# pi-adviser

A lean second-opinion reviewer for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

The main agent gets tunnel vision. Adviser watches what the agent reads and runs, then asks it sharp questions and checks. One small model call per tool-bearing turn. It never re-reads the conversation: each pass gets only its own rolling digest plus the new tool output.

## Install

```bash
pi install git:github.com/kartikkabadi/pi-adviser@v0.1.1
```

Then restart pi or run `/reload`. To try it without installing: `pi -e git:github.com/kartikkabadi/pi-adviser`.

## Usage

On by default. The switch:

```
/adviser on
/adviser off
/adviser      # toggles, then shows whether it is on or off
```

The state is saved to the agent config (`~/.pi/agent/adviser.json`) and restored when a new session starts: turn it off and every new session stays off until you turn it back on. A widget above the editor shows adviser state: reviewing, nothing to flag, or flagged with the note.

## Config

Environment variables:

```
PI_ADVISER_MODEL="provider/id"
PI_ADVISER_CONFIG="/path/to/adviser.json"
```

`PI_ADVISER_MODEL` picks a different model (default: the main agent's current model). `PI_ADVISER_CONFIG` overrides the state file path (default: `~/.pi/agent/adviser.json`). Debug: `PI_ADVISER_DEBUG=1` logs pass outcomes to stderr.

## How it works

- `turn_end`: one pass per turn, only when the turn produced tool results.
- Pass input: the adviser's own digest (max 700 chars) plus this turn's tool output (2000 chars per result, 9000 total).
- The adviser model replies with one JSON object: `{"concerns": "...", "digest": "..."}`. Empty concerns means silence.
- `context`: non-empty concerns are injected once into the next LLM call as a `[adviser]` user message. The main agent answers them.
- Stale protection: pending concerns are dropped as soon as a newer user message arrives, so the adviser never re-raises questions about superseded work.
- The adviser never blocks, never interrupts, never delays exit, and has no tools.

## License

MIT

## Test

```bash
bun test.ts
```

Run from the repo root. Requires bun; CI runs this exact command.

## Packaging notes

`package-lock.json` is intentionally not committed. Pi installs this package with `npm install --omit=dev` and regenerates the lock at install time. The runtime dependencies are the pi-bundled core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`), supplied by pi's extension loader, so a committed lock would describe copies that pi overrides at runtime. Install reproducibility is pinned by the git tag: `pi install git:github.com/kartikkabadi/pi-adviser@v0.1.1`.
