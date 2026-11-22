// After an edit, run config.verify.format on the touched file; never blocks.
// Silent on success; a failure comes back as context so the agent can react.
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { describeRun, runStage, tail } from "../../lib/verify.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const OUTPUT_TAIL = 1500;

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function formatOnEdit(input, config) {
  if (!EDIT_TOOLS.has(input.tool_name) || !config.verify.format) return { kind: "allow" };
  const raw = input.tool_input?.file_path;
  if (typeof raw !== "string" || raw === "") return { kind: "allow" };

  const abs = resolve(input.cwd || config.root, raw);
  const rel = relative(config.root, abs);
  const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!inside || !isFile(abs)) return { kind: "allow" };
  const file = sep === "/" ? rel : rel.split(sep).join("/");

  // The time limit is config.formatTimeoutSec (runStage's default for format).
  const started = Date.now();
  const result = await runStage("format", config, [file]);
  const ms = Date.now() - started;
  if (result.ok) return { kind: "allow", metrics: { result: result.skipped ? "skipped" : "ok", ms } };
  const metrics = { result: result.timedOut ? "timeout" : "failed", ms };
  const why = result.timedOut
    ? `timed out after ${config.formatTimeoutSec}s (formatTimeoutSec)`
    : result.exitCode === null
      ? "could not run"
      : `exited with code ${result.exitCode}`;
  return {
    kind: "context",
    metrics,
    text: `Formatter failed on ${file}: \`${result.command}\` ${why}.\n${tail(result.output, OUTPUT_TAIL) || "(no output)"}`,
  };
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
