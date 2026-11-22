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

/** Stored hide flags only. Focus does not hide panes — that pulled flex items out of Obsidian's split tree. */
export function effectivelyHidden(
	group: Pick<SpaceNode, 'hidden'>,
	section: Pick<SpaceNode, 'hidden'> | undefined
): boolean {
	if (group.hidden) return true;
	if (section?.hidden) return true;
	return false;
}

function isSessionKey(key: string): boolean {
	return key.includes(':') && !key.includes('/');
}

function isAutoGroupTitle(title: string): boolean {
	return /^Group \d+$/.test(title);
}

function tabKeysOf(nodes: SpaceNode[], groupId: string): Set<string> {
	return new Set(
		childrenOf(nodes, groupId)
			.filter((tab) => !tab.done && tab.tabKey)
			.map((tab) => tab.tabKey as string)
	);
}

/** Best dormant group whose stored files cover this pane. Session-only leaves do not block a match. */
function bestClaim(
	nodes: SpaceNode[],
	paneKeys: string[],
	candidates: SpaceNode[],
	taken: Map<string, string>
): { id: string; overlap: number } | undefined {
	let best: { id: string; overlap: number } | undefined;
	for (const group of candidates) {
		if (taken.has(group.id)) continue;
		const keys = tabKeysOf(nodes, group.id);
		if (keys.size === 0) continue;
		const fileKeys = paneKeys.filter((key) => !isSessionKey(key));
		if (fileKeys.some((key) => !keys.has(key))) continue;
		const overlap = paneKeys.filter((key) => keys.has(key)).length;
		if (overlap === 0) continue;
		if (!best || overlap > best.overlap) best = { id: group.id, overlap };
	}
	return best;
}

