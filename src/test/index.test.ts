import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  getSubmoduleReviewWindowData: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  runReviewApp: vi.fn(),
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
}));

vi.mock("../git.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  getSubmoduleReviewWindowData: mocks.getSubmoduleReviewWindowData,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

const { default: slopReviewExtension } = await import("../index.js");

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

  it("falls back to nested working tree review when a submodule pointer has no exact range", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn>; setEditorText: ReturnType<typeof vi.fn> } }) => Promise<void> }>();
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
    const initialFiles = [{ id: "root", path: "submodule-1" }];
    const nestedFiles = [{ id: "nested", path: "submodule-1/README.md" }];

    mocks.getReviewWindowData
      .mockResolvedValueOnce({ repoRoot: "/repo", files: initialFiles })
      .mockResolvedValueOnce({ repoRoot: "/repo/submodule-1", files: nestedFiles });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      await options.loadSubmoduleReviewData({
        repoRoot: "/repo/submodule-1",
        path: "submodule-1",
        oldSha: "abc123",
        newSha: "abc123",
        available: true,
      });
      return {
        result: { type: "submit", allComment: "", allIntent: "fix", comments: [] },
        files: nestedFiles,
      };
    });
    mocks.composeReviewPrompt.mockReturnValue("prompt body");

    slopReviewExtension(pi as never);
    await commands.get("slopchop")?.handler("", ctx);

    expect(mocks.getSubmoduleReviewWindowData).not.toHaveBeenCalled();
    expect(mocks.getReviewWindowData).toHaveBeenNthCalledWith(2, pi, "/repo/submodule-1");
  });
});
