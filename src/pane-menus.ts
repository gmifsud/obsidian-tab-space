import { Menu, type MenuItem, WorkspaceLeaf, type EventRef } from 'obsidian';
import type TabSpacesPlugin from './main';
import type { DockEdge } from './leaf-sync';
import type { SpaceNode } from './types';
import { COMPLETED_PARENT_ID } from './types';

type LeafMenuWorkspace = {
	on(name: 'leaf-menu', callback: (menu: Menu, leaf: WorkspaceLeaf) => void): EventRef;
	on(name: 'tab-group-menu', callback: (menu: Menu, tabs: { children: WorkspaceLeaf[] }) => void): EventRef;
};

type ShownMenu = Menu & { workingTabsItems?: boolean };
type SubmenuItem = MenuItem & { setSubmenu?: () => Menu };

const SELECTED_HEADER = 'tab-multi-selected';

/** Dock, Send, and Return on the tab header, the tab stack, and a multi-selected set. */
export function installPaneMenus(plugin: TabSpacesPlugin): void {
	const workspace = plugin.app.workspace as unknown as LeafMenuWorkspace;
	plugin.registerEvent(
		workspace.on('leaf-menu', (menu, leaf) => {
			const tab = plugin.leafSync.findTabForLeaf(leaf);
			if (!tab) return;
			addSendItems(menu, plugin, [tab], { dockGroup: true, dockTab: true });
		})
	);
	plugin.registerEvent(
		workspace.on('tab-group-menu', (menu, tabs) => {
			const leaves = tabs.children.filter((child) => child instanceof WorkspaceLeaf);
			const group = leaves[0] ? plugin.leafSync.groupForLeaf(leaves[0]) : undefined;
			if (group) addDockEntries(menu, (edge) => void plugin.leafSync.dockGroup(group.id, edge));
			const records = leaves
				.map((leaf) => plugin.leafSync.findTabForLeaf(leaf))
				.filter((tab): tab is SpaceNode => Boolean(tab));
			if (records.length > 0) addPoolSubmenu(menu, 'Send all to pool', plugin, records);
		})
	);

	const proto = Menu.prototype as unknown as { showAtMouseEvent(this: Menu, evt: MouseEvent): void };
	// eslint-disable-next-line @typescript-eslint/unbound-method -- saved before the prototype is replaced
	const originalShow = proto.showAtMouseEvent;
	proto.showAtMouseEvent = function (this: Menu, evt: MouseEvent): void {
		if (evt?.target instanceof Element) {
			const header = evt.target.closest('.workspace-tab-header.' + SELECTED_HEADER);
			const shown = this as ShownMenu;
			if (header && !shown.workingTabsItems) {
				const records = leavesWithSelectedHeader(plugin)
					.map((leaf) => plugin.leafSync.findTabForLeaf(leaf))
					.filter((tab): tab is SpaceNode => Boolean(tab));
				if (records.length > 0) {
					shown.workingTabsItems = true;
					addSendItems(this, plugin, records, { dockGroup: records.length === 1, dockTab: true });
				}
			}
		}
		originalShow.call(this, evt);
	};
	plugin.register(() => {
		proto.showAtMouseEvent = originalShow;
	});
}

export function addDockEntries(menu: Menu, dock: (edge: DockEdge) => void): void {
	const items = [
		['Dock left', 'left', 'panel-left'],
		['Dock right', 'right', 'panel-right'],
		['Dock top', 'top', 'panel-top'],
		['Dock bottom', 'bottom', 'panel-bottom'],
	] as const;
	for (const [title, edge, icon] of items) {
		menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(() => dock(edge)));
	}
}

/** Sidebar tab menu and the native tab menu share this block. */
export function addSendItems(
	menu: Menu,
	plugin: TabSpacesPlugin,
	tabs: SpaceNode[],
	options: { dockGroup: boolean; dockTab: boolean }
): void {
	const many = tabs.length > 1;
	addPoolSubmenu(menu, many ? `Send ${tabs.length} tabs to pool` : 'Send to pool', plugin, tabs);
	addGroupSubmenu(menu, many ? `Send ${tabs.length} tabs to group` : 'Send to group', plugin, tabs);
	const returnable = tabs.filter((tab) => {
		const home = tab.originGroupId ? plugin.store.find(tab.originGroupId) : undefined;
		return home?.type === 'group';
	});
	if (returnable.length > 0) {
		const same = returnable.every((tab) => tab.originGroupId === returnable[0].originGroupId);
		const home = same ? plugin.store.find(returnable[0].originGroupId ?? '') : undefined;
		const title =
			returnable.length > 1 && !same ? 'Return each to its own group' : `Return to ${home?.title ?? 'origin'}`;
		menu.addItem((item) =>
			item.setTitle(title).setIcon('undo').onClick(() => void plugin.leafSync.restoreTabs(returnable))
		);
	}
	if (options.dockTab) {
		menu.addSeparator();
		const sub = addSubmenu(menu, many ? 'Dock selected together' : 'Dock this tab', 'panel-left');
		if (sub) addDockEntries(sub, (edge) => void plugin.leafSync.dockTabs(tabs, edge));
	}
	if (options.dockGroup && tabs.length === 1) {
		const leaf = plugin.leafSync.leafForTab(tabs[0]);
		const group = leaf ? plugin.leafSync.groupForLeaf(leaf) : undefined;
		if (group) {
			const sub = addSubmenu(menu, 'Dock group', 'layers');
			if (sub) addDockEntries(sub, (edge) => void plugin.leafSync.dockGroup(group.id, edge));
		}
	}
}

function addPoolSubmenu(menu: Menu, title: string, plugin: TabSpacesPlugin, tabs: SpaceNode[]): void {
	const sections = plugin.store.items.filter((node) => node.type === 'section');
	if (sections.length === 0) return;
	const sub = addSubmenu(menu, title, 'inbox');
	if (!sub) return;
	for (const section of sections) {
		sub.addItem((item) =>
			item.setTitle(section.title).onClick(() => void plugin.leafSync.sendToPool(tabs, section.id))
		);
	}
}

function addGroupSubmenu(menu: Menu, title: string, plugin: TabSpacesPlugin, tabs: SpaceNode[]): void {
	const groups = plugin.store.items.filter(
		(node) => node.type === 'group' && node.parentId !== COMPLETED_PARENT_ID
	);
	if (groups.length === 0) return;
	const sub = addSubmenu(menu, title, 'folder');
	if (!sub) return;
	for (const group of groups) {
		const already = tabs.every((tab) => tab.parentId === group.id);
		sub.addItem((item) =>
			item
				.setTitle(group.title)
				.setDisabled(already)
				.onClick(() => void plugin.leafSync.sendToGroup(tabs, group.id))
		);
	}
}

function addSubmenu(menu: Menu, title: string, icon: 'inbox' | 'folder' | 'panel-left' | 'layers'): Menu | null {
	let created: Menu | null = null;
	menu.addItem((item) => {
		item.setTitle(title).setIcon(icon);
		const opener = item as SubmenuItem;
		if (typeof opener.setSubmenu === 'function') created = opener.setSubmenu();
	});
	return created;
}

function leavesWithSelectedHeader(plugin: TabSpacesPlugin): WorkspaceLeaf[] {
	const leaves: WorkspaceLeaf[] = [];
	plugin.app.workspace.iterateAllLeaves((leaf) => {
		const header = (leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		if (header?.classList.contains(SELECTED_HEADER)) leaves.push(leaf);
	});
	return leaves;
}
