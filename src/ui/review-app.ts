import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { adjustStructuredDiffContext, buildStructuredDiff, type StructuredDiff, type StructuredDiffVisibleItem } from "../diff.js";
import {
  clampSelectedLineTarget,
  createInitialReviewState,
  cycleFocus,
  cycleFocusBackward,
  deleteComment,
  ensureActiveFile,
  getCommentsForFileScope,
  getFileComment,
  getLineComment,
  getScopedFiles,
  getSelectedLineTarget,
  hasDraftContent,
  moveSelectedCommentIndex,
  moveSelectedLineTarget,
  setActiveFileId,
  setFocus,
  setAllComment,
  setScope,
  setSearchQuery,
  setSelectedLineTarget,
  setWrapLines,
  toggleHideUnchanged,
  upsertFileComment,
  upsertLineComment,
} from "../state.js";
import { detectPiLanguage, highlightCodeLineWithPi } from "../pi-render.js";
import { getShortcutConfigPath, getShortcutsForSide, type CommentShortcut } from "../shortcuts.js";
import { filterFilesBySearch } from "../search.js";
import { highlightJsonLine, highlightMarkdownLine } from "../theme-highlight.js";
import type { CommentIntent, DiffReviewComment, ReviewFile, ReviewFileContents, ReviewLineTarget, ReviewResult, ReviewScope, ReviewState } from "../types.js";
import { formatIntentLabel, formatScopeLabel } from "../types.js";

interface LoadedEntryReady {
  status: "ready";
  contents: ReviewFileContents;
  baseDiff: StructuredDiff;
}

interface LoadedEntryError {
  status: "error";
  error: string;
}

interface LoadedEntryLoading {
  status: "loading";
}

type LoadedEntry = LoadedEntryReady | LoadedEntryError | LoadedEntryLoading;

type EditTarget =
  | { kind: "line"; fileId: string; scope: ReviewScope; side: ReviewLineTarget["side"]; line: number; initialBody: string; intent: CommentIntent }
  | { kind: "file"; fileId: string; scope: ReviewScope; initialBody: string; intent: CommentIntent }
  | { kind: "all"; initialBody: string; intent: CommentIntent };

type CommentPanelItem =
  | { kind: "all"; body: string; intent: CommentIntent }
  | { kind: "comment"; comment: DiffReviewComment };

interface ReviewAppOptions {
  files: ReviewFile[];
  repoRoot: string;
  loadFileContents: (file: ReviewFile, scope: ReviewScope) => Promise<ReviewFileContents>;
  commentShortcuts: CommentShortcut[];
  notify: ExtensionContext["ui"]["notify"];
}

interface MousePaneBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface MousePaneLayout {
  navigator: MousePaneBounds;
  diff: MousePaneBounds;
  comments: MousePaneBounds | null;
}

const SEARCHABLE_SCOPES: ReviewScope[] = ["git-diff", "last-commit", "all-files"];
const DEFAULT_CONTEXT_LINES = 3;
const STACKED_LAYOUT_MAX_WIDTH = 99;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildEditorLaunchCommand(editorCommand: string, filePath: string, line: number): string {
  const lineNumber = Math.max(1, Math.floor(line));
  return `${editorCommand.trim() || "vi"} +${lineNumber} -- ${shellQuote(filePath)}`;
}

function runShellCommand(command: string, cwd: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

export function getEditorLineForTarget(diff: StructuredDiff, target: ReviewLineTarget): number {
  if (target.side === "added") return target.line;

  const rowIndex = diff.rows.findIndex((row) => row.oldLineNumber === target.line);
  if (rowIndex < 0) return target.line;

  const selectedRow = diff.rows[rowIndex]!;
  if (selectedRow.newLineNumber != null) return selectedRow.newLineNumber;

  for (let index = rowIndex + 1; index < diff.rows.length; index += 1) {
    const line = diff.rows[index]!.newLineNumber;
    if (line != null) return line;
  }

  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const line = diff.rows[index]!.newLineNumber;
    if (line != null) return line;
  }

  return 1;
}

export function getHalfPageStep(visibleRows: number): number {
  return Math.max(1, Math.floor(visibleRows / 2));
}

export function shouldStackPanes(frameInnerWidth: number): boolean {
  return frameInnerWidth <= STACKED_LAYOUT_MAX_WIDTH;
}

export function getPaneLayout(frameInnerWidth: number, commentsHidden: boolean): { navigatorWidth: number; diffWidth: number; commentsWidth: number } {
  const navigatorWidth = Math.max(24, Math.min(36, Math.floor(frameInnerWidth * 0.26)));
  if (commentsHidden) {
    return {
      navigatorWidth,
      diffWidth: Math.max(24, frameInnerWidth - navigatorWidth - 1),
      commentsWidth: 0,
    };
  }

  const commentsWidth = Math.max(24, Math.min(36, Math.floor(frameInnerWidth * 0.27)));
  return {
    navigatorWidth,
    commentsWidth,
    diffWidth: Math.max(24, frameInnerWidth - navigatorWidth - commentsWidth - 2),
  };
}

export function getStackedPaneLayout(bodyHeight: number, commentsHidden: boolean): { navigatorHeight: number; diffHeight: number; commentsHeight: number } {
  const safeBodyHeight = Math.max(commentsHidden ? 6 : 9, Math.floor(bodyHeight));
  const minimums = commentsHidden ? [3, 3] : [3, 3, 3];
  const weights = commentsHidden ? [1, 2] : [1, 2, 1];
  const heights = [...minimums];
  let remaining = safeBodyHeight - heights.reduce((sum, height) => sum + height, 0);

  while (remaining > 0) {
    let selectedIndex = 0;
    for (let index = 1; index < weights.length; index += 1) {
      if (heights[index]! / weights[index]! < heights[selectedIndex]! / weights[selectedIndex]!) {
        selectedIndex = index;
      }
    }
    heights[selectedIndex]! += 1;
    remaining -= 1;
  }

  return {
    navigatorHeight: heights[0]!,
    diffHeight: heights[1]!,
    commentsHeight: commentsHidden ? 0 : heights[2]!,
  };
}

export type MouseWheelDirection = "up" | "down";

export interface MouseWheelEvent {
  direction: MouseWheelDirection;
  col: number;
  row: number;
}

export function parseMouseWheelInput(data: string): MouseWheelEvent | null {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/);
  if (match == null) return null;

  const button = Number.parseInt(match[1]!, 10);
  if ((button & 64) === 0) return null;

  const wheelButton = button & 3;
  if (wheelButton !== 0 && wheelButton !== 1) return null;

  return {
    direction: wheelButton === 0 ? "up" : "down",
    col: Number.parseInt(match[2]!, 10),
    row: Number.parseInt(match[3]!, 10),
  };
}

type PaneName = "navigator" | "diff" | "comments";

type RelatedFileMarker = "→" | "←" | "↔";

export function getRelatedFilePaths(file: ReviewFile | null): Set<string> {
  return new Set([
    ...(file?.allFilesOutgoingReferences ?? []),
    ...(file?.allFilesIncomingReferences ?? []),
  ]);
}

export function getRelatedFileMarker(file: ReviewFile, activeFile: ReviewFile | null, scope: ReviewScope): RelatedFileMarker | null {
  if (activeFile == null || scope !== "all-files" || file.id === activeFile.id) return null;
  const outgoing = new Set(activeFile.allFilesOutgoingReferences ?? []).has(file.path);
  const incoming = new Set(activeFile.allFilesIncomingReferences ?? []).has(file.path);
  if (outgoing && incoming) return "↔";
  if (outgoing) return "→";
  if (incoming) return "←";
  return null;
}

type Theme = Parameters<ExtensionContext["ui"]["custom"]>[0] extends (tui: any, theme: infer T, kb: any, done: any) => any ? T : never;

function repeat(char: string, count: number): string {
  return count <= 0 ? "" : char.repeat(count);
}

function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "", true);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(padding);
}

