import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type TabSpacesPlugin from '../main';
import type { TabSpacesStore } from '../store';
import type { SpaceNode, OpenBehavior, ColorSlot } from '../types';
import { VIEW_TYPE_WORKING_TABS, COMPLETED_PARENT_ID, COLOR_SLOTS, COLOR_LABELS } from '../types';
import { ConfirmCompleteModal } from '../modals/ConfirmCompleteModal';
import { GroupDescriptionModal } from '../modals/GroupDescriptionModal';
import { TabPreviewModal } from '../modals/TabPreviewModal';
import { addSendItems } from '../pane-menus';

/** A real swatch beside each colour name in the menu -- Obsidian's MenuItem
 * takes a DocumentFragment for its title, which is the only way to get colour
 * into a menu without an icon font full of pre-tinted dots. */
function colorMenuTitle(slot: ColorSlot): DocumentFragment {
	const frag = createFragment();
	const swatch = frag.createSpan({ cls: 'working-tabs-swatch' });
	swatch.style.setProperty('--working-tabs-accent', `var(--working-tabs-color-${slot})`);
	frag.createSpan({ text: COLOR_LABELS[slot] });
	return frag;
}

type DropPosition = 'before' | 'after' | 'into';

/** True for a real text field. Checkbox/radio stay out so a focused row checkbox doesn't swallow Backspace. */
function isTextField(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.closest('[contenteditable="true"]')) return true;
	if (target.tagName === 'TEXTAREA') return true;
	if (target.tagName !== 'INPUT') return false;
	const type = (target as HTMLInputElement).type;
	return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'file' && type !== 'hidden' && type !== 'range';
}

const PLACEMENT_MENU: Array<{ label: string; behavior: OpenBehavior }> = [
	{ label: 'Split right', behavior: { mode: 'split', direction: 'vertical' } },
	{ label: 'Split down', behavior: { mode: 'split', direction: 'horizontal' } },
	{ label: 'Open in new window', behavior: { mode: 'window' } },
];

export class TabSpacesView extends ItemView {
	private store: TabSpacesStore;
	private treeEl!: HTMLElement;
	private draggedId: string | null = null;
	private dropMarkedEl: HTMLElement | null = null;
	private viewportDropEl: HTMLElement | null = null;
	private viewportDropZone: string | null = null;
	/** The dragged row is the drag image. Rebuilding the tree mid-drag detaches it and Chromium throws `null.clone` on every dragover. */
	private renderAfterDrag = false;
	private unsubscribe: (() => void) | null = null;
	private visibleOrder: string[] = [];
	private focusedId: string | null = null;
	/** Ctrl-click selection. A later Send applies to every id in here. */
	private selectedTabIds = new Set<string>();
	/** While set, store-driven re-renders are deferred so the inline rename input isn't destroyed mid-edit. */
	private renamingId: string | null = null;
	private completedCollapsed = true;
	private searchInputEl!: HTMLInputElement;
	private searchQuery = '';

	constructor(leaf: WorkspaceLeaf, private plugin: TabSpacesPlugin) {
		super(leaf);
		this.store = plugin.store;
	}

	getViewType(): string {
		return VIEW_TYPE_WORKING_TABS;
	}

	getDisplayText(): string {
		return 'Working tabs';
	}

