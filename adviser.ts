/**
 * adviser - the canonical 100-advisor roster as a pi extension.
 *
 * On each tool-bearing turn, all roster advisors review the tool activity in
 * parallel (small pool), each with its own rolling digest. Their notes are
 * coalesced into one injected context message on the next LLM call.
 *
 * Advisors hold zero tools: they review only the pass input and report
 * through their note. They never mutate anything; fixes are the main
 * agent's job.
 *
 * Usage:
 *   - Installed: on by default. /adviser on|off - bare /adviser toggles. The
 *     state is saved to the agent config (adviser.json) and restored on every
 *     session start; the command list always shows the live state.
 *   - Config: PI_ADVISER_MODEL="provider/id:reasoning" to override the roster
 *     pins (dev only; honored only when it resolves to the exact pinned model
 *     and reasoning). PI_ADVISER_ROSTER=path to point at a WATCHDOG.yml copy.
 *   - Debug: PI_ADVISER_DEBUG=1 logs pass outcomes to stderr.
 *
 * Design rules:
 *   - Never blocks or interrupts the main agent.
 *   - One coalesced wave per turn, only when the turn had tool results.
 *   - No stale injections: each wave is stamped with its turn's end time;
 *     delivery is dropped once a newer user message has arrived.
 *   - Silence is the default: an advisor speaks only when something matters.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  loadRoster,
  resolveRosterPath,
  validateRoster,
  type AdvisorSpec,
  type Roster,
} from "./roster.ts";

// ---------------------------------------------------------------------------
// Config - the entire config surface.
// ---------------------------------------------------------------------------

const MODEL_OVERRIDE = process.env.PI_ADVISER_MODEL?.trim() ?? "";
const DEBUG = process.env.PI_ADVISER_DEBUG === "1";
// Persisted on/off state. Override the path for testing.
const CONFIG_PATH = process.env.PI_ADVISER_CONFIG || join(getAgentDir(), "adviser.json");
const DEFAULT_ENABLED = true;

const TOOL_RESULT_MAX_CHARS = 2000; // per tool result
const PASS_INPUT_MAX_CHARS = 9000; // total tool activity per pass
const CONCERNS_MAX_CHARS = 900; // per-note cap
const DIGEST_MAX_CHARS = 700; // per-advisor memory, hard cap
const NOTES_MAX_CHARS = 3000; // combined injected notes, hard cap
const PASS_CONCURRENCY = 8; // advisors in flight at once

const SYSTEM_PROMPT = `You are Adviser, a second-opinion reviewer inside a coding agent session. You watch what the main agent reads and runs, and you flag real problems with sharp questions.

Input format:
- DIGEST: your memory of previous findings and their status.
- NEW TOOL ACTIVITY: tool calls and outputs since your last review.

Rules:
- Flag only what matters: concrete mistakes, missing verification, risky or destructive commands, contradictions with your digest, wasted work.
- Do not comment on code style, trivialities, or anything your digest shows as resolved.
- You can only review what is shown. You cannot read files or run tools.

Reply with exactly one JSON object and no other text:
{"concerns": "message to the main agent: sharp questions and checks it must answer. Empty string when nothing is worth saying. Max 150 words.", "digest": "your updated memory: findings, resolved status, open concerns. Max 100 words."}`;

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

let enabled = readConfig(CONFIG_PATH); // default: on
let roster: Roster | null = null; // canonical roster, loaded at session start
const digests = new Map<string, string>(); // advisor name -> rolling memory
const lastConcerns = new Map<string, string>(); // advisor name -> last delivered concern
let pendingNotes: { advisor: string; text: string }[] | null = null; // waiting for the next LLM call
let pendingStamp = 0; // turn-end time of the turn the pending wave reviewed
let passing = false; // coalescing: skip turns while a wave is in flight
let shutdown = false; // session is being torn down; stop touching ctx

// ---------------------------------------------------------------------------
// Pure helpers - exported for tests.
// ---------------------------------------------------------------------------

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Do not split a surrogate pair at the cut point (non-UTF8 safety).
  const cut = max - (text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? 1 : 0);
  return text.slice(0, cut) + "\n...[truncated]";
}

/** Read the persisted on/off state. Missing or broken config -> default on. Exported for tests. */
export function readConfig(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_ENABLED;
  } catch {
    return DEFAULT_ENABLED;
  }
}

