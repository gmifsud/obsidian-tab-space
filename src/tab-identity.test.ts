import { describe, expect, it } from 'vitest';
import { needsViewStateForIdentity } from './tab-identity';

describe('needsViewStateForIdentity', () => {
	it('skips view state when the leaf already has a file', () => {
		expect(needsViewStateForIdentity('markdown', 'notes/a.md')).toBe(false);
	});

	it('skips view state for a live terminal', () => {
		expect(needsViewStateForIdentity('terminus-view', undefined)).toBe(false);
		expect(needsViewStateForIdentity('terminus-diff-split', undefined)).toBe(false);
	});

	it('reads view state for any other view that has not exposed a file', () => {
		expect(needsViewStateForIdentity('markdown', undefined)).toBe(true);
		expect(needsViewStateForIdentity('code-space-dashboard', undefined)).toBe(true);
		expect(needsViewStateForIdentity('canvas', undefined)).toBe(true);
	});
});
