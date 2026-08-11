/**
 * adviser - a lean second-opinion reviewer for pi.
 *
 * Watches what the main agent reads and runs, then asks it sharp questions
 * and checks - one model call per tool-bearing turn, injected into the
 * next LLM call. It never re-reads the conversation: each pass gets only
 * its own rolling digest (what it flagged before) plus the new tool output.
 *
 * Usage:
 *   - Installed: on at the start of every session. /adviser on|off - bare /adviser toggles.
 *   - Config: PI_ADVISER_MODEL="provider/id" to pick a different model
 *     (default: the main agent's current model).
 *   - Debug: PI_ADVISER_DEBUG=1 logs pass outcomes to stderr.
 *
 * Design rules:
 *   - Never blocks or interrupts the main agent.
 *   - One pass per turn, only when the turn had tool results.
 *   - No stale injections: each pass is stamped with its turn's end time;
 *     delivery is dropped once a newer user message has arrived.
 *   - Silence is the default: the adviser speaks only when something matters.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";

// ---------------------------------------------------------------------------
// Config - the entire config surface.
// ---------------------------------------------------------------------------

const MODEL_OVERRIDE = process.env.PI_ADVISER_MODEL?.trim() ?? "";
const DEBUG = process.env.PI_ADVISER_DEBUG === "1";

const TOOL_RESULT_MAX_CHARS = 2000; // per tool result
const PASS_INPUT_MAX_CHARS = 9000; // total tool activity per pass
const CONCERNS_MAX_CHARS = 900; // injected note, hard cap
const DIGEST_MAX_CHARS = 700; // adviser memory, hard cap

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

let enabled = true;
let digest = ""; // adviser memory: what it flagged, what is open
let pendingConcerns: string | null = null; // advice waiting for the next LLM call
let pendingStamp = 0; // turn-end time of the turn the pending pass reviewed
let passing = false; // coalescing: skip turns while a pass is in flight
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

/** Extract text from a tool result's content parts. */
export function toolResultText(content: { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Build the adviser's pass input: digest + new tool activity. */
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
 * Parse the adviser's reply. Expects one JSON object {concerns, digest}.
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

// ---------------------------------------------------------------------------
// Extension logic.
// ---------------------------------------------------------------------------

function log(...parts: unknown[]): void {
  if (DEBUG) console.error("[adviser]", ...parts);
}

function resolveModel(ctx: ExtensionContext) {
  if (MODEL_OVERRIDE) {
    const slash = MODEL_OVERRIDE.indexOf("/");
    if (slash > 0 && slash < MODEL_OVERRIDE.length - 1) {
      const model = ctx.modelRegistry.find(
        MODEL_OVERRIDE.slice(0, slash),
        MODEL_OVERRIDE.slice(slash + 1),
      );
      if (model) return model;
      log("model override not found, falling back to main model:", MODEL_OVERRIDE);
    }
  }
  return ctx.model;
}

function setWidget(ctx: ExtensionContext, lines: string[]): void {
  if (shutdown) return;
  try {
    ctx.ui.setWidget("adviser", lines);
  } catch {
    // ctx can go stale after session replacement or shutdown; widget is cosmetic.
  }
}

async function runPass(ctx: ExtensionContext, input: string, stamp: number): Promise<void> {
  try {
    const model = resolveModel(ctx);
    if (!model) {
      log("error: no model available");
      setWidget(ctx, ["adviser: error: no model available"]);
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.apiKey) {
      log("error: no api key for", model.id);
      setWidget(ctx, ["adviser: error: no api key"]);
      return;
    }
    setWidget(ctx, ["adviser: reviewing the last tool activity..."]);
    const reply = await completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
    );
    if (shutdown) return; // session ended while the adviser was thinking
    const replyText = reply.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const result = parseAdviserOutput(replyText);
    if (result.digest) digest = result.digest;
    if (result.concerns) {
      pendingConcerns = result.concerns;
      pendingStamp = stamp;
      setWidget(ctx, [
        "adviser: flagged - questions will reach the agent",
        truncate(pendingConcerns, 160),
      ]);
      log("flagged:", pendingConcerns);
    } else {
      setWidget(ctx, ["adviser: nothing to flag"]);
      log("clean");
    }
  } catch (error) {
    setWidget(ctx, [
      "adviser: error: " + (error instanceof Error ? error.message : String(error)).slice(0, 80),
    ]);
    log("error:", error);
  }
}

export default function (pi: ExtensionAPI): void {
  // New session (or reload): the adviser memory is per-conversation.
  pi.on("session_start", () => {
    enabled = true; // always on at the start of a session; off never persists across sessions
    digest = "";
    pendingConcerns = null;
    pendingStamp = 0;
    passing = false;
    shutdown = false;
  });

  // Session ending: stop touching ctx; the adviser never delays or blocks exit.
  pi.on("session_shutdown", () => {
    shutdown = true;
  });

  // Trigger: one pass per turn, only when the turn produced tool results.
  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!enabled || passing) return;
    const entries: { toolName: string; text: string }[] = [];
    for (const result of event.toolResults) {
      const text = toolResultText(result.content as { type: string; text?: string }[]);
      if (text.trim()) entries.push({ toolName: result.toolName, text });
    }
    if (entries.length === 0) return;
    passing = true;
    const stamp = Date.now(); // the turn this pass reviews
    const input = buildPassInput(digest, entries);
    void runPass(ctx, input, stamp).finally(() => {
      passing = false;
    });
  });

  // Delivery: the next LLM call sees the pending advice once, then it clears.
  // Stale advice is dropped: if a newer user message has arrived since the
  // reviewed turn ended, the agent has moved on. Silence is the default.
  pi.on("context", (event, ctx: ExtensionContext) => {
    if (!pendingConcerns) return;
    if (isStale(event.messages, pendingStamp)) {
      pendingConcerns = null;
      log("dropped stale concerns (user moved on)");
      return;
    }
    const concerns = pendingConcerns;
    pendingConcerns = null;
    log("delivered to next LLM call");
    return { messages: [...event.messages, buildInjection(concerns)] };
  });

  // The on/off switch. Bare /adviser toggles; on/off set explicitly.
  pi.registerCommand("adviser", {
    description: "Adviser: on, off, or toggle",
    handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
      const on = applyCommand(enabled, args ?? "");
      if (!on) {
        pendingConcerns = null;
        pendingStamp = 0;
      }
      enabled = on;
      if (enabled) {
        setWidget(ctx, ["adviser: on"]);
        ctx.ui.notify("Adviser on", "info");
      } else {
        setWidget(ctx, []);
        ctx.ui.notify("Adviser off", "info");
      }
    },
  });
}
