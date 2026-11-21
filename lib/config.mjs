// Owns the project config: .harness/config.json in the consumer repo.
// Only this module knows the file location, defaults and schema.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * @typedef {object} HarnessConfig
 * @property {string} root  Project root: nearest ancestor of cwd holding .harness/ or .git.
 * @property {{ format?: string, lint?: string, typecheck?: string, test?: string }} verify
 *   Shell commands per check. Missing or empty = skipped. A command may contain `{files}`,
 *   which lib/verify.mjs replaces with the changed files (see runStage).
 * @property {string[]} protectedPaths  Globs agents may not edit. Project entries extend the defaults.
 * @property {string[]} blockedCommands Regexes for Bash commands that are always denied.
 * @property {{ enabled: boolean, maxAttempts: number, timeoutSec: number }} stopGate
 *   Re-run verify before the agent stops. maxAttempts bounds consecutive blocks per session;
 *   timeoutSec bounds each stage.
 * @property {number} formatTimeoutSec  Time limit for verify.format after each edit.
 */

export const CONFIG_PATH = join(".harness", "config.json");

const VERIFY_KEYS = ["format", "lint", "typecheck", "test"];
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
      if (typeof v !== "string") fail(`verify.${k} must be a string`);
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

function merge(root, raw) {
  const verify = Object.fromEntries(
    Object.entries(raw.verify ?? {}).filter(([, cmd]) => cmd.trim() !== ""),
  );
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
