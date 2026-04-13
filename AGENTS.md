# AGENTS.md

## Purpose

This directory contains local pi extensions and configuration used to customize the TUI experience.

The current goal is to make pi feel closer to Claude Code:

- flatter UI
- plain text flow instead of card-heavy blocks
- minimal padding
- consistent left alignment
- assistant/tool/user/input prompt markers

## Scope

Work in this directory and related local pi config only:

- `/home/scutech/.pi/agent/extensions/`
- `/home/scutech/.pi/agent/themes/`
- `/home/scutech/.pi/agent/settings.json`

Do **not** modify pi core source unless the user explicitly asks for it.

Reference pi core source for analysis only:

- `/home/scutech/fun/pi-mono/`

## Current Main Extension

Primary implementation file:

- `/home/scutech/.pi/agent/extensions/claude-code-tool-renderer.ts`

This file currently contains monkey patches and rendering overrides for:

- built-in tool rendering
- tool spacing / padding cleanup
- assistant reply rendering
- thinking preview rendering
- global text padding normalization
- editor prompt rendering
- user message rendering

## Files That Matter

- `/home/scutech/.pi/agent/extensions/claude-code-tool-renderer.ts`
- `/home/scutech/.pi/agent/extensions/TODO.md`
- `/home/scutech/.pi/agent/themes/claude-flat.json`
- `/home/scutech/.pi/agent/settings.json`

## Working Rules

1. Prefer extension-based customization over pi core edits.
2. Prefer monkey patching exported components/classes over forking pi internals.
3. Keep styling changes centralized in `claude-code-tool-renderer.ts` when possible.
4. Avoid introducing extra wrappers, boxes, padding, or background blocks unless required.
5. Preserve ctrl+o expansion behavior for tools/thinking if modifying those areas.
6. Keep visual alignment consistent across:
   - input editor prompt
   - user messages
   - assistant messages
   - tool calls/results
7. When changing rendering, reason carefully about:
   - width calculation
   - wrapping before prefix insertion
   - ANSI color handling
   - background fill behavior
   - trailing spaces / blank lines
8. When fixing layout regressions, inspect screenshots and explain root cause before patching if the issue is unclear.

## Styling Intent

### Assistant messages

- first visible line uses `● `
- body lines use two-space continuation indent
- minimal vertical spacing
- no card background

### Thinking messages

- compact preview style
- label `∴ Thinking`
- collapsed by default
- expanded via ctrl+o
- muted gray appearance

### Tool messages

- unified plain-text rendering
- call title line with `● `
- result body as indented text block
- no large padded cards
- no extra top/bottom blank lines

### User messages

- prompt-like style
- first line uses `> `
- continuation lines aligned underneath
- preserve intended background styling if requested

### Input editor

- first line uses `> `
- continuation lines aligned underneath
- avoid broken right edge / truncation artifacts
- wrapping must account for prompt width before final render

## Known Constraints

- pi does not currently provide an official global tool renderer hook for everything needed here.
- Some behavior requires monkey patching component prototypes.
- Width / wrapping bugs can appear if prefixes are added after render instead of before layout.
- Reusing original rendered output from card-style components can preserve unwanted padding/background behavior.

## Recommended Workflow

1. Read `TODO.md`.
2. Inspect the current extension file.
3. If needed, inspect pi core implementation in `pi-mono` for reference.
4. Patch locally in `/home/scutech/.pi/agent/extensions/`.
5. Keep changes minimal and focused.
6. After UI changes, tell the user what to reload and what to verify.

## If You Need pi Docs

Read these local docs when working on pi extension/theme/TUI topics:

- `/home/scutech/.nvm/versions/node/v23.11.1/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
- `/home/scutech/.nvm/versions/node/v23.11.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `/home/scutech/.nvm/versions/node/v23.11.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/themes.md`
- `/home/scutech/.nvm/versions/node/v23.11.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`

## Notes For Future Agents

If a visual regression appears, check these areas first:

- `patchEditorPrompt()`
- `patchUserMessages()`
- `patchAssistantReplies()`
- `patchToolSpacing()`
- `patchTextPadding()`

Pay special attention to prompt prefixes, wrapping width, and background fill.
