import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Diff from "diff";

function resolveThemeModuleUrl(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let current = start;

  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(current, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme", "theme.js");
    if (existsSync(candidate)) return pathToFileURL(candidate).href;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("Could not resolve Pi theme module for slopchop rendering.");
}

const { getLanguageFromPath, highlightCode } = await import(resolveThemeModuleUrl()) as {
  getLanguageFromPath: (filePath: string) => string | undefined;
  highlightCode: (code: string, lang?: string) => string[];
};

export function detectPiLanguage(filePath: string): string | undefined {
  return getLanguageFromPath(filePath);
}

export function highlightCodeLineWithPi(text: string, language: string | undefined): string {
  if (text.length === 0) return "";
  return highlightCode(text, language)[0] ?? text;
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/**
 * Adapted from Pi's internal diff renderer so slopchop follows Pi's intra-line
 * diff highlighting behavior while still controlling its own gutters and
 * comment markers.
 */
export function renderPiIntraLineDiff(
  oldContent: string,
  newContent: string,
  inverse: (text: string) => string,
): { removedLine: string; addedLine: string } {
  const wordDiff = Diff.diffWords(oldContent, newContent);

  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of wordDiff) {
    if (part.removed) {
      let value = replaceTabs(part.value);
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) removedLine += inverse(value);
      continue;
    }

    if (part.added) {
      let value = replaceTabs(part.value);
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) addedLine += inverse(value);
      continue;
    }

    const value = replaceTabs(part.value);
    removedLine += value;
    addedLine += value;
  }

  return { removedLine, addedLine };
}
