import { describe, expect, it } from 'vitest';
import { buildColumnMap, colToX, colWidth, placeFloat, proseStart, textEnd, xToCol } from '../../src/model/layout';

/** Fake measurer: characters have the given widths, laid out from x0. */
function fake(cells: string[], textoff: number, x0: number, widthOf: (ch: string) => number) {
  const lefts: number[] = [];
  let x = x0;
  for (let c = textoff; c < cells.length; c++) {
    lefts[c] = x;
    if (cells[c] !== '') x += widthOf(cells[c]);
  }
  return (col: number) => ({ left: lefts[col], right: lefts[col] + widthOf(cells[col]) });
}

const W: Record<string, number> = { i: 4, W: 15, m: 13, ' ': 4, a: 8, 漢: 16 };
const width = (ch: string) => W[ch] ?? 8;

describe('textEnd', () => {
  it('finds the first column after the last non-blank cell', () => {
    expect(textEnd([...'12 ab   '], 2)).toBe(5);
    expect(textEnd([...'12      '], 2)).toBe(2);
    expect(textEnd(['1', 'x', '漢', '', ' '], 1)).toBe(4);
  });
});

describe('proseStart', () => {
  const start = (line: string, textoff = 0) => proseStart([...line.padEnd(30)], textoff);
  it('keeps leading blanks on cells', () => {
    expect(start('    indented text')).toBe(4);
    expect(start('plain text')).toBe(0);
    expect(start('12  text', 2)).toBe(4);
  });
  it('keeps one list marker and the blanks after it', () => {
    expect(start('- item')).toBe(2);
    expect(start('   ○ Heading')).toBe(5);
    expect(start('  12. step')).toBe(6);
    expect(start('3) step')).toBe(3);
    expect(start('-   spaced')).toBe(4);
  });
  it('does not treat text that only looks like a marker as one', () => {
    expect(start('*emphasis* here')).toBe(0);
    expect(start('-dash')).toBe(0);
    expect(start('2026 was a year')).toBe(0);
    expect(start('- [ ] task')).toBe(2);
  });
  it('stops at the end of the text', () => {
    expect(start('      ')).toBe(0);
    expect(start('   -')).toBe(3);
  });
});

describe('buildColumnMap / colToX', () => {
  // Gutter of 3 mono cells (cw = 10), then "iiWm" in prose.
  const cells = [...'12 iiWm   '];
  const map = buildColumnMap(cells, 3, 10, 4, fake(cells, 3, 30, width));

  it('maps gutter columns to cells', () => {
    expect(colToX(map, 0)).toBe(0);
    expect(colToX(map, 2)).toBe(20);
  });

  it('maps text columns to measured character lefts', () => {
    expect([3, 4, 5, 6].map((c) => colToX(map, c))).toEqual([30, 34, 38, 53]);
    expect(map.endCol).toBe(7);
    expect(colToX(map, 7)).toBe(66);
  });

  it('adds one prose space per column past the end of the text', () => {
    expect(colToX(map, 8)).toBe(70);
    expect(colToX(map, 9)).toBe(74);
  });

  it('interpolates fractional columns', () => {
    expect(colToX(map, 5.5)).toBe(45.5);
    expect(colToX(map, 7.5)).toBe(68);
  });

  it('gives character widths, at least one space wide', () => {
    expect(colWidth(map, cells, 5)).toBe(15);
    expect(colWidth(map, cells, 3)).toBe(4);
    expect(colWidth(map, cells, 8)).toBe(4);
    expect(colWidth(map, cells, 1)).toBe(10);
  });

  it('maps an empty text area to textoff', () => {
    const empty = [...'12        '];
    const m = buildColumnMap(empty, 3, 10, 4, () => null);
    expect(m.endCol).toBe(3);
    expect(colToX(m, 3)).toBe(30);
    expect(colToX(m, 5)).toBe(38);
  });

  it('treats a double-width character as one box, its continuation at the midpoint', () => {
    const wide = ['漢', '', 'a', ' '];
    const m = buildColumnMap(wide, 0, 10, 4, fake(wide, 0, 0, width));
    expect([0, 1, 2, 3].map((c) => colToX(m, c))).toEqual([0, 8, 16, 24]);
    expect(colWidth(m, wide, 0)).toBe(16);
  });

  it('tolerates a measurer that returns nothing', () => {
    const m = buildColumnMap([...'ab '], 0, 10, 4, () => null);
    expect(m.xs).toEqual([0, 4, 8]);
  });
});

describe('xToCol', () => {
  const cells = [...'12 iiWm   '];
  const map = buildColumnMap(cells, 3, 10, 4, fake(cells, 3, 30, width));

  it('hit-tests gutter, text and past-the-end positions', () => {
    expect(xToCol(map, 5, 10)).toBe(0);
    expect(xToCol(map, 29.9, 10)).toBe(2);
    expect(xToCol(map, 30, 10)).toBe(3);
    expect(xToCol(map, 36, 10)).toBe(4);
    expect(xToCol(map, 45.5, 10)).toBe(5); // middle of W
    expect(xToCol(map, 60, 10)).toBe(6);
    expect(xToCol(map, 66, 10)).toBe(7);
    expect(xToCol(map, 71, 10)).toBe(8);
  });

  it('clamps to the grid', () => {
    expect(xToCol(map, -5, 10)).toBe(0);
    expect(xToCol(map, 1000, 10)).toBe(9);
  });

  it('round-trips every column', () => {
    for (let c = 0; c < 10; c++) expect(xToCol(map, colToX(map, c) + 0.5, 10)).toBe(c);
  });
});

describe('placeFloat', () => {
  const at = (corner: 'NW' | 'NE' | 'SW' | 'SE', x = 100, y = 100) => placeFloat(x, y, 40, 20, corner, 300, 200);

  it('puts the anchor corner on the anchor point', () => {
    expect(at('NW')).toEqual({ x: 100, y: 100 });
    expect(at('NE')).toEqual({ x: 60, y: 100 });
    expect(at('SW')).toEqual({ x: 100, y: 80 });
    expect(at('SE')).toEqual({ x: 60, y: 80 });
  });

  it('shifts back inside the right and bottom edges without resizing', () => {
    expect(at('NW', 290, 190)).toEqual({ x: 260, y: 180 });
  });

  it('shifts back inside the left and top edges', () => {
    expect(at('SE', 10, 5)).toEqual({ x: 0, y: 0 });
  });

  it('pins a float larger than the screen to the top-left', () => {
    expect(placeFloat(50, 50, 400, 300, 'NW', 300, 200)).toEqual({ x: 0, y: 0 });
  });
});
