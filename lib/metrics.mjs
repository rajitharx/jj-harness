// Owns the per-project metrics log: .harness/state/metrics.jsonl, one JSON
// object per line. Only this module knows the path, the v1 schema and the
// rotation rule. `runHook` is the only writer (policies hand it a `metrics`
// object on their verdict); `harness stats` is the reader.
//
// Fail open: nothing here throws or writes to stdout. A broken log costs the
// numbers, never a verdict.
//
// Privacy: an entry is rebuilt from a whitelist, so command text, command
// output, file contents, env values and file paths can't be recorded even by
// a buggy caller. Strings are short identifiers (rule ids, stage names,
// outcomes, the session id, a tree hash); anything else is dropped.
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, ensureStateDir } from "./state.mjs";

export const METRICS_FILE = "metrics.jsonl";
export const SCHEMA_VERSION = 1;
/** Rotate when the file is larger than this before an append. */
export const MAX_BYTES = 1024 * 1024;

const ID = /^[\w.:-]{1,80}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const STAGE_RESULTS = ["pass", "fail", "skipped", "timeout"];

/** @typedef {Record<string, unknown>} MetricEntry  A v1 entry as stored: `v`, `ts`, `session`, `event`, `policy`, plus the policy's fields. */

/**
 * Append one entry (adds `v` and `ts`). Returns false when nothing was written.
 * @param {string} root
 * @param {object} entry  Unknown fields are dropped; see `clean`.
 * @param {{ log?: (msg: string) => void, now?: Date }} [options]
 * @returns {boolean}
 */
export function recordMetric(root, entry, { log = logStderr, now = new Date() } = {}) {
  try {
    const clean = cleanEntry(entry);
    if (!clean) return false;
    const dir = ensureStateDir(root);
    const file = join(dir, METRICS_FILE);
    rotate(file);
    appendFileSync(file, `${JSON.stringify({ v: SCHEMA_VERSION, ts: now.toISOString(), ...clean })}\n`);
    return true;
  } catch (err) {
    log(`metrics: could not record (${String(err?.message ?? err).split("\n")[0]})`);
    return false;
  }
}

/**
 * Parsed entries, oldest first. Malformed lines and lines with another `v` are skipped.
 * A missing file is no data. Any other read error is logged and gives no data,
 * unless `strict`, which rethrows it so a CLI can report it.
 * @param {string} root
 * @param {{ since?: Date, session?: string, strict?: boolean, log?: (msg: string) => void }} [options]
 * @returns {MetricEntry[]}
 */
export function readMetrics(root, { since, session, strict = false, log = logStderr } = {}) {
  let text;
  try {
    text = readFileSync(join(root, STATE_DIR, METRICS_FILE), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    if (strict) throw err;
    log(`metrics: could not read (${String(err?.message ?? err).split("\n")[0]})`);
    return [];
  }
  const sinceMs = since instanceof Date ? since.getTime() : undefined;
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || e.v !== SCHEMA_VERSION || typeof e.ts !== "string") continue;
    const at = Date.parse(e.ts);
    if (Number.isNaN(at)) continue;
    if (sinceMs !== undefined && at < sinceMs) continue;
    if (session !== undefined && e.session !== session) continue;
    out.push(e);
  }
  return out;
}

/** When the file is over MAX_BYTES, keep the newest half of its lines (temp file + rename). */
function rotate(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return; // No file yet.
  }
  if (size <= MAX_BYTES) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length / 2));
    writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "");
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------- schema

const isId = (s) => typeof s === "string" && ID.test(s);
const isCount = (n) => Number.isInteger(n) && n >= 0 && n < 1e9;
const pick = (v, allowed) => (allowed.includes(v) ? v : undefined);

/** Per-policy fields, each a function returning the cleaned value or undefined to drop it. */
const POLICY_FIELDS = {
  "guard-bash": { verdict: (v) => pick(v, ["allow", "deny"]), rule: (v) => (isId(v) ? v : undefined) },
  "guard-paths": { verdict: (v) => pick(v, ["allow", "deny"]), rule: (v) => (isId(v) ? v : undefined) },
  "format-on-edit": { result: (v) => pick(v, ["ok", "failed", "skipped", "timeout"]), ms: (v) => (isCount(v) ? v : undefined) },
  "verify-gate": {
    fingerprint: (v) => (typeof v === "string" && FINGERPRINT.test(v) ? v : undefined),
    changedFiles: (v) => (isCount(v) ? v : undefined),
    stages: (v) => (Array.isArray(v) ? v.slice(0, 8).map(cleanStage).filter(Boolean) : undefined),
    outcome: (v) => pick(v, ["pass", "block", "nothing-ran", "gave-up", "deadline", "unchanged"]),
    attempt: (v) => (isCount(v) ? v : undefined),
  },
  "session-context": {},
};
const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];

function cleanStage(s) {
  if (!s || typeof s !== "object" || !isId(s.name) || !STAGE_RESULTS.includes(s.result)) return undefined;
  if (!isCount(s.filesChecked) || !isCount(s.ms)) return undefined;
  return { name: s.name, configured: s.configured === true, ran: s.ran === true, result: s.result, filesChecked: s.filesChecked, ms: s.ms };
}

/** The entry rebuilt from known fields, or null for an unknown policy or event. */
function cleanEntry(entry) {
  const fields = POLICY_FIELDS[entry?.policy];
  if (!fields || !EVENTS.includes(entry.event)) return null;
  const out = { session: isId(entry.session) ? entry.session : null, event: entry.event, policy: entry.policy };
  for (const [key, clean] of Object.entries(fields)) {
    const value = clean(entry[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function logStderr(msg) {
  process.stderr.write(`[harness] ${msg}\n`);
}
