import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, coverageOf, parseSince, renderReport, summarizeSession } from "../lib/stats.mjs";

let clock;
const reset = () => (clock = Date.parse("2026-11-22T07:40:00Z"));
reset();
/** An entry one minute after the previous one. */
const e = (policy, fields = {}) => ({
  v: 1,
  ts: new Date((clock += 60_000)).toISOString(),
  session: "3f2a9c1e-aaaa",
  event: policy === "verify-gate" ? "Stop" : "PreToolUse",
  policy,
  ...fields,
});
const stage = (name, result, filesChecked = 0, extra = {}) => ({
  name,
  configured: true,
  ran: result === "pass" || result === "fail" || result === "timeout",
  result,
  filesChecked,
  ms: 10,
  ...extra,
});
const NOT_CONFIGURED = { name: "typecheck", configured: false, ran: false, result: "skipped", filesChecked: 0, ms: 0 };
const gate = (outcome, changedFiles, stages, extra = {}) => e("verify-gate", { fingerprint: "0".repeat(64), changedFiles, stages, outcome, attempt: 1, ...extra });

test("coverage: checked is the most files any stage that ran was given, over the changed files", () => {
  const cases = [
    ["two stages, the larger set counts (a lower bound)", gate("pass", 10, [stage("lint", "pass", 8), NOT_CONFIGURED, stage("test", "pass", 6)]), { percent: 80, checked: 8, changed: 10, noChecksRan: false }],
    ["a failing stage still checked its files", gate("block", 4, [stage("lint", "fail", 4)]), { percent: 100, checked: 4, changed: 4, noChecksRan: false }],
    ["a timeout checked nothing we can count", gate("block", 4, [stage("lint", "pass", 1), stage("test", "timeout", 4)]), { percent: 25, checked: 1, changed: 4, noChecksRan: false }],
    ["rounds to a whole number", gate("pass", 3, [stage("lint", "pass", 2)]), { percent: 67, checked: 2, changed: 3, noChecksRan: false }],
    ["no changed files is n/a, not 100%", gate("nothing-ran", 0, [stage("lint", "skipped")]), { percent: null, checked: 0, changed: 0, noChecksRan: false }],
    ["n/a even when a whole-project stage ran", gate("pass", 0, [stage("test", "pass", 0)]), { percent: null, checked: 0, changed: 0, noChecksRan: false }],
    ["no stage ran is 0% with the note", gate("nothing-ran", 5, [stage("lint", "skipped"), NOT_CONFIGURED]), { percent: 0, checked: 0, changed: 5, noChecksRan: true }],
    ["a stage that ran with a count above the changed files is capped", gate("pass", 2, [stage("test", "pass", 9)]), { percent: 100, checked: 2, changed: 2, noChecksRan: false }],
    ["no gate entry at all is n/a", undefined, { percent: null, checked: 0, changed: 0, noChecksRan: false }],
  ];
  for (const [name, entry, expected] of cases) assert.deepEqual(coverageOf(entry), expected, name);
});

test("coverage uses the LAST gate entry of the session", () => {
  reset();
  const s = summarizeSession("s", [
    gate("block", 10, [stage("lint", "pass", 10), stage("test", "fail", 10)]),
    gate("pass", 10, [stage("lint", "pass", 5), stage("test", "pass", 5)]),
  ]);
  assert.equal(s.coverage.percent, 50);
  assert.deepEqual(s.stages.map((x) => [x.name, x.state, x.filesChecked]), [["lint", "pass", 5], ["test", "pass", 5]]);
});

test("caught: blocks that a later pass followed, counted by the failed stage", () => {
  const block = (name, result = "fail") => gate("block", 2, [stage("lint", name === "lint" ? result : "pass", 2), stage("test", name === "test" ? result : "skipped", name === "test" ? 2 : 0)]);
  const cases = [
    ["two blocks fixed", [block("lint"), block("test"), gate("pass", 2, [stage("lint", "pass", 2)])], 2, { lint: 1, test: 1 }],
    ["the same stage twice", [block("lint"), block("lint"), gate("pass", 2, [stage("lint", "pass", 2)])], 2, { lint: 2 }],
    ["a timeout block counts as the stage that failed", [block("test", "timeout"), gate("pass", 2, [stage("lint", "pass", 2)])], 1, { test: 1 }],
    ["blocks with no later pass caught nothing", [block("lint"), block("test")], 0, {}],
    ["a gave-up is not a pass", [block("lint"), gate("gave-up", 2, [])], 0, {}],
    ["a nothing-ran is not a pass", [block("lint"), gate("nothing-ran", 2, [stage("lint", "skipped")])], 0, {}],
    ["a block after the last pass is not caught", [gate("pass", 2, [stage("lint", "pass", 2)]), block("lint")], 0, {}],
    ["no blocks", [gate("pass", 2, [stage("lint", "pass", 2)])], 0, {}],
  ];
  for (const [name, entries, total, byStage] of cases) {
    reset();
    assert.deepEqual(summarizeSession("s", entries).caught, { total, byStage }, name);
  }
});