	getIcon(): string {
		return 'layout-panel-left';
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('working-tabs-view');

		// Search is the only piece of chrome left above the tree -- both
		// "create" actions live in the tree itself now, next to the rows they
		// produce -- so it's always visible rather than behind a toggle.
		this.searchInputEl = container.createEl('input', {
			cls: 'working-tabs-search-input',
			attr: { type: 'text', placeholder: 'Search tabs and groups…' },
		});
		this.searchInputEl.addEventListener('input', () => {
			this.searchQuery = this.searchInputEl.value;
			this.render();
		});
		this.searchInputEl.addEventListener('keydown', (evt) => {
			if (evt.key !== 'Escape') return;
			evt.stopPropagation();
			evt.preventDefault();
			this.clearSearch();
		});

		// Not focusable. A tabindex here becomes the keyboard target, and Backspace
		// then deletes the selected row instead of editing the note or a field.
		this.treeEl = container.createDiv({ cls: 'working-tabs-tree' });
		this.registerRootDropZone(this.treeEl);
		this.registerViewportDrop();

		this.unsubscribe = this.store.onChange(() => {
			if (this.renamingId) return;
			if (this.draggedId) {
				this.renderAfterDrag = true;
				return;
			}
			this.render();
		});
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const tab = leaf && this.plugin.leafSync.findTabForLeaf(leaf);
				if (tab) void this.revealNode(tab);
			})
		);
		this.render();
	}

	/** Highlight the active tab's row. A collapsed group stays collapsed — the
	 * active leaf used to expand it again, so a group that contained the open
	 * tab (or two copies of it) could never stay closed. */
	private async revealNode(node: SpaceNode): Promise<void> {
		this.highlightRow(node.id);
	}

	private clearSearch(): void {
		if (!this.searchQuery) return;
		this.searchInputEl.value = '';
		this.searchQuery = '';
		this.render();
	}

	/** A tab matches on its own title or file path; a group/section matches
	 * on its own title or if any descendant matches, so a search surfaces the
	 * container a hit lives in too. */
	private matchesQuery(node: SpaceNode, query: string): boolean {
		if (node.title.toLowerCase().includes(query)) return true;
		if (node.type === 'tab') return (node.filePath ?? '').toLowerCase().includes(query);
		return this.store.children(node.id).some((child) => this.matchesQuery(child, query));
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
	}

	// ── Rendering ────────────────────────────────────────────

	private render(): void {
		if (this.draggedId) {
			this.renderAfterDrag = true;
			return;
		}
		// Rebuilding the tree drops its scroll offset. A click lower down, on a
		// hibernating group, would otherwise jump back to the on-screen group.
		// The scroller may be the tree or an Obsidian ancestor, depending on
		// which one currently overflows.
		const scroller = this.scrollOwner();
		const scrollTop = scroller.scrollTop;
		this.contentEl.toggleClass('working-tabs-wrap-titles', this.store.settings.titleOverflow === 'wrap');
		this.treeEl.empty();
		this.visibleOrder = [];
		const query = this.searchQuery.trim().toLowerCase();

		const roots = this.store.children(null).filter((n) => !query || this.matchesQuery(n, query));
		if (roots.length === 0) {
			this.treeEl.createDiv({
				cls: 'working-tabs-empty',
				text: query
					? 'No matches.'
					: 'No groups yet -- open some tabs to create one automatically.',
			});
		}
		// Three clusters, never mixed: groups whose pane is on screen, groups that
		// are hibernating, then sections. Order inside a cluster is still the
		// stored order. A focused section renders first among sections.
		const focusedSectionId = this.store.focusedSectionId;
		const rootGroups = roots.filter((node) => node.type === 'group');
		const onScreen = rootGroups.filter((group) => this.plugin.leafSync.isRendered(group.id));
		const hibernating = rootGroups.filter((group) => !this.plugin.leafSync.isRendered(group.id));
		const sections = roots.filter((node) => node.type === 'section');
		const orderedSections = focusedSectionId
			? [
					...sections.filter((node) => node.id === focusedSectionId),
					...sections.filter((node) => node.id !== focusedSectionId),
				]
			: sections;

		this.renderCluster('On screen', 'onscreen', onScreen, query ? undefined : (parent) => this.renderNewGroupRow(parent));
		this.renderCluster('Hibernating', 'hibernating', hibernating);
		this.renderCluster(
			'Sections',
			'sections',
			orderedSections,
			query ? undefined : (parent) => this.renderCreateSectionRow(parent)
		);

		this.treeEl.createDiv({ cls: 'working-tabs-divider' });

		this.renderSyntheticSection(
			'Completed',
			COMPLETED_PARENT_ID,
			this.completedCollapsed,
			(v) => (this.completedCollapsed = v),
			query
		);
		if (this.focusedId) this.showWhetherOnScreen(this.focusedId);
		scroller.scrollTop = scrollTop;
	}

	/** The element that is actually scrolled. The tree is the intended one; an ancestor wins if that is where the offset lives. */
	private scrollOwner(): HTMLElement {
		let el: HTMLElement | null = this.treeEl;
		while (el) {
			const overflow = getComputedStyle(el).overflowY;
			if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && el.scrollHeight > el.clientHeight + 1) {
				return el;
			}
			el = el.parentElement;
		}
		return this.treeEl;
	}

	private renderCluster(
		title: string,
		kind: 'onscreen' | 'hibernating' | 'sections',
		nodes: SpaceNode[],
		extra?: (parent: HTMLElement) => void
	): void {
		if (nodes.length === 0 && !extra) return;
		const cluster = this.treeEl.createDiv({ cls: `working-tabs-cluster is-${kind}` });
		const label = cluster.createDiv({ cls: 'working-tabs-cluster-label' });
		label.createSpan({ cls: 'working-tabs-cluster-name', text: title });
		label.createSpan({ cls: 'working-tabs-count', text: String(nodes.length) });
		const query = this.searchQuery.trim().toLowerCase();
		for (const node of nodes) this.renderNode(cluster, node, 0, false, query);
		extra?.(cluster);
	}

	private renderNode(parentEl: HTMLElement, node: SpaceNode, depth: number, isCompleted: boolean, query: string): void {
		if (node.type === 'section') this.renderSection(parentEl, node, depth, query);
		else if (node.type === 'group') this.renderGroup(parentEl, node, depth, isCompleted, query);
		else this.renderTab(parentEl, node, depth);
	}

	private renderRowShell(parentEl: HTMLElement, node: SpaceNode, depth: number, extraCls = ''): HTMLElement {
		const row = parentEl.createDiv({
			cls: `working-tabs-row ${extraCls}`.trim(),
			attr: { 'data-node-id': node.id, style: `padding-left: ${8 + depth * 16}px`, draggable: 'true' },
		});
		this.wireDrag(row, node);

		// The group colour is the tab colour: a sidebar row and the pane tabs read
		// the same slot. A tab has no colour of its own, so it uses its group
		// (or its section, when it is parked in a pool).
		const accent = this.store.accentCss(node);
		if (accent) {
			row.addClass('working-tabs-colored');
			row.style.setProperty('--working-tabs-accent', accent);
		}

		this.visibleOrder.push(node.id);
		if (node.id === this.focusedId) row.addClass('is-focused');
		row.addEventListener('mousedown', (evt) => {
			if (evt.button !== 0 || isTextField(evt.target)) return;
			if ((evt.ctrlKey || evt.metaKey) && node.type === 'tab') {
				if (this.selectedTabIds.has(node.id)) {
					this.selectedTabIds.delete(node.id);
					row.removeClass('is-picked');
				} else {
					this.selectedTabIds.add(node.id);
					row.addClass('is-picked');
				}
				return;
			}
			if (this.selectedTabIds.size > 0) {
				this.selectedTabIds.clear();
				this.treeEl.querySelectorAll<HTMLElement>('.is-picked').forEach((picked) => picked.removeClass('is-picked'));
			}
			this.highlightRow(node.id);
		});
		return row;
	}

	private renderSection(parentEl: HTMLElement, node: SpaceNode, depth: number, query: string): void {
		const focused = this.store.focusedSectionId === node.id;
		const somethingFocused = Boolean(this.store.focusedSectionId);
		const wrapper = parentEl.createDiv({ cls: 'working-tabs-section' });
		const row = this.renderRowShell(
			wrapper,
			node,
			depth,
			`working-tabs-section-header${node.hidden ? ' is-hidden-pane' : ''}${focused ? ' is-focused-section' : ''}`
		);

		// Force-expanded during a search / while focused. Other sections render
		// collapsed while something is focused (stored collapsed flags untouched).
		const expanded = query ? true : focused ? true : somethingFocused ? false : !node.collapsed;
		const chevron = row.createDiv({ cls: 'working-tabs-chevron' });
		setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');

		const textCol = row.createDiv({ cls: 'working-tabs-text-col' });
		const title = textCol.createSpan({ cls: 'working-tabs-title' });
		title.setText(node.title);
		this.wireRename(title, node);
		if (focused) textCol.createSpan({ cls: 'working-tabs-focus-badge', text: 'focused' });
		if (node.description) {
			textCol.createDiv({ cls: 'working-tabs-description', text: node.description });
		}

		const actions = row.createDiv({ cls: 'working-tabs-row-actions' });
		this.makeGroupActionButton(actions, 'ellipsis-vertical', 'More', (evt) => {
			evt.stopPropagation();
			this.showSectionMenu(node, evt);
		});

		this.wireRowClick(row, () => {
			if (!query) void this.store.setCollapsed(node.id, expanded);
		});
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.showSectionMenu(node, evt);
		});

		if (expanded) {
			const childWrap = wrapper.createDiv({ cls: 'working-tabs-children' });
			const children = this.store.children(node.id).filter((c) => !query || this.matchesQuery(c, query));
			const pooled = children.filter((child) => child.type === 'tab');
			this.renderPool(childWrap, node, pooled, query);
			for (const child of children) {
				if (child.type !== 'tab') this.renderNode(childWrap, child, depth + 1, false, query);
			}
		}
	}

	private renderPool(parentEl: HTMLElement, section: SpaceNode, tabs: SpaceNode[], query: string): void {
		if (query && tabs.length === 0) return;
		const pool = parentEl.createDiv({ cls: 'working-tabs-pool' });
		pool.createDiv({ cls: 'working-tabs-pool-label', text: 'Pool' });
		if (tabs.length === 0) {
			pool.createDiv({ cls: 'working-tabs-pool-empty', text: 'Send tabs here. They stay open.' });
		}
		for (const tab of tabs) this.renderNode(pool, tab, 1, false, query);
		pool.addEventListener('dragover', (evt) => {
			const dragged = this.draggedId ? this.store.find(this.draggedId) : undefined;
			if (dragged?.type !== 'tab') return;
			evt.preventDefault();
			pool.addClass('is-drop');
		});
		pool.addEventListener('dragleave', () => pool.removeClass('is-drop'));
		pool.addEventListener('drop', (evt) => {
			pool.removeClass('is-drop');
			const dragged = this.draggedId ? this.store.find(this.draggedId) : undefined;
			if (dragged?.type !== 'tab') return;
			evt.preventDefault();
			evt.stopPropagation();
			const tabsToSend =
				this.selectedTabIds.has(dragged.id) && this.selectedTabIds.size > 1
					? this.selectedTabs()
					: [dragged];
			void this.plugin.leafSync.sendToPool(tabsToSend, section.id);
		});
	}

	private isLive(node: SpaceNode): boolean {
		return this.plugin.leafSync.isLive(node.id);
	}

	private selectedTabs(): SpaceNode[] {
		const tabs: SpaceNode[] = [];
		for (const id of this.selectedTabIds) {
			const node = this.store.find(id);
			if (node?.type === 'tab') tabs.push(node);
		}
		return tabs;
	}

	private renderGroup(parentEl: HTMLElement, node: SpaceNode, depth: number, isCompleted: boolean, query: string): void {
		const wrapper = parentEl.createDiv({ cls: 'working-tabs-group' });
		const live = !isCompleted && this.isLive(node);
		const row = this.renderRowShell(
			wrapper,
			node,
			depth,
			`working-tabs-group-header${live ? ' is-live' : ''}${node.hidden ? ' is-hidden-pane' : ''}`
		);

		// Force-expanded during a search to reveal the match inside -- collapsed
		// state underneath is untouched and resumes once the search is cleared.
		const expanded = query ? true : !node.collapsed;
		const chevron = row.createDiv({ cls: 'working-tabs-chevron' });
		setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
		chevron.addEventListener('click', (evt) => {
			evt.stopPropagation();
			evt.preventDefault();
			if (!query) void this.store.setCollapsed(node.id, expanded);
		});

		const textCol = row.createDiv({ cls: 'working-tabs-text-col' });
		const titleRow = textCol.createDiv({ cls: 'working-tabs-title-row' });
		const title = titleRow.createSpan({ cls: 'working-tabs-title' });
		title.setText(node.title);
		this.wireRename(title, node);
		const tabCount = this.store.children(node.id).length;
		titleRow.createSpan({ cls: 'working-tabs-count', text: String(tabCount) });
		if (live) titleRow.createSpan({ cls: 'working-tabs-live-chip', text: 'on screen' });
		titleRow.createSpan({ cls: 'working-tabs-screen-state' });
		if (node.description) {
			textCol.createDiv({ cls: 'working-tabs-description', text: node.description });
		}

		const actions = row.createDiv({ cls: 'working-tabs-row-actions' });
		if (isCompleted) {
			this.makeGroupActionButton(actions, 'rotate-ccw', 'Restore', (evt) => {
				evt.stopPropagation();
				void this.store.restore(node.id);
			});
		} else if (live) {
			this.makeGroupActionButton(actions, 'eye-off', 'Hide', (evt) => {
				evt.stopPropagation();
				void this.plugin.leafSync.hideGroup(node.id);
			});
		} else {
			this.makeGroupActionButton(actions, 'eye', 'Show', (evt) => {
				evt.stopPropagation();
				void this.plugin.leafSync.showGroup(node.id);
			});
		}
		this.makeGroupActionButton(actions, 'ellipsis-vertical', 'More', (evt) => {
			evt.stopPropagation();
			this.showGroupMenu(node, evt, isCompleted);
		});

		this.wireRowClick(row, (evt) => {
			if (query) return;
			if (evt.target instanceof Element && evt.target.closest('.working-tabs-chevron, .working-tabs-row-actions')) return;
			void this.store.setCollapsed(node.id, expanded);
		});
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.showGroupMenu(node, evt, isCompleted);
		});

		if (expanded) {
			const childWrap = wrapper.createDiv({ cls: 'working-tabs-children' });
			const children = this.store.children(node.id).filter((c) => !query || this.matchesQuery(c, query));
			for (const child of children) this.renderNode(childWrap, child, depth + 1, isCompleted, query);
		}
	}

	private makeGroupActionButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void
	): void {
		const btn = parent.createDiv({ cls: 'working-tabs-action-btn', attr: { 'aria-label': label } });
		setIcon(btn, icon);
		setTooltip(btn, label, { placement: 'top' });
		btn.addEventListener('click', onClick);
	}

	private renderTab(parentEl: HTMLElement, node: SpaceNode, depth: number): void {
		const row = this.renderRowShell(
			parentEl,
			node,
			depth,
			`working-tabs-tab-row${this.selectedTabIds.has(node.id) ? ' is-picked' : ''}`
		);

		const checkbox = row.createEl('input', {
			cls: 'working-tabs-done-checkbox',
			attr: { type: 'checkbox' },
		});
		checkbox.checked = Boolean(node.done);
		checkbox.addEventListener('click', (evt) => evt.stopPropagation());
		checkbox.addEventListener('change', () => void this.handleToggleDone(node));

		const title = row.createSpan({ cls: `working-tabs-title${node.done ? ' is-done' : ''}` });
		title.setText(node.title);
		const parent = node.parentId ? this.store.find(node.parentId) : undefined;
		if (parent?.type === 'section' && node.originGroupId) {
			const home = this.store.find(node.originGroupId);
			if (home) row.createSpan({ cls: 'working-tabs-origin', text: `returns to ${home.title}` });
		}

		const actions = row.createDiv({ cls: 'working-tabs-row-actions' });
		this.makeGroupActionButton(actions, 'x', 'Close tab', (evt) => {
			evt.stopPropagation();
			void this.plugin.leafSync.closeTab(node);
		});

		let pendingReveal: number | null = null;
		row.addEventListener('click', (evt) => {
			if (evt.ctrlKey || evt.metaKey) return;
			if (evt.target instanceof Element && evt.target.closest('.working-tabs-done-checkbox, .working-tabs-row-actions')) return;
			if (evt.detail > 1) {
				if (pendingReveal !== null) window.clearTimeout(pendingReveal);
				pendingReveal = null;
				return;
			}
			if (pendingReveal !== null) window.clearTimeout(pendingReveal);
			pendingReveal = window.setTimeout(() => {
				pendingReveal = null;
				void this.plugin.leafSync.revealOpenTab(node);
			}, 200);
		});
		row.addEventListener('dblclick', (evt) => {
			if (evt.target instanceof Element && evt.target.closest('.working-tabs-done-checkbox, .working-tabs-row-actions')) return;
			evt.preventDefault();
			evt.stopPropagation();
			new TabPreviewModal(this.app, {
				title: node.title,
				filePath: node.filePath,
				viewState: node.viewState,
			}).open();
		});
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			const tabs =
				this.selectedTabIds.has(node.id) && this.selectedTabIds.size > 1 ? this.selectedTabs() : [node];
			this.showTabMenu(tabs, evt);
		});
	}

	/** A group is never created directly -- it's just whatever reconcile
	 * finds occupying a pane it doesn't already know about (see
	 * doReconcile's step 4 and LeafSync.openNewGroup) -- so this row doesn't
	 * create a group record either. It only opens a blank pane per the
	 * chosen placement and lets that same auto-detection name it. */
	private renderNewGroupRow(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'working-tabs-row working-tabs-new-group-row' });
		const icon = row.createDiv({ cls: 'working-tabs-chevron' });
		setIcon(icon, 'plus');
		row.createSpan({ cls: 'working-tabs-title', text: 'New group' });
		row.addEventListener('click', (evt) => {
			const menu = new Menu();
			for (const { label, behavior } of PLACEMENT_MENU) {
				menu.addItem((item) => item.setTitle(label).onClick(() => void this.plugin.leafSync.openNewGroup(behavior)));
			}
			menu.showAtMouseEvent(evt);
		});
	}

	/** Heads the sections block, paired with "New group" above it. The info
	 * icon is the only explanation of what a section is *for*, so it rides
	 * along on the row (revealed on hover) rather than staying in the chrome. */
	private renderCreateSectionRow(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'working-tabs-row working-tabs-create-section-row' });
		const icon = row.createDiv({ cls: 'working-tabs-chevron' });
		setIcon(icon, 'plus');
		row.createSpan({ cls: 'working-tabs-title', text: 'Create a section' });
		const info = row.createSpan({ cls: 'working-tabs-info-icon' });
		setIcon(info, 'info');
		setTooltip(
			info,
			'Organize related groups together, e.g. by sprint or timeframe. Hide a section to tuck away every group inside it at once.',
			{ placement: 'top' }
		);
		row.addEventListener('click', () => void this.createSection());
	}

	// ── Synthetic Completed section ──────────────────────────

	private renderSyntheticSection(
		title: string,
		sentinelId: string,
		collapsed: boolean,
		setCollapsed: (v: boolean) => void,
		query: string
	): void {
		const wrapper = this.treeEl.createDiv({ cls: 'working-tabs-section working-tabs-synthetic-section' });
		const row = wrapper.createDiv({ cls: 'working-tabs-row working-tabs-section-header' });

		const expanded = query ? true : !collapsed;
		const chevron = row.createDiv({ cls: 'working-tabs-chevron' });
		setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');

		const titleEl = row.createSpan({ cls: 'working-tabs-title working-tabs-synthetic-title' });
		titleEl.setText(title);

		const allChildren = this.store.children(sentinelId);
		const children = allChildren.filter((c) => !query || this.matchesQuery(c, query));
		row.createSpan({ cls: 'working-tabs-count', text: String(query ? children.length : allChildren.length) });

		row.addEventListener('click', () => {
			if (query) return;
			setCollapsed(!collapsed);
			this.render();
		});

		this.registerSentinelDropZone(row, sentinelId);

		if (expanded) {
			const childWrap = wrapper.createDiv({ cls: 'working-tabs-children' });
			const isCompletedSection = sentinelId === COMPLETED_PARENT_ID;
			for (const child of children) this.renderNode(childWrap, child, 1, isCompletedSection, query);
		}
	}

	// ── Complete / restore ──────────────────────────────────

	/** Marking a tab done closes its live view (it disappears, same as the
	 * tab itself closing); unchecking it reopens that view in its group's
	 * pane. Checking off the last remaining tab in a group finishes the group
	 * too -- no extra confirm dialog, since checking every box one by one is
	 * already a deliberate multi-step action. */
	private async handleToggleDone(tab: SpaceNode): Promise<void> {
		await this.store.toggleDone(tab.id);
		if (tab.done) {
			await this.plugin.leafSync.closeLiveTabOnly(tab);
		} else {
			await this.plugin.leafSync.reopenTab(tab);
		}
		if (!tab.parentId) return;
		const group = this.store.find(tab.parentId);
		if (!group || group.type !== 'group' || group.parentId === COMPLETED_PARENT_ID) return;
		const siblings = this.store.children(group.id);
		if (siblings.length > 0 && siblings.every((s) => s.done)) {
			await this.plugin.leafSync.completeGroup(group.id);
		}
	}

	private requestComplete(node: SpaceNode): void {
		if (!this.store.settings.confirmBeforeComplete) {
			void this.plugin.leafSync.completeGroup(node.id);
			return;
		}
		new ConfirmCompleteModal(this.app, node.title, (dontAskAgain) => {
			if (dontAskAgain) void this.store.updateSettings({ confirmBeforeComplete: false });
			void this.plugin.leafSync.completeGroup(node.id);
		}).open();
	}

	/** Deleting a live group/tab record alone doesn't close its actual pane --
	 * the leaf stays open, unclaimed, and the very next reconcile pass just
	 * spins up a brand-new group for it, making the deleted row "reappear".
	 * Detaching the live leaf(s) first, same as Close group/Close tab, avoids
	 * that entirely. Sections have no live pane of their own, so this is a
	 * no-op for them beyond the plain removal. */
	private async deleteNode(node: SpaceNode): Promise<void> {
		if (node.type === 'tab') {
			// closeTab also removes the group itself if this was its last tab.
			await this.plugin.leafSync.closeTab(node);
			return;
		}
		if (node.type === 'group') await this.plugin.leafSync.closeGroup(node.id);
		await this.store.remove(node.id);
	}

	// ── Keyboard navigation ──────────────────────────────────

	/** Highlight only. No layout read, so it cannot force a reflow under the caret. */
	private highlightRow(id: string): void {
		const prevId = this.focusedId;
		this.focusedId = id;
		if (prevId && prevId !== id) {
			this.treeEl.querySelector<HTMLElement>(`[data-node-id="${prevId}"]`)?.removeClass('is-focused');
		}
		this.treeEl.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.addClass('is-focused');
	}

	/** On the selected group, say if its pane is actually visible, and outline that pane. */
	private showWhetherOnScreen(id: string | null): void {
		const labels = this.treeEl.querySelectorAll('.working-tabs-screen-state');
		for (let i = 0; i < labels.length; i++) {
			const label = labels[i] as HTMLElement;
			label.setText('');
			label.removeAttribute('data-state');
		}
		const node = id ? this.store.find(id) : undefined;
		if (!node || node.type !== 'group') {
			this.plugin.leafSync.markSelectedPane(null);
			return;
		}
		const onScreen = this.plugin.leafSync.isRendered(node.id);
		const label = this.treeEl.querySelector<HTMLElement>(
			`[data-node-id="${node.id}"] .working-tabs-screen-state`
		);
		if (label) {
			label.setText(onScreen ? 'on screen' : 'not on screen');
			label.setAttribute('data-state', onScreen ? 'on' : 'off');
		}
		this.plugin.leafSync.markSelectedPane(onScreen ? node.id : null);
	}

	/** A second click in a double-click is the rename, so it does not also toggle. */
	/** Wait briefly so a double-click can rename instead of also collapsing. */
	private wireRowClick(row: HTMLElement, action: (evt: MouseEvent) => void): void {
		let pending: number | null = null;
		row.addEventListener('click', (evt) => {
			if (evt.detail > 1) {
				if (pending !== null) window.clearTimeout(pending);
				pending = null;
				return;
			}
			if (pending !== null) window.clearTimeout(pending);
			pending = window.setTimeout(() => {
				pending = null;
				action(evt);
			}, 200);
		});
	}

	// ── Inline rename ────────────────────────────────────────

	private wireRename(title: HTMLElement, node: SpaceNode): void {
		title.addEventListener('dblclick', (evt) => {
			evt.stopPropagation();
			this.startRename(title, node);
		});
	}

	private startRename(title: HTMLElement, node: SpaceNode): void {
		if (this.renamingId) return;
		this.renamingId = node.id;

		const parent = title.parentElement as HTMLElement;
		const input = parent.createEl('input', { cls: 'working-tabs-rename-input' });
		input.type = 'text';
		input.value = node.title;
		parent.insertBefore(input, title);
		title.remove();
		input.focus();
		input.select();

		const finish = async (commit: boolean) => {
			if (this.renamingId !== node.id) return;
			input.removeEventListener('blur', onBlur);
			input.removeEventListener('keydown', onKeydown);
			this.renamingId = null;
			const value = input.value.trim();
			if (commit && value && value !== node.title) {
				await this.store.rename(node.id, value);
			} else {
				input.replaceWith(title);
				// Catch up on any store changes deferred while the input was open.
				this.render();
			}
		};
		const onBlur = () => void finish(true);
		const onKeydown = (evt: KeyboardEvent) => {
			if (evt.key !== 'Enter' && evt.key !== 'Escape') return;
			evt.stopPropagation();
			evt.preventDefault();
			void finish(evt.key === 'Enter');
		};
		input.addEventListener('blur', onBlur);
		input.addEventListener('keydown', onKeydown);
	}

	// ── Create ───────────────────────────────────────────────

	/** No naming modal -- creates instantly with a placeholder title and drops
	 * straight into inline rename, since typing a name up front is more
	 * friction than the action deserves. Rename (or add a description) later
	 * from the row itself if the default doesn't stick. */
	private async createSection(): Promise<void> {
		const section = await this.store.addSection(this.store.nextDefaultTitle('section'));
		const titleEl = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${section.id}"] .working-tabs-title`);
		if (titleEl) this.startRename(titleEl, section);
	}

	// ── Context menus ────────────────────────────────────────

	/**
	 * Opened from the "Colour" item on a group or section menu. A second Menu
	 * rather than a submenu: `MenuItem.setSubmenu` isn't in the public API for
	 * the versions this plugin supports, and reaching past the typings for a
	 * nested menu isn't worth it when reopening at the same point costs one
	 * click and can't break.
	 */
	private showColorMenu(node: SpaceNode, evt: MouseEvent): void {
		const menu = new Menu();
		// Forced onto Obsidian's own DOM menu. Desktop defaults to letting the
		// OS draw menus, and a native menu item can only carry plain text -- the
		// swatch element in each title is silently dropped, leaving a list of
		// colour names with no colour in it. This is the one menu in the plugin
		// whose whole point is the rendering, so it opts out; every other menu
		// is left native and matches the rest of the app. No-op on mobile, where
		// menus are always DOM anyway.
		menu.setUseNativeMenu(false);
		const parent = node.parentId ? this.store.find(node.parentId) : undefined;
		const inSection = node.type === 'group' && parent?.type === 'section';

		for (const slot of COLOR_SLOTS) {
			menu.addItem((item) =>
				item
					.setTitle(colorMenuTitle(slot))
					.setChecked(node.color === slot)
					.onClick(() => void this.store.setColor(node.id, slot))
			);
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				// Wording follows what clearing actually falls back to, since
				// "Automatic" would be a lie for a group that's about to start
				// tracking its section instead.
				.setTitle(inSection ? 'Use section colour' : 'Automatic')
				.setIcon('rotate-ccw')
				.setChecked(!node.color)
				.onClick(() => void this.store.setColor(node.id, undefined))
		);
		menu.addItem((item) =>
			item
				.setTitle('No colour')
				.setIcon('ban')
				.setChecked(node.color === 'none')
				.onClick(() => void this.store.setColor(node.id, 'none'))
		);

		if (node.type === 'section' && this.store.children(node.id).some((child) => child.color)) {
			menu.addItem((item) =>
				item
					.setTitle('Reset group colours')
					.setIcon('paintbrush')
					.onClick(() => void this.store.clearChildColors(node.id))
			);
		}

		menu.showAtMouseEvent(evt);
	}

	private showSectionMenu(node: SpaceNode, evt: MouseEvent): void {
		const menu = new Menu();
		const focused = this.store.focusedSectionId === node.id;
		menu.addItem((item) =>
			item.setTitle(focused ? 'Unfocus' : 'Focus').setIcon('crosshair').onClick(() => {
				if (focused) void this.store.setFocusedSection(null);
				else void this.plugin.leafSync.revealSection(node.id);
			})
		);
		menu.addItem((item) =>
			item.setTitle('Close all').setIcon('x').onClick(() => {
				for (const child of this.store.children(node.id)) {
					if (child.type === 'group' && this.plugin.leafSync.isLive(child.id)) {
						void this.plugin.leafSync.closeGroup(child.id);
					}
				}
			})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Rename').setIcon('pencil').onClick(() => {
				const titleEl = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"] .working-tabs-title`);
				if (titleEl) this.startRename(titleEl, node);
			})
		);
		menu.addItem((item) =>
			item.setTitle('Edit description').setIcon('align-left').onClick(() => {
				new GroupDescriptionModal(
					this.app,
					'Section description',
					'What this section is for…',
					node.description ?? '',
					(description) => {
						void this.store.setDescription(node.id, description || undefined);
					}
				).open();
			})
		);
		// Hidden while colour coding is switched off globally -- a picker whose
		// every choice is invisible is worse than no picker.
		if (this.store.settings.colorCoding) {
			menu.addItem((item) =>
				item.setTitle('Colour').setIcon('palette').onClick(() => this.showColorMenu(node, evt))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Delete section').setIcon('trash').onClick(() => {
				if (this.store.children(node.id).length > 0) {
					new Notice("Move or complete this section's groups first.");
					return;
				}
				void this.store.remove(node.id);
			})
		);
		menu.showAtMouseEvent(evt);
	}

	/** Files the whole group under a section. Its tabs stay in the group. */
	private addSendGroupToSection(menu: Menu, group: SpaceNode): void {
		const sections = this.store.items.filter((node) => node.type === 'section');
		if (sections.length === 0) return;
		let submenu: Menu | null = null;
		menu.addItem((item) => {
			item.setTitle('Send to section').setIcon('folder');
			const opener = item as { setSubmenu?: () => Menu };
			if (typeof opener.setSubmenu === 'function') submenu = opener.setSubmenu();
		});
		if (!submenu) return;
		const sectionMenu: Menu = submenu;
		for (const section of sections) {
			sectionMenu.addItem((item) =>
				item
					.setTitle(section.title)
					.setDisabled(group.parentId === section.id)
					.onClick(() => {
						const index = this.store.children(section.id).filter((child) => child.id !== group.id).length;
						void this.store.moveInto(group.id, section.id, index);
					})
			);
		}
		const parent = group.parentId ? this.store.find(group.parentId) : undefined;
		if (parent?.type !== 'section') return;
		sectionMenu.addSeparator();
		sectionMenu.addItem((item) =>
			item.setTitle('Remove from section').onClick(() => {
				const index = this.store.children(null).filter((child) => child.id !== group.id).length;
				void this.store.moveInto(group.id, null, index);
			})
		);
	}

	private addDockItems(menu: Menu, dock: (edge: 'left' | 'right' | 'top' | 'bottom') => void): void {
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

	private showGroupMenu(node: SpaceNode, evt: MouseEvent, isCompleted: boolean): void {
		const menu = new Menu();
		if (!isCompleted) {
			if (this.plugin.leafSync.isRendered(node.id)) {
				menu.addItem((item) =>
					item.setTitle('Hide').setIcon('eye-off').onClick(() => void this.plugin.leafSync.hideGroup(node.id))
				);
			} else {
				menu.addItem((item) =>
					item.setTitle('Show').setIcon('eye').onClick(() => void this.plugin.leafSync.showGroup(node.id))
				);
			}
			this.addSendGroupToSection(menu, node);
			this.addDockItems(menu, (edge) => void this.plugin.leafSync.dockGroup(node.id, edge));
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle('New tab').setIcon('plus').onClick(() => void this.plugin.leafSync.addBlankTab(node.id))
			);
			if (this.plugin.leafSync.isLive(node.id)) {
				const stacked = this.plugin.leafSync.isStacked(node.id);
				menu.addItem((item) =>
					item
						.setTitle(stacked ? 'Unstack tabs' : 'Stack tabs')
						.setIcon('layers')
						.onClick(() => void this.plugin.leafSync.toggleStacked(node.id))
				);
				menu.addItem((item) =>
					item.setTitle('Close group').setIcon('x').onClick(() => void this.plugin.leafSync.closeGroup(node.id))
				);
			}
			const undoReceipt = this.plugin.leafSync.receiptForTarget(node.id);
			if (undoReceipt) {
				menu.addItem((item) =>
					item
						.setTitle('Undo last merge')
						.setIcon('undo')
						.onClick(() => void this.plugin.leafSync.undoMerge(undoReceipt))
				);
			}
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Rename').setIcon('pencil').onClick(() => {
				const titleEl = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"] .working-tabs-title`);
				if (titleEl) this.startRename(titleEl, node);
			})
		);
		menu.addItem((item) =>
			item.setTitle('Edit description').setIcon('align-left').onClick(() => {
				new GroupDescriptionModal(
					this.app,
					'Group description',
					'What this group is for…',
					node.description ?? '',
					(description) => {
						void this.store.setDescription(node.id, description || undefined);
					}
				).open();
			})
		);
		// Hidden while colour coding is switched off globally -- a picker whose
		// every choice is invisible is worse than no picker.
		if (this.store.settings.colorCoding) {
			menu.addItem((item) =>
				item.setTitle('Colour').setIcon('palette').onClick(() => this.showColorMenu(node, evt))
			);
		}
		if (!isCompleted) {
			menu.addItem((item) =>
				item.setTitle('Complete').setIcon('check-circle').onClick(() => this.requestComplete(node))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Delete permanently').setIcon('trash').onClick(() => void this.deleteNode(node))
		);
		menu.showAtMouseEvent(evt);
	}

	private showTabMenu(tabs: SpaceNode[], evt: MouseEvent): void {
		const menu = new Menu();
		if (tabs.length === 1) {
			const node = tabs[0];
			menu.addItem((item) =>
				item.setTitle('Rename').setIcon('pencil').onClick(() => {
					const titleEl = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"] .working-tabs-title`);
					if (titleEl) this.startRename(titleEl, node);
				})
			);
			menu.addItem((item) =>
				item
					.setTitle(node.done ? 'Mark not done' : 'Mark done')
					.setIcon('check')
					.onClick(() => void this.store.toggleDone(node.id))
			);
			menu.addSeparator();
		}
		addSendItems(menu, this.plugin, tabs, { dockGroup: true, dockTab: true });
		if (tabs.length === 1) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle('Close tab').setIcon('x').onClick(() => void this.plugin.leafSync.closeTab(tabs[0]))
			);
		}
		menu.showAtMouseEvent(evt);
	}

	// ── Drag and drop ────────────────────────────────────────

	/** What kind of node is allowed to end up parented at `parentId` (a real group/section id, a sentinel, or null for root). */
	private canDropAt(dragged: SpaceNode, parentId: string | null): boolean {
		if (parentId === null) return dragged.type === 'group' || dragged.type === 'section';
		if (parentId === COMPLETED_PARENT_ID) return dragged.type === 'group';
		const parent = this.store.find(parentId);
		if (parent?.type === 'section') return dragged.type === 'group' || dragged.type === 'tab';
		if (parent?.type === 'group') return dragged.type === 'tab';
		return false;
	}

	/** True when `ancestor` is `node` itself or one of its ancestors. */
	private isSelfOrAncestor(ancestor: SpaceNode, node: SpaceNode): boolean {
		let current: SpaceNode | undefined = node;
		while (current) {
			if (current.id === ancestor.id) return true;
			current = current.parentId ? this.store.find(current.parentId) : undefined;
		}
		return false;
	}

	/** Groups can be merged into other groups (tabs move across, source is removed). */
	private canMergeInto(dragged: SpaceNode, target: SpaceNode): boolean {
		return (
			dragged.type === 'group' &&
			target.type === 'group' &&
			dragged.parentId !== COMPLETED_PARENT_ID &&
			target.parentId !== COMPLETED_PARENT_ID &&
			!this.isSelfOrAncestor(dragged, target)
		);
	}

	private wireDrag(row: HTMLElement, node: SpaceNode): void {
		row.addEventListener('dragstart', (evt) => {
			this.draggedId = node.id;
			row.addClass('working-tabs-dragging');
			evt.dataTransfer?.setData('text/plain', node.id);
			evt.dataTransfer!.effectAllowed = 'move';
		});
		row.addEventListener('dragend', () => {
			this.finishDrag(row);
		});

		row.addEventListener('dragover', (evt) => {
			if (!this.draggedId || this.draggedId === node.id) return;
			const dragged = this.store.find(this.draggedId);
			if (!dragged) return;
			const position = this.computeDropPosition(row, node, dragged, evt);
			if (!position) return;
			evt.preventDefault();
			this.markDropTarget(row, position);
		});
		row.addEventListener('dragleave', () => this.clearDropMarker());
		row.addEventListener('drop', (evt) => {
			if (!this.draggedId || this.draggedId === node.id) return;
			const dragged = this.store.find(this.draggedId);
			if (!dragged) return;
			const position = this.computeDropPosition(row, node, dragged, evt);
			if (!position) return;
			evt.preventDefault();
			void this.handleDrop(dragged, node, position);
			this.clearDropMarker();
		});
	}

	/** Returns null when this drop wouldn't be valid, so callers can skip preventDefault/marking entirely. */
	private computeDropPosition(row: HTMLElement, target: SpaceNode, dragged: SpaceNode, evt: DragEvent): DropPosition | null {
		if (dragged.type === 'tab' && (target.type === 'group' || target.type === 'section')) {
			return this.canDropAt(dragged, target.id) ? 'into' : null;
		}
		const rect = row.getBoundingClientRect();
		const fraction = (evt.clientY - rect.top) / rect.height;
		const canNestInto =
			(target.type === 'group' || target.type === 'section') &&
			(this.canDropAt(dragged, target.id) || this.canMergeInto(dragged, target));
		if (canNestInto && fraction > 0.25 && fraction < 0.75) return 'into';
		if (!this.canDropAt(dragged, target.parentId)) return canNestInto ? 'into' : null;
		return fraction < 0.5 ? 'before' : 'after';
	}

	private markDropTarget(row: HTMLElement, position: DropPosition): void {
		if (this.dropMarkedEl && this.dropMarkedEl !== row) this.clearDropMarker();
		row.removeClass('working-tabs-drop-before', 'working-tabs-drop-after', 'working-tabs-drop-into');
		row.addClass(`working-tabs-drop-${position}`);
		this.dropMarkedEl = row;
	}

	private clearDropMarker(): void {
		this.dropMarkedEl?.removeClass('working-tabs-drop-before', 'working-tabs-drop-after', 'working-tabs-drop-into');
		this.dropMarkedEl = null;
	}

	private async handleDrop(dragged: SpaceNode, target: SpaceNode, position: DropPosition): Promise<void> {
		if (dragged.type === 'tab') {
			if (position === 'into' && target.type === 'section') {
				await this.plugin.leafSync.sendToPool([dragged], target.id);
				return;
			}
			if (position === 'into' && target.type === 'group') {
				await this.plugin.leafSync.sendToGroup([dragged], target.id);
				return;
			}
			if (target.type !== 'tab' || !target.parentId) return;
			const parent = this.store.find(target.parentId);
			const siblings = this.store.children(target.parentId).filter((n) => n.id !== dragged.id);
			let index = siblings.findIndex((n) => n.id === target.id);
			if (index === -1) index = siblings.length;
			if (position === 'after') index += 1;
			if (parent?.type === 'section') {
				await this.store.moveInto(dragged.id, parent.id, index);
				return;
			}
			if (parent?.type === 'group') await this.plugin.leafSync.sendToGroup([dragged], parent.id, index);
			return;
		}

		if (position === 'into') {
			// Dropping a group "into" another group merges its tabs into the
			// target and removes the source — it must not nest groups.
			if (dragged.type === 'group' && target.type === 'group') {
				await this.plugin.leafSync.mergeGroupIntoTarget(dragged.id, target.id);
				return;
			}
			const index = this.store.children(target.id).filter((n) => n.id !== dragged.id).length;
			await this.store.moveInto(dragged.id, target.id, index);
			return;
		}
		const siblings = this.store.children(target.parentId).filter((n) => n.id !== dragged.id);
		let index = siblings.findIndex((n) => n.id === target.id);
		if (index === -1) index = siblings.length;
		if (position === 'after') index += 1;
		await this.store.moveInto(dragged.id, target.parentId, index);
	}

	private registerViewportDrop(): void {
		const over = (evt: DragEvent) => this.onViewportDragOver(evt);
		const drop = (evt: DragEvent) => void this.onViewportDrop(evt);
		const end = () => this.finishDrag();
		const root = this.app.workspace.containerEl;
		root.addEventListener('dragover', over);
		root.addEventListener('drop', drop);
		document.addEventListener('dragend', end);
		this.register(() => {
			root.removeEventListener('dragover', over);
			root.removeEventListener('drop', drop);
			document.removeEventListener('dragend', end);
			this.clearViewportDrop();
		});
	}

	private finishDrag(row?: HTMLElement): void {
		row?.removeClass('working-tabs-dragging');
		this.clearDropMarker();
		this.clearViewportDrop();
		this.draggedId = null;
		if (!this.renderAfterDrag) return;
		this.renderAfterDrag = false;
		this.render();
	}

	private draggedGroup(): SpaceNode | undefined {
		const node = this.draggedId ? this.store.find(this.draggedId) : undefined;
		if (!node || node.type !== 'group' || node.parentId === COMPLETED_PARENT_ID) return undefined;
		return node;
	}

	private viewportTarget(evt: DragEvent): { el: HTMLElement; zone: 'left' | 'right' | 'top' | 'bottom' | 'center' } | null {
		const target = evt.target;
		if (!(target instanceof Element)) return null;
		if (target.closest('.mod-left-split, .mod-right-split, .working-tabs-view')) return null;
		const el = target.closest('.mod-root .workspace-leaf');
		if (!(el instanceof HTMLElement)) return null;
		const rect = el.getBoundingClientRect();
		if (rect.width < 8 || rect.height < 8) return null;
		const x = (evt.clientX - rect.left) / rect.width;
		const y = (evt.clientY - rect.top) / rect.height;
		const edge = 0.28;
		let zone: 'left' | 'right' | 'top' | 'bottom' | 'center' = 'center';
		if (y < edge) zone = 'top';
		else if (y > 1 - edge) zone = 'bottom';
		else if (x < edge) zone = 'left';
		else if (x > 1 - edge) zone = 'right';
		return { el, zone };
	}

	private onViewportDragOver(evt: DragEvent): void {
		if (!this.draggedGroup()) {
			this.clearViewportDrop();
			return;
		}
		const hit = this.viewportTarget(evt);
		if (!hit) {
			this.clearViewportDrop();
			return;
		}
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
		this.markViewportDrop(hit.el, hit.zone);
	}

	private async onViewportDrop(evt: DragEvent): Promise<void> {
		const group = this.draggedGroup();
		const hit = group ? this.viewportTarget(evt) : null;
		this.clearViewportDrop();
		if (!group || !hit) return;
		evt.preventDefault();
		evt.stopPropagation();
		const anchor = this.leafForElement(hit.el);
		if (!anchor) return;
		await this.plugin.leafSync.placeGroupBeside(group.id, anchor, hit.zone);
	}

	private markViewportDrop(el: HTMLElement, zone: string): void {
		if (this.viewportDropEl === el && this.viewportDropZone === zone) return;
		if (this.viewportDropEl && this.viewportDropEl !== el) this.clearViewportDrop();
		this.viewportDropEl = el;
		this.viewportDropZone = zone;
		el.addClass('working-tabs-viewport-drop');
		for (const name of ['left', 'right', 'top', 'bottom', 'center']) {
			el.toggleClass(`is-${name}`, name === zone);
		}
	}

	private clearViewportDrop(): void {
		const el = this.viewportDropEl;
		this.viewportDropZone = null;
		if (!el) return;
		el.removeClass('working-tabs-viewport-drop', 'is-left', 'is-right', 'is-top', 'is-bottom', 'is-center');
		this.viewportDropEl = null;
	}

	private leafForElement(el: HTMLElement): WorkspaceLeaf | null {
		let found: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const leafEl = leaf.view.containerEl.closest('.workspace-leaf');
			if (leafEl === el) found = leaf;
		});
		return found;
	}

	private registerRootDropZone(treeEl: HTMLElement): void {
		treeEl.addEventListener('dragover', (evt) => {
			if (evt.target !== treeEl || !this.draggedId) return;
			const dragged = this.store.find(this.draggedId);
			if (dragged && this.canDropAt(dragged, null)) evt.preventDefault();
		});
		treeEl.addEventListener('drop', (evt) => {
			if (evt.target !== treeEl || !this.draggedId) return;
			const dragged = this.store.find(this.draggedId);
			if (!dragged || !this.canDropAt(dragged, null)) return;
			evt.preventDefault();
			const index = this.store.children(null).filter((n) => n.id !== this.draggedId).length;
			void this.store.moveInto(this.draggedId, null, index);
		});
	}

	private registerSentinelDropZone(headerEl: HTMLElement, sentinelId: string): void {
		headerEl.addEventListener('dragover', (evt) => {
			if (!this.draggedId) return;
			const dragged = this.store.find(this.draggedId);
			if (dragged && this.canDropAt(dragged, sentinelId)) evt.preventDefault();
		});
		headerEl.addEventListener('drop', (evt) => {
			if (!this.draggedId) return;
			const dragged = this.store.find(this.draggedId);
			if (!dragged || !this.canDropAt(dragged, sentinelId)) return;
			evt.preventDefault();
			if (sentinelId === COMPLETED_PARENT_ID && dragged.type === 'group') {
				this.requestComplete(dragged);
				return;
			}
			void this.store.moveInto(this.draggedId, sentinelId, this.store.children(sentinelId).length);
		});
	}
}
