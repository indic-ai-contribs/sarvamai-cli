// Agent loop — manages the conversation, streams model output, dispatches
// tool calls (with approval), and feeds results back until the model stops
// calling tools. Works for both single-prompt and interactive REPL modes.

import { Message, Provider, ToolCallParsed } from "../types.js";
import { TOOL_DEFS, executeTool, ToolCtx } from "../tools/index.js";

const SYSTEM_PROMPT = `You are sarvamai-cli, an agentic coding assistant running in the user's terminal.

You have exactly FOUR tools. Use them by their EXACT names:
  - read_file   — read a file (args: path)
  - write_file  — write/overwrite a file (args: path, content)
  - patch       — find-and-replace in a file (args: path, old_string, new_string)
  - run_shell   — run a shell command (args: command)

Do NOT invent tool names like "bash", "cat", "exec", or "terminal". Use the exact names above.

CRITICAL OUTPUT RULES:
- Output ONLY the final answer the user should see. Never output your internal reasoning, planning, or chain-of-thought as text.
- Do not narrate what you're about to do. Just call the tool, then present the result.
- Do not repeat or restate the user's request. Do not speculate about what the user "probably wants."
- If you read a file and need to edit it, call patch or write_file immediately after reading.
- If the tool output already contains the answer (e.g. command output), do NOT repeat it. Just confirm what was done in one short sentence.

TASK COMPLETION:
- Complete ALL steps the user requested. If the user asks for 3 things, do all 3.
- Do not output "No response requested" or similar.
- Only stop when the entire task is finished.
- Do NOT repeat a tool call you already made. If you already ran a command and got the result, use that result — don't run it again.

WORKING DIRECTORY:
- You operate relative to: {CWD}
- Only access files WITHIN this directory. Never access "/", "/app/", "/home/", etc.
- Use relative paths like "src/index.ts" or "./README.md".
- File tools check this rule: paths resolving outside the project are refused,
  as is "~". Shell commands are not sandboxed; keep them inside the project too.
  If you get a path error, the file is off-limits —
  do not retry with a different spelling of the same path. Tell the user instead.

How to work:
- Always read a file before editing it. Never guess at content.
- Prefer the smallest change. Use \`patch\` for targeted edits; \`write_file\` for new files.
- For shell commands, prefer read-only inspection first (ls, cat, rg, git diff) before mutating state.
- When done, give a concise summary. Don't over-explain.
- If a tool call fails, read the error, adjust, and retry.`;

export interface AgentOpts {
  provider: Provider;
  cwd: string;
  approve: (tool: string, summary: string, detail: string) => Promise<boolean>;
  temperature?: number;
  reasoning_effort?: "low" | "medium" | "high";
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;  // called with accumulated reasoning per turn
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  /** Out-of-band message for the user (e.g. the turn cap was hit). */
  onNotice?: (message: string) => void;
  maxTurns?: number;
  /** Max wall-clock time for a single run_shell command. */
  shellTimeoutMs?: number;
}

export function buildSystemPrompt(cwd: string): string {
  return SYSTEM_PROMPT.replace("{CWD}", cwd);
}

export async function runAgent(
  messages: Message[],
  userMsg: string,
  opts: AgentOpts
): Promise<Message[]> {
  const ctx: ToolCtx = { cwd: opts.cwd, approve: opts.approve, shellTimeoutMs: opts.shellTimeoutMs };
  const conversation: Message[] = [...messages, { role: "user", content: userMsg }];
  const maxTurns = opts.maxTurns ?? 20;
  let toolsExecuted = 0;
  let completed = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Scoped per turn, not per conversation. A conversation-wide set refused
    // legitimate repeats: "run the tests, fix the failure, run them again" had
    // its second run_shell("npm test") skipped as a duplicate and the model was
    // handed the pre-fix result. Within a single turn a repeat is still a loop.
    const executedCalls: string[] = [];
    let assistantText = "";
    let toolCalls: ToolCallParsed[] = [];
    let textBuffer = "";
    let reasoningBuffer = "";

    await new Promise<void>((resolve, reject) => {
      opts.provider.chatStream(
        conversation,
        TOOL_DEFS,
        { temperature: opts.temperature, reasoning_effort: opts.reasoning_effort },
        {
          onDelta: (delta) => {
            if (delta.content) {
              textBuffer += delta.content;
            }
            if (delta.reasoning_content) {
              reasoningBuffer += delta.reasoning_content;
            }
          },
          onDone: ({ content, tool_calls }) => {
            assistantText = content;
            toolCalls = tool_calls;

            // Pass accumulated reasoning to the callback regardless of
            // whether there are tool calls. The UI layer decides whether
            // to show it (background buffer) or discard it. Reasoning from
            // tool-call turns is often the most interesting ("why did it
            // choose that tool?").
            if (reasoningBuffer && opts.onReasoning) {
              opts.onReasoning(reasoningBuffer);
            }

            // Only flush text to the user if there are NO tool calls.
            if (tool_calls.length === 0 && textBuffer && opts.onText) {
              opts.onText(textBuffer);
            }
            resolve();
          },
          onError: (err) => reject(err),
        }
      );
    });

    const assistantMsg: Message = {
      role: "assistant",
      content: assistantText || "",
    };
    conversation.push(assistantMsg);

    if (toolCalls.length === 0) {
      const trivialResponses = [
        "no response requested",
        "done",
        "ok",
        "okay",
        "complete",
        "finished",
      ];
      const isTrivial = !assistantText.trim() ||
        trivialResponses.some(t => assistantText.trim().toLowerCase().startsWith(t));

      if (isTrivial && (turn > 0 || toolsExecuted > 0)) {
        conversation.push({
          role: "user",
          content: "You stopped after partial work. Please continue and complete the entire task I asked for.",
        });
        continue;
      }

      if (!assistantText.trim() && turn === 0 && toolsExecuted === 0) {
        conversation.push({
          role: "user",
          content: "You returned an empty response. Please complete the task I asked for.",
        });
        continue;
      }

      completed = true;
      break;
    }

    for (const tc of toolCalls) {
      const callSignature = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      if (executedCalls.includes(callSignature)) {
        const dupMsg = `Duplicate tool call skipped: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 80)}). You already called this — use the previous result.`;
        opts.onToolResult?.(tc.name, dupMsg);
        conversation.push({
          role: "tool",
          content: dupMsg,
          tool_call_id: tc.id,
          name: tc.name,
        });
        continue;
      }
      executedCalls.push(callSignature);

      opts.onToolCall?.(tc.name, tc.arguments);
      const result = await executeTool(tc.name, tc.arguments, ctx);
      opts.onToolResult?.(tc.name, result);
      conversation.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
        name: tc.name,
      });
      toolsExecuted++;
    }
  }

  // Falling out of the loop without the model choosing to stop means the turn
  // cap cut the work short. Silence here reads as "task finished".
  if (!completed) {
    const notice = `Stopped after ${maxTurns} turns with work still in progress. Re-run with a narrower request, or ask it to continue.`;
    opts.onNotice?.(notice);
  }

  return conversation;
}

export { SYSTEM_PROMPT };
