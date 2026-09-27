// Config tests. The file-mode checks run in a child process with HOME
// redirected, because config.ts resolves the path once at import time.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import { fileURLToPath } from "node:url";
import { parseSSE } from "../src/util/sse.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JS = path.resolve(HERE, "../src/config.js");

/** Runs `code` with HOME pointed at a fresh scratch dir; returns that dir. */
function inFakeHome(code: string): string {
  const home = path.join(os.tmpdir(), `sarvam-home-${Math.random().toString(36).slice(2)}`);
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: "pipe",
  });
  return home;
}

describe("config file permissions", () => {
  test("saveConfig writes the API key 0600 in a 0700 directory", async () => {
    const home = inFakeHome(`
      const { saveConfig } = await import(${JSON.stringify(CONFIG_JS)});
      await saveConfig({
        provider: "sarvam",
        sarvam: { apiKey: "sk_secret", model: "sarvam-105b" },
        openai: { apiKey: "", model: "gpt-4o" },
      });
    `);

    const dir = path.join(home, ".sarvam");
    const file = path.join(dir, "config.json");
    const dirMode = (await fs.stat(dir)).mode & 0o777;
    const fileMode = (await fs.stat(file)).mode & 0o777;

    assert.equal(fileMode, 0o600, `config.json should be 0600, got ${fileMode.toString(8)}`);
    assert.equal(dirMode, 0o700, `~/.sarvam should be 0700, got ${dirMode.toString(8)}`);

    await fs.rm(home, { recursive: true, force: true });
  });

  test("loadConfig tightens a pre-existing world-readable config", async () => {
    const home = inFakeHome(`
      const { saveConfig, loadConfig } = await import(${JSON.stringify(CONFIG_JS)});
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      await saveConfig({
        provider: "sarvam",
        sarvam: { apiKey: "sk_secret", model: "sarvam-105b" },
        openai: { apiKey: "", model: "gpt-4o" },
      });
      const dir = path.join(os.homedir(), ".sarvam");
      const file = path.join(dir, "config.json");
      await fs.chmod(file, 0o644);       // simulate a config from an older version
      await fs.chmod(dir, 0o755);
      await loadConfig();
    `);

    const dir = path.join(home, ".sarvam");
    const file = path.join(dir, "config.json");
    const mode = (await fs.stat(file)).mode & 0o777;
    const dirMode = (await fs.stat(dir)).mode & 0o777;
    assert.equal(mode, 0o600, `expected loadConfig to chmod down, got ${mode.toString(8)}`);
    assert.equal(dirMode, 0o700, `expected loadConfig to tighten the dir, got ${dirMode.toString(8)}`);

    await fs.rm(home, { recursive: true, force: true });
  });
});

describe("parseSSE", () => {
  const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });

  const collect = async (s: ReadableStream<Uint8Array>) => {
    const out: string[] = [];
    for await (const d of parseSSE(s)) out.push(d);
    return out;
  };

  test("yields each data payload", async () => {
    assert.deepEqual(
      await collect(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n'])),
      ['{"a":1}', '{"b":2}']
    );
  });

  test("reassembles an event split across chunks", async () => {
    assert.deepEqual(await collect(streamOf(['data: {"a', '":1}\n\n'])), ['{"a":1}']);
  });

  test("passes [DONE] through and ignores comments", async () => {
    assert.deepEqual(
      await collect(streamOf([": keepalive\n\n", "data: [DONE]\n\n"])),
      ["[DONE]"]
    );
  });

  test("flushes a trailing event with no blank line", async () => {
    assert.deepEqual(await collect(streamOf(['data: {"z":9}'])), ['{"z":9}']);
  });
});
