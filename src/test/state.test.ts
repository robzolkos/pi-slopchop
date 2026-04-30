import { describe, expect, it } from "vitest";
import {
  clampSelectedLineTarget,
  createInitialReviewState,
  getDefaultScope,
  getFileComment,
  getFilteredFiles,
  getLineComment,
  getScopedFiles,
  moveActiveFile,
  setScope,
  setSearchQuery,
  upsertFileComment,
  upsertLineComment,
} from "../state.js";
import type { ReviewFile } from "../types.js";

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    ...flags,
  };
}

describe("review state", () => {
  it("picks git diff as the default scope when available", () => {
    expect(getDefaultScope([
      makeFile("src/a.ts", { inGitDiff: true }),
      makeFile("src/b.ts", { inGitDiff: false, inLastCommit: true }),
    ])).toBe("git-diff");
  });

  it("prefers all changed files over the last commit when there is no worktree diff", () => {
    expect(getDefaultScope([
      makeFile("src/a.ts", { inGitDiff: false, inAllFiles: true }),
      makeFile("src/b.ts", { inGitDiff: false, inLastCommit: true }),
    ])).toBe("all-files");
  });

  it("orders all-files changes by review priority", () => {
    const makeAllFile = (path: string, status: "modified" | "added" | "deleted", references = 0) => makeFile(path, {
      inGitDiff: false,
      inAllFiles: true,
      allFilesReferenceCount: references,
      allFiles: {
        status,
        oldPath: status === "added" ? null : path,
        newPath: status === "deleted" ? null : path,
        displayPath: path,
        hasOriginal: status !== "added",
        hasModified: status !== "deleted",
      },
    });

    const files = [
      makeAllFile("docs/readme.md", "added"),
      makeAllFile("src/new.ts", "added"),
      makeAllFile("src/feature.ts", "modified"),
      makeAllFile("src/root.ts", "added", 2),
    ];

    expect(getScopedFiles(files, "all-files").map((file) => file.path)).toEqual([
      "src/root.ts",
      "src/feature.ts",
      "src/new.ts",
      "docs/readme.md",
    ]);
  });

  it("switches scopes and keeps selection valid", () => {
    const files = [
      makeFile("src/a.ts", { inGitDiff: true, inLastCommit: false }),
      makeFile("src/b.ts", { inGitDiff: false, inLastCommit: true }),
    ];
    let state = createInitialReviewState(files);
    state = setScope(state, files, "last-commit");
    expect(state.activeFileId).toBe("src/b.ts");
  });

  it("enforces one line comment per file+scope+side+line", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = upsertLineComment(state, "src/a.ts", "git-diff", "added", 12, "First");
    state = upsertLineComment(state, "src/a.ts", "git-diff", "added", 12, "Second");
    state = upsertLineComment(state, "src/a.ts", "git-diff", "deleted", 12, "Removed note");

    expect(state.draft.comments).toHaveLength(2);
    expect(getLineComment(state, "src/a.ts", "git-diff", "added", 12)?.body).toBe("Second");
    expect(getLineComment(state, "src/a.ts", "git-diff", "added", 12)?.intent).toBe("fix");
    expect(getLineComment(state, "src/a.ts", "git-diff", "deleted", 12)?.body).toBe("Removed note");
  });

  it("enforces one file comment per file+scope", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = upsertFileComment(state, "src/a.ts", "git-diff", "One", "discuss");
    state = upsertFileComment(state, "src/a.ts", "git-diff", "Two", "fix");

    expect(state.draft.comments).toHaveLength(1);
    expect(getFileComment(state, "src/a.ts", "git-diff")?.body).toBe("Two");
    expect(getFileComment(state, "src/a.ts", "git-diff")?.intent).toBe("fix");
  });

  it("filters files using search query", () => {
    const files = [makeFile("src/button.ts"), makeFile("src/input.ts")];
    let state = createInitialReviewState(files);
    state = setSearchQuery(state, files, "but");
    expect(getFilteredFiles(files, state).map((file) => file.path)).toEqual(["src/button.ts"]);
  });

  it("moves active file within filtered results", () => {
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")];
    let state = createInitialReviewState(files);
    state = moveActiveFile(state, files, 1);
    expect(state.activeFileId).toBe("src/b.ts");
  });

  it("clamps selected line target to a visible target", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = clampSelectedLineTarget(state, "src/a.ts", "git-diff", [{ side: "deleted", line: 4 }, { side: "added", line: 8 }]);
    expect(state.selectedLineTargetByScopeFile["git-diff::src/a.ts"]).toEqual({ side: "deleted", line: 4 });
  });
});
