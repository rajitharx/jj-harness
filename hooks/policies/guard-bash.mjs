// Deny destructive or irreversible shell commands (rm -rf /, force push to main, curl | sh, DROP DATABASE...) plus config.blockedCommands.
// Best-effort pattern matching over a quote-aware parse of the command, not a sandbox.
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "mongosh"]);
// Wrappers that run the rest of the line as a command, with the flags of theirs that take a value.
const WRAPPERS = {
  sudo: ["-u", "-g", "-h", "-p", "-C"],
  doas: ["-u"],
  env: ["-u", "-C", "-S"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: ["-f", "-o"],
  nice: ["-n"],
  timeout: ["-s", "-k"],
  stdbuf: ["-i", "-o", "-e"],
  xargs: ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"],
};
const RM_DANGEROUS = new Set([
  "/", "/*", "~", "~/*", "$HOME", "${HOME}", "$HOME/*", "${HOME}/*", "*", ".*",
  ".", "./*", "..", "../*", "$PWD", "${PWD}", "$(pwd)", "`pwd`",
]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);
// A command substitution (`$(…)`, backticks, `<(…)`) that starts with a download.
const DOWNLOAD_SUBST = /(?:\$\(|`|<\()\s*(?:\S*\/)?(?:curl|wget)\b/;

/**
 * The rule table. `scope` says what `test` receives:
 * - "command":  the raw command string
 * - "pipeline": an array of segments joined by `|` (a pipeline between `&&`, `||`, `;`, `&`, newlines)
 * - "segment":  one simple command { cmd, args, words, heredocs, subs, viaXargs }, wrappers stripped
 * Every test also gets `ctx`, whose `branch()` lazily reads the current git branch.
 * @type {{ scope: "command"|"pipeline"|"segment", test: (x: any, ctx: Ctx) => boolean, reason: string }[]}
 */
const RULES = [
  {
    scope: "pipeline",
    test: (pipeline) =>
      pipeline.some((s, k) => {
        if (s.cmd !== "rm" || !isRecursiveForce(s.args)) return false;
        const targets = operands(s.args);
        // `echo / | xargs rm -rf`: the targets arrive on stdin from the previous command.
        const prev = pipeline[k - 1];
        if (s.viaXargs && (prev?.cmd === "echo" || prev?.cmd === "printf")) targets.push(...operands(prev.args));
        return targets.some(isDangerousRmTarget);
      }),
    reason:
      "recursive force-delete of /, home, the working directory or a bare glob is irreversible. Delete the specific paths you mean instead (e.g. `rm -rf ./dist ./node_modules`).",
  },
  {
    scope: "segment",
    test: ({ cmd, args }, ctx) => {
      const push = cmd === "git" && parsePush(args);
      return !!push && pushTargets(push, ctx).some((t) => isProtectedBranch(t.dst) && (push.force || t.plus));
    },
    reason:
      "force-pushing to main/master rewrites shared history. Push to a feature branch and open a PR, or use `git revert` to undo commits on main.",
  },
  {
    scope: "segment",
    test: ({ cmd, args }, ctx) => {
      const push = cmd === "git" && parsePush(args);
      return !!push && pushTargets(push, ctx).some((t) => isProtectedBranch(t.dst) && (push.delete || t.src === ""));
    },
    reason: "deleting main/master on the remote breaks everyone using it. Delete feature branches only, and ask the user to change protected branches.",
  },
  {
    scope: "pipeline",
    test: (pipeline) => {
      const i = pipeline.findIndex((s) => DOWNLOADERS.has(s.cmd));
      return i !== -1 && pipeline.slice(i + 1).some((s) => SHELLS.has(s.cmd));
    },
    reason:
      "piping a download straight into a shell runs unreviewed remote code. Download to a file, inspect it, then run it (e.g. `curl -fsSLo install.sh <url> && less install.sh`).",
  },
  {
    scope: "segment",
    test: ({ cmd, args }) => {
      if (cmd === "eval" || cmd === "source" || cmd === ".") return args.some((a) => DOWNLOAD_SUBST.test(a));
      if (!SHELLS.has(cmd)) return false;
      const script = shellScriptArg(args);
      return (script !== null && DOWNLOAD_SUBST.test(script)) || args.some((a) => a.startsWith("<(") && DOWNLOAD_SUBST.test(a));
    },
    reason:
      "running a download through a shell runs unreviewed remote code. Download to a file, inspect it, then run it.",
  },
  {
    scope: "pipeline",
    test: (pipeline) =>
      pipeline.some((s) => s.words.some((w) => DB_CLIENTS.has(basename(w)))) &&
      /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\b|\bdropDatabase\s*\(/i.test(
        pipeline.flatMap((s) => [...s.words, ...s.heredocs]).join(" "),
      ),
    reason:
      "destructive SQL (DROP DATABASE/SCHEMA/TABLE, TRUNCATE) sent to a database client. Write a reviewed migration, or ask the user to run it themselves.",
  },
  {
    scope: "segment",
    test: ({ cmd }) => /^mkfs(?:\.|$)/.test(cmd ?? ""),
    reason: "mkfs formats a filesystem and destroys its data. Ask the user to run disk operations themselves.",
  },
  {
    scope: "segment",
    test: ({ cmd, args }) =>
      cmd === "dd" && args.some((a) => /^of=\/dev\//.test(a) && !/^of=\/dev\/(?:null|stdout|stderr|fd\/)/.test(a)),
    reason: "dd writing to a device overwrites it irreversibly. Write to a regular file instead, or ask the user to run it.",
  },
  {
    scope: "segment",
    test: ({ cmd, args }) =>
      cmd === "chmod" &&
      args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R/.test(a)) &&
      operands(args).some((a) => /^\/+\*?$/.test(a)),
    reason: "recursive chmod on / breaks the whole system's permissions. Change permissions on specific project paths instead.",
  },
  {
    scope: "command",
    // The lookbehind anchors the name at a token start, which keeps this linear on long inputs.
    test: (cmd) => /(?<![\w:])([\w:]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1/.test(cmd),
    reason: "this is a fork bomb, which exhausts the machine's processes. Don't run it.",
  },
];

/** @typedef {{ branch: () => string | null }} Ctx */

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function guardBash(input, config) {
  if (input.tool_name !== "Bash") return { kind: "allow" };
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") return { kind: "allow" };

  let branch;
  const ctx = { branch: () => (branch === undefined ? (branch = readCurrentBranch(config.root)) : branch) };
  const hit = check(command, 0, ctx);
  if (hit) return { kind: "block", reason: `Blocked \`${clip(hit.text)}\`: ${hit.reason}` };

  for (const pattern of config.blockedCommands) {
    if (new RegExp(pattern).test(command)) {
      return {
        kind: "block",
        reason: `Blocked \`${clip(command)}\`: it matches the project's blockedCommands pattern /${pattern}/ in .harness/config.json. Use a different command, or ask the user to run it.`,
      };
    }
  }
  return { kind: "allow" };
}

/**
 * The current branch of the repo at `root`, following a `.git` file's
 * `gitdir:` for worktrees. Null when detached or unreadable (fail open).
 * @param {string} root
 */
function readCurrentBranch(root) {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = resolve(root, m[1].trim());
    }
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(join(gitDir, "HEAD"), "utf8").trim());
    return ref ? ref[1] : null;
  } catch {
    return null;
  }
}

