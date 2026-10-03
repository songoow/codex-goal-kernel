#!/usr/bin/env -S node --no-warnings --experimental-strip-types
/**
 * Ablation runner: one task, one model, one sandbox, one turn budget, and the
 * SAME independent acceptance checks judging every arm. Spends model tokens.
 *
 *   node --experimental-strip-types examples/ablation.ts --task examples/greeting/spec.json \
 *     --arms kernel-resume,kernel-fresh,native-single,native-resume \
 *     --reps 1 --turns 6 --sandbox workspace-write [--model M] [--out DIR]
 *
 * Arms:
 *   kernel-resume   the kernel, continuity "resume" (one Codex thread, hidden memory kept)
 *   kernel-fresh    the kernel, continuity "fresh"  (new thread each turn; state.json is the memory)
 *   native-single   one plain `codex exec` given the objective and acceptance statements
 *   native-resume   the same first exec, then `resume` with a fixed "continue" prompt
 *
 * Fairness notes: native arms receive the acceptance statements once and no
 * per-turn verification feedback; they stop early when the independent checks
 * all pass, which gives them an oracle the model itself does not see. Kernel
 * arms stop on their own completion rule. Turn budgets are matched. Results are
 * written under --out (default .local/ablation/<timestamp>/) with every project
 * directory kept for inspection. A small sample on toy tasks validates the
 * pipeline; it is not evidence about long tasks.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCodexPrompt } from "../src/codex.ts";
import { GoalKernel } from "../src/kernel.ts";
import { GoalStore } from "../src/store.ts";
import { verifyAcceptance } from "../src/verify.ts";
import type { Goal, TurnReceipt } from "../src/types.ts";

type Arm = "kernel-resume" | "kernel-fresh" | "native-single" | "native-resume";
const ARMS: Arm[] = ["kernel-resume", "kernel-fresh", "native-single", "native-resume"];
type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

interface RunRecord {
  arm: Arm;
  rep: number;
  completed: boolean;
  turns: number;
  idle_turns: number;
  regressions: number;
  recoveries: number;
  tokens_in: number;
  tokens_out: number;
  wall_ms: number;
  stop_reason: string | null;
  verified_final: string[];
  project: string;
}

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

const taskPath = arg("task");
if (!taskPath) {
  process.stderr.write("usage: ablation.ts --task SPEC [--arms a,b] [--reps N] [--turns N] [--sandbox S] [--model M] [--out DIR]\n");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(resolve(taskPath), "utf8")) as Goal;
const arms = (arg("arms", ARMS.join(","))!.split(",") as Arm[]).map(a => {
  if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}; expected one of ${ARMS.join(", ")}`);
  return a;
});
const reps = Number(arg("reps", "1"));
const turns = Number(arg("turns", String(spec.policy.max_turns)));
const sandbox = arg("sandbox", "workspace-write") as Sandbox;
const model = arg("model") ?? undefined;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(arg("out", join(".local", "ablation", stamp))!);
assert.ok(Number.isSafeInteger(reps) && reps >= 1 && Number.isSafeInteger(turns) && turns >= 1, "--reps and --turns must be positive integers");
mkdirSync(out, { recursive: true });

const acceptanceList = spec.predicates.map(p => `- ${p.id}: ${p.statement}`).join("\n");
const NATIVE_FIRST = `${spec.objective}\n\nAcceptance checks (they will be verified independently afterwards):\n${acceptanceList}\n\nWork in the current directory. When everything is satisfied, reply DONE.`;
const NATIVE_CONTINUE = "Continue working toward the objective in this directory. Re-read the acceptance checks above, verify your work, and fix anything that does not hold. When everything is satisfied, reply DONE.";

function satisfiedNow(project: string): Set<string> {
  return new Set(verifyAcceptance(project, spec).satisfied);
}

async function runKernelArm(arm: Arm, rep: number, project: string): Promise<RunRecord> {
  const goal: Goal = { ...spec, policy: { ...spec.policy, max_turns: turns, continuity: arm === "kernel-fresh" ? "fresh" : "resume" } };
  const store = new GoalStore(project, join(project, ".goal-kernel"), spec.goal_id);
  store.initGoal(goal);
  const kernel = new GoalKernel(store, { projectRoot: project, model, sandbox });
  const started = Date.now();
  let stop: string | null = null;
  for (let i = 0; i < turns; i++) {
    const result = await kernel.runOneTurn();
    process.stdout.write(`  ${arm}#${rep} turn ${result.turn_index}: session=${result.session ?? "none"} verified=[${result.verified.join(",")}] progress=${result.progress ? "yes" : "no"}\n`);
    if (result.stop) { stop = result.stop.reason; break; }
  }
  const state = store.readState();
  const receipts = store.readJournal().filter(r => "ctx_hash" in r) as TurnReceipt[];
  return {
    arm, rep, completed: isComplete(satisfiedNow(project)), turns: receipts.length,
    idle_turns: receipts.filter(r => !r.progress).length,
    regressions: receipts.flatMap(r => r.rejected).filter(r => r.kind === "acceptance_regressed").length,
    recoveries: receipts.filter(r => r.session_recovery).length,
    tokens_in: state.usage_total.input_tokens, tokens_out: state.usage_total.output_tokens,
    wall_ms: Date.now() - started, stop_reason: stop, verified_final: [...satisfiedNow(project)].sort(), project,
  };
}

async function runNativeArm(arm: Arm, rep: number, project: string): Promise<RunRecord> {
  const started = Date.now();
  const maxTurns = arm === "native-single" ? 1 : turns;
  let session: string | null = null;
  let tokensIn = 0, tokensOut = 0, idle = 0, regressions = 0, used = 0;
  let previous = satisfiedNow(project);
  const log: string[] = [];
  for (let i = 1; i <= maxTurns; i++) {
    const result = await runCodexPrompt({
      projectRoot: project, prompt: i === 1 ? NATIVE_FIRST : NATIVE_CONTINUE, sessionId: session, model, sandbox,
    });
    used += 1;
    session = result.sessionId ?? session;
    tokensIn += result.usage.input_tokens; tokensOut += result.usage.output_tokens;
    const now = satisfiedNow(project);
    const gained = [...now].filter(id => !previous.has(id));
    const lost = [...previous].filter(id => !now.has(id));
    if (gained.length === 0) idle += 1;
    regressions += lost.length;
    log.push(JSON.stringify({ turn: i, session_id: result.sessionId, reused: result.sessionReused, usage: result.usage, satisfied: [...now].sort(), final_message: (result.finalMessage ?? "").slice(0, 300) }));
    process.stdout.write(`  ${arm}#${rep} turn ${i}: satisfied=[${[...now].sort().join(",")}] gained=[${gained.join(",")}]${lost.length ? ` lost=[${lost.join(",")}]` : ""}\n`);
    previous = now;
    if (isComplete(now)) break;
  }
  writeFileSync(join(project, "native-turns.jsonl"), log.join("\n") + "\n");
  const finalSet = satisfiedNow(project);
  return {
    arm, rep, completed: isComplete(finalSet), turns: used, idle_turns: idle, regressions, recoveries: 0,
    tokens_in: tokensIn, tokens_out: tokensOut, wall_ms: Date.now() - started,
    stop_reason: isComplete(finalSet) ? "goal_complete" : "budget_exhausted", verified_final: [...finalSet].sort(), project,
  };
}

function isComplete(satisfied: Set<string>): boolean {
  return spec.predicates.every(p => satisfied.has(p.id));
}

const records: RunRecord[] = [];
for (const arm of arms) {
  for (let rep = 1; rep <= reps; rep++) {
    const project = join(out, `${arm}-${rep}`);
    mkdirSync(project, { recursive: true });
    process.stdout.write(`\n== ${arm} rep ${rep} → ${project}\n`);
    const record = arm.startsWith("kernel") ? await runKernelArm(arm, rep, project) : await runNativeArm(arm, rep, project);
    records.push(record);
    writeFileSync(join(out, "results.json"), JSON.stringify({ task: resolve(taskPath), model: model ?? "(codex default)", sandbox, turns, reps, records }, null, 2));
  }
}

const mean = (xs: number[]) => xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
const rows = arms.map(arm => {
  const rs = records.filter(r => r.arm === arm);
  return `| ${arm} | ${rs.filter(r => r.completed).length}/${rs.length} | ${mean(rs.map(r => r.turns)).toFixed(1)} | ${mean(rs.map(r => r.idle_turns)).toFixed(1)} | ${rs.reduce((a, r) => a + r.regressions, 0)} | ${rs.reduce((a, r) => a + r.recoveries, 0)} | ${Math.round(mean(rs.map(r => r.tokens_in + r.tokens_out)))} | ${Math.round(mean(rs.map(r => r.wall_ms)) / 1000)}s |`;
});
const summary = [
  `# Ablation: ${spec.goal_id}`, "",
  `task: ${resolve(taskPath)}  model: ${model ?? "(codex default)"}  sandbox: ${sandbox}  turn budget: ${turns}  reps: ${reps}`, "",
  "| arm | completed | mean turns | mean idle turns | regressions | recoveries | mean tokens | mean wall |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows, "",
  "Completion is judged by the same independent checks for every arm. Small samples on toy tasks validate the pipeline only.", "",
].join("\n");
writeFileSync(join(out, "summary.md"), summary);
process.stdout.write(`\n${summary}\nartifacts: ${out}\n`);
