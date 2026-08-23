/**
 * roster - loads the canonical 100-advisor roster from WATCHDOG.yml.
 *
 * The file is a small, deterministic subset of YAML (block scalars plus a
 * top-level `advisors:` sequence). Pi's extension loader only exposes its
 * statically bundled packages to extensions, so this module uses a tiny
 * targeted parser instead of a YAML dependency. It is written for exactly
 * the canonical file's shape and is validated by test.ts.
 *
 * The Pi adapter grants advisors zero tools. The roster's `x-tool-tiers`
 * block is parsed into real tool-name lists (both the inline `t1: &t1 [a,b]`
 * form and the block-sequence `common: &common` + `- a` form) and each
 * advisor's `tools` reference is resolved to its names. Those names are used
 * only for evidence and contract checks - never translated into runtime tools
 * in Pi, where advisors stay read-only and request actions from the main agent.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The exact model pin every roster role must carry (kept byte-identical). */
export const ROSTER_MODEL = "particle/deepseek-v4-flash-0731:max";
export const ROSTER_EXPECTED = 100;

export interface AdvisorSpec {
  name: string;
  enabled: boolean;
  model: string;
  /** Resolved tool names granted by the roster tier (e.g. "read", "grep").
   *  Informational only in Pi: advisors never receive runtime tools. */
  tools: string[];
  /** Canonical life/work domain when the roster labels one (e.g. "health/wellbeing"). */
  domain?: string;
  instructions: string;
}

export interface Roster {
  sourcePath: string;
  sharedInstructions: string;
  advisors: AdvisorSpec[];
}

export interface RosterIssue {
  advisor: string | null;
  message: string;
}

/** PI_ADVISER_ROSTER override, else the live canonical file, else the repo copy. */
export function resolveRosterPath(): string {
  const explicit = process.env.PI_ADVISER_ROSTER?.trim();
  if (explicit) return explicit;
  const live = join(homedir(), ".omp", "agent", "WATCHDOG.yml");
  try {
    readFileSync(live, "utf8");
    return live;
  } catch {
    return join(homedir(), "omp-advisors", "WATCHDOG.yml");
  }
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/**
 * Strip `#` comments, but only outside block scalars. Block-scalar content
 * (lines indented deeper than their `key: |` line) is kept verbatim so an
 * instruction containing `#` is never corrupted.
 */
function stripYamlComments(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  let blockIndent = 0;
  for (const raw of lines) {
    if (inBlock) {
      if (raw.trim() === "" || indentOf(raw) > blockIndent) {
        out.push(raw); // block content: keep verbatim
        continue;
      }
      inBlock = false;
    }
    const stripped = raw.replace(/\s*#.*$/, "").replace(/\s+$/, "");
    if (/[|][>-]?$/.test(stripped)) {
      inBlock = true;
      blockIndent = indentOf(stripped);
    }
    out.push(stripped);
  }
  return out.join("\n");
}

/**
 * Strip the common minimum indentation from block-scalar content (standard
 * YAML block behavior), so the resulting text is clean for prompts.
 */
function dedentBlock(lines: string[]): string {
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return "";
  const minIndent = Math.min(...nonEmpty.map((l) => indentOf(l)));
  return lines
    .map((l) => (l.trim() === "" ? "" : l.slice(minIndent)))
    .join("\n")
    .trim();
}

function splitTools(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse one `x-tool-tiers` line into the tier keys it declares and any
 * inline tool list. Supports both canonical shapes:
 *   - `t1: &t1 [read, glob, grep]`   inline array (old shape)
 *   - `common: &common`              block header; tools follow as `- name`
 *                                     lines (current canonical shape)
 * Also accepts bare `&t1`, `t1: [a, b]`, `&t1 [a, b]`, and plain `t1:`.
 * Returns null when the line is not a tier declaration.
 */
function parseTierLine(line: string): { keys: string[]; tools: string[] | null } | null {
  const t = line.trim();
  let m = t.match(/^([\w-]+):\s*&([\w-]+)\s*\[([^\]]*)\]\s*$/); // t1: &t1 [a,b]
  if (m) return { keys: [m[1], m[2]], tools: splitTools(m[3]) };
  m = t.match(/^&([\w-]+)\s*\[([^\]]*)\]\s*$/); // &t1 [a,b]
  if (m) return { keys: [m[1]], tools: splitTools(m[2]) };
  m = t.match(/^([\w-]+):\s*\[([^\]]*)\]\s*$/); // t1: [a,b]
  if (m) return { keys: [m[1]], tools: splitTools(m[2]) };
  m = t.match(/^([\w-]+):\s*&([\w-]+)\s*$/); // common: &common
  if (m) return { keys: [m[1], m[2]], tools: null };
  m = t.match(/^&([\w-]+)\s*$/); // &common
  if (m) return { keys: [m[1]], tools: null };
  m = t.match(/^([\w-]+):\s*$/); // common:
  if (m) return { keys: [m[1]], tools: null };
  return null;
}

