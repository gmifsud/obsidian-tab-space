import { Notice, TFile, WorkspaceLeaf, type ViewState } from 'obsidian';
import type TabSpacesPlugin from './main';
import type { TabSpacesStore } from './store';
import type { OpenBehavior, SpaceNode } from './types';
import { COMPLETED_PARENT_ID, VIEW_TYPE_WORKING_TABS } from './types';
import {
	effectivelyHidden,
	pendingGroupId,
	plan,
	type PlanEntry,
	type TabIdentity,
	type WorkspaceSnapshot,
} from './membership';
import { installPaneMenus } from './pane-menus';
import { needsViewStateForIdentity } from './tab-identity';

/** Every leaf has a runtime `id` (that's what getLeafById() looks up), but it
 * isn't part of the public WorkspaceLeaf type -- this is the standard
 * workaround community plugins use to track a specific pane across renders. */
function getLeafId(leaf: WorkspaceLeaf): string | undefined {
	return (leaf as unknown as { id?: string }).id;
}

/** Session-stable pane ids. `leaf.parent.id` is undocumented and can churn
 * across splits/drags; pinning the first id we see per parent object keeps
 * claims stable for the session (restart still reattaches via membership D7). */
const paneIds = new WeakMap<object, string>();
let paneIdSeq = 0;

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
type SplitDirectionName = 'vertical' | 'horizontal';

/** The bits of a workspace split or tab group this plugin moves. */
interface SplitNode {
	parent: SplitNode | null;
	children: SplitNode[];
	direction?: 'vertical' | 'horizontal' | null;
	removeChild(child: SplitNode): void;
	insertChild(index: number, child: SplitNode): void;
}

function splitNode(value: unknown): SplitNode {
	return value as SplitNode;
}

function getPaneId(leaf: WorkspaceLeaf): string | undefined {
	const parent = leaf.parent as unknown as { id?: string } | null;
	if (!parent) return undefined;
	const cached = paneIds.get(parent);
	if (cached) return cached;
	const id = parent.id ?? `pane:${++paneIdSeq}`;
	paneIds.set(parent, id);
	return id;
}

/** Derived from the path alone (not leaf.view.getDisplayText()) so it works
 * the same whether or not the leaf's view has actually loaded yet. */
function titleFromPath(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.[^./]+$/, '') || base;
}

/** How much of a captured `viewState` is worth persisting, per string value.
 * Anything bigger is a payload some view is carrying around, not the identity
 * of a tab we need in order to reopen it -- Terminus, for instance, returns up
 * to 1000 lines of serialized terminal scrollback under `state.scrollback`,
 * which can run to hundreds of KB of escape-code-dense text. Persisting that
 * put a live terminal's whole transcript into this plugin's data.json, made
 * every unrelated store write re-serialize it, and -- because a running
 * terminal's scrollback changes on practically every keystroke -- guaranteed
 * that syncViewState's "has anything changed?" check never once matched, so
 * every reconcile pass wrote the file and re-rendered the sidebar. 8 KB is
 * comfortably above any real identity field (paths, URLs, view modes) and
 * far below any such payload. */
const MAX_VIEW_STATE_VALUE_CHARS = 8 * 1024;

/** How long a poll-driven pass will go without refreshing stored view state.
 * layout-change passes always refresh it, so this only governs the changes no
 * workspace event announces -- chiefly a web viewer tab navigating to a new
 * URL. Half a minute keeps that near-current while keeping the 3s title poll
 * (see start()) off the expensive path. */
const VIEW_STATE_POLL_INTERVAL_MS = 30_000;

/**
 * 'full' passes refresh everything, including each tab's stored view state.
 * 'poll' passes come from the plain interval timer, whose only job is noticing
 * renames no workspace event fires for, and so skip that refresh unless it has
 * been long enough (see VIEW_STATE_POLL_INTERVAL_MS).
 */
type SyncMode = 'full' | 'poll';

/** Strips oversized string values out of a captured view state so only its
 * identity-sized parts get persisted -- e.g. a Terminus tab keeps its `cwd`
 * (which is what makes reopening it land in the right directory) and drops its
 * `scrollback`. Returns the original object untouched when nothing is
 * oversized, which is the case for every ordinary note/canvas/web tab, so the
 * common path allocates nothing. */
function trimViewState(viewState: ViewState): ViewState {
	const state = viewState.state;
	if (!state || typeof state !== 'object') return viewState;
	let oversized: string[] | null = null;
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === 'string' && value.length > MAX_VIEW_STATE_VALUE_CHARS) (oversized ??= []).push(key);
	}
	if (!oversized) return viewState;
	const trimmed = { ...state };
	for (const key of oversized) delete trimmed[key];
	return { ...viewState, state: trimmed };
}

/**
 * Bridges the plugin's own group/section/tab data (in TabSpacesStore) with
 * Obsidian's live workspace. Nothing here has an analogue in a bookmarks-only
 * plugin, since bookmarks don't track live panes.
 */
export class LeafSync {
	constructor(
		private plugin: TabSpacesPlugin,
		private store: TabSpacesStore
	) {}

	/** Session-scoped merge undo stack (Phase B); max 5. */
	receipts: Array<{ group: SpaceNode; tabIds: string[]; targetGroupId: string; at: number }> = [];

	private get app() {
		return this.plugin.app;
	}

	private get workspace() {
		return this.plugin.app.workspace;
	}

	/**
	 * Identifies a leaf for tracking purposes, whether or not it's backed by a
	 * vault file -- a terminal, an embedded browser tab, a canvas, or any other
	 * plugin's custom view is just as much a "tab" as a note is.
	 *
	 * The file path is read out of the leaf's *stored* view state instead of
	 * `leaf.view instanceof FileView`, because a background pane's view is
	 * often a lightweight `DeferredView` stand-in (not yet instantiated as a
	 * real MarkdownView/FileView) until the user actually clicks into it, so
	 * an instanceof check would silently skip every leaf in any split that
	 * isn't currently focused. The path is also verified against the vault --
	 * some non-file views happen to store an unrelated string under a `file`
	 * key too, which would otherwise get misread as a real path.
	 */
	private getTabIdentity(leaf: WorkspaceLeaf): TabIdentity {
		const direct = this.directFilePath(leaf);
		if (direct) return { key: direct, path: direct, title: titleFromPath(direct) };

		const type = leaf.view.getViewType();
		if (!needsViewStateForIdentity(type, direct)) {
			const leafId = getLeafId(leaf) ?? `${Date.now()}-${Math.random()}`;
			return { key: `${type}:${leafId}`, title: leaf.getDisplayText() || type || 'Untitled' };
		}

		const viewState = this.readViewState(leaf);
		const rawFile = viewState.state?.file;
		const path =
			typeof rawFile === 'string' && this.app.vault.getAbstractFileByPath(rawFile) instanceof TFile
				? rawFile
				: undefined;
		if (path) return { key: path, path, title: titleFromPath(path) };

		const leafId = getLeafId(leaf) ?? `${Date.now()}-${Math.random()}`;
		const title = leaf.getDisplayText() || viewState.type || 'Untitled';
		return { key: `${type}:${leafId}`, title };
	}

	/** A loaded file view exposes its path. A deferred view does not. */
	private directFilePath(leaf: WorkspaceLeaf): string | undefined {
		const file = (leaf.view as { file?: { path?: string } }).file;
		if (typeof file?.path !== 'string' || !file.path) return undefined;
		return this.app.vault.getAbstractFileByPath(file.path) instanceof TFile ? file.path : undefined;
	}

