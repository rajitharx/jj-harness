import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Make a throwaway project dir, optionally with a .harness/config.json. */
export function makeProject(config) {
  const root = mkdtempSync(join(tmpdir(), "harness-test-"));
  mkdirSync(join(root, ".git"));
  if (config !== undefined) {
    mkdirSync(join(root, ".harness"));
    writeFileSync(join(root, ".harness", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return root;
}
