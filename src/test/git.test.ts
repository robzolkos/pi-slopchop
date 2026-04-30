import { describe, expect, it } from "vitest";
import { getChangedFileReferenceCounts, getChangedFileReferenceGraph, isReviewableFilePath, mergeChangedPaths, parseNameStatus, parseNumStat, parseUntrackedPaths } from "../git.js";

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
});
