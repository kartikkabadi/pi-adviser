/**
 * roster - loads the canonical 100-advisor roster from WATCHDOG.yml.
 *
 * The file is a small, deterministic subset of YAML (block scalars plus a
 * top-level `advisors:` sequence). Pi's extension loader only exposes its
 * statically bundled packages to extensions, so this module uses a tiny
 * targeted parser instead of a YAML dependency. It is written for exactly
 * the canonical file's shape and is validated by test.ts.
 *
 * The Pi adapter grants advisors zero tools; the roster's `tools` tier is
 * read as a marker (present/absent) and never translated into runtime tools.
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
  /** true when the roster grants this advisor a canonical tool tier. */
  hasTools: boolean;
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
    const stripped = raw.replace(/(^|\s+)#.*$/, "").replace(/\s+$/, "");
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

/**
 * Parse the canonical roster. Returns the shared `instructions` block and the
 * full advisor list. Tolerant of exact indentation: item keys are found by
 * scanning between an item's `- ` line and the next line at the same indent.
 */
export function parseRosterYaml(text: string): { sharedInstructions: string; advisors: AdvisorSpec[] } {
  const lines = stripYamlComments(text).split("\n");
  const advisors: AdvisorSpec[] = [];
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
      if (/^instructions:\s*\|?[>-]?$/.test(trimmed)) {
        const parts: string[] = [];
        let k = i + 1;
        while (k < lines.length && (lines[k].trim() === "" || indentOf(lines[k]) > 0)) {
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
          const item: AdvisorSpec = { name: "", enabled: true, model: "", hasTools: false, instructions: "" };
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
              if (l.trim() === "" || indentOf(l) > instrIndent) {
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
              else if (key === "tools") item.hasTools = true;
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
 * model pin byte-identical, unique names, a tools tier on each, and non-empty
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
    if (!a.hasTools) issues.push({ advisor: a.name, message: "tools tier missing" });
    if (!a.instructions.trim()) issues.push({ advisor: a.name, message: "instructions missing" });
  }
  return issues;
}
