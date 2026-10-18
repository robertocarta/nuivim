// A grid of cells as Neovim sends it. Rows are objects with a stable key so
// the view can move a row's element on grid_scroll instead of rebuilding it.

let nextRowKey = 1;

export class Row {
  readonly key = nextRowKey++;
  text: string[];
  hl: number[];
  dirty = true;

  constructor(width: number) {
    this.text = new Array<string>(width).fill(' ');
    this.hl = new Array<number>(width).fill(0);
  }

  resize(width: number): void {
    const old = this.text.length;
    this.text.length = width;
    this.hl.length = width;
    for (let i = old; i < width; i++) {
      this.text[i] = ' ';
      this.hl[i] = 0;
    }
    this.dirty = true;
  }

  clear(): void {
    this.text.fill(' ');
    this.hl.fill(0);
    this.dirty = true;
  }
}

/** One cell of a grid_line event: [text, hl_id?, repeat?]. */
export type CellUpdate = [string, number?, number?];

export class Grid {
  rows: Row[] = [];

  constructor(
    readonly id: number,
    public width: number,
    public height: number,
  ) {
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.rows.length > height) this.rows.length = height;
    for (const row of this.rows) if (row.text.length !== width) row.resize(width);
    while (this.rows.length < height) this.rows.push(new Row(width));
  }

  clear(): void {
    for (const row of this.rows) row.clear();
  }

  /** grid_line: write cells from col, honouring hl carry-over and repeat counts. */
  line(rowIndex: number, col: number, cells: unknown[]): void {
    const row = this.rows[rowIndex];
    if (!row) return;
    let hl = 0;
    let c = col;
    for (const cell of cells) {
      if (!Array.isArray(cell)) continue;
      const text = typeof cell[0] === 'string' ? cell[0] : ' ';
      if (typeof cell[1] === 'number') hl = cell[1];
      const repeat = typeof cell[2] === 'number' ? cell[2] : 1;
      for (let i = 0; i < repeat && c < this.width; i++, c++) {
        row.text[c] = text;
        row.hl[c] = hl;
      }
    }
    row.dirty = true;
  }

  /**
   * grid_scroll: move rows [top, bot) up by `count` (down if negative). Full-width
   * scrolls move Row objects; the rows scrolled in are reused and marked dirty,
   * and Neovim fills them with grid_line right after.
   */
  scroll(top: number, bot: number, left: number, right: number, count: number): void {
    top = Math.max(0, top);
    bot = Math.min(this.height, bot);
    const size = bot - top;
    if (count === 0 || size <= 0) return;
    if (Math.abs(count) >= size) {
      for (let r = top; r < bot; r++) this.rows[r].dirty = true;
      return;
    }
    if (left === 0 && right >= this.width) {
      const region = this.rows.slice(top, bot);
      const k = count > 0 ? count : size + count;
      const rotated = region.slice(k).concat(region.slice(0, k));
      const vacated = count > 0 ? rotated.slice(size - count) : rotated.slice(0, -count);
      for (const row of vacated) row.dirty = true;
      this.rows.splice(top, size, ...rotated);
      return;
    }
    // Partial-width scroll: copy cells.
    const copyRow = (dst: number, src: number) => {
      const d = this.rows[dst];
      const s = this.rows[src];
      for (let c = left; c < right && c < this.width; c++) {
        d.text[c] = s.text[c];
        d.hl[c] = s.hl[c];
      }
      d.dirty = true;
    };
    if (count > 0) for (let r = top; r < bot - count; r++) copyRow(r, r + count);
    else for (let r = bot - 1; r >= top - count; r--) copyRow(r, r + count);
  }

  /** The row's text, one string per cell (continuation cells are empty strings). */
  rowText(rowIndex: number): string {
    return this.rows[rowIndex]?.text.join('') ?? '';
  }
}
