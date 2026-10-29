import { describe, expect, it } from 'vitest';
import { escapeText, isMenuShortcut, keyToNvim, optionIsMetaFor, type KeyLike } from '../../src/model/keys';

const k = (key: string, mods: Partial<KeyLike> = {}, code = ''): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('keyToNvim', () => {
  it('maps special keys', () => {
    const cases: [string, string][] = [
      ['Enter', '<CR>'], ['Escape', '<Esc>'], ['Tab', '<Tab>'], ['Backspace', '<BS>'], ['Delete', '<Del>'],
      ['ArrowUp', '<Up>'], ['ArrowDown', '<Down>'], ['ArrowLeft', '<Left>'], ['ArrowRight', '<Right>'],
      ['Home', '<Home>'], ['End', '<End>'], ['PageUp', '<PageUp>'], ['PageDown', '<PageDown>'], ['Insert', '<Insert>'],
      ['F1', '<F1>'], ['F12', '<F12>'],
    ];
    for (const [key, out] of cases) expect(keyToNvim(k(key), false)).toBe(out);
  });

  it('adds modifiers to special keys, including Shift', () => {
    expect(keyToNvim(k('Tab', { ctrlKey: true, shiftKey: true }), false)).toBe('<C-S-Tab>');
    expect(keyToNvim(k('Enter', { shiftKey: true }), false)).toBe('<S-CR>');
    expect(keyToNvim(k('ArrowLeft', { metaKey: true }), false)).toBe('<D-Left>');
    expect(keyToNvim(k('F5', { altKey: true }), true)).toBe('<M-F5>');
    expect(keyToNvim(k('F5', { altKey: true }), false)).toBe('<F5>');
  });

  it('leaves text keys to the input event', () => {
    expect(keyToNvim(k('a'), false)).toBeNull();
    expect(keyToNvim(k('A', { shiftKey: true }), false)).toBeNull();
    expect(keyToNvim(k('<', { shiftKey: true }), false)).toBeNull();
    expect(keyToNvim(k(' '), false)).toBeNull();
    expect(keyToNvim(k('å', { altKey: true }, 'KeyA'), false)).toBeNull();
  });

  it('ignores lone modifiers, dead keys and composition', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Process', 'Unidentified']) {
      expect(keyToNvim(k(key, { ctrlKey: true }), false)).toBeNull();
    }
    expect(keyToNvim(k('Enter', { isComposing: true }), false)).toBeNull();
  });

  it('maps Ctrl and Cmd combinations', () => {
    expect(keyToNvim(k('s', { metaKey: true }), false)).toBe('<D-s>');
    expect(keyToNvim(k('a', { ctrlKey: true }), false)).toBe('<C-a>');
    expect(keyToNvim(k('A', { ctrlKey: true, shiftKey: true }), false)).toBe('<C-S-a>');
    expect(keyToNvim(k('s', { metaKey: true, shiftKey: true }), false)).toBe('<S-D-s>'); // Neovim reads this as <D-S>
    expect(keyToNvim(k('[', { ctrlKey: true }), false)).toBe('<C-[>');
    expect(keyToNvim(k('@', { ctrlKey: true, shiftKey: true }), false)).toBe('<C-@>');
    expect(keyToNvim(k('=', { metaKey: true }), false)).toBe('<D-=>');
  });

  it('names <, \\, | and space inside <...>', () => {
    expect(keyToNvim(k('<', { ctrlKey: true }), false)).toBe('<C-lt>');
    expect(keyToNvim(k('\\', { ctrlKey: true }), false)).toBe('<C-Bslash>');
    expect(keyToNvim(k('|', { metaKey: true }), false)).toBe('<D-Bar>');
    expect(keyToNvim(k(' ', { ctrlKey: true }), false)).toBe('<C-Space>');
  });

  it('uses the physical key when Option is Meta', () => {
    expect(keyToNvim(k('å', { altKey: true }, 'KeyA'), true)).toBe('<M-a>');
    expect(keyToNvim(k('Å', { altKey: true, shiftKey: true }, 'KeyA'), true)).toBe('<M-A>');
    expect(keyToNvim(k('¡', { altKey: true }, 'Digit1'), true)).toBe('<M-1>');
    expect(keyToNvim(k('ƒ', { altKey: true, ctrlKey: true }, 'KeyF'), true)).toBe('<C-M-f>');
  });
});

describe('isMenuShortcut', () => {
  it('leaves menu shortcuts to the menu bar', () => {
    for (const key of ['q', 'h', 'm', 't', 'w', ',', 'Q']) expect(isMenuShortcut(k(key, { metaKey: true }))).toBe(true);
    expect(isMenuShortcut(k('˙', { metaKey: true, altKey: true }, 'KeyH'))).toBe(true);
    expect(isMenuShortcut(k('f', { metaKey: true, ctrlKey: true }, 'KeyF'))).toBe(true);
    expect(isMenuShortcut(k('}', { metaKey: true, shiftKey: true }, 'BracketRight'))).toBe(true);
    expect(isMenuShortcut(k('{', { metaKey: true, shiftKey: true }, 'BracketLeft'))).toBe(true);
  });
  it('keeps everything else for Neovim or the app', () => {
    expect(isMenuShortcut(k('q'))).toBe(false);
    expect(isMenuShortcut(k('q', { ctrlKey: true }))).toBe(false);
    expect(isMenuShortcut(k('s', { metaKey: true }))).toBe(false);
    expect(isMenuShortcut(k('c', { metaKey: true }))).toBe(false);
    expect(isMenuShortcut(k(']', { metaKey: true }, 'BracketRight'))).toBe(false);
    expect(isMenuShortcut(k('w', { metaKey: true, shiftKey: true }, 'KeyW'))).toBe(false);
  });
});

describe('optionIsMetaFor', () => {
  it('honours the side setting', () => {
    expect(optionIsMetaFor('none', 'left')).toBe(false);
    expect(optionIsMetaFor('left', 'left')).toBe(true);
    expect(optionIsMetaFor('left', 'right')).toBe(false);
    expect(optionIsMetaFor('right', 'right')).toBe(true);
    expect(optionIsMetaFor('both', 'left')).toBe(true);
  });
});

describe('escapeText', () => {
  it('escapes < only', () => {
    expect(escapeText('a<b>c')).toBe('a<lt>b>c');
    expect(escapeText('かな')).toBe('かな');
  });
});
