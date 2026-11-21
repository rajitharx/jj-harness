// On Stop, if the working tree differs from HEAD, run lint, typecheck and test
// (only related files where a command uses `{files}`) and block with the
// failure so the agent fixes it. A per-session attempt counter bounds the loop.
// Whenever it lets the stop through after looking at changes, it tells the
// user what happened with a notice: which checks passed or were skipped, or
// why it allowed the stop with checks unfinished. The agent's last message is
// written before Stop fires, so only the user can be told.
//
// This module is the only reader and writer of <root>/.harness/state/verify-gate.json:
//   { fingerprint: string | null, attempts: { [sessionId]: number } }
// If that file can't be read or written, the gate allows rather than risk an
// unbounded block loop.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles } from "../../lib/git.mjs";
import { CHECK_STAGES, runStage, stageFiles, tail } from "../../lib/verify.mjs";

const GATE_STAGES = CHECK_STAGES;
const STATE_DIR = join(".harness", "state");
const STATE_FILE = "verify-gate.json";
const OUTPUT_TAIL = 8 * 1024;
// Forget attempt counts of old sessions so the state file stays small.
const MAX_SESSIONS = 20;
// Overall budget for one Stop, kept below the Stop hook's 900 s timeout in
// hooks/hooks.json: each stage gets min(stopGate.timeoutSec, what's left), so
// Claude Code never has to kill the hook (which would orphan the stage).
const GATE_DEADLINE_MS = 840_000;

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function verifyGate(input, config, { log = logStderr, deadlineMs = GATE_DEADLINE_MS } = {}) {
  const deadline = Date.now() + deadlineMs;
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
  // Silent: the run that saved this fingerprint already sent its notice, and
  // repeating it on every turn with no new changes would be noise.
  if (state.fingerprint && state.fingerprint === fingerprint(config, changed)) return { kind: "allow" };

  // Backstop for the loop guard: if the counter can't be read back, it can't
  // bound a continuation chain, so don't block one.
  if (!state.readable && input.stop_hook_active === true) {
    log("verify-gate: attempt counter is unreadable and this is a continuation; allowing stop");
    return notice(`checks not run: the attempt counter in ${STATE_DIR}/${STATE_FILE} is unreadable, so the gate allowed this stop.`);
  }

  const session = typeof input.session_id === "string" && input.session_id ? input.session_id : "unknown";
  const attempts = state.attempts[session] ?? 0;
  if (attempts >= config.stopGate.maxAttempts) {
    // Give up for this turn and reset, so the next turn gets a fresh budget.
    log(`verify-gate: gave up after ${attempts} attempts; allowing stop with checks still failing`);
    delete state.attempts[session];
    writeState(config.root, state, log);
    return notice(
      `gave up after ${attempts} blocked stops (stopGate.maxAttempts); allowed this stop with checks still failing.`,
    );
  }

  const files = stageFiles(changed);
  /** @type {[string, "passed" | "skipped", number | undefined][]} */
  const done = [];
  for (const stage of stages) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return deadlinePassed(stage, done, log);
    const result = await runStage(stage, config, files, {
      timeoutMs: Math.min(config.stopGate.timeoutSec * 1000, remaining),
    });
    if (result.ok) {
      done.push([stage, result.skipped ? "skipped" : "passed", result.fileCount]);
      continue;
    }
    if (result.timedOut && Date.now() >= deadline) return deadlinePassed(stage, done, log);
    state.attempts[session] = attempts + 1;
    // Fail open: a block whose count can't be saved would never reach maxAttempts.
    if (!writeState(config.root, state, log)) {
      log(`verify-gate: the ${stage} stage failed, but the attempt counter could not be saved; allowing stop`);
      return notice(
        `the ${stage} check failed, but the attempt counter in ${STATE_DIR} could not be saved, ` +
          "so the gate allowed this stop rather than risk an endless loop.",
      );
    }
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
  return passNotice(done);
}

/** @returns {import("../../lib/harness.mjs").Verdict} */
function notice(text) {
  return { kind: "notice", text: `harness: ${text}` };
}

/**
 * One mark per stage: `lint ✓ (1 file)`, `typecheck ✓`, `test skipped`. The count
 * is what the stage's command was given (after its `files` filter), so it is
 * shown only for stages that got paths; a whole-project stage has none.
 */
function stageSummary(done) {
  return done
    .map(([stage, outcome, count]) => {
      if (outcome !== "passed") return `${stage} skipped`;
      return count === undefined ? `${stage} ✓` : `${stage} ✓ (${count} file${count === 1 ? "" : "s"})`;
    })
    .join(" ");
}

/** `harness: lint ✓ (1 file) typecheck ✓ test ✓ (1 file)`, but never a pass when every stage was skipped. */
function passNotice(done) {
  const summary = stageSummary(done);
  if (!done.some(([, outcome]) => outcome === "passed")) return notice(`no checks ran (${summary})`);
  return notice(summary);
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

/**
 * Read the state file. `readable` is false when a file exists but can't be
 * read or parsed (so its attempt counts are unknown); a missing file is a
 * fresh, readable state.
 */
function readState(root) {
  const empty = (readable) => ({ readable, fingerprint: null, attempts: {} });
  let text;
  try {
    text = readFileSync(join(root, STATE_DIR, STATE_FILE), "utf8");
  } catch (err) {
    return empty(err?.code === "ENOENT");
  }
  try {
    const raw = JSON.parse(text);
    const attempts = raw?.attempts && typeof raw.attempts === "object" && !Array.isArray(raw.attempts) ? raw.attempts : {};
    return {
      readable: true,
      fingerprint: typeof raw?.fingerprint === "string" ? raw.fingerprint : null,
      attempts: Object.fromEntries(Object.entries(attempts).filter(([, n]) => Number.isInteger(n) && n > 0)),
    };
  } catch {
    return empty(false);
  }
}

/** Save the state atomically. Returns false (after logging) when it can't be saved. */
function writeState(root, state, log) {
  const dir = join(root, STATE_DIR);
  const file = join(dir, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    // Keep harness state out of the consumer's commits, even if the directory already existed.
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    const keys = Object.keys(state.attempts);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete state.attempts[k];
    const { fingerprint, attempts } = state;
    writeFileSync(tmp, JSON.stringify({ fingerprint, attempts }, null, 2) + "\n");
    renameSync(tmp, file);
    return true;
  } catch (err) {
    log(`verify-gate: could not save state (${firstLine(err)})`);
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing to clean up.
    }
    return false;
  }
}

/** Fail open once the overall deadline is gone, so Claude Code never has to kill the hook. */
function deadlinePassed(stage, done, log) {
  log(`verify-gate: ran out of time (overall gate deadline) during or before the ${stage} stage; allowing stop`);
  const before = done.length ? ` after ${stageSummary(done)}` : "";
  return notice(`ran out of time at the ${stage} check${before}; allowed this stop with the remaining checks unfinished.`);
}

function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

function logStderr(msg) {
  process.stderr.write(`[harness] ${msg}\n`);
}
