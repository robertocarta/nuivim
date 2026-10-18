# Decisions

Choices the build spec left open, and departures from it. Newest last.

## 2026-10-18 — A fourth command, `nvim_start(cols, rows)`
**Decision:** The frontend measures the cell metric, then calls `nvim_start(cols, rows)`; the backend finds, version-checks, spawns and attaches Neovim only then.
**Reason:** cols/rows depend on font metrics that only the web view can measure, and starting from the frontend guarantees its event listeners exist before the first redraw. Start errors (missing or old Neovim) come back as the command's error and become the error page.
**Rejected:** Spawning at app launch with a guessed size and resizing after (an extra full redraw, and a race with listener registration); attaching through `nvim_call` (the bridge then can't run in the backend).

## 2026-10-18 — `open-files` event; frontend runs `:drop`
**Decision:** Dropped files and Finder opens are sent from the backend to the frontend as an `open-files` event; the frontend calls `nvim_cmd({cmd='drop', args={path}}, {})`. Paths that arrive before Neovim is attached are kept and sent after attach. Command-line file arguments go to `nvim --embed -- <files>`.
**Reason:** One code path that the end-to-end tests can exercise through the WebSocket harness.

## 2026-10-18 — `frontend_log` command (dev builds only)
**Decision:** In dev builds the frontend mirrors `console.info/warn/error` to the terminal through a `frontend_log` command; release builds ignore it.
**Reason:** Verifying the app (not just the test harness) without opening the web inspector.

## 2026-10-18 — Dependencies beyond the stack table
- `rmpv` (Rust): msgpack values for converting redraw batches to JSON; nvim-rs already depends on it.
- `async-trait` (Rust): required by nvim-rs's `Handler` trait.
- `eslint` + `typescript-eslint`: the lint rule keeping `src/model` free of DOM and Tauri imports.
- `ws`, `@msgpack/msgpack`, `tsx` (dev only): the end-to-end harness (WebSocket server, msgpack-rpc to Neovim, running TypeScript under Node).
- TypeScript is pinned to 6.0: TypeScript 7 has no JavaScript API, which typescript-eslint needs.
- `.npmrc` sets `legacy-peer-deps`: npm 10 crashes resolving vitest's optional peer dependencies.

## 2026-10-18 — Window info in one `nvim_exec_lua` round trip
**Decision:** The window info query runs `nvim_win_get_buf`, `nvim_get_option_value('filetype'/'buftype')` and `getwininfo()[1].textoff` for a list of windows inside one `nvim_exec_lua` call.
**Reason:** Same calls as the spec, one round trip per batch of windows instead of four per window. Also re-queried when a window's line count gains or loses a digit (`win_viewport`), since that widens a number column.

## 2026-10-18 — Points are CSS pixels
**Decision:** Font sizes in points (guifont `:h14`, `prose_size`) are used as CSS pixels.
**Reason:** A macOS point is one CSS pixel at any scale factor; this matches MacVim and Neovide.

## 2026-10-18 — Cell height rounding
**Decision:** Cell height = `round(max(mono line height, prose line height) + linespace)`, where a line height is the height of a block with `line-height: normal`.

## 2026-10-18 — Message grid
**Decision:** The message grid is drawn at its `msg_set_pos` row over the full width, clipped by the window's bottom edge (Neovim makes it as tall as the screen). `msg_set_pos` for grid 0 (sent at startup) is ignored. No msgsep line is drawn when `scrolled` is true: the default `sep_char` is a space, and Neovim already draws the message area's background.

## 2026-10-18 — Key notation details
- Ctrl/Cmd + letter is sent lowercase, with `S-` when Shift is held, modifiers always in the order C-S-M-D (`<C-S-a>`, `<S-D-s>`); Neovim normalises these to `<C-S-A>` and `<D-S>`. Ctrl/Cmd + a shifted symbol is sent as the symbol without `S-` (`<C-@>`), since Shift is already in the character.
- With Option as Meta, letters and digits come from the physical key (`KeyboardEvent.code`); other keys fall back to the character Option produced.
- `<`, `\`, `|` and space inside `<…>` become `lt`, `Bslash`, `Bar`, `Space`.
- No Edit menu: without it, Cmd-C/V/A/X/Z reach Neovim as `<D-…>`. The app menu holds Hide (Cmd-H), Hide Others, Show All and Quit (Cmd-Q → `confirm qa`); the Window menu holds Minimise (Cmd-M) and Full Screen.

## 2026-10-18 — Light box-drawing characters are drawn with CSS
**Decision:** `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼` are drawn as 1px lines through the cell centre, and `╭ ╮ ╯ ╰` as rounded borders; the glyph stays in the DOM, transparent, so text extraction and tests still see it. Other box and block characters (U+2500–U+259F) are drawn as glyphs stretched to the cell height.
**Reason:** Rows are as tall as the larger of the two fonts, so mono glyphs leave gaps between rows; plugin borders (Telescope, completion menus) looked dashed. Terminals and GUIs such as kitty and Neovide draw these characters themselves for the same reason.
**Rejected:** Only stretching glyphs (fonts don't fill their advance box; later rows' backgrounds cover the overdraw).

## 2026-10-18 — Device-pixel snapping of mono spans and grid origins
**Decision:** Mono spans cover `[snap(c0 × cw), snap(c1 × cw))` and grid boxes are placed at snapped positions, where `snap` rounds to device pixels.
**Reason:** Fractional span edges antialias and leave visible seams between neighbouring cell backgrounds. The shift is at most half a device pixel (0.25 CSS px on Retina), inside the spec's ±0.5 tolerance.

## 2026-10-18 — Prose column offsets come from element widths, not partial Range rects
**Decision:** The column-to-x mapping takes each span's exact box (`getBoundingClientRect` of the element) plus the width of the text before the column, measured as a hidden element with the same classes, times the row's shrink scale.
**Reason:** WebKit rounds the rect of a Range covering part of a text node up to whole pixels (seen in Playwright WebKit: widths 9, 17, 26 for 8.43, 16.86, 25.29), which alone would break the ±0.5px tolerance. Element widths are exact.

## 2026-10-18 — mono_hl_groups match the group that holds the attributes
**Decision:** A highlight is mono when any `hi_name` in its ext_hlstate info equals a listed group or starts with it plus a dot (`@markup.raw` matches `@markup.raw.markdown_inline`).
**Finding:** `hi_name` is the final group where the attributes are defined, after links and treesitter fallback. With Neovim's default colorscheme `@markup.raw` is undefined, so inline code arrives as `Special` and cannot be told apart from the 28 other groups that end at `Special`. Colorschemes that define `@markup.raw` (most do) work as the spec intends; the test config defines it the same way.
**Rejected:** Resolving listed groups to their link targets (would make every `Special` run mono); setting `altfont` or other attributes on the user's highlight groups from the bridge (changes the user's highlights and breaks treesitter fallback for groups it defines).

## 2026-10-18 — Which prose row anchors a float horizontally
**Decision:** When a float's anchor grid holds the cursor and its anchor row is the cursor row or the row below it, the cursor row's column-to-x mapping is used; otherwise the anchor row's (clamped into the grid).
**Reason:** Completion menus and hover windows are placed on the row *below* the cursor (`anchor_row = cursor row + 1`), but the word they belong to is on the cursor row; that row below may hold unrelated text whose mapping would put the float in the wrong place.

## 2026-10-18 — Floats use propvim's own placement, not `screen_row`/`screen_col`
**Decision:** Floats are placed by the spec's anchor rules (anchor grid origin + anchor point, corner, then shifted inside the window). Neovim's `screen_row`/`screen_col` from `win_float_pos` are ignored: they assume monospace text.