/** Persist the on/off state so new sessions restore it. Exported for tests. */
export function writeConfig(path: string, enabled: boolean): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabled }, null, 2) + "\n");
  } catch (error) {
    log("error writing config:", error);
  }
}

/** Extract text from a tool result's content parts. */
export function toolResultText(content: { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Build an advisor's pass input: its digest + new tool activity. */
export function buildPassInput(
  digest: string,
  entries: { toolName: string; text: string }[],
): string {
  let body = "";
  for (const entry of entries) {
    const block = `## ${entry.toolName}\n${truncate(entry.text, TOOL_RESULT_MAX_CHARS)}\n`;
    if (body.length + block.length > PASS_INPUT_MAX_CHARS) break;
    body += block;
  }
  return `DIGEST:\n${digest || "(none)"}\n\nNEW TOOL ACTIVITY:\n${body}`;
}

/**
 * Parse an advisor's reply. Expects one JSON object {concerns, digest}.
 * Falls back to treating the whole reply as concerns when JSON is not
 * recoverable. Returns digest "" when the reply did not provide one.
 */
export function parseAdviserOutput(text: string): { concerns: string; digest: string } {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      return {
        concerns:
          typeof obj.concerns === "string" ? obj.concerns.trim().slice(0, CONCERNS_MAX_CHARS) : "",
        digest:
          typeof obj.digest === "string" ? obj.digest.trim().slice(0, DIGEST_MAX_CHARS) : "",
      };
    } catch {
      // fall through to the fallback below
    }
  }
  return { concerns: truncate(cleaned, CONCERNS_MAX_CHARS), digest: "" };
}

/** Newest user-message timestamp in a message list; 0 when none. Exported for tests. */
export function newestUserTimestamp(
  messages: { role?: string; timestamp?: number | string }[],
): number {
  let newest = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = typeof m.timestamp === "number" ? m.timestamp : Date.parse(String(m.timestamp)) || 0;
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * True when a newer user message arrived after the reviewed turn ended -
 * the pending advice is stale and must not be injected. Exported for tests.
 */
export function isStale(messages: { role?: string; timestamp?: number | string }[], stamp: number): boolean {
  return newestUserTimestamp(messages) > stamp;
}

/** Build the injected context message. Exported for tests. */
export function buildInjection(concerns: string): Record<string, unknown> {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[adviser] Note from a review of earlier tool activity (not the user's current instruction): ${concerns}`,
      },
    ],
    timestamp: Date.now(),
  };
}

/** Resolve the new enabled state from a /adviser argument. Exported for tests. */
export function applyCommand(state: boolean, arg: string): boolean {
  const a = arg.trim().toLowerCase();
  if (a === "on") return true;
  if (a === "off") return false;
  return !state; // bare /adviser toggles
}

