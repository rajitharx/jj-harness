// Deny destructive or irreversible shell commands (rm -rf /, force push to main, curl | sh, DROP DATABASE...) plus config.blockedCommands.
// Best-effort pattern matching over a quote-aware split of the command, not a sandbox.

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "mongosh"]);
// Wrappers that run the rest of the line as a command.
const PREFIXES = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice"]);
const PREFIX_ARG_FLAGS = new Set(["-u", "-g", "-n"]); // sudo -u user, nice -n 10
const RM_DANGEROUS = new Set(["/", "/*", "~", "~/*", "$HOME", "${HOME}", "$HOME/*", "${HOME}/*", "*", ".", "..", "./*", "../*"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * The rule table. `scope` says what `test` receives:
 * - "command":  the raw command string
 * - "pipeline": an array of segments joined by `|` (a pipeline between `&&`, `||`, `;`, `&`, newlines)
 * - "segment":  { cmd, args } of one simple command, with sudo/env wrappers stripped
 * @type {{ scope: "command"|"pipeline"|"segment", test: (x: any) => boolean, reason: string }[]}
 */
const RULES = [
  {
    scope: "segment",
    test: ({ cmd, args }) => cmd === "rm" && isRecursiveForce(args) && operands(args).some(isDangerousRmTarget),
    reason:
      "recursive force-delete of /, home, the working directory or a bare glob is irreversible. Delete the specific paths you mean instead (e.g. `rm -rf ./dist ./node_modules`).",
  },
  {
    scope: "segment",
    test: ({ cmd, args }) => cmd === "git" && isForcePushToProtected(args),
    reason:
      "force-pushing to main/master rewrites shared history. Push to a feature branch and open a PR, or use `git revert` to undo commits on main.",
  },
  {
    scope: "pipeline",
    test: (segments) => {
      const i = segments.findIndex((s) => DOWNLOADERS.has(s.cmd));
      return i !== -1 && segments.slice(i + 1).some((s) => SHELLS.has(s.cmd));
    },
    reason:
      "piping a download straight into a shell runs unreviewed remote code. Download to a file, inspect it, then run it (e.g. `curl -fsSLo install.sh <url> && less install.sh`).",
  },
  {
    scope: "command",
    test: (cmd) =>
      /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|source|\.)\s+<\(\s*(?:curl|wget)\b/.test(cmd) ||
      /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh\s+-c|eval)\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/.test(cmd),
    reason:
      "running a download through a shell runs unreviewed remote code. Download to a file, inspect it, then run it.",
  },
  {
    scope: "pipeline",
    test: (segments) =>
      segments.some((s) => [s.cmd, ...s.args].some((w) => DB_CLIENTS.has(basename(w)))) &&
      /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\b|\bdropDatabase\s*\(/i.test(
        segments.map((s) => [s.cmd, ...s.args].join(" ")).join(" | "),
      ),
    reason:
      "destructive SQL (DROP DATABASE/SCHEMA/TABLE, TRUNCATE) sent to a database client. Write a reviewed migration, or ask the user to run it themselves.",
  },
  {
    scope: "segment",
    test: ({ cmd }) => /^mkfs(?:\.|$)/.test(cmd),
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
    test: (cmd) => /([\w:]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1/.test(cmd),
    reason: "this is a fork bomb, which exhausts the machine's processes. Don't run it.",
  },
];

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function guardBash(input, config) {
  if (input.tool_name !== "Bash") return { kind: "allow" };
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") return { kind: "allow" };

  const hit = check(command, 0);
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

/** @returns {{ reason: string, text: string } | null} */
function check(command, depth) {
  for (const rule of RULES) {
    if (rule.scope === "command" && rule.test(command)) return { reason: rule.reason, text: command };
  }
  for (const pipeline of parse(command)) {
    for (const rule of RULES) {
      if (rule.scope === "pipeline" && rule.test(pipeline)) return { reason: rule.reason, text: show(pipeline) };
    }
    for (const segment of pipeline) {
      for (const rule of RULES) {
        if (rule.scope === "segment" && rule.test(segment)) return { reason: rule.reason, text: show([segment]) };
      }
      // `bash -c "…"` and `eval "…"` run a nested command line; check it too.
      const nested = nestedCommand(segment);
      if (nested && depth < 3) {
        const hit = check(nested, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function nestedCommand({ cmd, args }) {
  if (cmd === "eval") return args.join(" ");
  if (SHELLS.has(cmd)) {
    const i = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

/**
 * Split a command line into pipelines of simple commands. Quote-aware: quotes
 * are removed from words, and separators inside quotes are ordinary text.
 * Parentheses and backticks are treated as separators so subshells and
 * command substitutions are checked as their own commands.
 * @returns {{ cmd: string, args: string[] }[][]}
 */
function parse(command) {
  /** @type {string[][][]} */
  const pipelines = [[[]]];
  let word = null;
  let quote = null;
  const flushWord = () => {
    if (word !== null) pipelines.at(-1).at(-1).push(word);
    word = null;
  };
  const newSegment = () => (flushWord(), pipelines.at(-1).push([]));
  const newPipeline = () => (flushWord(), pipelines.push([[]]));

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && next !== undefined) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && next !== undefined) {
      if (next === "\n") i++; // line continuation
      else word = (word ?? "") + command[++i];
    } else if (/\s/.test(c) && c !== "\n") {
      flushWord();
    } else if (c === "|") {
      if (next === "|") (i++, newPipeline());
      else {
        if (next === "&") i++;
        newSegment();
      }
    } else if (c === "&") {
      const prev = command[i - 1];
      if (next === "&") (i++, newPipeline());
      else if (prev === ">" || prev === "<" || next === ">") word = (word ?? "") + c; // 2>&1, &>file
      else newPipeline();
    } else if (c === ";" || c === "\n" || c === "(" || c === ")" || c === "`" || c === "{" || c === "}") {
      // `{`/`}` only group commands as whole words; inside a word (${HOME}) they are text.
      if ((c === "{" || c === "}") && word !== null && word !== "") word += c;
      else if (c === "{" && word === null && next !== undefined && !/\s/.test(next)) word = c;
      else newPipeline();
    } else {
      word = (word ?? "") + c;
    }
  }
  flushWord();

  return pipelines
    .map((segments) => segments.map(toSegment).filter(Boolean))
    .filter((segments) => segments.length > 0);
}

/** Strip wrappers (sudo, env, VAR=x, …) and split into command name and args. */
function toSegment(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === "!") {
      i++;
    } else if (PREFIXES.has(basename(w))) {
      i++;
      while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
        if (PREFIX_ARG_FLAGS.has(words[i])) i++;
        i++;
      }
    } else break;
  }
  if (i >= words.length) return null;
  return { cmd: basename(words[i]), args: words.slice(i + 1) };
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
  return RM_DANGEROUS.has(t);
}

// git options that take a separate value before the subcommand.
const GIT_GLOBAL_ARG_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
// git push options that take a separate value.
const PUSH_ARG_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function isForcePushToProtected(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GIT_GLOBAL_ARG_FLAGS.has(args[i]) ? 2 : 1;
  if (args[i] !== "push") return false;

  let force = false;
  const positional = [];
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (a === "--force" || a.startsWith("--force-with-lease")) force = true;
    else if (PUSH_ARG_FLAGS.has(a)) j++;
    else if (a.startsWith("--")) continue;
    else if (/^-[a-zA-Z]+$/.test(a)) force ||= a.includes("f");
    else positional.push(a);
  }
  return positional.some((ref) => {
    const plus = ref.startsWith("+");
    const dst = (plus ? ref.slice(1) : ref).split(":").at(-1).replace(/^refs\/heads\//, "");
    return PROTECTED_BRANCHES.has(dst) && (force || plus);
  });
}

function basename(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}

function show(segments) {
  return segments.map((s) => [s.cmd, ...s.args].join(" ")).join(" | ");
}

function clip(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}
