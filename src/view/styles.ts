// One generated stylesheet: a class per highlight id, plus font variables.

import { colorHex, type HlAttr } from '../model/hl';
import type { UiState } from '../model/state';
import type { Metrics } from './metrics';

/**
 * Light box-drawing characters drawn as CSS lines through the cell centre, so
 * they meet exactly across cells and rows. Arms: u(p), d(own), l(eft), r(ight).
 */
export const BOX_LINES: Record<string, string> = {
  '─': 'lr', '│': 'ud', '┌': 'dr', '┐': 'dl', '└': 'ur', '┘': 'ul',
  '├': 'udr', '┤': 'udl', '┬': 'dlr', '┴': 'ulr', '┼': 'udlr',
};
/** Rounded corners, drawn with a border radius. */
export const BOX_ROUND: Record<string, string> = { '╭': 'dr', '╮': 'dl', '╯': 'ul', '╰': 'ur' };

function boxCss(): string {
  // Offsets are snapped to device pixels (--dp) so 1px lines stay crisp.
  const center = 'round(nearest, calc(50% - var(--lw) / 2), var(--dp))';
  const rules: string[] = [];
  for (const [ch, a] of Object.entries(BOX_LINES)) {
    const sel = `.row>span.b${ch.charCodeAt(0).toString(16)}`;
    const base = 'content:"";position:absolute;background:currentColor';
    if (a.includes('u') || a.includes('d')) {
      rules.push(`${sel}::before{${base};left:${center};width:var(--lw);top:${a.includes('u') ? 0 : center};bottom:${a.includes('d') ? 0 : center}}`);
    }
    if (a.includes('l') || a.includes('r')) {
      rules.push(`${sel}::after{${base};top:${center};height:var(--lw);left:${a.includes('l') ? 0 : center};right:${a.includes('r') ? 0 : center}}`);
    }
  }
  for (const [ch, a] of Object.entries(BOX_ROUND)) {
    const v = a[0] === 'd' ? 'top' : 'bottom';
    const h = a[1] === 'r' ? 'left' : 'right';
    rules.push(
      `.row>span.b${ch.charCodeAt(0).toString(16)}::before{content:"";position:absolute;box-sizing:border-box;` +
        `${a[1] === 'r' ? 'right' : 'left'}:0;${a[0] === 'd' ? 'bottom' : 'top'}:0;` +
        `width:calc(100% - ${center});height:calc(100% - ${center});` +
        `border-${v}:var(--lw) solid currentColor;border-${h}:var(--lw) solid currentColor;border-${v}-${h}-radius:calc(var(--cw) / 2)}`,
    );
  }
  return rules.join('\n');
}

const sheet = document.createElement('style');
sheet.id = 'nuivim-hl';
document.head.appendChild(sheet);

/**
 * Ids of highlights that stay monospace inside prose rows (mono_hl_groups). A
 * group also matches its dotted children, as treesitter captures fall back:
 * "@markup.raw" matches "@markup.raw.markdown_inline".
 */
export function monoHlIds(state: UiState, groups: string[]): Set<number> {
  const ids = new Set<number>();
  const matches = (name: string) => groups.some((g) => name === g || name.startsWith(g + '.'));
  for (const [id, attr] of state.hl) if (attr.names.some(matches)) ids.add(id);
  return ids;
}

function hlRule(id: number, a: HlAttr): string {
  const fg = a.fg !== undefined ? colorHex(a.fg) : 'var(--fg)';
  const bg = a.bg !== undefined ? colorHex(a.bg) : undefined;
  const p: string[] = [];
  if (a.reverse) {
    p.push(`color:${bg ?? 'var(--bg)'}`, `background-color:${fg}`);
  } else {
    if (a.fg !== undefined) p.push(`color:${fg}`);
    if (bg) p.push(`background-color:${bg}`);
  }
  if (a.bold) p.push('font-weight:bold');
  if (a.italic) p.push('font-style:italic');
  const lines: string[] = [];
  if (a.underline || a.undercurl || a.underdouble || a.underdotted || a.underdashed) lines.push('underline');
  if (a.strikethrough) lines.push('line-through');
  if (lines.length) {
    const style = a.undercurl ? 'wavy' : a.underdouble ? 'double' : a.underdotted ? 'dotted' : a.underdashed ? 'dashed' : 'solid';
    p.push(
      `text-decoration-line:${lines.join(' ')}`,
      `text-decoration-style:${style}`,
      `text-decoration-color:${a.sp !== undefined ? colorHex(a.sp) : 'var(--sp)'}`,
      'text-decoration-skip-ink:none',
    );
  }
  return `.h${id}{${p.join(';')}}`;
}

export function writeStyles(state: UiState, metrics: Metrics, monoIds: Set<number>): void {
  const { fonts } = metrics;
  const d = state.defaults;
  const rules = [
    `:root{--fg:${colorHex(d.fg)};--bg:${colorHex(d.bg)};--sp:${colorHex(d.sp)};` +
      `--mono-font:${fonts.monoFamily};--mono-size:${fonts.monoSize}px;` +
      `--prose-font:${fonts.proseFamily};--prose-size:${fonts.proseSize}px;--ch:${metrics.ch}px;` +
      `--bx-scale:${metrics.ch / Math.max(1, metrics.monoLineHeight)};--cw:${metrics.cw}px;--lw:${Math.max(1, Math.round(metrics.cw / 9))}px;--dp:${1 / (window.devicePixelRatio || 1)}px}`,
    boxCss(),
  ];
  for (const [id, attr] of state.hl) rules.push(hlRule(id, attr));
  // mono_hl_groups: set in the mono font but kept in the prose flow.
  if (monoIds.size) rules.push([...monoIds].map((id) => `.pt .h${id}`).join(',') + '{font-family:var(--mono-font);font-size:var(--mono-size)}');
  sheet.textContent = rules.join('\n');
}
