import { describe, expect, it } from "vitest";
import { BUILTIN_COMMENT_SHORTCUTS, DEFAULT_GLOBAL_SHORTCUT, getShortcutsForSide, parseShortcutConfig } from "../shortcuts.js";

describe("comment shortcuts", () => {
  it("loads builtins by default", () => {
    const parsed = parseShortcutConfig({ version: 1 });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.globalShortcut).toBe(DEFAULT_GLOBAL_SHORTCUT);
    expect(parsed.shortcuts).toEqual(BUILTIN_COMMENT_SHORTCUTS);
  });

  it("loads a configured global shortcut", () => {
    const parsed = parseShortcutConfig({ version: 1, globalShortcut: "ctrl+alt+r" });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.globalShortcut).toBe("ctrl+alt+r");
  });

  it("falls back to the default global shortcut when configured with an invalid value", () => {
    const parsed = parseShortcutConfig({ version: 1, globalShortcut: "not a shortcut" });

    expect(parsed.globalShortcut).toBe(DEFAULT_GLOBAL_SHORTCUT);
    expect(parsed.warnings[0]).toContain("Ignoring globalShortcut");
  });

  it("allows disabling builtins and adding a custom shortcut", () => {
    const parsed = parseShortcutConfig({
      version: 1,
      builtins: { disable: ["restore-deleted"] },
      shortcuts: [
        {
          id: "trace-added",
          key: "x",
          label: "trace",
          intent: "discuss",
          side: "added",
          text: "Explain how execution reaches this line.",
        },
      ],
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.shortcuts.some((shortcut) => shortcut.id === "restore-deleted")).toBe(false);
    expect(parsed.shortcuts.some((shortcut) => shortcut.id === "trace-added")).toBe(true);
  });

  it("rejects conflicting custom shortcuts", () => {
    const parsed = parseShortcutConfig({
      version: 1,
      shortcuts: [
        {
          id: "bad-why",
          key: "w",
          label: "why",
          intent: "discuss",
          side: "added",
          text: "Why?",
        },
      ],
    });

    expect(parsed.shortcuts.some((shortcut) => shortcut.id === "bad-why")).toBe(false);
    expect(parsed.warnings[0]).toContain("conflicts");
  });

  it("filters shortcuts by selected side", () => {
    const deleted = getShortcutsForSide(BUILTIN_COMMENT_SHORTCUTS, "deleted");
    expect(deleted.every((shortcut) => shortcut.side === "deleted" || shortcut.side === "both")).toBe(true);
    expect(deleted.some((shortcut) => shortcut.id === "why-deleted")).toBe(true);
    expect(deleted.some((shortcut) => shortcut.id === "why-added")).toBe(false);
  });
});
