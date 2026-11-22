// Public surface of the harness runtime: runHook.
// Config loading, policy dispatch and translation to Claude Code's hook
// protocol all live here, so policies only ever return a Verdict.
import { ConfigError, defaultConfig, loadConfig } from "./config.mjs";
import { recordMetric } from "./metrics.mjs";
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
 * any "block" wins and "context" strings (for the agent) are concatenated.
 * "notice" strings are for the user: they become the top-level systemMessage
 * on every event, joined, alongside any block or context.
 * Any verdict may also carry `metrics`: plain data about what the policy did
 * (verdict, rule id, stage results, ...). It never affects the output; `runHook`
 * hands it to lib/metrics.mjs, the only writer, which keeps just the fields
 * its schema knows. A `metrics` that isn't a plain object is ignored.
 * @typedef {{ metrics?: Record<string, unknown> }} WithMetrics
 * @typedef {({ kind: "allow" } | { kind: "block", reason: string } | { kind: "context", text: string } | { kind: "notice", text: string }) & WithMetrics} Verdict
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
        const verdict = normalize(await policy(input ?? {}, config), policy);
        record(event, policy, verdict, input, config, log);
        return verdict;
      } catch (err) {
        // Fail open: a harness bug must never brick the session.
        log(`policy ${policy.name || "<anonymous>"} failed on ${event}: ${err?.message ?? err}`);
        return { kind: "allow" };
      }
    }),
  );
  return { exitCode: 0, output: mergeVerdicts(event, verdicts) };
}

/** Hand a verdict's metrics to lib/metrics.mjs. Never throws: a metrics failure can't change a verdict. */
function record(event, policy, verdict, input, config, log) {
  try {
    const { metrics } = verdict;
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return;
    const session = typeof input?.session_id === "string" ? input.session_id : null;
    // The policy's id is its function name in kebab case: guardBash -> guard-bash.
    const id = (policy.name ?? "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    recordMetric(config.root, { ...metrics, session, event, policy: id }, { log });
  } catch (err) {
    log(`metrics: ${err?.message ?? err}`);
  }
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
  if (kind === "notice" && typeof verdict.text === "string" && verdict.text.trim() !== "") return verdict;
  throw new Error(`${policy.name || "policy"} returned an invalid verdict: ${JSON.stringify(verdict)}`);
}

/** @param {HookEvent} event @param {Verdict[]} verdicts @returns {object} */
function mergeVerdicts(event, verdicts) {
  const out = eventOutput(event, verdicts);
  // systemMessage is one of the common output fields: Claude Code shows it to
  // the user, not the model, next to whatever the event-specific fields do.
  const notices = verdicts.filter((v) => v.kind === "notice").map((v) => v.text.trim());
  if (notices.length) out.systemMessage = cap(notices.join("\n"), MAX_NOTICE);
  return out;
}

/** The event-specific fields, which the agent sees: blocks and context. */
function eventOutput(event, verdicts) {
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
      // Only blocking (with a reason the agent sees) means anything here: Stop's
      // additionalContext would continue the turn, so context is dropped.
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
// Notices are status lines for a person. Claude Code shows long hook strings
// as a 2,000-character preview, so stay well inside that.
const MAX_NOTICE = 1000;
const TRUNCATED = "…[truncated]";

function cap(text, max = MAX_TEXT) {
  return text.length > max ? text.slice(0, max - TRUNCATED.length) + TRUNCATED : text;
}

function logStderr(msg) {
  process.stderr.write(`[harness] ${msg}\n`);
}