function wrapAnsiText(text: string, width: number, wrapLines: boolean): string[] {
  const safeWidth = Math.max(1, width);
  if (!wrapLines) return [truncateToWidth(text, safeWidth, "…", false)];
  const wrapped = wrapTextWithAnsi(text, safeWidth).map((line) => truncateToWidth(line, safeWidth, "", false));
  return wrapped.length > 0 ? wrapped : [""];
}

function getScopeComparison(file: ReviewFile | null, scope: ReviewScope) {
  if (file == null) return null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  return file.allFiles;
}

function getScopeDisplayPath(file: ReviewFile | null, scope: ReviewScope): string {
  const comparison = getScopeComparison(file, scope);
  return comparison?.displayPath ?? file?.path ?? "(no file)";
}

function getStatusLabel(file: ReviewFile | null, scope: ReviewScope): string {
  const status = getScopeComparison(file, scope)?.status ?? file?.worktreeStatus;
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "modified": return "M";
    default: return "·";
  }
}

function getChangeCountLabel(theme: Theme, file: ReviewFile, scope: ReviewScope): string {
  const comparison = getScopeComparison(file, scope);
  const additions = comparison?.additions;
  const deletions = comparison?.deletions;
  if (additions == null && deletions == null) return "";
  const safeAdditions = additions ?? 0;
  const safeDeletions = deletions ?? 0;
  if (safeAdditions === 0 && safeDeletions === 0) return "";
  return ` ${theme.fg("success", `+${safeAdditions}`)} ${theme.fg("error", `-${safeDeletions}`)}`;
}

function getFileCommentCount(state: ReviewState, fileId: string, scope: ReviewScope): number {
  return state.draft.comments.filter((comment) => comment.fileId === fileId && comment.scope === scope).length;
}

function getCommentPanelItems(state: ReviewState, fileId: string | null, scope: ReviewScope): CommentPanelItem[] {
  const items: CommentPanelItem[] = [];
  if (state.draft.allComment.trim().length > 0) {
    items.push({ kind: "all", body: state.draft.allComment.trim(), intent: state.draft.allIntent });
  }
  if (fileId == null) return items;
  for (const comment of getCommentsForFileScope(state, fileId, scope)) {
    items.push({ kind: "comment", comment });
  }
  return items;
}

function getIntentBadge(theme: Theme, intent: CommentIntent): string {
  const text = `[${formatIntentLabel(intent)}]`;
  return intent === "fix" ? theme.fg("success", text) : theme.fg("warning", text);
}

function formatLineSideLabel(side: ReviewLineTarget["side"]): string {
  return side === "deleted" ? "Deleted" : "Added";
}

function getPanelItemLabel(theme: Theme, item: CommentPanelItem): string {
  if (item.kind === "all") return `${getIntentBadge(theme, item.intent)} All note`;
  if (item.comment.side === "file") return `${getIntentBadge(theme, item.comment.intent)} File comment`;
  return `${getIntentBadge(theme, item.comment.intent)} ${formatLineSideLabel(item.comment.side)} line ${item.comment.startLine}`;
}

function centerText(text: string, width: number): string {
  const clean = truncateToWidth(text, width, "", false);
  const remaining = Math.max(0, width - visibleWidth(clean));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${clean}`;
}

export function shortenNavigatorPath(path: string, maxWidth: number): string {
  const safeWidth = Math.max(1, maxWidth);
  if (visibleWidth(path) <= safeWidth) return path;

  const parts = path.split("/").filter((part) => part.length > 0);
  const baseName = parts[parts.length - 1] ?? path;
  if (parts.length <= 1) {
    return truncateToWidth(baseName, safeWidth, "…", false);
  }

  let suffix = baseName;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const nextSuffix = `${parts[index]}/${suffix}`;
    if (visibleWidth(`…/${nextSuffix}`) > safeWidth) break;
    suffix = nextSuffix;
  }

  const candidate = `…/${suffix}`;
  if (visibleWidth(candidate) <= safeWidth) return candidate;
  return truncateToWidth(baseName, safeWidth, "…", false);
}

function renderBox(title: string, width: number, height: number, theme: Theme, lines: string[], focused = false): string[] {
  const innerWidth = Math.max(1, width - 2);
  const innerHeight = Math.max(1, height - 2);
  const titleText = truncateToWidth(` ${title} `, Math.max(1, innerWidth - 2), "", false);
  const leftPad = Math.max(0, Math.floor((innerWidth - visibleWidth(titleText)) / 2));
  const rightPad = Math.max(0, innerWidth - visibleWidth(titleText) - leftPad);
  const borderColor = focused ? "accent" : "border";
  const top = theme.fg(borderColor, `┌${repeat("─", leftPad)}${titleText}${repeat("─", rightPad)}┐`);
  const bottom = theme.fg(borderColor, `└${repeat("─", innerWidth)}┘`);
  const body: string[] = [];

  for (let i = 0; i < innerHeight; i += 1) {
    const line = padLine(lines[i] ?? "", innerWidth);
    body.push(`${theme.fg(borderColor, "│")}${line}${theme.fg(borderColor, "│")}`);
  }

  return [top, ...body, bottom];
}

const MODAL_INNER_PADDING_X = 2;
const MODAL_INNER_PADDING_Y = 1;

function renderOuterFrame(
  width: number,
  height: number,
  theme: Theme,
  title: string,
  lines: string[],
  color: "accent" | "border" | "borderMuted" = "accent",
  paddingX = MODAL_INNER_PADDING_X,
  paddingY = MODAL_INNER_PADDING_Y,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const innerHeight = Math.max(1, height - 2);
  const contentWidth = Math.max(1, innerWidth - paddingX * 2);
  const contentHeight = Math.max(1, innerHeight - paddingY * 2);
  const titleText = truncateToWidth(` ${title} `, Math.max(1, innerWidth - 2), "", false);
  const leftPad = 1;
  const rightPad = Math.max(0, innerWidth - visibleWidth(titleText) - leftPad);
  const top = theme.fg(color, `┌${repeat("─", leftPad)}${titleText}${repeat("─", rightPad)}┐`);
  const bottom = theme.fg(color, `└${repeat("─", innerWidth)}┘`);
  const body: string[] = [];
  const sidePadding = " ".repeat(paddingX);

  for (let i = 0; i < innerHeight; i += 1) {
    let line = "";
    if (i >= paddingY && i < paddingY + contentHeight) {
      line = `${sidePadding}${padLine(lines[i - paddingY] ?? "", contentWidth)}${sidePadding}`;
    } else {
      line = " ".repeat(innerWidth);
    }
    body.push(`${theme.fg(color, "│")}${line}${theme.fg(color, "│")}`);
  }

  return [top, ...body, bottom];
}

export type DisplayRow =
  | { kind: "gap"; displayLineNumber: null; commentLineNumber: null; commentSide: null; sign: " "; codeText: string; pairedText?: undefined }
  | { kind: "context" | "added" | "removed"; displayLineNumber: number | null; commentLineNumber: number | null; commentSide: ReviewLineTarget["side"] | null; sign: " " | "+" | "-"; codeText: string; pairedText?: string };

type DiffTone = "added" | "removed" | "context";

function applyLineBackground(theme: Theme, text: string, tone: DiffTone): string {
  if (tone === "added") return theme.bg("toolSuccessBg", text);
  if (tone === "removed") return theme.bg("toolErrorBg", text);
  return text;
}

function highlightCodeLine(theme: Theme, _tone: DiffTone, text: string, language: string | undefined): string {
  if (text.length === 0) return "";
  if (language === "json") return highlightJsonLine(theme, text);
  if (language === "markdown") return highlightMarkdownLine(theme, text);
  return highlightCodeLineWithPi(text, language);
}

export function buildDisplayRows(diff: StructuredDiff): DisplayRow[] {
  const rows: DisplayRow[] = [];

  const pushLine = (
    sign: " " | "+" | "-",
    displayLineNumber: number | undefined,
    commentLineNumber: number | undefined,
    commentSide: ReviewLineTarget["side"] | undefined,
    codeText: string,
    kind: "context" | "added" | "removed",
    pairedText?: string,
  ) => {
    rows.push({
      sign,
      displayLineNumber: displayLineNumber ?? null,
      commentLineNumber: commentLineNumber ?? null,
      commentSide: commentSide ?? null,
      codeText,
      kind,
      pairedText,
    });
  };

  for (const item of diff.visibleItems) {
    if (item.type === "gap") {
      rows.push({ sign: " ", displayLineNumber: null, commentLineNumber: null, commentSide: null, codeText: item.label, kind: "gap" });
      continue;
    }

    const row = item.row;
    if (row.kind === "equal") {
      pushLine(" ", row.newLineNumber, row.newLineNumber, "added", row.newText, "context");
      continue;
    }
    if (row.kind === "delete") {
      pushLine("-", row.oldLineNumber, row.oldLineNumber, "deleted", row.oldText, "removed");
      continue;
    }
    if (row.kind === "insert") {
      pushLine("+", row.newLineNumber, row.newLineNumber, "added", row.newText, "added");
      continue;
    }

    pushLine("-", row.oldLineNumber, row.oldLineNumber, "deleted", row.oldText, "removed", row.newText);
    pushLine("+", row.newLineNumber, row.newLineNumber, "added", row.newText, "added", row.oldText);
  }

  return rows;
}

function getCommentableLineTargets(diff: StructuredDiff): ReviewLineTarget[] {
  const seen = new Set<string>();
  const targets: ReviewLineTarget[] = [];

  for (const row of buildDisplayRows(diff)) {
    if (row.commentLineNumber == null || row.commentSide == null) continue;
    const key = `${row.commentSide}:${row.commentLineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ side: row.commentSide, line: row.commentLineNumber });
  }

  return targets;
}

