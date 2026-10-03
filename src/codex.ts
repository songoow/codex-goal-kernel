import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnDelta, Usage } from "./types.ts";

/**
 * The Codex adapter — the one non-trivial piece of real engineering here.
 *
 * It shells out to `codex exec` and drives continuation with `resume <thread_id>`.
 * The facts it relies on are verified against the installed CLI (0.160.0):
 *   - `--json` emits a JSONL event stream (`thread.started`, `turn.completed`);
 *   - `resume <SESSION_ID>` continues the same thread, so the model keeps its
 *     own working context and the kernel does not have to replay history;
 *   - `--output-schema` makes the final message a validated JSON object;
 *   - `resume` rejects `--sandbox` and does not inherit the original thread's
 *     sandbox, so the policy is restated through `-c sandbox_mode=...` on every turn;
 *   - resuming a thread the provider no longer has exits non-zero with no
 *     events and `thread/resume failed: no rollout found for thread id ...`.
 *
 * A production rewrite would speak the app-server RPC protocol directly for
 * streaming and interrupt control. A subprocess per turn is the honest minimum
 * that is still real: it is the actual Codex runtime, not a mock.
 */
export interface CodexTurnRequest {
  projectRoot: string;
  prompt: string;
  /** null starts a new thread; otherwise the kernel resumes this session. */
  sessionId: string | null;
  model?: string;
  /**
   * Codex sandbox for the turn. The kernel defaults to `workspace-write` because
   * a goal that cannot change the workspace can never satisfy a file predicate;
   * `read-only` is available for inspection-only goals and is the safer choice
   * when the objective is analysis rather than delivery.
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
}

export interface CodexTurnResult {
  delta: TurnDelta;
  sessionId: string | null;
  sessionReused: boolean;
  usage: Usage;
  durationMs: number;
}

/** A completed exec without the structured delta contract. Used by the ablation runner's native arms. */
export interface CodexPromptResult {
  sessionId: string | null;
  sessionReused: boolean;
  usage: Usage;
  finalMessage: string | null;
  durationMs: number;
}

/**
 * Failure classes the kernel acts on. `session_missing` mirrors the name LoopX's
 * Codex adapter uses for a resume whose thread the provider no longer has; it is
 * the only class that changes control flow (discard the binding, start fresh).
 */
export type TurnFailureCategory = "session_missing" | "unknown";

export class CodexTurnError extends Error {
  readonly category: TurnFailureCategory;
  readonly exitCode: number | null;
  constructor(message: string, category: TurnFailureCategory, exitCode: number | null = null) {
    super(message);
    this.name = "CodexTurnError";
    this.category = category;
    this.exitCode = exitCode;
  }
}

/**
 * Text classification of a failed turn. This is a documented heuristic over
 * provider error text, not a typed contract: it fires only when a *resume*
 * produced no thread at all and the error names a missing rollout, thread or
 * session. Authentication wording wins, because a fresh retry cannot fix it.
 */
export function classifyTurnFailure(input: {
  resumed: boolean;
  sessionStarted: boolean;
  completed: boolean;
  stderr: string;
  eventError: string | null;
}): TurnFailureCategory {
  if (!input.resumed || input.sessionStarted || input.completed) return "unknown";
  const text = `${input.eventError ?? ""}\n${input.stderr}`.toLowerCase();
  if (/unauthorized|authentication|login required|invalid_api_key/.test(text)) return "unknown";
  if (text.includes("no rollout found for thread id")) return "session_missing";
  if (/(thread|session)[^\n]{0,40}not found/.test(text)) return "session_missing";
  return "unknown";
}

/** Mirrors `TurnDelta` in types.ts. A smoke test asserts the two agree. */
export function deltaJsonSchema(): Record<string, unknown> {
  const assumption = {
    type: "object",
    additionalProperties: false,
    required: ["id", "statement", "source"],
    properties: {
      id: { type: "string", minLength: 1 },
      statement: { type: "string", minLength: 1 },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "sha256"],
        properties: {
          kind: { type: "string", enum: ["file"] },
          path: { type: "string", minLength: 1 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
  } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: ["closed", "new_todos", "new_assumptions", "proposed_amendment", "note"],
    properties: {
      closed: { type: "array", items: { type: "string" } },
      new_todos: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "done_when", "advances"],
          properties: {
            id: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            done_when: { type: "string", minLength: 1 },
            advances: { type: "string", minLength: 1 },
          },
        },
      },
      new_assumptions: { type: "array", items: assumption },
      proposed_amendment: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["objective", "reason"],
            properties: {
              objective: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
          },
        ],
      },
      note: { type: "string" },
    },
  };
}

