import { describe, expect, it } from 'vitest';
import type { SpaceNode } from './types';
import {
	effectivelyHidden,
	plan,
	type PlanContext,
	type PlanEntry,
	type WorkspaceSnapshot,
} from './membership';

function tab(
	id: string,
	parentId: string,
	key: string,
	opts: Partial<SpaceNode> = {}
): SpaceNode {
	return {
		id,
		type: 'tab',
		title: opts.title ?? key,
		parentId,
		order: opts.order ?? 0,
		tabKey: key,
		filePath: opts.filePath ?? (key.includes(':') ? undefined : key),
		viewState: opts.viewState,
		done: opts.done,
		titleOverridden: opts.titleOverridden,
	};
}

function group(id: string, opts: Partial<SpaceNode> = {}): SpaceNode {
	return {
		id,
		type: 'group',
		title: opts.title ?? id,
		parentId: opts.parentId ?? null,
		order: opts.order ?? 0,
		homePaneId: opts.homePaneId,
		hidden: opts.hidden,
	};
}

function section(id: string): SpaceNode {
	return { id, type: 'section', title: id, parentId: null, order: 0 };
}

function snap(panes: WorkspaceSnapshot['panes']): WorkspaceSnapshot {
	return { panes };
}

function pane(
	paneId: string,
	leaves: Array<{ key: string; title?: string; path?: string; viewState?: { type?: string } }>
) {
	return {
		paneId,
		leaves: leaves.map((l, i) => ({
			leafId: `${paneId}-leaf-${i}`,
			identity: {
				key: l.key,
				path: l.path ?? (l.key.includes(':') ? undefined : l.key),
				title: l.title ?? l.key,
			},
			viewState: l.viewState,
		})),
	};
}

function ctx(partial: Partial<PlanContext> = {}): PlanContext {
	let n = 0;
	return {
		mode: 'full',
		focusedSectionId: null,
		suppressedGroupIds: new Set(),
		nextDefaultTitle: () => `Group ${++n}`,
		...partial,
	};
}

function kinds(entries: PlanEntry[]): string[] {
	return entries.map((e) => e.kind);
}

function ofKind<K extends PlanEntry['kind']>(entries: PlanEntry[], kind: K): Extract<PlanEntry, { kind: K }>[] {
	return entries.filter((e): e is Extract<PlanEntry, { kind: K }> => e.kind === kind);
}

