// On SessionStart, inject branch, dirty files, verify commands and the tail of
// .harness/progress.md as a compact context block (about 2 KB at most).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, PROGRESS_PATH, stageEntries } from "../../lib/config.mjs";
import { changedFiles, currentBranch } from "../../lib/git.mjs";
import { DIRS_PLACEHOLDER, FILES_PLACEHOLDER } from "../../lib/verify.mjs";

const MAX_DIRTY_LISTED = 10;
const PROGRESS_LINES = 40;
const MAX_PROGRESS_CHARS = 1200;
const MAX_TEXT = 2048;

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function sessionContext(input, config) {
  const lines = ["## Harness session context"];

  const branch = attempt(() => currentBranch(config.root));
  if (branch) lines.push(`Branch: ${branch}`);

  const dirty = attempt(() => changedFiles(config.root));
  if (dirty) {
    if (dirty.length === 0) lines.push("Working tree: clean");
    else {
      const shown = dirty.slice(0, MAX_DIRTY_LISTED).map((f) => (f.deleted ? `${f.path} (deleted)` : f.path));
      const more = dirty.length > MAX_DIRTY_LISTED ? `, … (+${dirty.length - MAX_DIRTY_LISTED} more)` : "";
      lines.push(`Dirty files (${dirty.length}): ${shown.join(", ")}${more}`);
    }
  }

  const commands = Object.entries(config.verify);
  if (commands.length) {
    lines.push(
      `Verify commands (\`${FILES_PLACEHOLDER}\`/\`${DIRS_PLACEHOLDER}\` = only the changed files or their directories are checked):`,
    );
    for (const [name, stage] of commands) {
      for (const cmd of stageEntries(stage)) {
        const where = cmd.cwd ? `in ${cmd.cwd}` : "";
        const only = cmd.files ? `only for ${cmd.files.join(", ")}` : "";
        const extra = [where, only].filter(Boolean).join("; ");
        lines.push(`- ${name}: ${cmd.run}${extra ? ` (${extra})` : ""}`);
      }
    }
    if (config.stopGate.enabled) lines.push("lint, typecheck and test re-run before you can stop if files changed.");
  }

  if (!existsSync(join(config.root, CONFIG_PATH))) {
    lines.push("No .harness/config.json yet: run /harness:harness-init to set up verify commands.");
  }

  const progress = attempt(() => readFileSync(join(config.root, PROGRESS_PATH), "utf8"));
  if (progress && progress.trim()) {
    let recent = progress.trimEnd().split("\n").slice(-PROGRESS_LINES).join("\n");
    if (recent.length > MAX_PROGRESS_CHARS) recent = "…" + recent.slice(-MAX_PROGRESS_CHARS);
    lines.push("", "Recent progress (.harness/progress.md):", recent);
  }

  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + "…";
  return { kind: "context", text };
}

/** Run `fn`, returning undefined on any error: missing git or files just drop a line. */
function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