test("gate outcomes: stops, blocks and the final outcome of the last entry", () => {
  const cases = [
    ["pass after blocks", ["block", "block", "pass"], { stops: 3, blocks: 2, final: "pass" }],
    ["gave up", ["block", "block", "gave-up"], { stops: 3, blocks: 2, final: "gave-up" }],
    ["deadline", ["pass", "deadline"], { stops: 2, blocks: 0, final: "deadline" }],
    ["ended while blocked", ["block"], { stops: 1, blocks: 1, final: "block" }],
    ["nothing ran", ["nothing-ran"], { stops: 1, blocks: 0, final: "nothing-ran" }],
  ];
  for (const [name, outcomes, expected] of cases) {
    reset();
    assert.deepEqual(summarizeSession("s", outcomes.map((o) => gate(o, 1, [stage("lint", "pass", 1)]))).gate, expected, name);
  }
  reset();
  const none = summarizeSession("s", [e("session-context")]);
  assert.deepEqual(none.gate, { stops: 0, blocks: 0, final: null });
  assert.deepEqual(none.stages, []);
  assert.equal(none.coverage.percent, null);
});

test("format-on-edit and guard counts", () => {
  reset();
  const s = summarizeSession("s", [
    e("format-on-edit", { result: "ok", ms: 5 }),
    e("format-on-edit", { result: "ok", ms: 5 }),
    e("format-on-edit", { result: "failed", ms: 5 }),
    e("format-on-edit", { result: "timeout", ms: 5 }),
    e("format-on-edit", { result: "skipped", ms: 0 }),
    e("guard-bash", { verdict: "deny", rule: "force-push-main" }),
    e("guard-bash", { verdict: "deny", rule: "force-push-main" }),
    e("guard-bash", { verdict: "deny", rule: "mkfs" }),
    e("guard-bash", { verdict: "allow" }),
    e("guard-paths", { verdict: "deny", rule: "protectedPaths" }),
    e("guard-paths", { verdict: "allow" }),
  ]);
  assert.deepEqual(s.formatOnEdit, { total: 5, ok: 2, failed: 1, skipped: 1, timeout: 1 });
  assert.deepEqual(s.guards, { bashDenies: 3, pathDenies: 1, bashRules: { "force-push-main": 2, mkfs: 1 } });
});

test("the human block for one session", () => {
  reset();
  const entries = [
    e("session-context"),
    ...Array.from({ length: 12 }, () => e("format-on-edit", { result: "ok", ms: 3 })),
    e("guard-bash", { verdict: "deny", rule: "force-push-main" }),
    gate("block", 10, [stage("lint", "fail", 8), NOT_CONFIGURED, stage("test", "skipped")]),
    gate("block", 10, [stage("lint", "pass", 8), NOT_CONFIGURED, stage("test", "fail", 6)]),
    gate("pass", 10, [stage("lint", "pass", 8), { ...NOT_CONFIGURED, configured: true, result: "skipped" }, stage("test", "pass", 6)]),
  ];
  const report = buildReport(entries, { scope: "last" });
  assert.equal(
    renderReport(report),
    [
      "harness stats — session 3f2a9c1e… (2026-11-22 07:41 → 07:57 UTC)",
      "verification coverage   80%  (8/10 changed files checked by ≥1 stage)",
      "stages                  lint ✓ 8/10 · typecheck skipped · test ✓ 6/10",
      "gate                    3 stops · 2 blocks · final: pass after 2 blocks",
      "caught                  2 failures fixed before stop (lint 1, test 1)",
      "format-on-edit          12/12 ok",
      "guards                  1 deny (bash: force-push-main) · 0 path denies",
    ].join("\n"),
  );
});

test("the human block says n/a, no checks ran, and no gate run", () => {
  reset();
  const render = (entries) => renderReport(buildReport(entries, { scope: "last" }));
  assert.match(render([gate("nothing-ran", 0, [stage("lint", "skipped")])]), /^verification coverage {3}n\/a {2}\(no changed files to check\)$/m);
  const none = render([gate("nothing-ran", 3, [stage("lint", "skipped"), NOT_CONFIGURED, stage("test", "skipped")])]);
  assert.match(none, /^verification coverage {3}0% {2}\(no checks ran; 3 changed files\)$/m);
  assert.match(none, /^stages {18}lint skipped · typecheck not configured · test skipped$/m);
  assert.match(none, /^gate {20}1 stop · 0 blocks · final: nothing-ran$/m);
  assert.match(none, /^caught {18}none$/m);
  assert.match(none, /^format-on-edit {10}no edits recorded$/m);
  assert.match(render([gate("gave-up", 2, [])]), /final: gave-up/);
  assert.match(render([gate("deadline", 2, [stage("lint", "pass", 2), stage("test", "timeout", 2)])]), /final: deadline/);
});

