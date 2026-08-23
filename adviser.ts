/**
 * adviser - the canonical 100-advisor roster as a pi extension.
 *
 * On each content-bearing turn - tool activity, a user instruction, or a main
 * agent reply - the roster advisors review the turn's evidence in parallel
 * (small pool), each with its own rolling digest. Their notes are coalesced
 * into one injected context message on the next LLM call.
 *
 * Advisors hold zero tools: they review only the evidence in the pass input
 * and report through their note. They never call tools and never mutate
 * anything; every action they want taken is named in `requestedAction` for the
 * main agent to execute, and it is surfaced in the injected note. OMP remains
 * the full-tool execution host.
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
 *   - One coalesced wave per turn, for every content-bearing turn (tool-less
 *     user turns included); a turn is never re-reviewed.
 *   - No stale injections: each wave is stamped with its turn's end time;
 *     delivery is dropped once a newer user message has arrived.
 *   - No repeats: an advisor's unchanged note is suppressed.
 *   - Silence is the default: an advisor speaks only when something matters.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
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
const USER_TEXT_MAX_CHARS = 2000; // latest user instruction shown to advisors
const ASSISTANT_TEXT_MAX_CHARS = 2000; // latest main-agent reply shown to advisors
const PASS_INPUT_MAX_CHARS = 9000; // total pass input budget
const NOTE_MAX_CHARS = 900; // per-note cap
const ACTION_MAX_CHARS = 400; // per requested-action cap
const DIGEST_MAX_CHARS = 700; // per-advisor memory, hard cap
const NOTES_MAX_CHARS = 3000; // combined injected notes, hard cap
const PASS_CONCURRENCY = 8; // advisors in flight at once

const SYSTEM_PROMPT = `You are an adviser in the Adviser extension inside a Pi agent session. You watch the working session - the user's requests, the main agent's replies, and the tool activity it reports - and you proactively advise across work, life, and world decisions. You never run tools and you never act: you observe only the evidence shown to you and you report, so the main agent can act.

Input format:
- DIGEST: your memory of previous findings and their status.
- USER INSTRUCTION: the user's latest request (shown when a turn without tool activity is reviewed).
- MAIN AGENT REPLY: the main agent's latest response (shown when a turn without tool activity is reviewed).
- NEW TOOL ACTIVITY: tool calls and outputs the main agent reported since your last review.

Rules:
- Evaluate every relevant turn proactively, including turns with no tool activity. Do not wait to be summoned; silence is the spam control.
- Flag only what matters and is grounded in the evidence shown. Name one concrete thing per note: an action, a discovery, a change, an opportunity, or a risk.
- Name the action you want the main agent to take in requestedAction. You cannot take it yourself.
- You can only review what is shown. You cannot read files, browse, or run tools.

Reply with exactly one JSON object and no other text:
{"note": "one concrete observation for the main agent: an action taken, a discovery, a change, an opportunity, or an emerging risk, anchored to the evidence that produced it. Empty string when nothing is worth saying. Max 150 words.", "requestedAction": "the exact action the main agent should take; empty string when none. Max 50 words.", "digest": "your updated memory: findings, resolved status, open concerns. Max 100 words."}`;

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
let lastUserInput = ""; // latest user instruction (from the input event)
let lastUserInputTime = 0; // when that instruction arrived
let lastReviewedInputTime = 0; // input time of the last reviewed turn (no-repeat)

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

/** Extract the visible text from an assistant message's content parts. Exported for tests. */
export function assistantMessageText(message: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}

/** Reduce the turn's tool results to non-empty text entries. Exported for tests. */
export function toolResultsToEntries(
  toolResults: { toolName: string; content?: { type: string; text?: string }[] }[],
): { toolName: string; text: string }[] {
  const entries: { toolName: string; text: string }[] = [];
  for (const result of toolResults) {
    const text = toolResultText((result.content ?? []) as { type: string; text?: string }[]);
    if (text.trim()) entries.push({ toolName: result.toolName, text });
  }
  return entries;
}

/** Everything advisors may see about one turn. */
export interface TurnEvidence {
  /** Latest user instruction (trimmed, capped). */
  userText: string;
  /** Latest main-agent reply (trimmed, capped). */
  assistantText: string;
  /** Non-empty tool results from the turn. */
  toolEntries: { toolName: string; text: string }[];
}

/**
 * Compose the evidence for one turn: the user instruction captured from the
 * input event, the main agent's reply, and the turn's tool results. Each text
 * source is capped so the combined pass stays bounded. Exported for tests.
 */
