import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getChangedFileReferenceCounts, getChangedFileReferenceGraph, getReviewWindowData, getSubmoduleReviewWindowData, isReviewableFilePath, loadReviewFileContents, mergeChangedPaths, parseJjGitDiffStats, parseJjStatTotals, parseJjSummary, parseNameStatus, parseNumStat, parseRawDiff, parseUntrackedPaths } from "../git.js";

const execFileAsync = promisify(execFile);

async function runGit(repoRoot: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoRoot });
}

async function runJj(repoRoot: string, args: string[]): Promise<void> {
  await execFileAsync("jj", args, { cwd: repoRoot });
}

async function jjAvailable(): Promise<boolean> {
  try {
    await execFileAsync("jj", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const hasJj = await jjAvailable();

async function createGitRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-git-test-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await writeFile(join(repoRoot, "README.md"), "initial\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function createJjRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-jj-test-"));
  await runJj(repoRoot, ["git", "init"]);
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await writeFile(join(repoRoot, "README.md"), "line1\nline2\n", "utf8");
  await writeFile(join(repoRoot, "notes.txt"), "note\n", "utf8");
  await writeFile(join(repoRoot, "src/app.ts"), "export const app = true;\n", "utf8");
  await runJj(repoRoot, ["describe", "-m", "initial"]);
  await runJj(repoRoot, ["bookmark", "create", "main", "-r", "@"]);
  await runJj(repoRoot, ["new"]);
  return repoRoot;
}

function createExecPi() {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      try {
        const result = await execFileAsync(command, args, { cwd: options?.cwd });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { code: typeof execError.code === "number" ? execError.code : 1, stdout: execError.stdout ?? "", stderr: execError.stderr ?? execError.message };
      }
    },
  };
}

