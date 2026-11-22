// Turns metric entries (lib/metrics.mjs) into the numbers `harness stats` prints.
// Pure: entries in, a report object or text out, no I/O and no clock (callers
// pass `now`). There is deliberately no single "effectiveness" score: the one
// percentage is verification coverage, everything else is a count or an outcome.

/** Bump when a key of the report below changes meaning or goes away (README documents them). */
export const REPORT_VERSION = 1;
const NO_SESSION = "(none)";

/**
 * @typedef {object} Coverage
 * @property {number|null} percent  Whole number 0 to 100, or null (`n/a`) when nothing changed or there was no gate run.
 * @property {number} checked  Changed files checked by at least one stage that ran. A lower bound: see README.
 * @property {number} changed  Files the checks could see in the last gate run.
 * @property {boolean} noChecksRan  The last gate run had files but no stage ran.
 *
 * @typedef {object} SessionSummary
 * @property {string} session
 * @property {string} start  ISO time of the session's first entry.
 * @property {string} end    ISO time of its last entry.
 * @property {Coverage} coverage  From the session's last verify-gate entry that is not a `gave-up` (see `reference`).
 * @property {{ name: string, state: "pass"|"fail"|"timeout"|"skipped"|"not-configured", filesChecked: number }[]} stages  The same entry's stages.
 * @property {{ stops: number, blocks: number, final: string|null }} gate  Verify-gate entries, those with outcome `block`, and the last entry's outcome.
 * @property {{ total: number, byStage: Record<string, number> }} caught  Blocks followed by a later `pass`, by the stage that failed.
 * @property {{ total: number, ok: number, failed: number, skipped: number, timeout: number }} formatOnEdit
 * @property {{ bashDenies: number, pathDenies: number, bashRules: Record<string, number> }} guards
 */

/**
 * @param {object[]} entries  Entries from readMetrics, oldest first.
 * @param {{ scope: "last"|"session"|"since", session?: string }} options
 *   last: the most recent session with a verify-gate entry; session: that session only;
 *   since: every session in `entries` (the caller already filtered by time).
 * @returns {{ v: number, scope: string, sessions: SessionSummary[], totals: object }}
 */
export function buildReport(entries, { scope, session }) {
  const bySession = new Map();
  for (const e of entries) {
    const id = typeof e.session === "string" ? e.session : NO_SESSION;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(e);
  }

  let picked = [...bySession.entries()];
  if (scope === "session") picked = picked.filter(([id]) => id === session);
  if (scope === "last") {
    const withGate = picked.filter(([, list]) => list.some(isGate));
    const newest = (list) => Math.max(...list.filter(isGate).map((e) => Date.parse(e.ts)));
    withGate.sort((a, b) => newest(b[1]) - newest(a[1]));
    picked = withGate.slice(0, 1);
  }
  const sessions = picked.map(([id, list]) => summarizeSession(id, list)).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { v: REPORT_VERSION, scope, sessions, totals: totalsOf(sessions) };
}

const isGate = (e) => e.policy === "verify-gate";