export function buildTurnEvidence(
  assistantMessage: { content?: Array<{ type?: string; text?: string }> },
  toolResults: { toolName: string; content?: { type: string; text?: string }[] }[],
  userText: string,
): TurnEvidence {
  return {
    userText: truncate(userText.trim(), USER_TEXT_MAX_CHARS),
    assistantText: truncate(assistantMessageText(assistantMessage), ASSISTANT_TEXT_MAX_CHARS),
    toolEntries: toolResultsToEntries(toolResults),
  };
}

/**
 * A turn is worth reviewing when it carries any evidence: user text, an
 * assistant reply, or tool activity. Tool-less user turns are included so
 * advisors proactively cover the whole working session. Exported for tests.
 */
export function shouldReviewTurn(evidence: TurnEvidence): boolean {
  return (
    evidence.userText.length > 0 ||
    evidence.assistantText.length > 0 ||
    evidence.toolEntries.length > 0
  );
}

/** Build an advisor's pass input: its digest + the turn's evidence. */
export function buildPassInput(digest: string, evidence: TurnEvidence): string {
  const parts: string[] = [];
  if (evidence.userText) {
    parts.push(`USER INSTRUCTION:\n${truncate(evidence.userText, USER_TEXT_MAX_CHARS)}`);
  }
  if (evidence.assistantText) {
    parts.push(`MAIN AGENT REPLY:\n${truncate(evidence.assistantText, ASSISTANT_TEXT_MAX_CHARS)}`);
  }
  let body = "";
  for (const entry of evidence.toolEntries) {
    const block = `## ${entry.toolName}\n${truncate(entry.text, TOOL_RESULT_MAX_CHARS)}\n`;
    if (body.length + block.length > PASS_INPUT_MAX_CHARS) break;
    body += block;
  }
  if (body) parts.push(`NEW TOOL ACTIVITY:\n${body}`);
  return `DIGEST:\n${digest || "(none)"}\n\n${parts.join("\n\n")}`;
}

/**
 * Parse an advisor's reply. Expects one JSON object {note, requestedAction,
 * digest}. Falls back to treating the whole reply as the note when JSON is
 * not recoverable. Returns digest "" when the reply did not provide one.
 */
