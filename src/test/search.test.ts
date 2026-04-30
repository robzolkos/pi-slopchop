import { describe, expect, it } from "vitest";
import { filterFilesBySearch, getFileSearchScore, normalizeQuery } from "../search.js";
import type { ReviewFile } from "../types.js";

function makeFile(path: string): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: true,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
  };
}

describe("search helpers", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeQuery("  Foo Bar ")).toBe("foobar");
  });

  it("preserves caller order for empty queries", () => {
    const files = [makeFile("src/b.ts"), makeFile("src/a.ts")];
    expect(filterFilesBySearch(files, "").map((file) => file.path)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("ranks basename prefix matches ahead of loose path matches", () => {
    const files = [
      makeFile("src/components/button.ts"),
      makeFile("src/features/forms/input-controller.ts"),
      makeFile("docs/button-guidelines.md"),
    ];

    const filtered = filterFilesBySearch(files, "but");
    expect(filtered.map((file) => file.path)).toEqual([
      "src/components/button.ts",
      "docs/button-guidelines.md",
    ]);
  });

  it("returns -1 for non-matches", () => {
    expect(getFileSearchScore("zzz", makeFile("src/button.ts"))).toBe(-1);
  });
});
