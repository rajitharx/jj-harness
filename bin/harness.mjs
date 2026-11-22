#!/usr/bin/env node
// The harness CLI: the small surface the skills call.
//   init [--write] [--force-config]   propose (or write) config, CLAUDE.md, AGENTS.md, progress.md
//   verify [--all | --base <ref>]     run lint, typecheck and test on the changed files
//   stats [--session <id> | --last | --since <when>] [--json]
//                                     report what the harness did (from .harness/state/metrics.jsonl)
// Exit codes: 0 ok (for verify, also "nothing ran", which it prints and is not a
// pass; for stats, also "no data"), 1 checks failed or init refused, 2 usage,
// config, git or state-dir error (including an unknown --base ref).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, ConfigError, PROGRESS_PATH, defaultConfig, loadConfig, stageEntries, validateConfig } from "../lib/config.mjs";
import { detectProject } from "../lib/detect.mjs";
import { BaseRefError, changedFiles, trackedFiles } from "../lib/git.mjs";
import { readMetrics } from "../lib/metrics.mjs";
import { buildReport, parseSince, renderReport } from "../lib/stats.mjs";
import { CHECK_STAGES, describeRun, runStage, stageFiles, tail } from "../lib/verify.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK_START = "<!-- harness:start -->";
const MARK_END = "<!-- harness:end -->";
const OUTPUT_TAIL = 4000;

/**
 * Subcommands: their boolean flags, the options that take a value
 * (`--base <ref>` or `--base=<ref>`), and the implementation.
 * skills.test.mjs reads the names and flags from here.
 */
export const COMMANDS = {
  init: { flags: ["--write", "--force-config"], options: ["--packages"], run: init },
  verify: { flags: ["--all"], options: ["--base"], run: verify },
  stats: { flags: ["--last", "--json"], options: ["--session", "--since"], run: stats },
};
export const SUBCOMMANDS = Object.keys(COMMANDS);

const USAGE = `usage: harness.mjs <command> [flags]
  init [--write] [--force-config] [--packages <paths>]
                                   detect the stack and propose .harness/config.json (dry run);
                                   --write creates it plus CLAUDE.md, AGENTS.md and .harness/progress.md;
                                   --packages a,b: in a monorepo, only these packages (root-relative, "." = root)
  verify [--all | --base <ref>]    run lint, typecheck and test on the files that differ from HEAD;
                                   --base <ref>: plus the files the branch changed (git diff <ref>...HEAD),
                                   for checking committed work; --all: every tracked file
  stats [--session <id> | --last | --since <when>] [--json]
                                   what the harness did: verification coverage, stages, gate outcomes,
                                   failures caught, formatter results, guard denies. --last (default): the
                                   most recent session with a gate run; --since <7d | 24h | ISO date>: every
                                   session since then; --json: the same numbers as one object

verify prints one line per stage, then "verify: passed", "verify: failed (<stages>)" or
"verify: nothing ran". Exit codes: 0 passed, or nothing ran (no check executed, which is
not a pass); 1 a check failed; 2 a usage, config or git error, or an unknown --base ref.
stats exits 0 after printing a report or "stats: no data", and 2 for a usage error or an unreadable state directory.`;

/**
 * Run the CLI. Returns the exit code instead of exiting, so tests can call it.
 * @param {string[]} argv  Arguments after the script name.
 * @param {{ cwd?: string, out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, { cwd = process.cwd(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const [name, ...rest] = argv;
  if (name === "--help" || name === "-h" || name === "help") {
    out(`${USAGE}\n`);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name ?? "") ? COMMANDS[name] : undefined;
  if (!command) {
    err(`${name ? `unknown command: ${name}\n` : ""}${USAGE}\n`);
    return 2;
  }
  const flags = new Set();
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf("=");
    const opt = eq > 0 ? arg.slice(0, eq) : arg;
    if (command.flags.includes(arg)) {
      flags.add(arg);
    } else if (command.options.includes(opt)) {
      const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
      if (!value || Object.hasOwn(options, opt)) {
        err(`${name}: ${opt} ${value ? "given twice" : "needs a value"}\n${USAGE}\n`);
        return 2;
      }
      options[opt] = value;
    } else {
      err(`${name}: unknown argument ${arg}\n${USAGE}\n`);
      return 2;
    }
  }
  try {
    return await command.run(flags, { cwd, out, err, options });
  } catch (e) {
    err(`harness ${name}: ${e?.message ?? e}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------- init

async function init(flags, { cwd, out, err, options = {} }) {
  const write = flags.has("--write");
  const force = flags.has("--force-config");
  const root = projectRoot(cwd);
  // "./apps/web/" is "apps/web", and "./" is the root, ".".
  const only = options["--packages"]?.split(",").map((p) => p.trim().replace(/^\.\/|\/$/g, "") || ".");
  const detection = detectProject(root, { only });
  const proposal = { ...readTemplateConfig(), verify: detection.verify };
  validateConfig(proposal, "proposed config");

  const changes = planInit(root, proposal, force);
  const refused = changes.filter((c) => c.action === "refused");

  if (!write) {
    const summary = changes.map(({ path, action, why }) => ({ path, action: dryAction(action), ...(why ? { why } : {}) }));
    out(`${JSON.stringify({ root, stacks: detection.stacks, packages: detection.packages, config: proposal, notes: detection.notes, changes: summary }, null, 2)}\n`);
    return 0;
  }
  if (refused.length) {
    for (const c of refused) err(`refused  ${c.path}: ${c.why}\n`);
    err("Nothing was written.\n");
    return 1;
  }
  for (const c of changes) {
    if (c.text === undefined) continue;
    mkdirSync(dirname(join(root, c.path)), { recursive: true });
    writeFileSync(join(root, c.path), c.text);
  }
  for (const c of changes) out(`${c.action.padEnd(10)}${c.path}${c.why ? ` (${c.why})` : ""}\n`);
  if (detection.notes.length) out(`\nNotes:\n${detection.notes.map((n) => `- ${n}`).join("\n")}\n`);
  out("\nInstalled the plugin in this session? Run /reload-plugins (or restart Claude Code) so its skills and hooks load; until then /harness:* says \"Unknown skill\".\n");
  return 0;
}

/** What --write would do, phrased for the dry run. */
function dryAction(action) {
  return { created: "would create", updated: "would update", replaced: "would replace", kept: "would keep" }[action] ?? action;
}

