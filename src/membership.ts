import type { SpaceNode } from './types';
import { COMPLETED_PARENT_ID } from './types';

/** Minimal view-state shape used by blank-tab detection -- avoids importing Obsidian. */
export type PlanViewState = { type?: string; state?: Record<string, unknown> };

export interface TabIdentity {
	key: string;
	path?: string;
	title: string;
}

export interface SnapshotLeaf {
	leafId: string;
	identity: TabIdentity;
	viewState?: PlanViewState;
}

export interface SnapshotPane {
	paneId: string;
	leaves: SnapshotLeaf[];
}

export interface WorkspaceSnapshot {
	panes: SnapshotPane[];
}

export interface PlanContext {
	mode: 'full' | 'poll';
	focusedSectionId: string | null;
	suppressedGroupIds: ReadonlySet<string>;
	nextDefaultTitle: () => string;
}

export type PlanEntry =
	| { kind: 'claimPane'; groupId: string; paneId: string }
	| { kind: 'releasePane'; groupId: string }
	| { kind: 'syncTitle'; tabId: string; title: string }
	| { kind: 'syncViewState'; tabId: string; viewState: PlanViewState }
	| { kind: 'setOrder'; tabId: string; order: number }
	| { kind: 'moveTabRecord'; tabId: string; fromGroupId: string; toGroupId: string }
	| { kind: 'addTab'; groupId: string; key: string; path?: string; title: string; viewState?: PlanViewState }
	| { kind: 'pruneTab'; tabId: string }
	| { kind: 'newGroup'; paneId: string; parentId: string | null; title: string }
	| { kind: 'merged'; fromGroup: SpaceNode; toGroupId: string; tabIds: string[] }
	| { kind: 'removeGroup'; groupId: string };

/** Provisional groupId on addTab entries that follow a newGroup for the same pane. */
export function pendingGroupId(paneId: string): string {
	return `__new__:${paneId}`;
}

/** A tab with nothing to restore -- a blank "New tab" pane. */
export function isBlankTab(tab: SpaceNode): boolean {
	if (tab.filePath) return false;
	const type = (tab.viewState as PlanViewState | undefined)?.type;
	return !type || type === 'empty';
}

/** Pure D12 hide rule — group flag, section flag, or outside focused section. */
export function effectivelyHidden(
	group: Pick<SpaceNode, 'hidden' | 'parentId'>,
	section: Pick<SpaceNode, 'hidden'> | undefined,
	focusedSectionId: string | null
): boolean {
	if (group.hidden) return true;
	if (section?.hidden) return true;
	if (focusedSectionId && group.parentId !== focusedSectionId) return true;
	return false;
}

function childrenOf(nodes: SpaceNode[], parentId: string): SpaceNode[] {
	return nodes
		.filter((n) => n.parentId === parentId)
		.sort((a, b) => a.order - b.order);
}

/**
 * Pure membership plan: workspace snapshot + store nodes → ordered PlanEntry list.
 * No Obsidian imports; LeafSync applies the result inside one store.batch.
 */
