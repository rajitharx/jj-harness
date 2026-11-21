// Owns the project config: .harness/config.json in the consumer repo.
// Only this module knows the file location, defaults and schema.

/**
 * @typedef {object} HarnessConfig
 * @property {{ format?: string, lint?: string, typecheck?: string, test?: string }} verify
 *   Shell commands per check. Missing = skipped.
 * @property {string[]} protectedPaths  Globs agents may not edit (defaults: .env*, secrets, lockfiles).
 * @property {string[]} blockedCommands Regexes for Bash commands that are always denied.
 * @property {{ enabled: boolean, maxAttempts: number }} stopGate  Re-run verify before the agent stops.
 */

/** @param {string} cwd @returns {HarnessConfig} */
export function loadConfig(cwd) {
  // pseudocode:
  //   find repo root from cwd; read .harness/config.json if present
  //   deep-merge over DEFAULTS; validate shape; return frozen object
  throw new Error("not implemented");
}
