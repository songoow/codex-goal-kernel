# Codex Goal Kernel

[English](README.md) | [简体中文](README.zh-CN.md)

A standalone TypeScript project for running bounded Codex CLI turns with
revalidated acceptance and persistent progress. It is an experimental runner
for one local goal, with its own state, CLI and tests. No LoopX installation or
repository is required. It does not drive Codex’s native Goal API.

## Why this design

The kernel keeps one goal explicit, rechecks acceptance against the workspace,
and credits each checkpoint once. These choices address stale success and
repeated activity being mistaken for progress. The rationale, tradeoffs and
evidence limits are explained in [Design rationale](docs/design.md)
([设计说明](docs/design.zh-CN.md)).

## Running the package

Requires Node 22.22.3 or newer, a working `codex` command and its existing login.
Verifier commands in the example also require Python 3. From the repository root:

```bash
npm ci
npm run typecheck
npm test
PROJECT_DIR="$(mktemp -d)"
node --experimental-strip-types src/cli.ts init --project "$PROJECT_DIR" --id greeting --spec ./examples/greeting/spec.json
node --experimental-strip-types src/cli.ts run --project "$PROJECT_DIR" --id greeting --turns 6
node --experimental-strip-types src/cli.ts status --project "$PROJECT_DIR" --id greeting
node --experimental-strip-types src/cli.ts view --project "$PROJECT_DIR" --id greeting
```

State, the declaration, receipts and the text view stay under the selected
project’s `.goal-kernel/` directory. This repository ignores that directory;
when using another Git project, add it to that project’s ignore rules.
Repeated `init` is rejected so it cannot erase a goal's budget or acceptance. Use a new id for a new experiment.
The JSON spec's `goal_id` must match `--id`.

