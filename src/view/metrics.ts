// The monospace cell metric every grid is laid out on.

export interface Fonts {
  /** CSS font-family lists. */
  monoFamily: string;
  proseFamily: string;
  /** Sizes in points; drawn as CSS pixels (1 pt = 1 CSS px, as in other macOS GUIs). */
  monoSize: number;
  proseSize: number;
  linespace: number;
}

export interface Metrics {
  fonts: Fonts;
  /** Cell width: the mono font's advance width. */
  cw: number;
  /** Cell height: the taller font's line height plus linespace, in whole pixels. */
  ch: number;
  /** Width of one space in the prose font. */
  proseSpace: number;
  /** Line height of the mono font alone (box-drawing glyphs are stretched from it to ch). */
  monoLineHeight: number;
}

function measureText(family: string, size: number, text: string): { width: number; height: number } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;visibility:hidden;left:-10000px;top:0;white-space:pre;line-height:normal;' +
    `font-family:${family};font-size:${size}px;font-kerning:none`;
  el.textContent = text;
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.remove();
  return { width: r.width, height: r.height };
}

export function measure(fonts: Fonts): Metrics {
  const mono = measureText(fonts.monoFamily, fonts.monoSize, '0'.repeat(100));
  const prose = measureText(fonts.proseFamily, fonts.proseSize, ' '.repeat(100) + 'x');
  const proseX = measureText(fonts.proseFamily, fonts.proseSize, 'x');
  const cw = mono.width / 100;
  const ch = Math.max(1, Math.round(Math.max(mono.height, prose.height) + fonts.linespace));
  return { fonts, cw, ch, proseSpace: (prose.width - proseX.width) / 100, monoLineHeight: mono.height };
}
