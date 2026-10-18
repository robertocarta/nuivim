// Pure layout math: column <-> x mapping for prose rows, and float placement.

import type { Corner } from './state';

/** Column-to-x mapping for one prose row, in pixels from the window's left edge. */
export interface ColumnMap {
  textoff: number;
  cellWidth: number;
  spaceWidth: number;
  /** First column after the last non-blank character (>= textoff). */
  endCol: number;
  /** xs[c] = left edge of column c, for 0 <= c <= endCol; xs[endCol] is the end of the text. */
  xs: number[];
}

export interface Rect {
  left: number;
  right: number;
}

const isBlank = (t: string) => t === ' ' || t === '';

/** First column after the last non-blank cell from textoff on (wide chars include their continuation). */
export function textEnd(cells: string[], textoff: number): number {
  let end = textoff;
  for (let c = cells.length - 1; c >= textoff; c--) {
    if (!isBlank(cells[c])) {
      end = c + 1;
      break;
    }
  }
  while (end < cells.length && cells[end] === '') end++;
  return end;
}

/** List markers that keep their cell width at the start of a prose row (with the space after them). */
const MARKERS = new Set(['-', '*', '+', '•', '○', '●', '◦', '▪', '‣', '⁃', '►', '▸']);

/**
 * First column of a prose row's proportional text. Leading blanks (indentation,
 * 'breakindent', virtual indent) and one list marker with its following blanks
 * keep their cell widths, so wrapped lines and body text indented with cells line
 * up under the text of their item or heading.
 */
export function proseStart(cells: string[], textoff: number): number {
  const end = textEnd(cells, textoff);
  let c = textoff;
  while (c < end && cells[c] === ' ') c++;
  let m = c;
  if (MARKERS.has(cells[m])) m++;
  else {
    while (m < end && m - c < 9 && cells[m] >= '0' && cells[m] <= '9') m++;
    m = m > c && (cells[m] === '.' || cells[m] === ')') ? m + 1 : c;
  }
  if (m > c && m < end && cells[m] === ' ') {
    c = m;
    while (c < end && cells[c] === ' ') c++;
  }
  return c;
}

/**
 * Builds the mapping from measured character boxes. `measure(col)` returns the
 * box of the character in cell `col`, relative to the window's left edge.
 */
export function buildColumnMap(
  cells: string[],
  textoff: number,
  cellWidth: number,
  spaceWidth: number,
  measure: (col: number) => Rect | null,
): ColumnMap {
  const endCol = textEnd(cells, textoff);
  const xs: number[] = [];
  for (let c = 0; c < textoff; c++) xs.push(c * cellWidth);
  let lastRight = textoff * cellWidth;
  let lastLeft = lastRight;
  for (let c = textoff; c < endCol; c++) {
    if (cells[c] === '') {
      // Right half of a double-width character: midpoint of that character.
      xs.push((lastLeft + lastRight) / 2);
      continue;
    }
    const r = measure(c);
    const left = r ? r.left : lastRight;
    const right = r ? Math.max(r.right, left) : left + spaceWidth;
    xs.push(left);
    lastLeft = left;
    lastRight = right;
  }
  xs.push(lastRight);
  return { textoff, cellWidth, spaceWidth, endCol, xs };
}

/** x of a (possibly fractional) column. Columns past the text add one space width each. */
export function colToX(m: ColumnMap, col: number): number {
  if (col < m.textoff) return col * m.cellWidth;
  if (col >= m.endCol) return m.xs[m.endCol] + (col - m.endCol) * m.spaceWidth;
  const i = Math.floor(col);
  const f = col - i;
  const x0 = m.xs[i];
  return f === 0 ? x0 : x0 + f * (m.xs[i + 1] - x0);
}

/** Width of the character in column `col` (at least one space wide). */
export function colWidth(m: ColumnMap, cells: string[], col: number): number {
  if (col < m.textoff) return (cells[col + 1] === '' ? 2 : 1) * m.cellWidth;
  let next = col + 1;
  while (cells[next] === '') next++;
  return Math.max(colToX(m, next) - colToX(m, col), m.spaceWidth);
}

/** Column under x (pixels from the window's left edge), clamped to [0, width - 1]. */
export function xToCol(m: ColumnMap, x: number, width: number): number {
  let col: number;
  if (x < m.textoff * m.cellWidth) col = Math.floor(x / m.cellWidth);
  else if (x >= m.xs[m.endCol]) col = m.endCol + Math.floor((x - m.xs[m.endCol]) / m.spaceWidth);
  else {
    // Binary search for the last column whose left edge is <= x.
    let lo = m.textoff;
    let hi = m.endCol - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (m.xs[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    col = lo;
  }
  return Math.max(0, Math.min(width - 1, col));
}

export interface Placement {
  x: number;
  y: number;
}

/**
 * Places a float of size w × h whose `corner` sits on the anchor point, then
 * shifts it back inside a screen of size screenW × screenH (never resizing it).
 */
export function placeFloat(
  anchorX: number,
  anchorY: number,
  w: number,
  h: number,
  corner: Corner,
  screenW: number,
  screenH: number,
): Placement {
  let x = corner === 'NE' || corner === 'SE' ? anchorX - w : anchorX;
  let y = corner === 'SW' || corner === 'SE' ? anchorY - h : anchorY;
  x = Math.max(0, Math.min(x, screenW - w));
  y = Math.max(0, Math.min(y, screenH - h));
  return { x, y };
}