/** One kernel turn: structured delta required. */
export async function runCodexTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
  const started = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "goal-kernel-"));
  try {
    const schemaPath = join(scratch, "delta.schema.json");
    const lastMessagePath = join(scratch, "last-message.json");
    writeFileSync(schemaPath, JSON.stringify(deltaJsonSchema()), "utf8");
    const { events } = await execCodex(request, { schemaPath, lastMessagePath });
    const raw = readLastMessage(lastMessagePath, events.finalMessage);
    return {
      delta: parseDelta(raw),
      sessionId: events.sessionId,
      sessionReused: request.sessionId !== null && events.sessionId === request.sessionId,
      usage: events.usage,
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One plain exec or resume with no output contract. */
export async function runCodexPrompt(request: CodexTurnRequest): Promise<CodexPromptResult> {
  const started = Date.now();
  const { events } = await execCodex(request, null);
  return {
    sessionId: events.sessionId,
    sessionReused: request.sessionId !== null && events.sessionId === request.sessionId,
    usage: events.usage,
    finalMessage: events.finalMessage,
    durationMs: Date.now() - started,
  };
}

async function execCodex(
  request: CodexTurnRequest,
  structured: { schemaPath: string; lastMessagePath: string } | null,
): Promise<{ events: ParsedEvents; stderr: string }> {
  const args = buildArgs(request, structured);
  const { stdout, stderr, code } = await run("codex", args, request.projectRoot, request.timeoutMs ?? 30 * 60_000);
  const events = parseEvents(stdout);
  if (!events.completed) {
    const tail = stderr.trim().slice(-800);
    const category = classifyTurnFailure({
      resumed: request.sessionId !== null,
      sessionStarted: events.sessionId !== null,
      completed: false,
      stderr,
      eventError: events.error,
    });
    throw new CodexTurnError(
      `codex turn did not complete (exit ${code}): ${events.error ?? (tail || "no event stream")}`,
      category,
      code,
    );
  }
  return { events, stderr };
}

export function buildArgs(
  request: CodexTurnRequest,
  structured: { schemaPath: string; lastMessagePath: string } | null,
): string[] {
  const common = ["--json", "--skip-git-repo-check"];
  if (structured) {
    common.push("--output-schema", structured.schemaPath, "--output-last-message", structured.lastMessagePath);
  }
  // Restated on every turn: `resume` rejects --sandbox and does not inherit the thread's policy.
  const sandbox = [`-c`, `sandbox_mode=${JSON.stringify(request.sandbox ?? "workspace-write")}`];
  const model = request.model ? ["--model", request.model] : [];
  if (request.sessionId) {
    return ["exec", "resume", ...common, ...sandbox, ...model, request.sessionId, request.prompt];
  }
  return ["exec", ...common, ...sandbox, ...model, request.prompt];
}

interface ParsedEvents {
  sessionId: string | null;
  usage: Usage;
  completed: boolean;
  finalMessage: string | null;
  error: string | null;
}

export function parseEvents(stdout: string): ParsedEvents {
  const out: ParsedEvents = {
    sessionId: null,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    completed: false,
    finalMessage: null,
    error: null,
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "thread.started" && typeof event.thread_id === "string") {
      out.sessionId = event.thread_id;
    } else if (type === "turn.completed" && event.usage) {
      out.completed = true;
      const usage = event.usage as Record<string, number>;
      out.usage = {
        input_tokens: usage.input_tokens ?? 0,
        cached_input_tokens: usage.cached_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      };
    } else if (type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        out.finalMessage = item.text;
      }
    } else if (type === "error" || type === "turn.failed") {
      out.error = typeof event.message === "string" ? event.message : JSON.stringify(event);
    }
  }
  return out;
}

function readLastMessage(path: string, fallback: string | null): string {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text !== "") return text;
  } catch {
    // Fall through to the streamed agent message.
  }
  if (fallback !== null) return fallback;
  throw new Error("codex returned no final message");
}

/** Tolerate a fenced or slightly annotated response, but never invent a delta. */
export function parseDelta(raw: string): TurnDelta {
  const text = stripFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`turn did not return a JSON delta: ${text.slice(0, 300)}`);
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  const value = parsed as Partial<TurnDelta>;
  if (value === null || typeof value !== "object") {
    throw new Error("turn delta was not an object");
  }
  return {
    closed: Array.isArray(value.closed) ? value.closed.filter(isString) : [],
    new_todos: Array.isArray(value.new_todos) ? value.new_todos : [],
    new_assumptions: Array.isArray(value.new_assumptions) ? value.new_assumptions : [],
    proposed_amendment: value.proposed_amendment ?? null,
    note: typeof value.note === "string" ? value.note : "",
  };
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(text);
  return match ? match[1].trim() : text;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // stdin is closed on purpose: a piped stdin makes `codex exec` wait for more input.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex turn exceeded ${timeoutMs}ms and was killed`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
