// On SessionStart, inject branch, dirty files, verify commands and the tail of .harness/progress.md as context.
/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function sessionContext(input, config) {
  throw new Error("not implemented");
}