/** Combine per-advisor notes into one injected text, hard-capped. Exported for tests. */
export function combineNotes(
  notes: { advisor: string; text: string }[],
  max = NOTES_MAX_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const note of notes) {
    const line = `- [${note.advisor}] ${note.text}`;
    if (used + line.length > max) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Deterministic no-repeat: an advisor's concern is suppressed when it is
 * unchanged from the last one delivered. Returns the concern to deliver,
 * or null when it is an unchanged repeat. Exported for tests.
 */
export function dedupeConcern(advisor: string, concerns: string, last: Map<string, string>): string | null {
  if (last.get(advisor) === concerns) return null;
  last.set(advisor, concerns);
  return concerns;
}

// ---------------------------------------------------------------------------
// Extension logic.
// ---------------------------------------------------------------------------

function log(...parts: unknown[]): void {
  if (DEBUG) console.error("[adviser]", ...parts);
}

/**
 * Parse a model pin "provider/model:reasoning" into its parts. The reasoning
 * suffix is required so max thinking is always explicit. Returns null when
 * the pin is malformed (fail closed - never guess a model). Exported for tests.
 */
export function parseModelPin(spec: string): { provider: string; modelId: string; reasoning: string } | null {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return null;
  const rest = spec.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return null;
  return {
    provider: spec.slice(0, slash),
    modelId: rest.slice(0, colon),
    reasoning: rest.slice(colon + 1),
  };
}

/**
 * The effective model pin for an advisor. The dev override (PI_ADVISER_MODEL)
 * is honored only when it resolves to the exact same model and reasoning as
 * the roster pin; any other override is ignored so runtime calls always use
 * the required pin with max reasoning. Returns null on a malformed spec.
 * Exported for tests.
 */
export function effectiveModelPin(spec: string, override: string): string | null {
  const pin = parseModelPin(spec);
  if (!pin) return null;
  if (override) {
    const candidate = parseModelPin(override);
    if (
      candidate &&
      candidate.provider === pin.provider &&
      candidate.modelId === pin.modelId &&
      candidate.reasoning === pin.reasoning
    ) {
      return override;
    }
    log("ignoring model override (does not match roster pin):", override);
  }
  return spec;
}

/**
 * Resolve a roster model pin like "particle/deepseek-v4-flash-0731:max".
 * The ":max" suffix is the thinking level, passed as options.reasoning.
 */
function resolveRosterModel(ctx: ExtensionContext, spec: string): { model: unknown; reasoning: string } | null {
  const target = effectiveModelPin(spec, MODEL_OVERRIDE);
  if (!target) {
    log("error: malformed roster model pin:", spec);
    return null;
  }
  const pin = parseModelPin(target);
  if (!pin) return null;
  const model = ctx.modelRegistry.find(pin.provider, pin.modelId);
  return model ? { model, reasoning: pin.reasoning } : null;
}

/** An advisor's system prompt: shared roster contract + its own role. */
function buildAdvisorSystemPrompt(shared: string, advisor: AdvisorSpec): string {
  return `${shared}

Your role: ${advisor.name}.

Role instructions:
${advisor.instructions}

Tools granted to you: none. You are read-only - you review only the tool activity shown in the pass input and report through your note. You never mutate anything; you only report observations for the main agent to act on.

Reply with exactly one JSON object and no other text:
{"concerns": "message to the main agent: one concrete issue, next action, drift, evidence gap, or milestone resolution, patch-anchored to the evidence that produced it. Empty string when nothing is worth saying. Max 150 words.", "digest": "your updated memory: findings, resolved status, open concerns. Max 100 words."}`;
}

function setWidget(ctx: ExtensionContext, lines: string[]): void {
  if (shutdown) return;
  try {
    ctx.ui.setWidget("adviser", lines);
  } catch {
    // ctx can go stale after session replacement or shutdown; widget is cosmetic.
  }
}

/** One advisor reviewing the turn: its digest + the tool activity -> note or silence. */
async function runAdvisorPass(
  ctx: ExtensionContext,
  advisor: AdvisorSpec,
  sharedInstructions: string,
  entries: { toolName: string; text: string }[],
): Promise<{ advisor: string; text: string } | null> {
  try {
    const resolved = resolveRosterModel(ctx, advisor.model);
    if (!resolved) {
      log("error: no model for", advisor.name, advisor.model);
      return null;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model as never);
    if (!auth.apiKey) {
      log("error: no api key for", advisor.name);
      return null;
    }
    const prevDigest = digests.get(advisor.name) ?? "";
    const input = buildPassInput(prevDigest, entries);
    const reply = await completeSimple(
      resolved.model as never,
      {
        systemPrompt: buildAdvisorSystemPrompt(sharedInstructions, advisor),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ctx.signal,
        reasoning: resolved.reasoning,
      },
    );
    if (shutdown) return null; // session ended while an advisor was thinking
    const replyText = reply.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const result = parseAdviserOutput(replyText);
    if (result.digest) digests.set(advisor.name, result.digest);
    if (!result.concerns) return null;
    const text = dedupeConcern(advisor.name, result.concerns, lastConcerns);
    return text ? { advisor: advisor.name, text } : null;
  } catch (error) {
    log("advisor error:", advisor.name, error);
    return null;
  }
}

/** Review the turn with all roster advisors, pooled, then queue their notes. */
async function runRosterPass(
  ctx: ExtensionContext,
  entries: { toolName: string; text: string }[],
  stamp: number,
): Promise<void> {
  const list = roster?.advisors ?? [];
  const shared = roster?.sharedInstructions ?? "";
  if (list.length === 0) {
    setWidget(ctx, ["adviser: error: roster has no advisors"]);
    return;
  }
  setWidget(ctx, [`adviser: ${list.length} advisors reviewing the last tool activity...`]);
  const notes: { advisor: string; text: string }[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      const index = cursor++;
      const note = await runAdvisorPass(ctx, list[index], shared, entries);
      if (note) notes.push(note);
    }
  };
  const pool = Math.min(PASS_CONCURRENCY, list.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  if (shutdown) return;
  if (notes.length) {
    pendingNotes = notes;
    pendingStamp = stamp;
    setWidget(ctx, [
      `adviser: ${notes.length} of ${list.length} advisors flagged`,
      truncate(combineNotes(notes), 160),
    ]);
    log("flagged", notes.length, "note(s)");
  } else {
    setWidget(ctx, [`adviser: ${list.length} advisors, nothing to flag`]);
    log("clean");
  }
}

export default function (pi: ExtensionAPI): void {
  // New session (or reload): the roster is per-machine, memory is per-conversation.
  pi.on("session_start", () => {
    enabled = readConfig(CONFIG_PATH); // restore the saved state; it persists across sessions
    digests.clear();
    lastConcerns.clear();
    pendingNotes = null;
    pendingStamp = 0;
    passing = false;
    shutdown = false;
    roster = loadRoster();
    if (roster) {
      const issues = validateRoster(roster);
      if (issues.length > 0) {
        log("error: invalid roster rejected:", issues.map((it) => it.message).join("; "));
        roster = null; // fail closed: never run advisors on incomplete/malformed roster data
      } else {
        log("roster loaded:", roster.sourcePath, "-", roster.advisors.length, "advisors");
      }
    } else {
      log("error: no roster at", resolveRosterPath());
    }
    syncAdviserCommand(); // reflect the restored state in the command list
  });

  // Session ending: stop touching ctx; the adviser never delays or blocks exit.
  pi.on("session_shutdown", () => {
    shutdown = true;
  });

  // Trigger: one coalesced wave per turn, only when the turn produced tool results.
  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!enabled || passing) return;
    if (!roster) {
      setWidget(ctx, ["adviser: error: no roster - set PI_ADVISER_ROSTER"]);
      return;
    }
    const entries: { toolName: string; text: string }[] = [];
    for (const result of event.toolResults) {
      const text = toolResultText(result.content as { type: string; text?: string }[]);
      if (text.trim()) entries.push({ toolName: result.toolName, text });
    }
    if (entries.length === 0) return;
    passing = true;
    const stamp = Date.now(); // the turn this wave reviews
    void runRosterPass(ctx, entries, stamp).finally(() => {
      passing = false;
    });
  });

  // Delivery: the next LLM call sees the pending notes once, then they clear.
  // Stale notes are dropped: if a newer user message has arrived since the
  // reviewed turn ended, the agent has moved on. Silence is the default.
  pi.on("context", (event, ctx: ExtensionContext) => {
    if (!pendingNotes || pendingNotes.length === 0) return;
    if (isStale(event.messages, pendingStamp)) {
      pendingNotes = null;
      log("dropped stale notes (user moved on)");
      return;
    }
    const notes = pendingNotes;
    pendingNotes = null;
    log("delivered", notes.length, "note(s) to next LLM call");
    return { messages: [...event.messages, buildInjection(combineNotes(notes))] };
  });

  // The on/off switch. Bare /adviser toggles; on/off set explicitly.
  // Re-registered on every state change so the command list shows the live
  // state ("Adviser: on" / "Adviser: off") instead of a static description.
  const adviserHandler = async (args: string | undefined, ctx: ExtensionCommandContext) => {
    const on = applyCommand(enabled, args ?? "");
    if (!on) {
      pendingNotes = null; // never deliver advice while off
      pendingStamp = 0;
    }
    enabled = on;
    writeConfig(CONFIG_PATH, enabled); // persist so new sessions keep the state
    if (enabled) {
      setWidget(ctx, roster ? [`adviser: on (${roster.advisors.length} advisors)`] : ["adviser: on (roster not loaded)"]);
      ctx.ui.notify("Adviser on", "info");
    } else {
      setWidget(ctx, []);
      ctx.ui.notify("Adviser off", "info");
    }
    syncAdviserCommand();
  };
  const syncAdviserCommand = (): void => {
    pi.registerCommand("adviser", {
      description: `Adviser: ${enabled ? "on" : "off"}`,
      handler: adviserHandler,
    });
  };
  syncAdviserCommand();
}
