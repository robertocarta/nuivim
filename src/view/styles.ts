// One generated stylesheet: a class per highlight id, plus font variables.

import { colorHex, type HlAttr } from '../model/hl';
import type { UiState } from '../model/state';
import type { Metrics } from './metrics';

const sheet = document.createElement('style');
sheet.id = 'propvim-hl';
document.head.appendChild(sheet);

/** Ids of highlights that stay monospace inside prose rows (mono_hl_groups). */
export function monoHlIds(state: UiState, groups: string[]): Set<number> {
  const wanted = new Set(groups);
  const ids = new Set<number>();
  for (const [id, attr] of state.hl) if (attr.names.some((n) => wanted.has(n))) ids.add(id);
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
      `--prose-font:${fonts.proseFamily};--prose-size:${fonts.proseSize}px;--ch:${metrics.ch}px}`,
  ];
  for (const [id, attr] of state.hl) rules.push(hlRule(id, attr));
  // mono_hl_groups: set in the mono font but kept in the prose flow.
  if (monoIds.size) rules.push([...monoIds].map((id) => `.pt .h${id}`).join(',') + '{font-family:var(--mono-font);font-size:var(--mono-size)}');
  sheet.textContent = rules.join('\n');
}