/** @returns {SessionSummary} */
export function summarizeSession(session, entries) {
  const sorted = [...entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const gate = sorted.filter(isGate);
  const last = gate.at(-1);
  // A gave-up run executed nothing on purpose: the stops before it, on the same tree, are what was checked.
  const reference = gate.findLast((x) => x.outcome !== "gave-up") ?? last;

  const caught = { total: 0, byStage: {} };
  gate.forEach((e, i) => {
    if (e.outcome !== "block" || !gate.slice(i + 1).some((later) => later.outcome === "pass")) return;
    for (const s of e.stages ?? []) {
      if (s.result !== "fail" && s.result !== "timeout") continue;
      caught.total++;
      bump(caught.byStage, s.name);
    }
  });

  const format = { total: 0, ok: 0, failed: 0, skipped: 0, timeout: 0 };
  for (const e of sorted.filter((x) => x.policy === "format-on-edit")) {
    format.total++;
    if (e.result in format) format[e.result]++;
  }

  const guards = { bashDenies: 0, pathDenies: 0, bashRules: {} };
  for (const e of sorted) {
    if (e.verdict !== "deny") continue;
    if (e.policy === "guard-bash") {
      guards.bashDenies++;
      const rule = e.rule ?? "unknown";
      bump(guards.bashRules, rule);
    } else if (e.policy === "guard-paths") guards.pathDenies++;
  }

  return {
    session,
    start: sorted[0].ts,
    end: sorted.at(-1).ts,
    coverage: coverageOf(reference),
    stages: reference ? stagesOf(reference) : [],
    gate: { stops: gate.length, blocks: gate.filter((e) => e.outcome === "block").length, final: last?.outcome ?? null },
    caught,
    formatOnEdit: format,
    guards,
  };
}

/**
 * Verification coverage of one verify-gate entry. The log has no paths, so "files
 * checked by at least one stage" is the most files any stage that ran was given:
 * a lower bound (two stages that checked different files count the larger set).
 * @param {object|undefined} entry
 * @returns {Coverage}
 */
export function coverageOf(entry) {
  const changed = Number.isInteger(entry?.changedFiles) ? entry.changedFiles : 0;
  if (!entry || changed === 0) return { percent: null, checked: 0, changed, noChecksRan: false };
  const ran = (entry.stages ?? []).filter((s) => s.ran && (s.result === "pass" || s.result === "fail"));
  if (ran.length === 0) return { percent: 0, checked: 0, changed, noChecksRan: true };
  const checked = Math.min(changed, Math.max(...ran.map((s) => s.filesChecked)));
  return { percent: Math.round((checked / changed) * 100), checked, changed, noChecksRan: false };
}

function stagesOf(entry) {
  return (entry.stages ?? []).map((s) => ({
    name: s.name,
    state: !s.configured ? "not-configured" : s.ran ? s.result : "skipped",
    filesChecked: s.filesChecked,
  }));
}

/** Sums over sessions. Coverage is total checked over total changed, across sessions that had files. */
function totalsOf(sessions) {
  const t = {
    sessions: sessions.length,
    coverage: { percent: null, checked: 0, changed: 0 },
    gate: { stops: 0, blocks: 0 },
    caught: { total: 0, byStage: {} },
    formatOnEdit: { total: 0, ok: 0, failed: 0, skipped: 0, timeout: 0 },
    guards: { bashDenies: 0, pathDenies: 0, bashRules: {} },
  };
  for (const s of sessions) {
    t.coverage.checked += s.coverage.checked;
    t.coverage.changed += s.coverage.changed;
    t.gate.stops += s.gate.stops;
    t.gate.blocks += s.gate.blocks;
    t.caught.total += s.caught.total;
    addCounts(t.caught.byStage, s.caught.byStage);
    addCounts(t.formatOnEdit, s.formatOnEdit);
    t.guards.bashDenies += s.guards.bashDenies;
    t.guards.pathDenies += s.guards.pathDenies;
    addCounts(t.guards.bashRules, s.guards.bashRules);
  }
  if (t.coverage.changed > 0) t.coverage.percent = Math.round((t.coverage.checked / t.coverage.changed) * 100);
  return t;
}

// Keys can come from a hand-edited log: only own properties count, so "constructor" is just a name.
function bump(counts, key, n = 1) {
  counts[key] = (Object.hasOwn(counts, key) ? counts[key] : 0) + n;
}

function addCounts(into, from) {
  for (const [k, n] of Object.entries(from)) bump(into, k, n);
}

// ---------------------------------------------------------------- --since

/**
 * `7d`, `24h`, or an ISO date (`2026-11-20`, `2026-11-20T08:00:00Z`) as a Date; null when it is none of those.
 * @param {string} text
 * @param {Date} now
 */
export function parseSince(text, now) {
  const rel = /^(\d{1,4})([dh])$/.exec(text);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * (rel[2] === "d" ? 86_400_000 : 3_600_000));
  // Dates and times without an offset are UTC, like everything `stats` prints.
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!iso) return null;
  const [, day, time = "00:00:00", zone = "Z"] = iso;
  const at = Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}${zone}`);
  if (Number.isNaN(at)) return null;
  // Date.parse rolls 2026-11-31 over to December: reject it.
  if (zone === "Z" && new Date(at).toISOString().slice(0, 10) !== day) return null;
  return new Date(at);
}

// ---------------------------------------------------------------- text

/** The report as the terminal block. Times are UTC, so output doesn't depend on the machine. */
export function renderReport(report) {
  if (report.sessions.length === 0) return "stats: no data";
  if (report.scope !== "since") return report.sessions.map(renderSession).join("\n\n");
  const t = report.totals;
  const lines = [
    `harness stats: ${t.sessions} session${t.sessions === 1 ? "" : "s"}`,
    ...rows([
      ["verification coverage", coverageText(t.coverage, t.coverage.changed > 0 && t.coverage.checked === 0)],
      ["gate", `${count(t.gate.stops, "stop")} · ${count(t.gate.blocks, "block")}`],
      ["caught", caughtText(t.caught)],
      ["format-on-edit", formatText(t.formatOnEdit)],
      ["guards", guardsText(t.guards)],
    ]),
    "",
    "per session",
    ...report.sessions.map(
      (s) =>
        `  ${shortId(s.session)}  ${span(s.start, s.end)}  coverage ${s.coverage.percent === null ? "n/a" : `${s.coverage.percent}%`}` +
        ` · ${count(s.gate.stops, "stop")} · ${count(s.gate.blocks, "block")} · final ${s.gate.final ?? "n/a"} · caught ${s.caught.total}`,
    ),
  ];
  return lines.join("\n");
}

function renderSession(s) {
  const stageText = s.stages.length
    ? s.stages.map((x) => stageText1(x, s.coverage.changed)).join(" · ")
    : "no gate run recorded";
  const final = s.gate.final === null ? "no gate run recorded" : finalText(s.gate);
  return [
    `harness stats — session ${shortId(s.session)} (${span(s.start, s.end)})`,
    ...rows([
      ["verification coverage", coverageText(s.coverage, s.coverage.noChecksRan)],
      ["stages", stageText],
      ["gate", s.gate.stops === 0 ? final : `${count(s.gate.stops, "stop")} · ${count(s.gate.blocks, "block")} · ${final}`],
      ["caught", caughtText(s.caught)],
      ["format-on-edit", formatText(s.formatOnEdit)],
      ["guards", guardsText(s.guards)],
    ]),
  ].join("\n");
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const rows = (pairs) => pairs.map(([label, value]) => `${label.padEnd(24)}${value}`);

function coverageText(c, noChecksRan) {
  if (c.percent === null) return "n/a  (no changed files to check)";
  if (noChecksRan) return `0%  (no checks ran; ${c.changed} changed file${c.changed === 1 ? "" : "s"})`;
  return `${c.percent}%  (${c.checked}/${c.changed} changed files checked by ≥1 stage)`;
}

function stageText1(s, changed) {
  switch (s.state) {
    case "pass":
      return `${s.name} ✓ ${s.filesChecked}/${changed}`;
    case "fail":
      return `${s.name} ✗ ${s.filesChecked}/${changed}`;
    case "timeout":
      return `${s.name} timeout`;
    case "not-configured":
      return `${s.name} not configured`;
    default:
      return `${s.name} skipped`;
  }
}

function finalText(gate) {
  if (gate.final === "pass" && gate.blocks > 0) return `final: pass after ${gate.blocks} block${gate.blocks === 1 ? "" : "s"}`;
  return `final: ${gate.final}`;
}

function caughtText(c) {
  if (c.total === 0) return "none";
  const by = Object.entries(c.byStage).map(([name, n]) => `${name} ${n}`).join(", ");
  return `${c.total} failure${c.total === 1 ? "" : "s"} fixed before stop (${by})`;
}

function formatText(f) {
  if (f.total === 0) return "no edits recorded";
  const rest = ["failed", "timeout", "skipped"].filter((k) => f[k] > 0).map((k) => `${f[k]} ${k}`);
  return [`${f.ok}/${f.total} ok`, ...rest].join(" · ");
}

function guardsText(g) {
  const rules = Object.entries(g.bashRules).map(([rule, n]) => (n > 1 ? `${rule} ×${n}` : rule)).join(", ");
  const bash = g.bashDenies === 0 ? "0 bash denies" : `${g.bashDenies} ${g.bashDenies === 1 ? "deny" : "denies"} (bash: ${rules})`;
  return `${bash} · ${g.pathDenies} path ${g.pathDenies === 1 ? "deny" : "denies"}`;
}

const shortId = (id) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** `2026-11-22 07:40 → 08:05 UTC`, or with both dates when the session crossed midnight. */
function span(start, end) {
  const d = (iso) => iso.slice(0, 10);
  const t = (iso) => iso.slice(11, 16);
  return d(start) === d(end)
    ? `${d(start)} ${t(start)} → ${t(end)} UTC`
    : `${d(start)} ${t(start)} → ${d(end)} ${t(end)} UTC`;
}
