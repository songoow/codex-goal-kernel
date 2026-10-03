import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBudget } from "../src/invariants.ts";
import { GoalKernel } from "../src/kernel.ts";
import { GoalStore } from "../src/store.ts";
import type { Goal, KernelState, TurnDelta, Usage } from "../src/types.ts";

/* Semantics: turns are always bounded; tokens and wall-clock are optional
 * ceilings. Completion still wins over any just-reached limit. The wall clock
 * starts at the first admitted model call, so an idle goal does not age. */

const idle: TurnDelta = { closed: [], new_todos: [], new_assumptions: [], proposed_amendment: null, note: "" };
const spec: Goal = {
  goal_id: "g", objective: "Create a and b.",
  predicates: ["a", "b"].map(id => ({ id, statement: `${id} exists`, verify: { kind: "file_exists", path: id } })),
  policy: { max_turns: 10, max_idle_turns: 10 },
};

function harness(t: test.TestContext, goal: Goal, usage: Usage, now: () => number, step: (project: string) => TurnDelta = () => idle) {
  const project = mkdtempSync(join(tmpdir(), "gk-budget-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const store = new GoalStore(project, join(project, ".goal-kernel"), goal.goal_id);
  store.initGoal(goal);
  let calls = 0;
  const kernel = new GoalKernel(store, {
    projectRoot: project, now,
    runTurn: async () => { calls += 1; return { delta: step(project), sessionId: "s", sessionReused: false, usage }; },
  });
  return { project, store, kernel, calls: () => calls };
}

test("without optional limits only the turn rule applies", () => {
  const state = { turn_count: 3, usage_total: { input_tokens: 1e9, cached_input_tokens: 0, output_tokens: 1e9 }, started_at: "2020-01-01T00:00:00.000Z" } as KernelState;
  assert.deepEqual(checkBudget(spec, state, Date.now()), []);
  assert.equal(checkBudget(spec, { ...state, turn_count: 10 }, Date.now())[0].reason, "budget_exhausted");
});

test("the token budget stops the loop once reported input+output reaches the ceiling", async t => {
  const goal: Goal = { ...spec, policy: { ...spec.policy, max_total_tokens: 200 } };
  const h = harness(t, goal, { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 }, Date.now);
  const first = await h.kernel.runOneTurn();
  assert.equal(first.stop, null, "120 of 200 tokens used");
  const second = await h.kernel.runOneTurn();
  assert.equal(second.stop?.reason, "budget_exhausted");
  assert.match(second.stop!.detail, /token budget 200 reached \(reported 240/);
  await h.kernel.runOneTurn();
  assert.equal(h.calls(), 2);
});

test("completion on the turn that exhausts the token budget still succeeds", async t => {
  const goal: Goal = { ...spec, policy: { ...spec.policy, max_total_tokens: 100 } };
  const h = harness(t, goal, { input_tokens: 500, cached_input_tokens: 0, output_tokens: 50 }, Date.now, project => {
    for (const id of ["a", "b"]) writeFileSync(join(project, id), "ok");
    return { ...idle, closed: ["a", "b"] };
  });
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "goal_complete");
});

test("the wall-clock budget is measured from the first admitted model call", async t => {
  let clock = 0;
  const goal: Goal = { ...spec, policy: { ...spec.policy, max_wallclock_ms: 1000 } };
  const h = harness(t, goal, { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, () => clock);
  assert.equal(h.store.readState().started_at, null, "init does not start the clock");
  clock = 5_000;
  assert.equal((await h.kernel.runOneTurn()).stop, null);
  assert.equal(h.store.readState().started_at, new Date(5_000).toISOString());
  clock = 5_500;
  assert.equal((await h.kernel.runOneTurn()).stop, null);
  clock = 6_500;
  const third = await h.kernel.runOneTurn();
  assert.equal(third.stop?.reason, "budget_exhausted");
  assert.match(third.stop!.detail, /wall-clock budget 1000 ms reached \(1500 ms/);
  assert.equal(h.calls(), 2, "the exhausted budget is detected before another model call");
});

test("state written before the clock existed starts it at the next admitted turn", async t => {
  const goal: Goal = { ...spec, policy: { ...spec.policy, max_wallclock_ms: 60_000 } };
  const h = harness(t, goal, { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, () => 42_000);
  const state = h.store.readState();
  delete state.started_at;
  delete state.recent_turns;
  h.store.writeState(state);
  await h.kernel.runOneTurn();
  assert.equal(h.store.readState().started_at, new Date(42_000).toISOString());
  assert.equal(h.store.readState().recent_turns?.length, 1);
});
