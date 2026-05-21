import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "../diff.js";

function file(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("buildStructuredDiff", () => {
  it("returns only equal rows for unchanged files", () => {
    const diff = buildStructuredDiff(file("alpha", "beta"), file("alpha", "beta"), 3);

    expect(diff).toMatchObject({
      additions: 0,
      deletions: 0,
      hunks: [],
      firstChangedLine: undefined,
      totalOldLines: 3,
      totalNewLines: 3,
    });
    expect(diff.rows).toEqual([
      {
        kind: "equal",
        oldLineNumber: 1,
        newLineNumber: 1,
        oldText: "alpha",
        newText: "alpha",
        oldHighlights: [],
        newHighlights: [],
      },
      {
        kind: "equal",
        oldLineNumber: 2,
        newLineNumber: 2,
        oldText: "beta",
        newText: "beta",
        oldHighlights: [],
        newHighlights: [],
      },
    ]);
    expect(diff.visibleItems.map((item) => item.type)).toEqual(["row", "row"]);
  });

  it("builds replace rows for modified lines", () => {
    const diff = buildStructuredDiff(
      file("alpha", "old value", "omega"),
      file("alpha", "new value", "omega"),
      3,
    );

    expect(diff).toMatchObject({
      additions: 1,
      deletions: 1,
      firstChangedLine: 2,
    });
    expect(diff.hunks).toEqual([
      {
        index: 0,
        displayStartRow: 0,
        displayEndRow: 2,
        changeStartRow: 1,
        changeEndRow: 1,
        oldStartLine: 2,
        oldEndLine: 2,
        newStartLine: 2,
        newEndLine: 2,
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(diff.rows.map((row) => row.kind)).toEqual(["equal", "replace", "equal"]);
    expect(diff.rows[1]).toMatchObject({
      oldLineNumber: 2,
      newLineNumber: 2,
      oldText: "old value",
      newText: "new value",
    });
    expect(diff.rows[1]!.oldHighlights).toEqual([{ start: 0, end: 3 }]);
    expect(diff.rows[1]!.newHighlights).toEqual([{ start: 0, end: 3 }]);
  });

  it("preserves line numbers when replacement groups have different line counts", () => {
    const diff = buildStructuredDiff(
      file("alpha", "old a", "old b", "omega"),
      file("alpha", "new a", "omega"),
      3,
    );

    expect(diff).toMatchObject({
      additions: 1,
      deletions: 2,
      firstChangedLine: 2,
    });
    expect(diff.hunks).toEqual([
      {
        index: 0,
        displayStartRow: 0,
        displayEndRow: 3,
        changeStartRow: 1,
        changeEndRow: 2,
        oldStartLine: 2,
        oldEndLine: 3,
        newStartLine: 2,
        newEndLine: 2,
        additions: 1,
        deletions: 2,
      },
    ]);
    expect(diff.rows).toEqual([
      {
        kind: "equal",
        oldLineNumber: 1,
        newLineNumber: 1,
        oldText: "alpha",
        newText: "alpha",
        oldHighlights: [],
        newHighlights: [],
      },
      {
        kind: "replace",
        oldLineNumber: 2,
        newLineNumber: 2,
        oldText: "old a",
        newText: "new a",
        oldHighlights: [{ start: 0, end: 3 }],
        newHighlights: [{ start: 0, end: 3 }],
      },
      {
        kind: "delete",
        oldLineNumber: 3,
        newLineNumber: undefined,
        oldText: "old b",
        newText: "",
        oldHighlights: [{ start: 0, end: 5 }],
        newHighlights: [],
      },
      {
        kind: "equal",
        oldLineNumber: 4,
        newLineNumber: 3,
        oldText: "omega",
        newText: "omega",
        oldHighlights: [],
        newHighlights: [],
      },
    ]);
  });

  it("builds separate hunks and gap metadata for distant changes", () => {
    const diff = buildStructuredDiff(
      file("a", "b", "c", "d", "e", "f", "g"),
      file("a", "B", "c", "d", "e", "F", "g"),
      0,
    );

    expect(diff).toMatchObject({
      additions: 2,
      deletions: 2,
      firstChangedLine: 2,
    });
    expect(diff.hunks).toEqual([
      {
        index: 0,
        displayStartRow: 1,
        displayEndRow: 1,
        changeStartRow: 1,
        changeEndRow: 1,
        oldStartLine: 2,
        oldEndLine: 2,
        newStartLine: 2,
        newEndLine: 2,
        additions: 1,
        deletions: 1,
      },
      {
        index: 1,
        displayStartRow: 5,
        displayEndRow: 5,
        changeStartRow: 5,
        changeEndRow: 5,
        oldStartLine: 6,
        oldEndLine: 6,
        newStartLine: 6,
        newEndLine: 6,
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(diff.visibleItems).toEqual([
      {
        type: "gap",
        beforeRowIndex: -1,
        afterRowIndex: 1,
        hiddenRowCount: 1,
        hiddenOldLines: 1,
        hiddenNewLines: 1,
        label: "Start of file · 1 unchanged line",
      },
      {
        type: "row",
        fullRowIndex: 1,
        row: diff.rows[1],
      },
      {
        type: "gap",
        beforeRowIndex: 1,
        afterRowIndex: 5,
        hiddenRowCount: 3,
        hiddenOldLines: 3,
        hiddenNewLines: 3,
        label: "… 3 unchanged lines …",
      },
      {
        type: "row",
        fullRowIndex: 5,
        row: diff.rows[5],
      },
      {
        type: "gap",
        beforeRowIndex: 5,
        afterRowIndex: 7,
        hiddenRowCount: 1,
        hiddenOldLines: 1,
        hiddenNewLines: 1,
        label: "End of file · 1 unchanged line",
      },
    ]);
  });

  it("keeps normalized line text when only the trailing newline changes", () => {
    const diff = buildStructuredDiff("alpha\nbeta", "alpha\nbeta\n", 3);

    expect(diff).toMatchObject({
      additions: 1,
      deletions: 1,
      firstChangedLine: 2,
      totalOldLines: 2,
      totalNewLines: 3,
    });
    expect(diff.rows).toEqual([
      {
        kind: "equal",
        oldLineNumber: 1,
        newLineNumber: 1,
        oldText: "alpha",
        newText: "alpha",
        oldHighlights: [],
        newHighlights: [],
      },
      {
        kind: "replace",
        oldLineNumber: 2,
        newLineNumber: 2,
        oldText: "beta",
        newText: "beta",
        oldHighlights: [],
        newHighlights: [],
      },
    ]);
  });

  it("normalizes CRLF input to the same visible line text", () => {
    const diff = buildStructuredDiff("alpha\r\nbeta\r\n", "alpha\r\ngamma\r\n", 3);

    expect(diff).toMatchObject({
      additions: 1,
      deletions: 1,
      firstChangedLine: 2,
      totalOldLines: 3,
      totalNewLines: 3,
    });
    expect(diff.rows).toEqual([
      {
        kind: "equal",
        oldLineNumber: 1,
        newLineNumber: 1,
        oldText: "alpha",
        newText: "alpha",
        oldHighlights: [],
        newHighlights: [],
      },
      {
        kind: "replace",
        oldLineNumber: 2,
        newLineNumber: 2,
        oldText: "beta",
        newText: "gamma",
        oldHighlights: [{ start: 0, end: 3 }],
        newHighlights: [
          { start: 0, end: 1 },
          { start: 2, end: 5 },
        ],
      },
    ]);
  });
});
