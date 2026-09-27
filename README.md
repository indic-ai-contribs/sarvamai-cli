# sarvamai-cli

[![npm version](https://img.shields.io/npm/v/sarvamai-cli.svg)](https://www.npmjs.com/package/sarvamai-cli)

An open-source agentic CLI coding assistant powered by **Sarvam AI**, built on the official [`sarvamai`](https://www.npmjs.com/package/sarvamai) SDK, with an OpenAI-compatible fallback provider. It reads, writes, and edits files and runs shell commands in your project. File tools check paths against the current directory; shell commands are not sandboxed. In the REPL, side effects require approval by default. See [Safety model](#safety-model) for the controls in each mode.

> **Status: early.** It works and it's published, but it has few users and needs testers more than it needs features. If you try it, [open an issue](https://github.com/indic-ai-contribs/sarvamai-cli/issues) — even "this was confusing" is useful.

Think of it as a lightweight, hackable terminal agent that talks to Sarvam's Indic-first LLMs (`sarvam-105b`) via the official SDK, and degrades gracefully to any OpenAI-compatible endpoint as a fallback. MIT-licensed, designed to complement Sarvam's SDK + skills ecosystem and be adoptable upstream.

![sarvamai-cli in a terminal: a `!` shell escape, an agent turn that runs a script through the approval gate, the Ctrl+O reasoning toggle, and `/model`](docs/demo.gif)

<sub>Recorded from the real binary with [`scripts/record-demo.py`](scripts/record-demo.py) — no external recorder needed.</sub>

## Why

Sarvam ships an excellent SDK (`sarvamai` on npm/PyPI) and Agent Skills for hosted editors (Claude Code, Cursor, Windsurf). But there's no standalone terminal agent for developers who live in the CLI. `sarvamai-cli` fills that gap — it consumes the official SDK for auth, retries, streaming, and SDK quirks, then layers an agentic tool loop on top.

**Relationship to Sarvam's stack:**

| Layer | What | Example |
|-------|------|---------|
| API client / SDK | `sarvamai` (official) | `npm install sarvamai` |
| Framework provider | Vercel AI SDK provider | `sarvam-ai-sdk` |
| Skills for hosted editors | `sarvamai/skills` (official) | Claude Code, Cursor |
| **Standalone terminal agent** | **sarvamai-cli (this project)** | — |

## Changelog

### v0.3.0
- **Security: file tools are now confined to the working directory.** `read_file`,
  `write_file`, and `patch` refuse paths resolving outside, including absolute paths,
  `../` traversal, and symlink escapes. Dangling and unresolved symlinks are refused,
  and write paths are checked again after approval. Previously the boundary existed only as an instruction in the system
  prompt, which a model could simply ignore — and `read_file` has no approval prompt, so
  nothing else stood in the way of reading `~/.ssh/id_rsa` or `~/.sarvam/config.json`.
  `~` is now refused rather than silently resolved to a literal `./~/` directory.
- **Security: `--approve always` no longer auto-approves.** It meant "always ask", but the
  REPL treated it the same as `never` and skipped every prompt — the most cautious-sounding
  setting produced the least caution. Clearer `auto` / `prompt` spellings are now preferred;
  `never` (= `auto`) and `always` (= `prompt`) still work. An invalid value is now rejected
  instead of silently falling through.
- **Security: the API key file is written `0600` inside a `0700` directory**, and an existing
  world-readable config is tightened on load.
- Fixed: `patch` corrupted replacements containing `$&`, `` $` ``, `$'` or `$1` — a string
  replacement is `$`-interpreted by `String.replace` even when the pattern is a plain string.
  Replacing `price` with `$& $&` wrote `price price`.
- Fixed: repeating a tool call on a later turn was skipped as a duplicate, so "run the tests,
  fix the failure, run them again" fed the model the pre-fix result. Duplicate detection is now
  per turn.
- Added: `run_shell` kills a command after 120s (whole process group) instead of hanging the
  agent forever on `npm start` or `tail -f`.
- Added: hitting the turn cap now says so instead of returning as though the task finished.
- Added: a test suite (`npm test`, 40 tests, no new dependencies) and CI on Node 20/22,
  including a pack-and-install smoke test of the published binary.
- Docs: the README claimed approval before *any* side effect. Single-prompt mode has always
  run unattended; that is now documented rather than implied away, and it announces itself.

### v0.2.11
- Renamed package from `sarvam-cli` to `sarvamai-cli` (the former was taken on npm) — the
  `sarvam` binary name is unchanged. First release published to the npm registry.

### v0.2.10
- Fixed: `sarvam --init` exited 0 without writing anything when stdin ended early
  (piped input, Ctrl+D) — the same unguarded readline pattern fixed in the REPL in v0.2.9.
  It now aborts with a clear message and a non-zero status rather than reporting success.
  A partial config is never written: an empty `apiKey` silently shadows the env vars.
- Added: demo GIF and an architecture diagram in the README, both reproducible from
  `scripts/`

### v0.2.9
- Fixed: Ctrl+D / Ctrl+C at any prompt exited silently with status 0 mid-line — readline's
  close event never resolved the pending question. Now exits cleanly (130 on interrupt).
- Fixed: tool output printed twice when the model restated it as its answer
- Fixed: `/model` accepted any string, so a typo failed later as an opaque API error
- Fixed: Ctrl+O redraw dropped already-typed text from the display while keeping it in the buffer
- Added: `! <cmd>` shell escape — runs directly, no model round trip
- `/model` reports when only one model is available instead of prompting for a choice of one

### v0.2.8
- Ctrl+O toggles reasoning display on/off (replaces /reasoning command)
- /model command switches models mid-session without restarting
- Provider interface gains getModel() and setModel() methods
- SARVAM_MODELS exported for model listing
- Welcome message shows current model + available shortcuts

### v0.2.7
- Reasoning tokens collected silently in background buffer (never shown by default)
- /reasoning command toggles inline reasoning display on/off
- /show command dumps the full reasoning log from the session
- Reasoning is passed per-turn to the UI callback (not streamed live)
- Welcome message updated to show available commands

### v0.2.6
- Buffer reasoning_content tokens (same as text) — discard when tool calls present
- Detect and skip duplicate tool calls (model was calling pwd twice)
- Add "do not repeat tool calls" rule to system prompt

### v0.2.5
- Add tool aliases: bash/shell/exec/cmd → run_shell, cat/read → read_file, etc. (model was calling "bash" and getting "Unknown tool")
- List exact tool names in system prompt: "Do NOT invent tool names like bash, cat, exec"
- Compact REPL output: single-line approval, drop "Exit: 0" noise, no redundant confirmation lines
- Strip exit-code lines from tool result display in REPL
- Tell model not to repeat tool output in its response

### v0.2.4
- Buffer streamed text and discard chain-of-thought when tool calls are present (only show final answer)
- Detect premature stops after partial work ("No response requested", "done", etc.) and nudge model to continue
- Add task completion rules to system prompt: complete ALL steps, don't stop after one tool call

### v0.2.3
- Fix `read_file` crashing on directories (EISDIR) — now detects directories and returns a helpful listing
- Constrain model to working directory via dynamic `{CWD}` injection in system prompt
- Auto-recover from empty responses with nudge mechanism

### v0.2.2
- Suppress chain-of-thought leakage via system prompt rules
- Accept `exit`, `quit`, `clear` without leading slash in REPL

### v0.2.1
- Fix deprecated `sarvam-m` model default → `sarvam-105b` (API returns 400 for sarvam-m)
- Fix env var fallback bug: `??` → `||` for API key resolution so empty strings from partial config files don't block env vars

### v0.2.0
- Now backed by the official `sarvamai` SDK — no more hand-rolled fetch
- Reasoning token streaming — `reasoning_content` deltas surfaced live in the REPL
- Cleaner provider separation: Sarvam provider is SDK-backed, OpenAI provider is raw-fetch

## Install

```bash
npm install -g sarvamai-cli   # makes `sarvam` available on your PATH
```

Or build from source:

```bash
git clone https://github.com/indic-ai-contribs/sarvamai-cli.git
cd sarvamai-cli
npm install        # installs sarvamai + typescript
npm run build
npm link           # makes `sarvam` available on your PATH
```

Then get a Sarvam API key from <https://dashboard.sarvam.ai> and run:

```bash
sarvam --init
```

This writes `~/.sarvam/config.json`:

```json
{
  "provider": "sarvam",
  "sarvam": { "apiKey": "sk_...", "model": "sarvam-105b" },
  "openai": { "apiKey": "", "model": "gpt-4o" }
}
```

Alternatively, set environment variables:

```bash
export SARVAM_API_KEY="sk_..."
# or, for the OpenAI-compatible fallback
export OPENAI_API_KEY="sk-..."
```

## Usage

Interactive REPL:

```bash
sarvam
```

Inside the REPL, `!` runs a shell command directly — no model round trip, no approval prompt,
since you typed the command yourself:

```
❯ ! git status
❯ ! npm test
```

Commands the *model* chooses to run still go through the usual approval gate.

Single prompt (non-interactive):

```bash
sarvam "add a .gitignore for a Python project"
sarvam "find and fix the off-by-one in src/parser.ts"
```

Force a provider / model:

```bash
sarvam --provider openai --model gpt-4o "refactor utils.ts"
sarvam -p sarvam -m sarvam-105b "write a test for the auth flow"
```

Auto-approve all tool calls (use with care):

```bash
sarvam --approve auto "run the tests and report failures"
```

Sarvam-native reasoning effort (streams thinking tokens in the REPL):

```bash
sarvam --reasoning-effort high "design a rate-limiter for this API"
```

All flags:

```
  -p, --provider <name>           sarvam | openai
  -m, --model <name>              Model name (sarvam-105b, gpt-4o, ...)
      --base-url <url>            Override the API base URL (OpenAI provider only)
      --approve <mode>            auto | prompt  (default: prompt each time)
  -t, --temperature <n>           Sampling temperature (0–2)
      --reasoning-effort <lvl>    low | medium | high  (Sarvam only)
      --init                      Create ~/.sarvam/config.json interactively
  -h, --help                      Show help
```

`--approve` also accepts the older `never` (= `auto`) and `always` (= `prompt`) spellings.

## Tools

| Tool | Approval | Description |
|------|----------|-------------|
| `read_file` | none | Read a file (with line numbers, offset/limit paging) |
| `write_file` | prompted in the REPL | Write/overwrite a file (creates parent dirs) |
| `patch` | prompted in the REPL | Targeted find-and-replace edit on a file |
| `run_shell` | prompted in the REPL | Run a shell command, return stdout+stderr (killed after 120s) |

The three file tools check paths against the working directory. `run_shell` starts there
but can access files elsewhere with your user permissions.

## Safety model

Two independent controls, and it's worth knowing which one is doing the work.

**1. File path checks — always on, every mode.** `read_file`, `write_file`, and `patch`
refuse any path that resolves outside the directory you started in. That covers absolute paths
(`/etc/passwd`), traversal (`../../.ssh/id_rsa`), and symlinks inside the project pointing out
of it. Dangling and unresolved symlinks are refused. `~` is refused rather than expanded.
Writes are checked again after approval. These checks are not an operating-system sandbox:
another process can still change paths between a check and filesystem access.

**Shell access is unrestricted.** `run_shell` starts in the project directory, but commands
can read or write elsewhere, access environment variables, and use the network with your
user permissions. The file path checks do not apply to commands or their child processes.

**2. Approval prompts — interactive REPL only.** In the REPL, `write_file`, `patch`, and
`run_shell` each ask before running, and a decline is fed back to the model as a tool result so
it adapts rather than stalls.

**A single prompt runs unattended.** `sarvam "do the thing"` has no interactive turn to prompt
on, so side effects are approved automatically and reported as they happen; it prints a line
saying so on the first one. File path checks still apply, but shell commands run without an
approval prompt and can access files outside the project. Content the model reads (a README,
a dependency's source) is untrusted input that can try to steer it.

`read_file` is never gated, so anything readable inside the project can reach the model.
Don't run it in a directory holding secrets you wouldn't paste into a chat window.

Your API key is written to `~/.sarvam/config.json` with mode `0600` inside a `0700` directory;
an older, looser config is tightened automatically on the next run.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
  <img alt="Agent loop: you prompt sarvamai-cli, which streams through the sarvamai SDK to sarvam-105b; tool calls pass through an approval gate before any of read_file, write_file, patch or run_shell executes, and the result feeds back into the loop. Declining returns the refusal to the model." src="docs/architecture-light.svg">
</picture>

In the REPL, writes, patches, and shell commands ask for approval by default, and a decline is fed back as a tool result so the agent can adapt. `--approve auto` and single-prompt runs skip the gate. In both modes the file tools check paths against the working directory; shell commands are not sandboxed. See [Safety model](#safety-model).

```
bin/sarvam.ts        CLI entrypoint — flag parsing, config loading, mode dispatch
src/
  config.ts          ~/.sarvam/config.json + env var resolution
  types.ts           Shared message/tool/provider types
  providers/
    sarvam.ts        Sarvam provider — backed by the official sarvamai SDK
    openai.ts        OpenAI-compatible provider — raw fetch + SSE, works with any /v1 endpoint
  tools/
    index.ts         Tool definitions + runtime with approval gating
  agent/
    loop.ts          Agent loop: stream → tool calls → results → repeat
  ui/
    repl.ts          Interactive REPL + single-prompt mode with streaming
  util/
    sse.ts           Minimal async SSE parser (used by the OpenAI provider)
```

**Runtime dependencies:** `sarvamai` (the official Sarvam SDK). The OpenAI provider uses Node 20's built-in `fetch` — no additional dependencies.

### Why two providers?

The **Sarvam provider** uses `SarvamAIClient` from the official `sarvamai` package. This gives us:
- Correct auth via `apiSubscriptionKey` (the SDK handles the header)
- Built-in retries and error handling (SDK throws typed `SarvamAIError` subclasses)
- Proper SSE stream parsing (SDK returns an `AsyncIterable<ChatCompletionChunk>`)
- Access to Sarvam-native extras: `reasoning_effort`, `reasoning_content`, `wiki_grounding`

The **OpenAI provider** is a thin raw-fetch client that works with any OpenAI-compatible endpoint (OpenAI, Groq, Together, Ollama, LM Studio). It exists as a fallback for users who don't have a Sarvam key yet or want to use a different model.

## Programmatic use

```typescript
import { SarvamProvider, runAgent } from "sarvamai-cli";

const provider = new SarvamProvider({ apiKey: process.env.SARVAM_API_KEY! });
const history = await runAgent([], "list files in the current directory", {
  provider,
  cwd: ".",
  approve: async () => true,
  onText: (chunk) => process.stdout.write(chunk),
  onReasoning: (chunk) => process.stderr.write(`[thinking] ${chunk}`),
});
```

## Config resolution order

1. CLI flags (`--provider`, `--model`, etc.)
2. Environment variables (`SARVAM_API_KEY`, `OPENAI_API_KEY`)
3. `~/.sarvam/config.json`

## Notes on the Sarvam SDK

- Package: `npm install sarvamai` (v1.1.7+)
- Client: `new SarvamAIClient({ apiSubscriptionKey: "sk_..." })`
- Chat: `client.chat.completions({ model, messages, stream: true, tools })`
- Streaming returns `AsyncIterable<ChatCompletionChunk>` — each chunk has `choices[0].delta`
- `delta.content` can be `null` when reasoning consumes the token budget — the provider guards for this
- `delta.reasoning_content` carries thinking tokens (Sarvam-native) — surfaced in the REPL
- Auth failures throw `ForbiddenError` (Sarvam returns 403, not 401)

## Contributing

PRs welcome. This is an open-source community project — see `AUTHORS` for contributors. The goal is a clean, ecosystem-aligned codebase that Sarvam (or anyone) can adopt or fork.

To add a new tool: add a handler in `src/tools/index.ts` (a `ToolDef` + `run` function), then register it in the `TOOLS` array. The agent loop picks it up automatically.

To add a new provider: implement the `Provider` interface in `src/types.ts`, then wire it in `bin/sarvam.ts`'s `buildProvider`.

## License

MIT — see [LICENSE](LICENSE).
