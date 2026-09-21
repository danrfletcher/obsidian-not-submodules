import { App, Modal, Setting } from "obsidian";

/**
 * The on-update popup (PR-6): explains the rebuild and offers the one
 * atomic "Migrate now" action. Dismissing it without migrating leaves the
 * settings-page banner as the persistent fallback - this modal itself
 * never re-appears on its own (it's shown once per load from `main.ts`,
 * driven by the same disk-derived `needsMigration` check as the banner).
 */
export class MigrationModal extends Modal {
	constructor(app: App, private onMigrate: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Not Submodules has been rebuilt" });
		contentEl.createEl("p", {
			text:
				"Nested repos are now discovered by scanning your vault's filesystem instead of a folder-naming " +
				"convention and frontmatter, and a self-maintaining git hook replaces the old static .gitignore line. " +
				'"Migrate now" rescans your vault, installs the hook, and removes the old ignore rule - all in one step. ' +
				"Nothing you've registered is lost.",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Migrate now")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true).setButtonText("Migrating...");
						await this.onMigrate();
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Later").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
