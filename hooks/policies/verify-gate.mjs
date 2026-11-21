// On Stop, if the working tree changed this session, run lint/typecheck/test; block with the failure output so the agent fixes it. Respect stop_hook_active and stopGate.maxAttempts to avoid loops.
/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function verifyGate(input, config) {
  throw new Error("not implemented");
}
