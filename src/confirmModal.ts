import { App, Modal, Setting } from "obsidian";

/**
 * A destructive-action confirmation, in place of the blocking native
 * `confirm()` (which Obsidian's plugin review flags - it blocks the whole
 * renderer process, unlike a modal).
 */
export class ConfirmModal extends Modal {
	private resolve: ((confirmed: boolean) => void) | null = null;

	constructor(app: App, private message: string, private confirmText = "Confirm") {
		super(app);
	}

	/** Opens the modal and resolves once the user picks an option (or dismisses it, which counts as cancel). */
	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(this.confirmText)
					.setWarning()
					.setCta()
					.onClick(() => {
						this.resolve?.(true);
						this.resolve = null;
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
		// Any close that isn't the confirm button's own click (Cancel, Esc, backdrop) counts as "not confirmed".
		this.resolve?.(false);
		this.resolve = null;
	}
}
