// Pure UI state built from redraw batches. No DOM: the view reads this state.

import { Grid } from './grid';
import { parseHlAttr, type DefaultColors, type HlAttr } from './hl';

export type Corner = 'NW' | 'NE' | 'SW' | 'SE';

export interface FloatPos {
  anchor: Corner;
  anchorGrid: number;
  anchorRow: number;
  anchorCol: number;
  mouseEnabled: boolean;
  zindex: number;
  /** Creation order, for stacking floats with the same zindex. */
  order: number;
}

export interface WinInfo {
  filetype: string;
  buftype: string;
  textoff: number;
}

/** Placement of a non-global grid: a window, a float or the message grid. */
export interface WinBox {
  grid: number;
  win: number;
  kind: 'win' | 'float' | 'msg';
  hidden: boolean;
  /** win_pos position and size on grid 1 (windows only). */
  row: number;
  col: number;
  width: number;
  height: number;
  float?: FloatPos;
  msg?: { row: number; scrolled: boolean; sepChar: string; zindex: number };
  info?: WinInfo;
  lineCount?: number;
}

export interface ModeInfo {
  cursorShape: 'block' | 'horizontal' | 'vertical';
  cellPercentage: number;
  blinkwait: number;
  blinkon: number;
  blinkoff: number;
  attrId: number;
  name: string;
  shortName: string;
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

function parseMode(m: unknown): ModeInfo {
  const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  const shape = o.cursor_shape;
  return {
    cursorShape: shape === 'horizontal' || shape === 'vertical' ? shape : 'block',
    cellPercentage: num(o.cell_percentage, 100) || 100,
    blinkwait: num(o.blinkwait),
    blinkon: num(o.blinkon),
    blinkoff: num(o.blinkoff),
    attrId: num(o.attr_id),
    name: str(o.name),
    shortName: str(o.short_name),
  };
}

const DEFAULT_MODE: ModeInfo = parseMode({});

type Handler = (state: UiState, args: unknown[]) => void;

export class UiState {
  grids = new Map<number, Grid>();
  wins = new Map<number, WinBox>();
  hl = new Map<number, HlAttr>();
  hlGroups = new Map<string, number>();
  defaults: DefaultColors = { fg: 0x000000, bg: 0xffffff, sp: 0xff0000 };
  cursor = { grid: 1, row: 0, col: 0 };
  cursorStyleEnabled = true;
  modes: ModeInfo[] = [];
  modeIdx = 0;
  modeName = 'normal';
  options: { guifont: string; linespace: number } = { guifont: '', linespace: 0 };
  mouseOn = false;
  busy = false;
  title = '';

  /** Set when highlights or default colours changed since the last paint. */
  hlDirty = true;
  /** Set when fonts (guifont, linespace) changed since the view last looked. */
  fontsDirty = true;
  /** Window handles whose buffer filetype / gutter width must be (re)queried. */
  private winQueries = new Set<number>();
  private floatCounter = 0;
  private unknownLogged = new Set<string>();
  log: (msg: string) => void = () => {};

  get mode(): ModeInfo {
    return this.modes[this.modeIdx] ?? DEFAULT_MODE;
  }

  /** Applies one redraw batch. Returns true when it contained a flush. */
  apply(batch: unknown): boolean {
    let flushed = false;
    if (!Array.isArray(batch)) return false;
    for (const event of batch) {
      if (!Array.isArray(event) || typeof event[0] !== 'string') continue;
      const name = event[0];
      if (name === 'flush') {
        flushed = true;
        continue;
      }
      const handler = HANDLERS[name];
      if (!handler) {
        if (!this.unknownLogged.has(name)) {
          this.unknownLogged.add(name);
          this.log(`propvim: ignoring redraw event ${name}`);
        }
        continue;
      }
      for (let i = 1; i < event.length; i++) {
        const args = event[i];
        if (!Array.isArray(args)) continue;
        try {
          handler(this, args);
        } catch (e) {
          this.log(`propvim: bad ${name} event: ${String(e)}`);
        }
      }
    }
    return flushed;
  }

  grid(id: number, width = 1, height = 1): Grid {
    let g = this.grids.get(id);
    if (!g) {
      g = new Grid(id, width, height);
      this.grids.set(id, g);
    }
    return g;
  }

  queueWinQuery(win: number): void {
    if (win > 0) this.winQueries.add(win);
  }

  /** Queues every window grid for a fresh info query. */
  queueAllWinQueries(): void {
    for (const box of this.wins.values()) if (box.kind !== 'msg') this.queueWinQuery(box.win);
  }

  takeWinQueries(): number[] {
    const out = [...this.winQueries];
    this.winQueries.clear();
    return out;
  }

  /** Stores a window info answer. Returns true when anything visible changed. */
  setWinInfo(win: number, info: WinInfo): boolean {
    let changed = false;
    for (const box of this.wins.values()) {
      if (box.win !== win) continue;
      const old = box.info;
      if (!old || old.filetype !== info.filetype || old.buftype !== info.buftype || old.textoff !== info.textoff) {
        box.info = info;
        changed = true;
        const g = this.grids.get(box.grid);
        if (g) for (const row of g.rows) row.dirty = true;
      }
    }
    return changed;
  }

  markAllDirty(): void {
    for (const g of this.grids.values()) for (const row of g.rows) row.dirty = true;
  }