	/** The reverse of clicking a tab in the sidebar: given a leaf that just
	 * became active in the workspace, finds the stored tab tracking it (if
	 * any), so the sidebar can highlight/reveal it in turn.
	 * The same file can sit in several groups, so the match is the record
	 * under the group that claims this leaf's pane. */
	findTabForLeaf(leaf: WorkspaceLeaf): SpaceNode | undefined {
		// The open view already knows its file. getViewState() here serialises
		// the whole view (a terminal dumps its scrollback) and forces layout.
		const key = this.openLeafKey(leaf);
		const paneId = getPaneId(leaf);
		const owner = paneId
			? this.store.items.find((item) => item.type === 'group' && item.homePaneId === paneId)
			: undefined;
		if (owner) {
			const inGroup = this.store.children(owner.id).find((item) => item.type === 'tab' && item.tabKey === key);
			if (inGroup) return inGroup;
		}
		return this.store.items.find((item) => item.type === 'tab' && item.tabKey === key);
	}

	/** Identity of a leaf that is already on screen, without reading view state. */
	private openLeafKey(leaf: WorkspaceLeaf): string {
		const file = (leaf.view as { file?: { path?: string } }).file;
		if (typeof file?.path === 'string' && file.path) return file.path;
		const id = getLeafId(leaf);
		const type = leaf.view.getViewType();
		return id ? `${type}:${id}` : this.getTabIdentity(leaf).key;
	}

	private reconcileRunning = false;
	private reconcileQueuedMode: SyncMode | null = null;
	private lastViewStateSync = 0;
	/** Groups currently mid-open (see openGroup) -- reconcile skips syncing
	 * their tab list until opening finishes, to avoid treating "not created
	 * yet" the same as "closed". */
	private openingGroups = new Set<string>();

	/**
	 * Set for the duration of one reconcile pass so each leaf's view state is
	 * read exactly once per pass instead of once per caller.
	 *
	 * `leaf.getViewState()` is not a cheap accessor -- it calls straight
	 * through to the view's own `getState()`, and a view is free to do real
	 * work there (Terminus serializes its entire scrollback buffer). A pass
	 * asked for the same leaf's state two or three times over: once building
	 * its identity, again to sync it, again when adding it to a group. On a
	 * workspace with a couple of live terminals that was several full
	 * serializations every three seconds, on the main thread, which is the
	 * same thread xterm.js needs in order to accept a keystroke.
	 *
	 * Pass-scoped rather than long-lived: view state genuinely does change
	 * between passes, so caching it across them would make the plugin act on
	 * stale data. A WeakMap so a leaf closed mid-pass isn't held alive.
	 */
	private viewStateCache: WeakMap<WorkspaceLeaf, ViewState> | null = null;

	private readViewState(leaf: WorkspaceLeaf): ViewState {
		const cache = this.viewStateCache;
		if (!cache) return leaf.getViewState();
		const cached = cache.get(leaf);
		if (cached) return cached;
		const fresh = leaf.getViewState();
		cache.set(leaf, fresh);
		return fresh;
	}

