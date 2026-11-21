// Public surface of the harness runtime: runHook.
// Config loading, policy dispatch and translation to Claude Code's hook
// protocol all live here, so policies only ever return a Verdict.
import { ConfigError, defaultConfig, loadConfig } from "./config.mjs";
import { POLICIES } from "../hooks/policies/index.mjs";

/**
 * @typedef {"SessionStart"|"PreToolUse"|"PostToolUse"|"Stop"} HookEvent
 *
 * Always exit 0 and speak JSON: Claude Code only reads stdout JSON on exit 0,
 * and JSON lets us attach reasons and context per event.
 * @typedef {{ exitCode: 0, output: object }} HookResult
 *
 * A policy receives the parsed hook input plus the project's resolved config
 * and returns a Verdict. Verdicts from every policy for an event are merged:
 * any "block" wins, "context" strings are concatenated.
 * @typedef {{ kind: "allow" } | { kind: "block", reason: string } | { kind: "context", text: string }} Verdict
 * @typedef {(input: object, config: import("./config.mjs").HarnessConfig) => Verdict | Promise<Verdict>} Policy
 */

/**
 * @param {HookEvent} event
 * @param {object} input  Parsed hook JSON from stdin.
 * @param {{ policies?: Record<string, Policy[]>, log?: (msg: string) => void }} [options]
 *   Overrides for tests. Production callers pass nothing.
 * @returns {Promise<HookResult>}
 */
export async function runHook(event, input, { policies = POLICIES, log = logStderr } = {}) {
  const list = policies[event];
  if (!list) {
    log(`unknown hook event "${event}", ignoring`);
    return { exitCode: 0, output: {} };
  }

  const config = resolveConfig(input?.cwd, log);
  const verdicts = await Promise.all(
    list.map(async (policy) => {
      try {
        return normalize(await policy(input ?? {}, config), policy);
      } catch (err) {
        // Fail open: a harness bug must never brick the session.
        log(`policy ${policy.name || "<anonymous>"} failed on ${event}: ${err?.message ?? err}`);
        return { kind: "allow" };
      }
    }),
  );
  return { exitCode: 0, output: mergeVerdicts(event, verdicts) };
}

function resolveConfig(cwd, log) {
  try {
    return loadConfig(cwd);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log(`${err.message}; falling back to defaults`);
    return defaultConfig(cwd);
  }
}

function normalize(verdict, policy) {
  const kind = verdict?.kind;
  if (kind === "allow") return verdict;
  if (kind === "block" && typeof verdict.reason === "string" && verdict.reason.trim() !== "") return verdict;
  if (kind === "context" && typeof verdict.text === "string") return verdict;
  throw new Error(`${policy.name || "policy"} returned an invalid verdict: ${JSON.stringify(verdict)}`);
}

/** @param {HookEvent} event @param {Verdict[]} verdicts @returns {object} */
function mergeVerdicts(event, verdicts) {
  const blocks = verdicts.filter((v) => v.kind === "block").map((v) => v.reason);
  const context = verdicts.filter((v) => v.kind === "context").map((v) => v.text);
  const reason = cap(blocks.join("\n"));
  const additionalContext = cap(context.join("\n\n"));

  switch (event) {
    case "PreToolUse":
      if (blocks.length) {
        return {
          hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason },
        };
      }
      return additionalContext ? { hookSpecificOutput: { hookEventName: event, additionalContext } } : {};

    case "PostToolUse": {
      const out = blocks.length ? { decision: "block", reason } : {};
      if (additionalContext) out.hookSpecificOutput = { hookEventName: event, additionalContext };
      return out;
    }

    case "Stop":
      // Stop has no context channel; only blocking (with a reason the agent sees) means anything.
      return blocks.length ? { decision: "block", reason } : {};

    case "SessionStart":
      // A session can't be blocked from starting; surface block reasons as context instead.
      {
        const text = cap([...blocks, ...context].join("\n\n"));
        return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
      }

    default:
      return {};
  }
}

// Keep hook output small: Claude Code feeds it to the model, and huge stdout
// writes are fragile across pipes.
const MAX_TEXT = 16 * 1024;
const TRUNCATED = "…[truncated]";

function cap(text) {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - TRUNCATED.length) + TRUNCATED : text;
}

function logStderr(msg) {
  process.stderr.write(`[harness] ${msg}\n`);
}
