import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexTurnError, buildArgs, classifyTurnFailure } from "../src/codex.ts";
import { renderContext } from "../src/context.ts";
import { GoalKernel } from "../src/kernel.ts";
import type { ModelCall } from "../src/kernel.ts";
import { GoalStore } from "../src/store.ts";
import type { Goal, TurnDelta, TurnReceipt } from "../src/types.ts";

/* Semantics under test, written before the implementation:
 *  - A resume whose thread the provider no longer has is `session_missing`; the
 *    kernel discards the binding and carries the SAME turn on a new thread, once.
 *  - Any other failure, or a second failure, stops the run as before.
 *  - `fresh` continuity never resumes and never stores a thread id.
 *  - Both modes render identical explicit context except the opening line.
 */

const idle: TurnDelta = { closed: [], new_todos: [], new_assumptions: [], proposed_amendment: null, note: "" };
const spec: Goal = {
  goal_id: "g", objective: "Create a, then b.",
  predicates: ["a", "b"].map(id => ({ id, statement: `${id} exists`, verify: { kind: "file_exists", path: id } })),
  policy: { max_turns: 10, max_idle_turns: 5 },
};

// Captured verbatim from codex-cli 0.160.0 after the thread's rollout was removed.
const LOST_THREAD_STDERR =
  "Error: thread/resume: thread/resume failed: no rollout found for thread id 01a102ab-f079-7b20-ae7e-af8072e96c43 (code -32600)\n";

test("a resume that produced no thread and names a missing rollout is session_missing", () => {
  const category = classifyTurnFailure({ resumed: true, sessionStarted: false, completed: false, stderr: LOST_THREAD_STDERR, eventError: null });
  assert.equal(category, "session_missing");
  assert.equal(classifyTurnFailure({ resumed: true, sessionStarted: false, completed: false, stderr: "", eventError: "session not found" }), "session_missing");
  assert.equal(classifyTurnFailure({ resumed: true, sessionStarted: false, completed: false, stderr: "thread_not_found", eventError: null }), "unknown", "the phrase must say not found, not a bare token");
});

test("the same text is not session_missing on a fresh exec, after a thread started, or after completion", () => {
  const base = { stderr: LOST_THREAD_STDERR, eventError: null };
  assert.equal(classifyTurnFailure({ resumed: false, sessionStarted: false, completed: false, ...base }), "unknown");
  assert.equal(classifyTurnFailure({ resumed: true, sessionStarted: true, completed: false, ...base }), "unknown");
  assert.equal(classifyTurnFailure({ resumed: true, sessionStarted: false, completed: true, ...base }), "unknown");
});

test("authentication wording wins: a fresh retry cannot fix a login problem", () => {
  const stderr = `${LOST_THREAD_STDERR}Error: unauthorized: login required\n`;
  assert.equal(classifyTurnFailure({ resumed: true, sessionStarted: false, completed: false, stderr, eventError: null }), "unknown");
});

test("resume restates the sandbox through -c and names the thread; a fresh exec does not", () => {
  const structured = { schemaPath: "/s.json", lastMessagePath: "/m.json" };
  const resumed = buildArgs({ projectRoot: "/p", prompt: "go", sessionId: "sid-1", sandbox: "read-only" }, structured);
  assert.deepEqual(resumed.slice(0, 2), ["exec", "resume"]);
  assert.ok(!resumed.includes("--sandbox"), "resume rejects --sandbox");
  assert.ok(resumed.includes('sandbox_mode="read-only"'));
  assert.equal(resumed.at(-2), "sid-1");
  const fresh = buildArgs({ projectRoot: "/p", prompt: "go", sessionId: null }, structured);
  assert.equal(fresh[0], "exec");
  assert.notEqual(fresh[1], "resume");
  assert.ok(fresh.includes('sandbox_mode="workspace-write"'), "default sandbox is workspace-write");
});

type Step = (call: { n: number; sessionId: string | null; project: string; prompt: string }) => ModelCall;

function harness(t: test.TestContext, step: Step, goal: Goal = spec) {
  const project = mkdtempSync(join(tmpdir(), "gk-continuity-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const store = new GoalStore(project, join(project, ".goal-kernel"), goal.goal_id);
  store.initGoal(goal);
  const calls: Array<{ sessionId: string | null; prompt: string }> = [];
  const kernel = new GoalKernel(store, {
    projectRoot: project,
    runTurn: async (input) => {
      calls.push({ sessionId: input.sessionId, prompt: input.prompt });
      return step({ n: calls.length, sessionId: input.sessionId, project, prompt: input.prompt });
    },
  });
  return { project, store, kernel, calls };
}

const ok = (sessionId: string, reused: boolean, delta: TurnDelta = idle): ModelCall => ({
  delta, sessionId, sessionReused: reused, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
});
const lost = () => new CodexTurnError(`codex turn did not complete (exit 1): ${LOST_THREAD_STDERR}`, "session_missing", 1);

test("a missing thread is recovered inside the same turn on a new thread", async t => {
  const h = harness(t, ({ n, sessionId, project }) => {
    if (n === 1) { writeFileSync(join(project, "a"), "ok"); return ok("s1", false, { ...idle, closed: ["a"], note: "made a" }); }
    if (n === 2) { assert.equal(sessionId, "s1"); throw lost(); }
    assert.equal(sessionId, null, "the retry must start a new thread");
    writeFileSync(join(project, "b"), "ok");
    return ok("s2", false, { ...idle, closed: ["b"], note: "made b" });
  });
  const first = await h.kernel.runOneTurn();
  assert.equal(first.session, "fresh");
  const second = await h.kernel.runOneTurn();
  assert.equal(second.session, "recovered");
  assert.equal(second.turn_index, 2);
  assert.equal(second.stop?.reason, "goal_complete", "the recovered turn's work counts normally");
  assert.equal(h.calls.length, 3, "one failed resume plus one fresh retry");
  assert.equal(h.calls[1].prompt, h.calls[2].prompt, "the retry carries the identical rendered context");
  const state = h.store.readState();
  assert.equal(state.turn_count, 2);
  assert.equal(state.session_id, "s2");
  const receipts = h.store.readJournal().filter(r => "ctx_hash" in r) as TurnReceipt[];
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1].session_recovery?.lost_session_id, "s1");
  assert.equal(receipts[1].session_reused, false);
  assert.equal(receipts[1].session_id, "s2");
  assert.equal(receipts[0].session_recovery, null);
});

