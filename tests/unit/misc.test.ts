import { describe, expect, it } from 'vitest';
import { DEFAULTS, mergeConfig } from '../../src/config';
import { parseGuifont } from '../../src/model/guifont';
import { colorHex, effectiveColors, hasOwnBackground, parseHlAttr } from '../../src/model/hl';

describe('parseGuifont', () => {
  it('reads names, escapes and size', () => {
    expect(parseGuifont('JetBrains_Mono,Menlo:h14:b')).toEqual({ family: '"JetBrains Mono", "Menlo"', size: 14 });
    expect(parseGuifont('Fira\\ Code:h12.5')).toEqual({ family: '"Fira Code"', size: 12.5 });
    expect(parseGuifont(':h16')).toEqual({ family: undefined, size: 16 });
    expect(parseGuifont('monospace')).toEqual({ family: 'monospace', size: undefined });
    expect(parseGuifont('')).toEqual({});
    expect(parseGuifont(42)).toEqual({});
  });
});

describe('highlights', () => {
  it('parses rgb attributes and hi_name list', () => {
    const a = parseHlAttr({ foreground: 0xff0000, undercurl: true, special: 0x00ff00, bold: true }, [
      { kind: 'syntax', hi_name: 'Error', id: 1 },
      { kind: 'ui', ui_name: 'Visual', hi_name: 'Visual', id: 2 },
    ]);
    expect(a).toMatchObject({ fg: 0xff0000, sp: 0x00ff00, bold: true, undercurl: true, italic: false, names: ['Error', 'Visual'] });
    expect(parseHlAttr(null, null)).toMatchObject({ fg: undefined, names: [] });
  });

  it('swaps colours for reverse and falls back to defaults', () => {
    const def = { fg: 1, bg: 2, sp: 3 };
    expect(effectiveColors(parseHlAttr({ reverse: true }, []), def)).toEqual({ fg: 2, bg: 1 });
    expect(effectiveColors(undefined, def)).toEqual({ fg: 1, bg: 2 });
    expect(hasOwnBackground(parseHlAttr({ background: 5 }, []))).toBe(true);
    expect(hasOwnBackground(parseHlAttr({ foreground: 5 }, []))).toBe(false);
    expect(colorHex(0xab)).toBe('#0000ab');
  });
});

describe('mergeConfig', () => {
  it('returns defaults for nil or an empty table', () => {
    expect(mergeConfig(undefined)).toEqual({ config: { ...DEFAULTS }, warnings: [] });
    expect(mergeConfig([]).warnings).toEqual([]);
  });

  it('merges valid keys', () => {
    const { config, warnings } = mergeConfig({ prose_font: 'Iowan Old Style', prose_size: 18, overflow: 'clip', prose_filetypes: ['markdown'], option_is_meta: 'left', mono_font: 'Menlo', mono_size: 13 });
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({ prose_font: 'Iowan Old Style', prose_size: 18, overflow: 'clip', prose_filetypes: ['markdown'], option_is_meta: 'left', mono_font: 'Menlo', mono_size: 13 });
    expect(config.mono_hl_groups).toEqual(DEFAULTS.mono_hl_groups);
  });

  it('ignores bad values and unknown keys with one warning each', () => {
    const { config, warnings } = mergeConfig({ overflow: 'bad', prose_size: 'big', colour: 'red', mono_hl_groups: [1] });
    expect(config.overflow).toBe('shrink');
    expect(config.prose_size).toBe(16);
    expect(config.mono_hl_groups).toEqual(DEFAULTS.mono_hl_groups);
    expect(warnings).toEqual([
      'overflow must be "shrink" or "clip"',
      'prose_size must be a number of points between 4 and 200',
      'unknown option colour',
      'mono_hl_groups must be a list of strings',
    ]);
  });

  it('accepts linespace as whole pixels only', () => {
    expect(mergeConfig({ linespace: 6 }).config.linespace).toBe(6);
    expect(mergeConfig({}).config.linespace).toBeUndefined();
    const bad = mergeConfig({ linespace: 2.5 });
    expect(bad.config.linespace).toBeUndefined();
    expect(bad.warnings).toEqual(['linespace must be a whole number of pixels between 0 and 100']);
  });

  it('rejects a non-table value', () => {
    expect(mergeConfig('x').warnings).toEqual(['vim.g.nuivim must be a table of options']);
  });

  it('does not share default lists between results', () => {
    const a = mergeConfig(undefined).config;
    a.prose_filetypes.push('x');
    expect(mergeConfig(undefined).config.prose_filetypes).not.toContain('x');
  });
});