test("scope last picks the session of the newest gate entry, and ignores sessions without one", () => {
  reset();
  const as = (session, entry) => ({ ...entry, session });
  const entries = [
    as("old", gate("pass", 1, [stage("lint", "pass", 1)])),
    as("new", gate("pass", 2, [stage("lint", "pass", 2)])),
    as("guards-only", e("guard-bash", { verdict: "allow" })),
  ];
  const r = buildReport(entries, { scope: "last" });
  assert.deepEqual(r.sessions.map((s) => s.session), ["new"]);
  assert.deepEqual(buildReport([as("guards-only", e("guard-bash", { verdict: "allow" }))], { scope: "last" }).sessions, []);
  assert.equal(renderReport(buildReport([], { scope: "last" })), "stats: no data");
});

test("scope session selects one session; a missing id is no data", () => {
  reset();
  const as = (session, entry) => ({ ...entry, session });
  const entries = [as("a", gate("pass", 1, [stage("lint", "pass", 1)])), as("b", gate("block", 1, [stage("lint", "fail", 1)]))];
  assert.deepEqual(buildReport(entries, { scope: "session", session: "b" }).sessions.map((s) => s.gate.final), ["block"]);
  assert.deepEqual(buildReport(entries, { scope: "session", session: "zzz" }).sessions, []);
});

test("scope since: totals plus one line per session, sessions ordered by start", () => {
  reset();
  const as = (session, entry) => ({ ...entry, session });
  const entries = [
    as("aaaaaaaa-1", gate("block", 10, [stage("lint", "fail", 10)])),
    as("aaaaaaaa-1", gate("pass", 10, [stage("lint", "pass", 10)])),
    as("bbbbbbbb-2", gate("pass", 10, [stage("lint", "pass", 5)])),
    as("bbbbbbbb-2", e("guard-paths", { verdict: "deny", rule: "protectedPaths" })),
    as("cccccccc-3", gate("nothing-ran", 0, [stage("lint", "skipped")])),
  ];
  const r = buildReport(entries, { scope: "since" });
  assert.deepEqual(r.sessions.map((s) => s.session), ["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3"]);
  assert.deepEqual(r.totals, {
    sessions: 3,
    coverage: { percent: 75, checked: 15, changed: 20 },
    gate: { stops: 4, blocks: 1 },
    caught: { total: 1, byStage: { lint: 1 } },
    formatOnEdit: { total: 0, ok: 0, failed: 0, skipped: 0, timeout: 0 },
    guards: { bashDenies: 0, pathDenies: 1, bashRules: {} },
  });
  const text = renderReport(r).split("\n");
  assert.equal(text[0], "harness stats: 3 sessions");
  assert.match(text.join("\n"), /^verification coverage {3}75% {2}\(15\/20 changed files checked by ≥1 stage\)$/m);
  assert.match(text.join("\n"), /^gate {20}4 stops · 1 block$/m);
  const lines = text.slice(text.indexOf("per session") + 1);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ {2}aaaaaaaa… {2}2026-11-22 .* coverage 100% · 2 stops · 1 block · final pass · caught 1$/);
  assert.match(lines[1], /coverage 50% · 1 stop · 0 blocks · final pass · caught 0$/);
  assert.match(lines[2], /coverage n\/a · 1 stop · 0 blocks · final nothing-ran/);
});

test("--json shape: stable keys", () => {
  reset();
  const r = buildReport([gate("pass", 2, [stage("lint", "pass", 1)])], { scope: "last" });
  assert.deepEqual(Object.keys(r), ["v", "scope", "sessions", "totals"]);
  assert.equal(r.v, 1);
  assert.deepEqual(Object.keys(r.sessions[0]), ["session", "start", "end", "coverage", "stages", "gate", "caught", "formatOnEdit", "guards"]);
  assert.deepEqual(Object.keys(r.sessions[0].coverage), ["percent", "checked", "changed", "noChecksRan"]);
  assert.deepEqual(Object.keys(r.totals), ["sessions", "coverage", "gate", "caught", "formatOnEdit", "guards"]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, "plain JSON");
});

test("a session that crosses midnight shows both dates", () => {
  const entries = [
    { v: 1, ts: "2026-11-21T23:50:00Z", session: "s", event: "SessionStart", policy: "session-context" },
    { v: 1, ts: "2026-11-22T00:10:00Z", session: "s", event: "PreToolUse", policy: "guard-bash", verdict: "allow" },
  ];
  assert.match(renderReport(buildReport(entries, { scope: "session", session: "s" })), /\(2026-11-21 23:50 → 2026-11-22 00:10 UTC\)/);
});

test("parseSince: durations and ISO dates; anything else is null", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const cases = [
    ["7d", "2026-11-15T12:00:00.000Z"],
    ["24h", "2026-11-21T12:00:00.000Z"],
    ["1h", "2026-11-22T11:00:00.000Z"],
    ["2026-11-20", "2026-11-20T00:00:00.000Z"],
    ["2026-11-20T08:30:00Z", "2026-11-20T08:30:00.000Z"],
    ["yesterday", null],
    ["7", null],
    ["7w", null],
    ["", null],
    ["-3d", null],
    ["2026-13-45", null],
    ["Nov 20", null],
  ];
  for (const [text, expected] of cases) assert.equal(parseSince(text, now)?.toISOString() ?? null, expected, JSON.stringify(text));
});