/** Resolve an advisor's `tools:` value to tool names against the tier map. */
function resolveTools(raw: string, tiers: Map<string, string[]>): string[] {
  const v = raw.trim();
  if (!v) return [];
  if (v.startsWith("*")) return tiers.get(v.slice(1)) ?? [];
  if (v.startsWith("[")) {
    const close = v.lastIndexOf("]");
    return splitTools(v.slice(1, close > 0 ? close : v.length));
  }
  if (tiers.has(v)) return tiers.get(v) ?? [];
  return splitTools(v);
}

/**
 * Parse the canonical roster. Returns the shared `instructions` block and the
 * full advisor list. Tolerant of exact indentation: item keys are found by
 * scanning between an item's `- ` line and the next line at the same indent.
 */
export function parseRosterYaml(text: string): { sharedInstructions: string; advisors: AdvisorSpec[] } {
  const lines = stripYamlComments(text).split("\n");
  const advisors: AdvisorSpec[] = [];
  const tiers = new Map<string, string[]>();
  let sharedInstructions = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    if (indent === 0) {
      if (/^x-tool-tiers:\s*$/.test(trimmed)) {
        // Collect every indented tier declaration below this key.
        let k = i + 1;
        let currentKeys: string[] = [];
        let currentTools: string[] | null = null;
        while (k < lines.length && indentOf(lines[k]) > 0) {
          const l = lines[k];
          if (l.trim() === "") {
            k++;
            continue;
          }
          const item = l.trim().match(/^-\s+(.+)$/);
          if (item) {
            // Block-sequence tier: append to the open tier's tools.
            if (currentKeys.length) {
              currentTools ??= [];
              currentTools.push(item[1].trim());
            }
            k++;
            continue;
          }
          // A new tier declaration closes the previous one.
          if (currentKeys.length) {
            for (const key of currentKeys) tiers.set(key, currentTools ?? []);
          }
          const header = parseTierLine(l);
          currentKeys = header?.keys ?? [];
          currentTools = header?.tools ?? null;
          k++;
        }
        if (currentKeys.length) {
          for (const key of currentKeys) tiers.set(key, currentTools ?? []);
        }
        i = k;
        continue;
      }
      if (/^instructions:\s*\|?[>-]?$/.test(trimmed)) {
        const parts: string[] = [];
        let k = i + 1;
        while (k < lines.length) {
          if (lines[k].trim() === "") {
            k++;
            continue;
          }
          if (indentOf(lines[k]) === 0) break; // next top-level key ends the block
          parts.push(lines[k]);
          k++;
        }
        sharedInstructions = dedentBlock(parts);
        i = k;
        continue;
      }
      if (trimmed === "advisors:") {
        i++;
        while (i < lines.length) {
          const itemLine = lines[i];
          const itemIndent = indentOf(itemLine);
          if (itemLine.trim() === "") {
            i++;
            continue;
          }
          if (itemIndent === 0) break; // next top-level key ends the list
          if (!itemLine.trimStart().startsWith("- ")) {
            i++;
            continue;
          }
          const item: AdvisorSpec = { name: "", enabled: true, model: "", tools: [], instructions: "" };
          const inlineName = itemLine.trimStart().match(/^-\s*name:\s*(.+)$/);
          if (inlineName) item.name = inlineName[1].trim();
          // Find where this item's key block ends (next `- ` at same indent).
          let itemEnd = i + 1;
          while (itemEnd < lines.length) {
            const l = lines[itemEnd];
            if (l.trim() === "") {
              itemEnd++;
              continue;
            }
            if (indentOf(l) === 0) break;
            if (indentOf(l) === itemIndent && l.trimStart().startsWith("- ")) break;
            itemEnd++;
          }
          // Scan the item's keys.
          let j = i + 1;
          let collectingInstructions = false;
          let instrIndent = -1;
          const instrParts: string[] = [];
          while (j < itemEnd) {
            const l = lines[j];
            if (collectingInstructions) {
              if (indentOf(l) > instrIndent) {
                instrParts.push(l);
                j++;
                continue;
              }
              collectingInstructions = false;
            }
            const km = l.match(/^(\s*)([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
            if (km && indentOf(l) > itemIndent) {
              const key = km[2];
              const val = km[3].trim();
              if (key === "name" && val) item.name = val;
              else if (key === "enabled") item.enabled = val.toLowerCase() === "true";
              else if (key === "model" && val) item.model = val;
              else if (key === "tools") item.tools = resolveTools(val, tiers);
              else if (key === "domain" && val) item.domain = val;
              else if (key === "instructions") {
                if (/[|][>-]?$/.test(val)) {
                  collectingInstructions = true;
                  instrIndent = indentOf(l);
                } else if (val) {
                  item.instructions = val;
                }
              }
            }
            j++;
          }
          if (instrParts.length) item.instructions = dedentBlock(instrParts);
          advisors.push(item);
          i = itemEnd;
        }
        continue;
      }
    }
    i++;
  }
  return { sharedInstructions, advisors };
}

/** Load and parse the roster. Returns null when the file is unreadable or malformed. */
export function loadRoster(filePath?: string): Roster | null {
  const sourcePath = filePath ?? resolveRosterPath();
  try {
    const parsed = parseRosterYaml(readFileSync(sourcePath, "utf8"));
    return {
      sourcePath,
      sharedInstructions: parsed.sharedInstructions,
      advisors: parsed.advisors,
    };
  } catch {
    return null;
  }
}

/**
 * Validate the canonical contract: exactly 100 advisors, all enabled, every
 * model pin byte-identical, unique names, resolved tools on each, and non-empty
 * shared plus per-advisor instructions.
 */
export function validateRoster(roster: Roster): RosterIssue[] {
  const issues: RosterIssue[] = [];
  if (!roster.sharedInstructions.trim()) {
    issues.push({ advisor: null, message: "shared instructions missing" });
  }
  if (roster.advisors.length !== ROSTER_EXPECTED) {
    issues.push({
      advisor: null,
      message: `expected ${ROSTER_EXPECTED} advisors, found ${roster.advisors.length}`,
    });
  }
  const seen = new Set<string>();
  for (const a of roster.advisors) {
    if (!a.name || seen.has(a.name)) {
      issues.push({ advisor: a.name || "(unnamed)", message: "missing or duplicate name" });
    }
    seen.add(a.name);
    if (!a.enabled) issues.push({ advisor: a.name, message: "not enabled" });
    if (a.model !== ROSTER_MODEL) {
      issues.push({ advisor: a.name, message: `model '${a.model}' != '${ROSTER_MODEL}'` });
    }
    if (a.tools.length === 0) issues.push({ advisor: a.name, message: "tools missing" });
    if (!a.instructions.trim()) issues.push({ advisor: a.name, message: "instructions missing" });
  }
  return issues;
}