/**
 * Decide every file init touches, without writing. Each change has an action
 * (created, updated, replaced, unchanged, kept or refused) and, when it
 * writes, the new text.
 */
function planInit(root, proposal, force) {
  const changes = [];
  const configText = `${JSON.stringify(proposal, null, 2)}\n`;
  const configFile = join(root, CONFIG_PATH);
  let verify = proposal.verify;
  if (!existsSync(configFile)) changes.push({ path: CONFIG_PATH, action: "created", text: configText });
  else if (readFileSync(configFile, "utf8") === configText) changes.push({ path: CONFIG_PATH, action: "unchanged" });
  else if (force) changes.push({ path: CONFIG_PATH, action: "replaced", text: configText });
  else {
    // Keep the user's config, and describe it (not the proposal) in CLAUDE.md.
    try {
      verify = loadConfig(root).verify;
      changes.push({ path: CONFIG_PATH, action: "kept", why: "exists and differs from the proposal; pass --force-config to replace it" });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      changes.push({ path: CONFIG_PATH, action: "refused", why: `the existing file is invalid (${e.message}); fix it or pass --force-config` });
    }
  }

  const claude = renderClaudeMd(root, verify);
  changes.push(mergeFile(root, "CLAUDE.md", claude, blockOf(claude)));
  const agentsBlock = [
    MARK_START,
    "Instructions for coding agents in this repository live in [CLAUDE.md](CLAUDE.md): read it first. It has the verify commands, the working rules and the project notes.",
    MARK_END,
  ].join("\n");
  changes.push(mergeFile(root, "AGENTS.md", `# AGENTS.md\n\n${agentsBlock}\n`, agentsBlock));

  if (existsSync(join(root, PROGRESS_PATH))) changes.push({ path: PROGRESS_PATH, action: "unchanged" });
  else {
    const text = "# Progress\n\nSession notes, newest last. The `handoff` skill appends entries; the harness shows the last 40 lines at session start.\n";
    changes.push({ path: PROGRESS_PATH, action: "created", text });
  }
  return changes;
}

/**
 * Create `path` with `fresh`, or merge `block` into the existing file: replace
 * the text between the harness markers, or append the block when there are
 * none. Everything outside the markers is kept byte for byte.
 */
function mergeFile(root, path, fresh, block) {
  const file = join(root, path);
  if (!existsSync(file)) return { path, action: "created", text: fresh };
  const existing = readFileSync(file, "utf8");
  const starts = existing.split(MARK_START).length - 1;
  const ends = existing.split(MARK_END).length - 1;
  if (starts === 0 && ends === 0) {
    const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { path, action: "updated", text: `${existing}${sep}${block}\n`, why: "appended the harness block" };
  }
  const s = existing.indexOf(MARK_START);
  const e = existing.indexOf(MARK_END);
  if (starts !== 1 || ends !== 1 || e < s) {
    return { path, action: "refused", why: `needs exactly one ${MARK_START} followed by one ${MARK_END}; fix the markers by hand` };
  }
  const text = existing.slice(0, s) + block + existing.slice(e + MARK_END.length);
  return text === existing ? { path, action: "unchanged" } : { path, action: "updated", text, why: "replaced the harness block" };
}

function blockOf(text) {
  return text.slice(text.indexOf(MARK_START), text.indexOf(MARK_END) + MARK_END.length);
}

function renderClaudeMd(root, verify) {
  const template = readFileSync(join(PLUGIN_ROOT, "templates", "CLAUDE.md"), "utf8");
  const values = { project_name: basename(root) };
  for (const stage of ["format", "lint", "typecheck", "test"]) values[`verify.${stage}`] = describeCommand(verify[stage]);
  // A stage with several commands is a list on the following lines: no trailing space after its label.
  return template.replace(/\{\{([\w.]+)\}\}/g, (m, key) => values[key] ?? m).replace(/^(- [A-Za-z]+:) $/gm, "$1");
}

