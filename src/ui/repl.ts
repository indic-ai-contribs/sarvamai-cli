// Interactive REPL UI — clean foreground (tool calls + output only),
// reasoning collected silently in background, toggle with Ctrl+O.
// /model switches models mid-session; `! <cmd>` is a direct shell escape.

import * as readline from "node:readline";
import { Message, Provider } from "../types.js";
import { runAgent, buildSystemPrompt } from "../agent/loop.js";
import { executeTool } from "../tools/index.js";
import { ApproveMode, isAutoApprove } from "../config.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

export interface ReplOpts {
  provider: Provider;
  cwd: string;
  temperature?: number;
  reasoning_effort?: "low" | "medium" | "high";
  approveMode?: ApproveMode;
}

export async function startRepl(opts: ReplOpts): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // readline never fires the question callback if the interface closes first
  // (Ctrl+D, Ctrl+C, piped stdin hitting EOF). Left unhandled, the awaited
  // promise hangs forever, the event loop drains, and node exits silently with
  // status 0 mid-prompt. Resolve to null on close so every caller can unwind.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const ask = (q: string): Promise<string | null> =>
    new Promise((resolve) => {
      if (closed) return resolve(null);
      let answered = false;
      const onClose = () => {
        if (!answered) {
          answered = true;
          resolve(null);
        }
      };
      rl.once("close", onClose);
      rl.question(q, (a) => {
        answered = true;
        rl.removeListener("close", onClose);
        resolve(a);
      });
    });

  // Ctrl+C: readline closes the interface by default, which the null path below
  // turns into a clean exit. Flag it so we can report 130 rather than 0.
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });

  let history: Message[] = [{ role: "system", content: buildSystemPrompt(opts.cwd) }];

  // Background reasoning buffer
  let reasoningLog = "";
  let showReasoning = false;

  const printStatus = () => {
    const model = opts.provider.getModel();
    const reasoningStatus = showReasoning ? `${MAGENTA}on${RESET}` : `${DIM}off${RESET}`;
    console.log(`${DIM}sarvamai-cli · ${opts.provider.name} · ${model} · ${opts.cwd}${RESET}`);
    console.log(`${DIM}exit to quit · clear to reset · Ctrl+O reasoning · /model to switch${RESET}`);
    console.log(`${DIM}reasoning: ${reasoningStatus}\n`);
  };

  printStatus();

  // Ctrl+O handler — toggle reasoning display
  // Ctrl+O sends \x0f (character code 15)
  process.stdin.on("data", (data) => {
    for (const byte of data) {
      if (byte === 0x0f) {
        showReasoning = !showReasoning;
        const label = showReasoning
          ? `${MAGENTA}reasoning ON${RESET}`
          : `${DIM}reasoning OFF${RESET}`;
        // \x1b[2K clears the partially-typed line before the notice lands on it.
        process.stdout.write(`\r\x1b[2K${label}\n`);
        // Redraw via readline rather than hand-writing the prompt: prompt(true)
        // re-renders the current line buffer too, so text typed before the
        // toggle stays visible instead of silently surviving off-screen.
        rl.prompt(true);
      }
    }
  });

  const approve = async (tool: string, summary: string, _detail: string): Promise<boolean> => {
    // Only "never"/"auto" skip the prompt. "always" previously landed here too,
    // which meant a user asking for the most cautious setting silently got no
    // prompts at all — the worst possible direction for the flag to fail in.
    if (isAutoApprove(opts.approveMode)) return true;
    const label = summary.length > 60 ? summary.slice(0, 57) + "…" : summary;
    const ans = await ask(`${YELLOW}▸ ${tool}: ${label} ${DIM}[y/N]${RESET} `);
    if (ans === null) return false; // stdin closed mid-prompt — decline, never assume consent
    const norm = ans.toLowerCase().trim();
    return norm === "y" || norm === "yes";
  };

  while (true) {
    const input = await ask(`${CYAN}❯ ${RESET}`);
    if (input === null) break; // EOF / interrupt — fall through to the clean exit
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "exit" || trimmed === "quit") break;

    // `! <cmd>` — direct shell escape. Runs without a model round trip and
    // without an approval prompt: the user typed the command themselves, so
    // consent is already explicit. Model-initiated run_shell keeps its gate.
    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (!command) {
        console.log(`${DIM}usage: ! <command>${RESET}\n`);
        continue;
      }
      const result = await executeTool(
        "run_shell",
        { command },
        { cwd: opts.cwd, approve: async () => true }
      );
      if (result.trim()) console.log(result.trimEnd());
      console.log("");
      continue;
    }

    // /model — switch model mid-session
    if (trimmed === "/model" || trimmed === "model") {
      const available = opts.provider.listModels();
      console.log(`${DIM}Current model: ${opts.provider.getModel()}${RESET}`);

      // A prompt offering exactly one choice is a dead end — say so and bail.
      if (available.length === 1) {
        console.log(`${DIM}${available[0]} is the only model available — nothing to switch to.${RESET}\n`);
        continue;
      }
      if (available.length > 1) {
        console.log(`${DIM}Available: ${available.join(", ")}${RESET}`);
      }

      const answer = await ask(`${CYAN}model> ${RESET}`);
      if (answer === null) break;
      const choice = answer.trim();
      if (!choice) {
        console.log(`${DIM}no change${RESET}\n`);
        continue;
      }
      // Empty list means the provider is unconstrained (any OpenAI-compatible
      // endpoint), so only validate when we actually know the valid ids.
      if (available.length > 0 && !available.includes(choice)) {
        console.log(`${RED}unknown model: ${choice}${RESET} ${DIM}(expected one of: ${available.join(", ")})${RESET}\n`);
        continue;
      }
      opts.provider.setModel(choice);
      console.log(`${GREEN}✓ switched to ${opts.provider.getModel()}${RESET}\n`);
      continue;
    }

    // /show — dump full reasoning log
    if (trimmed === "/show" || trimmed === "show reasoning") {
      if (reasoningLog.trim()) {
        console.log(`\n${MAGENTA}── Reasoning Log ──${RESET}`);
        console.log(`${DIM}${reasoningLog}${RESET}`);
        console.log(`${MAGENTA}── End ──${RESET}\n`);
      } else {
        console.log(`${DIM}No reasoning collected.${RESET}\n`);
      }
      continue;
    }

    if (trimmed === "/clear" || trimmed === "clear") {
      history = [{ role: "system", content: buildSystemPrompt(opts.cwd) }];
      reasoningLog = "";
      console.log(`${DIM}cleared${RESET}\n`);
      continue;
    }

    // Models restate tool output as their answer, so `pwd` printed its result
    // twice. The system prompt already forbids this and is ignored, so the UI
    // owns it instead: withhold assistant text while it still looks like an
    // echo of what we just printed, and release it the moment it diverges.
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    let lastPrinted = ""; // squashed copy of the tool output shown to the user
    let echoBuf = "";     // withheld text, still a candidate echo
    let echoing = false;

    const flushEcho = () => {
      if (echoBuf) process.stdout.write(RESET + echoBuf);
      echoBuf = "";
      echoing = false;
    };

    try {
      history = await runAgent(history, trimmed, {
        provider: opts.provider,
        cwd: opts.cwd,
        approve,
        temperature: opts.temperature,
        reasoning_effort: opts.reasoning_effort,
        onText: (chunk) => {
          if (!echoing) {
            process.stdout.write(RESET + chunk);
            return;
          }
          echoBuf += chunk;
          const seen = squash(echoBuf);
          if (!seen) return;                       // whitespace so far — undecided
          if (lastPrinted.startsWith(seen)) return; // still tracking the echo
          flushEcho();                             // diverged: real content, print it
        },
        onReasoning: (chunk) => {
          reasoningLog += chunk;
          if (showReasoning) {
            process.stdout.write(`\x1b[2;3m${chunk}\x1b[0m`);
          }
        },
        onNotice: (message) => {
          process.stdout.write(`\n${YELLOW}${message}${RESET}\n`);
        },
        onToolCall: (name, args) => {
          const argPreview = JSON.stringify(args).slice(0, 80);
          process.stdout.write(`\n${DIM}▸ ${name}${argPreview !== "{}" ? ` ${argPreview}` : ""}${RESET}`);
        },
        onToolResult: (name, result) => {
          const lines = result.split("\n").filter((l) => !l.startsWith("[exit:"));
          const preview = lines.slice(0, 5).join("\n");
          if (preview.trim()) {
            process.stdout.write(`\n${DIM}${preview}${result.length > 300 ? "…" : ""}${RESET}`);
            // Match against the preview, not the full result: we must never
            // suppress text the user hasn't already been shown.
            lastPrinted = squash(preview);
            echoBuf = "";
            echoing = true;
          }
        },
      });
      // Anything still withheld stayed a prefix of the tool output to the end,
      // so it was an echo. Drop it.
      echoBuf = "";
      echoing = false;
      process.stdout.write(`\n\n${RESET}`);
    } catch (err) {
      flushEcho(); // don't swallow partial output when a turn blows up
      console.error(`\n${RED}Error: ${(err as Error).message}${RESET}\n`);
    }
  }

  rl.close();
  console.log(`${interrupted ? "\n" : ""}${DIM}bye${RESET}`);
  if (interrupted) process.exitCode = 130; // conventional 128+SIGINT
}

