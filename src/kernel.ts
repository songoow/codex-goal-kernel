import { join } from "node:path";
import { renderContext } from "./context.ts";
import { runCodexTurn } from "./codex.ts";
import { nowIso } from "./fsutil.ts";
import { hashValue } from "./hash.ts";
import {
  checkAssumptions,
  checkBudget,
  checkProgress,
  checkTodoScoping,
  continuityOf,
  isGoalComplete,
  goalFingerprint,
} from "./invariants.ts";
import { GoalStore } from "./store.ts";
import { renderView } from "./view.ts";
import { applyDelta, updateAcceptance } from "./state.ts";
import { verifyAcceptance } from "./verify.ts";
import { RECENT_TURNS_LIMIT } from "./types.ts";
import type {
  Goal,
  KernelState,
  RecentTurn,
  SessionRecovery,
  StopReason,
  StopRecord,
  TurnDelta,
  TurnReceipt,
  Usage,
} from "./types.ts";

/** Bounded single-goal loop: check integrity, observe acceptance, act, recheck,
 * settle. External callers own scheduling. This prototype has no concurrency
 * fence or crash-safe transaction spanning journal and state. */

/** How the model call of one turn was carried: a new thread, the stored thread,
 * or a new thread started after the stored one turned out to be gone. */
export type SessionOutcome = "fresh" | "resumed" | "recovered";

export interface TurnResult {
  turn_id: string;
  turn_index: number;
  verified: string[];
  claimed: string[];
  admitted_todos: string[];
  rejected: Array<{ kind: string; detail: string }>;
  progress: boolean;
  usage: Usage;
  /** null when the turn made no model call. */
  session: SessionOutcome | null;
  stop: StopRecord | null;
}

export interface ModelCall {
  delta: TurnDelta;
  sessionId: string | null;
  sessionReused: boolean;
  usage: Usage;
}

export interface KernelOptions {
  projectRoot: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Injected for tests: replaces the real Codex subprocess. */
  runTurn?: (input: { prompt: string; sessionId: string | null }) => Promise<ModelCall>;
  /** Injected clock for the wall-clock budget. The kernel never schedules itself. */
  now?: () => number;
}

export class GoalKernel {
  readonly store: GoalStore;
  readonly options: KernelOptions;

  constructor(store: GoalStore, options: KernelOptions) {
    this.store = store;
    this.options = options;
  }

  /** Integrity and owner decisions always precede completion or resource limits. */
  private integrity(state: KernelState, goal: Goal): StopRecord | null {
    if (state.goal_hash !== goalFingerprint(goal) ||
        state.goal_hash !== goalFingerprint(this.store.readGoal())) {
      return this.stop("goal_hash_mismatch", "The frozen declaration changed; restore it before continuing.");
    }
    const violations = [
      ...checkTodoScoping(goal, state.todos),
      ...checkAssumptions(this.options.projectRoot, state.assumptions).violations,
    ];
    if (violations.length) return this.stop(violations[0].reason, violations[0].detail);
    if (state.pending_decision) {
      return this.stop("goal_amendment_required",
        "An objective amendment requires the owner: use amend --confirm or amend --reject.",
        state.pending_decision.turn_id);
    }
    return null;
  }

  /** Call only after refreshing acceptance from the workspace. */
  private settlement(state: KernelState, goal: Goal, nowMs: number): StopRecord | null {
    if (isGoalComplete(goal, state)) {
      return this.stop("goal_complete", "every acceptance predicate is verified");
    }
    const violations = [...checkBudget(goal, state, nowMs), ...checkProgress(goal, state)];
    return violations.length ? this.stop(violations[0].reason, violations[0].detail) : null;
  }

  private callModel(prompt: string, sessionId: string | null): Promise<ModelCall> {
    if (this.options.runTurn) return this.options.runTurn({ prompt, sessionId });
    return runCodexTurn({
      projectRoot: this.options.projectRoot, prompt, sessionId,
      model: this.options.model, sandbox: this.options.sandbox,
    });
  }