class ReviewApp {
  focused = false;

  private state: ReviewState;
  private readonly cache = new Map<string, LoadedEntry>();
  private searchMode = false;
  private searchBuffer = "";
  private shortcutMode = false;
  private helpMode = false;
  private commentsHidden = false;
  private externalEditorOpen = false;
  private editTarget: EditTarget | null = null;
  private editor: Editor;
  private message: string | null = null;
  private navigatorScroll = 0;
  private diffScroll = 0;
  private commentsScroll = 0;
  private navigatorPageSize = 1;
  private diffPageSize = 1;
  private commentsPageSize = 1;
  private relatedFilterAnchorFileId: string | null = null;
  private relatedFilterReturnFileId: string | null = null;
  private mousePaneLayout: MousePaneLayout | null = null;
  private mouseTrackingEnabled = false;
  private lastWidth = 120;
  private readonly previousHardwareCursor: boolean;
  private readonly syntaxLineCache = new Map<string, string>();
  private readonly renderedDiffLineCache = new Map<string, string[]>();

  constructor(
    private readonly tui: any,
    private readonly theme: Theme,
    private readonly done: (value: ReviewResult) => void,
    private readonly options: ReviewAppOptions,
  ) {
    this.state = ensureActiveFile(createInitialReviewState(options.files), options.files);
    this.searchBuffer = this.state.searchQuery;

    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(this.tui, editorTheme);
    this.editor.disableSubmit = true;
    this.previousHardwareCursor = typeof this.tui.getShowHardwareCursor === "function"
      ? this.tui.getShowHardwareCursor()
      : false;
    this.syncCursorMode();
    this.setMouseTracking(true);

    queueMicrotask(() => {
      this.ensureActiveEntry();
      this.requestRender();
    });
  }

  dispose(): void {
    this.setMouseTracking(false);
    if (typeof this.tui.setShowHardwareCursor === "function") {
      this.tui.setShowHardwareCursor(this.previousHardwareCursor);
    }
  }

  invalidate(): void {
    this.syntaxLineCache.clear();
    this.renderedDiffLineCache.clear();
    this.message = this.message;
  }

  private syncCursorMode(): void {
    if (typeof this.tui.setShowHardwareCursor === "function") {
      this.tui.setShowHardwareCursor(this.editTarget != null || this.previousHardwareCursor);
    }
    (this.editor as unknown as { focused?: boolean }).focused = this.editTarget != null;
  }

  private requestRender(): void {
    if (typeof this.tui.requestRender === "function") {
      this.tui.requestRender();
    }
  }

  private writeTerminal(data: string): void {
    if (typeof this.tui.terminal?.write === "function") {
      this.tui.terminal.write(data);
    } else {
      process.stdout.write(data);
    }
  }