	start(): void {
		this.workspace.onLayoutReady(() => void this.reconcile());
		// Membership has to follow splits and tab moves, but reading every leaf's
		// view state here made each of those events serialise terminal scrollback.
		// Titles and membership use the cheap identity. View state waits for the
		// poll interval inside doReconcile.
		this.plugin.registerEvent(this.workspace.on('layout-change', () => void this.reconcile('poll')));
		installPaneMenus(this.plugin);

		// A rename made through another plugin's own UI (e.g. Terminus letting
		// you rename a terminal tab) only touches that plugin's internal DOM
		// elements directly -- it doesn't fire any Obsidian workspace event, so
		// layout-change never sees it. A slow periodic fallback is the only way
		// to notice; syncTitle() already no-ops when nothing's actually changed,
		// so this costs nothing on the (typical) tick where titles are unchanged.
		// Runs in 'poll' mode: titles are all it exists to catch, and the view
		// state refresh a full pass also does is far too expensive to run on a
		// timer against views that do real work in getState().
		this.plugin.registerInterval(window.setInterval(() => void this.reconcile('poll'), 3000));

		// A file rename is a vault event, not a workspace layout-change --
		// without this, a renamed file's tab looks "closed" (old path no
		// longer open) while the new path looks like a brand-new tab, so it
		// gets orphaned out of its group instead of renamed in place.
		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) void this.store.remapTabPath(oldPath, file.path, titleFromPath(file.path));
			})
		);
	}

	/**
	 * `layout-change` fires often (any tab/pane change), and a reconcile pass
	 * does several sequential awaited store mutations, each of which writes
	 * to disk. Without this guard, a second layout-change firing mid-pass
	 * would start an overlapping reconcile reading/writing the same data
	 * concurrently -- interleaved writes from two passes is exactly what
	 * produced the duplicate/missing tabs seen while testing this. Instead,
	 * a call that arrives while one is already running just requests exactly
	 * one more full pass after the current one finishes.
	 */
	private async reconcile(mode: SyncMode = 'full'): Promise<void> {
		if (this.reconcileRunning) {
			// Never let a cheap poll downgrade a queued full pass -- a real
			// layout change still has to be reconciled in full once the current
			// pass finishes, whatever else arrived in the meantime.
			this.reconcileQueuedMode = this.reconcileQueuedMode === 'full' || mode === 'full' ? 'full' : 'poll';
			return;
		}
		this.reconcileRunning = true;
		try {
			// One disk write and one sidebar re-render for the whole pass,
			// rather than one of each per tab touched (see store.batch).
			this.viewStateCache = new WeakMap();
			await this.store.batch(() => this.doReconcile(mode));
		} finally {
			this.viewStateCache = null;
			this.reconcileRunning = false;
			const queued = this.reconcileQueuedMode;
			if (queued) {
				this.reconcileQueuedMode = null;
				void this.reconcile(queued);
			}
		}
	}

	/**
	 * Keeps live-tracking state honest against reality via pure membership
	 * plan (see membership.ts): snapshot → plan → apply.
	 */
	private async doReconcile(mode: SyncMode): Promise<void> {
		// Legacy homeLeafId without homePaneId: leaf ids are dead after restart;
		// treat as dormant and drop the deprecated field.
		for (const node of this.store.items) {
			if (node.type === 'group' && node.homeLeafId && !node.homePaneId) {
				node.homeLeafId = undefined;
			}
		}

		const syncState = mode === 'full' || Date.now() - this.lastViewStateSync >= VIEW_STATE_POLL_INTERVAL_MS;
		if (syncState) this.lastViewStateSync = Date.now();
		const planMode: SyncMode = syncState ? 'full' : 'poll';

		const snapshot = this.snapshot(planMode);
		const entries = plan(snapshot, this.store.items, {
			mode: planMode,
			focusedSectionId: this.store.focusedSectionId,
			suppressedGroupIds: this.openingGroups,
			nextDefaultTitle: () => this.store.nextDefaultTitle('group'),
		});
		await this.applyPlan(entries);

		const leafByPane = this.firstLeafByPane();
		for (const node of this.store.items) {
			if (node.type !== 'group' || !node.homePaneId) continue;
			const leaf = leafByPane.get(node.homePaneId);
			if (!leaf) continue;
			this.applyHiddenClass(node, leaf);
			this.applyAccent(node, leaf);
		}
	}

	private snapshot(mode: SyncMode): WorkspaceSnapshot {
		const panes = new Map<string, WorkspaceSnapshot['panes'][0]>();
		this.workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot();
			if (root === this.workspace.leftSplit || root === this.workspace.rightSplit) return;
			if (leaf.view.getViewType() === VIEW_TYPE_WORKING_TABS) return;
			const paneId = getPaneId(leaf);
			if (!paneId) return;
			const identity = this.getTabIdentity(leaf);
			const leafId = getLeafId(leaf) ?? identity.key;
			const list = panes.get(paneId) ?? { paneId, leaves: [] };
			list.leaves.push({
				leafId,
				identity,
				viewState: mode === 'full' ? trimViewState(this.readViewState(leaf)) : undefined,
			});
			panes.set(paneId, list);
		});
		return { panes: [...panes.values()] };
	}

	private async applyPlan(entries: PlanEntry[]): Promise<void> {
		const pendingGroups = new Map<string, string>();
		for (const entry of entries) {
			switch (entry.kind) {
				case 'claimPane':
					await this.store.setHomePane(entry.groupId, entry.paneId);
					break;
				case 'releasePane':
					await this.store.setHomePane(entry.groupId, undefined);
					break;
				case 'syncTitle':
					await this.store.syncTitle(entry.tabId, entry.title);
					break;
				case 'syncViewState':
					await this.store.syncViewState(entry.tabId, entry.viewState);
					break;
				case 'setOrder':
					await this.store.setOrder(entry.tabId, entry.order);
					break;
				case 'moveTabRecord':
					await this.store.moveTabRecord(entry.tabId, entry.toGroupId);
					break;
				case 'addTab': {
					const groupId = pendingGroups.get(entry.groupId) ?? entry.groupId;
					await this.store.addTab(groupId, entry.key, entry.title, {
						filePath: entry.path,
						viewState: entry.viewState,
					});
					break;
				}
				case 'pruneTab':
					await this.store.remove(entry.tabId);
					break;
				case 'newGroup': {
					const group = await this.store.addGroup(entry.title, entry.parentId);
					await this.store.setHomePane(group.id, entry.paneId);
					pendingGroups.set(pendingGroupId(entry.paneId), group.id);
					break;
				}
				case 'merged': {
					const receipt = {
						group: entry.fromGroup,
						tabIds: entry.tabIds,
						targetGroupId: entry.toGroupId,
						at: Date.now(),
					};
					this.receipts.unshift(receipt);
					if (this.receipts.length > 5) this.receipts.length = 5;
					const target = this.store.find(entry.toGroupId);
					this.showMergeNotice(entry.fromGroup.title, target?.title ?? 'group', receipt);
					break;
				}
				case 'removeGroup':
					await this.store.remove(entry.groupId);
					break;
			}
		}
	}

	/** The tab-group element this stored group claims, if that pane still exists. */
	paneElement(groupId: string): HTMLElement | null {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group') return null;
		const leaf = this.findLeafInPane(group.homePaneId);
		return (leaf?.view.containerEl.closest('.workspace-tabs') as HTMLElement | null) ?? null;
	}

	/** True when that pane is in the layout and has a visible box. */
	isRendered(groupId: string): boolean {
		const el = this.paneElement(groupId);
		if (!el) return false;
		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden') return false;
		const rect = el.getBoundingClientRect();
		return rect.width >= 2 && rect.height >= 2;
	}

	/** Outline the selected group's pane. Clears any previous outline. */
	markSelectedPane(groupId: string | null): void {
		const marked = document.querySelectorAll('.workspace-tabs.working-tabs-selected-pane');
		for (let i = 0; i < marked.length; i++) {
			(marked[i] as HTMLElement).removeClass('working-tabs-selected-pane');
		}
		if (!groupId || !this.isRendered(groupId)) return;
		this.paneElement(groupId)?.addClass('working-tabs-selected-pane');
	}

	/** First leaf whose parent pane id matches, if any. */
	private findLeafInPane(paneId: string | undefined): WorkspaceLeaf | undefined {
		if (!paneId) return undefined;
		let found: WorkspaceLeaf | undefined;
		this.workspace.iterateAllLeaves((l) => {
			if (!found && getPaneId(l) === paneId) found = l;
		});
		return found;
	}

	private leavesInPane(paneId: string | undefined): WorkspaceLeaf[] {
		if (!paneId) return [];
		const out: WorkspaceLeaf[] = [];
		this.workspace.iterateAllLeaves((l) => {
			if (getPaneId(l) === paneId) out.push(l);
		});
		return out;
	}

	private findOwningGroupByPane(paneId: string | undefined, excludeId?: string): SpaceNode | undefined {
		if (!paneId) return undefined;
		return this.store.items.find(
			(n) => n.type === 'group' && n.id !== excludeId && n.homePaneId === paneId
		);
	}

	/**
	 * Ported from Vertical Tabs' own (proven, shipped-for-years) approach:
	 * toggle a class on the specific pane, then let a *declarative* CSS
	 * `:has()` selector (see styles.css) cascade the collapse up through
	 * however many nested splits are affected -- not JavaScript walking the
	 * DOM. An earlier attempt tried to replicate that cascade ourselves by
	 * recursively adjusting flex values, which occasionally corrupted the
	 * sizing of *other*, unrelated panes; CSS re-evaluating `:has()` on its
	 * own, with nothing but a class toggle from us, can't drift out of sync
	 * with the DOM the way hand-rolled JS state can.
	 */
	/** Stored hide flags. Not applied to the workspace — hiding a pane is Close. */
	isEffectivelyHidden(group: SpaceNode): boolean {
		const parent = group.parentId ? this.store.find(group.parentId) : undefined;
		const section = parent?.type === 'section' ? parent : undefined;
		return effectivelyHidden(group, section);
	}

	private firstLeafByPane(): Map<string, WorkspaceLeaf> {
		const leafByPane = new Map<string, WorkspaceLeaf>();
		this.workspace.iterateAllLeaves((leaf) => {
			const paneId = getPaneId(leaf);
			if (paneId && !leafByPane.has(paneId)) leafByPane.set(paneId, leaf);
		});
		return leafByPane;
	}

	/** Drop a leftover hide class from older builds. The stylesheet no longer hides panes. */
	private applyHiddenClass(group: SpaceNode, leaf = this.findLeafInPane(group.homePaneId)): void {
		const tabsEl = leaf?.view.containerEl.closest('.workspace-tabs') as HTMLElement | null;
		tabsEl?.removeClass('working-tabs-hidden-pane');
	}

	/**
	 * Colour coding's half of the same mechanism: reaches the group's pane the
	 * exact same way applyHiddenClass does, and sets a custom property that
	 * styles.css turns into a stripe down the pane's leading edge. Nothing but
	 * a property write from here -- the stripe itself is declarative, so it
	 * can't drift out of sync with the DOM.
	 *
	 * The edge is deliberately not the tab-header row: the "Hide tab bar"
	 * setting deletes that row outright (see styles.css), and an accent that
	 * vanishes for the people leaning hardest on this sidebar would be the
	 * wrong half of the feature to lose.
	 *
	 * Always set *or* clear, never set-only: panes get recycled between groups
	 * as they open and close, and a stripe left behind would claim a pane still
	 * belongs to a group that has since moved out of it.
	 */
	private applyAccent(group: SpaceNode, leaf = this.findLeafInPane(group.homePaneId)): void {
		const tabsEl = leaf?.view.containerEl.closest('.workspace-tabs') as HTMLElement | null;
		if (!tabsEl) return;
		const next = this.store.accentCss(group) ?? '';
		// Compared before writing because refreshAccents runs on every store
		// change (which includes each reconcile tick), and the overwhelmingly
		// common case is that nothing about the colour has moved.
		if (tabsEl.style.getPropertyValue('--working-tabs-accent') === next) return;
		if (next) {
			tabsEl.style.setProperty('--working-tabs-accent', next);
			tabsEl.addClass('working-tabs-accented');
		} else {
			tabsEl.style.removeProperty('--working-tabs-accent');
			tabsEl.removeClass('working-tabs-accented');
		}
	}

	/** Re-asserts every live group's stripe. Driven off the store's change
	 * event (see main.ts) because so many different edits change what a pane
	 * should be showing -- picking a colour, dragging a group into or out of a
	 * section, recolouring the section itself, completing a group -- and every
	 * one of them already goes through the store. */
	refreshAccents(): void {
		for (const node of this.store.items) {
			if (node.type === 'group' && node.homePaneId) this.applyAccent(node);
		}
	}

	refreshHidden(): void {
		for (const node of this.store.items) {
			if (node.type === 'group' && node.homePaneId) this.applyHiddenClass(node);
		}
	}

	async toggleGroupHidden(id: string): Promise<void> {
		await this.store.toggleHidden(id);
		const group = this.store.find(id);
		if (group) this.applyHiddenClass(group);
	}

	/** Same mechanism as toggleGroupHidden, but for every group filed under a
	 * section at once -- each group's own `hidden` flag is untouched, only
	 * the section's is flipped, and isEffectivelyHidden combines the two. */
	async toggleSectionHidden(id: string): Promise<void> {
		await this.store.toggleHidden(id);
		for (const group of this.store.children(id)) {
			if (group.type === 'group') this.applyHiddenClass(group);
		}
	}

	/** For 'split', resolves the anchor pane ourselves and calls
	 * `createLeafBySplit` explicitly instead of `getLeaf('split', direction)`
	 * -- the same public API `getLeaf` uses internally (`getLeaf('split', d)`
	 * is just `createLeafBySplit(getMostRecentLeaf(), d)` under the hood), but
	 * going through it directly is one less layer to trust, and matches the
	 * mechanism the workspace drag-and-drop feature already uses successfully. */
	/** Most recent leaf in the main editor, never a side dock or this sidebar. */
	private editorLeaf(): WorkspaceLeaf | undefined {
		const root = this.workspace.rootSplit;
		const recent = this.workspace.getMostRecentLeaf();
		if (recent && recent.getRoot() === root && recent.view.getViewType() !== VIEW_TYPE_WORKING_TABS) return recent;
		let found: WorkspaceLeaf | undefined;
		this.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			if (leaf.getRoot() !== root) return;
			if (leaf.view.getViewType() === VIEW_TYPE_WORKING_TABS) return;
			found = leaf;
		});
		return found;
	}

	/**
	 * Move this group's own leaves into a pane on one edge. A pane already on
	 * that edge is split so the new group sits beside it. Leaves open in some
	 * other group's pane stay where they are.
	 */
	private async dockLeaves(leaves: WorkspaceLeaf[], edge: DockEdge, closed: SpaceNode[] = []): Promise<SplitNode | null> {
		const editor = this.editorLeaf();
		const neighbor = this.findEdgeAnchor(edge, leaves);
		const beside = Boolean(neighbor);
		const orientation: SplitDirectionName =
			edge === 'top' || edge === 'bottom' ? 'horizontal' : 'vertical';
		const before = edge === 'left' || edge === 'top';
		const basis = neighbor ?? (editor && !leaves.includes(editor) ? editor : leaves[0] ?? editor);
		if (!basis && closed.length === 0) return null;
		const anchor = basis ?? this.workspace.getLeaf('tab');
		const placeholder = this.workspace.createLeafBySplit(anchor, orientation, before);
		const tabs = splitNode(placeholder.parent);
		for (const leaf of leaves) {
			if (leaf !== placeholder && leaf.parent !== placeholder.parent) this.reparentLeaf(leaf, tabs);
		}
		for (const tab of closed) {
			const leaf = this.workspace.createLeafInParent(placeholder.parent, 9999);
			await this.openTabInLeaf(leaf, tab);
		}
		if (leaves.length > 0 || closed.length > 0) placeholder.detach();
		if (!beside) this.hoistToEdge(tabs, edge);
		else this.markDock(tabs, edge);
		(this.workspace as unknown as { requestResize?: () => void }).requestResize?.();
		const focus = leaves[0];
		if (focus && focus.parent) this.workspace.setActiveLeaf(focus, { focus: true });
		return tabs;
	}

	/** A pane already sitting on this edge, excluding the leaves being moved. */
	private findEdgeAnchor(edge: DockEdge, moving: WorkspaceLeaf[]): WorkspaceLeaf | undefined {
		const movingSet = new Set(moving);
		const view = this.workspace.containerEl.getBoundingClientRect();
		let best: { leaf: WorkspaceLeaf; score: number } | undefined;
		this.workspace.iterateAllLeaves((leaf) => {
			if (movingSet.has(leaf) || leaf.getRoot() !== this.workspace.rootSplit) return;
			if (leaf.view.getViewType() === VIEW_TYPE_WORKING_TABS) return;
			const el = leaf.view.containerEl.closest('.workspace-tabs');
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const marked = el.hasClass(`working-tabs-dock-${edge}`);
			const thin =
				edge === 'bottom' || edge === 'top'
					? rect.height > 0 && rect.height < view.height * 0.92
					: rect.width > 0 && rect.width < view.width * 0.92;
			const onEdge =
				edge === 'bottom'
					? Math.abs(rect.bottom - view.bottom) < 16
					: edge === 'top'
						? Math.abs(rect.top - view.top) < 16
						: edge === 'left'
							? Math.abs(rect.left - view.left) < 16
							: Math.abs(rect.right - view.right) < 16;
			if (!marked && !(thin && onEdge)) return;
			const score = marked
				? Number.POSITIVE_INFINITY
				: edge === 'bottom'
					? rect.top
					: edge === 'top'
						? -rect.bottom
						: edge === 'left'
							? -rect.right
							: rect.left;
			if (!best || score > best.score) best = { leaf, score };
		});
		return best?.leaf;
	}

	private reparentLeaf(leaf: WorkspaceLeaf, tabs: SplitNode): void {
		const source = splitNode(leaf.parent);
		if (source === tabs) return;
		source.removeChild(splitNode(leaf));
		tabs.insertChild(tabs.children.length, splitNode(leaf));
	}

	/** Put the first pane on an edge. Does not remove a pane that is already there. */
	private hoistToEdge(tabs: SplitNode, edge: DockEdge): void {
		const root = splitNode(this.workspace.rootSplit);
		if (tabs.parent && tabs.parent !== root) tabs.parent.removeChild(tabs);
		const span: SplitDirectionName = edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal';
		const atStart = edge === 'top' || edge === 'left';
		const container = this.ensureRootSpan(root, span);
		container.insertChild(atStart ? 0 : container.children.length, tabs);
		this.markDock(tabs, edge);
	}

	/** Root splits on the axis that separates this edge from the rest of the window. */
	private ensureRootSpan(root: SplitNode, span: SplitDirectionName): SplitNode {
		if (root.direction === span) return root;
		const nested = root.children.length === 1 && root.children[0].direction === span ? root.children[0] : undefined;
		if (nested) return nested;
		const band = this.createSplit(root, span);
		const existing = root.children.slice();
		root.insertChild(0, band);
		for (const child of existing) {
			if (child === band) continue;
			child.parent?.removeChild(child);
			band.insertChild(band.children.length, child);
		}
		return band;
	}

	private createSplit(sibling: SplitNode, direction: SplitDirectionName): SplitNode {
		const Split = sibling.constructor as new (workspace: unknown, direction: SplitDirectionName) => SplitNode;
		return new Split(this.workspace, direction);
	}

	private markDock(tabs: SplitNode, edge: DockEdge): void {
		const el = (tabs as { containerEl?: HTMLElement }).containerEl;
		if (!el) return;
		for (const side of ['left', 'right', 'top', 'bottom'] as const) el.removeClass(`working-tabs-dock-${side}`);
		el.addClass(`working-tabs-dock-${edge}`);
	}

	private paneIdOf(tabs: SplitNode): string | undefined {
		let id: string | undefined;
		this.workspace.iterateAllLeaves((leaf) => {
			if (!id && splitNode(leaf.parent) === tabs) id = getPaneId(leaf);
		});
		return id;
	}

	async dockTab(tab: SpaceNode, edge: DockEdge): Promise<void> {
		await this.dockTabs([tab], edge);
	}

	/** Peels these tabs into one new pane on an edge. The rest of their group stays. */
	async dockTabs(tabs: SpaceNode[], edge: DockEdge): Promise<void> {
		const moving = tabs.filter((tab) => tab.type === 'tab');
		if (moving.length === 0) return;
		const leaves: WorkspaceLeaf[] = [];
		const closed: SpaceNode[] = [];
		for (const tab of moving) {
			const open = tab.tabKey ? this.findOpenLeaf(tab.tabKey) : undefined;
			if (open) leaves.push(open);
			else closed.push(tab);
		}
		const pane = await this.dockLeaves(leaves, edge, closed);
		if (!pane) return;
		const paneId = this.paneIdOf(pane);
		const title = moving.length === 1 ? moving[0].title || this.store.nextDefaultTitle('group') : this.store.nextDefaultTitle('group');
		const group = await this.store.addGroup(title, null);
		if (paneId) await this.store.setHomePane(group.id, paneId);
		for (const tab of moving) {
			await this.store.clearOrigin(tab.id);
			await this.store.moveTabRecord(tab.id, group.id);
		}
	}

	async dockGroup(id: string, edge: DockEdge): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group') return;
		const records = this.store.children(id).filter((tab) => (tab.viewState || tab.filePath) && !tab.done);
		const homeId = group.homePaneId;
		const leaves: WorkspaceLeaf[] = [];
		const closed: SpaceNode[] = [];
		for (const tab of records) {
			const leaf = tab.tabKey ? this.findOpenLeaf(tab.tabKey) : undefined;
			if (leaf && homeId && getPaneId(leaf) === homeId) leaves.push(leaf);
			else closed.push(tab);
		}
		if (leaves.length === 0 && closed.length === 0) return;
		const tabs = await this.dockLeaves(leaves, edge, closed);
		if (!tabs) return;
		const paneId = this.paneIdOf(tabs);
		if (paneId) await this.store.setHomePane(id, paneId);
	}

	/** Open this group in its own pane next to the leaf under the cursor. Does not merge into that leaf's group. */
	async placeGroupBeside(id: string, anchor: WorkspaceLeaf, zone: DockEdge | 'center'): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group') return;
		const anchorPane = getPaneId(anchor);
		if (anchorPane && anchorPane === group.homePaneId) {
			await this.revealGroup(id);
			return;
		}
		const direction: SplitDirectionName =
			zone === 'top' || zone === 'bottom' ? 'horizontal' : 'vertical';
		const before = zone === 'left' || zone === 'top';
		const placeholder = this.workspace.createLeafBySplit(anchor, direction, before);
		const tabs = splitNode(placeholder.parent);
		const records = this.store.children(id).filter((tab) => (tab.viewState || tab.filePath) && !tab.done);
		const homeId = group.homePaneId;
		const leaves: WorkspaceLeaf[] = [];
		const closed: SpaceNode[] = [];
		for (const tab of records) {
			const leaf = tab.tabKey ? this.findOpenLeaf(tab.tabKey) : undefined;
			const inDestination = Boolean(leaf && leaf.parent === placeholder.parent);
			if (inDestination) continue;
			if (leaf && homeId && getPaneId(leaf) === homeId) leaves.push(leaf);
			else closed.push(tab);
		}
		for (const leaf of leaves) this.reparentLeaf(leaf, tabs);
		for (const tab of closed) {
			const leaf = this.workspace.createLeafInParent(placeholder.parent, 9999);
			await this.openTabInLeaf(leaf, tab);
		}
		if (leaves.length > 0 || closed.length > 0) placeholder.detach();
		const paneId = this.paneIdOf(tabs);
		if (paneId) await this.store.setHomePane(id, paneId);
		const focus = leaves[0] ?? this.findLeafInPane(paneId);
		if (focus) {
			this.workspace.setActiveLeaf(focus, { focus: true });
			await this.workspace.revealLeaf(focus);
		}
	}

	/** Reveal a group that is already on screen. An off-screen group opens in its own pane, not into whichever group is current. */
	async showGroup(id: string): Promise<void> {
		if (this.isRendered(id)) {
			await this.openGroup(id);
			return;
		}
		await this.openGroup(id, { mode: 'split', direction: 'vertical' });
	}

	/** Take the group's pane off the screen. The sidebar row stays. */
	async hideGroup(id: string): Promise<void> {
		await this.closeGroup(id);
	}

	private createLeafFor(behavior: OpenBehavior): WorkspaceLeaf {
		switch (behavior.mode) {
			case 'split': {
				const anchor = this.editorLeaf();
				if (anchor) return this.workspace.createLeafBySplit(anchor, behavior.direction ?? 'vertical');
				return this.workspace.getLeaf('split', behavior.direction ?? 'vertical');
			}
			case 'window':
				return this.workspace.getLeaf('window');
			case 'tab':
			default:
				return this.workspace.getLeaf('tab');
		}
	}

	/** Opens a brand-new, empty pane per the chosen placement -- no group
	 * record is created here at all. The next reconcile pass finds the new
	 * pane unclaimed and auto-creates + auto-names its group ("Group N"),
	 * exactly like any other pane opened by hand; this is just the sidebar's
	 * "+ New group" row shortcut for that same, already-existing path. */
	async openNewGroup(behavior: OpenBehavior): Promise<void> {
		const leaf = this.createLeafFor(behavior);
		await leaf.setViewState({ type: 'empty', active: true });
		this.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** viewState works for any view type (terminal, web viewer, canvas, notes
	 * with their scroll/mode preserved) and is preferred whenever present;
	 * plain openFile() is only a fallback for simple file tabs that don't
	 * have one captured. A tab we only know by its view type (a terminal whose
	 * scrollback was not stored, an empty tab) still opens, so Show is not a no-op. */
	private async openTabInLeaf(leaf: WorkspaceLeaf, tab: SpaceNode): Promise<void> {
		const openEmpty = async () => {
			await leaf.setViewState({ type: 'empty', active: true });
		};
		try {
			const stored = tab.viewState as ViewState | undefined;
			if (stored?.type && stored.type !== 'empty') {
				await leaf.setViewState({ ...stored, active: true });
				return;
			}
			if (tab.filePath) {
				const file = this.app.vault.getAbstractFileByPath(tab.filePath);
				if (file instanceof TFile) {
					await leaf.openFile(file);
					return;
				}
			}
			const type = this.viewTypeFromKey(tab.tabKey);
			if (type) {
				await leaf.setViewState({ type, active: true });
				return;
			}
			await openEmpty();
		} catch {
			await openEmpty();
		}
	}

	/** `terminus-view:<leafId>` and similar keys name the view. File paths do not. */
	private viewTypeFromKey(tabKey: string | undefined): string | undefined {
		if (!tabKey) return undefined;
		const type = tabKey.split(':')[0];
		if (!type || type === 'empty' || type.includes('/') || type.includes('.')) return undefined;
		return type;
	}

	/** Whether a group currently has a live pane. */
	isLive(id: string): boolean {
		const group = this.store.find(id);
		return Boolean(group?.homePaneId && this.findLeafInPane(group.homePaneId));
	}

	private findOpenLeaf(tabKey: string | undefined): WorkspaceLeaf | undefined {
		if (!tabKey) return undefined;
		let found: WorkspaceLeaf | undefined;
		this.workspace.iterateAllLeaves((l) => {
			if (!found && this.getTabIdentity(l).key === tabKey) found = l;
		});
		return found;
	}

	/** Clicking a tab in the sidebar should focus that exact tab, not just
	 * whichever one happens to already be active in its pane. Opens the whole
	 * group first if it isn't live yet (or this particular tab isn't open --
	 * e.g. it was just un-done). */
	async focusTab(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId) return;
		const group = this.store.find(tab.parentId);
		const paneId = group?.type === 'group' ? group.homePaneId : undefined;
		let leaf =
			paneId && tab.tabKey
				? this.leavesInPane(paneId).find((item) => this.getTabIdentity(item).key === tab.tabKey)
				: undefined;
		if (!leaf && this.isLive(tab.parentId)) {
			await this.reopenTab(tab);
			const home = this.store.find(tab.parentId);
			leaf =
				home?.type === 'group' && home.homePaneId && tab.tabKey
					? this.leavesInPane(home.homePaneId).find((item) => this.getTabIdentity(item).key === tab.tabKey)
					: undefined;
		}
		if (!leaf) return;
		await leaf.loadIfDeferred();
		this.workspace.setActiveLeaf(leaf, { focus: true });
		await this.workspace.revealLeaf(leaf);
	}

	/** Put this group's tabs into the editor's current tab group. A live group is only revealed. */
	async openInCurrentGroup(id: string): Promise<void> {
		if (this.isLive(id)) {
			await this.openGroup(id);
			return;
		}
		await this.moveGroupIntoCurrentTabGroup(id);
	}

	/** Open this group's tabs in a new pane to the right. Closes the old pane first when it is already live. */
	async openInNewGroup(id: string): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group') return;
		if (group.homePaneId && this.findLeafInPane(group.homePaneId)) await this.closeGroup(id);
		await this.openGroup(id, { mode: 'split', direction: 'vertical' });
	}

	/** Reveals a live group. A dormant group opens only for an explicit placement
	 * (split right, split down, or a new window). Mode `'tab'` does not split. */
	async openGroup(id: string, behaviorOverride?: OpenBehavior): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group') return;

		const focused = this.store.focusedSectionId;
		if (focused && group.parentId !== focused) {
			await this.store.setFocusedSection(null);
		}

		if (group.homePaneId) {
			const leaf = this.findLeafInPane(group.homePaneId);
			if (leaf) {
				await leaf.loadIfDeferred();
				await this.workspace.revealLeaf(leaf);
				return;
			}
		}

		const tabs = this.store.children(id).filter((tab) => tab.type === 'tab' && !tab.done);
		if (tabs.length === 0) return;

		const behavior = behaviorOverride ?? group.openBehavior ?? this.store.settings.defaultOpenBehavior;
		if (!behaviorOverride && behavior.mode === 'tab') return;
		if (behaviorOverride && behaviorOverride.mode !== 'tab') await this.store.setOpenBehavior(id, behaviorOverride);

		const first = this.createLeafFor(behaviorOverride ?? behavior);

		const paneId = getPaneId(first);
		if (paneId) await this.store.setHomePane(id, paneId);

		this.openingGroups.add(id);
		try {
			await this.openTabInLeaf(first, tabs[0]);
			for (const tab of tabs.slice(1)) {
				const leaf = this.workspace.createLeafInParent(first.parent, 9999);
				await this.openTabInLeaf(leaf, tab);
			}
		} finally {
			this.openingGroups.delete(id);
		}

		await this.workspace.revealLeaf(first);
	}

	/** Insert this group's tabs into the editor's current tab group. */
	async moveGroupIntoCurrentTabGroup(sourceId: string): Promise<void> {
		const leaf = this.editorLeaf();
		const paneId = leaf ? getPaneId(leaf) : undefined;
		if (!paneId) return;
		await this.mergeGroupInto(sourceId, paneId);
	}

	/**
	 * Move records into the target group, reopen leaves in its pane, remove the
	 * source, and keep a session receipt for Undo.
	 */
	async mergeGroupInto(sourceId: string, targetPaneId: string): Promise<void> {
		const group = this.store.find(sourceId);
		if (!group || group.type !== 'group') return;
		const owner = this.findOwningGroupByPane(targetPaneId, sourceId);
		if (!owner) return;
		const targetLeaf = this.findLeafInPane(targetPaneId);
		if (!targetLeaf) return;

		const tabs = this.store.children(sourceId).filter((t) => t.type === 'tab');
		if (tabs.length === 0) return;
		const tabIds = tabs.map((t) => t.id);
		const fromSnapshot: SpaceNode = { ...group };

		this.openingGroups.add(sourceId);
		this.openingGroups.add(owner.id);
		try {
			if (group.homePaneId && this.findLeafInPane(group.homePaneId)) await this.closeGroup(sourceId);
			for (const tab of tabs) {
				await this.store.moveTabRecord(tab.id, owner.id);
				const leaf = this.workspace.createLeafInParent(targetLeaf.parent, 9999);
				await this.openTabInLeaf(leaf, tab);
			}
			await this.store.remove(sourceId);
			const receipt = {
				group: fromSnapshot,
				tabIds,
				targetGroupId: owner.id,
				at: Date.now(),
			};
			this.receipts.unshift(receipt);
			if (this.receipts.length > 5) this.receipts.length = 5;
			this.showMergeNotice(fromSnapshot.title, owner.title, receipt);
		} finally {
			this.openingGroups.delete(sourceId);
			this.openingGroups.delete(owner.id);
		}
	}

	/**
	 * Merge one group into another by moving every tab record across, then
	 * removing the source group. Used by drag-and-drop when a group is dropped
	 * onto another group. Works whether either group is live or hibernated:
	 * sendToGroup only opens leaves when the target is live. Keeps the same
	 * Undo receipt as mergeGroupInto.
	 */
	async mergeGroupIntoTarget(sourceId: string, targetId: string): Promise<void> {
		if (sourceId === targetId) return;
		const group = this.store.find(sourceId);
		const target = this.store.find(targetId);
		if (!group || group.type !== 'group') return;
		if (!target || target.type !== 'group') return;
		if (group.parentId === COMPLETED_PARENT_ID || target.parentId === COMPLETED_PARENT_ID) return;

		// Refuse to merge a group into itself or one of its own descendants.
		let cursor: SpaceNode | undefined = target;
		while (cursor) {
			if (cursor.id === sourceId) return;
			cursor = cursor.parentId ? this.store.find(cursor.parentId) : undefined;
		}

		const tabs = this.store.children(sourceId).filter((t) => t.type === 'tab');
		const tabIds = tabs.map((t) => t.id);
		const fromSnapshot: SpaceNode = { ...group };

		this.openingGroups.add(sourceId);
		this.openingGroups.add(target.id);
		try {
			if (group.homePaneId && this.findLeafInPane(group.homePaneId)) await this.closeGroup(sourceId);
			if (tabs.length > 0) await this.sendToGroup(tabs, target.id);
			await this.store.remove(sourceId);
			if (tabs.length === 0) return;
			const receipt = {
				group: fromSnapshot,
				tabIds,
				targetGroupId: target.id,
				at: Date.now(),
			};
			this.receipts.unshift(receipt);
			if (this.receipts.length > 5) this.receipts.length = 5;
			this.showMergeNotice(fromSnapshot.title, target.title, receipt);
		} finally {
			this.openingGroups.delete(sourceId);
			this.openingGroups.delete(target.id);
		}
	}

	private showMergeNotice(
		fromTitle: string,
		toTitle: string,
		receipt: { group: SpaceNode; tabIds: string[]; targetGroupId: string; at: number }
	): void {
		const frag = createFragment();
		frag.appendText(`Moved "${fromTitle}" into "${toTitle}". `);
		const btn = frag.createEl('button', { text: 'Undo', cls: 'mod-cta' });
		const notice = new Notice(frag, 0);
		btn.addEventListener('click', () => {
			notice.hide();
			void this.undoMerge(receipt);
		});
	}

	receiptForTarget(groupId: string): { group: SpaceNode; tabIds: string[]; targetGroupId: string; at: number } | undefined {
		return this.receipts.find((r) => r.targetGroupId === groupId);
	}

	async undoMerge(receipt: {
		group: SpaceNode;
		tabIds: string[];
		targetGroupId: string;
		at: number;
	}): Promise<void> {
		const idx = this.receipts.indexOf(receipt);
		if (idx >= 0) this.receipts.splice(idx, 1);

		const parentOk = receipt.group.parentId ? Boolean(this.store.find(receipt.group.parentId)) : true;
		const restored: SpaceNode = {
			...receipt.group,
			parentId: parentOk ? receipt.group.parentId : null,
			homePaneId: undefined,
			homeLeafId: undefined,
		};
		await this.store.insertGroup(restored);

		const surviving = receipt.tabIds
			.map((id) => this.store.find(id))
			.filter((t): t is SpaceNode => Boolean(t && t.type === 'tab'));

		for (const tab of surviving) {
			await this.closeLiveTabOnly({ ...tab, parentId: receipt.targetGroupId });
			await this.store.moveTabRecord(tab.id, restored.id);
		}

		const targetLeaf = this.findLeafInPane(this.store.find(receipt.targetGroupId)?.homePaneId);
		if (!targetLeaf || surviving.length === 0) {
			new Notice(
				surviving.length === 0
					? `"${restored.title}" restored (no tabs left to reopen).`
					: `"${restored.title}" restored as dormant — target pane was closed.`
			);
			return;
		}

		this.openingGroups.add(restored.id);
		try {
			const first = this.workspace.createLeafBySplit(targetLeaf, 'vertical');
			const paneId = getPaneId(first);
			if (paneId) await this.store.setHomePane(restored.id, paneId);
			await this.openTabInLeaf(first, surviving[0]);
			for (const tab of surviving.slice(1)) {
				const leaf = this.workspace.createLeafInParent(first.parent, 9999);
				await this.openTabInLeaf(leaf, tab);
			}
			await this.workspace.revealLeaf(first);
		} finally {
			this.openingGroups.delete(restored.id);
		}
	}

	/** Moves a tab's record and, when the target group is live, its leaf.
	 * An open leaf is not filed onto a dormant group — that split the record from the pane. */
	async moveTab(tab: SpaceNode, toGroupId: string, index: number): Promise<void> {
		await this.sendToGroup([tab], toGroupId, index);
	}

	/** Files tabs in a section pool. Open leaves stay in the pane they are already in. */
	async sendToPool(tabs: SpaceNode[], sectionId: string): Promise<void> {
		await this.store.batch(async () => {
			for (const tab of tabs) {
				if (tab.type === 'tab') await this.store.parkInPool(tab.id, sectionId);
			}
		});
	}

	/** Sends tabs to a named group, which becomes their home. Does not reveal that pane.
	 * A dormant group receives the record and the open leaf is closed, so the view stays put. */
	async sendToGroup(tabs: SpaceNode[], groupId: string, index?: number): Promise<void> {
		const target = this.store.find(groupId);
		if (!target || target.type !== 'group') return;
		const live = Boolean(target.homePaneId && this.findLeafInPane(target.homePaneId));
		await this.store.batch(async () => {
			let at = index ?? this.store.children(groupId).filter((child) => !tabs.some((tab) => tab.id === child.id)).length;
			for (const tab of tabs) {
				if (tab.type !== 'tab') continue;
				const parent = tab.parentId ? this.store.find(tab.parentId) : undefined;
				if (parent?.type === 'group' && parent.id === groupId) {
					await this.store.moveInto(tab.id, groupId, at);
					at += 1;
					if (live) {
						const updated = this.store.find(tab.id);
						if (updated && this.findOpenLeaf(updated.tabKey)) await this.relocateLiveLeaf(updated);
					}
					continue;
				}
				await this.store.clearOrigin(tab.id);
				if (!live) this.findOpenLeaf(tab.tabKey)?.detach();
				await this.store.moveInto(tab.id, groupId, at);
				at += 1;
				if (!live) continue;
				const updated = this.store.find(tab.id);
				if (!updated) continue;
				const open = this.findOpenLeaf(updated.tabKey);
				if (open && getPaneId(open) === target.homePaneId) continue;
				if (open) await this.relocateLiveLeaf(updated);
				else await this.reopenTab(updated);
			}
		});
	}

	/** Puts pooled tabs back in the groups they left. Does not move leaves. */
	async restoreTabs(tabs: SpaceNode[]): Promise<void> {
		await this.store.batch(async () => {
			for (const tab of tabs) {
				if (tab.type === 'tab') await this.store.restoreOrigin(tab.id);
			}
		});
	}

	/** Show a leaf that is already open. Does not create a pane or move a tab. */
	async revealOpenTab(tab: SpaceNode): Promise<void> {
		const leaf = this.leafForTab(tab);
		if (!leaf) return;
		await leaf.loadIfDeferred();
		this.workspace.setActiveLeaf(leaf, { focus: true });
		await this.workspace.revealLeaf(leaf);
	}

	/** Show a group's pane when it is already on screen. */
	async revealGroup(groupId: string): Promise<void> {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group') return;
		const leaf = this.findLeafInPane(group.homePaneId);
		if (!leaf) return;
		await leaf.loadIfDeferred();
		this.workspace.setActiveLeaf(leaf, { focus: true });
		await this.workspace.revealLeaf(leaf);
	}

	/** The open leaf for this tab, if it is on screen. */
	leafForTab(tab: SpaceNode): WorkspaceLeaf | undefined {
		return tab.tabKey ? this.findOpenLeaf(tab.tabKey) : undefined;
	}

	/** The group that claims the pane this leaf is open in. */
	groupForLeaf(leaf: WorkspaceLeaf): SpaceNode | undefined {
		return this.findOwningGroupByPane(getPaneId(leaf));
	}

	async moveTabToNewGroup(tab: SpaceNode, direction: 'vertical' | 'horizontal'): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId) return;
		const source = this.store.find(tab.parentId);
		const anchor =
			(source?.type === 'group' ? this.findLeafInPane(source.homePaneId) : undefined) ??
			this.findOpenLeaf(tab.tabKey) ??
			this.editorLeaf();
		if (!anchor) return;

		const group = await this.store.addGroup(this.store.nextDefaultTitle('group'), null);
		this.openingGroups.add(group.id);
		try {
			const first = this.workspace.createLeafBySplit(anchor, direction);
			const paneId = getPaneId(first);
			if (paneId) await this.store.setHomePane(group.id, paneId);
			await this.store.moveInto(tab.id, group.id, 0);
			if (this.findOpenLeaf(tab.tabKey)) {
				const updated = this.store.find(tab.id);
				if (updated) await this.relocateLiveLeaf(updated);
			} else {
				await this.openTabInLeaf(first, tab);
			}
			await this.workspace.revealLeaf(first);
		} finally {
			this.openingGroups.delete(group.id);
		}
	}

	/** Closes a group's live pane (all sibling leaves in it), without touching stored data. */
	async closeGroup(id: string): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group' || !group.homePaneId) return;
		for (const sibling of this.leavesInPane(group.homePaneId)) sibling.detach();
		await this.store.setHomePane(id, undefined);
	}

	async completeGroup(id: string): Promise<void> {
		await this.closeGroup(id);
		await this.store.complete(id);
	}

	/** Bring this section's live tab groups forward. Does not hide anything else. */
	async revealSection(sectionId: string): Promise<void> {
		await this.store.setFocusedSection(sectionId);
		for (const child of this.store.children(sectionId)) {
			if (child.type !== 'group' || !child.homePaneId) continue;
			const leaf = this.findLeafInPane(child.homePaneId);
			if (leaf) await this.workspace.revealLeaf(leaf);
		}
	}

	isStacked(groupId: string): boolean {
		const group = this.store.find(groupId);
		const leaf = group?.type === 'group' ? this.findLeafInPane(group.homePaneId) : undefined;
		return Boolean((leaf?.parent as { isStacked?: boolean } | undefined)?.isStacked);
	}

	async toggleStacked(groupId: string): Promise<void> {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group') return;
		const leaf = this.findLeafInPane(group.homePaneId);
		const parent = leaf?.parent as { isStacked?: boolean; setStacked?: (stacked: boolean) => void } | undefined;
		if (!parent || typeof parent.setStacked !== 'function') return;
		parent.setStacked(!parent.isStacked);
	}

	/** Opens a blank tab in a live group's pane -- the sidebar's stand-in for
	 * Obsidian's native "+" button, which lives in the tab-header row the
	 * "Hide tab bar" setting hides. Not open yet -- if it's dormant in a
	 * section, use "Open" first. */
	async addBlankTab(groupId: string): Promise<void> {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group') return;
		const homeLeaf = this.findLeafInPane(group.homePaneId);
		if (!homeLeaf) return;
		const leaf = this.workspace.createLeafInParent(homeLeaf.parent, 9999);
		await leaf.setViewState({ type: 'empty', active: true });
		this.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** Detaches this tab's leaf only when it is open in this tab's own group.
	 * A hibernating copy of the same file must not close the leaf that belongs
	 * to another group. */
	async closeLiveTabOnly(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.tabKey) return;
		const group = tab.parentId ? this.store.find(tab.parentId) : undefined;
		if (group?.type !== 'group' || !group.homePaneId) return;
		const match = this.leavesInPane(group.homePaneId).find(
			(leaf) => this.getTabIdentity(leaf).key === tab.tabKey
		);
		match?.detach();
	}

	/** How many of `tab`'s siblings (by stored order) currently have a live
	 * leaf in `groupId`'s pane -- the correct index to insert/reposition
	 * `tab` at, so it lands where it actually belongs instead of at the end. */
	private countLiveSiblingsBefore(groupId: string, tab: SpaceNode, excludeTabId?: string): number {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group' || !group.homePaneId) return 0;
		const openKeys = new Set(this.leavesInPane(group.homePaneId).map((l) => this.getTabIdentity(l).key));
		return this.store
			.children(groupId)
			.filter((s) => s.id !== excludeTabId && s.order < tab.order && s.tabKey && openKeys.has(s.tabKey))
			.length;
	}

	/** Reopens one specific tab into its group's live pane (e.g. after
	 * unchecking "done"), at the position it actually belongs among its
	 * currently-open siblings -- not just appended at the end. Does nothing
	 * if the group isn't currently live; the tab will simply show up normally
	 * next time the whole group opens. */
	async reopenTab(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId) return;
		const group = this.store.find(tab.parentId);
		if (group?.type !== 'group' || !group.homePaneId) return;
		const homeLeaf = this.findLeafInPane(group.homePaneId);
		if (!homeLeaf) return;
		const index = this.countLiveSiblingsBefore(group.id, tab);
		const leaf = this.workspace.createLeafInParent(homeLeaf.parent, index);
		await this.openTabInLeaf(leaf, tab);
	}

	/**
	 * Repositions a tab's already-open leaf to match where it now sits in the
	 * sidebar (after a drag-to-reorder, or a drag into a different group) --
	 * relocating it between panes too if the group it was dropped into isn't
	 * the one it was already open in.
	 *
	 * Obsidian has no public API for repositioning an already-open leaf, so
	 * this uses the same undocumented `WorkspaceParent.removeChild`/
	 * `insertChild`/`selectTabIndex` internals the Vertical Tabs plugin relies
	 * on for its own tab reordering. Guarded with an existence check so it
	 * quietly no-ops instead of throwing if a future Obsidian version removes
	 * or renames them.
	 */
	async relocateLiveLeaf(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId || !tab.tabKey) return;
		const group = this.store.find(tab.parentId);
		if (!group || group.type !== 'group' || !group.homePaneId) return;
		const homeLeaf = this.findLeafInPane(group.homePaneId);
		if (!homeLeaf) return;
		const targetContainer = homeLeaf.parent;

		const sourceLeaf = this.findOpenLeaf(tab.tabKey);
		if (!sourceLeaf) return;

		const index = this.countLiveSiblingsBefore(group.id, tab, tab.id);
		const source = sourceLeaf.parent as unknown as { removeChild?: (leaf: WorkspaceLeaf) => void };
		const target = targetContainer as unknown as {
			insertChild?: (index: number, leaf: WorkspaceLeaf) => void;
			selectTabIndex?: (index: number) => void;
		};
		if (typeof source.removeChild !== 'function' || typeof target.insertChild !== 'function') return;

		source.removeChild(sourceLeaf);
		target.insertChild(index, sourceLeaf);
		target.selectTabIndex?.(index);
		(this.workspace as unknown as { requestResize?: () => void }).requestResize?.();
	}

	/** Closes one specific tab: detaches its live leaf and forgets it, same as
	 * closing a browser tab. Without the detach half, "removing" a tab that's
	 * still genuinely open would just have reconcile() re-add it right back
	 * under Unsorted on the next pass. */
	async closeTab(tab: SpaceNode): Promise<void> {
		await this.closeLiveTabOnly(tab);
		await this.store.remove(tab.id);
		if (tab.parentId) await this.removeGroupIfEmpty(tab.parentId);
	}

	/** A group left with nothing at all -- no live tabs, no done ones kept on
	 * purpose -- has no reason to keep occupying the sidebar. Used after any
	 * plugin-initiated tab removal; reconcile's own step 1 handles the same
	 * cleanup for tabs closed natively in Obsidian. */
	private async removeGroupIfEmpty(groupId: string): Promise<void> {
		const group = this.store.find(groupId);
		if (group?.type === 'group' && this.store.children(groupId).length === 0) {
			await this.store.remove(groupId);
		}
	}
}