describe('plan()', () => {
	it('reattaches a dormant group when the open pane is part of its tab list', () => {
		const nodes = [
			group('g1'),
			tab('t1', 'g1', 'a.md', { order: 0 }),
			tab('t2', 'g1', 'b.md', { order: 1 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'claimPane')).toEqual([{ kind: 'claimPane', groupId: 'g1', paneId: 'p1' }]);
		expect(ofKind(entries, 'newGroup')).toHaveLength(0);
		expect(ofKind(entries, 'pruneTab')).toHaveLength(0);
	});

	it('leaves dormant intact and creates a new group when the pane has a foreign file', () => {
		const nodes = [
			group('g1'),
			tab('t1', 'g1', 'a.md', { order: 0 }),
			tab('t2', 'g1', 'b.md', { order: 1 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }, { key: 'c.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'claimPane').filter((e) => e.groupId === 'g1')).toHaveLength(0);
		expect(ofKind(entries, 'newGroup')).toEqual([
			{ kind: 'newGroup', paneId: 'p1', parentId: null, title: 'Group 1' },
		]);
		expect(ofKind(entries, 'pruneTab').filter((e) => e.tabId === 't1' || e.tabId === 't2')).toHaveLength(0);
	});

	it('gives a pane back from an automatic Group N to the named group', () => {
		const nodes = [
			group('auto', { title: 'Group 13', homePaneId: 'p1' }),
			tab('live', 'auto', 'a.md'),
			group('named', { title: 'External Services' }),
			tab('kept', 'named', 'a.md'),
			tab('also', 'named', 'b.md'),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'releasePane').some((entry) => entry.groupId === 'auto')).toBe(true);
		expect(ofKind(entries, 'claimPane')).toContainEqual({ kind: 'claimPane', groupId: 'named', paneId: 'p1' });
		expect(ofKind(entries, 'newGroup')).toHaveLength(0);
		expect(ofKind(entries, 'pruneTab').some((entry) => entry.tabId === 'also')).toBe(false);
	});

	it('moves a tab record between live groups without destroy/recreate; done sibling not pruned', () => {
		const nodes = [
			group('gA', { homePaneId: 'pA' }),
			group('gB', { homePaneId: 'pB' }),
			tab('t1', 'gA', 'a.md', { order: 0 }),
			tab('tKeep', 'gA', 'keep.md', { order: 1 }),
			tab('tDone', 'gA', 'done.md', { order: 2, done: true }),
			tab('t3', 'gB', 'c.md', { order: 0 }),
		];
		// Only a.md dragged into B; keep.md stays in A so this is not a full merge
		const entries = plan(
			snap([pane('pA', [{ key: 'keep.md' }]), pane('pB', [{ key: 'c.md' }, { key: 'a.md' }])]),
			nodes,
			ctx()
		);

		expect(ofKind(entries, 'moveTabRecord')).toEqual([
			{ kind: 'moveTabRecord', tabId: 't1', fromGroupId: 'gA', toGroupId: 'gB' },
		]);
		expect(ofKind(entries, 'addTab').some((e) => e.key === 'a.md')).toBe(false);
		expect(ofKind(entries, 'pruneTab').find((e) => e.tabId === 'tDone')).toBeUndefined();
		expect(ofKind(entries, 'merged')).toHaveLength(0);
		expect(ofKind(entries, 'removeGroup')).toHaveLength(0);
	});

	it('emits merged + removeGroup when every non-done tab of H moves to G', () => {
		const nodes = [
			group('H', { homePaneId: 'pH', title: 'Source' }),
			group('G', { homePaneId: 'pG', title: 'Target' }),
			tab('t1', 'H', 'x.md', { order: 0 }),
			tab('t2', 'H', 'y.md', { order: 1 }),
			tab('t3', 'G', 'z.md', { order: 0 }),
		];
		const entries = plan(
			snap([pane('pH', []), pane('pG', [{ key: 'z.md' }, { key: 'x.md' }, { key: 'y.md' }])]),
			nodes,
			ctx()
		);
		const merged = ofKind(entries, 'merged');
		expect(merged).toHaveLength(1);
		expect(merged[0].fromGroup.id).toBe('H');
		expect(merged[0].toGroupId).toBe('G');
		expect(merged[0].tabIds.sort()).toEqual(['t1', 't2']);
		expect(kinds(entries).includes('removeGroup')).toBe(true);
	});

	it('releases a group when its pane disappears and keeps non-blank tab list', () => {
		const nodes = [
			group('g1', { homePaneId: 'pGone' }),
			tab('t1', 'g1', 'a.md', { order: 0 }),
			tab('tBlank', 'g1', 'empty:1', {
				order: 1,
				filePath: undefined,
				viewState: { type: 'empty' },
			}),
		];
		const entries = plan(snap([]), nodes, ctx());
		expect(ofKind(entries, 'releasePane')).toEqual([{ kind: 'releasePane', groupId: 'g1' }]);
		expect(ofKind(entries, 'pruneTab').some((e) => e.tabId === 'tBlank')).toBe(true);
		expect(ofKind(entries, 'pruneTab').some((e) => e.tabId === 't1')).toBe(false);
		expect(ofKind(entries, 'removeGroup')).toHaveLength(0);
	});

	it('removes a released group that only had blank tabs', () => {
		const nodes = [
			group('g1', { homePaneId: 'pGone' }),
			tab('tBlank', 'g1', 'empty:1', {
				order: 0,
				filePath: undefined,
				viewState: { type: 'empty' },
			}),
		];
		const entries = plan(snap([]), nodes, ctx());
		expect(ofKind(entries, 'removeGroup')).toEqual([{ kind: 'removeGroup', groupId: 'g1' }]);
	});

	it('skips mirror for suppressed groups', () => {
		const nodes = [
			group('g1', { homePaneId: 'p1' }),
			tab('t1', 'g1', 'a.md', { order: 0 }),
		];
		const entries = plan(
			snap([pane('p1', [{ key: 'a.md' }, { key: 'b.md' }])]),
			nodes,
			ctx({ suppressedGroupIds: new Set(['g1']) })
		);
		expect(ofKind(entries, 'addTab')).toHaveLength(0);
		expect(ofKind(entries, 'pruneTab')).toHaveLength(0);
		expect(ofKind(entries, 'claimPane')).toEqual([{ kind: 'claimPane', groupId: 'g1', paneId: 'p1' }]);
	});

	it('files a new pane at the root even when a section is focused', () => {
		const nodes = [section('sec1')];
		const entries = plan(
			snap([pane('p1', [{ key: 'a.md' }])]),
			nodes,
			ctx({ focusedSectionId: 'sec1' })
		);
		expect(ofKind(entries, 'newGroup')).toEqual([
			{ kind: 'newGroup', paneId: 'p1', parentId: null, title: 'Group 1' },
		]);
	});

	it('moves records when a live pane vanishes and its tabs are all in one other pane', () => {
		const nodes = [
			group('H', { homePaneId: 'pGone', title: 'Source' }),
			group('G', { homePaneId: 'pG', title: 'Target' }),
			tab('t1', 'H', 'x.md', { order: 0 }),
			tab('t2', 'H', 'y.md', { order: 1 }),
			tab('t3', 'G', 'z.md', { order: 0 }),
		];
		const entries = plan(snap([pane('pG', [{ key: 'z.md' }, { key: 'x.md' }, { key: 'y.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'moveTabRecord').map((e) => e.tabId).sort()).toEqual(['t1', 't2']);
		expect(ofKind(entries, 'addTab').some((e) => e.key === 'x.md' || e.key === 'y.md')).toBe(false);
		expect(ofKind(entries, 'merged')[0]?.toGroupId).toBe('G');
		expect(ofKind(entries, 'removeGroup').some((e) => e.groupId === 'H')).toBe(true);
	});

	it('emits syncViewState only in full mode', () => {
		const nodes = [
			group('g1', { homePaneId: 'p1' }),
			tab('t1', 'g1', 'a.md', { order: 0, viewState: { type: 'markdown' } }),
		];
		const snapshot = snap([pane('p1', [{ key: 'a.md', viewState: { type: 'markdown' } }])]);

		const full = plan(snapshot, nodes, ctx({ mode: 'full' }));
		expect(ofKind(full, 'syncViewState')).toHaveLength(1);

		const poll = plan(snapshot, nodes, ctx({ mode: 'poll' }));
		expect(ofKind(poll, 'syncViewState')).toHaveLength(0);
		expect(ofKind(poll, 'syncTitle')).toHaveLength(0);

		const renamed = plan(snap([pane('p1', [{ key: 'a.md', title: 'Renamed' }])]), nodes, ctx());
		expect(ofKind(renamed, 'syncTitle')).toEqual([{ kind: 'syncTitle', tabId: 't1', title: 'Renamed' }]);
	});

	it('never prune+adds the same key in one plan when moving between live groups', () => {
		const nodes = [
			group('gA', { homePaneId: 'pA' }),
			group('gB', { homePaneId: 'pB' }),
			tab('t1', 'gA', 'a.md', { order: 0 }),
			tab('t2', 'gB', 'b.md', { order: 0 }),
		];
		const entries = plan(
			snap([pane('pA', [{ key: 'b.md' }]), pane('pB', [{ key: 'a.md' }])]),
			nodes,
			ctx()
		);
		const prunedKeys = new Set(
			ofKind(entries, 'pruneTab').map((e) => nodes.find((n) => n.id === e.tabId)?.tabKey)
		);
		const addedKeys = new Set(ofKind(entries, 'addTab').map((e) => e.key));
		for (const key of prunedKeys) {
			expect(addedKeys.has(key as string)).toBe(false);
		}
		expect(ofKind(entries, 'moveTabRecord').length).toBeGreaterThan(0);
	});

	it('does not mutate dormant tab lists when another pane shows the same keys', () => {
		const nodes = [
			group('dormant'),
			tab('t1', 'dormant', 'a.md', { order: 0 }),
			group('live', { homePaneId: 'p1' }),
			tab('t2', 'live', 'b.md', { order: 0 }),
		];
		const entries = plan(
			snap([pane('p1', [{ key: 'b.md' }, { key: 'a.md' }])]),
			nodes,
			ctx()
		);
		expect(ofKind(entries, 'moveTabRecord')).toHaveLength(0);
		expect(ofKind(entries, 'pruneTab').some((e) => e.tabId === 't1')).toBe(false);
		expect(ofKind(entries, 'addTab').some((e) => e.key === 'a.md' && e.groupId === 'live')).toBe(true);
	});

	it('leaves a pooled tab in its section while its leaf stays open', () => {
		const nodes = [
			section('work'),
			group('g1', { homePaneId: 'p1' }),
			tab('pooled', 'work', 'a.md', { order: 0 }),
			tab('live', 'g1', 'b.md', { order: 0 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }, { key: 'b.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'addTab').some((entry) => entry.key === 'a.md')).toBe(false);
		expect(ofKind(entries, 'moveTabRecord').some((entry) => entry.tabId === 'pooled')).toBe(false);
		expect(ofKind(entries, 'pruneTab').some((entry) => entry.tabId === 'pooled')).toBe(false);
	});

	it('does not invent a group for a pane whose leaves are all pooled', () => {
		const nodes = [
			section('work'),
			group('g1'),
			tab('pooled', 'work', 'a.md', { order: 0 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'newGroup')).toHaveLength(0);
		expect(ofKind(entries, 'addTab')).toHaveLength(0);
	});

	it('drops a second copy of the same tab inside one group', () => {
		const nodes = [
			group('g1', { homePaneId: 'p1' }),
			tab('t1', 'g1', 'a.md', { order: 0 }),
			tab('t2', 'g1', 'a.md', { order: 1 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'pruneTab').map((entry) => entry.tabId)).toEqual(['t1']);
		expect(ofKind(entries, 'addTab')).toHaveLength(0);
	});

	it('prunes a stored tab that is no longer open in its live pane', () => {
		const nodes = [
			group('footer', { homePaneId: 'p1' }),
			tab('open1', 'footer', 'a.md', { order: 0 }),
			tab('open2', 'footer', 'b.md', { order: 1 }),
			tab('stale', 'footer', 'c.md', { order: 2 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }, { key: 'b.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'pruneTab').map((entry) => entry.tabId)).toEqual(['stale']);
	});

	it('does not add another copy when the live group already has the tab', () => {
		const nodes = [
			group('live', { homePaneId: 'p1' }),
			tab('already', 'live', 'a.md', { order: 0 }),
			group('dormant'),
			tab('old', 'dormant', 'a.md', { order: 0 }),
		];
		const entries = plan(snap([pane('p1', [{ key: 'a.md' }])]), nodes, ctx());
		expect(ofKind(entries, 'addTab').some((entry) => entry.groupId === 'live' && entry.key === 'a.md')).toBe(
			false
		);
	});

	it('effectivelyHidden is only the stored hide flags', () => {
		const g = { hidden: false };
		expect(effectivelyHidden(g, undefined)).toBe(false);
		expect(effectivelyHidden({ hidden: true }, undefined)).toBe(true);
		expect(effectivelyHidden(g, { hidden: true })).toBe(true);
		expect(effectivelyHidden(g, { hidden: false })).toBe(false);
	});

	it('reattaches after pane id changes when contents still match exactly', () => {
		const nodes = [
			group('g1', { homePaneId: 'oldPane' }),
			tab('t1', 'g1', 'a.md', { order: 0 }),
			tab('t2', 'g1', 'b.md', { order: 1 }),
		];
		const entries = plan(
			snap([pane('newPane', [{ key: 'a.md' }, { key: 'b.md' }])]),
			nodes,
			ctx()
		);
		expect(ofKind(entries, 'releasePane')).toEqual([{ kind: 'releasePane', groupId: 'g1' }]);
		expect(ofKind(entries, 'claimPane')).toContainEqual({
			kind: 'claimPane',
			groupId: 'g1',
			paneId: 'newPane',
		});
		expect(ofKind(entries, 'newGroup')).toHaveLength(0);
	});
});
