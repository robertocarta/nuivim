// The ordered list of tabs and which one is active. Pure: the view draws it.

export interface Tab {
  id: number;
  title: string;
}

export class Tabs {
  list: Tab[] = [];
  active = -1;
  private nextId = 1;

  add(title = ''): Tab {
    const tab = { id: this.nextId++, title };
    const at = this.list.findIndex((t) => t.id === this.active);
    this.list.splice(at + 1, 0, tab); // after the active tab, as browsers do
    this.active = tab.id;
    return tab;
  }

  /** Removes a tab; the tab to its right (else left) becomes active if it was. */
  remove(id: number): void {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.list.splice(i, 1);
    if (this.active === id) this.active = this.list[Math.min(i, this.list.length - 1)]?.id ?? -1;
  }

  select(id: number): void {
    if (this.list.some((t) => t.id === id)) this.active = id;
  }

  /** Cmd-1…Cmd-8 select by position; Cmd-9 selects the last tab, as in browsers. */
  selectNumber(n: number): void {
    const tab = n === 9 ? this.list.at(-1) : this.list[n - 1];
    if (tab) this.active = tab.id;
  }

  /** Next (+1) or previous (-1) tab, wrapping around. */
  cycle(step: number): void {
    const i = this.list.findIndex((t) => t.id === this.active);
    if (i < 0) return;
    this.active = this.list[(i + step + this.list.length) % this.list.length].id;
  }

  setTitle(id: number, title: string): void {
    const tab = this.list.find((t) => t.id === id);
    if (tab) tab.title = title;
  }
}

/** A tab's title: the current file's name, else the working directory's name. */
export function tabTitle(bufname: string, cwd: string): string {
  const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? '';
  return base(bufname) || (cwd ? base(cwd) || '/' : '') || '[No Name]';
}
