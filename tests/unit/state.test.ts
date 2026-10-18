import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UiState } from '../../src/model/state';

/** Replays a recorded fixture (see tests/fixtures/record.ts). */
function replay(name: string): { state: UiState; flushes: number } {
  const batches = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown[];
  const state = new UiState();
  let flushes = 0;
  for (const b of batches) if (state.apply(b)) flushes++;
  return { state, flushes };
}

const boxes = (s: UiState, kind: string) => [...s.wins.values()].filter((b) => b.kind === kind && !b.hidden);

describe('recorded startup', () => {
  const { state, flushes } = replay('startup');

  it('reports flushes', () => expect(flushes).toBeGreaterThan(0));

  it('sizes grid 1 and places the window grid (grid_resize, win_pos)', () => {
    const g1 = state.grids.get(1)!;
    expect([g1.width, g1.height]).toEqual([80, 24]);
    const [win] = boxes(state, 'win');
    expect(win).toMatchObject({ grid: 2, win: 1000, row: 0, col: 0, width: 80, height: 22 });
    expect(state.grids.get(2)!.width).toBe(80);
  });

  it('fills window and statusline text (grid_line)', () => {
    expect(state.grids.get(2)!.rowText(0).trimEnd()).toBe('# A short note');
    expect(state.grids.get(2)!.rowText(10).trimEnd()).toBe('~');
    expect(state.grids.get(1)!.rowText(22)).toContain('prose.md');
  });

  it('positions the message grid (msg_set_pos), ignoring grid 0', () => {
    const [msg] = boxes(state, 'msg');
    expect(msg.grid).toBe(3);
    expect(msg.msg).toMatchObject({ row: 23, scrolled: false });
    expect(state.wins.has(0)).toBe(false);
  });

  it('records cursor, modes, mouse, title and colours', () => {
    expect(state.cursor).toEqual({ grid: 2, row: 0, col: 0 });
    expect(state.modes.length).toBeGreaterThan(5);
    expect(state.modeName).toBe('normal');
    expect(state.mode.cursorShape).toBe('block');
    expect(state.mouseOn).toBe(true);
    expect(typeof state.title).toBe('string'); // 'title' is off in the fixture config
    expect(state.defaults.bg).not.toBe(state.defaults.fg);
  });

  it('keeps highlight group names from ext_hlstate (hl_attr_define, hl_group_set)', () => {
    const names = [...state.hl.values()].flatMap((a) => a.names);
    expect(names).toContain('StatusLine');
    expect(state.hlGroups.get('StatusLine')).toBeDefined();
  });

  it('queues a window info query for each win_pos', () => {
    expect(state.takeWinQueries()).toEqual([1000]);
    expect(state.takeWinQueries()).toEqual([]);
  });

  it('reads guifont and linespace (option_set)', () => {
    expect(state.options.linespace).toBe(0);
    expect(state.fontsDirty).toBe(true);
  });
});

describe('recorded :vsplit | split', () => {
  const { state } = replay('split');
  it('has three window boxes at distinct positions', () => {
    const wins = boxes(state, 'win');
    expect(wins).toHaveLength(3);
    const pos = new Set(wins.map((w) => `${w.row},${w.col}`));
    expect(pos.size).toBe(3);
    expect(wins.some((w) => w.col > 0)).toBe(true);
    expect(wins.some((w) => w.row > 0 && w.col === 0)).toBe(true);
  });
  it('draws the vertical separator on grid 1', () => {
    const right = boxes(state, 'win').find((w) => w.col > 0)!;
    expect(state.grids.get(1)!.rows[0].text[right.col - 1]).toBe('│');
  });
});

describe('recorded float (win_float_pos)', () => {
  const { state } = replay('float');
  const [f] = boxes(state, 'float');
  it('stores the anchor', () => {
    expect(f.float).toMatchObject({ anchor: 'NW', anchorGrid: 1, anchorRow: 3, anchorCol: 10, zindex: 60, mouseEnabled: true });
  });
  it('holds border, box drawing, CJK and emoji cells', () => {
    const g = state.grids.get(f.grid)!;
    expect([g.width, g.height]).toEqual([14, 6]);
    expect(g.rows[0].text[0]).toBe('╭');
    const row2 = g.rows[2].text;
    const i = row2.indexOf('漢');
    expect(row2[i + 1]).toBe('');
    expect(g.rows[4].text.slice(1, 3)).toEqual(['😀', '']);
  });
});

describe('recorded completion popup', () => {
  const { state } = replay('pum');
  it('is a float anchored to the window grid, below the cursor', () => {
    const [pum] = boxes(state, 'float');
    expect(pum.float!.anchorGrid).toBe(2);
    expect(pum.float!.anchorRow).toBe(state.cursor.row + 1);
    expect(state.modeName).toBe('insert');
    expect(state.mode.cursorShape).toBe('vertical');
    expect(state.mode.cellPercentage).toBe(25);
  });
});

describe('recorded scrolling (grid_scroll)', () => {
  const { state } = replay('scroll');
  it('ends with rows matching the buffer from line 3', () => {
    const g = state.grids.get(2)!;
    for (let r = 0; r < g.height; r++) expect(g.rowText(r).trimEnd()).toBe(`line ${r + 3} of a long file`);
  });
});

describe('recorded tabs and close (win_close, grid_destroy, win_hide)', () => {
  const { state } = replay('tabs');
  it('drops the closed float and its grid', () => {
    expect(boxes(state, 'float')).toHaveLength(0);
    expect([...state.wins.values()].some((b) => b.kind === 'float')).toBe(false);
  });
  it('hides the first tab window and shows the new one', () => {
    expect(state.wins.get(2)!.hidden).toBe(true);
    expect(boxes(state, 'win')).toHaveLength(1);
  });
});

