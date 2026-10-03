import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
function fixture(t: test.TestContext) {
  const project = mkdtempSync(join(tmpdir(), "gk-cli-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const spec = {
    goal_id: "g", objective: "Create a; then obtain owner acceptance.",
    predicates: [
      { id: "a", statement: "a exists", verify: { kind: "file_exists", path: "a" } },
      { id: "owner", statement: "owner accepts", verify: { kind: "owner", note: "review" } },
    ], policy: { max_turns: 1, max_idle_turns: 2 },
  };
  const specPath = join(project, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const statePath = join(project, ".goal-kernel", "goals", "g", "state.json");
  function run(verb: string, args: string[] = []) {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", cli,
      verb, "--project", project, "--id", "g", ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.error, undefined);
    return { code: r.status, text: `${r.stdout}${r.stderr}` };
  }
  return { project, spec, specPath, statePath, run };
}

test("CLI init cannot erase an existing goal's budget and acceptance", t => {
  const h = fixture(t);
  assert.equal(h.run("init", ["--spec", h.specPath]).code, 0);
  const before = readFileSync(h.statePath, "utf8");
  const second = h.run("init", ["--spec", h.specPath]);
  assert.equal(second.code, 1);
  assert.match(second.text, /already exists/);
  assert.equal(readFileSync(h.statePath, "utf8"), before);
});

test("CLI rejects malformed budgets, duplicate predicates and invalid turn limits", t => {
  const h = fixture(t);
  for (const max_turns of [0, -1, 1.5, null, "many"]) {
    writeFileSync(h.specPath, JSON.stringify({ ...h.spec, policy: { ...h.spec.policy, max_turns } }));
    assert.equal(h.run("init", ["--spec", h.specPath]).code, 1);
  }
  writeFileSync(h.specPath, JSON.stringify({ ...h.spec, predicates: [h.spec.predicates[0], h.spec.predicates[0]] }));
  assert.match(h.run("init", ["--spec", h.specPath]).text, /unique/);
  for (const turns of ["0", "-1", "1.5", "NaN", "2suffix"]) {
    assert.match(h.run("run", ["--turns", turns]).text, /positive integer/);
  }
});

test("CLI owner acceptance cannot bypass automatic checks; completion and regression read back", t => {
  const h = fixture(t);
  assert.equal(h.run("init", ["--spec", h.specPath]).code, 0);
  assert.equal(h.run("accept", ["--predicate", "a"]).code, 1);
  writeFileSync(join(h.project, "a"), "ok");
  assert.equal(h.run("accept", ["--predicate", "owner"]).code, 0);
  // Already satisfied work is verified and settled without launching a model.
  assert.equal(h.run("run").code, 0);
  assert.match(h.run("status").text, /status=done/);
  assert.match(h.run("view").text, /\[x\] \*\*a\*\*/);
  rmSync(join(h.project, "a"));
  const invalidated = h.run("run");
  assert.equal(invalidated.code, 3, invalidated.text);
  assert.match(invalidated.text, /acceptance_regressed/);
  assert.equal(h.run("status").code, 3);
  assert.match(h.run("view").text, /\[ \] \*\*a\*\*/);
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).turn_count, 0);
});

test("CLI init validates continuity and the optional budgets, and status reads them back", t => {
  const h = fixture(t);
  writeFileSync(h.specPath, JSON.stringify({ ...h.spec, policy: { ...h.spec.policy, continuity: "sticky" } }));
  assert.match(h.run("init", ["--spec", h.specPath]).text, /continuity must be one of resume, fresh/);
  for (const bad of [{ max_total_tokens: 0 }, { max_total_tokens: 1.5 }, { max_wallclock_ms: "soon" }, { max_wallclock_ms: -1 }]) {
    writeFileSync(h.specPath, JSON.stringify({ ...h.spec, policy: { ...h.spec.policy, ...bad } }));
    assert.equal(h.run("init", ["--spec", h.specPath]).code, 1, JSON.stringify(bad));
  }
  writeFileSync(h.specPath, JSON.stringify({ ...h.spec, policy: { ...h.spec.policy, continuity: "fresh", max_total_tokens: 5000, max_wallclock_ms: 3600000 } }));
  const init = h.run("init", ["--spec", h.specPath]);
  assert.equal(init.code, 0, init.text);
  assert.match(init.text, /continuity: fresh/);
  const status = h.run("status").text;
  assert.match(status, /continuity=fresh/);
  assert.match(status, /budget=0\/5000/);
  assert.match(status, /wallclock_budget_ms=3600000/);
  assert.match(h.run("view").text, /- continuity: fresh/);
});
