// Tool-layer tests: path containment, patch fidelity, shell timeout.
// Run with `npm test` (compiles, then node --test on dist/).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveInRoot,
  executeTool,
  ToolCtx,
  DEFAULT_SHELL_TIMEOUT_MS,
} from "../src/tools/index.js";

let root: string;
let outside: string;

before(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sarvam-test-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "SECRET", "utf8");
  await fs.writeFile(path.join(root, "inside.txt"), "hello", "utf8");
});

after(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

const ctx = (): ToolCtx => ({ cwd: root, approve: async () => true });

describe("resolveInRoot", () => {
  test("allows a plain relative path", async () => {
    const r = await resolveInRoot(root, "inside.txt");
    assert.equal(r.ok, true);
  });

  test("allows a not-yet-existing nested path", async () => {
    const r = await resolveInRoot(root, "src/new/file.ts");
    assert.equal(r.ok, true);
  });

  test("allows an in-project name starting with two dots", async () => {
    const r = await resolveInRoot(root, "..valid/file.ts");
    assert.equal(r.ok, true);
  });

  test("allows a symlink whose target stays inside the project", async () => {
    await fs.symlink(path.join(root, "inside.txt"), path.join(root, "safe-link"));
    assert.equal((await resolveInRoot(root, "safe-link")).ok, true);
  });

  test("refuses a missing project root", async () => {
    assert.equal((await resolveInRoot(path.join(root, "missing-root"), "file.txt")).ok, false);
  });

  test("refuses a symlink loop instead of trusting its parent", async () => {
    await fs.symlink("loop-link", path.join(root, "loop-link"));
    assert.equal((await resolveInRoot(root, "loop-link")).ok, false);
  });

  test("refuses an absolute path outside the root", async () => {
    const r = await resolveInRoot(root, "/etc/passwd");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /outside the project root/);
  });

  test("refuses traversal out of the root", async () => {
    const r = await resolveInRoot(root, "../outside/secret.txt");
    assert.equal(r.ok, false);
  });

  test("refuses deep traversal", async () => {
    const r = await resolveInRoot(root, "../../../../etc/passwd");
    assert.equal(r.ok, false);
  });

  test("refuses ~ rather than creating a literal ~ directory", async () => {
    const r = await resolveInRoot(root, "~/.sarvam/config.json");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /not expanded/);
  });

  test("refuses a symlink pointing out of the root", async () => {
    const link = path.join(root, "escape-link");
    await fs.symlink(path.join(outside, "secret.txt"), link).catch(() => {});
    const r = await resolveInRoot(root, "escape-link");
    assert.equal(r.ok, false, "a symlink out of the project must not resolve");
  });
});

describe("read_file containment", () => {
  test("reads a file inside the project", async () => {
    const out = await executeTool("read_file", { path: "inside.txt" }, ctx());
    assert.match(out, /hello/);
  });

  // read_file has no approval prompt, so containment is the only control on it.
  test("refuses to read outside the project", async () => {
    const out = await executeTool("read_file", { path: "../outside/secret.txt" }, ctx());
    assert.doesNotMatch(out, /SECRET/);
    assert.match(out, /outside the project root/);
  });
});

describe("write_file containment", () => {
  test("refuses a dangling symlink to a new outside file", async () => {
    const target = path.join(outside, "dangling-target.txt");
    await fs.symlink(target, path.join(root, "dangling-link"));
    let approvals = 0;
    const out = await executeTool("write_file", { path: "dangling-link", content: "escape" }, {
      cwd: root,
      approve: async () => { approvals++; return true; },
    });
    assert.match(out, /Error:/);
    assert.equal(approvals, 0);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  });

  test("refuses a path beneath a dangling directory symlink", async () => {
    const target = path.join(outside, "missing-directory");
    await fs.symlink(target, path.join(root, "dangling-dir"));
    const out = await executeTool("write_file", { path: "dangling-dir/new.txt", content: "escape" }, ctx());
    assert.match(out, /Error:/);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  });

  test("rechecks a path changed during approval", async () => {
    const f = path.join(root, "changed-write.txt");
    const out = await executeTool("write_file", { path: "changed-write.txt", content: "escape" }, {
      cwd: root,
      approve: async () => {
        await fs.symlink(path.join(outside, "secret.txt"), f);
        return true;
      },
    });
    assert.match(out, /outside the project root/);
    assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET");
  });

  test("refuses to write outside the project", async () => {
    const target = path.join(outside, "written.txt");
    const out = await executeTool(
      "write_file",
      { path: "../outside/written.txt", content: "x" },
      ctx()
    );
    assert.match(out, /outside the project root/);
    await assert.rejects(fs.stat(target), "no file may be created outside the root");
  });
});

describe("patch", () => {
  test("rechecks a path changed during approval", async () => {
    const f = path.join(root, "changed-patch.txt");
    await fs.writeFile(f, "original");
    const out = await executeTool("patch", {
      path: "changed-patch.txt", old_string: "original", new_string: "escape",
    }, {
      cwd: root,
      approve: async () => {
        await fs.unlink(f);
        await fs.symlink(path.join(outside, "secret.txt"), f);
        return true;
      },
    });
    assert.match(out, /outside the project root/);
    assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "SECRET");
  });

  test("does not interpret $ sequences in the replacement", async () => {
    const f = path.join(root, "dollar.txt");
    await fs.writeFile(f, "const price = 10;", "utf8");

    const out = await executeTool(
      "patch",
      { path: "dollar.txt", old_string: "price", new_string: "$& $&" },
      ctx()
    );
    assert.match(out, /Patched/);
    assert.equal(await fs.readFile(f, "utf8"), "const $& $& = 10;");
  });

  test("preserves a backtick-dollar replacement verbatim", async () => {
    const f = path.join(root, "dollar2.txt");
    await fs.writeFile(f, "echo VALUE", "utf8");
    await executeTool(
      "patch",
      { path: "dollar2.txt", old_string: "VALUE", new_string: "$`x" },
      ctx()
    );
    assert.equal(await fs.readFile(f, "utf8"), "echo $`x");
  });

  test("refuses an ambiguous match", async () => {
    const f = path.join(root, "dup.txt");
    await fs.writeFile(f, "a a", "utf8");
    const out = await executeTool(
      "patch",
      { path: "dup.txt", old_string: "a", new_string: "b" },
      ctx()
    );
    assert.match(out, /appears 2 times/);
  });
});

describe("run_shell", () => {
  test("returns command output", async () => {
    const out = await executeTool("run_shell", { command: "echo hi" }, ctx());
    assert.match(out, /hi/);
  });

  test("kills a command that exceeds the timeout", async () => {
    const started = Date.now();
    const out = await executeTool(
      "run_shell",
      { command: "sleep 30" },
      { ...ctx(), shellTimeoutMs: 400 }
    );
    assert.match(out, /timed out/);
    assert.ok(Date.now() - started < 10_000, "must not wait for the full sleep");
  });

  test("has a sane default timeout", () => {
    assert.equal(DEFAULT_SHELL_TIMEOUT_MS, 120_000);
  });
});

describe("tool aliases", () => {
  test("maps a guessed name to the real tool", async () => {
    const out = await executeTool("bash", { command: "echo aliased" }, ctx());
    assert.match(out, /aliased/);
  });

  test("reports an unknown tool without throwing", async () => {
    const out = await executeTool("teleport", {}, ctx());
    assert.match(out, /Unknown tool/);
  });
});