  private setMouseTracking(enabled: boolean): void {
    if (this.mouseTrackingEnabled === enabled) return;
    this.mouseTrackingEnabled = enabled;
    this.writeTerminal(enabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
  }

  private getPaneAtMousePosition(col: number, row: number): PaneName | null {
    const layout = this.mousePaneLayout;
    if (layout == null) return null;

    const zeroCol = col - 1;
    const zeroRow = row - 1;
    const contains = (bounds: MousePaneBounds | null): boolean => bounds != null
      && zeroRow >= bounds.top
      && zeroRow <= bounds.bottom
      && zeroCol >= bounds.left
      && zeroCol <= bounds.right;

    if (contains(layout.navigator)) return "navigator";
    if (contains(layout.diff)) return "diff";
    if (contains(layout.comments)) return "comments";
    return null;
  }

  private getCachedHighlightedCode(tone: DiffTone, text: string, language: string | undefined): string {
    const key = `${language ?? ""}\u001f${tone}\u001f${text}`;
    const cached = this.syntaxLineCache.get(key);
    if (cached != null) return cached;

    const highlighted = highlightCodeLine(this.theme, tone, text, language);
    if (this.syntaxLineCache.size > 5000) this.syntaxLineCache.clear();
    this.syntaxLineCache.set(key, highlighted);
    return highlighted;
  }

  private getCachedRenderedDiffLines(
    width: number,
    wrapLines: boolean,
    rowKind: DisplayRow["kind"],
    tone: DiffTone,
    contentText: string,
    isSelected: boolean,
  ): string[] {
    const key = `${width}\u001f${wrapLines ? "wrap" : "nowrap"}\u001f${rowKind}\u001f${tone}\u001f${isSelected ? 1 : 0}\u001f${contentText}`;
    const cached = this.renderedDiffLineCache.get(key);
    if (cached != null) return cached;

    const wrapped = wrapAnsiText(contentText, Math.max(1, width - 2), wrapLines);
    const rendered = wrapped.map((line) => {
      const paddedLine = padLine(line, Math.max(1, width - 2));
      if (isSelected) return this.theme.bg("selectedBg", paddedLine);
      if (rowKind === "added" || rowKind === "removed") return applyLineBackground(this.theme, paddedLine, tone);
      return paddedLine;
    });

    if (this.renderedDiffLineCache.size > 5000) this.renderedDiffLineCache.clear();
    this.renderedDiffLineCache.set(key, rendered);
    return rendered;
  }

  private setMessage(message: string): void {
    this.message = message;
  }

  private activeFile(): ReviewFile | null {
    return this.options.files.find((file) => file.id === this.state.activeFileId) ?? null;
  }

  private cacheKey(fileId: string, scope: ReviewScope): string {
    return `${scope}::${fileId}`;
  }

  private getEntry(fileId: string | null, scope: ReviewScope): LoadedEntry | undefined {
    if (fileId == null) return undefined;
    return this.cache.get(this.cacheKey(fileId, scope));
  }

  private getDisplayDiff(fileId: string | null, scope: ReviewScope): StructuredDiff | null {
    const entry = this.getEntry(fileId, scope);
    if (entry?.status !== "ready") return null;
    if (scope === "all-files") return entry.baseDiff;
    return adjustStructuredDiffContext(entry.baseDiff, this.state.hideUnchanged ? 0 : DEFAULT_CONTEXT_LINES);
  }

  private getVisibleLineTargets(fileId: string | null, scope: ReviewScope): ReviewLineTarget[] {
    const diff = this.getDisplayDiff(fileId, scope);
    if (diff == null) return [];
    return getCommentableLineTargets(diff);
  }

  private relatedFilterAnchorFile(): ReviewFile | null {
    if (this.relatedFilterAnchorFileId == null || this.state.activeScope !== "all-files") return null;
    return this.options.files.find((file) => file.id === this.relatedFilterAnchorFileId) ?? null;
  }

  private getNavigatorFiles(): ReviewFile[] {
    let files = getScopedFiles(this.options.files, this.state.activeScope);
    const anchor = this.relatedFilterAnchorFile();

    if (anchor != null) {
      const relatedPaths = getRelatedFilePaths(anchor);
      files = files
        .filter((file) => file.id === anchor.id || relatedPaths.has(file.path))
        .sort((a, b) => {
          if (a.id === anchor.id) return -1;
          if (b.id === anchor.id) return 1;
          return 0;
        });
    }

    return filterFilesBySearch(files, this.state.searchQuery);
  }

  private ensureLineSelection(): void {
    const file = this.activeFile();
    if (file == null) return;
    const visibleTargets = this.getVisibleLineTargets(file.id, this.state.activeScope);
    this.state = clampSelectedLineTarget(this.state, file.id, this.state.activeScope, visibleTargets);
  }

  private async ensureActiveEntry(): Promise<void> {
    const file = this.activeFile();
    if (file == null) return;
    const key = this.cacheKey(file.id, this.state.activeScope);
    if (this.cache.has(key)) {
      this.ensureLineSelection();
      return;
    }

    this.cache.set(key, { status: "loading" });
    this.requestRender();

    try {
      const contents = await this.options.loadFileContents(file, this.state.activeScope);
      const baseDiff = buildStructuredDiff(contents.originalContent, contents.modifiedContent, DEFAULT_CONTEXT_LINES);
      this.cache.set(key, { status: "ready", contents, baseDiff });
      this.ensureLineSelection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cache.set(key, { status: "error", error: message });
    }

    this.requestRender();
  }

  private setScope(scope: ReviewScope): void {
    this.relatedFilterAnchorFileId = null;
    this.relatedFilterReturnFileId = null;
    this.state = setScope(this.state, this.options.files, scope);
    this.diffScroll = 0;
    this.navigatorScroll = 0;
    this.commentsScroll = 0;
    void this.ensureActiveEntry();
    this.requestRender();
  }

  private openSearch(): void {
    this.relatedFilterAnchorFileId = null;
    this.relatedFilterReturnFileId = null;
    this.searchMode = true;
    this.searchBuffer = this.state.searchQuery;
    this.setMessage("Search files; Enter or Esc to finish.");
    this.requestRender();
  }

  private closeSearch(apply: boolean): void {
    if (apply) {
      this.state = setSearchQuery(this.state, this.options.files, this.searchBuffer);
      void this.ensureActiveEntry();
    }
    this.searchMode = false;
    this.requestRender();
  }

  private openEditor(target: EditTarget): void {
    this.commentsHidden = false;
    this.editTarget = target;
    this.editor.setText(target.initialBody);
    this.syncCursorMode();
    this.requestRender();
  }

  private setEditIntent(intent: CommentIntent): void {
    if (this.editTarget == null) return;
    this.editTarget = { ...this.editTarget, intent };
    this.requestRender();
  }

  private toggleEditIntent(): void {
    if (this.editTarget == null) return;
    this.setEditIntent(this.editTarget.intent === "fix" ? "discuss" : "fix");
  }

  private saveEditor(): void {
    const value = this.editor.getText();
    const target = this.editTarget;
    if (target == null) return;

    if (target.kind === "all") {
      this.state = setAllComment(this.state, value, target.intent);
    } else if (target.kind === "file") {
      this.state = upsertFileComment(this.state, target.fileId, target.scope, value, target.intent);
    } else {
      this.state = upsertLineComment(this.state, target.fileId, target.scope, target.side, target.line, value, target.intent);
    }

    this.editTarget = null;
    this.syncCursorMode();
    this.requestRender();
  }

  private cancelEditor(): void {
    this.editTarget = null;
    this.syncCursorMode();
    this.requestRender();
  }

  private editLineCommentWithIntent(defaultIntent: CommentIntent): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No selectable diff line in view.");
      this.requestRender();
      return;
    }
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    this.openEditor({
      kind: "line",
      fileId: file.id,
      scope: this.state.activeScope,
      side: target.side,
      line: target.line,
      initialBody: existing?.body ?? "",
      intent: defaultIntent,
    });
  }

  private editLineComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No selectable diff line in view.");
      this.requestRender();
      return;
    }
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    this.openEditor({
      kind: "line",
      fileId: file.id,
      scope: this.state.activeScope,
      side: target.side,
      line: target.line,
      initialBody: existing?.body ?? "",
      intent: existing?.intent ?? "fix",
    });
  }

  private editFileComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const existing = getFileComment(this.state, file.id, this.state.activeScope);
    this.openEditor({
      kind: "file",
      fileId: file.id,
      scope: this.state.activeScope,
      initialBody: existing?.body ?? "",
      intent: existing?.intent ?? "fix",
    });
  }

  private editAllNote(): void {
    this.openEditor({ kind: "all", initialBody: this.state.draft.allComment, intent: this.state.draft.allIntent });
  }

  private editCurrentLineComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) return;
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    if (existing == null) {
      this.setMessage("No line comment on selected line.");
      this.requestRender();
      return;
    }
    this.editLineComment();
  }

  private deleteCurrentLineComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) return;
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    if (existing == null) return;
    this.state = deleteComment(this.state, existing.id);
    this.requestRender();
  }

  private deleteSelectedComment(): void {
    const file = this.activeFile();
    const items = getCommentPanelItems(this.state, file?.id ?? null, this.state.activeScope);
    const item = items[this.state.selectedCommentIndex];
    if (item == null) return;
    if (item.kind === "all") {
      this.state = setAllComment(this.state, "", this.state.draft.allIntent);
    } else {
      this.state = deleteComment(this.state, item.comment.id);
    }
    this.requestRender();
  }

  private editSelectedComment(): void {
    const file = this.activeFile();
    const items = getCommentPanelItems(this.state, file?.id ?? null, this.state.activeScope);
    const item = items[this.state.selectedCommentIndex];
    if (item == null) return;
    if (item.kind === "all") {
      this.editAllNote();
      return;
    }
    if (item.comment.side === "file") {
      this.editFileComment();
      return;
    }
    this.state = setSelectedLineTarget(this.state, item.comment.fileId, item.comment.scope, {
      side: item.comment.side,
      line: item.comment.startLine ?? 1,
    });
    this.editLineComment();
  }

  private async openSelectedLineInEditor(): Promise<void> {
    if (this.externalEditorOpen) return;

    const file = this.activeFile();
    if (file == null) {
      this.setMessage("No file selected.");
      this.requestRender();
      return;
    }

    if (!file.hasWorkingTreeFile) {
      this.setMessage("Cannot open this file in $EDITOR because it does not exist in the working tree.");
      this.requestRender();
      return;
    }

    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No selectable diff line to open in $EDITOR.");
      this.requestRender();
      return;
    }

    const diff = this.getDisplayDiff(file.id, this.state.activeScope);
    if (diff == null) {
      this.setMessage("Diff is still loading; try again in a moment.");
      this.requestRender();
      return;
    }

    const editorLine = getEditorLineForTarget(diff, target);
    const editorCommand = (process.env.EDITOR || process.env.VISUAL || "vi").trim() || "vi";
    const filePath = join(this.options.repoRoot, file.path);
    const command = buildEditorLaunchCommand(editorCommand, filePath, editorLine);

    this.externalEditorOpen = true;
    this.setMessage(`Opening ${file.path}:${editorLine} in $EDITOR…`);
    this.requestRender();

    try {
      this.setMouseTracking(false);
      if (typeof this.tui.stop === "function") this.tui.stop();
      if (typeof this.tui.terminal?.clearScreen === "function") this.tui.terminal.clearScreen();
      const code = await runShellCommand(command, this.options.repoRoot);
      this.setMessage(code === 0 ? `Returned from $EDITOR at ${file.path}:${editorLine}.` : `$EDITOR exited with code ${code ?? "unknown"}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setMessage(`Could not open $EDITOR: ${message}`);
    } finally {
      this.externalEditorOpen = false;
      if (typeof this.tui.start === "function") this.tui.start();
      this.setMouseTracking(true);
      if (typeof this.tui.requestRender === "function") this.tui.requestRender(true);
    }
  }

  private submit(): void {
    if (!hasDraftContent(this.state)) {
      this.setMessage("Add at least one line comment, file comment, or all note before submitting.");
      this.requestRender();
      return;
    }
    this.done({ type: "submit", ...this.state.draft });
  }

  private cancel(): void {
    this.done({ type: "cancel" });
  }

  private moveHunk(delta: number): void {
    const file = this.activeFile();
    const diff = this.getDisplayDiff(file?.id ?? null, this.state.activeScope);
    if (file == null || diff == null || diff.hunks.length === 0) return;

    const visibleTargets = this.getVisibleLineTargets(file.id, this.state.activeScope);
    const current = getSelectedLineTarget(this.state, file.id, this.state.activeScope) ?? visibleTargets[0] ?? null;
    const targets = diff.hunks
      .map((hunk) => visibleTargets.find((target) => {
        const start = target.side === "deleted"
          ? (hunk.oldStartLine ?? hunk.newStartLine ?? target.line)
          : (hunk.newStartLine ?? hunk.oldStartLine ?? target.line);
        const end = target.side === "deleted"
          ? (hunk.oldEndLine ?? hunk.newEndLine ?? target.line)
          : (hunk.newEndLine ?? hunk.oldEndLine ?? target.line);
        return start <= target.line && target.line <= end;
      }))
      .filter((target): target is ReviewLineTarget => target != null);
    if (targets.length === 0 || current == null) return;

    let index = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      if (target.line < current.line || (target.line === current.line && target.side === current.side)) index = i;
    }
    const nextIndex = Math.max(0, Math.min(targets.length - 1, index + delta));
    this.state = setSelectedLineTarget(this.state, file.id, this.state.activeScope, targets[nextIndex]!);
    this.requestRender();
  }

  private getAvailableShortcuts(): CommentShortcut[] {
    const file = this.activeFile();
    const target = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    if (file == null || target == null) return [];
    return getShortcutsForSide(this.options.commentShortcuts, target.side);
  }

  private openShortcutMode(): void {
    if (this.state.activeScope === "all-files") {
      this.setMessage("Slash shortcuts are only available in git diff and last commit scopes.");
      this.requestRender();
      return;
    }
    const shortcuts = this.getAvailableShortcuts();
    if (shortcuts.length === 0) {
      this.setMessage("No slash shortcuts available for the selected line.");
      this.requestRender();
      return;
    }
    this.commentsHidden = false;
    this.helpMode = false;
    this.shortcutMode = true;
    this.requestRender();
  }

  private closeShortcutMode(): void {
    this.shortcutMode = false;
    this.requestRender();
  }

  private toggleHelpMode(): void {
    this.helpMode = !this.helpMode;
    if (this.helpMode) this.commentsHidden = false;
    this.requestRender();
  }

  private toggleCommentsPane(): void {
    this.commentsHidden = !this.commentsHidden;
    if (this.commentsHidden) this.helpMode = false;
    if (this.commentsHidden && this.state.focus === "comments") {
      this.state = setFocus(this.state, "diff");
    }
    this.requestRender();
  }

  private cycleVisibleFocus(backward = false): void {
    if (!this.commentsHidden) {
      this.state = backward ? cycleFocusBackward(this.state) : cycleFocus(this.state);
      this.requestRender();
      return;
    }

    const nextFocus = this.state.focus === "navigator" ? "diff" : "navigator";
    this.state = setFocus(this.state, nextFocus);
    this.requestRender();
  }

  private toggleRelatedFilter(): void {
    if (this.relatedFilterAnchorFileId != null) {
      const returnFileId = this.relatedFilterReturnFileId;
      this.relatedFilterAnchorFileId = null;
      this.relatedFilterReturnFileId = null;
      if (returnFileId != null) {
        this.state = setActiveFileId(this.state, this.options.files, returnFileId);
        void this.ensureActiveEntry();
      }
      this.navigatorScroll = 0;
      this.setMessage("Showing all files.");
      this.requestRender();
      return;
    }

    if (this.state.activeScope !== "all-files") {
      this.setMessage("Related filter is only available in the all files scope.");
      this.requestRender();
      return;
    }

    const file = this.activeFile();
    const relatedPaths = getRelatedFilePaths(file);
    if (file == null || relatedPaths.size === 0) {
      this.setMessage("No related files for the active file.");
      this.requestRender();
      return;
    }

    this.relatedFilterAnchorFileId = file.id;
    this.relatedFilterReturnFileId = file.id;
    this.navigatorScroll = 0;
    this.setMessage(`Showing files related to ${file.path}. Press r to show all files.`);
    this.requestRender();
  }

  private moveNavigatorSelection(delta: number): void {
    const files = this.getNavigatorFiles();
    if (files.length === 0) {
      this.state = setActiveFileId(this.state, this.options.files, null);
      this.requestRender();
      return;
    }

    const index = files.findIndex((file) => file.id === this.state.activeFileId);
    const currentIndex = index >= 0 ? index : 0;
    const nextIndex = Math.max(0, Math.min(files.length - 1, currentIndex + delta));
    this.state = setActiveFileId(this.state, this.options.files, files[nextIndex]!.id);
    void this.ensureActiveEntry();
    this.requestRender();
  }

  private moveDiffSelection(delta: number): void {
    const file = this.activeFile();
    if (file == null) return;
    const visibleTargets = this.getVisibleLineTargets(file.id, this.state.activeScope);
    this.state = moveSelectedLineTarget(this.state, file.id, this.state.activeScope, visibleTargets, delta);
    this.requestRender();
  }

  private moveCommentSelection(delta: number): void {
    const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope);
    this.state = moveSelectedCommentIndex(this.state, items.length, delta);
    this.requestRender();
  }

  private handleMouseWheel(data: string): boolean {
    const event = parseMouseWheelInput(data);
    if (event == null) return false;

    const pane = this.getPaneAtMousePosition(event.col, event.row);
    if (pane == null) return true;

    const delta = event.direction === "down" ? 1 : -1;
    if (pane === "navigator") {
      this.state = setFocus(this.state, "navigator");
      this.moveNavigatorSelection(delta);
      return true;
    }
    if (pane === "diff") {
      this.state = setFocus(this.state, "diff");
      this.moveDiffSelection(delta);
      return true;
    }
    if (pane === "comments" && !this.commentsHidden) {
      this.state = setFocus(this.state, "comments");
      this.moveCommentSelection(delta);
      return true;
    }

    return true;
  }

  private applyShortcutByKey(key: string): void {
    const file = this.activeFile();
    const target = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    if (file == null || target == null) {
      this.shortcutMode = false;
      this.requestRender();
      return;
    }

    const shortcut = this.getAvailableShortcuts().find((item) => item.key === key.toLowerCase());
    if (shortcut == null) {
      this.setMessage(`No slash shortcut for '${key}'.`);
      this.shortcutMode = false;
      this.requestRender();
      return;
    }

    this.state = upsertLineComment(this.state, file.id, this.state.activeScope, target.side, target.line, shortcut.text, shortcut.intent);
    this.shortcutMode = false;
    this.requestRender();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.closeSearch(false);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.closeSearch(true);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.searchBuffer = this.searchBuffer.slice(0, -1);
      this.state = setSearchQuery(this.state, this.options.files, this.searchBuffer);
      void this.ensureActiveEntry();
      this.requestRender();
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.searchBuffer += data;
      this.state = setSearchQuery(this.state, this.options.files, this.searchBuffer);
      void this.ensureActiveEntry();
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.externalEditorOpen) return;
    if (this.handleMouseWheel(data)) return;

    if (this.editTarget != null) {
      if (matchesKey(data, Key.escape)) {
        this.cancelEditor();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.tab)) {
        this.toggleEditIntent();
        return;
      }
      if (matchesKey(data, Key.shift("enter"))) {
        this.editor.handleInput("\n");
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.saveEditor();
        return;
      }
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }

    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }

    if (this.shortcutMode) {
      if (matchesKey(data, Key.escape)) {
        this.closeShortcutMode();
        return;
      }
      if (data.length === 1 && data >= " ") {
        this.applyShortcutByKey(data);
        return;
      }
      return;
    }

    if (data === "?") { this.toggleHelpMode(); return; }
    if (this.helpMode && matchesKey(data, Key.escape)) { this.helpMode = false; this.requestRender(); return; }

    if (data === "1") { this.setScope("git-diff"); return; }
    if (data === "2") { this.setScope("last-commit"); return; }
    if (data === "3") { this.setScope("all-files"); return; }
    if (matchesKey(data, Key.shift("tab"))) { this.cycleVisibleFocus(true); return; }
    if (matchesKey(data, Key.tab)) { this.cycleVisibleFocus(); return; }
    if (matchesKey(data, Key.escape)) { this.cancel(); return; }
    if (data === "h") { this.toggleCommentsPane(); return; }
    if (data === "w") { this.state = setWrapLines(this.state, !this.state.wrapLines); this.requestRender(); return; }
    if (data === "u") { this.state = toggleHideUnchanged(this.state); this.ensureLineSelection(); this.requestRender(); return; }
    if (data === "s") { this.submit(); return; }
    if (data === "l") { this.editFileComment(); return; }
    if (data === "a") { this.editAllNote(); return; }
    if (data === "n") { this.moveHunk(1); return; }
    if (data === "p") { this.moveHunk(-1); return; }

    if (this.state.focus === "navigator") {
      if (matchesKey(data, Key.down) || data === "j") {
        this.moveNavigatorSelection(1);
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.moveNavigatorSelection(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.moveNavigatorSelection(getHalfPageStep(this.navigatorPageSize));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.moveNavigatorSelection(-getHalfPageStep(this.navigatorPageSize));
        return;
      }
      if (data === "r") {
        this.toggleRelatedFilter();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.state = setFocus(this.state, "diff");
        this.requestRender();
      }
      return;
    }

    if (this.state.focus === "diff") {
      if (data === "/") {
        this.openShortcutMode();
        return;
      }
      const file = this.activeFile();
      if (file != null) {
        if (matchesKey(data, Key.down) || data === "j") {
          this.moveDiffSelection(1);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          this.moveDiffSelection(-1);
          return;
        }
        if (matchesKey(data, Key.ctrl("d"))) {
          this.moveDiffSelection(getHalfPageStep(this.diffPageSize));
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          this.moveDiffSelection(-getHalfPageStep(this.diffPageSize));
          return;
        }
        if (data === "o") {
          void this.openSelectedLineInEditor();
          return;
        }
        if (data === "f") {
          this.editLineCommentWithIntent("fix");
          return;
        }
        if (data === "d" || data === "c") {
          this.editLineCommentWithIntent("discuss");
          return;
        }
        if (data === "e") {
          this.editCurrentLineComment();
          return;
        }
        if (data === "x") {
          this.deleteCurrentLineComment();
          return;
        }
      }
      return;
    }

    if (data === "/") { this.openSearch(); return; }

    if (this.state.focus === "comments") {
      const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope);
      if (matchesKey(data, Key.down) || data === "j") {
        this.moveCommentSelection(1);
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.moveCommentSelection(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.moveCommentSelection(getHalfPageStep(this.commentsPageSize));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.moveCommentSelection(-getHalfPageStep(this.commentsPageSize));
        return;
      }
      if (data === "e" || matchesKey(data, Key.enter)) {
        this.editSelectedComment();
        return;
      }
      if (data === "d") {
        this.deleteSelectedComment();
        return;
      }
    }
  }

  private renderNavigator(width: number, height: number): string[] {
    const files = this.getNavigatorFiles();
    const lines: string[] = [];
    const relatedAnchor = this.relatedFilterAnchorFile();
    const relatedSuffix = relatedAnchor == null ? "" : ` • related to ${shortenNavigatorPath(relatedAnchor.path, 24)}`;
    const titleSuffix = this.searchMode ? ` (${this.searchBuffer || "…"})` : this.state.searchQuery ? ` (${this.state.searchQuery})` : "";
    lines.push(this.theme.fg("muted", `${files.length} file${files.length === 1 ? "" : "s"}${titleSuffix}${relatedSuffix}`));
    lines.push("");

    if (files.length === 0) {
      lines.push(this.theme.fg("warning", "No files in this scope."));
      lines.push(this.theme.fg("dim", "Try another scope or clear search."));
      return renderBox("Navigator", width, height, this.theme, lines, this.state.focus === "navigator");
    }

    const maxBody = Math.max(1, height - 4);
    this.navigatorPageSize = maxBody;
    const activeIndex = Math.max(0, files.findIndex((file) => file.id === this.state.activeFileId));
    if (activeIndex < this.navigatorScroll) this.navigatorScroll = activeIndex;
    if (activeIndex >= this.navigatorScroll + maxBody) this.navigatorScroll = activeIndex - maxBody + 1;
    const visible = files.slice(this.navigatorScroll, this.navigatorScroll + maxBody);
    const activeFile = this.activeFile();
    const relationSource = relatedAnchor ?? activeFile;
    const relatedFilterActive = relatedAnchor != null;

    for (const file of visible) {
      const active = file.id === this.state.activeFileId;
      const relationMarker = getRelatedFileMarker(file, relationSource, this.state.activeScope);
      const related = relationMarker != null;
      const prefix = relationMarker == null
        ? active && !relatedFilterActive ? this.theme.fg("accent", "›") : " "
        : this.theme.fg(active || !relatedFilterActive ? "accent" : "muted", relationMarker);
      const status = this.theme.fg(active || (!relatedFilterActive && related) ? "accent" : "muted", getStatusLabel(file, this.state.activeScope));
      const count = getFileCommentCount(this.state, file.id, this.state.activeScope);
      const changeMarker = getChangeCountLabel(this.theme, file, this.state.activeScope);
      const commentMarker = count > 0 ? this.theme.fg("success", ` ${count}●`) : this.theme.fg("dim", "  ·");
      const prefixText = `${prefix} ${status} `;
      const pathWidth = Math.max(1, width - 2 - visibleWidth(prefixText) - visibleWidth(changeMarker) - visibleWidth(commentMarker));
      const shortenedPath = shortenNavigatorPath(file.path, pathWidth);
      const pathText = active || (!relatedFilterActive && related)
        ? this.theme.fg("accent", shortenedPath)
        : this.theme.fg("text", shortenedPath);
      lines.push(`${prefixText}${pathText}${changeMarker}${commentMarker}`);
    }

    return renderBox("Navigator", width, height, this.theme, lines, this.state.focus === "navigator");
  }

  private renderDiff(width: number, height: number): string[] {
    const file = this.activeFile();
    const lines: string[] = [];
    if (file == null) {
      lines.push(this.theme.fg("warning", "No file selected."));
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }

    const entry = this.getEntry(file.id, this.state.activeScope);
    lines.push(this.theme.fg("muted", getScopeDisplayPath(file, this.state.activeScope)));
    lines.push(this.theme.fg("dim", `${formatScopeLabel(this.state.activeScope)} • wrap ${this.state.wrapLines ? "on" : "off"}${this.state.activeScope === "all-files" ? "" : ` • unchanged ${this.state.hideUnchanged ? "hidden" : "shown"}`}`));
    lines.push("");

    if (entry == null || entry.status === "loading") {
      lines.push(this.theme.fg("muted", "Loading file contents…"));
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }
    if (entry.status === "error") {
      lines.push(this.theme.fg("error", "Could not load file contents."));
      lines.push(this.theme.fg("muted", entry.error));
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }

    const diff = this.getDisplayDiff(file.id, this.state.activeScope)!;
    const visibleTargets = this.getVisibleLineTargets(file.id, this.state.activeScope);
    const language = detectPiLanguage(file.path);
    this.state = clampSelectedLineTarget(this.state, file.id, this.state.activeScope, visibleTargets);
    const selectedTarget = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    const displayRows = buildDisplayRows(diff);
    const rendered: string[] = [];
    let selectedIndex = 0;

    for (const row of displayRows) {
      const isSelected = row.commentLineNumber != null
        && row.commentSide != null
        && selectedTarget?.line === row.commentLineNumber
        && selectedTarget.side === row.commentSide;
      const lineComment = row.commentLineNumber != null && row.commentSide != null
        ? getLineComment(this.state, file.id, this.state.activeScope, row.commentSide, row.commentLineNumber)
        : undefined;

      let contentText: string;
      let tone: DiffTone = "context";
      if (row.kind === "gap") {
        contentText = this.theme.fg("muted", centerText(row.codeText, Math.max(row.codeText.length + 2, 10)));
      } else {
        tone = row.kind === "added" ? "added" : row.kind === "removed" ? "removed" : "context";
        const lineLabel = row.displayLineNumber == null ? "    " : String(row.displayLineNumber).padStart(4, " ");
        const gutterLine = this.theme.fg("borderMuted", lineLabel);
        const gutterSign = row.sign === "+"
          ? this.theme.fg("success", row.sign)
          : row.sign === "-"
            ? this.theme.fg("error", row.sign)
            : this.theme.fg("toolDiffContext", row.sign);
        const commentIndicator = lineComment == null
          ? " "
          : lineComment.intent === "fix"
            ? this.theme.fg("success", "●")
            : this.theme.fg("warning", "◆");
        const highlightedCode = this.getCachedHighlightedCode(tone, row.codeText, language);
        contentText = `${gutterLine} ${gutterSign} ${commentIndicator} ${highlightedCode}`;
      }

      const renderedLines = this.getCachedRenderedDiffLines(width, this.state.wrapLines, row.kind, tone, contentText, isSelected);
      if (isSelected) selectedIndex = rendered.length;
      rendered.push(...renderedLines);
    }

    const maxBody = Math.max(1, height - 5);
    this.diffPageSize = maxBody;
    if (selectedIndex < this.diffScroll) this.diffScroll = selectedIndex;
    if (selectedIndex >= this.diffScroll + maxBody) this.diffScroll = selectedIndex - maxBody + 1;
    lines.push(...rendered.slice(this.diffScroll, this.diffScroll + maxBody));

    return renderBox(`Diff ${diff.hunks.length > 0 ? `(${diff.hunks.length} hunk${diff.hunks.length === 1 ? "" : "s"})` : ""}`.trim(), width, height, this.theme, lines, this.state.focus === "diff");
  }

  private renderHelpPanel(width: number, height: number): string[] {
    const lines: string[] = [];
    const activeShortcuts = this.getAvailableShortcuts();

    lines.push(this.theme.fg("muted", "? toggle help • Esc close"));
    lines.push("");
    lines.push(this.theme.fg("warning", "Keys"));
    lines.push(this.theme.fg("muted", "1/2/3 scope • Tab focus • / shortcuts/search • r related • h comments • s submit"));
    lines.push(this.theme.fg("muted", "f line fix • d/c line discuss • e edit line • x delete line"));
    lines.push(this.theme.fg("muted", "Ctrl+d/u half-page • o open in $EDITOR • l file • a all • n/p hunks"));
    lines.push("");
    lines.push(this.theme.fg("warning", "Editor"));
    lines.push(this.theme.fg("muted", "Tab toggle • Enter save • Shift+Enter newline • Esc cancel"));
    lines.push("");
    lines.push(this.theme.fg("warning", "Slash shortcuts"));
    if (activeShortcuts.length === 0) {
      lines.push(this.theme.fg("dim", "No active shortcuts for the current selection."));
    } else {
      for (const shortcut of activeShortcuts) {
        const badge = getIntentBadge(this.theme, shortcut.intent);
        lines.push(`${this.theme.fg("accent", shortcut.key)} ${this.theme.fg("text", shortcut.label)} ${badge}`);
      }
    }
    lines.push("");
    lines.push(this.theme.fg("warning", "Config"));
    lines.push(...wrapAnsiText(this.theme.fg("muted", getShortcutConfigPath()), Math.max(10, width - 4), true));

    return renderBox("Help", width, height, this.theme, lines, true);
  }

  private renderComments(width: number, height: number): string[] {
    const file = this.activeFile();
    const lines: string[] = [];
    const fileId = file?.id ?? null;
    const items = getCommentPanelItems(this.state, fileId, this.state.activeScope);
    this.state = moveSelectedCommentIndex(this.state, items.length, 0);

    if (this.shortcutMode) {
      const shortcuts = this.getAvailableShortcuts();
      lines.push(this.theme.fg("muted", "Press a key to apply a templated comment."));
      lines.push(this.theme.fg("dim", "Esc cancel"));
      lines.push("");

      if (shortcuts.length === 0) {
        lines.push(this.theme.fg("warning", "No shortcuts available."));
        return renderBox("Slash shortcuts", width, height, this.theme, lines, true);
      }

      const groups = [
        { intent: "discuss" as const, header: this.theme.fg("warning", "DISCUSS") },
        { intent: "fix" as const, header: this.theme.fg("success", "FIX") },
      ];

      groups.forEach((group, groupIndex) => {
        const groupShortcuts = shortcuts.filter((shortcut) => shortcut.intent === group.intent);
        if (groupShortcuts.length === 0) return;
        if (groupIndex > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(group.header);
        lines.push("");

        for (const shortcut of groupShortcuts) {
          lines.push(`${this.theme.fg("accent", shortcut.key)} ${this.theme.fg("text", shortcut.label)}`);
          for (const line of wrapAnsiText(this.theme.fg("muted", shortcut.text), Math.max(10, width - 4), true).slice(0, 3)) {
            lines.push(`  ${line}`);
          }
          lines.push("");
        }
      });

      return renderBox("Slash shortcuts", width, height, this.theme, lines, true);
    }

    if (this.helpMode) {
      return this.renderHelpPanel(width, height);
    }

    if (this.editTarget != null) {
      lines.push(this.theme.fg("muted", this.editTarget.kind === "all"
        ? "All note"
        : this.editTarget.kind === "file"
          ? "File comment"
          : `${formatLineSideLabel(this.editTarget.side)} line ${this.editTarget.line}`));
      lines.push(`${getIntentBadge(this.theme, this.editTarget.intent)} ${this.theme.fg("dim", "Tab toggle")}`);
      lines.push(this.theme.fg("dim", "Enter save • Shift+Enter newline"));
      lines.push(this.theme.fg("dim", "Esc cancel"));
      lines.push("");
      const editorLines = this.editor.render(Math.max(10, width - 4));
      lines.push(...editorLines.map((line) => ` ${line}`));
      return renderBox("Edit comment", width, height, this.theme, lines, true);
    }

    lines.push(this.theme.fg("muted", `${this.state.draft.comments.length} scoped comment${this.state.draft.comments.length === 1 ? "" : "s"}`));
    lines.push(this.theme.fg("dim", this.state.draft.allComment ? `all note set • ${formatIntentLabel(this.state.draft.allIntent).toLowerCase()}` : "all note: none"));
    lines.push("");

    if (file != null) {
      const fileComment = getFileComment(this.state, file.id, this.state.activeScope);
      const selectedTarget = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
      const lineComment = selectedTarget == null
        ? undefined
        : getLineComment(this.state, file.id, this.state.activeScope, selectedTarget.side, selectedTarget.line);
      lines.push(this.theme.fg("muted", `file: ${fileComment ? "commented" : "none"}`));
      lines.push(this.theme.fg("muted", selectedTarget == null
        ? "line —: none"
        : `${formatLineSideLabel(selectedTarget.side).toLowerCase()} ${selectedTarget.line}: ${lineComment ? "commented" : "none"}`));
      lines.push("");
    }

    if (items.length === 0) {
      lines.push(this.theme.fg("dim", "No comments yet."));
      lines.push(this.theme.fg("dim", "Use f/d/c for line, l for file, or a for all."));
      return renderBox("Comments", width, height, this.theme, lines, this.state.focus === "comments");
    }

    const maxBody = Math.max(1, height - 5);
    this.commentsPageSize = maxBody;
    const activeIndex = Math.max(0, this.state.selectedCommentIndex);
    if (activeIndex < this.commentsScroll) this.commentsScroll = activeIndex;
    if (activeIndex >= this.commentsScroll + maxBody) this.commentsScroll = activeIndex - maxBody + 1;

    for (const [index, item] of items.slice(this.commentsScroll, this.commentsScroll + maxBody).entries()) {
      const absoluteIndex = this.commentsScroll + index;
      const selected = absoluteIndex === activeIndex;
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const label = getPanelItemLabel(this.theme, item);
      lines.push(prefix + (selected ? this.theme.fg("accent", label) : label));
      const body = item.kind === "all" ? item.body : item.comment.body;
      for (const line of wrapAnsiText(this.theme.fg("muted", body), Math.max(10, width - 4), true).slice(0, 3)) {
        lines.push(`   ${line}`);
      }
      if (item.kind === "comment" && item.comment.side !== "file") {
        lines.push(this.theme.fg("dim", `   ${getScopeDisplayPath(file, this.state.activeScope)}:${item.comment.startLine} (${item.comment.side})`));
      }
      lines.push("");
    }

    return renderBox("Comments", width, height, this.theme, lines, this.state.focus === "comments");
  }

  render(width: number): string[] {
    this.lastWidth = Math.max(40, width);
    const terminalRows = this.tui?.terminal?.rows ?? 28;
    const totalHeight = Math.max(20, terminalRows - 4);
    const frameColor = "accent" as const;
    const frameInnerWidth = Math.max(20, this.lastWidth - 2 - MODAL_INNER_PADDING_X * 2);
    const frameInnerHeight = Math.max(10, totalHeight - 2 - MODAL_INNER_PADDING_Y * 2);
    const stackPanes = shouldStackPanes(frameInnerWidth);
    const bodyHeight = Math.max(stackPanes && !this.commentsHidden ? 9 : 6, frameInnerHeight - 5);
    const terminalCols = this.tui?.terminal?.columns ?? this.lastWidth;
    const overlayOriginCol = Math.max(0, Math.floor((terminalCols - this.lastWidth) / 2));
    const overlayOriginRow = Math.max(0, Math.floor((terminalRows - totalHeight) / 2));
    const bodyTop = overlayOriginRow + 1 + MODAL_INNER_PADDING_Y + 1;
    const contentLeft = overlayOriginCol + 1 + MODAL_INNER_PADDING_X;

    const layoutStatus = stackPanes ? "stacked layout • " : "";
    const promptStatus = this.shortcutMode
      ? "Shortcut mode • choose from the comments panel • Esc cancel"
      : this.helpMode
        ? "Help open • ? toggle • Esc close"
        : this.message ?? (this.searchMode
          ? `Search: ${this.searchBuffer}`
          : this.editTarget != null
            ? `Editing ${formatIntentLabel(this.editTarget.intent).toLowerCase()} comment`
            : `${layoutStatus}Tab focus • / search • ? help • 1/2/3 scopes • h ${this.commentsHidden ? "show" : "hide"} comments • o open • s submit • Esc cancel`);

    const scopeTabs = SEARCHABLE_SCOPES.map((scope, index) => {
      const active = this.state.activeScope === scope;
      const count = getScopedFiles(this.options.files, scope).length;
      const text = `${index + 1}:${formatScopeLabel(scope)}(${count})`;
      return active ? this.theme.bg("selectedBg", this.theme.fg("text", ` ${text} `)) : this.theme.fg("muted", ` ${text} `);
    }).join(" ");

    const headerLines = [
      truncateToWidth(scopeTabs, frameInnerWidth, "", false),
    ];

    const body: string[] = [];

    if (stackPanes) {
      const { navigatorHeight, diffHeight, commentsHeight } = getStackedPaneLayout(bodyHeight, this.commentsHidden);
      const paneLeft = contentLeft;
      const paneRight = contentLeft + frameInnerWidth - 1;
      const navigatorTop = bodyTop;
      const diffTop = navigatorTop + navigatorHeight;
      const commentsTop = diffTop + diffHeight;
      this.mousePaneLayout = {
        navigator: { top: navigatorTop, bottom: navigatorTop + navigatorHeight - 1, left: paneLeft, right: paneRight },
        diff: { top: diffTop, bottom: diffTop + diffHeight - 1, left: paneLeft, right: paneRight },
        comments: this.commentsHidden ? null : { top: commentsTop, bottom: commentsTop + commentsHeight - 1, left: paneLeft, right: paneRight },
      };

      body.push(...this.renderNavigator(frameInnerWidth, navigatorHeight));
      body.push(...this.renderDiff(frameInnerWidth, diffHeight));
      if (!this.commentsHidden) body.push(...this.renderComments(frameInnerWidth, commentsHeight));
    } else {
      const { navigatorWidth, diffWidth, commentsWidth } = getPaneLayout(frameInnerWidth, this.commentsHidden);
      const diffLeft = contentLeft + navigatorWidth + 1;
      const commentsLeft = this.commentsHidden ? null : diffLeft + diffWidth + 1;
      this.mousePaneLayout = {
        navigator: { top: bodyTop, bottom: bodyTop + bodyHeight - 1, left: contentLeft, right: contentLeft + navigatorWidth - 1 },
        diff: { top: bodyTop, bottom: bodyTop + bodyHeight - 1, left: diffLeft, right: diffLeft + diffWidth - 1 },
        comments: commentsLeft == null ? null : { top: bodyTop, bottom: bodyTop + bodyHeight - 1, left: commentsLeft, right: commentsLeft + commentsWidth - 1 },
      };

      const navigator = this.renderNavigator(navigatorWidth, bodyHeight);
      const diff = this.renderDiff(diffWidth, bodyHeight);
      const comments = this.commentsHidden ? [] : this.renderComments(commentsWidth, bodyHeight);

      for (let i = 0; i < bodyHeight; i += 1) {
        body.push(this.commentsHidden
          ? `${navigator[i] ?? ""} ${diff[i] ?? ""}`
          : `${navigator[i] ?? ""} ${diff[i] ?? ""} ${comments[i] ?? ""}`);
      }
    }

    const footer = [
      truncateToWidth(this.theme.fg("dim", promptStatus), frameInnerWidth, "…", false),
      truncateToWidth(this.theme.fg("dim", "navigator: ↑↓ files, Ctrl+d/u half-page, r related filter • diff: ↑↓ lines, Ctrl+d/u half-page, / shortcuts, o open in $EDITOR, f fix line, d/c discuss line, e edit, x delete, l file, a all, n/p hunks • comments: h hide/show, ↑↓ comments, Ctrl+d/u half-page, e edit, d delete • editor: Tab toggle intent, Enter save, Shift+Enter newline • ? help • w wrap • u toggle unchanged"), frameInnerWidth, "…", false),
    ];

    return renderOuterFrame(this.lastWidth, totalHeight, this.theme, "slopchop", [...headerLines, ...body, ...footer], frameColor);
  }
}

export async function runReviewApp(
  ctx: ExtensionContext,
  options: Omit<ReviewAppOptions, "notify">,
): Promise<ReviewResult> {
  return ctx.ui.custom<ReviewResult>(
    (tui, theme, _kb, done) => new ReviewApp(tui, theme, done, { ...options, notify: ctx.ui.notify.bind(ctx.ui) }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        maxHeight: "100%",
        minWidth: 40,
        margin: 1,
      },
    },
  );
}