describe("git helpers", () => {
  it("parses modified, added, deleted, and renamed files", () => {
    const output = [
      "M\tsrc/app.ts",
      "A\tREADME.md",
      "D\told.txt",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
    ].join("\n");

    expect(parseNameStatus(output)).toEqual([
      { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts" },
      { status: "added", oldPath: null, newPath: "README.md" },
      { status: "deleted", oldPath: "old.txt", newPath: null },
      { status: "renamed", oldPath: "src/old-name.ts", newPath: "src/new-name.ts" },
    ]);
  });

  it("merges tracked and untracked changes without duplicates", () => {
    const tracked = [{ status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" }];
    const untracked = [
      { status: "added" as const, oldPath: null, newPath: "src/new.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
    ];

    expect(mergeChangedPaths(tracked, untracked)).toEqual([
      { status: "modified", oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "added", oldPath: null, newPath: "src/new.ts" },
    ]);
  });

  it("parses untracked paths", () => {
    expect(parseUntrackedPaths("src/new.ts\nnotes.md\n")).toEqual([
      { status: "added", oldPath: null, newPath: "src/new.ts" },
      { status: "added", oldPath: null, newPath: "notes.md" },
    ]);
  });

  it("parses numstat additions and deletions", () => {
    expect(parseNumStat("12\t3\tsrc/app.ts\n-\t-\tassets/generated.bin\n")).toEqual(new Map([
      ["src/app.ts", { additions: 12, deletions: 3 }],
      ["assets/generated.bin", { additions: 0, deletions: 0 }],
    ]));
  });

  it("parses raw submodule gitlink changes with old and new commits", () => {
    const output = ":160000 160000 abc1234 def5678 M\0packages/app\0";

    expect(parseRawDiff(output)).toEqual([
      {
        status: "modified",
        oldPath: "packages/app",
        newPath: "packages/app",
        oldMode: "160000",
        newMode: "160000",
        oldSha: "abc1234",
        newSha: "def5678",
      },
    ]);
  });

  it("builds nested submodule review data from the explicit parent gitlink range", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "diff --find-renames -M --name-status old-sha new-sha --") return { code: 0, stdout: "M\tsrc/app.ts\n", stderr: "" };
      if (joined === "diff --find-renames -M --raw -z old-sha new-sha --") return { code: 0, stdout: "", stderr: "" };
      if (joined === "diff --find-renames -M --numstat old-sha new-sha --") return { code: 0, stdout: "4\t2\tsrc/app.ts\n", stderr: "" };
      if (joined === "show new-sha:src/app.ts") return { code: 0, stdout: "export const app = true;\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    const data = await getSubmoduleReviewWindowData({ exec } as never, "/repo/packages/app", "old-sha", "new-sha");

    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({
      path: "src/app.ts",
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      allFiles: {
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        originalRevision: "old-sha",
        modifiedRevision: "new-sha",
        additions: 4,
        deletions: 2,
      },
    });
  });

  it("loads explicit range contents from comparison revisions", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "show old-sha:src/app.ts") return { code: 0, stdout: "old\n", stderr: "" };
      if (joined === "show new-sha:src/app.ts") return { code: 0, stdout: "new\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    await expect(loadReviewFileContents({ exec } as never, "/repo/packages/app", {
      id: "src/app.ts",
      path: "src/app.ts",
      worktreeStatus: null,
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      gitDiff: null,
      lastCommit: null,
      allFiles: {
        status: "modified",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        displayPath: "src/app.ts",
        hasOriginal: true,
        hasModified: true,
        originalRevision: "old-sha",
        modifiedRevision: "new-sha",
      },
    }, "all-files")).resolves.toEqual({ originalContent: "old\n", modifiedContent: "new\n" });
  });

  it("marks large untracked files with compact review metadata", async () => {
    const repoRoot = await createGitRepo();
    try {
      await writeFile(join(repoRoot, "large.md"), `${"line\n".repeat(20_001)}`, "utf8");

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      const file = data.files.find((entry) => entry.path === "large.md");

      expect(file?.gitDiff).toMatchObject({
        status: "added",
        additions: 20_001,
        deletions: 0,
        isTooLarge: true,
        statsTruncated: true,
      });
      await expect(loadReviewFileContents(createExecPi() as never, repoRoot, file!, "git-diff")).resolves.toEqual({ originalContent: "", modifiedContent: "" });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("marks tracked diffs over the changed-line limit as compact placeholders", async () => {
    const repoRoot = await createGitRepo();
    try {
      await writeFile(join(repoRoot, "large.md"), `${"line\n".repeat(20_001)}`, "utf8");
      await runGit(repoRoot, ["add", "large.md"]);

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      const file = data.files.find((entry) => entry.path === "large.md");

      expect(file?.gitDiff).toMatchObject({
        status: "added",
        additions: 20_001,
        deletions: 0,
        isTooLarge: true,
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("counts changed files referenced by other changed files", () => {
    const changes = [
      { status: "added" as const, oldPath: null, newPath: "src/root.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "modified" as const, oldPath: "src/nested/b.ts", newPath: "src/nested/b.ts" },
    ];
    const contents = new Map([
      ["src/a.ts", "import { root } from './root';\n"],
      ["src/nested/b.ts", "export { root } from '../root';\n"],
    ]);

    expect(getChangedFileReferenceCounts(changes, contents).get("src/root.ts")).toBe(2);
    const graph = getChangedFileReferenceGraph(changes, contents);
    expect(graph.outgoing.get("src/a.ts")).toEqual(["src/root.ts"]);
    expect(graph.incoming.get("src/root.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("filters obvious binary or minified assets", () => {
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
    expect(isReviewableFilePath("assets/logo.png")).toBe(false);
    expect(isReviewableFilePath("dist/app.min.js")).toBe(false);
  });

  it("parses jj summary lines including brace-notation renames", () => {
    const output = [
      "A src/new.ts",
      "M has space.txt",
      "D old.txt",
      "R {dir1 => dir2}/f1.txt",
      "R {top.txt => dir2/top.txt}",
      "R {README.md => README2.md}",
    ].join("\n");

    expect(parseJjSummary(output)).toEqual([
      { status: "added", oldPath: null, newPath: "src/new.ts" },
      { status: "modified", oldPath: "has space.txt", newPath: "has space.txt" },
      { status: "deleted", oldPath: "old.txt", newPath: null },
      { status: "renamed", oldPath: "dir1/f1.txt", newPath: "dir2/f1.txt" },
      { status: "renamed", oldPath: "top.txt", newPath: "dir2/top.txt" },
      { status: "renamed", oldPath: "README.md", newPath: "README2.md" },
    ]);
  });

  it("parses jj stat totals keyed by target path", () => {
    const output = [
      "{README.md => README2.md} | 0",
      "src/app.ts                | 4 ----",
      "has space.txt             | 2 ++",
      "4 files changed, 7 insertions(+), 4 deletions(-)",
    ].join("\n");

    expect(parseJjStatTotals(output)).toEqual(new Map([
      ["README2.md", 0],
      ["src/app.ts", 4],
      ["has space.txt", 2],
    ]));
  });

  it("counts additions and deletions from jj git-style patches", () => {
    const output = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index cc798ff50d..66d48fc1e6 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "diff --git a/src/c.ts b/src/c.ts",
      "new file mode 100644",
      "index 0000000000..fa49b07797",
      "--- /dev/null",
      "+++ b/src/c.ts",
      "@@ -0,0 +1,1 @@",
      "+new file",
      "diff --git a/notes.txt b/docs/notes.txt",
      "similarity index 100%",
      "rename from notes.txt",
      "rename to docs/notes.txt",
    ].join("\n");

    expect(parseJjGitDiffStats(output)).toEqual(new Map([
      ["src/a.ts", { additions: 1, deletions: 1 }],
      ["src/c.ts", { additions: 1, deletions: 0 }],
      ["docs/notes.txt", { additions: 0, deletions: 0 }],
    ]));
  });

  it.skipIf(!hasJj)("builds review windows and contents for a jj repo", async () => {
    const repoRoot = await createJjRepo();
    try {
      await mkdir(join(repoRoot, "src"), { recursive: true });
      await mkdir(join(repoRoot, "docs"), { recursive: true });
      await writeFile(join(repoRoot, "src/committed.ts"), "export const committed = true;\n", "utf8");
      await runJj(repoRoot, ["commit", "-m", "completed feature"]);

      await writeFile(join(repoRoot, "README.md"), "line1\nline2\nline3\n", "utf8");
      await writeFile(join(repoRoot, "src/new.ts"), "export const newValue = 1;\n", "utf8");
      await writeFile(join(repoRoot, "docs/notes.txt"), "note\n", "utf8");
      await rm(join(repoRoot, "notes.txt"), { force: true });
      await rm(join(repoRoot, "src/app.ts"), { force: true });

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      expect(data.vcs).toBe("jj");
      const byPath = new Map(data.files.map((file) => [file.path, file]));

      const readme = byPath.get("README.md")!;
      expect(readme.inGitDiff).toBe(true);
      expect(readme.inAllFiles).toBe(false);
      expect(readme.gitDiff).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
      expect(readme.allFiles).toBeNull();

      const newFile = byPath.get("src/new.ts")!;
      expect(newFile.gitDiff).toMatchObject({ status: "added", additions: 1, deletions: 0 });
      expect(newFile.inAllFiles).toBe(false);

      const renamed = byPath.get("docs/notes.txt")!;
      expect(renamed.gitDiff).toMatchObject({
        status: "renamed",
        oldPath: "notes.txt",
        newPath: "docs/notes.txt",
        additions: 0,
        deletions: 0,
      });

      const deleted = byPath.get("src/app.ts")!;
      expect(deleted.gitDiff).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });

      const completed = byPath.get("src/committed.ts")!;
      expect(completed.inGitDiff).toBe(false);
      expect(completed.inLastCommit).toBe(true);
      expect(completed.inAllFiles).toBe(true);
      expect(completed.lastCommit).toMatchObject({ status: "added", additions: 1, deletions: 0 });
      expect(completed.allFiles).toMatchObject({ status: "added", additions: 1, deletions: 0, modifiedRevision: "@-" });

      const readmeDiff = await loadReviewFileContents(createExecPi() as never, repoRoot, readme, "git-diff");
      expect(readmeDiff).toEqual({ originalContent: "line1\nline2\n", modifiedContent: "line1\nline2\nline3\n" });

      const renamedDiff = await loadReviewFileContents(createExecPi() as never, repoRoot, renamed, "git-diff");
      expect(renamedDiff).toEqual({ originalContent: "note\n", modifiedContent: "note\n" });

      const lastCommitDiff = await loadReviewFileContents(createExecPi() as never, repoRoot, completed, "last-commit");
      expect(lastCommitDiff).toEqual({ originalContent: "", modifiedContent: "export const committed = true;\n" });

      const allFilesDiff = await loadReviewFileContents(createExecPi() as never, repoRoot, completed, "all-files");
      expect(allFilesDiff).toEqual({ originalContent: "", modifiedContent: "export const committed = true;\n" });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJj)("does not invent directional stats for large jj diffs", async () => {
    const repoRoot = await createJjRepo();
    try {
      await writeFile(join(repoRoot, "large.md"), "line\n".repeat(20_001), "utf8");
      await runJj(repoRoot, ["commit", "-m", "add large file"]);
      await rm(join(repoRoot, "large.md"));

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      const comparison = data.files.find((file) => file.path === "large.md")?.gitDiff;

      expect(comparison).toMatchObject({ status: "deleted", isTooLarge: true });
      expect(comparison?.additions).toBeUndefined();
      expect(comparison?.deletions).toBeUndefined();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJj)("resolves a remote-only jj default bookmark for the completed stack", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "pi-slopchop-jj-remote-"));
    const remote = join(sandbox, "remote.git");
    const seed = join(sandbox, "seed");
    const repoRoot = join(sandbox, "repo");
    try {
      await execFileAsync("git", ["init", "--bare", remote]);
      await execFileAsync("git", ["init", seed]);
      await runGit(seed, ["config", "user.email", "test@example.com"]);
      await runGit(seed, ["config", "user.name", "Test User"]);
      await writeFile(join(seed, "README.md"), "initial\n", "utf8");
      await runGit(seed, ["add", "README.md"]);
      await runGit(seed, ["commit", "-m", "initial"]);
      await runGit(seed, ["branch", "-M", "main"]);
      await runGit(seed, ["push", remote, "main"]);
      await runGit(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      await execFileAsync("jj", ["git", "clone", "--no-colocate", remote, repoRoot]);
      await runJj(repoRoot, ["bookmark", "delete", "main"]);
      await runJj(repoRoot, ["config", "unset", "--repo", "revset-aliases.\"trunk()\""]);

      await writeFile(join(repoRoot, "completed.ts"), "export const completed = true;\n", "utf8");
      await runJj(repoRoot, ["commit", "-m", "completed feature"]);
      await writeFile(join(repoRoot, "wip.ts"), "export const wip = true;\n", "utf8");

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      const completed = data.files.find((file) => file.path === "completed.ts")!;
      const wip = data.files.find((file) => file.path === "wip.ts")!;
      expect(completed.inAllFiles).toBe(true);
      expect(completed.allFiles?.modifiedRevision).toBe("@-");
      expect(wip.inGitDiff).toBe(true);
      expect(wip.inAllFiles).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJj)("treats files in a fresh jj repo as working copy additions", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-jj-fresh-"));
    try {
      await runJj(repoRoot, ["git", "init"]);
      await writeFile(join(repoRoot, "a.txt"), "a\n", "utf8");

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      expect(data.files.length).toBeGreaterThan(0);
      const file = data.files.find((entry) => entry.path === "a.txt");
      expect(file?.inGitDiff).toBe(true);
      expect(file?.gitDiff).toMatchObject({ status: "added", additions: 1, deletions: 0 });

      const contents = await loadReviewFileContents(createExecPi() as never, repoRoot, file!, "git-diff");
      expect(contents).toEqual({ originalContent: "", modifiedContent: "a\n" });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJj)("returns no files for an empty jj repo", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-jj-empty-"));
    try {
      await runJj(repoRoot, ["git", "init"]);
      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      expect(data.files).toEqual([]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