export function plan(
	snapshot: WorkspaceSnapshot,
	nodes: SpaceNode[],
	ctx: PlanContext
): PlanEntry[] {
	const entries: PlanEntry[] = [];
	const paneById = new Map(snapshot.panes.map((p) => [p.paneId, p]));
	const paneIds = new Set(paneById.keys());

	const tabs = nodes.filter((n) => n.type === 'tab');
	const tabByKey = new Map<string, SpaceNode>();
	for (const tab of tabs) {
		if (tab.tabKey) tabByKey.set(tab.tabKey, tab);
	}

	const groups = nodes.filter((n) => n.type === 'group' && n.parentId !== COMPLETED_PARENT_ID);

	// Effective parent of each tab after moves emitted this pass (pure — no node mutation).
	const effectiveParent = new Map<string, string>();
	for (const tab of tabs) {
		if (tab.parentId) effectiveParent.set(tab.id, tab.parentId);
	}

	const claimByGroup = new Map<string, string>();
	const claimByPane = new Map<string, string>();
	for (const g of groups) {
		if (g.homePaneId && paneIds.has(g.homePaneId)) {
			claimByGroup.set(g.id, g.homePaneId);
			claimByPane.set(g.homePaneId, g.id);
		}
	}

	const movedOut = new Map<string, { toGroupId: string; tabIds: string[] }>();
	const movedTabIds = new Set<string>();

	// 1. Live sync
	for (const pane of snapshot.panes) {
		for (const leaf of pane.leaves) {
			const tab = tabByKey.get(leaf.identity.key);
			if (!tab) continue;
			entries.push({ kind: 'syncTitle', tabId: tab.id, title: leaf.identity.title });
			if (ctx.mode === 'full' && leaf.viewState) {
				entries.push({ kind: 'syncViewState', tabId: tab.id, viewState: leaf.viewState });
			}
		}
	}

	// 2. Claims — keep / release
	for (const g of groups) {
		if (!g.homePaneId) continue;
		if (paneIds.has(g.homePaneId)) {
			entries.push({ kind: 'claimPane', groupId: g.id, paneId: g.homePaneId });
		} else {
			entries.push({ kind: 'releasePane', groupId: g.id });
			claimByGroup.delete(g.id);

			let survivors = 0;
			for (const tab of childrenOf(nodes, g.id)) {
				if (!tab.done && isBlankTab(tab)) {
					entries.push({ kind: 'pruneTab', tabId: tab.id });
				} else {
					survivors++;
				}
			}
			if (survivors === 0) {
				entries.push({ kind: 'removeGroup', groupId: g.id });
			}
		}
	}

	// 3. Reattach (D7) — every non-done tab key present in the unclaimed pane
	const reattachCandidates = groups.filter(
		(g) => !claimByGroup.has(g.id) && g.parentId !== COMPLETED_PARENT_ID
	);

	for (const pane of snapshot.panes) {
		if (claimByPane.has(pane.paneId)) continue;
		const paneKeys = new Set(pane.leaves.map((l) => l.identity.key));
		for (const g of reattachCandidates) {
			if (claimByGroup.has(g.id)) continue;
			const nonDone = childrenOf(nodes, g.id).filter((t) => !t.done && t.tabKey);
			if (nonDone.length === 0) continue;
			if (!nonDone.every((t) => paneKeys.has(t.tabKey as string))) continue;
			entries.push({ kind: 'claimPane', groupId: g.id, paneId: pane.paneId });
			claimByGroup.set(g.id, pane.paneId);
			claimByPane.set(pane.paneId, g.id);
			break;
		}
	}

	// 4. Mirror (D1) — moves/adds for every claimed pane first, then prunes/order.
	// Two passes so a swap between live panes never prune+adds the same key.
	const mirrorTargets: Array<{ paneId: string; groupId: string }> = [];
	for (const [paneId, groupId] of claimByPane) {
		if (ctx.suppressedGroupIds.has(groupId)) continue;
		mirrorTargets.push({ paneId, groupId });
	}

	for (const { paneId, groupId } of mirrorTargets) {
		const pane = paneById.get(paneId);
		if (!pane) continue;

		for (const leaf of pane.leaves) {
			const key = leaf.identity.key;
			const existing = tabByKey.get(key);
			if (!existing) {
				entries.push({
					kind: 'addTab',
					groupId,
					key,
					path: leaf.identity.path,
					title: leaf.identity.title,
					viewState: leaf.viewState,
				});
				continue;
			}

			const fromId = effectiveParent.get(existing.id);
			if (fromId === groupId) continue;

			const fromGroup = fromId ? groups.find((n) => n.id === fromId) : undefined;
			const fromIsLive = Boolean(fromGroup && claimByGroup.has(fromGroup.id));

			if (fromIsLive && fromGroup) {
				entries.push({
					kind: 'moveTabRecord',
					tabId: existing.id,
					fromGroupId: fromGroup.id,
					toGroupId: groupId,
				});
				movedTabIds.add(existing.id);
				effectiveParent.set(existing.id, groupId);

				const bucket = movedOut.get(fromGroup.id) ?? { toGroupId: groupId, tabIds: [] };
				if (bucket.tabIds.length > 0 && bucket.toGroupId !== groupId) {
					bucket.toGroupId = '';
				} else {
					bucket.toGroupId = groupId;
				}
				bucket.tabIds.push(existing.id);
				movedOut.set(fromGroup.id, bucket);
			} else {
				// Dormant (or unknown) source — leave that list alone; add here.
				entries.push({
					kind: 'addTab',
					groupId,
					key,
					path: leaf.identity.path,
					title: leaf.identity.title,
					viewState: leaf.viewState,
				});
			}
		}
	}

	for (const { paneId, groupId } of mirrorTargets) {
		const pane = paneById.get(paneId);
		if (!pane) continue;
		const paneKeys = pane.leaves.map((l) => l.identity.key);
		const paneKeySet = new Set(paneKeys);

		for (const tab of childrenOf(nodes, groupId)) {
			if (tab.done) continue;
			if (effectiveParent.get(tab.id) !== groupId) continue;
			if (movedTabIds.has(tab.id)) continue;
			if (!tab.tabKey || !paneKeySet.has(tab.tabKey)) {
				entries.push({ kind: 'pruneTab', tabId: tab.id });
			}
		}

		const liveTabs: SpaceNode[] = [];
		const seen = new Set<string>();
		for (const key of paneKeys) {
			const tab = tabByKey.get(key);
			if (!tab || seen.has(tab.id)) continue;
			if (effectiveParent.get(tab.id) !== groupId) continue;
			liveTabs.push(tab);
			seen.add(tab.id);
		}
		const rest = childrenOf(nodes, groupId).filter(
			(t) => effectiveParent.get(t.id) === groupId && !seen.has(t.id)
		);
		let order = 0;
		for (const tab of [...liveTabs, ...rest]) {
			entries.push({ kind: 'setOrder', tabId: tab.id, order: order++ });
		}
	}

	// 5. Merge detection (D3) — H ends with zero non-done tabs, all moved to a single G
	for (const g of groups) {
		if (!claimByGroup.has(g.id) && !g.homePaneId) continue;
		const move = movedOut.get(g.id);
		if (!move || !move.toGroupId || move.tabIds.length === 0) continue;

		const nonDoneRemaining = tabs.filter(
			(t) => !t.done && effectiveParent.get(t.id) === g.id
		);
		if (nonDoneRemaining.length > 0) continue;

		const paneId = claimByGroup.get(g.id);
		if (paneId) {
			entries.push({ kind: 'releasePane', groupId: g.id });
			claimByGroup.delete(g.id);
			claimByPane.delete(paneId);
		}
		entries.push({
			kind: 'merged',
			fromGroup: { ...g },
			toGroupId: move.toGroupId,
			tabIds: [...move.tabIds],
		});
		entries.push({ kind: 'removeGroup', groupId: g.id });
	}

	// 6. New groups for still-unclaimed panes
	for (const pane of snapshot.panes) {
		if (claimByPane.has(pane.paneId)) continue;
		entries.push({
			kind: 'newGroup',
			paneId: pane.paneId,
			parentId: ctx.focusedSectionId,
			title: ctx.nextDefaultTitle(),
		});
		const gid = pendingGroupId(pane.paneId);
		for (const leaf of pane.leaves) {
			entries.push({
				kind: 'addTab',
				groupId: gid,
				key: leaf.identity.key,
				path: leaf.identity.path,
				title: leaf.identity.title,
				viewState: leaf.viewState,
			});
		}
		claimByPane.set(pane.paneId, gid);
	}

	return entries;
}
