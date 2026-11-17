import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type TabSpacesPlugin from '../main';
import type { TabSpacesStore } from '../store';
import type { SpaceNode, OpenBehavior, ColorSlot } from '../types';
import { VIEW_TYPE_WORKING_TABS, COMPLETED_PARENT_ID, COLOR_SLOTS, COLOR_LABELS } from '../types';
import { ConfirmCompleteModal } from '../modals/ConfirmCompleteModal';
import { GroupDescriptionModal } from '../modals/GroupDescriptionModal';

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
	private unsubscribe: (() => void) | null = null;
	private visibleOrder: string[] = [];
	private focusedId: string | null = null;
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
			if (evt.key === 'Escape') {
				evt.preventDefault();
				this.clearSearch();
			}
		});

		this.treeEl = container.createDiv({ cls: 'working-tabs-tree', attr: { tabindex: '0' } });
		this.registerRootDropZone(this.treeEl);
		this.treeEl.addEventListener('keydown', (evt) => this.handleKeydown(evt));

		this.unsubscribe = this.store.onChange(() => {
			if (this.renamingId) return;
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

	/** The reverse of clicking a tab: when it becomes active in the workspace
	 * (clicked directly, or switched to via keyboard), expand whatever
	 * group/section/Completed bucket it's tucked inside so the highlighted
	 * row is actually visible, not just technically focused. */
	private async revealNode(node: SpaceNode): Promise<void> {
		let parentId = node.parentId;
		while (parentId) {
			if (parentId === COMPLETED_PARENT_ID) {
				if (this.completedCollapsed) {
					this.completedCollapsed = false;
					this.render();
				}
				break;
			}
			const parent = this.store.find(parentId);
			if (!parent) break;
			if ((parent.type === 'group' || parent.type === 'section') && parent.collapsed) {
				await this.store.toggleCollapsed(parent.id);
			}
			parentId = parent.parentId;
		}
		// Highlight only -- this runs off active-leaf-change, i.e. in response
		// to the user focusing something in the workspace, so it must leave the
		// keyboard exactly where they just put it.
		this.setFocus(node.id, { takeKeyboardFocus: false });
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
		// Sections always sit below every root-level group, so the top of the
		// panel reads as "what's live right now" -- relative order *within*
		// each type still comes from the stored order (drag-to-reorder), this
		// only separates the two types from each other. The two "+" rows sit
		// between the blocks as a pair: "New group" closes out the groups it
		// appends to, "Create a section" heads the sections block it appends
		// to, so both containers read as peers you can make from one spot.
		// While a section is focused it renders first among sections.
		const focusedSectionId = this.store.focusedSectionId;
		for (const node of roots.filter((n) => n.type === 'group')) this.renderNode(this.treeEl, node, 0, false, query);
		if (!query) {
			this.renderNewGroupRow();
			this.renderCreateSectionRow();
		}
		const sections = roots.filter((n) => n.type === 'section');
		const orderedSections = focusedSectionId
			? [
					...sections.filter((n) => n.id === focusedSectionId),
					...sections.filter((n) => n.id !== focusedSectionId),
				]
			: sections;
		for (const node of orderedSections) this.renderNode(this.treeEl, node, 0, false, query);

		this.treeEl.createDiv({ cls: 'working-tabs-divider' });

		this.renderSyntheticSection(
			'Completed',
			COMPLETED_PARENT_ID,
			this.completedCollapsed,
			(v) => (this.completedCollapsed = v),
			query
		);
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

		// Same custom property the pane's stripe uses, so a row and the pane it
		// stands for are literally reading the same colour -- that's the whole
		// point of the coding, and it stops the two drifting apart. Tabs
		// resolve to nothing and stay unstyled.
		const slot = this.store.effectiveColor(node);
		if (slot) {
			row.addClass('working-tabs-colored');
			row.style.setProperty('--working-tabs-accent', `var(--working-tabs-color-${slot})`);
		}

		this.visibleOrder.push(node.id);
		if (node.id === this.focusedId) row.addClass('is-focused');
		row.addEventListener('mousedown', (evt) => {
			if ((evt.target as HTMLElement).tagName === 'INPUT') return;
			this.setFocus(node.id);
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
			if (!query) void this.store.toggleCollapsed(node.id);
		});
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.showSectionMenu(node, evt);
		});

		if (expanded) {
			const childWrap = wrapper.createDiv({ cls: 'working-tabs-children' });
			const children = this.store.children(node.id).filter((c) => !query || this.matchesQuery(c, query));
			for (const child of children) this.renderNode(childWrap, child, depth + 1, false, query);
		}
	}

	private isLive(node: SpaceNode): boolean {
		return this.plugin.leafSync.isLive(node.id);
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
			if (!query) void this.store.toggleCollapsed(node.id);
		});

		const textCol = row.createDiv({ cls: 'working-tabs-text-col' });
		const titleRow = textCol.createDiv({ cls: 'working-tabs-title-row' });
		const title = titleRow.createSpan({ cls: 'working-tabs-title' });
		title.setText(node.title);
		this.wireRename(title, node);
		const tabCount = this.store.children(node.id).length;
		titleRow.createSpan({ cls: 'working-tabs-count', text: String(tabCount) });
		if (node.description) {
			textCol.createDiv({ cls: 'working-tabs-description', text: node.description });
		}

		const actions = row.createDiv({ cls: 'working-tabs-row-actions' });
		if (!live && !isCompleted) {
			this.makeGroupActionButton(actions, 'external-link', 'Open', (evt) => {
				evt.stopPropagation();
				this.showPlacementMenu(node, evt);
			});
		}
		this.makeGroupActionButton(
			actions,
			isCompleted ? 'rotate-ccw' : 'check-circle',
			isCompleted ? 'Restore' : 'Complete',
			(evt) => {
				evt.stopPropagation();
				if (isCompleted) void this.store.restore(node.id);
				else this.requestComplete(node);
			}
		);
		this.makeGroupActionButton(actions, 'ellipsis-vertical', 'More', (evt) => {
			evt.stopPropagation();
			this.showGroupMenu(node, evt, isCompleted);
		});

		this.wireRowClick(row, () => {
			if (live) void this.plugin.leafSync.openGroup(node.id);
			else if (!isCompleted) this.showPlacementMenu(node);
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
		btn.addEventListener('click', onClick);
	}

	private renderTab(parentEl: HTMLElement, node: SpaceNode, depth: number): void {
		const row = this.renderRowShell(parentEl, node, depth, 'working-tabs-tab-row');

		const checkbox = row.createEl('input', {
			cls: 'working-tabs-done-checkbox',
			attr: { type: 'checkbox' },
		});
		checkbox.checked = Boolean(node.done);
		checkbox.addEventListener('click', (evt) => evt.stopPropagation());
		checkbox.addEventListener('change', () => void this.handleToggleDone(node));

		const title = row.createSpan({ cls: `working-tabs-title${node.done ? ' is-done' : ''}` });
		title.setText(node.title);
		this.wireRename(title, node);

		const actions = row.createDiv({ cls: 'working-tabs-row-actions' });
		this.makeGroupActionButton(actions, 'x', 'Close tab', (evt) => {
			evt.stopPropagation();
			void this.plugin.leafSync.closeTab(node);
		});

		this.wireRowClick(row, () => void this.plugin.leafSync.focusTab(node));
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.showTabMenu(node, evt);
		});
	}

	/** A group is never created directly -- it's just whatever reconcile
	 * finds occupying a pane it doesn't already know about (see
	 * doReconcile's step 4 and LeafSync.openNewGroup) -- so this row doesn't
	 * create a group record either. It only opens a blank pane per the
	 * chosen placement and lets that same auto-detection name it. */
	private renderNewGroupRow(): void {
		const row = this.treeEl.createDiv({ cls: 'working-tabs-row working-tabs-new-group-row' });
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
	private renderCreateSectionRow(): void {
		const row = this.treeEl.createDiv({ cls: 'working-tabs-row working-tabs-create-section-row' });
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

	/**
	 * Marks a row as the keyboard-navigation cursor and scrolls it into view.
	 *
	 * `takeKeyboardFocus` is what separates "the user is driving this panel"
	 * from "this panel is reflecting something that happened elsewhere". Moving
	 * DOM focus to the tree is right for the first -- a click on a row, an
	 * arrow key -- and actively harmful for the second: highlighting the row
	 * for whichever leaf just became active is a *response* to the user
	 * focusing something else in the workspace, so stealing the keyboard back
	 * takes it away from the thing they just deliberately clicked into. A
	 * terminal is where that's felt hardest, since a pane that has lost focus
	 * looks identical to one that is simply refusing to accept typing.
	 */
	private setFocus(id: string, { takeKeyboardFocus = true }: { takeKeyboardFocus?: boolean } = {}): void {
		const prevId = this.focusedId;
		this.focusedId = id;
		if (prevId) this.treeEl.querySelector<HTMLElement>(`[data-node-id="${prevId}"]`)?.removeClass('is-focused');
		const el = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
		el?.addClass('is-focused');
		el?.scrollIntoView({ block: 'nearest' });
		if (takeKeyboardFocus) this.treeEl.focus();
	}

	private moveFocus(delta: number): void {
		if (this.visibleOrder.length === 0) return;
		const currentIndex = this.focusedId ? this.visibleOrder.indexOf(this.focusedId) : -1;
		const nextIndex = Math.max(0, Math.min(this.visibleOrder.length - 1, currentIndex + delta));
		const nextId = this.visibleOrder[nextIndex];
		if (nextId) this.setFocus(nextId);
	}

	private handleKeydown(evt: KeyboardEvent): void {
		if (!this.focusedId) {
			if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
				evt.preventDefault();
				this.moveFocus(evt.key === 'ArrowDown' ? 1 : -1);
			}
			return;
		}
		const node = this.store.find(this.focusedId);
		if (!node) return;

		switch (evt.key) {
			case 'ArrowDown':
				evt.preventDefault();
				this.moveFocus(1);
				break;
			case 'ArrowUp':
				evt.preventDefault();
				this.moveFocus(-1);
				break;
			case 'ArrowRight':
				evt.preventDefault();
				if ((node.type === 'group' || node.type === 'section') && node.collapsed) {
					void this.store.toggleCollapsed(node.id);
				} else {
					this.moveFocus(1);
				}
				break;
			case 'ArrowLeft':
				evt.preventDefault();
				if ((node.type === 'group' || node.type === 'section') && !node.collapsed) {
					void this.store.toggleCollapsed(node.id);
				} else if (node.parentId && this.store.find(node.parentId)) {
					this.setFocus(node.parentId);
				}
				break;
			case 'Enter':
				evt.preventDefault();
				if (node.type === 'section') void this.store.toggleCollapsed(node.id);
				else if (node.type === 'group') {
					if (this.plugin.leafSync.isLive(node.id)) void this.plugin.leafSync.openGroup(node.id);
					else this.showPlacementMenu(node);
				}
				else void this.plugin.leafSync.focusTab(node);
				break;
			case 'F2': {
				evt.preventDefault();
				const titleEl = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"] .working-tabs-title`);
				if (titleEl) this.startRename(titleEl, node);
				break;
			}
			case 'Delete':
			case 'Backspace':
				evt.preventDefault();
				void this.deleteNode(node);
				break;
		}
	}

	/** Delaying the click action lets a following second click cancel it, so double-clicking the title renames instead of opening/toggling first. */
	private wireRowClick(row: HTMLElement, action: () => void): void {
		let pending: number | null = null;
		row.addEventListener('click', () => {
			if (pending !== null) {
				window.clearTimeout(pending);
				pending = null;
				return;
			}
			pending = window.setTimeout(() => {
				pending = null;
				action();
			}, 250);
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
			// Stop every key here, not just Enter/Escape -- otherwise normal
			// text editing (Backspace, Delete, arrow keys, ...) bubbles up to
			// the tree's own keydown handler, which treats Backspace/Delete as
			// "delete this node" and Arrow keys as "move focus" instead of
			// letting the input edit its own text.
			evt.stopPropagation();
			if (evt.key === 'Enter') {
				evt.preventDefault();
				void finish(true);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				void finish(false);
			}
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

	/** Placement for a dormant group. Nothing opens until one of these verbs is chosen. */
	private showPlacementMenu(node: SpaceNode, evt?: MouseEvent): void {
		const menu = new Menu();
		for (const { label, behavior } of PLACEMENT_MENU) {
			menu.addItem((item) =>
				item.setTitle(label).onClick(() => void this.plugin.leafSync.openGroup(node.id, behavior))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle('Move into current tab group')
				.setIcon('layers')
				.onClick(() => void this.plugin.leafSync.moveGroupIntoCurrentTabGroup(node.id))
		);
		if (evt) menu.showAtMouseEvent(evt);
		else {
			const row = this.treeEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
			const rect = row?.getBoundingClientRect();
			if (rect) menu.showAtPosition({ x: rect.left, y: rect.bottom });
		}
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

	private showGroupMenu(node: SpaceNode, evt: MouseEvent, isCompleted: boolean): void {
		const menu = new Menu();
		if (!isCompleted) {
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
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Delete permanently').setIcon('trash').onClick(() => void this.deleteNode(node))
		);
		menu.showAtMouseEvent(evt);
	}

	private showTabMenu(node: SpaceNode, evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle(node.done ? 'Mark not done' : 'Mark done').setIcon('check').onClick(() => void this.store.toggleDone(node.id))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Split right')
				.setIcon('separator-vertical')
				.onClick(() => void this.plugin.leafSync.moveTabToNewGroup(node, 'vertical'))
		);
		menu.addItem((item) =>
			item
				.setTitle('Split down')
				.setIcon('separator-horizontal')
				.onClick(() => void this.plugin.leafSync.moveTabToNewGroup(node, 'horizontal'))
		);
		for (const group of this.store.items.filter(
			(n) => n.type === 'group' && n.id !== node.parentId && this.plugin.leafSync.isLive(n.id)
		)) {
			menu.addItem((item) =>
				item.setTitle(`Move to: ${group.title}`).setIcon('folder').onClick(() => {
					void this.plugin.leafSync.moveTab(node, group.id, this.store.children(group.id).length);
				})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Close tab').setIcon('x').onClick(() => void this.plugin.leafSync.closeTab(node))
		);
		menu.showAtMouseEvent(evt);
	}

	// ── Drag and drop ────────────────────────────────────────

	/** What kind of node is allowed to end up parented at `parentId` (a real group/section id, a sentinel, or null for root). */
	private canDropAt(dragged: SpaceNode, parentId: string | null): boolean {
		if (parentId === null) return dragged.type === 'group' || dragged.type === 'section';
		if (parentId === COMPLETED_PARENT_ID) return dragged.type === 'group';
		const parent = this.store.find(parentId);
		if (parent?.type === 'section') return dragged.type === 'group';
		if (parent?.type === 'group') return dragged.type === 'tab';
		return false;
	}

	private wireDrag(row: HTMLElement, node: SpaceNode): void {
		row.addEventListener('dragstart', (evt) => {
			this.draggedId = node.id;
			row.addClass('working-tabs-dragging');
			evt.dataTransfer?.setData('text/plain', node.id);
			evt.dataTransfer!.effectAllowed = 'move';
		});
		row.addEventListener('dragend', () => {
			row.removeClass('working-tabs-dragging');
			this.clearDropMarker();
			this.draggedId = null;
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
		const rect = row.getBoundingClientRect();
		const fraction = (evt.clientY - rect.top) / rect.height;
		const canNestInto = (target.type === 'group' || target.type === 'section') && this.canDropAt(dragged, target.id);
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
			if (position === 'into' && target.type === 'group') {
				const index = this.store.children(target.id).filter((n) => n.id !== dragged.id).length;
				await this.plugin.leafSync.moveTab(dragged, target.id, index);
				return;
			}
			if (!target.parentId) return;
			const siblings = this.store.children(target.parentId).filter((n) => n.id !== dragged.id);
			let index = siblings.findIndex((n) => n.id === target.id);
			if (index === -1) index = siblings.length;
			if (position === 'after') index += 1;
			await this.plugin.leafSync.moveTab(dragged, target.parentId, index);
			return;
		}

		if (position === 'into') {
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
