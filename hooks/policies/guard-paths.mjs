// Deny Edit/Write/MultiEdit/NotebookEdit on config.protectedPaths (.env, keys, .git/...).
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { globToRegExp } from "../../lib/glob.mjs";

const PATH_FIELD = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** @param {object} input @param {import("../../lib/config.mjs").HarnessConfig} config
 *  @returns {Promise<import("../../lib/harness.mjs").Verdict>} */
export async function guardPaths(input, config) {
  const field = PATH_FIELD[input.tool_name];
  const raw = field && input.tool_input?.[field];
  if (typeof raw !== "string" || raw === "") return { kind: "allow" };

  const abs = resolve(input.cwd || config.root, raw.replace(/^~(?=$|[/\\])/, homedir()));
  const rel = relative(config.root, abs);
  const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const candidates = inside ? [toPosix(rel)] : [];
  const absPosix = toPosix(abs);

  for (const pattern of config.protectedPaths) {
    // Outside the project only `**/` patterns are meaningful; match them against the absolute path.
    const subjects = pattern.startsWith("**/") ? [...candidates, absPosix] : candidates;
    if (subjects.some((p) => globToRegExp(pattern).test(p))) {
      return {
        kind: "block",
        reason: `Blocked ${input.tool_name} on ${raw}: it matches the protected path pattern "${pattern}" (config.protectedPaths). Secrets, keys and .git internals are off-limits to the agent. Ask the user to make this change themselves, or read configuration from a non-secret file instead. (A project's .harness/config.json can add protected paths but can't remove the built-in ones: .env files, keys and .git.)`,
      };
    }
  }
  return { kind: "allow" };
}

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}
