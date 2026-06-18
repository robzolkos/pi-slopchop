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

  it("formats line ranges", () => {
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
          endLine: 29,
          body: "Apply this to the whole block.",
        },
      ],
    });

    expect(prompt).toContain("1. src/bar.ts:27-29 (added)");
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

  it("prefixes nested repo paths in the generated prompt", () => {
    const prompt = composeReviewPrompt([
      {
        ...files[0]!,
        id: "nested",
        path: "docs/local-agent-sandbox-note.md",
        pathPrefix: "submodule-1",
        gitDiff: {
          status: "modified",
          oldPath: "docs/local-agent-sandbox-note.md",
          newPath: "docs/local-agent-sandbox-note.md",
          displayPath: "docs/local-agent-sandbox-note.md",
          hasOriginal: true,
          hasModified: true,
        },
        lastCommit: null,
      },
    ], {
      type: "submit",
      allComment: "",
      allIntent: "fix",
      comments: [
        {
          id: "1",
          fileId: "nested",
          scope: "git-diff",
          side: "added",
          intent: "fix",
          startLine: 3,
          endLine: 5,
          body: "Is this needed?",
        },
      ],
    });

    expect(prompt).toContain("1. submodule-1/docs/local-agent-sandbox-note.md:3-5 (added)");
  });

  it("prefixes both sides of nested renamed paths", () => {
    const prompt = composeReviewPrompt([
      {
        ...files[0]!,
        id: "renamed-nested",
        path: "src/new-name.ts",
        pathPrefix: "submodule-1",
        gitDiff: null,
        lastCommit: {
          status: "renamed",
          oldPath: "src/old-name.ts",
          newPath: "src/new-name.ts",
          displayPath: "src/old-name.ts -> src/new-name.ts",
          hasOriginal: true,
          hasModified: true,
        },
      },
    ], {
      type: "submit",
      allComment: "",
      allIntent: "fix",
      comments: [
        {
          id: "1",
          fileId: "renamed-nested",
          scope: "last-commit",
          side: "file",
          intent: "fix",
          startLine: null,
          endLine: null,
          body: "Review this rename.",
        },
      ],
    });

    expect(prompt).toContain("- submodule-1/src/old-name.ts -> submodule-1/src/new-name.ts");
  });

  it("keeps nested prefixed paths in mixed fix and discuss output", () => {
    const prompt = composeReviewPrompt([
      {
        ...files[0]!,
        id: "nested-fix",
        path: "docs/local-agent-sandbox-note.md",
        pathPrefix: "submodule-1",
        gitDiff: {
          status: "modified",
          oldPath: "docs/local-agent-sandbox-note.md",
          newPath: "docs/local-agent-sandbox-note.md",
          displayPath: "docs/local-agent-sandbox-note.md",
          hasOriginal: true,
          hasModified: true,
        },
        lastCommit: null,
      },
      {
        ...files[0]!,
        id: "nested-discuss",
        path: "README.md",
        pathPrefix: "submodule-1",
        gitDiff: {
          status: "modified",
          oldPath: "README.md",
          newPath: "README.md",
          displayPath: "README.md",
          hasOriginal: true,
          hasModified: true,
        },
        lastCommit: null,
      },
    ], {
      type: "submit",
      allComment: "",
      allIntent: "fix",
      comments: [
        {
          id: "1",
          fileId: "nested-fix",
          scope: "git-diff",
          side: "added",
          intent: "fix",
          startLine: 3,
          endLine: 3,
          body: "B: F: dsfdsf",
        },
        {
          id: "2",
          fileId: "nested-discuss",
          scope: "git-diff",
          side: "added",
          intent: "discuss",
          startLine: 134,
          endLine: 134,
          body: "B: D: sdfdsfdsf",
        },
      ],
    });

    expect(prompt).toContain("1. submodule-1/docs/local-agent-sandbox-note.md:3 (added)");
    expect(prompt).toContain("1. submodule-1/README.md:134 (added)");
  });
});
