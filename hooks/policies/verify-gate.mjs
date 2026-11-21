// On Stop, if the working tree differs from HEAD, run lint, typecheck and test
// (only related files where a command uses `{files}`) and block with the
// failure so the agent fixes it. A per-session attempt counter bounds the loop.
//
// This module is the only reader and writer of <root>/.harness/state/verify-gate.json:
//   { fingerprint: string | null, attempts: { [sessionId]: number } }
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles } from "../../lib/git.mjs";
import { runStage, tail } from "../../lib/verify.mjs";

const GATE_STAGES = ["lint", "typecheck", "test"];
const STATE_DIR = join(".harness", "state");
const STATE_FILE = "verify-gate.json";
const OUTPUT_TAIL = 8 * 1024;
// Forget attempt counts of old sessions so the state file stays small.
const MAX_SESSIONS = 20;

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function verifyGate(input, config, { log = logStderr } = {}) {
  if (!config.stopGate.enabled) return { kind: "allow" };
  const stages = GATE_STAGES.filter((s) => config.verify[s]);
  if (stages.length === 0) return { kind: "allow" };

  let changed;
  try {
    changed = listChanges(config.root);
  } catch (err) {
    log(`verify-gate: could not list changed files in ${config.root} (${firstLine(err)}); allowing stop`);
    return { kind: "allow" };
  }
  if (changed.length === 0) return { kind: "allow" };

  const state = readState(config.root);
  if (state.fingerprint && state.fingerprint === fingerprint(config, changed)) return { kind: "allow" };

  const session = typeof input.session_id === "string" && input.session_id ? input.session_id : "unknown";
  const attempts = state.attempts[session] ?? 0;
  if (attempts >= config.stopGate.maxAttempts) {
    // Give up for this turn and reset, so the next turn gets a fresh budget.
    log(`verify-gate: gave up after ${attempts} attempts; allowing stop with checks still failing`);
    delete state.attempts[session];
    writeState(config.root, state, log);
    return { kind: "allow" };
  }

  // Harness files (.harness/config.json, progress.md, plans) are never source for lint or tests.
  const files = changed.filter((f) => !f.deleted && !f.path.startsWith(".harness/")).map((f) => f.path);
  for (const stage of stages) {
    const result = await runStage(stage, config, files);
    if (result.ok) continue;
    state.attempts[session] = attempts + 1;
    writeState(config.root, state, log);
    return { kind: "block", reason: blockReason(stage, result, config, attempts + 1) };
  }

  // Fingerprint after the run, so files the checks themselves touch don't force a re-run.
  try {
    state.fingerprint = fingerprint(config, listChanges(config.root));
  } catch {
    state.fingerprint = null;
  }
  delete state.attempts[session];
  writeState(config.root, state, log);
  return { kind: "allow" };
}

function listChanges(root) {
  // Our own state never counts as a change, even if its .gitignore was removed.
  return changedFiles(root).filter((f) => !f.path.startsWith(".harness/state/"));
}

/** Hash of the changed paths with their mtime and size, plus the commands that check them. */
function fingerprint(config, changed) {
  const h = createHash("sha256");
  h.update(JSON.stringify(GATE_STAGES.map((s) => config.verify[s] ?? "")));
  for (const { path } of changed) {
    let meta = "missing";
    try {
      const st = statSync(join(config.root, path));
      meta = `${st.mtimeMs}:${st.size}`;
    } catch {
      // Deleted: the path alone is enough.
    }
    h.update(`\0${path}\0${meta}`);
  }
  return h.digest("hex");
}

function blockReason(stage, result, config, attempt) {
  const why = result.timedOut
    ? `timed out after ${config.stopGate.timeoutSec}s (stopGate.timeoutSec)`
    : result.exitCode === null
      ? "could not run"
      : `exited with code ${result.exitCode}`;
  const output = tail(result.output, OUTPUT_TAIL) || "(no output)";
  return [
    `Verify gate: the ${stage} stage failed; it ${why}.`,
    `Command: ${result.command}`,
    `Output (last ${OUTPUT_TAIL / 1024} KB):`,
    output,
    "",
    `Fix the failure, then finish again: the gate will re-run lint, typecheck and test on the changed files. ` +
      `(Attempt ${attempt} of ${config.stopGate.maxAttempts}.)`,
  ].join("\n");
}

function readState(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, STATE_DIR, STATE_FILE), "utf8"));
    const attempts = raw?.attempts && typeof raw.attempts === "object" && !Array.isArray(raw.attempts) ? raw.attempts : {};
    return {
      fingerprint: typeof raw?.fingerprint === "string" ? raw.fingerprint : null,
      attempts: Object.fromEntries(Object.entries(attempts).filter(([, n]) => Number.isInteger(n) && n > 0)),
    };
  } catch {
    return { fingerprint: null, attempts: {} };
  }
}

function writeState(root, state, log) {
  try {
    const dir = join(root, STATE_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      // Keep harness state out of the consumer's commits.
      writeFileSync(join(dir, ".gitignore"), "*\n");
    }
    const keys = Object.keys(state.attempts);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete state.attempts[k];
    const file = join(dir, STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (err) {
    log(`verify-gate: could not save state (${firstLine(err)})`);
  }
}

function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

function logStderr(msg) {
  process.stderr.write(`[harness] ${msg}\n`);
}