test("recovery is bounded: a failed fresh retry stops the run and clears the binding", async t => {
  const h = harness(t, ({ n }) => {
    if (n === 1) return ok("s1", false);
    if (n === 2) throw lost();
    throw new CodexTurnError("codex turn did not complete (exit 1): no event stream", "unknown", 1);
  });
  await h.kernel.runOneTurn();
  const second = await h.kernel.runOneTurn();
  assert.equal(second.stop?.reason, "runtime_error");
  assert.match(second.stop!.detail, /fresh start also failed/);
  assert.equal(h.calls.length, 3);
  const state = h.store.readState();
  assert.equal(state.turn_count, 2, "the attempt consumed its turn");
  assert.equal(state.session_id, null);
  const third = await h.kernel.runOneTurn();
  assert.equal(third.stop?.reason, "runtime_error");
  assert.equal(h.calls.length, 3, "a stopped goal spends nothing more");
});

test("a failure that is not a missing thread stops immediately and keeps the binding", async t => {
  const h = harness(t, ({ n }) => {
    if (n === 1) return ok("s1", false);
    throw new CodexTurnError("codex turn did not complete (exit 1): unauthorized", "unknown", 1);
  });
  await h.kernel.runOneTurn();
  const second = await h.kernel.runOneTurn();
  assert.equal(second.stop?.reason, "runtime_error");
  assert.equal(h.calls.length, 2, "no retry for a non-session failure");
  assert.equal(h.store.readState().session_id, "s1");
});

test("fresh continuity never resumes and never stores a thread", async t => {
  const goal: Goal = { ...spec, policy: { ...spec.policy, continuity: "fresh" } };
  const h = harness(t, ({ n, sessionId }) => {
    assert.equal(sessionId, null);
    return ok(`s${n}`, false, { ...idle, note: `turn ${n}` });
  }, goal);
  const first = await h.kernel.runOneTurn();
  const second = await h.kernel.runOneTurn();
  assert.equal(first.session, "fresh");
  assert.equal(second.session, "fresh");
  assert.equal(h.store.readState().session_id, null);
  const receipts = h.store.readJournal().filter(r => "ctx_hash" in r) as TurnReceipt[];
  assert.deepEqual(receipts.map(r => r.session_id), ["s1", "s2"], "each thread id is still recorded for audit");
  assert.ok(receipts.every(r => r.continuity === "fresh" && !r.session_reused && r.session_recovery === null));
});

test("under fresh continuity a session_missing error is an ordinary runtime error, not a retry loop", async t => {
  const goal: Goal = { ...spec, policy: { ...spec.policy, continuity: "fresh" } };
  const h = harness(t, () => { throw lost(); }, goal);
  const result = await h.kernel.runOneTurn();
  assert.equal(result.stop?.reason, "runtime_error");
  assert.equal(h.calls.length, 1);
});

test("recent turns are bounded to five and rendered into the next prompt", async t => {
  const h = harness(t, ({ n }) => ok("s1", n > 1, { ...idle, note: `note-${n}` }),
    { ...spec, policy: { max_turns: 20, max_idle_turns: 20 } });
  for (let i = 0; i < 7; i++) await h.kernel.runOneTurn();
  const state = h.store.readState();
  assert.equal(state.recent_turns?.length, 5);
  assert.deepEqual(state.recent_turns?.map(r => r.turn_index), [3, 4, 5, 6, 7]);
  const seventhPrompt = h.calls[6].prompt;
  assert.match(seventhPrompt, /- turn 6: progress=no verified=\[\] note="note-6"/);
  assert.ok(!seventhPrompt.includes('"note-1"'), "the oldest turns fall off the bounded tail");
  assert.match(h.calls[0].prompt, /Recent turns[\s\S]*- \(none yet\)/);
});

test("resume and fresh render the same explicit context except the opening line", () => {
  const state = {
    version: 1 as const, goal_id: "g", goal_hash: "h", session_id: null, turn_count: 2,
    usage_total: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, todos: [], assumptions: [],
    verified_predicates: ["a"], pending_decision: null, no_progress_streak: 0, status: "running" as const, stop: null,
    recent_turns: [{ turn_index: 2, progress: true, verified_new: ["a"], note: "made a" }],
  };
  const resume = renderContext(spec, state).prompt.split("\n");
  const fresh = renderContext({ ...spec, policy: { ...spec.policy, continuity: "fresh" } }, state).prompt.split("\n");
  assert.notEqual(resume[0], fresh[0]);
  assert.match(fresh[0], /no memory of earlier turns/);
  assert.deepEqual(resume.slice(1), fresh.slice(1));
});
