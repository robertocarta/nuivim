// The tab bar: one button per tab (title and close button) and a new-tab button.

import type { Tabs } from '../model/tabs';

export interface TabBarActions {
  select(id: number): void;
  close(id: number): void;
  add(): void;
}

export class TabBar {
  constructor(
    private readonly el: HTMLElement,
    actions: TabBarActions,
  ) {
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus in Neovim
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLElement>('[data-tab]');
      if (target.closest('.new-tab')) actions.add();
      else if (tab && target.closest('.close')) actions.close(Number(tab.dataset.tab));
      else if (tab) actions.select(Number(tab.dataset.tab));
    });
    el.addEventListener('auxclick', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (e.button === 1 && tab) actions.close(Number(tab.dataset.tab));
    });
  }

  render(tabs: Tabs, hidden: boolean): void {
    this.el.hidden = hidden;
    this.el.replaceChildren(
      ...tabs.list.map((t) => {
        const b = document.createElement('div');
        b.className = 'tab' + (t.id === tabs.active ? ' active' : '');
        b.dataset.tab = String(t.id);
        b.title = t.title;
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = t.title || 'NuiVim';
        const close = document.createElement('span');
        close.className = 'close';
        close.textContent = '×';
        close.title = 'Close tab (⌘W)';
        b.append(label, close);
        return b;
      }),
      Object.assign(document.createElement('div'), { className: 'new-tab', textContent: '+', title: 'New tab (⌘T)' }),
    );
  }
}
