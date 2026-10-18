// Turns UiState into DOM. Every grid is laid out on the mono cell metric; only
// the text area of prose windows is set proportionally inside its window box.

import type { Config } from '../config';
import { effectiveColors, colorHex, hasOwnBackground } from '../model/hl';
import { buildColumnMap, colToX, colWidth, placeFloat, textEnd, xToCol, type ColumnMap } from '../model/layout';
import type { Grid, Row } from '../model/grid';
import type { UiState, WinBox } from '../model/state';
import type { Metrics } from './metrics';
import { BOX_LINES, BOX_ROUND, monoHlIds, writeStyles } from './styles';

/** Per-row bookkeeping for prose rows: where each cell's text sits in the DOM. */
interface ProseRow {
  pc: HTMLElement;
  spanIdx: Int32Array;
  off: Int32Array;
  len: Int32Array;
  /** Horizontal scale from overflow = shrink (1 when the text fits). */
  scale: number;
  map?: ColumnMap;
}

class GridView {
  readonly el = document.createElement('div');
  readonly rowEls = new Map<number, HTMLDivElement>();
  readonly prose = new Map<number, ProseRow>();
  isProse = false;
  textoff = 0;
  visible = false;
  x = 0;
  y = 0;
  w = 0;
  h = 0;
  z = 0;

  constructor(readonly id: number) {
    this.el.className = 'grid';
    this.el.dataset.grid = String(id);
  }
}

export interface Hit {
  grid: number;
  row: number;
  col: number;
}

export interface PaintStats {
  /** Milliseconds per paint, most recent last (bounded). */
  times: number[];
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const isAscii = (t: string) => t.length === 1 && t.charCodeAt(0) < 0x80;
/** Extra classes for box-drawing characters: drawn lines, or a glyph stretched to the cell height. */
function boxClass(t: string): string {
  if (t.length !== 1) return '';
  const code = t.charCodeAt(0);
  if (code < 0x2500 || code > 0x259f) return '';
  return BOX_LINES[t] || BOX_ROUND[t] ? ` bd b${code.toString(16)}` : ' bx';
}
const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
/** Snaps to device pixels so neighbouring cell backgrounds meet without seams. */
const snap = (n: number) => {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(n * dpr) / dpr;
};
/** A mono span covering cells [c0, c1). */
const cellSpan = (cls: string, c0: number, c1: number, cw: number, text: string) => {
  const x0 = snap(c0 * cw);
  return `<span class="${cls}" style="left:${px(x0)};width:${px(snap(c1 * cw) - x0)}">${esc(text)}</span>`;
};

export class Renderer {
  private views = new Map<number, GridView>();
  private cursorEl = document.createElement('div');
  private measureHost = document.createElement('div');
  private blinkSheet = document.createElement('style');
  private blinkKey = '';
  private blinkFlip = false;
  private lastCursor = '';
  private monoIds = new Set<number>();
  private stylesDirty = true;
  /** Grids in hit-test order, topmost first. */
  private stack: GridView[] = [];
  readonly stats: PaintStats = { times: [] };

  constructor(
    private readonly screen: HTMLElement,
    public metrics: Metrics,
    public config: Config,
  ) {
    this.cursorEl.className = 'cursor';
    this.measureHost.className = 'pt measure';
    this.measureHost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.measureHost);
    document.head.appendChild(this.blinkSheet);
  }

  /** New fonts or config: everything is re-measured and repainted. */
  reset(state: UiState, metrics: Metrics, config: Config): void {
    this.metrics = metrics;
    this.config = config;
    this.stylesDirty = true;
    for (const v of this.views.values()) v.prose.clear();
    state.markAllDirty();
  }

  private isProseBox(box: WinBox | undefined): boolean {
    return (
      !!box &&
      box.kind === 'win' &&
      !!box.info &&
      box.info.buftype !== 'terminal' &&
      this.config.prose_filetypes.includes(box.info.filetype)
    );
  }

