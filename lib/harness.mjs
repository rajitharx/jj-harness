// Public surface of the harness runtime: one function.
// Everything else (config loading, policy registry, result merging) is private.
import { loadConfig } from "./config.mjs";
import { POLICIES } from "../hooks/policies/index.mjs";

/**
 * @typedef {"SessionStart"|"PreToolUse"|"PostToolUse"|"Stop"} HookEvent
 * @typedef {{ exitCode: 0 | 2, output?: object }} HookResult
 *
 * A policy receives the parsed hook input plus the project's resolved config
 * and returns a Verdict. Verdicts from every policy for an event are merged:
 * any "block" wins, "context" strings are concatenated.
 * @typedef {{ kind: "allow" } | { kind: "block", reason: string } | { kind: "context", text: string }} Verdict
 */

/** @param {HookEvent} event @param {object} input @returns {Promise<HookResult>} */
export async function runHook(event, input) {
  // pseudocode:
  //   config = loadConfig(input.cwd)
  //   verdicts = await Promise.all(POLICIES[event].map(p => p(input, config)))
  //   return mergeVerdicts(event, verdicts)   // fail-open on policy crash, log to stderr
  throw new Error("not implemented");
}

/** @param {HookEvent} event @param {Verdict[]} verdicts @returns {HookResult} */
function mergeVerdicts(event, verdicts) {
  throw new Error("not implemented");
}
