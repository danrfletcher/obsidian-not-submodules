import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type NotSubmodulesPlugin from "./main";
import { LocationKind } from "./types";
import { gitInit, hasGitDir } from "./gitUtils";
import { getBasePath, scanAndBuildRegistry } from "./registry";
import { checkHookStatus, installHook } from "./hookInstall";
import { revealInFileExplorer } from "./reveal";
import { errorMessage } from "./errors";

/** Vault-relative parent path of a vault-relative path ("" for the vault root). */
function vaultDirname(vaultPath: string): string {
	const parts = vaultPath.split("/").filter(Boolean);
	parts.pop();
	return parts.join("/");
}

function kindLabel(kind: LocationKind): string {
	if (kind === "worktree") return "worktree";
	if (kind === "submodule") return "submodule";
	return "original";
}

export class NotSubmodulesSettingTab extends PluginSettingTab {
	plugin: NotSubmodulesPlugin;

	constructor(app: App, plugin: NotSubmodulesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderGitInitSetting(containerEl);
		this.renderHookSetting(containerEl);
		this.renderRepoList(containerEl);
	}

	private renderGitInitSetting(containerEl: HTMLElement): void {
		const basePath = getBasePath(this.app);
		const alreadyInit = !!basePath && hasGitDir(basePath);

		const setting = new Setting(containerEl)
			.setName("Initialise git repo")
			.setDesc("Your vault needs to be a git repository for nested repos to be ignorable.");

		if (alreadyInit) {
			const status = setting.controlEl.createSpan({ cls: "not-submodules-status" });
			setIcon(status.createSpan(), "check");
			status.createSpan({ text: " Already a git repo" });
		} else {
			setting.addButton((btn) =>
				btn
					.setButtonText("Initialise")
					.setCta()
					.onClick(async () => {
						if (!basePath) {
							new Notice("Couldn't resolve the vault's location on disk.");
							return;
						}
						btn.setDisabled(true).setButtonText("Initialising...");
						try {
							await gitInit(basePath);
							new Notice("Initialised the vault as a git repository.");
							this.display();
						} catch (e: unknown) {
							new Notice(`Failed to initialise: ${errorMessage(e)}`);
							btn.setDisabled(false).setButtonText("Initialise");
						}
					})
			);
		}
	}

	private renderHookSetting(containerEl: HTMLElement): void {
		const basePath = getBasePath(this.app);
		const status = basePath ? checkHookStatus(basePath) : "missing";

		const setting = new Setting(containerEl)
			.setName("Install git hook")
			.setDesc(
				"Installs a pre-commit hook that keeps .gitignore's nested-repo rules correct automatically on every commit " +
					"- no manual step needed."
			);

		if (status === "installed") {
			const s = setting.controlEl.createSpan({ cls: "not-submodules-status" });
			setIcon(s.createSpan(), "check");
			s.createSpan({ text: " Git hook installed" });
			return;
		}

		if (status === "foreign") {
			setting.setDesc(
				setting.descEl.textContent +
					" A pre-commit hook this plugin didn't install already exists - installing is refused until you resolve it."
			);
		}

		setting.addButton((btn) =>
			btn
				.setButtonText("Install git hook")
				.setCta()
				.onClick(async () => {
					if (!basePath) {
						new Notice("Couldn't resolve the vault's location on disk.");
						return;
					}
					const outcome = installHook(basePath);
					new Notice(outcome.message);
					if (outcome.status !== "foreign-hook-exists") {
						await this.plugin.setHookInstalled(true);
					}
					this.display();
				})
		);
	}

	/**
	 * A manual filesystem scan, never run automatically. This is a
	 * deliberately unstyled listing - the Originals/Worktrees sections and
	 * per-location actions (Clone/Push/Pull/New/Delete/Remove) are PR-4's
	 * job; this PR only needs the scan result to be visible and correct.
	 */
	private renderRepoList(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Nested git repos").setHeading();

		const refreshSetting = new Setting(containerEl)
			.setName("Refresh")
			.setDesc("Scans the vault's filesystem for nested git repos and rebuilds this list. Not run automatically.");
		refreshSetting.addButton((btn) =>
			btn
				.setButtonText("Refresh")
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true).setButtonText("Scanning...");
					try {
						const { entries, warnings } = await scanAndBuildRegistry(this.app, this.plugin.registry);
						await this.plugin.saveRegistry(entries);
						for (const warning of warnings) new Notice(warning);
						const count = entries.reduce((sum, e) => sum + e.locations.length, 0);
						new Notice(`Found ${count} repo location${count === 1 ? "" : "s"} across ${entries.length} repo${entries.length === 1 ? "" : "s"}.`);
					} catch (e: unknown) {
						new Notice(`Refresh failed: ${errorMessage(e)}`);
					} finally {
						this.display();
					}
				})
		);

		if (this.plugin.registry.length === 0) {
			containerEl.createEl("p", {
				text: 'No repos scanned yet. Click "Refresh" above to scan the vault.',
				cls: "setting-item-description",
			});
			return;
		}

		for (const entry of this.plugin.registry) {
			const originals = entry.locations.filter((l) => l.kind !== "worktree");
			const worktrees = entry.locations.filter((l) => l.kind === "worktree");

			const setting = new Setting(containerEl)
				.setName(entry.repoName)
				.setDesc(
					entry.originUrl
						? `${entry.originUrl} · ${originals.length} original${originals.length === 1 ? "" : "s"}, ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"}`
						: "No resolvable origin remote yet - not trackable across locations until it has one."
				);

			const list = setting.controlEl.createEl("ul", { cls: "not-submodules-location-list" });
			for (const loc of entry.locations) {
				const item = list.createEl("li", {
					text: `${loc.vaultPath} (${kindLabel(loc.kind)}${loc.isCloned ? "" : ", missing"})`,
				});
				item.setCssStyles({ cursor: "pointer" });
				item.addEventListener("click", () => {
					const target = loc.isCloned ? loc.vaultPath : vaultDirname(loc.vaultPath);
					if (!revealInFileExplorer(this.app, target)) {
						new Notice("Couldn't reveal it in the file navigator.");
					}
				});
			}
		}
	}
}
