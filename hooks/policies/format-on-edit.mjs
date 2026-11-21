// After an edit, run config.verify.format on the touched file; never blocks.
/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function formatOnEdit(input, config) {
  throw new Error("not implemented");
}