  paint(state: UiState): void {
    const t0 = performance.now();
    const { cw, ch } = this.metrics;
    if (state.hlDirty || this.stylesDirty) {
      this.monoIds = monoHlIds(state, this.config.mono_hl_groups);
      writeStyles(state, this.metrics, this.monoIds);
      state.hlDirty = false;
      this.stylesDirty = false;
    }

    for (const [id, v] of this.views) {
      if (!state.grids.has(id)) {
        v.el.remove();
        this.views.delete(id);
      }
    }

    const painted: [GridView, ProseRow][] = [];
    for (const grid of state.grids.values()) {
      let v = this.views.get(grid.id);
      if (!v) {
        v = new GridView(grid.id);
        this.views.set(grid.id, v);
        this.screen.appendChild(v.el);
      }
      const box = state.wins.get(grid.id);
      v.visible = grid.id === 1 || (!!box && !box.hidden);
      v.el.style.display = v.visible ? '' : 'none';
      if (!v.visible) continue;
      const prose = this.isProseBox(box);
      const textoff = prose ? Math.min(box!.info!.textoff, grid.width) : 0;
      if (prose !== v.isProse || textoff !== v.textoff) {
        v.isProse = prose;
        v.textoff = textoff;
        v.prose.clear();
        for (const row of grid.rows) row.dirty = true;
      }
      v.el.classList.toggle('prose', prose);
      v.w = grid.width * cw;
      v.h = grid.height * ch;
      v.el.style.width = px(v.w);
      v.el.style.height = px(v.h);
      this.paintRows(state, grid, v, painted);
    }

    // Read phase: overflow of freshly painted prose rows, then one write pass.
    const avail = (v: GridView) => v.w - v.textoff * cw;
    const widths = painted.map(([, pr]) => pr.pc.getBoundingClientRect().width);
    painted.forEach(([v, pr], i) => {
      const a = avail(v);
      if (widths[i] > a + 0.5 && this.config.overflow === 'shrink') {
        pr.scale = a / widths[i];
        pr.pc.style.transform = `scaleX(${pr.scale})`;
      }
    });

    this.layout(state);
    this.paintCursor(state);

    const times = this.stats.times;
    times.push(performance.now() - t0);
    if (times.length > 5000) times.splice(0, times.length - 5000);
  }

  private paintRows(state: UiState, grid: Grid, v: GridView, painted: [GridView, ProseRow][]): void {
    const { ch } = this.metrics;
    const live = new Set<number>();
    grid.rows.forEach((row, r) => {
      live.add(row.key);
      let el = v.rowEls.get(row.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'row';
        v.rowEls.set(row.key, el);
        v.el.appendChild(el);
      }
      const top = px(r * ch);
      if (el.style.top !== top) el.style.top = top;
      if (!row.dirty) return;
      row.dirty = false;
      if (v.isProse) {
        const pr = this.paintProseRow(state, row, v, el);
        v.prose.set(row.key, pr);
        painted.push([v, pr]);
      } else {
        el.innerHTML = this.monoHtml(row, 0, row.text.length);
      }
    });
    for (const [key, el] of v.rowEls) {
      if (!live.has(key)) {
        el.remove();
        v.rowEls.delete(key);
        v.prose.delete(key);
      }
    }
  }

  /** Mono cells [from, to): ASCII runs share a span; other characters get their own. */
  private monoHtml(row: Row, from: number, to: number): string {
    const { cw } = this.metrics;
    const { text, hl } = row;
    let html = '';
    let c = from;
    while (c < to) {
      const t = text[c];
      const h = hl[c];
      if (t === '') {
        c++;
        continue;
      }
      if (isAscii(t)) {
        const start = c;
        let s = t;
        c++;
        while (c < to && hl[c] === h && isAscii(text[c])) s += text[c++];
        if (h === 0 && s.trim() === '') continue;
        html += cellSpan(`h${h}`, start, c, cw, s);
      } else {
        const w = text[c + 1] === '' ? 2 : 1;
        html += cellSpan(`h${h}${boxClass(t)}`, c, c + w, cw, t);
        c++;
      }
    }
    return html;
  }

