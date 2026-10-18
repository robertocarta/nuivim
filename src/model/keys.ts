// Keyboard event -> Neovim key notation, for keys that produce no text or carry
// Ctrl/Cmd (or Option when it acts as Meta). Text keys return null and reach
// Neovim through the textarea's input event instead.

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export type OptionIsMeta = 'none' | 'left' | 'right' | 'both';

const SPECIAL: Record<string, string> = {
  Enter: 'CR',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'BS',
  Delete: 'Del',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
};
for (let i = 1; i <= 12; i++) SPECIAL[`F${i}`] = `F${i}`;

/** Characters that need a name inside <...>. */
const NAMED: Record<string, string> = { '<': 'lt', '\\': 'Bslash', '|': 'Bar', ' ': 'Space' };

/** Escapes typed text for nvim_input: only '<' is special. */
export function escapeText(text: string): string {
  return text.replace(/</g, '<lt>');
}

/** Whether Option on the given side (from KeyboardEvent.location) counts as Meta. */
export function optionIsMetaFor(setting: OptionIsMeta, side: 'left' | 'right'): boolean {
  return setting === 'both' || setting === side;
}

/** The unmodified character for a physical key, used when Option acts as Meta. */
function baseFromCode(code: string, shift: boolean): string | undefined {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return shift ? m[1] : m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code);
  if (m && !shift) return m[1];
  return undefined;
}

/**
 * Returns the Neovim notation for a keydown, or null when the key should be
 * left alone (it types text, is a lone modifier, or is part of a composition).
 * `optionMeta` says whether the held Option key acts as Meta.
 */
export function keyToNvim(e: KeyLike, optionMeta: boolean): string | null {
  if (e.isComposing || e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return null;
  const meta = e.altKey && optionMeta;
  const special = SPECIAL[e.key];
  if (special) {
    const mods = (e.ctrlKey ? 'C-' : '') + (e.shiftKey ? 'S-' : '') + (meta ? 'M-' : '') + (e.metaKey ? 'D-' : '');
    return `<${mods}${special}>`;
  }
  if ([...e.key].length !== 1) return null; // Shift, Control, CapsLock, …
  if (!e.ctrlKey && !e.metaKey && !meta) return null; // plain text
  let ch = e.key;
  if (meta) ch = baseFromCode(e.code, e.shiftKey) ?? ch;
  let shift = '';
  if (/^[a-zA-Z]$/.test(ch) && (e.ctrlKey || e.metaKey)) {
    // Ctrl/Cmd with a letter: lowercase letter, plus S- when Shift is held.
    // (Meta alone keeps the case from baseFromCode: <M-a>, <M-A>.)
    if (e.shiftKey) shift = 'S-';
    ch = ch.toLowerCase();
  }
  const name = NAMED[ch] ?? ch;
  const mods = (e.ctrlKey ? 'C-' : '') + shift + (meta ? 'M-' : '') + (e.metaKey ? 'D-' : '');
  return `<${mods}${name}>`;
}
