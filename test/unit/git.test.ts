import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getChangedFiles } from "../../src/core/git";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const rel = (files: string[]) => files.map((f) => path.relative(dir, f).split(path.sep).join("/")).sort();

function initRepo(branch = "main") {
  git("init", "-q", "-b", branch);
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-ready-git-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("getChangedFiles", () => {
  it("reports no-git outside a repository", async () => {
    const r = await getChangedFiles(dir);
    expect(r.kind).toBe("no-git");
  });

  it("collects committed (since merge-base), staged, unstaged and untracked files", async () => {
    initRepo();
    write("a.ts", "1");
    write("d.js", "1");
    write("gone.ts", "1");
    write("later-on-main.ts", "1");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    write("a.ts", "2");
    write("sub dir/é.rs", "x");
    git("add", ".");
    git("commit", "-qm", "feature work");
    git("rm", "-q", "gone.ts");
    git("commit", "-qm", "rm");
    git("checkout", "-q", "main");
    write("later-on-main.ts", "2");
    git("commit", "-qam", "main moves on");
    git("checkout", "-q", "feature");
    write("c.java", "x");
    git("add", "c.java");
    write("d.js", "2");
    write("new.rs", "untracked");
    const r = await getChangedFiles(dir);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.base).toBe("main");
    expect(rel(r.files)).toEqual(["a.ts", "c.java", "d.js", "new.rs", "sub dir/é.rs"]);
  });

  it("works on a detached HEAD", async () => {
    initRepo();
    write("a.ts", "1");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    write("b.ts", "1");
    git("add", ".");
    git("commit", "-qm", "b");
    git("checkout", "-q", "--detach", "HEAD");
    const r = await getChangedFiles(dir);
    expect(r.kind === "ok" && rel(r.files)).toEqual(["b.ts"]);
  });

  it("falls back to master, then origin/HEAD", async () => {
    initRepo("master");
    write("a.ts", "1");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "f");
    write("b.ts", "1");
    git("add", ".");
    git("commit", "-qm", "b");
    let r = await getChangedFiles(dir);
    expect(r.kind === "ok" && r.base).toBe("master");

    const clone = dir + "-clone";
    execFileSync("git", ["clone", "-q", dir, clone]);
    try {
      execFileSync("git", ["checkout", "-qb", "work"], { cwd: clone });
      // the clone checked out "f" (the origin HEAD); with no local main/master, origin/HEAD is used
      execFileSync("git", ["branch", "-D", "f"], { cwd: clone, stdio: "ignore" });
      fs.writeFileSync(path.join(clone, "c.ts"), "1");
      r = await getChangedFiles(clone);
      expect(r.kind === "ok" && r.base).toBe("origin/HEAD");
      expect(r.kind === "ok" && r.files.map((f) => path.basename(f))).toEqual(["c.ts"]);
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });

  it("uses a configured base branch", async () => {
    initRepo();
    write("a.ts", "1");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "develop");
    write("b.ts", "1");
    git("add", ".");
    git("commit", "-qm", "b");
    git("checkout", "-qb", "f");
    write("c.ts", "1");
    git("add", ".");
    git("commit", "-qm", "c");
    const r = await getChangedFiles(dir, { baseBranch: "develop" });
    expect(r.kind === "ok" && rel(r.files)).toEqual(["c.ts"]);
    const bad = await getChangedFiles(dir, { baseBranch: "nope" });
    expect(bad.kind === "ok" && bad.note).toMatch(/nope/);
  });

  it("without a base branch, reports only uncommitted changes with a note", async () => {
    initRepo("trunk");
    write("a.ts", "1");
    git("add", ".");
    git("commit", "-qm", "base");
    write("a.ts", "2");
    const r = await getChangedFiles(dir);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.base).toBeUndefined();
    expect(r.note).toMatch(/default branch/i);
    expect(rel(r.files)).toEqual(["a.ts"]);
  });

  it("handles a repository with no commits", async () => {
    initRepo();
    write("a.ts", "1");
    write("b.ts", "1");
    git("add", "b.ts");
    const r = await getChangedFiles(dir);
    expect(r.kind === "ok" && rel(r.files)).toEqual(["a.ts", "b.ts"]);
  });

  it("works from a subdirectory and returns absolute paths", async () => {
    initRepo();
    write("pkg/a.ts", "1");
    git("add", ".");
    git("commit", "-qm", "base");
    write("pkg/a.ts", "2");
    const r = await getChangedFiles(path.join(dir, "pkg"));
    expect(r.kind === "ok" && r.files).toEqual([path.join(dir, "pkg", "a.ts")]);
  });
});
