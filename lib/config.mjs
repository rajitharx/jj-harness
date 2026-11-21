// Owns the project config: .harness/config.json in the consumer repo.
// Only this module knows the file location, defaults and schema.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * @typedef {object} HarnessConfig
 * @property {string} root  Project root: nearest ancestor of cwd holding .harness/ or .git.
 * @property {{ format?: VerifyCommand, lint?: VerifyCommand, typecheck?: VerifyCommand, test?: VerifyCommand }} verify
 *   One command per check. Missing or empty = skipped. In the file each entry is a string
 *   or `{ run, files }`; here it is always normalized to a VerifyCommand.
 * @property {string[]} protectedPaths  Globs agents may not edit. Project entries extend the defaults.
 * @property {string[]} blockedCommands Regexes for Bash commands that are always denied.
 * @property {{ enabled: boolean, maxAttempts: number, timeoutSec: number }} stopGate
 *   Re-run verify before the agent stops. maxAttempts bounds consecutive blocks per session;
 *   timeoutSec bounds each stage.
 * @property {number} formatTimeoutSec  Time limit for verify.format after each edit.
 */

/**
 * @typedef {object} VerifyCommand
 * @property {string} run  Shell command. May contain `{files}` and `{dirs}`, which
 *   lib/verify.mjs replaces with the changed files / their directories (see runStage).
 * @property {string[]} [files]  Globs. Only changed files matching one of them reach
 *   the command; a stage with a filter and no matching changed file is skipped.
 * @property {string} [cwd]  A directory under the project root (POSIX, no `..`). The command
 *   runs there and only sees changed files below it: `files` globs, `{files}` and `{dirs}` are
 *   relative to it, and the stage is skipped when nothing below it changed. This is how a
 *   monorepo package gets its own commands.
 */

/**
 * The entries of one verify stage: a stage holds one command, or an array of
 * them (one per package), normalized by `merge` to `VerifyCommand | VerifyCommand[]`.
 * @param {VerifyCommand | VerifyCommand[] | undefined} stage
 * @returns {VerifyCommand[]}
 */
export function stageEntries(stage) {
  return stage === undefined ? [] : Array.isArray(stage) ? stage : [stage];
}

export const CONFIG_PATH = join(".harness", "config.json");
/** Session notes appended by the handoff skill; session-context shows the tail. */
export const PROGRESS_PATH = join(".harness", "progress.md");

const VERIFY_KEYS = ["format", "lint", "typecheck", "test"];
const VERIFY_ENTRY_KEYS = ["run", "files", "cwd"];
const STOP_GATE_KEYS = ["enabled", "maxAttempts", "timeoutSec"];

const DEFAULT_PROTECTED_PATHS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  ".git/**",
];

export class ConfigError extends Error {
  name = "ConfigError";
}

/**
 * Resolve the effective config for the project containing `cwd`.
 * Throws ConfigError when the file exists but is malformed, so the caller
 * decides how to degrade.
 * @param {string} cwd
 * @returns {HarnessConfig}
 */
export function loadConfig(cwd) {
  const root = findRoot(resolve(cwd || process.cwd()));
  const file = join(root, CONFIG_PATH);
  const raw = existsSync(file) ? parse(file) : {};
  return deepFreeze(merge(root, validate(raw, file)));
}

/**
 * Check a raw config object (as it would be written to CONFIG_PATH) against the
 * schema. Throws ConfigError naming `label` on the first problem.
 * @param {unknown} raw
 * @param {string} [label]
 */
export function validateConfig(raw, label = CONFIG_PATH) {
  validate(raw, label);
}

/** Defaults for a project root, used when no config exists or it is invalid. */
export function defaultConfig(cwd) {
  return deepFreeze(merge(findRoot(resolve(cwd || process.cwd())), {}));
}

function findRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".harness")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function parse(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: invalid JSON (${err.message})`);
  }
}

function validate(raw, file) {
  const fail = (msg) => {
    throw new ConfigError(`${file}: ${msg}`);
  };
  if (!isObject(raw)) fail("must be a JSON object");

  if (raw.verify !== undefined) {
    if (!isObject(raw.verify)) fail("verify must be an object");
    for (const [k, v] of Object.entries(raw.verify)) {
      if (!VERIFY_KEYS.includes(k)) fail(`verify.${k} is not one of ${VERIFY_KEYS.join(", ")}`);
      if (Array.isArray(v)) {
        if (v.length === 0) fail(`verify.${k} must not be an empty array`);
        v.forEach((entry, i) => validateEntry(`verify.${k}[${i}]`, entry, fail));
      } else validateEntry(`verify.${k}`, v, fail);
    }
  }
  for (const key of ["protectedPaths", "blockedCommands"]) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].some((s) => typeof s !== "string")) {
      fail(`${key} must be an array of strings`);
    }
  }
  for (const pattern of raw.blockedCommands ?? []) {
    try {
      new RegExp(pattern);
    } catch {
      fail(`blockedCommands entry is not a valid regex: ${pattern}`);
    }
  }
  if (raw.formatTimeoutSec !== undefined && !(Number.isInteger(raw.formatTimeoutSec) && raw.formatTimeoutSec >= 1)) {
    fail("formatTimeoutSec must be an integer >= 1");
  }
  if (raw.stopGate !== undefined) {
    const g = raw.stopGate;
    if (!isObject(g)) fail("stopGate must be an object");
    for (const k of Object.keys(g)) {
      if (!STOP_GATE_KEYS.includes(k)) fail(`stopGate.${k} is not one of ${STOP_GATE_KEYS.join(", ")}`);
    }
    if (g.enabled !== undefined && typeof g.enabled !== "boolean") fail("stopGate.enabled must be a boolean");
    if (g.maxAttempts !== undefined && !(Number.isInteger(g.maxAttempts) && g.maxAttempts >= 1)) {
      fail("stopGate.maxAttempts must be an integer >= 1");
    }
    if (g.timeoutSec !== undefined && !(Number.isInteger(g.timeoutSec) && g.timeoutSec >= 1)) {
      fail("stopGate.timeoutSec must be an integer >= 1");
    }
  }
  return raw;
}

/** One verify entry: a string or `{ run, files?, cwd? }`. */
function validateEntry(where, v, fail) {
  if (typeof v === "string") return;
  if (!isObject(v)) fail(`${where} must be a string or { "run": string, "files": [globs], "cwd": directory }`);
  for (const ek of Object.keys(v)) {
    if (!VERIFY_ENTRY_KEYS.includes(ek)) fail(`${where}.${ek} is not one of ${VERIFY_ENTRY_KEYS.join(", ")}`);
  }
  if (typeof v.run !== "string") fail(`${where}.run must be a string`);
  if (
    v.files !== undefined &&
    (!Array.isArray(v.files) || v.files.length === 0 || v.files.some((g) => typeof g !== "string" || g.trim() === ""))
  ) {
    fail(`${where}.files must be a non-empty array of glob strings`);
  }
  if (v.cwd !== undefined && normalizeCwd(v.cwd) === null) {
    fail(`${where}.cwd must be a relative directory inside the project (no "..", not absolute)`);
  }
}

/**
 * `cwd` as a clean POSIX path (`./apps//web/` becomes `apps/web`), `""` for the
 * project root itself, or null when it is not a relative path inside the project.
 */
function normalizeCwd(cwd) {
  if (typeof cwd !== "string" || /^([A-Za-z]:|[\\/])/.test(cwd) || cwd.includes("\\") || cwd.includes("\0")) return null;
  const parts = cwd.split("/").filter((p) => p !== "" && p !== ".");
  return parts.includes("..") ? null : parts.join("/");
}

function normalizeEntry(v) {
  const entry = { run: typeof v === "string" ? v : v.run };
  if (typeof v === "string") return entry;
  if (v.files) entry.files = [...v.files];
  const cwd = v.cwd === undefined ? "" : normalizeCwd(v.cwd);
  if (cwd) entry.cwd = cwd;
  return entry;
}

function merge(root, raw) {
  // One internal shape for every entry, so lib/verify.mjs sees a single form. A stage
  // is one entry, or an array of them when it has several (empty commands are dropped,
  // and a single survivor is unwrapped).
  const verify = {};
  for (const [k, v] of Object.entries(raw.verify ?? {})) {
    const entries = (Array.isArray(v) ? v : [v]).map(normalizeEntry).filter((e) => e.run.trim() !== "");
    if (entries.length === 1) verify[k] = entries[0];
    else if (entries.length > 1) verify[k] = entries;
  }
  return {
    root,
    verify,
    // Extend, never replace: a project config can't silently drop secret protection.
    protectedPaths: [...new Set([...DEFAULT_PROTECTED_PATHS, ...(raw.protectedPaths ?? [])])],
    blockedCommands: [...(raw.blockedCommands ?? [])],
    stopGate: { enabled: true, maxAttempts: 3, timeoutSec: 300, ...(raw.stopGate ?? {}) },
    formatTimeoutSec: raw.formatTimeoutSec ?? 30,
  };
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(obj);
}
