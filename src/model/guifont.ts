// 'guifont' parsing: "JetBrains_Mono,Menlo:h14:b" -> CSS family list and size.

export interface GuiFont {
  /** CSS font-family list, or undefined when no font is named. */
  family?: string;
  /** Size in points, or undefined when there is no :h option. */
  size?: number;
}

/** The font names in 'guifont', unescaped ("JetBrains_Mono,Menlo:h14" -> ["JetBrains Mono", "Menlo"]). */
export function guifontNames(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/(?<!\\):/)[0]
    .split(/(?<!\\),/)
    .map((n) => n.replace(/\\(.)/g, '$1').replace(/_/g, ' ').trim())
    .filter((n) => n && n !== '*');
}

export function parseGuifont(value: unknown): GuiFont {
  if (typeof value !== 'string' || value.trim() === '') return {};
  // Split on ':' not preceded by a backslash.
  const parts = value.split(/(?<!\\):/);
  const names = guifontNames(value);
  let size: number | undefined;
  for (const opt of parts.slice(1)) {
    const m = /^h(\d+(?:\.\d+)?)$/.exec(opt.trim());
    if (m) size = Number(m[1]);
  }
  const family = names.length ? names.map(cssFamily).join(', ') : undefined;
  return { family, size };
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-monospace', 'ui-serif', 'ui-sans-serif']);

/** Quotes a family name for CSS unless it is a generic family or already a list. */
export function cssFamily(name: string): string {
  const n = name.trim();
  if (GENERIC.has(n) || n.includes(',') || /^["'].*["']$/.test(n)) return n;
  return `"${n.replace(/["\\]/g, '')}"`;
}
