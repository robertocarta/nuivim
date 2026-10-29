// The Settings window (⌘,): NuiVim's own settings. Appearance fields that the
// active tab's vim.g.nuivim sets are shown but disabled, since that table wins.

import { DEFAULTS, mergeConfig, type Config } from '../config';
import type { AppSettings } from '../settings';

type Field =
  | { key: keyof Config; label: string; kind: 'text' | 'number' | 'list'; placeholder: string; hint?: string }
  | { key: keyof Config; label: string; kind: 'select'; options: [string, string][]; hint?: string };

const APPEARANCE: Field[] = [
  { key: 'prose_font', label: 'Prose font', kind: 'text', placeholder: DEFAULTS.prose_font },
  { key: 'prose_size', label: 'Prose size (pt)', kind: 'number', placeholder: String(DEFAULTS.prose_size) },
  { key: 'mono_font', label: 'Mono font', kind: 'text', placeholder: "from 'guifont', else Menlo" },
  { key: 'mono_size', label: 'Mono size (pt)', kind: 'number', placeholder: "from 'guifont', else 14" },
  { key: 'linespace', label: 'Line spacing (px)', kind: 'number', placeholder: "from 'linespace', else 0" },
  { key: 'prose_filetypes', label: 'Prose filetypes', kind: 'list', placeholder: DEFAULTS.prose_filetypes.join(', ') },
  { key: 'mono_hl_groups', label: 'Mono highlight groups', kind: 'list', placeholder: DEFAULTS.mono_hl_groups.join(', ') },
  {
    key: 'overflow',
    label: 'Lines too wide for the window',
    kind: 'select',
    options: [['', 'Default (shrink)'], ['shrink', 'Shrink to fit'], ['clip', 'Cut off']],
  },
  {
    key: 'option_is_meta',
    label: 'Option key as Meta',
    kind: 'select',
    options: [['', 'Default (neither)'], ['none', 'Neither'], ['left', 'Left Option'], ['right', 'Right Option'], ['both', 'Both']],
  },
];

function el(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElement {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

interface InputProps {
  type: string;
  name: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
}

function input(props: InputProps): HTMLInputElement {
  const e = document.createElement('input');
  e.type = props.type;
  e.name = props.name;
  if (props.value !== undefined) e.value = props.value;
  if (props.placeholder !== undefined) e.placeholder = props.placeholder;
  if (props.checked !== undefined) e.checked = props.checked;
  return e;
}

export interface SettingsPanelOptions {
  settings: AppSettings;
  /** Appearance keys set by the active tab's vim.g.nuivim. */
  overridden: (keyof Config)[];
  /** Saves; resolves with an error message, or null. */
  save(settings: AppSettings): Promise<string | null>;
  close(): void;
}

export function openSettingsPanel(host: HTMLElement, o: SettingsPanelOptions): void {
  const s = o.settings;
  const inputs = new Map<keyof Config, HTMLInputElement | HTMLSelectElement>();
  const row = (label: string, control: HTMLElement, hint?: string) =>
    el('label', { className: 'field' }, el('span', { className: 'name' }, label), control, ...(hint ? [el('small', {}, hint)] : []));

  const wd = input({ type: 'text', value: s.working_directory, placeholder: '~ (home folder)', name: 'working_directory' });
  const home = input({ type: 'text', value: s.homepage, placeholder: 'none', name: 'homepage' });
  const autohide = input({ type: 'checkbox', checked: s.autohide_tabs, name: 'autohide_tabs' });

  const appearanceRows = APPEARANCE.map((f) => {
    const value = s.appearance[f.key];
    let control: HTMLInputElement | HTMLSelectElement;
    if (f.kind === 'select') {
      const select = document.createElement('select');
      select.name = f.key;
      for (const [v, label] of f.options) select.append(new Option(label, v));
      control = select;
      control.value = typeof value === 'string' ? value : '';
    } else {
      control = input({
        type: f.kind === 'number' ? 'number' : 'text',
        name: f.key,
        placeholder: f.placeholder,
        value: value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value),
      });
    }
    inputs.set(f.key, control);
    const overridden = o.overridden.includes(f.key);
    control.disabled = overridden;
    return row(f.label, control, overridden ? 'Set by vim.g.nuivim in your Neovim config, which takes precedence.' : f.hint);
  });

  const error = el('p', { className: 'error', role: 'alert' });
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  const saveBtn = el('button', { type: 'submit', textContent: 'Save', className: 'primary' });
  const form = el(
    'form',
    { className: 'settings', ariaLabel: 'NuiVim settings' },
    el('h1', {}, 'Settings'),
    el('h2', {}, 'Tabs'),
    row('Working directory', wd, 'New tabs start here. Tabs opened with the nuivim shell command start in the directory it was run from.'),
    row('Homepage file', home, 'Opened in new tabs; relative paths are relative to the working directory.'),
    el('label', { className: 'check' }, autohide, ' Hide the tab bar when only one tab is open'),
    el('h2', {}, 'Appearance'),
    el('p', { className: 'note' }, 'Empty fields use the default. vim.g.nuivim in your Neovim config overrides these.'),
    ...appearanceRows,
    error,
    el('div', { className: 'buttons' }, cancel, saveBtn),
  );

  const collect = (): AppSettings | string => {
    const appearance: Record<string, unknown> = {};
    for (const f of APPEARANCE) {
      const control = inputs.get(f.key)!;
      if (control.disabled) {
        if (s.appearance[f.key] !== undefined) appearance[f.key] = s.appearance[f.key];
        continue;
      }
      const raw = control.value.trim();
      if (!raw) continue;
      appearance[f.key] = f.kind === 'number' ? Number(raw) : f.kind === 'list' ? raw.split(/[\s,]+/).filter(Boolean) : raw;
    }
    const { warnings } = mergeConfig(appearance);
    if (warnings.length) return warnings.map((w) => w.replace(/^(\w+)/, (k) => APPEARANCE.find((f) => f.key === k)?.label ?? k)).join('. ') + '.';
    return { working_directory: wd.value.trim(), homepage: home.value.trim(), autohide_tabs: autohide.checked, appearance };
  };

  // Values are checked by mergeConfig, with messages in the form, not by the browser.
  (form as HTMLFormElement).noValidate = true;
  const backdrop = el('div', { className: 'settings-backdrop' }, form);
  // Escape closes the panel wherever the focus is (WebKit does not focus clicked buttons).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    o.close();
  };
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = collect();
    if (typeof result === 'string') {
      error.textContent = result;
      return;
    }
    const failure = await o.save(result);
    if (failure) error.textContent = failure;
    else close();
  });
  host.append(backdrop);
  wd.focus();
}
