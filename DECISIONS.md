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
- Ctrl/Cmd + letter is sent lowercase, with `S-` when Shift is held (`<C-S-a>`, `<D-S-s>`); Neovim normalises these to `<C-S-A>` and `<D-S>`. Ctrl/Cmd + a shifted symbol is sent as the symbol without `S-` (`<C-@>`), since Shift is already in the character.
- With Option as Meta, letters and digits come from the physical key (`KeyboardEvent.code`); other keys fall back to the character Option produced.
- `<`, `\`, `|` and space inside `<…>` become `lt`, `Bslash`, `Bar`, `Space`.
- No Edit menu: without it, Cmd-C/V/A/X/Z reach Neovim as `<D-…>`. The app menu holds Hide (Cmd-H), Hide Others, Show All and Quit (Cmd-Q → `confirm qa`); the Window menu holds Minimise (Cmd-M) and Full Screen.
