import assert from "node:assert/strict";
import { parseRosterYaml } from "./roster.ts";

const parsed = parseRosterYaml(`instructions: |
  Check C# code and # literal block text.
advisors:
  - name: C#Reviewer # a real comment
    model: provider/c#model
    instructions: Review C# types # trailing comment
`);
assert.equal(parsed.advisors[0].name, "C#Reviewer");
assert.equal(parsed.advisors[0].model, "provider/c#model");
assert.equal(parsed.advisors[0].instructions, "Review C# types");
assert.ok(parsed.sharedInstructions.includes("# literal block text"));
console.log("PASS literal hashes and real comments remain distinct");
