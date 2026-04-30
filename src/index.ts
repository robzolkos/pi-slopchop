import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { loadCommentShortcuts } from "./shortcuts.js";
import { runReviewApp } from "./ui/review-app.js";

export default function slopReviewExtension(pi: ExtensionAPI) {
  let activeReview = false;

  async function openReview(ctx: ExtensionContext): Promise<void> {
    if (activeReview) {
      ctx.ui.notify("A /slopchop review session is already open.", "warning");
      return;
    }

    activeReview = true;
    try {
      const { repoRoot, files } = await getReviewWindowData(pi, ctx.cwd);
      const shortcutConfig = loadCommentShortcuts();
      if (files.length === 0) {
        ctx.ui.notify("No reviewable files found for git diff, last commit, or all files.", "info");
        return;
      }

      if (shortcutConfig.warnings.length > 0) {
        ctx.ui.notify(`Loaded slopchop shortcuts with ${shortcutConfig.warnings.length} warning${shortcutConfig.warnings.length === 1 ? "" : "s"}. Using valid entries only.`, "warning");
      }

      const result = await runReviewApp(ctx, {
        files,
        repoRoot,
        loadFileContents: (file, scope) => loadReviewFileContents(pi, repoRoot, file, scope),
        commentShortcuts: shortcutConfig.shortcuts,
      });

      if (result.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, result);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not open /slopchop: ${message}`, "error");
    } finally {
      activeReview = false;
    }
  }

  pi.registerCommand("slopchop", {
    description: "Review and annotate code changes",
    handler: async (_args, ctx) => {
      await openReview(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+s", {
    description: "Open /slopchop",
    handler: async (ctx) => {
      await openReview(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeReview = false;
  });
}
