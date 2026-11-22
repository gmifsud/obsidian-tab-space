/** Terminal views serialise their scrollback inside view state. Their identity is the view type plus leaf id, which does not need that read. Every other view may store a file path in view state. */
const SKIP_VIEW_STATE_TYPES = new Set(['terminus-view', 'terminus-diff-split']);

export function needsViewStateForIdentity(viewType: string, directFilePath: string | undefined): boolean {
	if (directFilePath) return false;
	return !SKIP_VIEW_STATE_TYPES.has(viewType);
}
