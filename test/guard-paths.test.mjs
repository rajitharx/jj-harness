import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { guardPaths } from "../hooks/policies/guard-paths.mjs";
import { makeProject } from "./helpers.mjs";

const root = makeProject();
const config = loadConfig(root);
const edit = (file_path, { tool = "Edit", cwd = root, c = config } = {}) =>
  guardPaths({ tool_name: tool, cwd, tool_input: tool === "NotebookEdit" ? { notebook_path: file_path } : { file_path } }, c);

const MUST_BLOCK = [
  [".env", ".env"],
  [".env.local", ".env.*"],
  ["config/.env", "**/.env"],
  ["apps/web/.env.production", "**/.env.*"],
  ["certs/server.pem", "**/*.pem"],
  ["deploy.key", "**/*.key"],
  [".git/config", ".git/**"],
  [".git/hooks/pre-commit", ".git/**"],
  ["~/.ssh/id_ed25519", "**/id_ed25519*"],
  ["~/.ssh/id_rsa", "**/id_rsa*"],
  ["/etc/ssl/private/site.key", "**/*.key"],
  [".ENV", ".env"],
  ["certs/server.KEY", "**/*.key"],
  [".Git/config", ".git/**"],
];

const MUST_ALLOW = [
  "src/env.ts",
  // Deliberate: `.envrc.example` is a direnv template, not a dotenv file. The
  // defaults match `.env` and `.env.<suffix>`, and `.envrc…` has no dot after `.env`.
  ".envrc.example",
  "docs/keys.md",
  ".github/workflows/ci.yml",
  ".gitignore",
  "src/environment/index.ts",
  "README.md",
  "/tmp/notes.txt",
];

for (const [path, pattern] of MUST_BLOCK) {
  test(`blocks ${path} (${pattern})`, async () => {
    const v = await edit(path);
    assert.equal(v.kind, "block");
    assert.ok(v.reason.includes(`"${pattern}"`), `reason names the pattern: ${v.reason}`);
  });
}

for (const path of MUST_ALLOW) {
  test(`allows ${path}`, async () => {
    assert.deepEqual(await edit(path), { kind: "allow" });
  });
}

test("applies to Write, MultiEdit and NotebookEdit; other tools are allowed", async () => {
  for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) {
    assert.equal((await edit(".env", { tool })).kind, "block", tool);
  }
  assert.deepEqual(await guardPaths({ tool_name: "Read", cwd: root, tool_input: { file_path: ".env" } }, config), { kind: "allow" });
  assert.deepEqual(await guardPaths({ tool_name: "Bash", cwd: root, tool_input: { command: "cat .env" } }, config), { kind: "allow" });
  assert.deepEqual(await guardPaths({ tool_name: "Edit", cwd: root, tool_input: {} }, config), { kind: "allow" });
});

test("resolves relative paths against cwd, then matches relative to the root", async () => {
  const nested = join(root, "config");
  assert.equal((await edit(".env", { cwd: nested })).kind, "block", "config/.env via nested cwd");
  assert.equal((await edit("../.git/HEAD", { cwd: nested })).kind, "block");
  assert.equal((await edit(join(root, "certs", "a.pem"))).kind, "block", "absolute path inside root");
  assert.deepEqual(await edit("env.ts", { cwd: join(root, "src") }), { kind: "allow" });
});

test("outside the root only **/ patterns apply, against the absolute path", async () => {
  assert.equal((await edit(join(homedir(), ".ssh", "id_rsa.pub"))).kind, "block");
  // `.env` (root-anchored) must not match some other project's top-level .env…
  const c = loadConfig(makeProject({ protectedPaths: ["secrets/**"] }));
  assert.deepEqual(await edit("/elsewhere/secrets/a.txt", { c }), { kind: "allow" });
  // …but `**/.env` still catches it.
  assert.equal((await edit("/elsewhere/.env", { c })).kind, "block");
});

test("a directory whose name starts with '..' is inside the root", async () => {
  const c = loadConfig(makeProject({ protectedPaths: ["..vault/**"] }));
  assert.equal((await edit("..vault/token", { cwd: c.root, c })).kind, "block");
  assert.equal((await edit("../..vault/token", { cwd: join(c.root, "sub"), c })).kind, "block");
});

test("glob semantics: **, *, ? and dot-files", async () => {
  const c = loadConfig(
    makeProject({ protectedPaths: ["secrets/**", "**/*.lock", "data/?.csv", "infra/**/prod/*.tfvars", "*.sqlite"] }),
  );
  const r = c.root;
  const cases = [
    ["secrets/a.txt", "block"],
    ["secrets/deep/.hidden", "block"],
    ["secretsx/a.txt", "allow"],
    ["package.lock", "block"],
    ["a/b/.yarn.lock", "block"],
    ["data/1.csv", "block"],
    ["data/12.csv", "allow"],
    ["infra/prod/x.tfvars", "block"],
    ["infra/a/b/prod/x.tfvars", "block"],
    ["infra/prod/sub/x.tfvars", "allow"],
    ["app.sqlite", "block"],
    ["db/app.sqlite", "allow"],
    ["file(1).txt", "allow"],
  ];
  for (const [path, kind] of cases) {
    assert.equal((await edit(path, { cwd: r, c })).kind, kind, path);
  }
});
