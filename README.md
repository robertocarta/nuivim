# propvim

A small macOS app that runs Neovim and sets prose in a proportional font, while
every floating window (completion menus, LSP hovers, Telescope and other plugin
popups) keeps its exact monospace layout.

It works with your normal Neovim config, or none at all, and never changes it.

## How it works

Neovim's UI protocol (`ext_multigrid`) sends every window and every float as its
own grid of cells. propvim lays out all grids on an imaginary monospace cell
grid, so windows and floats land where Neovim and plugins expect them, and then
draws only the text area of prose windows in a proportional font inside its
window box. Line numbers, signs, statuslines, the command line and all floats
stay monospace. Floats attached to text (completion, hover, signature help) are
moved to where that text actually is.

## Install

You need macOS 11 or newer and **Neovim 0.10 or newer** (`brew install neovim`).
propvim finds `nvim` on the `PATH` of your login shell; set `PROPVIM_NVIM` to
use another binary.

Build from source (Rust, Node 20 and the Xcode command line tools):

```sh
npm ci
npm run tauri build                     # .app and .dmg for this Mac
scripts/build-universal.sh              # universal (Apple Silicon + Intel) .app and .dmg
```

The universal build needs a Rust toolchain with both macOS targets. If yours
lacks the Intel one (Homebrew's Rust does), install a private toolchain into the
project folder, which the script then uses:

```sh
RUSTUP_HOME=$PWD/.toolchain/rustup CARGO_HOME=$PWD/.toolchain/cargo \
  rustup toolchain install stable --profile minimal \
  --target x86_64-apple-darwin --target aarch64-apple-darwin
```

The bundles land in `src-tauri/target/.../release/bundle/`. The app is not
signed: the first time, right-click it in Finder and choose **Open**, or run
`xattr -dr com.apple.quarantine propvim.app`.

Open files by dropping them on the window, with **Open With** in Finder, or
from a terminal: `open -a propvim notes.md`.

## Configuration

Configure propvim from your Neovim config with one global table. It is harmless
in a terminal Neovim, so one `init.lua` works everywhere:

```lua
vim.g.propvim = {
  prose_font = "Charter",          -- CSS font family: any installed font
  prose_size = 17,                 -- points
  mono_font = "JetBrains Mono",    -- overrides 'guifont' when set
  mono_size = 14,
  prose_filetypes = { "markdown", "text", "tex", "gitcommit", "mail" },
  mono_hl_groups = { "@markup.raw", "markdownCode", "texMathZone" },
  overflow = "shrink",             -- or "clip"
  option_is_meta = "none",         -- "none" | "left" | "right" | "both"
}
```

| Key | Type | Default |
| --- | --- | --- |
| `prose_font` | string | Charter |
| `prose_size` | number, points | 16 |
| `mono_font` | string | from `'guifont'`, else Menlo |
| `mono_size` | number, points | from `'guifont'` (`Name:h14`), else 14 |
| `prose_filetypes` | list of filetypes | markdown, text, tex, plaintex, rst, org, norg, typst, asciidoc, gitcommit, mail |
| `mono_hl_groups` | list of highlight groups | @markup.raw, @markup.raw.block, @markup.math, markdownCode, markdownCodeBlock, texMathZone |
| `overflow` | `"shrink"` or `"clip"` | shrink |
| `option_is_meta` | `"none"`, `"left"`, `"right"`, `"both"` | none |

- Change the table and run `:PropvimReload` to apply it without restarting.
- An unknown key or a wrong value is ignored (the default stays) and shows one
  warning, e.g. `propvim: overflow must be "shrink" or "clip"`.
- `prose_filetypes`: windows showing these filetypes (and not terminals) get
  proportional text. Everything else stays monospace, including plugin windows
  such as file trees and dashboards, which have their own filetypes.
- `mono_hl_groups`: text in these highlight groups (inline code, math) is set in
  the mono font but stays in the flow of the line. A group also matches its
  dotted children (`@markup.raw` matches `@markup.raw.markdown_inline`).
- `overflow`: what happens when a line set in the prose font is wider than its
  window, which is rare: `shrink` narrows that line to fit, `clip` cuts it off.
- `option_is_meta`: which Option key sends `<M-…>`. Otherwise Option types its
  character as usual (`å`, `…`).

### Wrapping prose

Neovim still wraps lines by character count, so proportional lines end a little
short of the right edge. For prose, wrap at word boundaries:

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown", "text", "tex" },
  command = "setlocal wrap linebreak breakindent",
})
```

### Keys

- **Cmd-=**, **Cmd--**, **Cmd-0**: bigger, smaller and configured font sizes
  (both fonts, this session only).
- **Cmd-Q** and the close button run `:confirm qa`. **Cmd-H** hides, **Cmd-M**
  minimises.
- Every other Cmd combination reaches Neovim as `<D-…>`. propvim maps
  **Cmd-C** (copy in visual mode), **Cmd-V** (paste in normal, insert and
  command-line mode) and **Cmd-A** (select all), but only where you have not
  mapped those keys yourself.
- The clipboard is Neovim's own (`"+`, through `pbcopy`/`pbpaste`).

## Known limits

- Wrapped prose lines end short of the right edge (see above).
- Text that relies on alignment inside a prose window, such as Markdown tables
  and ASCII diagrams, does not line up. Put it in a code block or a filetype that
  is not in `prose_filetypes`.
- `mono_hl_groups` matches the highlight group that actually holds the colours.
  Neovim's default colorscheme leaves `@markup.raw` undefined, so inline code
  falls back to `Special` and stays proportional; most colorschemes define
  `@markup.raw` and work as expected.
- In prose windows, cells past the end of the text are one space wide each, so
  things drawn there (`colorcolumn`, virtual text at a fixed column) do not land
  at their monospace position. Trailing highlights such as `CursorLine` and
  visual selection still stretch to the window edge.
- With Option as Meta, keys other than letters and digits send the character
  Option produces.
- `winblend`/`pumblend` transparency, ligature settings, smooth scrolling and
  cursor animation are not supported.
- One window running one local Neovim. No tabline, sidebar or other GUI chrome:
  Neovim draws its own command line, messages and popup menu.

## Development

```sh
npm run tauri dev        # the app, with live reload of the frontend
npm test                 # lint, types, unit (Vitest, cargo test), end-to-end (Playwright WebKit)
npx tsx tests/fixtures/record.ts   # re-record redraw fixtures after a Neovim upgrade
```

The end-to-end tests run the frontend in Playwright's WebKit (the engine behind
WKWebView) against `tests/e2e/harness.ts`, which gives each test its own
`nvim --embed --clean -u tests/fixtures/init.lua`. Screenshots of the main
scenarios are saved to `tests/e2e/screenshots/`.

Code map:

- `src-tauri/src/` — Rust backend: spawns Neovim (`nvim.rs`), resolves the
  login-shell environment (`shellenv.rs`), app window, menu and commands
  (`main.rs`), and the Lua bridge run inside Neovim (`bridge.lua`).
- `src/model/` — UI state from redraw events: grids, highlights, windows,
  cursor, keys, layout math. No DOM, enforced by ESLint.
- `src/view/` — turns the model into DOM: rows, prose runs, floats, cursor.
- `src/input/` — keyboard, IME and mouse.
- `src/transport.ts` — Tauri events and commands in the app, a WebSocket in tests.

Decisions the build spec left open are recorded in [DECISIONS.md](DECISIONS.md).
