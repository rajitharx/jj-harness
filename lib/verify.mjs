// The one way to run a `config.verify.*` command, used by format-on-edit and
// verify-gate. It owns the `{files}` placeholder: substitution, quoting and
// skipping when there is nothing to check.
import { spawn } from "node:child_process";

export const FILES_PLACEHOLDER = "{files}";

// Keep only the tail of a command's output in memory; callers trim further.
const MAX_OUTPUT = 64 * 1024;
// After a timeout kill, stop waiting for stdio to close (a grandchild that
// left the process group could hold the pipes open forever).
const KILL_GRACE_MS = 2_000;

/**
 * @typedef {object} StageResult
 * @property {boolean} ok        True when the stage passed or was skipped.
 * @property {boolean} skipped   True when nothing ran: no command configured, or `{files}` with no files.
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
 * Build the shell command for a stage, or null when the stage should be skipped.
 * - `{files}` is replaced by the quoted, root-relative paths; no files means skip.
 * - `format` without `{files}` gets the paths appended, because formatters take paths.
 * - Any other command without `{files}` runs as written.
 * @param {string} name  Stage name (format, lint, typecheck, test).
 * @param {string|undefined} command
 * @param {string[]} files
 * @returns {string|null}
 */
export function buildCommand(name, command, files) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const quoted = files.map(shellQuote).join(" ");
  if (command.includes(FILES_PLACEHOLDER)) {
    return files.length ? command.split(FILES_PLACEHOLDER).join(quoted) : null;
  }
  if (name === "format") return files.length ? `${command} ${quoted}` : null;
  return command;
}

/**
 * Run `config.verify[name]` through the shell in `config.root`, with CI=1.
 * Never throws: spawn errors and timeouts come back as failures.
 * @param {string} name
 * @param {import("./config.mjs").HarnessConfig} config
 * @param {string[]} files  Root-relative paths of changed (non-deleted) files.
 * @param {{ timeoutMs?: number }} [options]  Defaults to config.stopGate.timeoutSec.
 * @returns {Promise<StageResult>}
 */
export function runStage(name, config, files, { timeoutMs } = {}) {
  const command = buildCommand(name, config.verify?.[name], files);
  if (command === null) return Promise.resolve({ ok: true, skipped: true, output: "" });
  const limit = timeoutMs ?? (config.stopGate?.timeoutSec ?? 300) * 1000;

  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let done = false;
    let timer;
    let grace;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ skipped: false, command, output, ...result });
    };
    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };

    let child;
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