export function parseAdviserOutput(text: string): {
  note: string;
  requestedAction: string;
  digest: string;
} {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      return {
        note: typeof obj.note === "string" ? obj.note.trim().slice(0, NOTE_MAX_CHARS) : "",
        requestedAction:
          typeof obj.requestedAction === "string"
            ? obj.requestedAction.trim().slice(0, ACTION_MAX_CHARS)
            : "",
        digest: typeof obj.digest === "string" ? obj.digest.trim().slice(0, DIGEST_MAX_CHARS) : "",
      };
    } catch {
      // fall through to the fallback below
    }
  }
  return { note: truncate(cleaned, NOTE_MAX_CHARS), requestedAction: "", digest: "" };
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
export function buildInjection(concerns: string): UserMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[adviser] Proactive notes from roster advisors on the previous turn (background, not the user's current instruction): ${concerns}`,
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

/**
 * Combine per-advisor notes into one injected text, hard-capped. Actions
 * requested by advisors render first so the main agent sees them; every
 * requested action is surfaced, never silently executed. Exported for tests.
 */
export function combineNotes(
  notes: { advisor: string; text: string; action?: string }[],
  max = NOTES_MAX_CHARS,
): string {
  const sections: string[] = [];
  const actions = notes.filter((n) => n.action);
  if (actions.length) {
    sections.push("ACTIONS REQUESTED:\n" + actions.map((n) => `- [${n.advisor}] ${n.action}`).join("\n"));
  }
  const texts = notes.filter((n) => n.text);
  if (texts.length) {
    sections.push("NOTES:\n" + texts.map((n) => `- [${n.advisor}] ${n.text}`).join("\n"));
  }
  let out = sections.join("\n\n");
  if (out.length > max) out = out.slice(0, max);
  return out;
}

/**
 * Deterministic no-repeat: a note (keyed by note text plus requested action)
 * is suppressed when it is unchanged from the last one delivered. Returns
 * true when the note is new and should be delivered. Exported for tests.
 */
export function dedupeConcern(
  advisor: string,
  key: string,
  last: Map<string, string>,
): boolean {
  if (last.get(advisor) === key) return false;
  last.set(advisor, key);
  return true;
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
function resolveRosterModel(ctx: ExtensionContext, spec: string): { model: unknown; reasoning: ThinkingLevel } | null {
  const target = effectiveModelPin(spec, MODEL_OVERRIDE);
  if (!target) {
    log("error: malformed roster model pin:", spec);
    return null;
  }
  const pin = parseModelPin(target);
  if (!pin) return null;
  const model = ctx.modelRegistry.find(pin.provider, pin.modelId);
  return model ? { model, reasoning: pin.reasoning as ThinkingLevel } : null;
}

/**
 * An advisor's system prompt: the shared proactive contract + its own role,
 * with the extension-wide meta-prompt, the no-tools rule, and the report
 * contract. Exported for tests.
 */
export function buildAdvisorSystemPrompt(shared: string, advisor: AdvisorSpec): string {
  return `${SYSTEM_PROMPT}

${shared}

Your role: ${advisor.name}.

Role instructions:
${advisor.instructions}

Tools granted to you: none. You are read-only - you review only the evidence shown in the pass input and report through your note and requestedAction. You never call tools and you never mutate anything; every action you want taken is named in requestedAction for the main agent to execute.

Reply with exactly one JSON object and no other text:
{"note": "one concrete observation for the main agent: an action taken, a discovery, a change, an opportunity, or an emerging risk, anchored to the evidence that produced it. Empty string when nothing is worth saying. Max 150 words.", "requestedAction": "the exact action the main agent should take; empty string when none. Max 50 words.", "digest": "your updated memory: findings, resolved status, open concerns. Max 100 words."}`;
}

function setWidget(ctx: ExtensionContext, lines: string[]): void {
  if (shutdown) return;
  try {
    ctx.ui.setWidget("adviser", lines);
  } catch {
    // ctx can go stale after session replacement or shutdown; widget is cosmetic.
  }
}

/** One advisor reviewing the turn: its digest + the turn's evidence -> note or silence. */
async function runAdvisorPass(
  ctx: ExtensionContext,
  advisor: AdvisorSpec,
  sharedInstructions: string,
  evidence: TurnEvidence,
): Promise<{ advisor: string; text: string; action?: string } | null> {
  try {
    const resolved = resolveRosterModel(ctx, advisor.model);
    if (!resolved) {
      log("error: no model for", advisor.name, advisor.model);
      return null;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model as never);
    if (!auth.ok) {
      log("error: no api key for", advisor.name);
      return null;
    }
    const prevDigest = digests.get(advisor.name) ?? "";
    const input = buildPassInput(prevDigest, evidence);
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
    const key = result.note + "\u0000" + result.requestedAction;
    if (!dedupeConcern(advisor.name, key, lastConcerns)) return null;
    if (!result.note && !result.requestedAction) return null;
    return { advisor: advisor.name, text: result.note, action: result.requestedAction || undefined };
  } catch (error) {
    log("advisor error:", advisor.name, error);
    return null;
  }
}

/** Review the turn with all roster advisors, pooled, then queue their notes. */
async function runRosterPass(
  ctx: ExtensionContext,
  evidence: TurnEvidence,
  stamp: number,
): Promise<void> {
  const list = roster?.advisors ?? [];
  const shared = roster?.sharedInstructions ?? "";
  if (list.length === 0) {
    setWidget(ctx, ["adviser: error: roster has no advisors"]);
    return;
  }
  setWidget(ctx, [`adviser: ${list.length} advisors reviewing the last turn...`]);
  const notes: { advisor: string; text: string; action?: string }[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      const index = cursor++;
      const note = await runAdvisorPass(ctx, list[index], shared, evidence);
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
    lastUserInput = "";
    lastUserInputTime = 0;
    lastReviewedInputTime = 0;
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

  // Input: capture the latest user instruction so advisors can review turns
  // that had no tool activity. Command dispatches and the adviser's own
  // injections are skipped so they never surface as user intent.
  pi.on("input", (event: InputEvent) => {
    const text = typeof event.text === "string" ? event.text : "";
    const t = text.trim();
    if (!t || t.startsWith("/") || t.startsWith("[adviser]")) return;
    lastUserInput = t;
    lastUserInputTime = Date.now();
  });

  // Trigger: one coalesced wave per content-bearing turn. Tool-less turns
  // (a user instruction, a main agent reply) are reviewed too, and a turn is
  // never re-reviewed: the input guard and the no-repeat stamp both hold.
  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!enabled || passing) return;
    if (!roster) {
      setWidget(ctx, ["adviser: error: no roster - set PI_ADVISER_ROSTER"]);
      return;
    }
    const evidence = buildTurnEvidence(
      "content" in event.message && Array.isArray(event.message.content)
        ? { content: event.message.content }
        : {},
      event.toolResults,
      lastUserInput,
    );
    // No-repeat: skip unless this turn has evidence we have not reviewed.
    // A turn with tool activity is always new; a tool-less turn is reviewed
    // exactly once per new user input.
    if (lastUserInputTime <= lastReviewedInputTime && evidence.toolEntries.length === 0) {
      return;
    }
    if (!shouldReviewTurn(evidence)) return;
    lastReviewedInputTime = lastUserInputTime;
    passing = true;
    const stamp = Date.now(); // the turn this wave reviews
    void runRosterPass(ctx, evidence, stamp).finally(() => {
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
