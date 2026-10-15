import assert from "node:assert/strict";
import { parseRosterYaml } from "./roster.ts";

const parsed = parseRosterYaml(`instructions: |
  First paragraph.

  Second paragraph.
advisors:
  - name: First
    instructions: |
      Check correctness.

      Check errors too.

  - name: Second
    instructions: Check tests.
`);
assert.equal(parsed.sharedInstructions, "First paragraph.\n\nSecond paragraph.");
assert.deepEqual(parsed.advisors.map(a => a.name), ["First", "Second"]);
assert.equal(parsed.advisors[0].instructions, "Check correctness.\n\nCheck errors too.");
console.log("PASS blank lines preserve shared instructions and the full roster");