  private paintProseRow(state: UiState, row: Row, v: GridView, el: HTMLDivElement): ProseRow {
    const { cw } = this.metrics;
    const { text, hl } = row;
    const width = text.length;
    const textoff = v.textoff;
    const end = textEnd(text, textoff);
    const spanIdx = new Int32Array(width).fill(-1);
    const off = new Int32Array(width);
    const len = new Int32Array(width);
    let runs = '';
    let span = -1;
    let cur = -1;
    let s = '';
    const flush = () => {
      if (span >= 0) runs += `<span class="h${cur}">${esc(s)}</span>`;
    };
    for (let c = textoff; c < end; c++) {
      const t = text[c];
      if (t === '') continue;
      if (hl[c] !== cur || span < 0) {
        flush();
        span++;
        cur = hl[c];
        s = '';
      }
      spanIdx[c] = span;
      off[c] = s.length;
      len[c] = t.length;
      s += t;
    }
    flush();
    // Trailing blanks with their own background (CursorLine, visual to end of
    // line) stretch to the window's right edge.
    const fillHl = end < width ? hl[end] : 0;
    const filler = end < width && hasOwnBackground(state.hl.get(fillHl)) ? `<span class="h${fillHl} pf"></span>` : '';
    el.innerHTML =
      this.monoHtml(row, 0, textoff) +
      `<div class="pt" style="left:${px(textoff * cw)};width:${px((width - textoff) * cw)}"><span class="pc">${runs}</span>${filler}</div>`;
    const pc = el.querySelector<HTMLElement>('.pc')!;
    return { pc, spanIdx, off, len, scale: 1 };
  }

  /**
   * The column-to-x mapping of a prose row, built lazily. WebKit snaps Range
   * rects of partial text nodes to whole pixels, so offsets inside a span come
   * from prefix widths measured as elements (exact), set in the same classes.
   */
  private columnMap(v: GridView, grid: Grid, rowIndex: number): ColumnMap | null {
    const row = grid.rows[rowIndex];
    const pr = row && v.prose.get(row.key);
    if (!row || !pr) return null;
    if (pr.map) return pr.map;
    const el = v.rowEls.get(row.key)!;
    const base = el.getBoundingClientRect().left;
    const spans = [...pr.pc.children] as HTMLElement[];
    const rects = spans.map((s) => s.getBoundingClientRect());
    const texts = spans.map((s) => s.textContent ?? '');

    // One hidden element per needed prefix; prefix 0 and the full text need none.
    const wanted = new Map<string, number>();
    let html = '';
    const need = (span: number, off: number) => {
      if (off <= 0 || off >= texts[span].length) return;
      const key = `${span}:${off}`;
      if (wanted.has(key)) return;
      wanted.set(key, wanted.size);
      html += `<span class="${spans[span].className}">${esc(texts[span].slice(0, off))}</span>`;
    };
    for (let c = v.textoff; c < row.text.length; c++) {
      if (pr.spanIdx[c] < 0) continue;
      need(pr.spanIdx[c], pr.off[c]);
      need(pr.spanIdx[c], pr.off[c] + pr.len[c]);
    }
    this.measureHost.innerHTML = html;
    const widths = [...this.measureHost.children].map((e) => e.getBoundingClientRect().width);
    this.measureHost.textContent = '';

    const x = (span: number, off: number) => {
      const r = rects[span];
      if (off <= 0) return r.left - base;
      if (off >= texts[span].length) return r.right - base;
      return r.left - base + widths[wanted.get(`${span}:${off}`)!] * pr.scale;
    };
    const measure = (col: number) => {
      const span = pr.spanIdx[col];
      if (span < 0 || !rects[span]) return null;
      return { left: x(span, pr.off[col]), right: x(span, pr.off[col] + pr.len[col]) };
    };
    pr.map = buildColumnMap(row.text, v.textoff, this.metrics.cw, this.metrics.proseSpace, measure);
    return pr.map;
  }

  /** x of a column on a grid, in pixels from the grid's left edge. */
  colX(gridId: number, rowIndex: number, col: number, state: UiState): number {
    const v = this.views.get(gridId);
    const grid = state.grids.get(gridId);
    if (v && grid && v.isProse && col >= v.textoff) {
      const map = this.columnMap(v, grid, Math.max(0, Math.min(grid.height - 1, rowIndex)));
      if (map) return colToX(map, col);
    }
    return col * this.metrics.cw;
  }

