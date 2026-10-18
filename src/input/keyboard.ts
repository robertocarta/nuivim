// Keyboard and IME input through a hidden textarea kept at the cursor, so every
// layout, dead key and input method works without guessing from key codes.

import { escapeText, keyToNvim, optionIsMetaFor, type OptionIsMeta } from '../model/keys';

export interface KeyboardHooks {
  send(keys: string): void;
  optionIsMeta(): OptionIsMeta;
  /** Keys the app keeps for itself (font size). Returns true when handled. */
  appKey(e: KeyboardEvent): boolean;
  /** Uncommitted IME text, or null when composition ends. */
  compose(text: string | null): void;
}

export function attachKeyboard(ta: HTMLTextAreaElement, hooks: KeyboardHooks): void {
  let composing = false;
  const alt = { left: false, right: false };

  ta.addEventListener('keydown', (e) => {
    if (e.code === 'AltLeft') alt.left = true;
    if (e.code === 'AltRight') alt.right = true;
    if (composing || e.isComposing) return;
    if (hooks.appKey(e)) {
      e.preventDefault();
      return;
    }
    const setting = hooks.optionIsMeta();
    const optionMeta = e.altKey && ((alt.left && optionIsMetaFor(setting, 'left')) || (alt.right && optionIsMetaFor(setting, 'right')));
    const keys = keyToNvim(e, optionMeta);
    if (keys) {
      e.preventDefault();
      hooks.send(keys);
    }
  });

  ta.addEventListener('keyup', (e) => {
    if (e.code === 'AltLeft') alt.left = false;
    if (e.code === 'AltRight') alt.right = false;
  });
  ta.addEventListener('blur', () => {
    alt.left = alt.right = false;
  });

  ta.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    if (composing || ie.isComposing || ie.inputType === 'insertCompositionText' || ie.inputType === 'insertFromComposition') {
      if (!composing) ta.value = '';
      return;
    }
    const text = ta.value;
    ta.value = '';
    if (text) hooks.send(escapeText(text));
  });

  ta.addEventListener('compositionstart', () => {
    composing = true;
    hooks.compose('');
  });
  ta.addEventListener('compositionupdate', (e) => hooks.compose(e.data ?? ''));
  ta.addEventListener('compositionend', (e) => {
    composing = false;
    hooks.compose(null);
    ta.value = '';
    if (e.data) hooks.send(escapeText(e.data));
  });
}
