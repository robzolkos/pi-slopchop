import { describe, expect, it } from "vitest";
import { renderPiIntraLineDiff } from "../pi-render.js";

function mark(text: string): string {
  return `<${text}>`;
}

function render(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
  return renderPiIntraLineDiff(oldContent, newContent, mark);
}

function joinMarkedSeries(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `<${prefix}${index}>`).join(".");
}

describe("renderPiIntraLineDiff", () => {
  it.each([
    {
      name: "numeric edits around punctuation",
      oldContent: "x=1",
      newContent: "x=2",
      expected: { removedLine: "x=<1>", addedLine: "x=<2>" },
    },
    {
      name: "member access edits",
      oldContent: "foo.bar",
      newContent: "foo.baz",
      expected: { removedLine: "foo.<bar>", addedLine: "foo.<baz>" },
    },
    {
      name: "identifier edits before punctuation",
      oldContent: "function foo()",
      newContent: "function bar()",
      expected: { removedLine: "function <foo>()", addedLine: "function <bar>()" },
    },
  ])("keeps token boundaries for $name", ({ oldContent, newContent, expected }) => {
    expect(render(oldContent, newContent)).toEqual(expected);
  });

  it("returns unchanged output for unchanged lines", () => {
    expect(render("same(value)", "same(value)")).toEqual({
      removedLine: "same(value)",
      addedLine: "same(value)",
    });
  });

  it("preserves leading whitespace while highlighting the changed token", () => {
    expect(render("  foo()", "  bar()")).toEqual({
      removedLine: "  <foo>()",
      addedLine: "  <bar>()",
    });
  });

  it("expands tabs consistently in shared and highlighted segments", () => {
    expect(render("\tfoo\tbar", "\tfoo\tbaz")).toEqual({
      removedLine: "   foo   <bar>",
      addedLine: "   foo   <baz>",
    });
  });

  it("keeps token-level highlighting under the token matrix limit", () => {
    const oldLine = Array.from({ length: 70 }, (_, index) => `a${index}`).join(".");
    const newLine = Array.from({ length: 70 }, (_, index) => `b${index}`).join(".");

    expect(render(oldLine, newLine)).toEqual({
      removedLine: joinMarkedSeries("a", 70),
      addedLine: joinMarkedSeries("b", 70),
    });
  });

  it("falls back to whole-line highlighting over the token matrix limit", () => {
    const oldLine = Array.from({ length: 150 }, (_, index) => `a${index}`).join(".");
    const newLine = Array.from({ length: 150 }, (_, index) => `b${index}`).join(".");

    expect(render(oldLine, newLine)).toEqual({
      removedLine: `<${oldLine}>`,
      addedLine: `<${newLine}>`,
    });
  });
});
