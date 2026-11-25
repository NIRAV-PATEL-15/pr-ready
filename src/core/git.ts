import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Runs git with the given arguments in cwd and resolves with stdout. Rejects on non-zero exit. */
export type RunGit = (args: string[], cwd: string) => Promise<string>;

export type ChangedFilesResult =
  | { kind: "ok"; root: string; base?: string; files: string[]; note?: string }
  | { kind: "no-git"; message: string };

export interface ChangedFilesOptions {
  /** Branch/ref to compare against; empty = auto-detect (main, master, origin/HEAD, origin/main, origin/master). */
  baseBranch?: string;
  run?: RunGit;
}

const AUTO_BASES = ["main", "master", "origin/HEAD", "origin/main", "origin/master"];

/**
 * Runs git through execFile (never a shell). `core.fsmonitor` is forced off so a repository's
 * own config cannot make these read-only commands start a program.
 */
export const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

export async function getChangedFiles(cwd: string, opts: ChangedFilesOptions = {}): Promise<ChangedFilesResult> {
  const run = opts.run ?? defaultRunGit;
  const tryRun = async (args: string[], dir: string): Promise<string | undefined> => {
    try { return await run(args, dir); } catch { return undefined; }
  };

  let root: string;
  try {
    root = (await run(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { kind: "no-git", message: code === "ENOENT" ? "git was not found on PATH." : "This folder is not inside a git repository." };
  }
  if (!root) return { kind: "no-git", message: "This folder is not inside a git repository." };
  root = path.resolve(root);

  const verify = async (ref: string) => (await tryRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root)) !== undefined;
  const hasHead = await verify("HEAD");

  let base: string | undefined;
  let note: string | undefined;
  const wanted = opts.baseBranch?.trim();
  if (wanted) {
    if (wanted.startsWith("-")) note = `Base branch "${wanted}" is not a valid name; showing only uncommitted changes.`;
    else if (await verify(wanted)) base = wanted;
    else note = `Base branch "${wanted}" was not found; showing only uncommitted changes.`;
  } else {
    for (const b of AUTO_BASES) if (await verify(b)) { base = b; break; }
    if (!base) note = "No default branch (main, master or origin/HEAD) was found; showing only uncommitted changes.";
  }

  let diffFrom: string | undefined = hasHead ? "HEAD" : undefined;
  let usedBase: string | undefined;
  if (hasHead && base) {
    const mb = (await tryRun(["merge-base", "HEAD", base], root))?.trim();
    if (mb) { diffFrom = mb; usedBase = base; }
    else note = `The current branch has no common history with ${base}; showing only uncommitted changes.`;
  }

  const rels = new Set<string>();
  const addZ = (out: string | undefined) => out?.split("\0").forEach((p) => p && rels.add(p));
  if (diffFrom) addZ(await tryRun(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRT", diffFrom, "--"], root));
  addZ(await tryRun(["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRT", "--"], root));
  addZ(await tryRun(["ls-files", "--others", "--exclude-standard", "-z"], root));

  const files = [...rels]
    .map((r) => path.join(root, r))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } })
    .sort();
  return { kind: "ok", root, base: usedBase, files, note };
}