  async runOneTurn(): Promise<TurnResult> {
    const goal = this.store.readGoal();
    const state = this.store.readState();
    const now = this.options.now ?? Date.now;
    if (state.status === "stopped") return this.emptyResult(state, state.stop);

    const integrity = this.integrity(state, goal);
    if (integrity) return this.finishStopped(state, integrity);

    // The model must see invalidated work before it chooses its next action.
    const before = verifyAcceptance(this.options.projectRoot, goal, [], state.verified_predicates);
    updateAcceptance(state, before.satisfied);
    if (state.status === "done") {
      if (!isGoalComplete(goal, state)) {
        return this.finishStopped(state, this.stop("acceptance_regressed",
          "Previously completed work no longer passes. Inspect the checks before starting more work."));
      }
      return this.emptyResult(state, state.stop);
    }
    const gate = this.settlement(state, goal, now());
    if (gate) return this.finishStopped(state, gate);

    const continuity = continuityOf(goal);
    const credited = new Set(state.credited_predicates ?? state.verified_predicates);
    const { prompt, ctx_hash } = renderContext(goal, state);
    const turnIndex = state.turn_count + 1;
    const turnId = `turn_${String(turnIndex).padStart(4, "0")}`;
    // The wall-clock budget counts from the first admitted model call, not from init.
    state.started_at ??= new Date(now()).toISOString();
    // Under `fresh` continuity the rendered state is the only memory: never resume.
    const requestedSession = continuity === "fresh" ? null : state.session_id;

    let result: ModelCall;
    let recovery: SessionRecovery | null = null;
    try {
      result = await this.callModel(prompt, requestedSession);
    } catch (error) {
      if (requestedSession !== null && isSessionMissing(error)) {
        // The provider no longer has the thread. Continuity lives in state.json,
        // so discard the binding and carry the same turn on a new thread, once.
        recovery = {
          lost_session_id: requestedSession,
          reason: "session_missing",
          detail: String((error as Error).message).slice(0, 400),
        };
        state.session_id = null;
        try {
          result = await this.callModel(prompt, null);
        } catch (retryError) {
          state.turn_count = turnIndex;
          return this.finishStopped(state, this.stop("runtime_error",
            `${turnId}: session ${requestedSession} was missing and a fresh start also failed: ${(retryError as Error).message}`), turnId);
        }
      } else {
        // A failed attempt still consumed a turn. Runtime usage may be unavailable.
        state.turn_count = turnIndex;
        return this.finishStopped(state, this.stop("runtime_error", `${turnId}: ${(error as Error).message}`), turnId);
      }
    }

    const session: SessionOutcome = recovery ? "recovered" : result.sessionReused ? "resumed" : "fresh";
    state.turn_count = turnIndex;
    state.session_id = continuity === "fresh" ? null : (result.sessionId ?? state.session_id);
    state.usage_total = addUsage(state.usage_total, result.usage);

    // Re-read the frozen declaration before accepting anything from this turn.
    let stop = this.integrity(state, goal);
    const outcome = stop
      ? { verified: [], rejected: [], satisfied: [] }
      : verifyAcceptance(this.options.projectRoot, goal, result.delta.closed, state.verified_predicates);
    const { admitted, rejected } = stop
      ? { admitted: [], rejected: [] }
      : applyDelta(state, goal, result.delta, outcome.satisfied);
    const newlyVerified = outcome.satisfied.filter(id => !credited.has(id));
    const progress = newlyVerified.length > 0;
    state.credited_predicates = [...new Set([...credited, ...newlyVerified])];
    state.no_progress_streak = progress ? 0 : state.no_progress_streak + 1;
    pushRecentTurn(state, {
      turn_index: turnIndex, progress, verified_new: newlyVerified,
      note: result.delta.note.slice(0, 200),
    });

    if (!stop && result.delta.proposed_amendment) {
      state.pending_decision = {
        turn_id: turnId, raised_at: nowIso(), before_hash: state.goal_hash,
        after_hash: goalFingerprint({ ...goal, objective: result.delta.proposed_amendment.objective }),
        proposal: result.delta.proposed_amendment,
      };
    }
    stop ??= this.integrity(state, goal) ?? this.settlement(state, goal, now());
    if (stop) {
      state.status = stop.reason === "goal_complete" ? "done" : "stopped";
      state.stop = stop;
    }
    const receipt: TurnReceipt = {
      turn_id: turnId, at: nowIso(), turn_index: turnIndex, goal_hash: state.goal_hash,
      ctx_hash, continuity, session_id: result.sessionId, session_reused: result.sessionReused,
      session_recovery: recovery,
      usage: result.usage, closed: result.delta.closed, verified: outcome.verified,
      note: result.delta.note, admitted_todos: admitted,
      rejected: [...before.rejected, ...outcome.rejected, ...rejected],
      progress, state_hash_after: hashValue(state),
    };
    this.store.appendReceipt(receipt);
    this.store.writeState(state);
    if (stop) this.store.appendReceipt({ turn_id: turnId, at: nowIso(), stop, state_hash_after: hashValue(state) });
    this.store.writeView(renderView(goal, state, this.store.readJournal() as never));
    return {
      turn_id: turnId, turn_index: turnIndex, verified: newlyVerified,
      claimed: result.delta.closed, admitted_todos: admitted, rejected: receipt.rejected,
      progress, usage: result.usage, session, stop,
    };
  }

  private finishStopped(
    state: KernelState,
    stop: StopRecord,
    turnId: string | null = null,
    reportedTurnIndex?: number,
  ): TurnResult {
    state.status = stop.reason === "goal_complete" ? "done" : "stopped";
    state.stop = stop;
    this.store.writeState(state);
    const goal = this.store.readGoal();
    this.store.appendReceipt({ turn_id: turnId, at: nowIso(), stop, state_hash_after: hashValue(state) } as never);
    this.store.writeView(renderView(goal, state, this.store.readJournal() as never));
    const result = this.emptyResult(state, stop);
    return reportedTurnIndex === undefined ? result : { ...result, turn_index: reportedTurnIndex };
  }

  private emptyResult(state: KernelState, stop: StopRecord | null): TurnResult {
    return {
      turn_id: state.stop?.turn_id ?? "turn_0000",
      turn_index: state.turn_count,
      verified: [],
      claimed: [],
      admitted_todos: [],
      rejected: [],
      progress: false,
      usage: state.usage_total,
      session: null,
      stop,
    };
  }

  /** Build a stop record without yet persisting it. */
  private stop(reason: StopReason, detail: string, turnId: string | null = null): StopRecord {
    return { reason, detail, at: nowIso(), turn_id: turnId };
  }
}

/** Duck-typed so an injected runner can raise the class without importing the adapter. */
function isSessionMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { category?: unknown }).category === "session_missing";
}

function pushRecentTurn(state: KernelState, entry: RecentTurn): void {
  state.recent_turns = [...(state.recent_turns ?? []), entry].slice(-RECENT_TURNS_LIMIT);
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export function defaultDataRoot(projectRoot: string): string {
  return join(projectRoot, ".goal-kernel");
}
