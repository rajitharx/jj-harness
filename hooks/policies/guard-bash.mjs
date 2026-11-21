// Deny destructive or irreversible shell commands (rm -rf /, force push to main, curl | sh, DROP DATABASE...) plus config.blockedCommands.
/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function guardBash(input, config) {
  throw new Error("not implemented");
}