/** One command as markdown: `run`, its filter abbreviated, or "not configured". */
function describeCommand(stage) {
  const entries = stageEntries(stage);
  if (entries.length === 0) return "not configured";
  const one = (entry) => {
    const { run, files, cwd } = typeof entry === "string" ? { run: entry } : entry;
    const shown = files?.slice(0, 3).map((g) => `\`${g}\``).join(", ");
    const notes = [cwd && `in \`${cwd}\``, shown && `only for ${shown}${files.length > 3 ? `, … ${files.length - 3} more` : ""}`].filter(Boolean);
    return `\`${run}\`${notes.length ? ` (${notes.join("; ")})` : ""}`;
  };
  return entries.length === 1 ? one(entries[0]) : entries.map((e) => `\n  - ${one(e)}`).join("");
}

function readTemplateConfig() {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, "templates", "config.json"), "utf8"));
}

/** The project root for `cwd`, even when its config is invalid (init may replace it). */
function projectRoot(cwd) {
  try {
    return loadConfig(cwd).root;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return defaultConfig(cwd).root;
  }
}

// ---------------------------------------------------------------- verify

async function verify(flags, { cwd, out, err, options = {} }) {
  const all = flags.has("--all");
  const base = options["--base"];
  if (all && base !== undefined) {
    err(`verify: --all and --base can't be combined\n${USAGE}\n`);
    return 2;
  }
  let config;
  try {
    config = loadConfig(cwd);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`${e.message}\n`);
    return 2;
  }
  let files;
  try {
    const changed = changedFiles(config.root, base);
    if (all) {
      const tracked = trackedFiles(config.root).map((path) => ({ path, deleted: !existsSync(join(config.root, path)) }));
      files = [...new Set(stageFiles([...tracked, ...changed]))].sort();
    } else {
      files = stageFiles(changed);
    }
  } catch (e) {
    if (e instanceof BaseRefError) {
      err(`verify --base: ${e.message}\n`);
      return 2;
    }
    err(`could not list files with git in ${config.root}: ${String(e?.message ?? e).split("\n")[0]}\n`);
    return 2;
  }

  const scope = all
    ? "files (--all: every tracked file)"
    : base !== undefined
      ? `changed files (${base}...HEAD plus the working tree)`
      : "changed files";
  out(`verify: ${files.length} ${scope} in ${config.root}\n`);
  const failed = [];
  let ran = 0;
  for (const stage of CHECK_STAGES) {
    if (!config.verify[stage]) {
      out(`skipped  ${stage} (no command configured)\n`);
      continue;
    }
    const r = await runStage(stage, config, files);
    if (!r.skipped) ran++;
    if (r.skipped) out(`skipped  ${stage} (no matching ${all ? "" : "changed "}files)\n`);
    else if (r.ok) for (const c of r.commands ?? [r.command]) out(`ok       ${stage}: ${c}\n`);
    else {
      failed.push(stage);
      const why = r.timedOut ? `timed out after ${config.stopGate.timeoutSec}s` : r.exitCode === null ? "could not run" : `exit ${r.exitCode}`;
      out(`FAILED   ${stage}: ${describeRun(r)} (${why})\n${tail(r.output, OUTPUT_TAIL) || "(no output)"}\n`);
    }
  }
  out(failed.length ? `verify: failed (${failed.join(", ")})\n` : ran ? "verify: passed\n" : "verify: nothing ran (no check executed; not a pass)\n");
  return failed.length ? 1 : 0;
}

// ---------------------------------------------------------------- stats

async function stats(flags, { cwd, out, err, options = {} }) {
  const chosen = [flags.has("--last") && "--last", "--session" in options && "--session", "--since" in options && "--since"].filter(Boolean);
  if (chosen.length > 1) {
    err(`stats: ${chosen.join(" and ")} can't be combined\n${USAGE}\n`);
    return 2;
  }
  let since;
  if ("--since" in options) {
    since = parseSince(options["--since"], new Date());
    if (!since) {
      err(`stats: --since needs a duration like 7d or 24h, or an ISO date like 2026-11-20 (got "${options["--since"]}")\n${USAGE}\n`);
      return 2;
    }
  }
  const scope = since ? "since" : "--session" in options ? "session" : "last";
  const root = projectRoot(cwd);
  let entries;
  try {
    // Strict: an unreadable state directory is an error here, not "no data".
    entries = readMetrics(root, { since, strict: true });
  } catch (e) {
    err(`stats: could not read the metrics log in ${root}/.harness/state (${String(e?.message ?? e).split("\n")[0]})\n`);
    return 2;
  }
  const report = buildReport(entries, { scope, session: options["--session"] });
  if (flags.has("--json")) out(`${JSON.stringify(report, null, 2)}\n`);
  else out(`${renderReport(report)}\n`);
  return 0;
}

// ---------------------------------------------------------------- entry

if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2));

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