  private layout(state: UiState): void {
    const { cw, ch } = this.metrics;
    const screenGrid = state.grids.get(1);
    const screenW = (screenGrid?.width ?? 0) * cw;
    const screenH = (screenGrid?.height ?? 0) * ch;
    this.screen.style.width = px(screenW);
    this.screen.style.height = px(screenH);

    const placed = new Map<number, { x: number; y: number }>();
    const resolving = new Set<number>();
    const origin = (id: number): { x: number; y: number } => {
      const done = placed.get(id);
      if (done) return done;
      const box = state.wins.get(id);
      const v = this.views.get(id);
      let p = { x: 0, y: 0 };
      if (id !== 1 && box && v && !resolving.has(id)) {
        resolving.add(id);
        if (box.kind === 'win') p = { x: box.col * cw, y: box.row * ch };
        else if (box.kind === 'msg' && box.msg) p = { x: 0, y: box.msg.row * ch };
        else if (box.kind === 'float' && box.float) {
          const f = box.float;
          const o = origin(f.anchorGrid);
          // Floats next to the cursor (completion, hover, signature help) belong
          // to the cursor's row, also when they sit on the row below it.
          const c = state.cursor;
          const row = c.grid === f.anchorGrid && (f.anchorRow === c.row || f.anchorRow === c.row + 1) ? c.row : Math.floor(f.anchorRow);
          const ax = o.x + this.colX(f.anchorGrid, row, f.anchorCol, state);
          const ay = o.y + f.anchorRow * ch;
          p = placeFloat(ax, ay, v.w, v.h, f.anchor, screenW, screenH);
        }
        resolving.delete(id);
      }
      placed.set(id, p);
      return p;
    };

    const floats: GridView[] = [];
    const wins: GridView[] = [];
    const msgs: GridView[] = [];
    for (const v of this.views.values()) {
      if (!v.visible || v.id === 1) continue;
      const box = state.wins.get(v.id)!;
      (box.kind === 'float' ? floats : box.kind === 'msg' ? msgs : wins).push(v);
    }
    const fz = (v: GridView) => state.wins.get(v.id)!.float!;
    floats.sort((a, b) => fz(a).zindex - fz(b).zindex || fz(a).order - fz(b).order);

    const place = (v: GridView, z: number) => {
      const p = origin(v.id);
      v.x = snap(p.x);
      v.y = snap(p.y);
      v.z = z;
      v.el.style.transform = `translate(${px(v.x)},${px(v.y)})`;
      v.el.style.zIndex = String(z);
    };
    const g1 = this.views.get(1);
    if (g1) place(g1, 0);
    wins.forEach((v) => place(v, 1));
    floats.forEach((v, i) => place(v, 100 + i));
    msgs.forEach((v) => place(v, 100000));

    const mouseFloats = floats.filter((v) => state.wins.get(v.id)!.float!.mouseEnabled);
    this.stack = [...msgs, ...mouseFloats.reverse(), ...wins, ...(g1 ? [g1] : [])];
  }

  /** The grid cell under a point (client coordinates), topmost grid first. */
  hitTest(clientX: number, clientY: number, state: UiState): Hit | null {
    const { cw, ch } = this.metrics;
    const sr = this.screen.getBoundingClientRect();
    const x = clientX - sr.left;
    const y = clientY - sr.top;
    for (const v of this.stack) {
      if (x < v.x || x >= v.x + v.w || y < v.y || y >= v.y + v.h) continue;
      const grid = state.grids.get(v.id);
      if (!grid) continue;
      const row = Math.max(0, Math.min(grid.height - 1, Math.floor((y - v.y) / ch)));
      const lx = x - v.x;
      let col = Math.max(0, Math.min(grid.width - 1, Math.floor(lx / cw)));
      if (v.isProse && lx >= v.textoff * cw) {
        const map = this.columnMap(v, grid, row);
        if (map) col = xToCol(map, lx, grid.width);
      }
      return { grid: v.id, row, col };
    }
    return null;
  }

