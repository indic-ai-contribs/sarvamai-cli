#!/usr/bin/env node
// sarvamai-cli entrypoint — parses CLI flags, loads config, builds the right
// provider, and launches either single-prompt or interactive REPL mode.
//
// Usage:
//   sarvam                              # interactive REPL
//   sarvam "fix the typo in README"     # single prompt, then exit
//   sarvam --provider openai "..."      # force a provider for this run
//   sarvam --init                       # create ~/.sarvam/config.json
//   sarvam --approve auto "..."         # auto-approve all tool calls
//   sarvam --model sarvam-105b "..."

import { loadConfig, initConfigInteractive, Config, ApproveMode } from "../src/config.js";
import { SarvamProvider } from "../src/providers/sarvam.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { startRepl, runSinglePrompt } from "../src/ui/repl.js";

interface ParsedArgs {
  prompt?: string;
  provider?: "sarvam" | "openai";
  model?: string;
  baseUrl?: string;
  init?: boolean;
  approve?: ApproveMode;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--provider":
      case "-p":
        args.provider = argv[++i] as "sarvam" | "openai";
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "--init":
        args.init = true;
        break;
      case "--approve": {
        const mode = argv[++i];
        // Validate rather than cast: a typo used to fall through as an unknown
        // value and silently pick a behaviour the user did not ask for — and
        // this flag decides whether side effects run unprompted.
        if (!["auto", "prompt", "always", "never"].includes(mode)) {
          console.error(`Invalid --approve value: ${mode ?? "(missing)"}. Expected: auto | prompt`);
          process.exit(1);
        }
        args.approve = mode as ApproveMode;
        break;
      }
      case "--temperature":
      case "-t":
        args.temperature = Number(argv[++i]);
        break;
      case "--reasoning-effort":
        args.reasoningEffort = argv[++i] as "low" | "medium" | "high";
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(1);
        }
        rest.push(a);
    }
  }

  if (rest.length) args.prompt = rest.join(" ");
  return args;
}

const HELP = `sarvamai-cli — agentic coding assistant powered by Sarvam AI

USAGE
  sarvam                          Start interactive REPL
  sarvam "your prompt here"       Run a single prompt, then exit
  sarvam --init                   Create ~/.sarvam/config.json interactively

FLAGS
  -p, --provider <name>           sarvam | openai  (default: from config or env)
  -m, --model <name>              Model name (sarvam-105b, gpt-4o, ...)
      --base-url <url>            Override API base URL (OpenAI provider only)
      --approve <mode>            auto | prompt  (default: prompt each time)
                                  auto runs side effects without asking
                                  ("never"/"always" still accepted: never=auto,
                                   always=prompt)
  -t, --temperature <n>           Sampling temperature (0–2)
      --reasoning-effort <lvl>    low | medium | high  (Sarvam only, streams thinking tokens)
  -h, --help                      Show this help

CONFIG
  Keys are read from ~/.sarvam/config.json, then env vars:
    SARVAM_API_KEY                Sarvam API key (sk_...)
    OPENAI_API_KEY                OpenAI-compatible API key

  Get a Sarvam key: https://dashboard.sarvam.ai

EXAMPLES
  sarvam "add a .gitignore for a Python project"
  sarvam --provider openai --model gpt-4o "refactor utils.ts"
  sarvam --approve auto "run the tests and report failures"

NOTE
  A single prompt (sarvam "...") runs unattended: side effects are approved
  automatically and reported as they happen. File tools are confined to the
  current directory in every mode.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.init) {
    const created = await initConfigInteractive();
    // Non-zero when init aborted without writing, so scripted callers can tell.
    process.exit(created ? 0 : 1);
  }

  const cfg = await loadConfig({
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.approve ? { approve: args.approve } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
  });

  const provider = buildProvider(cfg, args.model, args.baseUrl);

  if (!provider) {
    console.error("No API key found. Run `sarvam --init` or set SARVAM_API_KEY / OPENAI_API_KEY.");
    process.exit(1);
  }

  const cwd = process.cwd();

  if (args.prompt) {
    await runSinglePrompt(args.prompt, {
      provider,
      cwd,
      temperature: cfg.temperature,
      reasoning_effort: cfg.reasoning_effort,
      approveMode: cfg.approve,
    });
  } else {
    await startRepl({
      provider,
      cwd,
      temperature: cfg.temperature,
      reasoning_effort: cfg.reasoning_effort,
      approveMode: cfg.approve,
    });
  }
}

function buildProvider(cfg: Config, modelOverride?: string, baseUrlOverride?: string) {
  if (cfg.provider === "sarvam") {
    if (!cfg.sarvam.apiKey) return null;
    // The sarvamai SDK handles the base URL internally — no baseUrl override
    // is passed here. Only model + apiKey are used.
    return new SarvamProvider({
      apiKey: cfg.sarvam.apiKey,
      model: modelOverride ?? cfg.sarvam.model,
    });
  } else {
    if (!cfg.openai.apiKey) return null;
    return new OpenAIProvider({
      apiKey: cfg.openai.apiKey,
      model: modelOverride ?? cfg.openai.model,
      baseUrl: baseUrlOverride ?? cfg.openai.baseUrl,
    });
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