  private box(grid: number, win: number, kind: WinBox['kind']): WinBox {
    let b = this.wins.get(grid);
    if (!b) {
      b = { grid, win, kind, hidden: false, row: 0, col: 0, width: 0, height: 0 };
      this.wins.set(grid, b);
    }
    if (b.kind !== kind) {
      b.kind = kind;
      if (kind !== 'float') b.float = undefined;
      if (kind !== 'msg') b.msg = undefined;
    }
    if (win) b.win = win;
    b.hidden = false;
    return b;
  }

  // Handlers, called through HANDLERS below.

  gridResize(args: unknown[]): void {
    const [id, w, h] = [num(args[0]), num(args[1]), num(args[2])];
    const g = this.grids.get(id);
    if (g) g.resize(w, h);
    else this.grid(id, w, h);
  }

  winPos(args: unknown[]): void {
    const b = this.box(num(args[0]), num(args[1]), 'win');
    b.row = num(args[2]);
    b.col = num(args[3]);
    b.width = num(args[4]);
    b.height = num(args[5]);
    this.queueWinQuery(b.win);
  }

  winFloatPos(args: unknown[]): void {
    const grid = num(args[0]);
    const existing = this.wins.get(grid);
    const order = existing?.float?.order ?? ++this.floatCounter;
    const b = this.box(grid, num(args[1]), 'float');
    const anchor = str(args[2], 'NW');
    b.float = {
      anchor: (['NW', 'NE', 'SW', 'SE'].includes(anchor) ? anchor : 'NW') as Corner,
      anchorGrid: num(args[3], 1),
      anchorRow: num(args[4]),
      anchorCol: num(args[5]),
      mouseEnabled: args[6] !== false,
      zindex: num(args[7], 50),
      order,
    };
    // A float showing a file (a zen or reading page) can be prose; the popup menu has no window (-1).
    this.queueWinQuery(b.win);
  }

  msgSetPos(args: unknown[]): void {
    // Neovim sends one msg_set_pos for grid 0 at startup; there is no such grid.
    if (num(args[0]) === 0) return;
    const b = this.box(num(args[0]), 0, 'msg');
    b.msg = { row: num(args[1]), scrolled: args[2] === true, sepChar: str(args[3]), zindex: num(args[4], 200) };
  }

  winViewport(args: unknown[]): void {
    const b = this.wins.get(num(args[0]));
    if (!b) return;
    const count = num(args[6]);
    // A gutter with line numbers widens when the line count gains a digit.
    if (b.lineCount !== undefined && String(b.lineCount).length !== String(count).length) this.queueWinQuery(b.win);
    b.lineCount = count;
  }

  optionSet(args: unknown[]): void {
    const name = args[0];
    if (name === 'guifont' && typeof args[1] === 'string' && args[1] !== this.options.guifont) {
      this.options.guifont = args[1];
      this.fontsDirty = true;
    } else if (name === 'linespace' && typeof args[1] === 'number' && args[1] !== this.options.linespace) {
      this.options.linespace = args[1];
      this.fontsDirty = true;
    }
  }
}

const HANDLERS: Record<string, Handler> = {
  grid_resize: (s, a) => s.gridResize(a),
  grid_clear: (s, a) => s.grids.get(num(a[0]))?.clear(),
  grid_destroy: (s, a) => {
    s.grids.delete(num(a[0]));
    s.wins.delete(num(a[0]));
  },
  grid_line: (s, a) => {
    if (Array.isArray(a[3])) s.grid(num(a[0])).line(num(a[1]), num(a[2]), a[3]);
  },
  grid_scroll: (s, a) => s.grids.get(num(a[0]))?.scroll(num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])),
  grid_cursor_goto: (s, a) => {
    s.cursor = { grid: num(a[0], 1), row: num(a[1]), col: num(a[2]) };
  },
  hl_attr_define: (s, a) => {
    s.hl.set(num(a[0]), parseHlAttr(a[1], a[3]));
    s.hlDirty = true;
  },
  hl_group_set: (s, a) => {
    if (typeof a[0] === 'string') s.hlGroups.set(a[0], num(a[1]));
  },
  default_colors_set: (s, a) => {
    const c = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
    s.defaults = { fg: c(a[0], s.defaults.fg), bg: c(a[1], s.defaults.bg), sp: c(a[2], s.defaults.sp) };
    s.hlDirty = true;
    s.markAllDirty();
  },
  win_pos: (s, a) => s.winPos(a),
  win_float_pos: (s, a) => s.winFloatPos(a),
  win_hide: (s, a) => {
    const b = s.wins.get(num(a[0]));
    if (b) b.hidden = true;
  },
  win_close: (s, a) => {
    s.wins.delete(num(a[0]));
  },
  msg_set_pos: (s, a) => s.msgSetPos(a),
  win_viewport: (s, a) => s.winViewport(a),
  mode_info_set: (s, a) => {
    s.cursorStyleEnabled = a[0] !== false;
    s.modes = Array.isArray(a[1]) ? a[1].map(parseMode) : [];
  },
  mode_change: (s, a) => {
    s.modeName = str(a[0], s.modeName);
    s.modeIdx = num(a[1]);
  },
  option_set: (s, a) => s.optionSet(a),
  set_title: (s, a) => {
    s.title = str(a[0]);
  },
  busy_start: (s) => {
    s.busy = true;
  },
  busy_stop: (s) => {
    s.busy = false;
  },
  mouse_on: (s) => {
    s.mouseOn = true;
  },
  mouse_off: (s) => {
    s.mouseOn = false;
  },
  // Known and deliberately ignored.
  bell: () => {},
  visual_bell: () => {},
  set_icon: () => {},
  chdir: () => {},
  update_menu: () => {},
  win_viewport_margins: () => {},
  win_extmark: () => {},
};
