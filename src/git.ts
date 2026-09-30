import { open, readFile, stat } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope, ReviewSubmoduleByScope, ReviewSubmoduleInfo, Vcs } from "./types.js";
export type { Vcs } from "./types.js";

export interface RepoContext {
  vcs: Vcs;
  repoRoot: string;
}

export interface ReviewWindowData {
  vcs: Vcs;
  repoRoot: string;
  files: ReviewFile[];
}

export interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

export interface ChangeStats {
  additions: number;
  deletions: number;
  statsTruncated?: boolean;
}

interface ReviewFileSeed {
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  inAllFiles: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  allFiles: ReviewFileComparison | null;
  allFilesReferenceCount: number;
  allFilesOutgoingReferences: string[];
  allFilesIncomingReferences: string[];
  submodule?: ReviewSubmoduleByScope;
}

export interface RawDiffChange extends ChangedPath {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

async function runJj(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("jj", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `jj ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runJjAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("jj", args, { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

/**
 * Detect which VCS owns the working directory. A jj workspace always contains a
 * `.jj` directory at its root and may also contain a colocated `.git`, so jj is
 * probed first and wins whenever it applies.
 */
export async function getRepoContext(pi: ExtensionAPI, cwd: string): Promise<RepoContext> {
  const jjResult = await pi.exec("jj", ["root"], { cwd });
  if (jjResult.code === 0) {
    const repoRoot = jjResult.stdout.trim();
    if (repoRoot.length > 0) return { vcs: "jj", repoRoot };
  }

  const gitResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (gitResult.code !== 0) {
    throw new Error("Not inside a git or jj repository.");
  }
  return { vcs: "git", repoRoot: gitResult.stdout.trim() };
}

/**
 * Classify a known repository root without spawning any process: a jj workspace
 * always has a `.jj` directory at its root.
 */
async function detectVcsAt(repoRoot: string): Promise<Vcs> {
  try {
    const entry = await stat(join(repoRoot, ".jj"));
    if (entry.isDirectory()) return "jj";
  } catch {
    // Not a jj workspace; fall through to git.
  }
  return "git";
}

const LARGE_DIFF_MAX_BYTES = 1_000_000;
const LARGE_DIFF_MAX_CHANGED_LINES = 20_000;

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const context = await getRepoContext(pi, cwd);
  return context.repoRoot;
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

export function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "modified", oldPath: path, newPath: path });
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "deleted", oldPath: path, newPath: null });
    }
  }

  return changes;
}

function parseRawStatus(rawStatus: string): ChangeStatus | null {
  const code = rawStatus[0];
  if (code === "M" || code === "T") return "modified";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return null;
}

export function parseRawDiff(output: string): RawDiffChange[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const changes: RawDiffChange[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (header == null || !header.startsWith(":")) continue;

    const parts = header.slice(1).split(" ");
    const oldMode = parts[0] ?? "";
    const newMode = parts[1] ?? "";
    const oldSha = parts[2] ?? "";
    const newSha = parts[3] ?? "";
    const rawStatus = parts[4] ?? "";
    const status = parseRawStatus(rawStatus);
    if (status == null) continue;

    const oldPath = fields[index++] ?? null;
    const newPath = status === "renamed" ? fields[index++] ?? null : oldPath;
    if (oldPath == null) continue;

    changes.push({
      status,
      oldPath: status === "added" ? null : oldPath,
      newPath: status === "deleted" ? null : newPath,
      oldMode,
      newMode,
      oldSha,
      newSha,
    });
  }

  return changes;
}

export function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({ status: "added" as const, oldPath: null, newPath: path }));
}

function parseTrackedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(change);
  }

  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function parseStatCount(value: string | undefined): number {
  if (value == null || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumStatPath(path: string): string {
  if (!path.includes(" => ")) return path;
  const expanded = path.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
  if (!expanded.includes(" => ")) return expanded;
  return expanded.split(" => ").pop() ?? expanded;
}

export function parseNumStat(output: string): Map<string, ChangeStats> {
  const stats = new Map<string, ChangeStats>();

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const rawPath = parts.slice(2).join("\t");
    if (rawPath.length === 0) continue;
    stats.set(normalizeGitPath(normalizeNumStatPath(rawPath)), {
      additions: parseStatCount(parts[0]),
      deletions: parseStatCount(parts[1]),
    });
  }

  return stats;
}

function changedLineCount(stats: ChangeStats | undefined): number {
  return (stats?.additions ?? 0) + (stats?.deletions ?? 0);
}

function exceedsLargeDiffLineLimit(stats: ChangeStats | undefined): boolean {
  return changedLineCount(stats) > LARGE_DIFF_MAX_CHANGED_LINES;
}

async function getWorkingTreeFileSize(repoRoot: string, path: string | null | undefined): Promise<number | null> {
  if (path == null) return null;
  try {
    const result = await stat(join(repoRoot, path));
    return result.isFile() ? result.size : null;
  } catch {
    return null;
  }
}

async function isLargeWorkingTreeFile(repoRoot: string, path: string | null | undefined): Promise<boolean> {
  const size = await getWorkingTreeFileSize(repoRoot, path);
  return size != null && size > LARGE_DIFF_MAX_BYTES;
}

interface BoundedLineCount {
  complete: boolean;
  lines: number;
}

async function countLinesInFileWithLimit(path: string, maxBytes: number, maxLines: number): Promise<BoundedLineCount> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    const fileStat = await stat(path);
    handle = await open(path, "r");
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, maxBytes)));
    let position = 0;
    let lineCount = 0;
    let lastByte: number | undefined;

    while (position < maxBytes && lineCount <= maxLines) {
      const bytesToRead = Math.min(buffer.length, maxBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead === 0) break;

      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        lastByte = buffer[index];
        if (lastByte === 0x0a) lineCount += 1;
        if (lineCount > maxLines) break;
      }
    }

    const countedLines = lastByte !== undefined && lastByte !== 0x0a ? lineCount + 1 : lineCount;
    return {
      complete: position >= fileStat.size && countedLines <= maxLines,
      lines: countedLines,
    };
  } catch {
    return { complete: true, lines: 0 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function getUntrackedFileStats(repoRoot: string, path: string): Promise<{ stats: ChangeStats; isTooLarge: boolean }> {
  const absolutePath = join(repoRoot, path);
  const size = await getWorkingTreeFileSize(repoRoot, path);
  if (size == null) return { stats: { additions: 0, deletions: 0 }, isTooLarge: false };

  if (size > LARGE_DIFF_MAX_BYTES) {
    const counted = await countLinesInFileWithLimit(absolutePath, LARGE_DIFF_MAX_BYTES, LARGE_DIFF_MAX_CHANGED_LINES);
    return {
      stats: { additions: counted.lines, deletions: 0, statsTruncated: !counted.complete },
      isTooLarge: true,
    };
  }

  const counted = await countLinesInFileWithLimit(absolutePath, size, LARGE_DIFF_MAX_CHANGED_LINES);
  const isTooLarge = counted.lines > LARGE_DIFF_MAX_CHANGED_LINES;
  return {
    stats: { additions: counted.lines, deletions: 0, statsTruncated: !counted.complete },
    isTooLarge,
  };
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(
  change: ChangedPath,
  stats?: ChangeStats,
  revisions?: { originalRevision?: string | null; modifiedRevision?: string | null },
  options?: { isTooLarge?: boolean },
): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
    additions: stats?.additions,
    deletions: stats?.deletions,
    isTooLarge: options?.isTooLarge,
    statsTruncated: stats?.statsTruncated,
    originalRevision: revisions?.originalRevision,
    modifiedRevision: revisions?.modifiedRevision,
  };
}

function buildReviewFileId(
  path: string,
  hasWorkingTreeFile: boolean,
  gitDiff: ReviewFileComparison | null,
  lastCommit: ReviewFileComparison | null,
  allFiles: ReviewFileComparison | null,
): string {
  return [path, hasWorkingTreeFile ? "working" : "gone", gitDiff?.displayPath ?? "", lastCommit?.displayPath ?? "", allFiles?.displayPath ?? ""].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit, seed.allFiles),
    path: seed.path,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    inAllFiles: seed.inAllFiles,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
    allFiles: seed.allFiles,
    allFilesReferenceCount: seed.allFilesReferenceCount,
    allFilesOutgoingReferences: seed.allFilesOutgoingReferences,
    allFilesIncomingReferences: seed.allFilesIncomingReferences,
    submodule: seed.submodule,
  };
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

export function isReviewableFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);

  if (fileName.length === 0) return false;

  const binaryExtensions = new Set([
    ".7z",
    ".a",
    ".avi",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".dll",
    ".dylib",
    ".eot",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".lockb",
    ".map",
    ".mov",
    ".mp3",
    ".mp4",
    ".o",
    ".otf",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".svgz",
    ".tar",
    ".ttf",
    ".wasm",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ]);

  if (binaryExtensions.has(extension)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;

  return true;
}

function normalizeGitPath(path: string): string {
  return posix.normalize(path).replace(/^\.\//, "");
}

function normalizeDiffSha(sha: string): string | null {
  return /^0+$/.test(sha) ? null : sha;
}

function isSubmoduleRawChange(change: RawDiffChange): boolean {
  return change.oldMode === "160000" || change.newMode === "160000";
}

function rawDiffMap(changes: RawDiffChange[]): Map<string, RawDiffChange> {
  return new Map(changes.map((change) => [normalizeGitPath(getChangeKey(change)), change]));
}

async function getNestedRepoRoot(pi: ExtensionAPI, parentRepoRoot: string, submodulePath: string): Promise<{ repoRoot: string } | { unavailableReason: string }> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: join(parentRepoRoot, submodulePath) });
  if (result.code !== 0) return { unavailableReason: "submodule is not initialized locally" };

  const repoRoot = result.stdout.trim();
  if (repoRoot.length === 0 || repoRoot === parentRepoRoot) {
    return { unavailableReason: "submodule path does not resolve to a nested repository" };
  }

  return { repoRoot };
}

function getSubmoduleInfo(repoRoot: string | null, raw: RawDiffChange): ReviewSubmoduleInfo {
  return {
    repoRoot: repoRoot ?? "",
    path: raw.newPath ?? raw.oldPath ?? "(unknown)",
    oldSha: normalizeDiffSha(raw.oldSha),
    newSha: normalizeDiffSha(raw.newSha),
    available: repoRoot != null,
    unavailableReason: repoRoot == null ? "submodule is not initialized locally" : undefined,
  };
}

function getChangeKey(change: ChangedPath): string {
  return change.newPath ?? change.oldPath ?? toDisplayPath(change);
}

function getImportAliases(path: string): string[] {
  const normalized = normalizeGitPath(path);
  const aliases = [normalized];
  const extension = posix.extname(normalized);

  if (extension.length > 0) {
    aliases.push(normalized.slice(0, -extension.length));
  }

  const directory = posix.dirname(normalized);
  const basename = posix.basename(normalized, extension);
  if (basename === "index" && directory !== ".") {
    aliases.push(directory);
  }

  return aliases;
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier != null) specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveRelativeImport(sourcePath: string, specifier: string, aliases: Map<string, string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = normalizeGitPath(posix.join(posix.dirname(sourcePath), specifier));
  return aliases.get(resolved) ?? null;
}

export interface ChangedFileReferenceGraph {
  counts: Map<string, number>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

export function getChangedFileReferenceGraph(changes: ChangedPath[], contentsByPath: Map<string, string>): ChangedFileReferenceGraph {
  const paths = changes.map(getChangeKey).map(normalizeGitPath);
  const pathSet = new Set(paths);
  const aliases = new Map<string, string>();
  const counts = new Map<string, number>(paths.map((path) => [path, 0]));
  const outgoingSets = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));
  const incomingSets = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));

  for (const path of paths) {
    for (const alias of getImportAliases(path)) {
      if (!aliases.has(alias)) aliases.set(alias, path);
    }
  }

  for (const change of changes) {
    if (change.newPath == null) continue;
    const sourcePath = normalizeGitPath(change.newPath);
    const content = contentsByPath.get(sourcePath) ?? contentsByPath.get(change.newPath) ?? "";
    const referencedPaths = new Set<string>();

    for (const specifier of extractImportSpecifiers(content)) {
      const referencedPath = resolveRelativeImport(sourcePath, specifier, aliases);
      if (referencedPath == null || referencedPath === sourcePath || !pathSet.has(referencedPath)) continue;
      referencedPaths.add(referencedPath);
    }

    for (const referencedPath of referencedPaths) {
      counts.set(referencedPath, (counts.get(referencedPath) ?? 0) + 1);
      outgoingSets.get(sourcePath)?.add(referencedPath);
      incomingSets.get(referencedPath)?.add(sourcePath);
    }
  }

  const toSortedArrays = (map: Map<string, Set<string>>): Map<string, string[]> => new Map(
    [...map.entries()].map(([path, relatedPaths]) => [path, [...relatedPaths].sort((a, b) => a.localeCompare(b))]),
  );

  return {
    counts,
    outgoing: toSortedArrays(outgoingSets),
    incoming: toSortedArrays(incomingSets),
  };
}

export function getChangedFileReferenceCounts(changes: ChangedPath[], contentsByPath: Map<string, string>): Map<string, number> {
  return getChangedFileReferenceGraph(changes, contentsByPath).counts;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

function upsertSeed(seeds: Map<string, ReviewFileSeed>, key: string, create: () => ReviewFileSeed): ReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = create();
  seeds.set(key, seed);
  return seed;
}

function createSeed(path: string, hasWorkingTreeFile: boolean): ReviewFileSeed {
  return {
    path,
    worktreeStatus: null,
    hasWorkingTreeFile,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    allFilesReferenceCount: 0,
    allFilesOutgoingReferences: [],
    allFilesIncomingReferences: [],
  };
}

async function getFirstExistingRef(pi: ExtensionAPI, repoRoot: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoRoot });
    if (result.code === 0) return ref;
  }
  return null;
}

export async function getDefaultBranchRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const originHead = (await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
  if (originHead.length > 0 && originHead !== "origin/HEAD") return originHead;

  return getFirstExistingRef(pi, repoRoot, ["origin/main", "origin/master", "main", "master"]);
}

async function getBranchBaseRevision(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const defaultBranch = await getDefaultBranchRef(pi, repoRoot);
  if (defaultBranch == null) return null;
  const result = await pi.exec("git", ["merge-base", defaultBranch, "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string): Promise<ReviewWindowData> {
  const { vcs, repoRoot } = await getRepoContext(pi, cwd);
  const data = vcs === "jj" ? await getJjReviewWindowData(pi, repoRoot) : await getGitReviewWindowData(pi, repoRoot);
  return { vcs, ...data };
}

async function getGitReviewWindowData(pi: ExtensionAPI, repoRoot: string): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const trackedDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const worktreeRawOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--raw", "-z", "HEAD", "--"])
    : "";
  const worktreeNumStatOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"]);
  const lastCommitOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
    : "";
  const lastCommitRawOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--raw", "-z", "--no-commit-id", "-r", "HEAD"])
    : "";
  const lastCommitNumStatOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--numstat", "--no-commit-id", "-r", "HEAD"])
    : "";
  const branchBaseRevision = repositoryHasHead ? await getBranchBaseRevision(pi, repoRoot) : null;
  const branchDiffOutput = branchBaseRevision == null
    ? ""
    : await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", branchBaseRevision, "HEAD", "--"]);
  const branchRawOutput = branchBaseRevision == null
    ? ""
    : await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--raw", "-z", branchBaseRevision, "HEAD", "--"]);
  const branchNumStatOutput = branchBaseRevision == null
    ? ""
    : await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", branchBaseRevision, "HEAD", "--"]);

  const untrackedChanges = parseUntrackedPaths(untrackedOutput);
  const worktreeStats = parseNumStat(worktreeNumStatOutput);
  const worktreeLargePaths = new Set<string>();
  await Promise.all(untrackedChanges.map(async (change) => {
    if (change.newPath == null) return;
    const inspection = await getUntrackedFileStats(repoRoot, change.newPath);
    const normalizedPath = normalizeGitPath(change.newPath);
    worktreeStats.set(normalizedPath, inspection.stats);
    if (inspection.isTooLarge) worktreeLargePaths.add(normalizedPath);
  }));
  const lastCommitStats = parseNumStat(lastCommitNumStatOutput);
  const branchStats = parseNumStat(branchNumStatOutput);
  const worktreeRaw = rawDiffMap(parseRawDiff(worktreeRawOutput));
  const lastCommitRaw = rawDiffMap(parseRawDiff(lastCommitRawOutput));
  const branchRaw = rawDiffMap(parseRawDiff(branchRawOutput));
  const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), untrackedChanges)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  await Promise.all(worktreeChanges.map(async (change) => {
    const key = normalizeGitPath(getChangeKey(change));
    if (worktreeLargePaths.has(key)) return;
    const stats = worktreeStats.get(key);
    if (exceedsLargeDiffLineLimit(stats) || await isLargeWorkingTreeFile(repoRoot, change.newPath)) {
      worktreeLargePaths.add(key);
    }
  }));
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const currentPaths = uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)])
    .filter((path) => !deletedPaths.has(path))
    .filter(isReviewableFilePath);
  const currentPathSet = new Set(currentPaths);
  const lastCommitChanges = parseNameStatus(lastCommitOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const lastCommitLargePaths = new Set<string>();
  await Promise.all(lastCommitChanges.map(async (change) => {
    const key = normalizeGitPath(getChangeKey(change));
    const stats = lastCommitStats.get(key);
    if (exceedsLargeDiffLineLimit(stats) || await isLargeWorkingTreeFile(repoRoot, change.newPath)) {
      lastCommitLargePaths.add(key);
    }
  }));
  const branchChanges = parseNameStatus(branchDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const branchLargePaths = new Set<string>();
  await Promise.all(branchChanges.map(async (change) => {
    const key = normalizeGitPath(getChangeKey(change));
    const stats = branchStats.get(key);
    if (exceedsLargeDiffLineLimit(stats) || await isLargeWorkingTreeFile(repoRoot, change.newPath)) {
      branchLargePaths.add(key);
    }
  }));
  const branchContentsByPath = new Map<string, string>();
  await Promise.all(branchChanges.map(async (change) => {
    if (change.newPath == null) return;
    const key = normalizeGitPath(getChangeKey(change));
    if (branchLargePaths.has(key)) return;
    branchContentsByPath.set(normalizeGitPath(change.newPath), await getWorkingTreeContent(repoRoot, change.newPath));
  }));
  const branchReferenceGraph = getChangedFileReferenceGraph(branchChanges, branchContentsByPath);

  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of worktreeChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change, worktreeStats.get(normalizeGitPath(key)), undefined, { isTooLarge: worktreeLargePaths.has(normalizeGitPath(key)) });
  }

  for (const change of branchChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, branchStats.get(normalizeGitPath(key)), undefined, { isTooLarge: branchLargePaths.has(normalizeGitPath(key)) });
    seed.allFilesReferenceCount = branchReferenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = branchReferenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = branchReferenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  for (const change of lastCommitChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change, lastCommitStats.get(normalizeGitPath(key)), undefined, { isTooLarge: lastCommitLargePaths.has(normalizeGitPath(key)) });
  }

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inAllFiles = true;
      seeds.set(path, seed);
    }
  }

  const markSubmodule = async (scope: ReviewScope, rawMap: Map<string, RawDiffChange>, stats: Map<string, ChangeStats>): Promise<void> => {
    for (const [key, raw] of rawMap.entries()) {
      if (!isSubmoduleRawChange(raw)) continue;
      const seed = upsertSeed(seeds, key, () => createSeed(key, raw.newPath != null));
      if (scope === "git-diff") {
        seed.worktreeStatus = raw.status;
        seed.hasWorkingTreeFile = raw.newPath != null;
        seed.inGitDiff = true;
        seed.gitDiff ??= toComparison(raw, stats.get(normalizeGitPath(key)));
      } else if (scope === "last-commit") {
        seed.inLastCommit = true;
        seed.lastCommit ??= toComparison(raw, stats.get(normalizeGitPath(key)));
      } else {
        seed.inAllFiles = true;
        seed.allFiles ??= toComparison(raw, stats.get(normalizeGitPath(key)));
      }

      const submodulePath = raw.newPath ?? raw.oldPath;
      const nested = submodulePath == null || raw.newPath == null
        ? { unavailableReason: "submodule is not available in the working tree" }
        : await getNestedRepoRoot(pi, repoRoot, submodulePath);
      const info = "repoRoot" in nested
        ? getSubmoduleInfo(nested.repoRoot, raw)
        : { ...getSubmoduleInfo(null, raw), unavailableReason: nested.unavailableReason };
      seed.submodule = { ...(seed.submodule ?? {}), [scope]: info };
    }
  };

  await markSubmodule("git-diff", worktreeRaw, worktreeStats);
  await markSubmodule("last-commit", lastCommitRaw, lastCommitStats);
  await markSubmodule("all-files", branchRaw, branchStats);

  const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);
  return { repoRoot, files };
}

/**
 * Convert a jj display path such as `{dir1 => dir2}/app.ts` into the concrete
 * old and new paths of the change.
 */
function parseBraceDisplayPath(display: string): { oldPath: string; newPath: string } {
  const start = display.indexOf("{");
  const end = display.indexOf("}");
  if (start >= 0 && end > start) {
    const prefix = display.slice(0, start);
    const inner = display.slice(start + 1, end);
    const suffix = display.slice(end + 1);
    const arrow = inner.indexOf("=>");
    if (arrow >= 0) {
      const oldPart = inner.slice(0, arrow).trim();
      const newPart = inner.slice(arrow + 2).trim();
      return { oldPath: `${prefix}${oldPart}${suffix}`, newPath: `${prefix}${newPart}${suffix}` };
    }
  }
  return { oldPath: display, newPath: display };
}

/**
 * Parse `jj diff --summary` output (`A path`, `M path`, `D path`,
 * `R {old => new}`) into the shared ChangedPath shape.
 */
export function parseJjSummary(output: string): ChangedPath[] {
  const changes: ChangedPath[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const code = trimmed[0]!;
    const displayPath = trimmed.slice(1).trim();
    if (code === "A") {
      changes.push({ status: "added", oldPath: null, newPath: displayPath });
    } else if (code === "D") {
      changes.push({ status: "deleted", oldPath: displayPath, newPath: null });
    } else if (code === "M") {
      changes.push({ status: "modified", oldPath: displayPath, newPath: displayPath });
    } else if (code === "R") {
      const { oldPath, newPath } = parseBraceDisplayPath(displayPath);
      changes.push({ status: "renamed", oldPath, newPath });
    } else if (code === "C") {
      // jj copies are rare; surface them as added files on the target path.
      changes.push({ status: "added", oldPath: null, newPath: parseBraceDisplayPath(displayPath).newPath });
    }
  }
  return changes;
}

/**
 * Parse `jj diff --stat` output into the exact total changed lines per target
 * path. The trailing `N files changed, ...` summary line is skipped.
 */
export function parseJjStatTotals(output: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const pipeIndex = trimmed.lastIndexOf("|");
    if (pipeIndex < 0) continue;
    const displayPath = trimmed.slice(0, pipeIndex).trim();
    const statPart = trimmed.slice(pipeIndex + 1).trim();
    const match = statPart.match(/^(\d+)/);
    if (match == null) continue;
    totals.set(normalizeGitPath(parseBraceDisplayPath(displayPath).newPath), Number.parseInt(match[1]!, 10));
  }
  return totals;
}

function parseGitDiffTargetPath(header: string): string {
  const rest = header.slice("diff --git ".length);
  const bIndex = rest.indexOf(" b/");
  const bPart = bIndex >= 0 ? rest.slice(bIndex + 3) : rest;
  const unquoted = bPart.startsWith('"') && bPart.endsWith('"') ? bPart.slice(1, -1) : bPart;
  return unquoted;
}

/**
 * Parse `jj diff --git` output into exact per-file addition/deletion counts by
 * counting patch lines, keyed by the target (new) path.
 */
export function parseJjGitDiffStats(output: string): Map<string, ChangeStats> {
  const stats = new Map<string, ChangeStats>();
  let currentPath: string | null = null;
  let additions = 0;
  let deletions = 0;

  const flush = (): void => {
    if (currentPath != null) {
      stats.set(normalizeGitPath(currentPath), { additions, deletions });
    }
    currentPath = null;
    additions = 0;
    deletions = 0;
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentPath = parseGitDiffTargetPath(line);
    } else if (currentPath != null) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  flush();
  return stats;
}

/**
 * Resolve the jj base revision for the completed "change stack" scope: the
 * merge base of the default branch (configured trunk, else remote/local main
 * or master) and the parent of the working-copy commit `@`.
 */
async function getJjBranchBaseRevision(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const candidates: string[] = [];
  const trunkConfig = await pi.exec("jj", ["config", "list", "revset-aliases.\"trunk()\"", "--color", "never"], { cwd: repoRoot });
  if (trunkConfig.code === 0 && trunkConfig.stdout.trim().length > 0) candidates.push("trunk()");
  candidates.push("main@origin", "master@origin", "main", "master");

  for (const candidate of candidates) {
    const resolveResult = await runJjAllowFailure(pi, repoRoot, ["log", "-r", candidate, "--no-graph", "-T", "commit_id", "--color", "never"]);
    if (resolveResult.trim().length === 0) continue;
    const baseResult = await runJjAllowFailure(pi, repoRoot, ["log", "-r", `heads(::${candidate} & ::@-)`, "--no-graph", "-T", "commit_id", "--color", "never"]);
    const commitId = baseResult.trim().split(/\r?\n/)[0];
    if (commitId != null && commitId.length > 0) return commitId;
  }
  return null;
}

interface JjScopeData {
  changes: ChangedPath[];
  stats: Map<string, ChangeStats>;
  largePaths: Set<string>;
}

/**
 * Collect the changed files, exact per-file stats, and too-large paths for one
 * jj diff scope (e.g. the working copy, a single revision, or a range).
 */
async function collectJjScopeData(pi: ExtensionAPI, repoRoot: string, scopeArgs: string[]): Promise<JjScopeData> {
  const summaryOutput = await runJj(pi, repoRoot, [...scopeArgs, "--summary", "--color", "never"]);
  const statOutput = await runJj(pi, repoRoot, [...scopeArgs, "--stat", "--color", "never"]);
  const totals = parseJjStatTotals(statOutput);
  const changes = parseJjSummary(summaryOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));

  const largePaths = new Set<string>();
  await Promise.all(changes.map(async (change) => {
    const key = normalizeGitPath(getChangeKey(change));
    if (exceedsLargeDiffLineLimit({ additions: totals.get(key) ?? 0, deletions: 0 })) {
      largePaths.add(key);
      return;
    }
    if (change.newPath != null && await isLargeWorkingTreeFile(repoRoot, change.newPath)) {
      largePaths.add(key);
    }
  }));

  const stats = new Map<string, ChangeStats>();
  const gitPaths = changes
    .map((change) => change.newPath ?? change.oldPath)
    .filter((path): path is string => path != null && !largePaths.has(normalizeGitPath(path)));
  if (gitPaths.length > 0) {
    const gitOutput = await runJj(pi, repoRoot, [...scopeArgs, "--git", "--color", "never", "--", ...gitPaths]);
    const counted = parseJjGitDiffStats(gitOutput);
    for (const [path, changeStats] of counted) stats.set(normalizeGitPath(path), changeStats);
  }

  for (const change of changes) {
    const key = normalizeGitPath(getChangeKey(change));
    if (stats.has(key)) continue;
    const total = totals.get(key) ?? 0;
    if (largePaths.has(key)) continue;
    stats.set(key, { additions: total, deletions: 0 });
  }

  return { changes, stats, largePaths };
}

async function getJjReviewWindowData(pi: ExtensionAPI, repoRoot: string): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  const worktreeData = await collectJjScopeData(pi, repoRoot, ["diff"]);
  const lastCommitData = await collectJjScopeData(pi, repoRoot, ["diff", "-r", "@-"]);
  const branchBaseRevision = await getJjBranchBaseRevision(pi, repoRoot);
  const branchData = branchBaseRevision == null
    ? { changes: [], stats: new Map<string, ChangeStats>(), largePaths: new Set<string>() }
    : await collectJjScopeData(pi, repoRoot, ["diff", "--from", branchBaseRevision, "--to", "@-"]);

  const trackedFilesOutput = await runJj(pi, repoRoot, ["file", "list"]);
  const currentPaths = uniquePaths(parseTrackedPaths(trackedFilesOutput)).filter(isReviewableFilePath);
  const currentPathSet = new Set(currentPaths);

  const branchContentsByPath = new Map<string, string>();
  await Promise.all(branchData.changes.map(async (change) => {
    if (change.newPath == null) return;
    const key = normalizeGitPath(getChangeKey(change));
    if (branchData.largePaths.has(key)) return;
    branchContentsByPath.set(normalizeGitPath(change.newPath), await getJjRevisionContent(pi, repoRoot, "@-", change.newPath));
  }));
  const branchReferenceGraph = getChangedFileReferenceGraph(branchData.changes, branchContentsByPath);

  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of worktreeData.changes) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change, worktreeData.stats.get(normalizeGitPath(key)), undefined, { isTooLarge: worktreeData.largePaths.has(normalizeGitPath(key)) });
  }

  for (const change of branchData.changes) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, branchData.stats.get(normalizeGitPath(key)), { originalRevision: branchBaseRevision ?? undefined, modifiedRevision: "@-" }, { isTooLarge: branchData.largePaths.has(normalizeGitPath(key)) });
    seed.allFilesReferenceCount = branchReferenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = branchReferenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = branchReferenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  for (const change of lastCommitData.changes) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change, lastCommitData.stats.get(normalizeGitPath(key)), undefined, { isTooLarge: lastCommitData.largePaths.has(normalizeGitPath(key)) });
  }

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inAllFiles = true;
      seeds.set(path, seed);
    }
  }

  const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);
  return { repoRoot, files };
}

async function getJjRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
  const result = await pi.exec("jj", ["file", "show", "--revision", revision, path, "--color", "never"], { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

async function getJjSubmoduleReviewWindowData(pi: ExtensionAPI, repoRoot: string, oldSha: string, newSha: string): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  const scopeData = await collectJjScopeData(pi, repoRoot, ["diff", "--from", oldSha, "--to", newSha]);
  const contentsByPath = new Map<string, string>();
  await Promise.all(scopeData.changes.map(async (change) => {
    if (change.newPath == null) return;
    const key = normalizeGitPath(getChangeKey(change));
    if (scopeData.largePaths.has(key)) return;
    contentsByPath.set(normalizeGitPath(change.newPath), await getJjRevisionContent(pi, repoRoot, newSha, change.newPath));
  }));
  const referenceGraph = getChangedFileReferenceGraph(scopeData.changes, contentsByPath);
  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of scopeData.changes) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, scopeData.stats.get(normalizeGitPath(key)), { originalRevision: oldSha, modifiedRevision: newSha }, { isTooLarge: scopeData.largePaths.has(normalizeGitPath(key)) });
    seed.allFilesReferenceCount = referenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = referenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = referenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  return { repoRoot, files: [...seeds.values()].map(createReviewFile).sort(compareReviewFiles) };
}

export async function getSubmoduleReviewWindowData(pi: ExtensionAPI, repoRoot: string, oldSha: string, newSha: string): Promise<ReviewWindowData> {
  const vcs = await detectVcsAt(repoRoot);
  const data = vcs === "jj"
    ? await getJjSubmoduleReviewWindowData(pi, repoRoot, oldSha, newSha)
    : await getGitSubmoduleReviewWindowData(pi, repoRoot, oldSha, newSha);
  return { vcs, ...data };
}

async function getGitSubmoduleReviewWindowData(pi: ExtensionAPI, repoRoot: string, oldSha: string, newSha: string): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  const diffOutput = await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", oldSha, newSha, "--"]);
  const rawOutput = await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--raw", "-z", oldSha, newSha, "--"]);
  const numStatOutput = await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", oldSha, newSha, "--"]);
  const rangeStats = parseNumStat(numStatOutput);
  const rangeRaw = rawDiffMap(parseRawDiff(rawOutput));
  const rangeChanges = parseNameStatus(diffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const rangeLargePaths = new Set<string>();
  for (const change of rangeChanges) {
    const key = normalizeGitPath(getChangeKey(change));
    if (exceedsLargeDiffLineLimit(rangeStats.get(key))) rangeLargePaths.add(key);
  }
  const rangeContentsByPath = new Map<string, string>();
  await Promise.all(rangeChanges.map(async (change) => {
    if (change.newPath == null) return;
    const key = normalizeGitPath(getChangeKey(change));
    if (rangeLargePaths.has(key)) return;
    rangeContentsByPath.set(normalizeGitPath(change.newPath), await getRevisionContent(pi, repoRoot, newSha, change.newPath));
  }));
  const referenceGraph = getChangedFileReferenceGraph(rangeChanges, rangeContentsByPath);
  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of rangeChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, rangeStats.get(normalizeGitPath(key)), { originalRevision: oldSha, modifiedRevision: newSha }, { isTooLarge: rangeLargePaths.has(normalizeGitPath(key)) });
    seed.allFilesReferenceCount = referenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = referenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = referenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  for (const [key, raw] of rangeRaw.entries()) {
    if (!isSubmoduleRawChange(raw)) continue;
    const seed = upsertSeed(seeds, key, () => createSeed(key, raw.newPath != null));
    seed.inAllFiles = true;
    seed.allFiles ??= toComparison(raw, rangeStats.get(normalizeGitPath(key)), { originalRevision: oldSha, modifiedRevision: newSha });
    const submodulePath = raw.newPath ?? raw.oldPath;
    const nested = submodulePath == null || raw.newPath == null
      ? { unavailableReason: "submodule is not available in the working tree" }
      : await getNestedRepoRoot(pi, repoRoot, submodulePath);
    const info = "repoRoot" in nested
      ? getSubmoduleInfo(nested.repoRoot, raw)
      : { ...getSubmoduleInfo(null, raw), unavailableReason: nested.unavailableReason };
    seed.submodule = { "all-files": info };
  }

  return { repoRoot, files: [...seeds.values()].map(createReviewFile).sort(compareReviewFiles) };
}

export async function loadReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope): Promise<ReviewFileContents> {
  const vcs = await detectVcsAt(repoRoot);
  if (vcs === "jj") return loadJjReviewFileContents(pi, repoRoot, file, scope);
  return loadGitReviewFileContents(pi, repoRoot, file, scope);
}

async function loadGitReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope): Promise<ReviewFileContents> {
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;

  if (scope === "all-files" && comparison == null) {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }

  if (comparison == null || comparison.isTooLarge) {
    return { originalContent: "", modifiedContent: "" };
  }

  const branchBaseRevision = scope === "all-files" && comparison.originalRevision === undefined ? await getBranchBaseRevision(pi, repoRoot) : null;
  const originalRevision = comparison.originalRevision !== undefined
    ? comparison.originalRevision
    : scope === "git-diff"
      ? "HEAD"
      : scope === "last-commit"
        ? "HEAD^"
        : branchBaseRevision;
  const modifiedRevision = comparison.modifiedRevision !== undefined
    ? comparison.modifiedRevision
    : scope === "git-diff"
      ? null
      : "HEAD";

  const originalContent = comparison.oldPath == null || originalRevision == null ? "" : await getRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : modifiedRevision == null
      ? await getWorkingTreeContent(repoRoot, comparison.newPath)
      : await getRevisionContent(pi, repoRoot, modifiedRevision, comparison.newPath);

  return { originalContent, modifiedContent };
}

async function loadJjReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope): Promise<ReviewFileContents> {
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;

  if (scope === "all-files" && comparison == null) {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }

  if (comparison == null || comparison.isTooLarge) {
    return { originalContent: "", modifiedContent: "" };
  }

  const originalRevision = comparison.originalRevision !== undefined
    ? comparison.originalRevision
    : scope === "git-diff"
      ? "@-"
      : scope === "last-commit"
        ? "@--"
        : null;
  const modifiedRevision = comparison.modifiedRevision !== undefined
    ? comparison.modifiedRevision
    : scope === "git-diff"
      ? null
      : scope === "last-commit"
        ? "@-"
        : "@";

  const originalContent = comparison.oldPath == null || originalRevision == null ? "" : await getJjRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : modifiedRevision == null
      ? await getWorkingTreeContent(repoRoot, comparison.newPath)
      : await getJjRevisionContent(pi, repoRoot, modifiedRevision, comparison.newPath);

  return { originalContent, modifiedContent };
}
