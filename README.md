# visualizar

See what your coding agent is doing, live, in a small local browser tab.

visualizar reads Claude Code's own session transcript, so there's no wrapper and
no setup inside Claude Code. It shows the step Claude is on right now, big and in
the middle, and the steps around it, at the level of detail you pick:

| Level | Example |
| --- | --- |
| **Simple** | Building the top card |
| **Vibe** | Changed `src/components/TopCard.tsx` — swapped 3 lines for 5 |
| **Engineer** | `Edit src/components/TopCard.tsx` with the diff, or `$ npm test` with its output |

Fixes you send with [inject](https://github.com/sk82santhosh-cpu/Inject) show up
exactly where they landed, and a **Mistakes** panel keeps a list of them per project.

## Quickstart

1. Install it (Node 18+, macOS, Linux, or WSL2). Run this from a clone of this
   repo; the package isn't on npm yet:

   ```bash
   npm install -g .
   ```

2. In the folder where you run Claude Code, start it:

   ```bash
   visualizar
   ```

3. A browser tab opens on `http://127.0.0.1:4777`. Keep it beside your terminal.
   It follows the newest Claude Code session in that folder and switches to a
   new one when you start it.

## Views

Switch at any time from the top bar. Your choices are remembered.

- **Cards**: one card per step. The current step is big and centred; the steps
  before and after sit beside it. A strip of coloured marks along the bottom is
  the whole session, with your fixes as red flags. Use ← / → to step through,
  Enter to open details, and **Jump to now** to follow live again.
- **Flow**: a flowchart of every step, grouped by the prompts you sent. Your
  fixes branch in, in red, at the point they reached Claude.
- **Timeline**: lanes for You, Claude, Tools, Helpers (subagents) and Fixes on a
  time axis. Bars show how long each tool call took; long pauses are squeezed.
  Every fix is a dashed red line across all lanes.

The **NOW** strip at the top always says what's happening: the tool running and
for how long, "Thinking…", or "Done — waiting for you".

Themes: **Claude** (warm) and **Codex** (cool). Both use the same HUD look.

## Where the data comes from

- **Claude Code transcripts**: `~/.claude/projects/<project>/<session-id>.jsonl`,
  where `<project>` is the working directory with every non-alphanumeric character
  replaced by `-` ([docs](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)).
  `CLAUDE_CONFIG_DIR` is respected. The file is read incrementally, a few times a
  second, so updates appear within about a third of a second.
- **inject's fixes**: `<project>/.steer/fixes.jsonl`. Each fix is placed at the
  time it was delivered (or queued, if it never was), and a tool call that an
  urgent fix blocked is marked *stopped by your fix*.

**Read-only.** visualizar never writes to transcripts or to `fixes.jsonl`. The only
thing it writes is your edits from the Mistakes panel, to
`<project>/.steer/mistakes.json`, keyed by the original fix. Reword a fix, add a
note about what went wrong, or hide it; the original line stays in `fixes.jsonl`.

## Optional: AI descriptions for unusual steps

The translation is rule-based. It knows Claude Code's built-in tools (Read, Write,
Edit, Bash, Grep, Glob, WebFetch, WebSearch, Task/Agent, TodoWrite, and more) and
classifies common shell commands (tests, installs, builds, git). Anything else, such
as an MCP tool, gets a generic description like "Using linear: create issue".

To describe those with a cheap model instead:

```bash
visualizar --ai
```

This uses `claude-haiku-5-5` with your own Anthropic credentials (`ANTHROPIC_API_KEY`
or `ant auth login`). Only the tool's name and a clipped copy of its input are
sent, never its output or your files. Results are cached for the run. Without
`--ai`, or without credentials, nothing is sent anywhere and the generic text stays.

## Options

```
visualizar [--session <id>] [--port <n>] [--no-open] [--ai]
```

| Option | |
| --- | --- |
| `--session <id>` | Follow one session (an id prefix is enough) instead of the newest in this folder. You can also pick any recent session from the menu in the page. |
| `--port <n>` | Port to use (default 4777; the next free one is taken if busy). |
| `--no-open` | Don't open a browser tab; just print the URL. |
| `--ai` | AI descriptions for unusual steps (above). |

## Inside Claude Code

The same idea as a Claude Code mod: a sci-fi HUD pane drawn inside Claude Code itself, in the terminal, the Desktop app and VS Code. It lives in [`mod/`](mod) and needs no server or browser tab.

```bash
claude --plugin-dir ./mod
```

Then type `/visualizar` (it also works mid-turn). The pane is a sidebar beside the transcript in a wide window, or a framed region above the prompt otherwise.

The pane is built from Claude Code's own interface elements, so it fills the pane, updates in place, and looks native in the Desktop app, VS Code and the terminal. It shows a **NOW** panel with the current step in large type and a running clock, the current step as a big bordered card with the steps before and after it beside it (stacked when the pane is narrow), and a coloured track of the whole session. At Engineer level the card shows the actual diff or command. ◀ / ▶ step back through the session; **Back to live** follows Claude again.

It also shows your prompts as cards and this session's fixes from `<project>/.steer/fixes.jsonl` where they landed. Layouts match the browser tool: **Cards** (the default), **Flow** and **Timeline** (the current turn on lanes). Keys while the pane has focus: `1` Cards, `2` Flow, `3` Timeline, `s` Simple, `v` Vibe, `e` Engineer, `c` Claude theme, `x` Codex theme, `b` / `n` step back and forward, `l` back to live, Esc returns to the prompt. (VS Code buttons have no hotkeys; click them.) Run `/visualizar` again to close.

It is fed by Claude Code's mod events (`turn.start`, `tool.call`), not by parsing the transcript, and it is read-only: it never writes to transcripts or `fixes.jsonl`. The phrases come from `src/translate.js`; the mod runs in a sandbox with no Node, so `mod/hooks/translate.js` is generated from it. After changing `src/translate.js`, run `node mod/build.mjs` (`--check` verifies it is current).

Install it from this repository instead of a local folder (terminal):

```
/plugin install visualizar --marketplace sk82santhosh-cpu/Visualizar
```

From a shell: `claude plugin install visualizar --marketplace sk82santhosh-cpu/Visualizar`. In the Desktop app, click + next to the prompt box, then Plugins, Add marketplace with `sk82santhosh-cpu/Visualizar`, then Add plugin. In VS Code, the terminal command works from Claude Code's prompt.

Check it with `claude plugin validate ./mod` and `claude plugin test ./mod`. Claude Code asks you to trust the folder before it loads a mod's hooks.

## Things to know

- **The transcript format is internal to Claude Code** and, per its docs, "changes
  between versions". visualizar reads it defensively and skips anything it doesn't
  recognise, but a Claude Code update can still change what it can show. Tested
  with Claude Code 2.1.299.
- **Local only.** The server listens on 127.0.0.1, answers only requests addressed
  to `127.0.0.1` or `localhost` (against DNS rebinding), and requires a per-run
  token for the one write endpoint.
- **Subagents** appear as a single "Sending a helper to …" step. Their inner steps
  are only shown when they're in the main transcript (the Helpers lane); subagent
  transcripts stored in separate files aren't read yet.
- **Codex**: the Codex theme is a colour scheme only. Reading Codex sessions isn't
  supported yet.

## Development

```bash
npm install
npm test
```

No build step and no runtime dependencies. `@anthropic-ai/sdk` is optional and
only loaded with `--ai`.

## License

MIT
