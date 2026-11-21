// The one list of policies per event. A test asserts hooks/hooks.json
// declares exactly the events that appear here.
import { guardBash } from "./guard-bash.mjs";
import { guardPaths } from "./guard-paths.mjs";
import { formatOnEdit } from "./format-on-edit.mjs";
import { verifyGate } from "./verify-gate.mjs";
import { sessionContext } from "./session-context.mjs";

export const POLICIES = {
  SessionStart: [sessionContext],
  PreToolUse: [guardBash, guardPaths],
  PostToolUse: [formatOnEdit],
  Stop: [verifyGate],
};
