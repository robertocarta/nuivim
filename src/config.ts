// vim.g.nuivim merged over the defaults. Pure: no DOM, no Tauri.

import type { OptionIsMeta } from './model/keys';

export interface Config {
  prose_font: string;
  prose_size: number;
  /** undefined: take the font from 'guifont', else Menlo. */
  mono_font?: string;
  /** undefined: take the size from 'guifont', else 14. */
  mono_size?: number;
  prose_filetypes: string[];
  mono_hl_groups: string[];
  overflow: 'shrink' | 'clip';
  option_is_meta: OptionIsMeta;
  /** Extra pixels between rows; undefined: Neovim's 'linespace' option. */
  linespace?: number;
}

export const DEFAULTS: Readonly<Config> = Object.freeze({
  prose_font: 'Charter',
  prose_size: 16,
  mono_font: undefined,
  mono_size: undefined,
  prose_filetypes: ['markdown', 'text', 'tex', 'plaintex', 'rst', 'org', 'norg', 'typst', 'asciidoc', 'gitcommit', 'mail'],
  mono_hl_groups: ['@markup.raw', '@markup.raw.block', '@markup.math', 'markdownCode', 'markdownCodeBlock', 'texMathZone'],
  overflow: 'shrink',
  option_is_meta: 'none',
  linespace: undefined,
});

export const FALLBACK_MONO_FONT = 'Menlo';
export const FALLBACK_MONO_SIZE = 14;

type Check = (v: unknown) => string | null; // null = valid, else the expected-type text

const isString: Check = (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'must be a font name (string)');
const isSize: Check = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 4 && v <= 200 ? null : 'must be a number of points between 4 and 200');
const isLinespace: Check = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? null : 'must be a whole number of pixels between 0 and 100');
const isStringList: Check = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be a list of strings';
const oneOf = (...values: string[]): Check => (v) =>
  typeof v === 'string' && values.includes(v) ? null : `must be ${values.map((x) => `"${x}"`).join(values.length === 2 ? ' or ' : ', ')}`;

const CHECKS: Record<keyof Config, Check> = {
  prose_font: isString,
  prose_size: isSize,
  mono_font: isString,
  mono_size: isSize,
  prose_filetypes: isStringList,
  mono_hl_groups: isStringList,
  overflow: oneOf('shrink', 'clip'),
  option_is_meta: oneOf('none', 'left', 'right', 'both'),
  linespace: isLinespace,
};

/**
 * Merges a raw vim.g.nuivim value over the defaults. Unknown keys and values of
 * the wrong type are ignored (the default stays) and produce one warning each.
 */
export function mergeConfig(raw: unknown): { config: Config; warnings: string[] } {
  const config: Config = { ...DEFAULTS, prose_filetypes: [...DEFAULTS.prose_filetypes], mono_hl_groups: [...DEFAULTS.mono_hl_groups] };
  const warnings: string[] = [];
  // An empty Lua table arrives as an empty array.
  if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) return { config, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('vim.g.nuivim must be a table of options');
    return { config, warnings };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in CHECKS)) {
      warnings.push(`unknown option ${key}`);
      continue;
    }
    const k = key as keyof Config;
    const problem = CHECKS[k](value);
    if (problem) {
      warnings.push(`${key} ${problem}`);
      continue;
    }
    (config as unknown as Record<string, unknown>)[k] = value;
  }
  return { config, warnings };
}