describe('recorded modes and messages', () => {
  const { state } = replay('modes');
  it('returns to normal mode and shows the message on the message grid', () => {
    expect(state.modeName).toBe('normal');
    const msg = boxes(state, 'msg')[0];
    const g = state.grids.get(msg.grid)!;
    expect(g.rows.some((r) => r.text.join('').includes('hello'))).toBe(true);
  });
});

describe('hand-written events', () => {
  it('handles busy, mouse and ignored events', () => {
    const s = new UiState();
    s.apply([['busy_start', []], ['mouse_on', []]]);
    expect(s.busy).toBe(true);
    expect(s.mouseOn).toBe(true);
    s.apply([['busy_stop', []], ['mouse_off', []], ['bell', []], ['visual_bell', []]]);
    expect(s.busy).toBe(false);
    expect(s.mouseOn).toBe(false);
  });

  it('logs an unknown event once and never throws', () => {
    const s = new UiState();
    const logs: string[] = [];
    s.log = (m) => logs.push(m);
    expect(() => s.apply([['future_event', [1]], ['future_event', [2]], 'junk', [42], ['grid_line', 'x'], ['grid_line', [1]]])).not.toThrow();
    expect(logs.filter((l) => l.includes('future_event'))).toHaveLength(1);
    expect(s.apply('not a batch')).toBe(false);
  });

  it('applies events with extra trailing arguments', () => {
    const s = new UiState();
    s.apply([['grid_resize', [1, 10, 2, 'extra']], ['grid_line', [1, 0, 0, [['a', 1, 2]], false, 'more']]]);
    expect(s.grids.get(1)!.rowText(0)).toBe('aa        ');
  });

  it('marks fonts dirty only when guifont or linespace change', () => {
    const s = new UiState();
    s.fontsDirty = false;
    s.apply([['option_set', ['guifont', ''], ['emoji', true]]]);
    expect(s.fontsDirty).toBe(false);
    s.apply([['option_set', ['guifont', 'Menlo:h13']]]);
    expect(s.fontsDirty).toBe(true);
    s.fontsDirty = false;
    s.apply([['option_set', ['linespace', 2]]]);
    expect(s.fontsDirty).toBe(true);
    expect(s.options).toEqual({ guifont: 'Menlo:h13', linespace: 2 });
  });

  it('re-queries a window when its line count gains a digit (win_viewport)', () => {
    const s = new UiState();
    s.apply([['grid_resize', [2, 10, 5]], ['win_pos', [2, 1000, 0, 0, 10, 5]]]);
    s.takeWinQueries();
    s.apply([['win_viewport', [2, 1000, 0, 5, 0, 0, 9, 0]]]);
    expect(s.takeWinQueries()).toEqual([]);
    s.apply([['win_viewport', [2, 1000, 0, 5, 0, 0, 10, 0]]]);
    expect(s.takeWinQueries()).toEqual([1000]);
  });

  it('stores window info and repaints that grid only when it changes', () => {
    const s = new UiState();
    s.apply([['grid_resize', [2, 4, 2]], ['win_pos', [2, 1000, 0, 0, 4, 2]]]);
    s.grids.get(2)!.rows.forEach((r) => (r.dirty = false));
    expect(s.setWinInfo(1000, { filetype: 'markdown', buftype: '', textoff: 3 })).toBe(true);
    expect(s.grids.get(2)!.rows.every((r) => r.dirty)).toBe(true);
    expect(s.setWinInfo(1000, { filetype: 'markdown', buftype: '', textoff: 3 })).toBe(false);
  });

  it('keeps float creation order across repositioning', () => {
    const s = new UiState();
    s.apply([['win_float_pos', [5, 1001, 'NW', 1, 0, 0, true, 50]], ['win_float_pos', [6, 1002, 'SE', 1, 2.5, 3, false, 50]]]);
    s.apply([['win_float_pos', [5, 1001, 'NE', 1, 1, 1, true, 50]]]);
    expect(s.wins.get(5)!.float!.order).toBeLessThan(s.wins.get(6)!.float!.order);
    expect(s.wins.get(5)!.float!.anchor).toBe('NE');
    expect(s.wins.get(6)!.float).toMatchObject({ anchorRow: 2.5, mouseEnabled: false });
  });

  it('turns a float back into a window on win_pos', () => {
    const s = new UiState();
    s.apply([['win_float_pos', [5, 1001, 'NW', 1, 0, 0, true, 50]], ['win_pos', [5, 1001, 1, 2, 3, 4]]]);
    expect(s.wins.get(5)).toMatchObject({ kind: 'win', row: 1, col: 2, float: undefined });
  });

  it('parses mode_info_set with missing keys', () => {
    const s = new UiState();
    s.apply([['mode_info_set', [true, [{ name: 'normal', cursor_shape: 'block' }, { cursor_shape: 'horizontal', cell_percentage: 20, attr_id: 7, blinkon: 400 }]]], ['mode_change', ['replace', 1]]]);
    expect(s.mode).toMatchObject({ cursorShape: 'horizontal', cellPercentage: 20, attrId: 7, blinkon: 400, blinkoff: 0 });
    expect(s.modeName).toBe('replace');
  });

  it('applies default colours and repaints every row', () => {
    const s = new UiState();
    s.apply([['grid_resize', [1, 2, 1]]]);
    s.grids.get(1)!.rows[0].dirty = false;
    s.apply([['default_colors_set', [0x112233, 0x445566, -1, 0, 0]]]);
    expect(s.defaults).toEqual({ fg: 0x112233, bg: 0x445566, sp: 0xff0000 });
    expect(s.grids.get(1)!.rows[0].dirty).toBe(true);
  });
});
