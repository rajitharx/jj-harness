// The one way to run a `config.verify.*` command, used by format-on-edit and
// verify-gate (and the CLI's verify). It owns the `{files}`/`{dirs}`
// placeholders and per-command file filters: substitution, quoting and
// skipping when there is nothing to check.
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { matchGlob } from "./glob.mjs";

export const FILES_PLACEHOLDER = "{files}";
export const DIRS_PLACEHOLDER = "{dirs}";
/** The checks the Stop gate and the CLI's verify run, in order (format runs per edit). */
export const CHECK_STAGES = Object.freeze(["lint", "typecheck", "test"]);

// Keep only the tail of a command's output in memory; callers trim further.
const MAX_OUTPUT = 64 * 1024;
// After a timeout kill, stop waiting for stdio to close (a grandchild that
// left the process group could hold the pipes open forever).
const KILL_GRACE_MS = 2_000;

/**
 * @typedef {object} StageResult
 * @property {boolean} ok        True when the stage passed or was skipped.
 * @property {boolean} skipped   True when nothing ran: no command configured, or no (matching) files.
 * @property {string} output     Combined stdout and stderr (tail only).
 * @property {string} [command]  The exact shell command that ran.
 * @property {number|null} [exitCode]
 * @property {boolean} [timedOut]
 */

/**
 * Quote a path for a POSIX shell. Plain paths are left alone so commands stay readable.
 * @param {string} s
 */
export function shellQuote(s) {
  if (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a root-relative path into one shell word that can't be read as an
 * option: a leading `-` gets `./` in front (quoting alone can't stop `-rf`
 * or `--config=evil.js` from being parsed as flags), then it is quoted.
 * @param {string} path
 */
export function pathArg(path) {
  return shellQuote(path.startsWith("-") ? `./${path}` : path);
}

/**
 * Build the shell command for a stage, or null when the stage should be skipped.
 * - `entry.files` (globs) first narrows `files` to the matching paths.
 * - `{files}` is replaced by the quoted, root-relative paths; `{dirs}` by their
 *   unique parent directories (`.` or `./dir`). Either with no paths means skip.
 * - `format` without a placeholder gets the paths appended, because formatters take paths.
 * - Any other command without a placeholder runs as written, unless it has a
 *   `files` filter that no path matches (then it is skipped).
 * @param {string} name  Stage name (format, lint, typecheck, test).
 * @param {import("./config.mjs").VerifyCommand|undefined} entry
 * @param {string[]} files
 * @returns {string|null}
 */
export function buildCommand(name, entry, files) {
  const command = entry?.run;
  if (typeof command !== "string" || command.trim() === "") return null;
  const matched = entry.files ? files.filter((f) => matchGlob(f, entry.files) !== undefined) : files;
  const usesFiles = command.includes(FILES_PLACEHOLDER);
  const usesDirs = command.includes(DIRS_PLACEHOLDER);
  if (usesFiles || usesDirs) {
    if (matched.length === 0) return null;
    const quoted = matched.map(pathArg).join(" ");
    const dirs = [...new Set(matched.map(dirArg))].map(shellQuote).join(" ");
    // One pass, so a file name containing "{dirs}" is never substituted again.
    return command.replace(/\{files\}|\{dirs\}/g, (m) => (m === FILES_PLACEHOLDER ? quoted : dirs));
  }
  if (name === "format") return matched.length ? `${command} ${matched.map(pathArg).join(" ")}` : null;
  if (entry.files && matched.length === 0) return null;
  return command;
}

/** Parent directory of a root-relative path, as `.` or `./dir` (never read as an option). */
function dirArg(path) {
  const dir = posix.dirname(path);
  return dir === "." ? "." : `./${dir}`;
}

/**
 * The paths that verify stages check, from changedFiles in lib/git: deleted
 * files are gone, and harness files (.harness/config.json, progress.md, plans)
 * are never lint or test input. Shared by verify-gate and the CLI's verify.
 * @param {{ path: string, deleted: boolean }[]} changed
 * @returns {string[]}
 */
export function stageFiles(changed) {
  return changed.filter((f) => !f.deleted && !f.path.startsWith(".harness/")).map((f) => f.path);
}

/**
 * Run `config.verify[name]` through the shell in `config.root`, with CI=1.
 * Never throws: spawn errors and timeouts come back as failures.
 * @param {string} name
 * @param {import("./config.mjs").HarnessConfig} config
 * @param {string[]} files  Root-relative paths of changed (non-deleted) files.
 * @param {{ timeoutMs?: number }} [options]  Defaults to config.formatTimeoutSec for
 *   `format` and config.stopGate.timeoutSec for the other stages.
 * @returns {Promise<StageResult>}
 */
export function runStage(name, config, files, { timeoutMs } = {}) {
  const command = buildCommand(name, config.verify?.[name], files);
  if (command === null) return Promise.resolve({ ok: true, skipped: true, output: "" });
  const limit = timeoutMs ?? (name === "format" ? config.formatTimeoutSec : config.stopGate.timeoutSec) * 1000;

  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let done = false;
    let timer;
    let grace;
    let child;
    const finish = (result) => {
      if (done) return;
      done = true;
      untrack(child);
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ skipped: false, command, output, ...result });
    };
    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };

    try {
      child = spawn(command, {
        cwd: config.root,
        shell: true,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group on POSIX, so a timeout kills the whole tree.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({ ok: false, exitCode: null, output: `could not start: ${err.message}` });
      return;
    }
    track(child);
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    child.on("error", (err) => {
      append(`\n${err.message}\n`);
      finish({ ok: false, exitCode: null });
    });
    child.on("close", (code) => {
      if (timedOut) finish({ ok: false, exitCode: null, timedOut: true });
      else finish({ ok: code === 0, exitCode: code });
    });

    timer = setTimeout(() => {
      timedOut = true;
      kill(child);
      grace = setTimeout(() => finish({ ok: false, exitCode: null, timedOut: true }), KILL_GRACE_MS);
    }, limit);
  });
}

// Children still running. Stages run in their own process group, so if the
// hook process is told to stop, take them down with it instead of orphaning them.
const active = new Set();
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

function track(child) {
  if (active.size === 0) for (const sig of SIGNALS) process.on(sig, onSignal);
  active.add(child);
}

function untrack(child) {
  if (!child || !active.delete(child) || active.size > 0) return;
  for (const sig of SIGNALS) process.off(sig, onSignal);
}

function onSignal(sig) {
  for (const child of active) kill(child);
  active.clear();
  for (const s of SIGNALS) process.off(s, onSignal);
  // Re-raise with the default handler so the process still dies of the signal.
  process.kill(process.pid, sig);
}

function kill(child) {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Last `max` characters of `text`, marked when cut. */
export function tail(text, max) {
  const t = text.trimEnd();
  return t.length > max ? `…[earlier output cut]\n${t.slice(-max)}` : t;
}
