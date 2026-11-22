import { App, Modal, TFile, WorkspaceLeaf, type ViewState } from 'obsidian';

export interface TabPreviewTarget {
	title: string;
	filePath?: string;
	viewState?: unknown;
}

interface DetachedLeaf extends WorkspaceLeaf {
	containerEl: HTMLElement;
}

/** Hosts a real workspace view inside the modal, off the main layout. */
export class TabPreviewModal extends Modal {
	private leaf: DetachedLeaf | null = null;

	constructor(
		app: App,
		private target: TabPreviewTarget
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass('mod-working-tabs-editor');
		for (const [name, value] of [
			['width', '92vw'],
			['max-width', '92vw'],
			['height', '86vh'],
			['max-height', '86vh'],
		] as const) {
			modalEl.style.setProperty(name, value, 'important');
		}
		contentEl.addClass('working-tabs-editor-modal');
		const host = contentEl.createDiv({ cls: 'working-tabs-editor-host' });
		const state = this.viewState();
		const file = this.target.filePath ? this.app.vault.getAbstractFileByPath(this.target.filePath) : null;
		if (!state && !(file instanceof TFile)) {
			host.createEl('p', { text: 'This tab has no note to open.' });
			return;
		}

		const Leaf = WorkspaceLeaf as unknown as new (app: App) => DetachedLeaf;
		const leaf = new Leaf(this.app);
		this.leaf = leaf;
		host.appendChild(leaf.containerEl);
		leaf.containerEl.addClass('working-tabs-editor-leaf');
		leaf.containerEl.style.width = '100%';
		leaf.containerEl.style.height = '100%';
		try {
			if (state && state.type !== 'markdown' && state.type !== 'empty') {
				await leaf.setViewState({ ...state, active: false });
			} else if (file instanceof TFile) {
				await leaf.openFile(file, { state: { mode: 'source' } });
			} else if (state) {
				await leaf.setViewState({ ...state, active: false });
			}
		} catch (error) {
			leaf.detach();
			this.leaf = null;
			host.empty();
			const detail = error instanceof Error ? error.message : String(error);
			host.createEl('p', { text: `Could not open this tab here. ${detail}` });
			return;
		}
		window.setTimeout(() => leaf.onResize(), 0);
		window.setTimeout(() => leaf.onResize(), 50);
	}

	onClose(): void {
		this.leaf?.detach();
		this.leaf = null;
		this.contentEl.empty();
		this.modalEl.removeClass('mod-working-tabs-editor');
	}

	private viewState(): ViewState | null {
		const stored = this.target.viewState;
		if (!stored || typeof stored !== 'object' || !('type' in stored)) return null;
		const state = stored as ViewState;
		if (typeof state.type !== 'string' || !state.type) return null;
		if (state.type === 'markdown') {
			return { ...state, active: false, state: { ...(state.state ?? {}), mode: 'source' } };
		}
		return { ...state, active: false };
	}
}