export async function runSinglePrompt(
  prompt: string,
  opts: ReplOpts
): Promise<void> {
  const history: Message[] = [{ role: "system", content: buildSystemPrompt(opts.cwd) }];

  // Single-prompt mode is unattended by design: there is no interactive turn to
  // prompt on, so every side effect is approved automatically and reported
  // after the fact. File paths are checked, but shell commands are not sandboxed.
  let announcedUnattended = false;
  const approve = async (tool: string, summary: string, _detail: string): Promise<boolean> => {
    if (!announcedUnattended) {
      announcedUnattended = true;
      console.log(
        `${DIM}unattended mode — side effects run without asking; file paths checked against ${opts.cwd}; shell commands are not sandboxed${RESET}`
      );
    }
    const label = summary.length > 60 ? summary.slice(0, 57) + "…" : summary;
    console.log(`${YELLOW}▸ ${tool}: ${label}${RESET}`);
    return true;
  };

  try {
    await runAgent(history, prompt, {
      provider: opts.provider,
      cwd: opts.cwd,
      approve,
      temperature: opts.temperature,
      reasoning_effort: opts.reasoning_effort,
      onText: (chunk) => process.stdout.write(chunk),
      onToolCall: (name, args) => {
        const argPreview = JSON.stringify(args).slice(0, 80);
        process.stdout.write(`\n${DIM}▸ ${name}${argPreview !== "{}" ? ` ${argPreview}` : ""}${RESET}`);
      },
      onToolResult: (_name, result) => {
        const lines = result.split("\n").filter((l) => !l.startsWith("[exit:"));
        const preview = lines.slice(0, 5).join("\n");
        if (preview.trim()) {
          console.log(`${DIM}${preview}${RESET}`);
        }
      },
      onNotice: (message) => console.error(`${YELLOW}${message}${RESET}`),
    });
    console.log("");
  } catch (err) {
    console.error(`\n${RED}Error: ${(err as Error).message}${RESET}`);
    process.exitCode = 1;
  }
}
