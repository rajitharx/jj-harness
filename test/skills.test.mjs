import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../lib/config.mjs";
import { COMMANDS, SUBCOMMANDS } from "../bin/harness.mjs";
import { frontmatter } from "./helpers.mjs";

const SKILLS = fileURLToPath(new URL("../skills/", import.meta.url));
const dirs = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const read = (dir) => readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");

/** Subcommands a skill invokes as `bin/harness.mjs <sub>` (quoted or not). */
const invoked = (text) => [...text.matchAll(/bin\/harness\.mjs"?\s+([a-z][\w-]*)/g)].map((m) => m[1]);

/** `--flags` written after `bin/harness.mjs <sub>` on the same line, up to the closing backtick. */
const invokedFlags = (text) =>
  [...text.matchAll(/bin\/harness\.mjs"?\s+([a-z][\w-]*)([^`\n]*)/g)].flatMap(([, sub, rest]) =>
    [...rest.matchAll(/(?<!\S)(--[\w-]+)/g)].map((m) => ({ sub, flag: m[1] })),
  );
const knownFlag = (sub, flag) => COMMANDS[sub] && [...COMMANDS[sub].flags, ...COMMANDS[sub].options].includes(flag);

test("the plugin ships the expected skills", () => {
  assert.deepEqual(dirs.sort(), ["handoff", "harness-init", "plan", "review", "ship", "stats", "verify"]);
});

for (const dir of dirs) {
  test(`skill ${dir}: SKILL.md with a matching name and a description`, () => {
    assert.ok(existsSync(join(SKILLS, dir, "SKILL.md")), "has SKILL.md");
    const text = read(dir);
    const fm = frontmatter(text);
    assert.equal(fm.name, dir);
    assert.ok(fm.description && fm.description.length >= 40, `a real trigger description: ${fm.description}`);
    assert.doesNotMatch(text, /not implemented|Sketch/i, "no stub text left");
  });

  test(`skill ${dir}: every CLI subcommand and flag it mentions exists`, () => {
    for (const sub of invoked(read(dir))) assert.ok(SUBCOMMANDS.includes(sub), `${dir} calls unknown subcommand "${sub}"`);
    for (const { sub, flag } of invokedFlags(read(dir))) assert.ok(knownFlag(sub, flag), `${dir} passes unknown flag ${sub} ${flag}`);
  });
}

test("the reviewer agent's CLI calls use real subcommands and flags", () => {
  const text = readFileSync(fileURLToPath(new URL("../agents/reviewer.md", import.meta.url)), "utf8");
  const calls = invokedFlags(text);
  assert.ok(calls.some((c) => c.sub === "verify" && c.flag === "--base"), "reviewer runs verify --base");
  for (const { sub, flag } of calls) assert.ok(knownFlag(sub, flag), `reviewer passes unknown flag ${sub} ${flag}`);
});

test("review and ship check committed work with verify --base", () => {
  for (const dir of ["review", "ship"]) {
    assert.ok(invokedFlags(read(dir)).some((c) => c.sub === "verify" && c.flag === "--base"), `${dir} uses verify --base`);
    assert.match(read(dir), /nothing ran/, `${dir} says what "nothing ran" means`);
  }
  assert.match(read("verify"), /--base <ref>/);
});

test("skills that call the CLI reach it through their base directory", () => {
  for (const dir of ["harness-init", "verify", "ship"]) {
    const text = read(dir);
    assert.ok(invoked(text).length > 0, `${dir} calls the CLI`);
    assert.match(text, /node "<skill base dir>\/\.\.\/\.\.\/bin\/harness\.mjs"/, dir);
    assert.match(text, /base directory/, `${dir} explains the base directory`);
  }
  assert.deepEqual([...new Set(invoked(read("harness-init")))].sort(), ["init"]);
});

test("ship lists every default protected path", () => {
  const ship = read("ship");
  const defaults = defaultConfig(mkdtempSync(join(tmpdir(), "harness-skills-"))).protectedPaths;
  for (const p of defaults) assert.ok(ship.includes(`\`${p}\``), `ship mentions ${p}`);
});

test("review sends the diff to the harness:reviewer agent", () => {
  assert.match(read("review"), /subagent_type: "harness:reviewer"/);
});
