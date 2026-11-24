---
name: ship
description: Commit the current work and open a pull request safely - refuses on main/master, runs verify first, never stages protected files, writes a conventional commit, pushes and runs gh pr create. Use when the user says "ship it", "commit and open a PR" or "make a PR".
---

# ship

## Steps

1. **Check the branch.** Run `git rev-parse --abbrev-ref HEAD`. If it is `main` or `master` (or `HEAD`, detached), stop: tell the user to create a branch first, and offer to run `git switch -c <type>/<short-slug>` for them.

2. **Verify**, before committing. Find the base branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, strip `origin/`, falling back to `main`, then `master`) and run the verify CLI (it lives in this plugin, two levels above this skill's base directory, which you were told when the skill loaded):

   ```sh
   node "<skill base dir>/../../bin/harness.mjs" verify --base <base branch>
   ```

   `--base` checks the branch's earlier commits as well as the uncommitted work you're about to commit. Without it, commits already on the branch would go unchecked. If it exits non-zero, stop and report the failing stage and its output exactly. Don't commit with failing checks. `verify: nothing ran` (exit 0) means no checks executed: tell the user so rather than calling it a pass. If the changed behaviour has no tests at all, tell the user and offer to run the `harness:test-writer` agent first.

3. **Choose what to stage.** Show `git status --short`. Stage files by explicit path (`git add -- <path> ...`); never `git add -A`, `git add .` or `git commit -a`. Never stage a file that matches a protected path: the defaults are `.env`, `.env.*`, `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `**/id_ed25519*`, `.git/**` and `**/.git/**`, plus every pattern in `protectedPaths` in `.harness/config.json` (a path matching `allowPaths` there is exempt). If such a file is changed, leave it unstaged and tell the user. Ask before staging files that look unrelated to the change.

4. **Commit** with a conventional-commit message: `type(scope): summary` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, …), a summary under about 72 characters, and a body that says what changed and why. Follow `CLAUDE.md` for anything the project requires, such as a trailer.

5. **Push and open the PR.**
   - `git push -u origin HEAD`.
   - Look for a PR template: `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/*.md`, `docs/pull_request_template.md` or `pull_request_template.md`. If one exists, fill in its sections; otherwise write a summary, what changed, and how it was verified (quote the verify result).
   - `gh pr create --base <base branch> --title "<title>" --body-file <file>`, then show the PR URL.

## Never

- Never force-push (`--force`, `-f`, `--force-with-lease`, `+refspec`).
- Never merge the PR, and never push to `main`/`master` directly.
- Never skip hooks (`--no-verify`) or stage protected files.