/** @returns {{ reason: string, text: string } | null} */
function check(command, depth, ctx) {
  for (const rule of RULES) {
    if (rule.scope === "command" && rule.test(command, ctx)) return { reason: rule.reason, text: command };
  }
  for (const pipeline of parse(command)) {
    for (const rule of RULES) {
      if (rule.scope === "pipeline" && rule.test(pipeline, ctx)) return { reason: rule.reason, text: show(pipeline) };
    }
    for (const segment of pipeline) {
      for (const rule of RULES) {
        if (rule.scope === "segment" && rule.test(segment, ctx)) return { reason: rule.reason, text: show([segment]) };
      }
      if (depth >= 3) continue;
      for (const nested of nestedCommands(segment)) {
        const hit = check(nested, depth + 1, ctx);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Command lines a segment runs besides itself: substitutions, `bash -c`, `eval`, a heredoc fed to a shell. */
function nestedCommands({ cmd, args, subs, heredocs }) {
  const out = [...subs];
  if (cmd === "eval") out.push(args.join(" "));
  if (SHELLS.has(cmd)) {
    const script = shellScriptArg(args);
    if (script !== null) out.push(script);
    out.push(...heredocs);
  }
  return out;
}

/** The script string of `sh -c '…'` (any flag cluster containing `c`, e.g. `-lc`), or null. */
function shellScriptArg(args) {
  const i = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

/**
 * @typedef {{ words: string[], heredocs: string[], subs: string[] }} RawSegment
 * @typedef {RawSegment & { cmd: string | null, args: string[], viaXargs: boolean }} Segment
 */

/**
 * Split a command line into pipelines of simple commands. Quote-aware: quotes
 * are removed from words, and separators inside quotes are ordinary text.
 * Command substitutions (`$(…)`, backticks, `<(…)`) stay in their word and
 * are also recorded in `subs`, so they're checked as commands of their own.
 * Heredoc bodies are attached to the segment that reads them.
 * @returns {Segment[][]}
 */
function parse(command) {
  /** @type {RawSegment[][]} */
  const pipelines = [];
  /** @type {RawSegment[]} */ let pipeline;
  /** @type {RawSegment} */ let seg;
  /** @type {{ delim: string, strip: boolean, seg: RawSegment }[]} */
  let pendingHeredocs = [];
  let word = null;
  let quote = null;
  const append = (s) => (word = (word ?? "") + s);
  const flush = () => {
    if (word !== null) seg.words.push(word);
    word = null;
  };
  const newSegment = () => {
    flush();
    seg = { words: [], heredocs: [], subs: [] };
    pipeline.push(seg);
  };
  const newPipeline = () => {
    flush();
    pipeline = [];
    pipelines.push(pipeline);
    newSegment();
  };
  const substitution = (i) => {
    const end = closingIndex(command, i);
    seg.subs.push(command.slice(command[i] === "`" ? i + 1 : i + 2, end));
    append(command.slice(i, end + 1));
    return end;
  };
  newPipeline();

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else append(c);
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined) append(command[++i]);
      else if ((c === "$" && next === "(") || c === "`") i = substitution(i);
      else append(c);
    } else if (c === "'" || c === '"') {
      quote = c;
      append("");
    } else if (c === "\\" && next !== undefined) {
      if (next === "\n") i++; // line continuation
      else append(command[++i]);
    } else if (((c === "$" || c === "<" || c === ">") && next === "(") || c === "`") {
      i = substitution(i);
    } else if (c === "<" && next === "<" && command[i + 2] === "<") {
      // A here-string: keep `<<<` as one token so the word after it stays in the command.
      flush();
      seg.words.push("<<<");
      i += 2;
    } else if (c === "<" && next === "<") {
      const header = readHeredocHeader(command, i + 2);
      if (!header) {
        append("<<");
        i++;
        continue;
      }
      flush();
      pendingHeredocs.push({ ...header, seg });
      i = header.end - 1;
    } else if (c === "\n") {
      flush();
      if (pendingHeredocs.length) {
        let pos = i + 1;
        for (const h of pendingHeredocs) {
          const body = readHeredocBody(command, pos, h);
          h.seg.heredocs.push(body.text);
          pos = body.end;
        }
        pendingHeredocs = [];
        i = pos - 1;
      }
      newPipeline();
    } else if (/\s/.test(c)) {
      flush();
    } else if (c === "|") {
      if (next === "|") (i++, newPipeline());
      else {
        if (next === "&") i++;
        newSegment();
      }
    } else if (c === "&") {
      const prev = command[i - 1];
      if (next === "&") (i++, newPipeline());
      else if (prev === ">" || prev === "<" || next === ">") append(c); // 2>&1, &>file
      else newPipeline();
    } else if (c === ";" || c === "(" || c === ")") {
      newPipeline();
    } else if ((c === "{" || c === "}") && word === null && (next === undefined || /[\s;]/.test(next))) {
      newPipeline(); // a `{ …; }` group; `${HOME}` and `{a,b}` stay part of their word
    } else {
      append(c);
    }
  }
  flush();

  return pipelines.map((p) => p.map(toSegment).filter((s) => s.cmd !== null || s.subs.length || s.heredocs.length)).filter((p) => p.length);
}

/** Index of the `)` (or backtick) closing the substitution that starts at `i`. */
function closingIndex(command, i) {
  if (command[i] === "`") {
    const end = command.indexOf("`", i + 1);
    return end === -1 ? command.length - 1 : end;
  }
  let depth = 0;
  let quote = null;
  for (let j = i + 1; j < command.length; j++) {
    const c = command[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return command.length - 1;
}

/** Parse the delimiter after `<<` (`EOF`, `-EOF`, `'EOF'`, `"EOF"`). */
function readHeredocHeader(command, start) {
  let i = start;
  const strip = command[i] === "-";
  if (strip) i++;
  while (command[i] === " " || command[i] === "\t") i++;
  let delim = "";
  while (i < command.length && !/[\s;|&<>()]/.test(command[i])) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return null;
      delim += command.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\\") {
      delim += command[i + 1] ?? "";
      i += 2;
    } else {
      delim += c;
      i++;
    }
  }
  return delim ? { delim, strip, end: i } : null;
}

/** Read heredoc lines from `pos` up to the delimiter line. */
function readHeredocBody(command, pos, { delim, strip }) {
  const lines = [];
  while (pos < command.length) {
    const eol = command.indexOf("\n", pos);
    const line = command.slice(pos, eol === -1 ? command.length : eol);
    pos = eol === -1 ? command.length : eol + 1;
    if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
    lines.push(line);
  }
  return { text: lines.join("\n"), end: pos };
}

/** Strip wrappers (sudo, env, timeout, xargs, VAR=x, …) and split into command name and args. */
function toSegment(raw) {
  const { words } = raw;
  let viaXargs = false;
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const wrapper = basename(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === "!") {
      i++;
    } else if (Object.hasOwn(WRAPPERS, wrapper)) {
      if (wrapper === "xargs") viaXargs = true;
      i++;
      while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
        if (WRAPPERS[wrapper].includes(words[i])) i++;
        i++;
      }
      if (wrapper === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[i] ?? "")) i++;
    } else break;
  }
  if (i >= words.length) return { ...raw, cmd: null, args: [], viaXargs };
  return { ...raw, cmd: basename(words[i]), args: words.slice(i + 1), viaXargs };
}

