// The one way to run a `config.verify.*` command, used by format-on-edit and
// verify-gate (and the CLI's verify). It owns the `{files}`/`{dirs}`
// placeholders and per-command file filters: substitution, quoting and
// skipping when there is nothing to check.
import { spawn } from "node:child_process";
import { join, posix } from "node:path";
import { stageEntries } from "./config.mjs";
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
 * @property {number} [fileCount]  How many files the command was given (the paths matching its
 *   `files` filter), set only when it ran with `{files}`/`{dirs}` or a formatter's appended paths.
 *   Absent for a whole-project command and for a skipped stage.
 * @property {string} output     Combined stdout and stderr (tail only).
 * @property {string} [command]  The exact shell command that ran.
 * @property {string[]} [commands]  Every command that ran, as `describeRun` shows it (a failure is the last).
 * @property {string} [cwd]      The entry's `cwd` (root-relative), when the command ran in a package directory.
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
 * - With `entry.cwd`, only paths below that directory count, as paths relative to
 *   it (so the `files` globs, `{files}` and `{dirs}` all are), and nothing below
 *   it means skip, even for a command with no placeholder or filter.
 * @param {string} name  Stage name (format, lint, typecheck, test).
 * @param {import("./config.mjs").VerifyCommand|undefined} entry
 * @param {string[]} files
 * @returns {string|null}
 */
export function buildCommand(name, entry, files) {
  return planStage(name, entry, files)?.command ?? null;
}

/**
 * Like buildCommand, but also says how many files the command was given:
 * `fileCount` is set when paths are passed to it, and absent for a command
 * that runs as written (whole-project). Null when the stage is skipped.
 * @param {string} name
 * @param {import("./config.mjs").VerifyCommand|undefined} entry
 * @param {string[]} files
 * @returns {{ command: string, fileCount?: number, cwd?: string }|null}
 */
export function planStage(name, entry, files) {
  const plan = planEntry(name, entry, files);
  return plan && entry.cwd ? { ...plan, cwd: entry.cwd } : plan;
}

function planEntry(name, entry, files) {
  const command = entry?.run;
  if (typeof command !== "string" || command.trim() === "") return null;
  let scoped = files;
  if (entry.cwd) {
    const prefix = `${entry.cwd}/`;
    scoped = files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    if (scoped.length === 0) return null;
  }
  const matched = entry.files ? scoped.filter((f) => matchGlob(f, entry.files) !== undefined) : scoped;
  const usesFiles = command.includes(FILES_PLACEHOLDER);
  const usesDirs = command.includes(DIRS_PLACEHOLDER);
  if (usesFiles || usesDirs) {
    if (matched.length === 0) return null;
    const quoted = matched.map(pathArg).join(" ");
    const dirs = [...new Set(matched.map(dirArg))].map(shellQuote).join(" ");
    // One pass, so a file name containing "{dirs}" is never substituted again.
    const built = command.replace(/\{files\}|\{dirs\}/g, (m) => (m === FILES_PLACEHOLDER ? quoted : dirs));
    return { command: built, fileCount: matched.length };
  }
  if (name === "format") {
    return matched.length ? { command: `${command} ${matched.map(pathArg).join(" ")}`, fileCount: matched.length } : null;
  }
  if (entry.files && matched.length === 0) return null;
  return { command };
}

/** A ran command for people: `(in apps/web) npx tsc --noEmit`, or the bare command at the root. */
export function describeRun({ command, cwd }) {
  return cwd ? `(in ${cwd}) ${command}` : command;
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
 * Run `config.verify[name]` through the shell in `config.root` (or in each entry's
 * `cwd`), with CI=1. A stage with several entries runs them in order and stops at
 * the first failure; its time limit covers all of them, and the result is the
 * failing entry's, or a pass whose `fileCount` sums the entries that ran.
 * Never throws: spawn errors and timeouts come back as failures.
 * @param {string} name
 * @param {import("./config.mjs").HarnessConfig} config
 * @param {string[]} files  Root-relative paths of changed (non-deleted) files.
 * @param {{ timeoutMs?: number }} [options]  Defaults to config.formatTimeoutSec for
 *   `format` and config.stopGate.timeoutSec for the other stages.
 * @returns {Promise<StageResult>}
 */
export async function runStage(name, config, files, { timeoutMs } = {}) {
  const limit = timeoutMs ?? (name === "format" ? config.formatTimeoutSec : config.stopGate.timeoutSec) * 1000;
  const deadline = Date.now() + limit;
  /** @type {StageResult} */
  let total = { ok: true, skipped: true, output: "" };
  for (const entry of stageEntries(config.verify?.[name])) {
    const plan = planStage(name, entry, files);
    if (plan === null) continue;
    const left = deadline - Date.now();
    if (left <= 0) {
      return { ok: false, skipped: false, command: plan.command, ...(plan.cwd ? { cwd: plan.cwd } : {}), exitCode: null, timedOut: true, output: "" };
    }
    const result = await runCommand(plan, config.root, left);
    if (!result.ok) return { ...result, commands: [...(total.commands ?? []), describeRun(result)] };
    total = {
      ...result,
      commands: [...(total.commands ?? []), describeRun(result)],
      ...(plan.fileCount === undefined && total.fileCount === undefined ? {} : { fileCount: (total.fileCount ?? 0) + (plan.fileCount ?? 0) }),
    };
  }
  return total;
}

/** Run one planned command; resolves with its StageResult, never rejects. */
function runCommand({ command, fileCount, cwd }, root, limit) {
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
      resolve({
        skipped: false,
        command,
        ...(cwd ? { cwd } : {}),
        ...(fileCount === undefined ? {} : { fileCount }),
        output,
        ...result,
      });
    };
    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };

    try {
      child = spawn(command, {
        cwd: cwd ? join(root, cwd) : root,
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
