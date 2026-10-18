// Highlight attributes from hl_attr_define, with the ext_hlstate group names.

export interface HlAttr {
  fg?: number;
  bg?: number;
  sp?: number;
  reverse: boolean;
  italic: boolean;
  bold: boolean;
  strikethrough: boolean;
  underline: boolean;
  undercurl: boolean;
  underdouble: boolean;
  underdotted: boolean;
  underdashed: boolean;
  /** Every hi_name in the info array, lowest priority first. */
  names: string[];
}

export interface DefaultColors {
  fg: number;
  bg: number;
  sp: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && v >= 0 ? v : undefined);

export function parseHlAttr(rgb: unknown, info: unknown): HlAttr {
  const a = (rgb && typeof rgb === 'object' ? rgb : {}) as Record<string, unknown>;
  const names: string[] = [];
  if (Array.isArray(info)) {
    for (const item of info) {
      const name = item && typeof item === 'object' ? (item as Record<string, unknown>).hi_name : undefined;
      if (typeof name === 'string' && name) names.push(name);
    }
  }
  return {
    fg: num(a.foreground),
    bg: num(a.background),
    sp: num(a.special),
    reverse: a.reverse === true,
    italic: a.italic === true,
    bold: a.bold === true,
    strikethrough: a.strikethrough === true,
    underline: a.underline === true,
    undercurl: a.undercurl === true,
    underdouble: a.underdouble === true,
    underdotted: a.underdotted === true,
    underdashed: a.underdashed === true,
    names,
  };
}

export function colorHex(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

/** Effective foreground/background after reverse, falling back to the defaults. */
export function effectiveColors(attr: HlAttr | undefined, def: DefaultColors): { fg: number; bg: number } {
  const fg = attr?.fg ?? def.fg;
  const bg = attr?.bg ?? def.bg;
  return attr?.reverse ? { fg: bg, bg: fg } : { fg, bg };
}

/** True when cells with this highlight paint a background different from the grid's default. */
export function hasOwnBackground(attr: HlAttr | undefined): boolean {
  return !!attr && (attr.bg !== undefined || attr.reverse);
}
