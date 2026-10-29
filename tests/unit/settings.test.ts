import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/config';
import { Tabs, tabTitle } from '../../src/model/tabs';
import { appearanceDefaults, layerConfig, parseSettings, SETTINGS_DEFAULTS, showValue, tabStart } from '../../src/settings';

describe('parseSettings', () => {
  it('defaults for nothing stored', () => {
    expect(parseSettings({})).toEqual(SETTINGS_DEFAULTS);
    expect(parseSettings(null)).toEqual(SETTINGS_DEFAULTS);
  });
  it('keeps well-formed values only', () => {
    expect(
      parseSettings({
        working_directory: ' ~/notes ',
        homepage: 'index.md',
        autohide_tabs: false,
        appearance: { prose_size: 18, overflow: 'bad', prose_filetypes: ['md'], colour: 'red', linespace: 2.5 },
      }),
    ).toEqual({ working_directory: '~/notes', homepage: 'index.md', autohide_tabs: false, appearance: { prose_size: 18, prose_filetypes: ['md'] } });
    expect(parseSettings({ working_directory: 3, autohide_tabs: 'yes' })).toMatchObject({ working_directory: '', autohide_tabs: true });
  });
});

describe('layerConfig', () => {
  it('vim.g.nuivim overrides the app settings, which override the defaults', () => {
    const { config, overridden, warnings } = layerConfig({ prose_font: 'Iowan Old Style', prose_size: 20 }, { prose_size: 22, linespace: 4 });
    expect(config).toMatchObject({ prose_font: 'Iowan Old Style', prose_size: 22, linespace: 4, overflow: DEFAULTS.overflow });
    expect(overridden).toEqual(['prose_size', 'linespace']);
    expect(warnings).toEqual([]);
  });
  it('a bad vim.g.nuivim value keeps the app setting and warns', () => {
    const { config, warnings, overridden } = layerConfig({ overflow: 'clip' }, { overflow: 'bad' });
    expect(config.overflow).toBe('clip');
    expect(warnings).toEqual(['overflow must be "shrink" or "clip"']);
    expect(overridden).toEqual(['overflow']);
  });
  it('no vim.g.nuivim', () => {
    expect(layerConfig({}, undefined)).toMatchObject({ overridden: [], warnings: [] });
  });
});

describe('tabStart', () => {
  const s = { ...SETTINGS_DEFAULTS, working_directory: '~/notes', homepage: 'index.md' };
  it('the first tab at startup: working directory and homepage', () => {
    expect(tabStart(null, s, true)).toEqual({ cwd: '~/notes', files: ['index.md'] });
    expect(tabStart(null, SETTINGS_DEFAULTS, true)).toEqual({ cwd: undefined, files: [] });
  });
  it('a new tab later: working directory, no homepage (its swap file is taken)', () => {
    expect(tabStart(null, s)).toEqual({ cwd: '~/notes', files: [] });
  });
  it('from a shell: its directory and files, no homepage', () => {
    expect(tabStart({ cwd: '/work', files: ['a.txt'] }, s)).toEqual({ cwd: '/work', files: ['a.txt'] });
    expect(tabStart({ cwd: '/work', files: [] }, s)).toEqual({ cwd: '/work', files: [] });
  });
  it('from Finder (no directory): the working directory', () => {
    expect(tabStart({ cwd: null, files: ['/x/b.md'] }, s)).toEqual({ cwd: '~/notes', files: ['/x/b.md'] });
  });
});

describe('appearanceDefaults', () => {
  it("takes the mono font and size from 'guifont' and spacing from 'linespace'", () => {
    const d = appearanceDefaults('SF Mono,Menlo,Monaco:h13', 2);
    expect(d).toMatchObject({ prose_font: 'Charter', prose_size: 16, mono_font: 'SF Mono, Menlo, Monaco', mono_size: 13, linespace: 2, overflow: 'shrink' });
    expect(d.prose_filetypes).toEqual(DEFAULTS.prose_filetypes);
  });
  it("falls back to Menlo 14 without 'guifont'", () => {
    expect(appearanceDefaults('', 0)).toMatchObject({ mono_font: 'Menlo', mono_size: 14, linespace: 0 });
  });
  it('shows lists comma-separated', () => {
    expect(showValue(['a', 'b'])).toBe('a, b');
    expect(showValue(16)).toBe('16');
    expect(showValue(undefined)).toBe('');
  });
});

describe('Tabs', () => {
  it('adds after the active tab and activates it', () => {
    const t = new Tabs();
    const a = t.add('a');
    const b = t.add('b');
    t.select(a.id);
    const c = t.add('c');
    expect(t.list.map((x) => x.title)).toEqual(['a', 'c', 'b']);
    expect(t.active).toBe(c.id);
    expect(b.id).not.toBe(c.id);
  });
  it('removing the active tab activates its right neighbour, else the left one', () => {
    const t = new Tabs();
    const [a, b, c] = [t.add('a'), t.add('b'), t.add('c')];
    t.select(b.id);
    t.remove(b.id);
    expect(t.active).toBe(c.id);
    t.remove(c.id);
    expect(t.active).toBe(a.id);
    t.remove(a.id);
    expect(t.active).toBe(-1);
  });
  it('removing another tab keeps the active one', () => {
    const t = new Tabs();
    const [a, b] = [t.add('a'), t.add('b')];
    t.remove(a.id);
    expect(t.active).toBe(b.id);
  });
  it('cycles and selects by number (9 = last)', () => {
    const t = new Tabs();
    const [a, , c] = [t.add('a'), t.add('b'), t.add('c')];
    t.cycle(1);
    expect(t.active).toBe(a.id);
    t.cycle(-1);
    expect(t.active).toBe(c.id);
    t.selectNumber(1);
    expect(t.active).toBe(a.id);
    t.selectNumber(9);
    expect(t.active).toBe(c.id);
    t.selectNumber(5);
    expect(t.active).toBe(c.id);
  });
});

describe('tabTitle', () => {
  it('is the file name, else the directory name', () => {
    expect(tabTitle('/a/b/notes.md', '/a')).toBe('notes.md');
    expect(tabTitle('', '/Users/x/project/')).toBe('project');
    expect(tabTitle('', '/')).toBe('/');
    expect(tabTitle('', '')).toBe('[No Name]');
    expect(tabTitle('term://~//123:/bin/zsh', '/a')).toBe('zsh');
  });
});
