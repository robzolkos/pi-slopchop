import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "../diff.js";
import type { ReviewFile } from "../types.js";
import { buildDisplayRows, buildEditorLaunchCommand, getEditorLineForTarget, getHalfPageStep, getPaneLayout, getRelatedFileMarker, getRelatedFilePaths, parseMouseWheelInput } from "../ui/review-app.js";

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: true,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    ...flags,
  };
}

describe("buildDisplayRows", () => {
  it("keeps deleted and added rows independently commentable when line numbers overlap", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    const rowsAtLineTwo = buildDisplayRows(diff).filter((row) => row.displayLineNumber === 2);

    expect(rowsAtLineTwo).toHaveLength(2);
    expect(rowsAtLineTwo.map((row) => ({ kind: row.kind, commentLineNumber: row.commentLineNumber, commentSide: row.commentSide }))).toEqual([
      { kind: "removed", commentLineNumber: 2, commentSide: "deleted" },
      { kind: "context", commentLineNumber: 2, commentSide: "added" },
    ]);
  });
});

describe("getEditorLineForTarget", () => {
  it("maps deleted lines to the nearest surviving working-tree line", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    expect(getEditorLineForTarget(diff, { side: "deleted", line: 2 })).toBe(2);
  });
});

describe("getHalfPageStep", () => {
  it("uses at least one row and otherwise half the visible rows", () => {
    expect(getHalfPageStep(1)).toBe(1);
    expect(getHalfPageStep(9)).toBe(4);
    expect(getHalfPageStep(10)).toBe(5);
  });
});

describe("getPaneLayout", () => {
  it("gives the diff pane the comments width when comments are hidden", () => {
    const shown = getPaneLayout(100, false);
    const hidden = getPaneLayout(100, true);

    expect(hidden.commentsWidth).toBe(0);
    expect(hidden.navigatorWidth).toBe(shown.navigatorWidth);
    expect(hidden.diffWidth).toBeGreaterThan(shown.diffWidth);
  });
});

describe("related navigator helpers", () => {
  it("marks incoming, outgoing, and bidirectional related files", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect(getRelatedFileMarker(makeFile("src/out.ts"), active, "all-files")).toBe("→");
    expect(getRelatedFileMarker(makeFile("src/in.ts"), active, "all-files")).toBe("←");
    expect(getRelatedFileMarker(makeFile("src/both.ts"), active, "all-files")).toBe("↔");
    expect(getRelatedFileMarker(makeFile("src/other.ts"), active, "all-files")).toBeNull();
  });

  it("combines incoming and outgoing related file paths", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect([...getRelatedFilePaths(active)].sort()).toEqual(["src/both.ts", "src/in.ts", "src/out.ts"]);
  });
});

describe("parseMouseWheelInput", () => {
  it("parses SGR mouse wheel events", () => {
    expect(parseMouseWheelInput("\x1b[<64;10;5M")).toEqual({ direction: "up", col: 10, row: 5 });
    expect(parseMouseWheelInput("\x1b[<65;10;5M")).toEqual({ direction: "down", col: 10, row: 5 });
  });

  it("ignores non-wheel mouse events", () => {
    expect(parseMouseWheelInput("\x1b[<0;10;5M")).toBeNull();
  });
});

describe("buildEditorLaunchCommand", () => {
  it("opens the requested file and line with shell-safe quoting", () => {
    expect(buildEditorLaunchCommand("nvim", "/tmp/a b's.ts", 12)).toBe("nvim +12 -- '/tmp/a b'\\''s.ts'");
  });

  it("falls back to vi and clamps invalid line numbers", () => {
    expect(buildEditorLaunchCommand(" ", "/tmp/file.ts", 0)).toBe("vi +1 -- '/tmp/file.ts'");
  });
});
