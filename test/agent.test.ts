// Agent-loop tests driven by a scripted fake provider — no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

import { runAgent } from "../src/agent/loop.js";
import { Message, Provider, StreamCallbacks, ToolCallParsed } from "../src/types.js";
import { isAutoApprove } from "../src/config.js";

/** Replays a fixed script of turns, one per chatStream call. */
function fakeProvider(turns: Array<{ content?: string; tool_calls?: ToolCallParsed[] }>): Provider {
  let i = 0;
  return {
    name: "fake",
    getModel: () => "fake-model",
    setModel: () => {},
    listModels: () => ["fake-model"],
    async chatStream(_m: Message[], _t, _o, cb: StreamCallbacks) {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      cb.onDone({ content: turn.content ?? "", tool_calls: turn.tool_calls ?? [] });
    },
  };
}

const call = (id: string, command: string): ToolCallParsed => ({
  id,
  name: "run_shell",
  arguments: { command },
});

describe("duplicate tool calls", () => {
  test("skips a repeat within the same turn", async () => {
    const results: string[] = [];
    await runAgent([], "go", {
      provider: fakeProvider([
        { tool_calls: [call("1", "echo once"), call("2", "echo once")] },
        { content: "done" },
      ]),
      cwd: os.tmpdir(),
      approve: async () => true,
      onToolResult: (_n, r) => results.push(r),
    });
    assert.equal(results.length, 2);
    assert.match(results[1], /Duplicate tool call skipped/);
  });

  // The regression this guards: "run the tests, fix it, run them again" used to
  // have its second identical command skipped, handing the model a stale result.
  test("allows the same command again on a later turn", async () => {
    const results: string[] = [];
    await runAgent([], "go", {
      provider: fakeProvider([
        { tool_calls: [call("1", "echo run")] },
        { tool_calls: [call("2", "echo run")] },
        { content: "done" },
      ]),
      cwd: os.tmpdir(),
      approve: async () => true,
      onToolResult: (_n, r) => results.push(r),
    });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.doesNotMatch(r, /Duplicate/, "a later turn may legitimately repeat a command");
      assert.match(r, /run/);
    }
  });
});

describe("turn cap", () => {
  test("notifies when work is cut short", async () => {
    const notices: string[] = [];
    let n = 0;
    await runAgent([], "go", {
      // Never stops calling tools — each call is unique so nothing is skipped.
      provider: fakeProvider([{ tool_calls: [call("x", "echo loop")] }]),
      cwd: os.tmpdir(),
      approve: async () => true,
      onToolCall: () => { n++; },
      onNotice: (m) => notices.push(m),
      maxTurns: 3,
    });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Stopped after 3 turns/);
  });

  test("stays silent when the model finishes on its own", async () => {
    const notices: string[] = [];
    await runAgent([], "go", {
      provider: fakeProvider([{ content: "all done" }]),
      cwd: os.tmpdir(),
      approve: async () => true,
      onNotice: (m) => notices.push(m),
    });
    assert.equal(notices.length, 0);
  });
});

describe("approval declined", () => {
  test("a declined tool reports back instead of running", async () => {
    const results: string[] = [];
    await runAgent([], "go", {
      provider: fakeProvider([
        { tool_calls: [{ id: "1", name: "write_file", arguments: { path: "x.txt", content: "y" } }] },
        { content: "ok" },
      ]),
      cwd: os.tmpdir(),
      approve: async () => false,
      onToolResult: (_n, r) => results.push(r),
    });
    assert.match(results[0], /declined/i);
  });
});

describe("isAutoApprove", () => {
  test("auto and never skip the prompt", () => {
    assert.equal(isAutoApprove("auto"), true);
    assert.equal(isAutoApprove("never"), true);
  });

  // The inversion this guards: "always" used to skip prompts in the REPL, so
  // the most cautious-sounding setting produced no prompts at all.
  test("always and prompt keep prompting", () => {
    assert.equal(isAutoApprove("always"), false);
    assert.equal(isAutoApprove("prompt"), false);
  });

  test("unset defaults to prompting", () => {
    assert.equal(isAutoApprove(undefined), false);
  });
});
