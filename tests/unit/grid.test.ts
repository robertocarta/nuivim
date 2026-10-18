import { describe, expect, it } from 'vitest';
import { Grid } from '../../src/model/grid';

const text = (g: Grid, r: number) => g.rowText(r);

describe('Grid.line', () => {
  it('writes cells with hl carry-over and repeat counts', () => {
    const g = new Grid(2, 10, 2);
    g.line(0, 1, [['a', 5], ['b'], [' ', 7, 3], ['c', 8, 2]]);
    expect(text(g, 0)).toBe(' ab   cc  ');
    expect(g.rows[0].hl.slice(0, 8)).toEqual([0, 5, 5, 7, 7, 7, 8, 8]);
  });

  it('keeps the empty continuation cell after a double-width character', () => {
    const g = new Grid(2, 6, 1);
    g.line(0, 0, [['漢', 1], [''], ['x']]);
    expect(g.rows[0].text.slice(0, 3)).toEqual(['漢', '', 'x']);
    expect(g.rows[0].hl.slice(0, 3)).toEqual([1, 1, 1]);
  });

  it('leaves the rest of the row unchanged and ignores cells past the edge', () => {
    const g = new Grid(2, 4, 1);
    g.line(0, 0, [['z', 0, 4]]);
    g.line(0, 2, [['a', 0, 10]]);
    expect(text(g, 0)).toBe('zzaa');
  });

  it('ignores rows outside the grid and malformed cells', () => {
    const g = new Grid(2, 4, 1);
    g.line(5, 0, [['a']]);
    g.line(0, 0, [null, 'x', ['b', 2]]);
    expect(text(g, 0)).toBe('b   ');
  });

  it('marks the row dirty', () => {
    const g = new Grid(2, 4, 2);
    g.rows.forEach((r) => (r.dirty = false));
    g.line(1, 0, [['a']]);
    expect(g.rows.map((r) => r.dirty)).toEqual([false, true]);
  });
});

describe('Grid.scroll', () => {
  const filled = (h: number) => {
    const g = new Grid(2, 3, h);
    for (let r = 0; r < h; r++) g.line(r, 0, [[String(r), 0, 3]]);
    g.rows.forEach((r) => (r.dirty = false));
    return g;
  };

  it('moves rows up and reuses the vacated rows (full width)', () => {
    const g = filled(5);
    const keys = g.rows.map((r) => r.key);
    g.scroll(0, 5, 0, 3, 2);
    expect([0, 1, 2].map((r) => text(g, r))).toEqual(['222', '333', '444']);
    // Moved rows are the same objects and stay clean; vacated rows are dirty.
    expect(g.rows.slice(0, 3).map((r) => r.key)).toEqual(keys.slice(2));
    expect(g.rows.map((r) => r.dirty)).toEqual([false, false, false, true, true]);
  });

  it('moves rows down inside a region', () => {
    const g = filled(5);
    g.scroll(1, 4, 0, 3, -1);
    expect(text(g, 0)).toBe('000');
    expect(text(g, 2)).toBe('111');
    expect(text(g, 3)).toBe('222');
    expect(text(g, 4)).toBe('444');
    expect(g.rows[1].dirty).toBe(true);
  });

  it('copies cells for a partial-width region', () => {
    const g = filled(3);
    g.scroll(0, 3, 1, 2, 1);
    expect([0, 1, 2].map((r) => text(g, r))).toEqual(['010', '121', '222']);
  });

  it('marks the whole region dirty when scrolling by its height or more', () => {
    const g = filled(3);
    g.scroll(0, 3, 0, 3, 3);
    expect(g.rows.every((r) => r.dirty)).toBe(true);
    expect(text(g, 0)).toBe('000');
  });
});

describe('Grid.resize and clear', () => {
  it('keeps content when growing and pads with spaces', () => {
    const g = new Grid(2, 2, 1);
    g.line(0, 0, [['a', 3, 2]]);
    g.resize(4, 2);
    expect(text(g, 0)).toBe('aa  ');
    expect(text(g, 1)).toBe('    ');
    g.resize(1, 1);
    expect(g.rows.length).toBe(1);
    expect(text(g, 0)).toBe('a');
  });

  it('clears every cell', () => {
    const g = new Grid(2, 2, 2);
    g.line(1, 0, [['x', 4, 2]]);
    g.clear();
    expect(text(g, 1)).toBe('  ');
    expect(g.rows[1].hl).toEqual([0, 0]);
  });
});
