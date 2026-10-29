// NuiVim's own settings (the Settings window, stored by the app), and how they
// combine with vim.g.nuivim. Pure: no DOM, no Tauri.

import { CONFIG_KEYS, DEFAULTS, FALLBACK_MONO_FONT, FALLBACK_MONO_SIZE, mergeConfig, type Config } from './config';
import { guifontNames, parseGuifont } from './model/guifont';
import type { OpenRequest } from './transport';

export interface AppSettings {
  /** New tabs start here (unless opened from a shell); empty: the home folder. */
  working_directory: string;
  /** File opened in the first tab when NuiVim starts with nothing else to open; empty: none. */
  homepage: string;
  /** Hide the tab bar while only one tab is open. */
  autohide_tabs: boolean;
  /** Appearance options, the same keys as vim.g.nuivim (which overrides them). */
  appearance: Partial<Config>;
}

export const SETTINGS_DEFAULTS: Readonly<AppSettings> = Object.freeze({
  working_directory: '',
  homepage: '',
  autohide_tabs: true,
  appearance: {},
});

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads stored settings, keeping only well-formed values. */
export function parseSettings(raw: unknown): AppSettings {
  const o = isObject(raw) ? raw : {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  // Each appearance key is kept only if it is valid on its own.
  const appearance: Record<string, unknown> = {};
  if (isObject(o.appearance)) {
    for (const key of CONFIG_KEYS) {
      if (key in o.appearance && !mergeConfig({ [key]: o.appearance[key] }).warnings.length) appearance[key] = o.appearance[key];
    }
  }
  return {
    working_directory: str(o.working_directory),
    homepage: str(o.homepage),
    autohide_tabs: typeof o.autohide_tabs === 'boolean' ? o.autohide_tabs : SETTINGS_DEFAULTS.autohide_tabs,
    appearance,
  };
}

/**
 * The effective config of a tab: defaults, then the app's appearance settings,
 * then that tab's vim.g.nuivim. `overridden` lists the keys vim.g.nuivim sets.
 */
export function layerConfig(appearance: Partial<Config>, nvimRaw: unknown): { config: Config; warnings: string[]; overridden: (keyof Config)[] } {
  const base = mergeConfig(appearance).config;
  const { config, warnings } = mergeConfig(nvimRaw, base);
  const overridden = isObject(nvimRaw) ? CONFIG_KEYS.filter((k) => k in nvimRaw) : [];
  return { config, warnings, overridden };
}

/**
 * Where a new tab starts and what it opens. A request (shell command, Finder)
 * brings its own files and, from a shell, its directory; otherwise the tab
 * starts in the settings' working directory, with the homepage only for the
 * first tab at startup (another Neovim opening the same file would hit its swap file).
 */
export function tabStart(req: OpenRequest | null, s: AppSettings, withHomepage = false): { cwd?: string; files: string[] } {
  const cwd = req?.cwd || s.working_directory || undefined;
  const files = req ? req.files : withHomepage && s.homepage ? [s.homepage] : [];
  return { cwd, files };
}

/**
 * The appearance values in use when Settings sets nothing: the defaults, with the
 * mono font and size from Neovim's 'guifont' and the row spacing from 'linespace'.
 */
export function appearanceDefaults(guifont: string, linespace: number): Config {
  return {
    ...DEFAULTS,
    prose_filetypes: [...DEFAULTS.prose_filetypes],
    mono_hl_groups: [...DEFAULTS.mono_hl_groups],
    mono_font: guifontNames(guifont).join(', ') || FALLBACK_MONO_FONT,
    mono_size: parseGuifont(guifont).size ?? FALLBACK_MONO_SIZE,
    linespace,
  };
}

/** How a config value is shown in a Settings field. */
export function showValue(v: unknown): string {
  return v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
}
