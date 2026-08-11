// Unit checks for adviser.ts pure helpers. Run: bun /tmp/adviser-check/test.ts
import {
  buildInjection,
  buildPassInput,
  parseAdviserOutput,
  toolResultText,
  truncate,
} from "./adviser.ts";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log("ok  -", name);
  } else {
    failed++;
    console.log("FAIL-", name, "\n  expected:", e, "\n  actual:  ", a);
  }
}

// truncate
check("truncate keeps short text", truncate("hello", 10), "hello");
check("truncate cuts long text", truncate("hello world", 5), "hello\n...[truncated]");

// toolResultText
check(
  "toolResultText extracts text parts only",
  toolResultText([
    { type: "text", text: "a" },
    { type: "image", text: "nope" },
    { type: "text", text: "b" },
  ]),
  "ab",
);
check("toolResultText empty", toolResultText([]), "");

// buildPassInput
const input = buildPassInput("flagged X, open", [
  { toolName: "read", text: "file content here" },
  { toolName: "bash", text: "ok".repeat(3000) }, // over per-result cap
]);
check("pass input has digest", input.includes("DIGEST:\nflagged X, open"), true);
check("pass input has tool block", input.includes("## read\nfile content here"), true);
check("pass input truncates per result", input.includes("...[truncated]"), true);
check(
  "pass input caps total size",
  input.length <= 9000 + 700 + 200,
  true,
);

// parseAdviserOutput
check(
  "parses clean json",
  parseAdviserOutput('{"concerns":"check X","digest":"Y open"}'),
  { concerns: "check X", digest: "Y open" },
);
check(
  "parses json inside fences",
  parseAdviserOutput('```json\n{"concerns":"c","digest":"d"}\n```'),
  { concerns: "c", digest: "d" },
);
check(
  "parses json with leading prose",
  parseAdviserOutput('Here you go:\n{"concerns":"c2","digest":"d2"}'),
  { concerns: "c2", digest: "d2" },
);
check(
  "empty concerns stays empty",
  parseAdviserOutput('{"concerns":"","digest":"d"}'),
  { concerns: "", digest: "d" },
);
check(
  "unparseable text becomes concerns",
  parseAdviserOutput("You forgot to verify the build."),
  { concerns: "You forgot to verify the build.", digest: "" },
);
const longConcerns = parseAdviserOutput('{"concerns":"' + "x".repeat(2000) + '","digest":"d"}');
check("concerns capped at 900 chars", longConcerns.concerns.length <= 900, true);

// buildInjection
const inj = buildInjection("check Y") as { role: string; content: { type: string; text: string }[] };
check("injection is user role", inj.role, "user");
check("injection prefixes adviser", inj.content[0].text, "[adviser] check Y");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

// Surrogate pair safety: truncating an emoji must not split the pair.
const emoji = "a".repeat(3) + "😀" + "b".repeat(20);
const cut = truncate(emoji, 6);
check("truncate does not split surrogate pairs", /[\uD800-\uDBFF]$/.test(cut), false);
check("truncate keeps valid emoji", cut.includes("😀"), true);