  /** Cursor box in client coordinates, for the hidden textarea and IME overlay. */
  cursorBox(state: UiState): { x: number; y: number; h: number; prose: boolean } {
    const v = this.views.get(state.cursor.grid);
    const sr = this.screen.getBoundingClientRect();
    const { row, col } = state.cursor;
    const x = (v?.x ?? 0) + this.colX(state.cursor.grid, row, col, state);
    return { x: sr.left + x, y: sr.top + (v?.y ?? 0) + row * this.metrics.ch, h: this.metrics.ch, prose: !!v?.isProse && col >= v.textoff };
  }

  private paintCursor(state: UiState): void {
    const el = this.cursorEl;
    const { cw, ch } = this.metrics;
    const { grid: gid, row, col } = state.cursor;
    const v = this.views.get(gid);
    const grid = state.grids.get(gid);
    const cells = grid?.rows[row];
    if (!v || !v.visible || !grid || !cells || state.busy) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    if (el.parentElement !== v.el) v.el.appendChild(el);

    let x = col * cw;
    let w = (cells.text[col + 1] === '' ? 2 : 1) * cw;
    const prose = v.isProse && col >= v.textoff;
    const scale = prose ? (v.prose.get(cells.key)?.scale ?? 1) : 1;
    if (prose) {
      const map = this.columnMap(v, grid, row);
      if (map) {
        x = colToX(map, col);
        w = colWidth(map, cells.text, col);
      }
    }
    const mode = state.mode;
    const cellHl = cells.hl[col] ?? 0;
    const cellAttr = state.hl.get(cellHl);
    const attr = mode.attrId ? state.hl.get(mode.attrId) : undefined;
    let fg: number;
    let bg: number;
    if (!attr) {
      const c = effectiveColors(cellAttr, state.defaults);
      fg = c.bg;
      bg = c.fg;
    } else {
      ({ fg, bg } = effectiveColors(attr, state.defaults));
    }
    let top = row * ch;
    let height = ch;
    let text = '';
    if (mode.cursorShape === 'horizontal') {
      height = Math.max(1, Math.round((ch * mode.cellPercentage) / 100));
      top += ch - height;
    } else if (mode.cursorShape === 'vertical') {
      w = Math.max(1, Math.round((cw * mode.cellPercentage) / 100));
    } else {
      text = cells.text[col] ?? ' ';
    }
    el.style.transform = `translate(${px(x)},${px(top)})`;
    el.style.width = px(w);
    el.style.height = px(height);
    const monoFont = !prose || this.monoIds.has(cellHl);
    el.className = `cursor h${cellHl}${monoFont ? '' : ' cp'}`;
    el.style.background = colorHex(bg);
    el.style.color = colorHex(fg);
    el.style.textDecoration = 'none';
    if (scale !== 1 && text) {
      // A shrunk row: draw the character under the cursor at the row's scale.
      el.innerHTML = `<span style="display:inline-block;transform:scaleX(${scale});transform-origin:0 0">${esc(text)}</span>`;
    } else {
      el.textContent = text;
    }
    this.blink(mode.blinkwait, mode.blinkon, mode.blinkoff, `${gid}:${row}:${col}:${state.modeIdx}`);
  }

  /** CSS blink: restarted (by swapping identical keyframes) whenever the cursor moves. */
  private blink(wait: number, on: number, off: number, where: string): void {
    const el = this.cursorEl;
    if (!on || !off) {
      el.style.animation = 'none';
      return;
    }
    const key = `${on}/${off}`;
    if (key !== this.blinkKey) {
      this.blinkKey = key;
      const pct = (on / (on + off)) * 100;
      const frames = `{0%{opacity:1}${pct}%{opacity:0}100%{opacity:0}}`;
      this.blinkSheet.textContent = `@keyframes pvblink0${frames}@keyframes pvblink1${frames}`;
    }
    if (where !== this.lastCursor) {
      this.lastCursor = where;
      this.blinkFlip = !this.blinkFlip;
    }
    el.style.animation = `pvblink${this.blinkFlip ? 1 : 0} ${on + off}ms step-end ${wait}ms infinite`;
  }
}