The runtime defaults to `workspace-write`. `--sandbox read-only` is available
for inspection tasks. Explicit `--sandbox danger-full-access` delegates the
current user's filesystem permissions to the subprocess; use only a disposable,
trusted environment when the usual sandbox is unavailable. This package does
not change Codex login, model, global settings or scheduling.
[Codex authentication](https://developers.openai.com/codex/auth) explains the
CLI's login storage. Check `codex login status` in the same environment used to
run the package; an inherited alternate configuration directory can select a
different login.

To stop using the experiment, stop invoking `run` and remove any external clock
entry you created. It installs no daemon. Preserve the goal directory for audit
or delete it with its disposable project. Removing this repository does not modify Codex or its configuration.

## Acceptance and progress

The owner supplies `objective`, `predicates`, `policy.max_turns` and
`policy.max_idle_turns`. Both limits must be positive integers. Optional
`policy.max_total_tokens` caps the summed provider-reported input plus output
tokens, and optional `policy.max_wallclock_ms` caps elapsed time since the
first admitted model call. Optional `policy.continuity` selects `resume` (the
default) or `fresh`; see the next section. Predicate ids are unique. Supported checks are `file_exists`, `file_sha256`, `command` and
`owner` (see `src/types.ts` and the example spec).

Before an admitted action, the kernel checks the declaration fingerprint,
todo references, file assumptions and pending objective amendments. It then
refreshes acceptance from the actual workspace so a resumed session sees
invalidated work. After the action it checks the declaration again, re-runs
all automatic predicates, updates todos, and settles the turn. Verifier commands
must be trusted, bounded, repeatable and read-only; they run at both boundaries
in the selected project and do not inherit the model subprocess's sandbox.
Every prompt also carries a bounded tail of the last five turns (what the
harness verified, and each turn's own one-line note), so a new thread can see
what was already tried without trusting any longer narrative.

`verified_predicates` is the current snapshot. A failed automatic check removes
its earlier pass and reopens todos completed by that predicate. A check passing
for the first time earns progress; creating todos, repeating claims or repairing
an already credited checkpoint does not. `credited_predicates` retains that
history across restarts. Original v1 state without the optional field is read
with its earlier verified ids already credited. Neither logs nor old receipts
are rewritten during that read.

A complete acceptance snapshot wins over a just-reached turn or idle limit.
Declaration integrity, stale assumptions and pending owner decisions still win
over completion. An incomplete goal stops at its configured limit. Runtime
failures also consume an attempted turn; missing provider token usage is not an
estimate of zero cost.

No semantic relevance judgment is made from a todo's predicate id. Binding an id
only proves referential validity. Choose acceptance checks and intermediate
checkpoints that reflect the real desired outcome; a large task with no
checkable intermediate result can legitimately need a larger idle allowance.
A prompt hash identifies the explicit rendered prompt, not Codex's full session
history, tool inputs, workspace or a replayable execution.

## Continuity and lost threads

Memory between turns can live in two places: the provider's thread, or the
kernel's state. `policy.continuity` makes that a frozen, per-goal condition.

- `resume` (default) continues one Codex thread with `codex exec resume`. The
  model keeps its hidden working memory in addition to the explicit prompt.
- `fresh` starts a new thread on every turn. The rendered state and the
  workspace are the only memory. This is the shape LoopX chose for its published
  LHTB arm (one fresh exec per heartbeat, never resume).

Both modes receive byte-identical prompt sections except the opening line, so a
comparison between them varies exactly one thing: the hidden thread history.
The receipt records `continuity`, the thread id used and whether it was reused.

If a `resume` fails because Codex no longer has the thread (the CLI exits
without events and reports `no rollout found for thread id`), the kernel
discards the stored id, records `session_recovery` in that turn's receipt, and
carries the same rendered turn on a new thread once. A second failure, or any
failure that is not a missing thread, stops the run with `runtime_error` as
before. The classification is a documented text heuristic over the CLI's error
output (`classifyTurnFailure` in `src/codex.ts`); authentication wording is
never treated as a lost thread. The sandbox policy is restated with
`-c sandbox_mode=...` on every turn because `resume` rejects `--sandbox` and
does not inherit the thread's original policy.

## Readback and owner operations

`status` and `view` show the last recorded verification snapshot. `run` on a
completed goal rechecks it without a model call. Regression changes the state
to `stopped` with `acceptance_regressed`; it does not silently return success or
start new work. Exit codes: `0` means the requested bounded operation succeeded
(and can still leave the goal running), `3` means stopped, `1` means usage or
uncaught runtime error. Read `status` to distinguish running from done.

Only `owner` predicates may be accepted through
`accept --predicate ID --note TEXT`. Model claims cannot accept them. This is
an operator convention on a trusted local machine, not authenticated separation
between a human and an agent with the same filesystem permissions.

A returned objective amendment stops execution. `amend --confirm` adopts it;
`amend --reject` continues with the prior objective. The prototype updates only
the objective, not the predicate definitions. A change to acceptance or budgets
requires a new goal. General stopped-goal recovery is not automated: inspect the
reason and use a new goal after correcting the declaration or environment.

## Validation and remaining qualification

```bash
npm test
npm run typecheck
npm run test:live -- --sandbox workspace-write
```

Offline tests include positive and negative acceptance, repeated-credit and
budget-boundary cases, goal edits during a turn, restart readback, pending owner
decisions, legacy state, continuity modes, lost-thread recovery, budgets and
real CLI behavior. The live check spends model tokens in a disposable synthetic
project. It exercises five separate kernel processes on one Codex session, an
external regression and repair, a lost thread (the stored id is replaced by one
Codex never issued) recovered on a new thread, completion on the last turn, and
rejection of a stale completed result. The task explicitly requests one
checkpoint per turn to exercise continuation.

This smoke is not evidence of multi-hour reliability or improved model quality.
The package has no concurrency fence, no transaction spanning journal and state,
no retry for failures other than a missing thread, no general recovery command,
and no guarantee of reclaiming subprocess descendants after timeout. Token
counters are provider-reported and their cumulative-versus-delta semantics are
unqualified: if a provider reports cumulative usage, the token ceiling fires
early, never late. The verifier and state are accessible to an agent with
workspace write access. There is no sandboxed independent judge or guarantee
against semantic drift.

## Comparing continuity modes

`examples/ablation.ts` runs one task under matched model, sandbox and turn
budget across four arms and judges every arm with the same independent checks:

```bash
node --experimental-strip-types examples/ablation.ts \
  --task examples/tasks/ledger/spec.json \
  --arms kernel-resume,kernel-fresh,native-single,native-resume \
  --reps 3 --turns 6 --sandbox workspace-write --model <pinned model>
```

`kernel-resume` and `kernel-fresh` are the kernel under each continuity mode.
`native-single` is one plain `codex exec` given the objective and acceptance
statements. `native-resume` is that exec followed by `resume` with a fixed
"continue" prompt and no verification feedback. Per run it records completion,
turns, idle turns, regressions of previously passing checks, recoveries and
reported tokens, and writes `results.json` and `summary.md` under
`.local/ablation/<timestamp>/` with every project kept for inspection. Native
arms stop early when the independent checks pass, an oracle the model does not
see; this is stated in the summary. A handful of repetitions on the bundled toy
tasks validates the pipeline and nothing more. Evidence about long tasks needs
real tasks, more repetitions and reported uncertainty.

The open question this is built to answer: does continuity belong in the
provider's thread or in the kernel's state? Neither this repository nor the
LoopX benchmark documentation has established that yet.