/** A tab filed in a section pool. Its leaf may still be open; the record stays put. */
function isSectionPool(nodes: SpaceNode[], tab: SpaceNode): boolean {
	if (tab.type !== 'tab' || !tab.parentId) return false;
	return nodes.some((node) => node.id === tab.parentId && node.type === 'section');
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

	const addedThisPass = new Set<string>();
	const hasKey = (groupId: string, key: string): boolean => {
		if (addedThisPass.has(`${groupId}\0${key}`)) return true;
		return childrenOf(nodes, groupId).some((tab) => tab.type === 'tab' && tab.tabKey === key);
	};
	const rememberKey = (groupId: string, key: string): void => {
		addedThisPass.add(`${groupId}\0${key}`);
	};
	const movedOut = new Map<string, { toGroupId: string; tabIds: string[] }>();
	const movedTabIds = new Set<string>();

	// 1. Live sync
	for (const pane of snapshot.panes) {
		for (const leaf of pane.leaves) {
			const tab = tabByKey.get(leaf.identity.key);
			if (!tab) continue;
			if (!tab.titleOverridden && tab.title !== leaf.identity.title) {
				entries.push({ kind: 'syncTitle', tabId: tab.id, title: leaf.identity.title });
			}
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

	// 3. Reattach. After a restart the pane id is gone and some of the group's
	// tabs may not have been restored yet. Claim the pane when every file in it
	// already belongs to one dormant group. A new session-only leaf (terminal
	// leaf ids change every launch) does not block that. Do not prune the
	// group's other stored tabs on this pass.
	const reattachCandidates = groups.filter(
		(g) => !claimByGroup.has(g.id) && g.parentId !== COMPLETED_PARENT_ID
	);
	const freshClaims = new Set<string>();

	for (const pane of snapshot.panes) {
		if (claimByPane.has(pane.paneId)) continue;
		const best = bestClaim(
			nodes,
			pane.leaves.map((leaf) => leaf.identity.key),
			reattachCandidates,
			claimByGroup
		);
		if (!best) continue;
		entries.push({ kind: 'claimPane', groupId: best.id, paneId: pane.paneId });
		claimByGroup.set(best.id, pane.paneId);
		claimByPane.set(pane.paneId, best.id);
		freshClaims.add(best.id);
	}

	// A pane already claimed by an automatic "Group N" goes back to the named
	// group that actually owns those files. Those automatic groups are what a
	// failed reattach left behind.
	for (const [paneId, groupId] of [...claimByPane.entries()]) {
		const owner = groups.find((group) => group.id === groupId);
		if (!owner || !isAutoGroupTitle(owner.title)) continue;
		const pane = paneById.get(paneId);
		if (!pane) continue;
		const paneKeys = pane.leaves.map((leaf) => leaf.identity.key);
		const better = bestClaim(
			nodes,
			paneKeys,
			groups.filter((group) => group.id !== groupId && !isAutoGroupTitle(group.title)),
			claimByGroup
		);
		if (!better) continue;
		const ownerKeys = tabKeysOf(nodes, owner.id);
		const ownerOverlap = paneKeys.filter((key) => ownerKeys.has(key)).length;
		if (better.overlap < ownerOverlap) continue;
		entries.push({ kind: 'releasePane', groupId });
		entries.push({ kind: 'claimPane', groupId: better.id, paneId });
		claimByGroup.delete(groupId);
		claimByGroup.set(better.id, paneId);
		claimByPane.set(paneId, better.id);
		freshClaims.add(better.id);
	}

	// A live group whose pane is gone, and whose non-done tabs all sit in one
	// remaining claimed pane, moves those records instead of copying them.
	// The snapshot has no empty pane, so the later merge step never sees this.
	for (const g of groups) {
		if (claimByGroup.has(g.id) || !g.homePaneId) continue;
		const nonDone = childrenOf(nodes, g.id).filter((t) => !t.done && t.tabKey);
		if (nonDone.length === 0) continue;
		const hosts = snapshot.panes.filter((pane) => {
			const keys = new Set(pane.leaves.map((l) => l.identity.key));
			return nonDone.every((t) => keys.has(t.tabKey as string));
		});
		if (hosts.length !== 1) continue;
		const hostId = claimByPane.get(hosts[0].paneId);
		if (!hostId || hostId === g.id) continue;
		const tabIds: string[] = [];
		for (const tab of nonDone) {
			entries.push({
				kind: 'moveTabRecord',
				tabId: tab.id,
				fromGroupId: g.id,
				toGroupId: hostId,
			});
			movedTabIds.add(tab.id);
			effectiveParent.set(tab.id, hostId);
			tabIds.push(tab.id);
		}
		entries.push({
			kind: 'merged',
			fromGroup: { ...g },
			toGroupId: hostId,
			tabIds,
		});
		entries.push({ kind: 'removeGroup', groupId: g.id });
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
				if (hasKey(groupId, key)) continue;
				rememberKey(groupId, key);
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

			if (isSectionPool(nodes, existing)) continue;

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
				// Dormant (or unknown) source — leave that list alone; add here
				// unless this group already has the same tab.
				if (hasKey(groupId, key)) continue;
				rememberKey(groupId, key);
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
			if (freshClaims.has(groupId)) continue;
			if (tab.done) continue;
			if (effectiveParent.get(tab.id) !== groupId) continue;
			if (movedTabIds.has(tab.id)) continue;
			if (tab.tabKey && paneKeySet.has(tab.tabKey)) continue;
			// A note that is not open yet still belongs to the group. Dropping it
			// here is what erased stored tabs when a hibernated group was given a pane.
			if (!isBlankTab(tab)) continue;
			entries.push({ kind: 'pruneTab', tabId: tab.id });
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
			if (tab.order !== order) entries.push({ kind: 'setOrder', tabId: tab.id, order });
			order += 1;
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

	// 6. New groups for still-unclaimed panes.
	// A leaf whose record sits in a section pool stays that record. It does not
	// spawn another tab, and a pane of only pooled leaves does not spawn a group.
	for (const pane of snapshot.panes) {
		if (claimByPane.has(pane.paneId)) continue;
		const freshLeaves = pane.leaves.filter((leaf) => {
			const existing = tabByKey.get(leaf.identity.key);
			return !(existing && isSectionPool(nodes, existing));
		});
		if (freshLeaves.length === 0) continue;
		entries.push({
			kind: 'newGroup',
			paneId: pane.paneId,
			parentId: null,
			title: ctx.nextDefaultTitle(),
		});
		const gid = pendingGroupId(pane.paneId);
		const seen = new Set<string>();
		for (const leaf of freshLeaves) {
			if (seen.has(leaf.identity.key)) continue;
			seen.add(leaf.identity.key);
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

	// One tab key, one row, inside a single group. Keep the record membership
	// already resolved (tabByKey) and drop the extra copies.
	for (const group of groups) {
		const keeper = new Map<string, string>();
		for (const tab of childrenOf(nodes, group.id)) {
			if (!tab.tabKey) continue;
			const kept = keeper.get(tab.tabKey);
			if (!kept) {
				keeper.set(tab.tabKey, tab.id);
				continue;
			}
			const resolved = tabByKey.get(tab.tabKey)?.id;
			if (resolved === tab.id) {
				entries.push({ kind: 'pruneTab', tabId: kept });
				keeper.set(tab.tabKey, tab.id);
			} else {
				entries.push({ kind: 'pruneTab', tabId: tab.id });
			}
		}
	}

	return entries;
}
