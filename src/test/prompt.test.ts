import { describe, expect, it } from "vitest";
import { composeReviewPrompt } from "../prompt.js";
import type { ReviewFile } from "../types.js";

const files: ReviewFile[] = [
  {
    id: "foo",
    path: "src/foo.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: true,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: "src/foo.ts",
      newPath: "src/foo.ts",
      displayPath: "src/foo.ts",
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: {
      status: "renamed",
      oldPath: "src/old-foo.ts",
      newPath: "src/foo.ts",
      displayPath: "src/old-foo.ts -> src/foo.ts",
      hasOriginal: true,
      hasModified: true,
    },
    allFiles: null,
  },
  {
    id: "bar",
    path: "src/bar.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: "src/bar.ts",
      newPath: "src/bar.ts",
      displayPath: "src/bar.ts",
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: null,
    allFiles: null,
  },
];

describe("composeReviewPrompt", () => {
  it("uses strict mixed-mode instructions when both fix and discuss items exist", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "Tighten naming.",
      allIntent: "discuss",
      comments: [
        {
          id: "2",
          fileId: "foo",
          scope: "last-commit",
          side: "file",
          intent: "fix",
          startLine: null,
          endLine: null,
          body: "Rename this API to match the package.",
        },
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "fix",
          startLine: 27,
          endLine: 27,
          body: "Flatten this conditional.",
        },
        {
          id: "3",
          fileId: "foo",
          scope: "last-commit",
          side: "deleted",
          intent: "fix",
          startLine: 11,
          endLine: 11,
          body: "Check whether this removal is safe.",
        },
      ],
    });

    expect(prompt).toBe([
      "Process the following review feedback.",
      "",
      "Rules:",
      "- For FIX items: make the requested changes.",
      "- For DISCUSS items: do not edit files, write code, run write/editing tools, or make repo changes in order to address them.",
      "- Treat DISCUSS items as non-actionable discussion prompts; answer them only in prose with explanation, rationale, or a proposal.",
      "- DISCUSS items must never be converted into code changes unless the user later gives an explicit follow-up request.",
      "- If both FIX and DISCUSS items are present, implement only the FIX items; answer the DISCUSS items separately in prose.",
      "",
      "FIX",
      "",
      "Files:",
      "- src/old-foo.ts -> src/foo.ts",
      "  Rename this API to match the package.",
      "",
      "Lines:",
      "1. src/bar.ts:27 (added)",
      "   Flatten this conditional.",
      "",
      "2. src/old-foo.ts -> src/foo.ts:11 (deleted)",
      "   Check whether this removal is safe.",
      "",
      "DISCUSS",
      "",
      "Review-wide:",
      "Tighten naming.",
    ].join("\n"));
  });

  it("uses discuss-only instructions with no fix references", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "fix",
      comments: [
        {
          id: "1",
          fileId: "foo",
          scope: "all-files",
          side: "added",
          intent: "discuss",
          startLine: 3,
          endLine: 3,
          body: "First line\nSecond line",
        },
      ],
    });

    expect(prompt).toBe([
      "Respond to the following review discussion items in prose only.",
      "Do not edit files, write code, run write/editing tools, or make repo changes.",
      "",
      "DISCUSS",
      "",
      "Lines:",
      "1. src/foo.ts:3",
      "   First line",
      "   Second line",
    ].join("\n"));
    expect(prompt).not.toContain("FIX items");
  });

  it("uses fix-only instructions with no discuss references", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "fix",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "fix",
          startLine: 27,
          endLine: 27,
          body: "Flatten this conditional.",
        },
      ],
    });

    expect(prompt).toBe([
      "Address the following review feedback by making the requested changes.",
      "",
      "FIX",
      "",
      "Lines:",
      "1. src/bar.ts:27 (added)",
      "   Flatten this conditional.",
    ].join("\n"));
    expect(prompt).not.toContain("DISCUSS items");
  });
});
