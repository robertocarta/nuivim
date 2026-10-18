// Mouse and wheel input, hit-tested on the same layout the renderer drew.

import type { Hit } from '../view/renderer';

export interface MouseHooks {
  enabled(): boolean;
  hitTest(clientX: number, clientY: number): Hit | null;
  send(button: string, action: string, modifier: string, hit: Hit): void;
  cell(): { cw: number; ch: number };
  focus(): void;
}

const BUTTONS = ['left', 'middle', 'right'];

const mods = (e: MouseEvent) => (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '') + (e.altKey ? 'A' : '') + (e.metaKey ? 'D' : '');

export function attachMouse(screen: HTMLElement, hooks: MouseHooks): void {
  let held: string | null = null;
  let last: Hit | null = null;
  const same = (a: Hit | null, b: Hit | null) => !!a && !!b && a.grid === b.grid && a.row === b.row && a.col === b.col;

  screen.addEventListener('mousedown', (e) => {
    e.preventDefault();
    hooks.focus();
    const button = BUTTONS[e.button];
    if (!hooks.enabled() || !button) return;
    const hit = hooks.hitTest(e.clientX, e.clientY);
    if (!hit) return;
    held = button;
    last = hit;
    hooks.send(button, 'press', mods(e), hit);
  });

  // Moves are only sent while a button is held, and only when the cell changes.
  window.addEventListener('mousemove', (e) => {
    if (!held) return;
    const hit = hooks.hitTest(e.clientX, e.clientY);
    if (!hit || same(hit, last)) return;
    last = hit;
    hooks.send(held, 'drag', mods(e), hit);
  });

  window.addEventListener('mouseup', (e) => {
    if (!held) return;
    const hit = hooks.hitTest(e.clientX, e.clientY) ?? last;
    if (hit) hooks.send(held, 'release', mods(e), hit);
    held = null;
  });

  screen.addEventListener('contextmenu', (e) => e.preventDefault());

  // Accumulate pixel deltas; one wheel event per cell crossed.
  let accX = 0;
  let accY = 0;
  screen.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!hooks.enabled()) return;
      const { cw, ch } = hooks.cell();
      const scale = e.deltaMode === 1 ? ch : e.deltaMode === 2 ? ch * 20 : 1;
      accX += e.deltaX * scale;
      accY += e.deltaY * scale;
      const hit = hooks.hitTest(e.clientX, e.clientY);
      if (!hit) return;
      const m = mods(e);
      while (Math.abs(accY) >= ch) {
        hooks.send('wheel', accY > 0 ? 'down' : 'up', m, hit);
        accY -= Math.sign(accY) * ch;
      }
      while (Math.abs(accX) >= cw) {
        hooks.send('wheel', accX > 0 ? 'right' : 'left', m, hit);
        accX -= Math.sign(accX) * cw;
      }
    },
    { passive: false },
  );
}
