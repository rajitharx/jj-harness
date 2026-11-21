// Deny Edit/Write to config.protectedPaths (.env, keys, lockfiles, .git/).
/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function guardPaths(input, config) {
  throw new Error("not implemented");
}
