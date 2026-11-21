// Zero-dependency glob matching on root-relative POSIX paths. Shared by
// guard-paths (protectedPaths) and lib/verify.mjs (per-command file filters).

const cache = new Map();

/**
 * Compile a glob to an anchored RegExp. Supports `**` (any number of path
 * segments, as a whole segment), `*` (any run of non-`/` characters), `?`
 * (one non-`/` character). Wildcards match dot-files. Everything else is literal.
 * Matching ignores case, because macOS and Windows filesystems usually do:
 * `.ENV` is the same file as `.env` there.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = cache.get(glob);
  if (re) return re;
  const segments = glob.split("/");
  let src = "";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") {
      src += last ? ".*" : "(?:[^/]*/)*";
      return;
    }
    for (const c of seg) {
      if (c === "*") src += "[^/]*";
      else if (c === "?") src += "[^/]";
      else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    if (!last) src += "/";
  });
  re = new RegExp(`^${src}$`, "i");
  cache.set(glob, re);
  return re;
}

/**
 * The first glob in `globs` that matches `path`, or undefined.
 * @param {string} path  POSIX path.
 * @param {readonly string[]} globs
 * @returns {string|undefined}
 */
export function matchGlob(path, globs) {
  return globs.find((g) => globToRegExp(g).test(path));
}