function isRecursiveForce(args) {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (a === "--") break;
    if (a === "--recursive") recursive = true;
    else if (a === "--force") force = true;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes("f")) force = true;
    }
  }
  return recursive && force;
}

/** Non-option arguments (everything after `--` counts as an operand). */
function operands(args) {
  const out = [];
  let endOfOptions = false;
  for (const a of args) {
    if (!endOfOptions && a === "--") endOfOptions = true;
    else if (endOfOptions || !a.startsWith("-") || a === "-") out.push(a);
  }
  return out;
}

function isDangerousRmTarget(target) {
  if (/^\/+\*?$/.test(target)) return true; // /, //, /*
  const t = target.length > 1 ? target.replace(/\/+$/, "") : target; // ~/ → ~, ./ → .
  return RM_DANGEROUS.has(t) || /^\.\.(?:\/\.\.)+(?:\/\*)?$/.test(t); // ../.., ../../*
}

// git options that take a separate value before the subcommand.
const GIT_GLOBAL_ARG_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
// git push options that take a separate value.
const PUSH_ARG_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** @returns {{ force: boolean, delete: boolean, refspecs: string[] } | null} */
function parsePush(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GIT_GLOBAL_ARG_FLAGS.has(args[i]) ? 2 : 1;
  if (args[i] !== "push") return null;

  const push = { force: false, delete: false, refspecs: [] };
  const positional = [];
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (a === "--force" || a.startsWith("--force-with-lease")) push.force = true;
    else if (a === "--delete") push.delete = true;
    else if (PUSH_ARG_FLAGS.has(a)) j++;
    else if (a.startsWith("--")) continue;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      push.force ||= a.includes("f");
      push.delete ||= a.includes("d");
    } else positional.push(a);
  }
  push.refspecs = positional.slice(1); // the first positional is the remote
  return push;
}

/**
 * Destination branches of a push. No refspec, or a `HEAD` destination, means
 * the current branch (read lazily; unknown → null, which never matches).
 * @returns {{ plus: boolean, src: string, dst: string | null }[]}
 */
function pushTargets(push, ctx) {
  if (push.refspecs.length === 0) return [{ plus: false, src: "HEAD", dst: ctx.branch() }];
  return push.refspecs.map((ref) => {
    const plus = ref.startsWith("+");
    const body = plus ? ref.slice(1) : ref;
    const colon = body.indexOf(":");
    const src = colon === -1 ? body : body.slice(0, colon);
    let dst = colon === -1 ? body : body.slice(colon + 1);
    if (dst === "HEAD") dst = ctx.branch();
    return { plus, src, dst };
  });
}

function isProtectedBranch(dst) {
  return typeof dst === "string" && PROTECTED_BRANCHES.has(dst.replace(/^refs\/heads\//, ""));
}

function basename(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}

function show(segments) {
  return segments.map((s) => [...s.words, ...(s.heredocs.length ? ["<<…"] : [])].join(" ")).join(" | ");
}

function clip(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}
