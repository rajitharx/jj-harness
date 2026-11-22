import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { formatOnEdit } from "../hooks/policies/format-on-edit.mjs";
import { bare, makeProject, writeFile } from "./helpers.mjs";

// Records each formatter invocation's arguments: one line per run, arguments
// separated by \x1f. A shell script keeps the test fast.
function recorder() {
  const log = join(mkdtempSync(join(tmpdir(), "harness-fmt-")), "calls");
  writeFileSync(log, "");
  const script = `printf '%s\\037' "$@" >> '${log}'; printf '\\n' >> '${log}'\n`;
  const calls = () =>
    readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\x1f").slice(0, -1));
  return { script, calls };
}

function setup(format) {
  const rec = recorder();
  const root = makeProject(format === undefined ? {} : { verify: { format } });
  writeFile(root, "fmt.sh", rec.script);
  writeFile(root, "src/a b.ts", "x\n");
  return { root, config: loadConfig(root), calls: rec.calls };
}

const editRaw = (config, file_path, { tool = "Edit", cwd = config.root } = {}) =>
  formatOnEdit({ tool_name: tool, cwd, tool_input: { file_path } }, config);
const edit = async (...args) => bare(await editRaw(...args));

test("formats the edited file, root-relative, silently on success", async () => {
  const { root, config, calls } = setup("sh fmt.sh");
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.deepEqual(await edit(config, "src/a b.ts", { tool }), { kind: "allow" }, tool);
  }
  assert.deepEqual(await edit(config, join(root, "src", "a b.ts")), { kind: "allow" }, "absolute path");
  assert.deepEqual(await edit(config, "a b.ts", { cwd: join(root, "src") }), { kind: "allow" }, "relative to cwd");
  assert.deepEqual(calls(), Array(5).fill(["src/a b.ts"]));
});

test("{files} in the format command is replaced instead of appended", async () => {
  const { config, calls } = setup("sh fmt.sh --write {files} --quiet");
  await edit(config, "src/a b.ts");
  assert.deepEqual(calls(), [["--write", "src/a b.ts", "--quiet"]]);
});

test("does nothing for other tools, missing paths, files outside the root or gone, or no format command", async () => {
  const { config, calls } = setup("sh fmt.sh");
  const cases = [
    ["Read", { tool_name: "Read", tool_input: { file_path: "src/a b.ts" } }],
    ["NotebookEdit", { tool_name: "NotebookEdit", tool_input: { notebook_path: "src/a b.ts" } }],
    ["no file_path", { tool_name: "Edit", tool_input: {} }],
    ["empty file_path", { tool_name: "Edit", tool_input: { file_path: "" } }],
    ["outside the root", { tool_name: "Write", tool_input: { file_path: join(tmpdir(), "elsewhere.ts") } }],
    ["parent dir", { tool_name: "Write", tool_input: { file_path: "../x.ts" } }],
    ["deleted", { tool_name: "Edit", tool_input: { file_path: "src/gone.ts" } }],
    ["the root itself", { tool_name: "Edit", tool_input: { file_path: "." } }],
  ];
  for (const [name, input] of cases) {
    assert.deepEqual(bare(await formatOnEdit({ cwd: config.root, ...input }, config)), { kind: "allow" }, name);
  }
  assert.deepEqual(calls(), []);
  const none = setup(undefined);
  assert.deepEqual(await edit(none.config, "src/a b.ts"), { kind: "allow" });
  assert.deepEqual(none.calls(), []);
});

test("a formatter failure comes back as context with the output tail, never a block", async () => {
  const { config } = setup(`node -e "console.error('SyntaxError: unexpected token'); process.exit(2)"`);
  const v = await edit(config, "src/a b.ts");
  assert.equal(v.kind, "context");
  assert.match(v.text, /Formatter failed on src\/a b\.ts/);
  assert.match(v.text, /exited with code 2/);
  assert.match(v.text, /SyntaxError: unexpected token/);
  assert.ok(v.text.length < 2048);
});

test("metrics: ok, failed, timeout and skipped results with a duration; nothing when it does not apply", async () => {
  const cases = [
    ["ok", "sh fmt.sh", {}],
    ["failed", "sh fmt.sh; exit 3", {}],
    ["timeout", `node -e "setTimeout(() => {}, 30000)"`, { formatTimeoutSec: 1 }],
  ];
  for (const [result, format, extra] of cases) {
    const rec = recorder();
    const root = makeProject({ verify: { format }, ...extra });
    writeFile(root, "fmt.sh", rec.script);
    writeFile(root, "src/a.ts", "x\n");
    const verdict = await editRaw(loadConfig(root), "src/a.ts");
    assert.equal(verdict.metrics.result, result);
    assert.ok(Number.isInteger(verdict.metrics.ms) && verdict.metrics.ms >= 0, result);
    assert.deepEqual(Object.keys(verdict.metrics).sort(), ["ms", "result"]);
  }
  const skipped = makeProject({ verify: { format: { run: "exit 1", files: ["**/*.py"] } } });
  writeFile(skipped, "src/a.ts", "x\n");
  assert.equal((await editRaw(loadConfig(skipped), "src/a.ts")).metrics.result, "skipped", "the files filter matched nothing");

  const { config } = setup("sh fmt.sh");
  assert.equal((await editRaw(config, "src/gone.ts")).metrics, undefined, "file missing");
  assert.equal((await formatOnEdit({ tool_name: "Read", tool_input: { file_path: "src/a b.ts" } }, config)).metrics, undefined, "other tool");
  assert.equal((await editRaw(setup(undefined).config, "src/a b.ts")).metrics, undefined, "no formatter configured");
});
