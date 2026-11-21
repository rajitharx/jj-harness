// Release consistency: the three version fields agree, the changelog covers
// the version, and the README's config reference matches lib/config.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultConfig, validateConfig } from "../lib/config.mjs";
import { makeProject } from "./helpers.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));

const plugin = json(".claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");
const pkg = json("package.json");

test("plugin.json is the one plugin version; package.json matches and the marketplace entry sets none", () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json lists the "${plugin.name}" plugin`);
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, plugin.version, "package.json version");
  // The host-marketplace docs: don't set version in both places; plugin.json silently wins.
  assert.equal(entry.version, undefined, "the marketplace entry must not set version");
});

test("CHANGELOG.md has a dated entry for the current version", () => {
  const escaped = plugin.version.replace(/\./g, "\\.");
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
});

/** The JSON block that follows the `<!-- config-defaults -->` marker in the README. */
function readmeDefaults(readme) {
  const m = /<!-- config-defaults -->\s*```json\n([\s\S]*?)\n```/.exec(readme);
  assert.ok(m, "README has a ```json block right after <!-- config-defaults -->");
  return JSON.parse(m[1]);
}

test("README config defaults match lib/config.mjs", () => {
  const { root, ...defaults } = defaultConfig(makeProject());
  assert.ok(root);
  assert.deepEqual(readmeDefaults(read("README.md")), JSON.parse(JSON.stringify(defaults)));
});

/** The verify stage names, read from lib/config.mjs's own error for an unknown one. */
function verifyKeys() {
  try {
    validateConfig({ verify: { "?": "" } });
  } catch (err) {
    const m = /is not one of (.+)$/.exec(err.message);
    assert.ok(m, err.message);
    return m[1].split(", ");
  }
  assert.fail("an unknown verify key was accepted");
}

test("README config table documents every key and nothing else", () => {
  const readme = read("README.md");
  const { root, verify, stopGate, ...rest } = defaultConfig(makeProject());
  const expected = [
    ...verifyKeys().map((s) => `verify.${s}`),
    ...Object.keys(rest),
    ...Object.keys(stopGate).map((k) => `stopGate.${k}`),
  ].sort();
  const section = readme.slice(readme.indexOf("## Config reference"), readme.indexOf("<!-- config-defaults -->"));
  const documented = [...section.matchAll(/^\| `([\w.]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(documented, expected);
});
