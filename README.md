# pi-slopchop

`/slopchop` is a terminal-native review and annotation surface for Pi.

It is inspired by Mario Zechner's [pi-diff-review](https://github.com/badlogic/pi-diff-review).

It lets you stop after an agent turn, walk the diff inside Pi, add fast line/file/whole-change annotations, and send that feedback back to the agent as a clean prompt in the editor.

The goal is simple: keep terminal-based review within Pi, keep annotations precise, and make it easy to separate **things that should change** from **things you want explained or discussed**.

## Summary

Use `/slopchop` when you want to review and annotate work before sending the agent another turn.

It supports three review scopes:

- `git diff`
- `last commit`
- `all files`

Inside the review UI you can:

- move through files and hunks quickly
- annotate **added** and **deleted** lines
- leave **file-level** annotations
- leave a **whole-change** note
- mark feedback as either:
  - `FIX` — the agent should change something
  - `DISCUSS` — the agent should explain, justify, or propose, without editing code just to satisfy the comment
- insert the resulting review prompt into Pi’s editor

`/slopchop` does **not** auto-send the prompt. It stages the next message for you.

## Quickstart

### Install

```bash
pi install npm:pi-slopchop
```

Then restart Pi or run `/reload`.

### Run it

Inside a git repo in Pi:

```text
/slopchop
```

Or use the global shortcut:

```text
ctrl+alt+s
```

### Basic flow

1. Run `/slopchop`
2. Pick a scope:
   - `git diff` — review your current uncommitted working tree changes against `HEAD`
   - `last commit` — review the most recent commit against its parent
   - `all files` — review files changed on the current branch compared with the default branch; if there are no changed scopes, falls back to current file contents

   By default, `/slopchop` opens the first scope that makes sense for the repo in this order:
   - `git diff` if there are uncommitted changes
   - otherwise `all files` if the current branch differs from the default branch
   - otherwise `last commit` if there is a reviewable last commit
   - otherwise `all files` as a current-file fallback

   In the branch-level `all files` scope, files are ordered for review priority: changed files referenced by more other changed files come first, then modified/renamed before added before deleted, then source files before tests/docs/changesets, then path order. The navigator can filter to files related to the active file with `r`. In related mode, `→` means the active file references that file, `←` means that file references the active file, and `↔` means both. Press `r` again to return to all files.
3. Move to the file and line you care about
4. Add annotations:
   - `f` for a line annotation with `FIX` preselected
   - `d` or `c` for a line annotation with `DISCUSS` preselected
   - `l` for a file annotation
   - `a` for a whole-change note
5. Press `s` to insert the review prompt into the editor
6. Read it, tweak it if you want, then send it normally

### Fastest path

If you want speed, use slash shortcuts on a selected diff line:

- press `/`
- press a shortcut key from the right panel

That creates a templated annotation instantly. If you want to refine it afterwards, press `e` on that same line.

## Deep dive

### Annotation model

`/slopchop` treats feedback as one of three scopes:

#### Line comments

Use these for precise feedback tied to a specific added or deleted line.

Examples:

- `Why was this deleted?`
- `What is this code doing?`
- `Consider a clearer name here.`

#### File comments

Use these when the feedback applies to the whole file change rather than one line.

Examples:

- `Explain this file-level refactor.`
- `This file now does too much.`

#### Whole-change note

Use this when the feedback is about the change as a whole.

Examples:

- `Explain this entire diff to me.`
- `What is the overall intention behind this change?`

### FIX vs DISCUSS

This distinction is central to how `/slopchop` works.

#### FIX

Use `FIX` when you want the next agent turn to change something.

Examples:

- rename this
- simplify this
- add tests for this
- restore this deleted line

#### DISCUSS

Use `DISCUSS` when you want explanation, rationale, tradeoffs, or a proposal.

Examples:

- why was this deleted?
- what is this code doing?
- explain this change to me
- is this approach intentional?

When `/slopchop` generates the prompt, it uses different wording depending on whether your review is:

- `DISCUSS` only
- `FIX` only
- mixed `FIX` + `DISCUSS`

That keeps pure discussion prompts strict, and avoids unnecessary instructions when you only want changes.

### Navigation and commenting

#### Global

- `1 / 2 / 3` — switch scope
- mouse wheel — scroll the pane under the cursor
- `Tab` — cycle focus: navigator → diff → comments
- `/` — search files, or open slash shortcuts in diff focus
- `?` — toggle help in the right sidebar
- `w` — toggle wrapping
- `u` — toggle unchanged context in diff scopes
- `h` — hide/show the comments pane
- `s` — insert the generated prompt into the editor
- `Esc` — cancel the review

#### Navigator

- `↑↓` or `j/k` — move between files
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `r` — toggle related-files filter in `all files` scope
- file rows show change counts as `+added -deleted`
- `Enter` — move focus to diff

#### Diff

- `↑↓` or `j/k` — move between selectable added/deleted lines
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `n / p` — next / previous hunk
- `o` — open the selected line in `$EDITOR`, then return to `/slopchop` when the editor exits
- `f` — line comment, default `FIX`
- `d` or `c` — line comment, default `DISCUSS`
- `e` — edit the existing line comment on the selected line
- `x` — delete the existing line comment on the selected line
- `l` — file comment
- `a` — whole-change note
- `/` — open slash shortcut mode for the selected line

Line comment markers in the diff gutter:

- `●` = `FIX`
- `◆` = `DISCUSS`

#### Comments panel

- `↑↓` or `j/k` — move through saved comments
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `e` or `Enter` — edit selected comment
- `d` — delete selected comment

#### Editor

- `Tab` — toggle `FIX` / `DISCUSS`
- `Enter` — save
- `Shift+Enter` — newline
- `Esc` — cancel editor

### Slash shortcut mode

Slash shortcut mode is for very fast line comments.

When you press `/` on a selected diff line:

- the right sidebar switches to a shortcut panel
- shortcuts are grouped under `DISCUSS` and `FIX`
- pressing one shortcut key applies that comment immediately

This is designed for repetitive review patterns like:

- explain this
- why was this added?
- why was this deleted?
- what problem is this solving?
- simplify this
- add tests

If you want to refine the templated text after applying it, press `e` on that line.

### Shortcut configuration

Optional user-level config file:

- `~/.pi/agent/extensions/slopchop.json`

Example:

```json
{
  "version": 1,
  "builtins": {
    "disable": ["restore-deleted"]
  },
  "shortcuts": [
    {
      "id": "trace-added",
      "key": "x",
      "label": "trace",
      "intent": "discuss",
      "side": "added",
      "text": "Explain how execution reaches this line."
    }
  ]
}
```

#### Fields

- `version` — schema version, currently `1`
- `builtins.disable` — built-in shortcut ids to turn off
- `shortcuts` — your custom shortcuts

Each shortcut has:

- `id` — stable identifier
- `key` — one-character trigger after `/`
- `label` — short label shown in the UI
- `intent` — `fix` or `discuss`
- `side` — `added`, `deleted`, or `both`
- `text` — the comment text to apply

### Prompt generation

When you submit, `/slopchop` builds a prompt that matches the kind of review you created.

It groups feedback naturally into sections like:

- review-wide note
- file comments
- line comments

and uses stricter instructions when `DISCUSS` items are present, so the model is less likely to turn explanatory comments into accidental edits.

### What it is good at

`/slopchop` is especially good when you want to:

- pause after an agent turn and inspect the change carefully
- ask for explanation without losing the exact line you are looking at
- separate actionable change requests from discussion
- review deleted lines, not just added ones
- stay inside Pi instead of switching to a browser or external review tool


