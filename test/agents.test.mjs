import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { frontmatter } from "./helpers.mjs";

const AGENTS = fileURLToPath(new URL("../agents/", import.meta.url));
const SKILLS = fileURLToPath(new URL("../skills/", import.meta.url));
const agentFiles = readdirSync(AGENTS).filter((f) => f.endsWith(".md"));
const agentNames = agentFiles.map((f) => f.slice(0, -".md".length));
const readAgent = (name) => readFileSync(join(AGENTS, `${name}.md`), "utf8");

/** Every SKILL.md under skills/, at any depth. */
function skillFiles(dir = SKILLS) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? skillFiles(join(dir, e.name)) : e.name === "SKILL.md" ? [join(dir, e.name)] : [],
  );
}

/**
 * `harness:<name>` references to agents in a skill's text. Skipped: slash
 * commands (`/harness:verify`, which name skills) and the CLAUDE.md marker
 * comments (`<!-- harness:start -->`).
 */
const agentRefs = (text) =>
  [...text.matchAll(/(?<![/\w-]|<!-- )harness:([a-z][\w-]*)/g)].map((m) => m[1]);

// The fields Claude Code documents for plugin subagents
// (https://code.claude.com/docs/en/sub-agents, plugins/components). Unknown
// fields are ignored silently, so a typo would go unnoticed without this.
const PLUGIN_AGENT_FIELDS = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "effort",
  "maxTurns",
  "autoCompactWindow",
  "skills",
  "memory",
  "background",
  "omitClaudeMd",
  "isolation",
  "color",
  "experimental",
];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const tools = (fm) => (fm.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);

test("the plugin ships the expected agents", () => {
  assert.deepEqual(agentNames.sort(), ["reviewer", "test-writer"]);
});

for (const name of agentNames) {
  test(`agent ${name}: frontmatter name matches the file, with a real description`, () => {
    const text = readAgent(name);
    const fm = frontmatter(text);
    assert.equal(fm.name, name);
    assert.ok(fm.description && fm.description.length >= 40, `a real description: ${fm.description}`);
    for (const key of Object.keys(fm)) assert.ok(PLUGIN_AGENT_FIELDS.includes(key), `${name}: undocumented field "${key}"`);
    assert.doesNotMatch(text, /not implemented|Sketch/i, "no stub text left");
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    assert.ok(body.length > 200, "has a real system prompt");
  });
}

test("reviewer is read-only: an explicit tools list with no editing tool", () => {
  const list = tools(frontmatter(readAgent("reviewer")));
  assert.ok(list.length > 0, "tools is set (omitting it would inherit every tool)");
  for (const t of EDIT_TOOLS) assert.ok(!list.includes(t), `reviewer must not have ${t}`);
});

test("test-writer has an explicit tools list that can write tests and run them", () => {
  const list = tools(frontmatter(readAgent("test-writer")));
  for (const t of ["Read", "Edit", "Write", "Bash"]) assert.ok(list.includes(t), `test-writer needs ${t}`);
});

test("reviewer's prompt covers verification, read-only use and the output contract", () => {
  const text = readAgent("reviewer");
  for (const re of [/CONFIRMED/, /PLAUSIBLE/, /blocking/, /should-fix/, /Checked and fine/, /Verdict: approve \| request changes/, /No findings/, /CLAUDE\.md/, /AGENTS\.md/, /bin\/harness\.mjs" verify/]) {
    assert.match(text, re);
  }
});

test("agent references in skills resolve to agent files", () => {
  const files = skillFiles();
  const refs = files.flatMap((f) => agentRefs(readFileSync(f, "utf8")).map((name) => ({ file: relative(SKILLS, f), name })));
  // The scanner must actually find references, or this test proves nothing.
  assert.ok(refs.some((r) => r.name === "reviewer"), "review references harness:reviewer");
  for (const { file, name } of refs) assert.ok(agentNames.includes(name), `${file} references unknown agent harness:${name}`);
});

test("agentRefs skips skill commands and marker comments", () => {
  assert.deepEqual(agentRefs('`/harness:verify` <!-- harness:start --> "harness:reviewer" `harness:x-y`'), ["reviewer", "x-y"]);
});
