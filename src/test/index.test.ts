import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  runReviewApp: vi.fn(),
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
}));

vi.mock("../git.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

const { default: slopReviewExtension } = await import("../index.js");

interface CommandContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setEditorText: ReturnType<typeof vi.fn>;
  };
}

describe("slop review extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCommentShortcuts.mockReturnValue({
      shortcuts: [],
      globalShortcut: "alt+s",
      warnings: ["bad shortcut config"],
      path: "/tmp/slopchop.json",
    });
  });

  it("surfaces initial shortcut config warnings on startup and reload", async () => {
    const handlers = new Map<string, (event: { reason: string }, ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>>();
    const pi = {
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn((event: string, handler) => handlers.set(event, handler)),
    };
    const ctx = { hasUI: true, ui: { notify: vi.fn() } };

    slopReviewExtension(pi as never);

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, "slopchop config: bad shortcut config", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "slopchop config: bad shortcut config", "warning");
  });

  it("builds the prompt from the files returned by the review UI", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: CommandContext) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setEditorText: vi.fn(),
      },
    };
    const initialFiles = [{ id: "root", path: "root.ts" }];
    const submittedFiles = [{ id: "nested", path: "submodule-1/nested.ts" }];

    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: initialFiles });
    mocks.runReviewApp.mockResolvedValue({
      result: { type: "submit", allComment: "", allIntent: "fix", comments: [] },
      files: submittedFiles,
    });
    mocks.composeReviewPrompt.mockReturnValue("prompt body");

    slopReviewExtension(pi as never);
    await commands.get("slopchop")?.handler("", ctx);

    expect(mocks.composeReviewPrompt).toHaveBeenCalledWith(submittedFiles, {
      type: "submit",
      allComment: "",
      allIntent: "fix",
      comments: [],
    });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("prompt body");
  });

  it("preserves nested fix and discuss comments when submitting from the parent review", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: CommandContext) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setEditorText: vi.fn(),
      },
    };
    const initialFiles = [{ id: "root", path: "README.md" }];
    const submittedFiles = [
      { id: "root", path: "README.md" },
      { id: "nested-fix", path: "backend/docs/local-agent-sandbox-note.md" },
      { id: "nested-discuss", path: "backend/README.md" },
    ];
    const result = {
      type: "submit" as const,
      allComment: "",
      allIntent: "fix" as const,
      comments: [
        {
          id: "fix-1",
          fileId: "nested-fix",
          scope: "git-diff" as const,
          side: "added" as const,
          intent: "fix" as const,
          startLine: 3,
          endLine: 3,
          body: "B: F: dsfdsf",
        },
        {
          id: "discuss-1",
          fileId: "nested-discuss",
          scope: "git-diff" as const,
          side: "added" as const,
          intent: "discuss" as const,
          startLine: 134,
          endLine: 134,
          body: "B: D: sdfdsfdsf",
        },
      ],
    };
    const prompt = [
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
      "Lines:",
      "1. backend/docs/local-agent-sandbox-note.md:3 (added)",
      "   B: F: dsfdsf",
      "",
      "DISCUSS",
      "",
      "Lines:",
      "1. backend/README.md:134 (added)",
      "   B: D: sdfdsfdsf",
    ].join("\n");

    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: initialFiles });
    mocks.runReviewApp.mockResolvedValue({ result, files: submittedFiles });
    mocks.composeReviewPrompt.mockReturnValue(prompt);

    slopReviewExtension(pi as never);
    await commands.get("slopchop")?.handler("", ctx);

    expect(ctx.ui.setEditorText).toHaveBeenCalledWith(prompt);
    expect(mocks.composeReviewPrompt).toHaveBeenCalledWith(submittedFiles, result);
  });
});
