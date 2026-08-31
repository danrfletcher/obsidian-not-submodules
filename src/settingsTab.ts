import { App, Notice, PluginSettingTab, Setting, normalizePath, setIcon } from "obsidian";
import type NotSubmodulesPlugin from "./main";
import { GITIGNORE_LINE } from "./types";
import { gitClone, gitInit, gitPull, gitPush, hasGitDir } from "./gitUtils";
import {
	buildRegistry,
	findUnregisteredGitRepoFolders,
	findUnregisteredGitRepoFoldersFast,
	getBasePath,
} from "./registry";
import { registerRepoAtPath } from "./registerRepo";
import { revealInFileExplorer } from "./reveal";
import { SimplePathSuggest } from "./pathSuggest";
import { errorMessage } from "./errors";
import * as fs from "fs";
import * as path from "path";

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
		this.renderGitignoreSetting(containerEl);
		this.renderRepoList(containerEl);
		this.renderRegisterNew(containerEl);
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

	private renderGitignoreSetting(containerEl: HTMLElement): void {
		const basePath = getBasePath(this.app);
		const gitignorePath = basePath ? path.join(basePath, ".gitignore") : null;
		const alreadySetUp =
			!!gitignorePath &&
			fs.existsSync(gitignorePath) &&
			fs.readFileSync(gitignorePath, "utf8").includes(GITIGNORE_LINE);

		const setting = new Setting(containerEl)
			.setName("Ignore nested repos")
			.setDesc(`Adds "${GITIGNORE_LINE}" to .gitignore so nested repos aren't tracked as part of the vault repo.`);

		if (alreadySetUp) {
			const status = setting.controlEl.createSpan({ cls: "not-submodules-status" });
			setIcon(status.createSpan(), "check");
			status.createSpan({ text: " .gitignore is set up" });
		} else {
			setting.addButton((btn) =>
				btn
					.setButtonText("Add to .gitignore")
					.setCta()
					.onClick(async () => {
						if (!gitignorePath) {
							new Notice("Couldn't resolve the vault's location on disk.");
							return;
						}
						try {
							const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
							const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
							fs.writeFileSync(gitignorePath, `${existing}${sep}${GITIGNORE_LINE}\n`);
							new Notice(".gitignore updated.");
							this.display();
						} catch (e: unknown) {
							new Notice(`Failed to update .gitignore: ${errorMessage(e)}`);
						}
					})
			);
		}
	}

	private renderRepoList(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Nested git repos").setHeading();

		const registry = buildRegistry(this.app);
		const basePath = getBasePath(this.app);
		const missing = registry.filter((r) => !r.isCloned);
		const cloned = registry.filter((r) => r.isCloned);

		if (registry.length === 0) {
			containerEl.createEl("p", {
				text: 'No repos registered yet. Use "Register a repo" below to add one.',
				cls: "setting-item-description",
			});
			return;
		}

		const bulk = new Setting(containerEl).setName("Bulk actions");

		if (missing.length > 0) {
			bulk.addButton((btn) =>
				btn.setButtonText(`Clone all missing (${missing.length})`).onClick(async () => {
					btn.setDisabled(true).setButtonText("Cloning...");
					for (const entry of missing) {
						if (!basePath) continue;
						try {
							await gitClone(entry.url, `${basePath}/${entry.localFolderPath}`);
						} catch (e: unknown) {
							new Notice(`Failed to clone ${entry.repoName}: ${errorMessage(e)}`);
						}
					}
					new Notice("Finished cloning missing repos.");
					this.display();
				})
			);
		}
		if (cloned.length > 0) {
			bulk.addButton((btn) =>
				btn.setButtonText(`Pull all (${cloned.length})`).onClick(async () => {
					btn.setDisabled(true).setButtonText("Pulling...");
					for (const entry of cloned) {
						if (!basePath) continue;
						try {
							await gitPull(`${basePath}/${entry.localFolderPath}`);
						} catch (e: unknown) {
							new Notice(`Failed to pull ${entry.repoName}: ${errorMessage(e)}`);
						}
					}
					new Notice("Finished pulling all repos.");
					this.display();
				})
			);
			bulk.addButton((btn) =>
				btn.setButtonText(`Push all (${cloned.length})`).onClick(async () => {
					btn.setDisabled(true).setButtonText("Pushing...");
					for (const entry of cloned) {
						if (!basePath) continue;
						try {
							await gitPush(`${basePath}/${entry.localFolderPath}`);
						} catch (e: unknown) {
							new Notice(`Failed to push ${entry.repoName}: ${errorMessage(e)}`);
						}
					}
					new Notice("Finished pushing all repos.");
					this.display();
				})
			);
		}

		for (const entry of registry) {
			const setting = new Setting(containerEl)
				.setName(entry.repoName)
				.setDesc(`${entry.url} \u00b7 in ${entry.parentFolderPath || "vault root"}`);

			setting.nameEl.addClass("not-submodules-repo-name");
			setting.nameEl.setAttr(
				"title",
				entry.isCloned
					? "Click to reveal in file navigator"
					: "Not cloned locally yet - click to reveal its parent folder"
			);
			setting.nameEl.setCssStyles({ cursor: "pointer" });
			setting.nameEl.addEventListener("click", () => {
				const revealed = entry.isCloned
					? revealInFileExplorer(this.app, entry.localFolderPath)
					: revealInFileExplorer(this.app, entry.parentFolderPath);
				if (!revealed) {
					new Notice("Couldn't reveal it in the file navigator.");
				}
			});

			if (entry.isCloned) {
				setting.addButton((btn) =>
					btn.setButtonText("Pull").onClick(async () => {
						btn.setDisabled(true).setButtonText("Pulling...");
						if (!basePath) return;
						try {
							await gitPull(`${basePath}/${entry.localFolderPath}`);
							new Notice(`Pulled ${entry.repoName}.`);
						} catch (e: unknown) {
							new Notice(`Pull failed: ${errorMessage(e)}`);
						} finally {
							this.display();
						}
					})
				);
				setting.addButton((btn) =>
					btn.setButtonText("Push").onClick(async () => {
						btn.setDisabled(true).setButtonText("Pushing...");
						if (!basePath) return;
						try {
							await gitPush(`${basePath}/${entry.localFolderPath}`);
							new Notice(`Pushed ${entry.repoName}.`);
						} catch (e: unknown) {
							new Notice(`Push failed: ${errorMessage(e)}`);
						} finally {
							this.display();
						}
					})
				);
			} else {
				setting.addButton((btn) =>
					btn
						.setButtonText("Clone")
						.setCta()
						.onClick(async () => {
							btn.setDisabled(true).setButtonText("Cloning...");
							if (!basePath) return;
							try {
								await gitClone(entry.url, `${basePath}/${entry.localFolderPath}`);
								new Notice(`Cloned ${entry.repoName}.`);
							} catch (e: unknown) {
								new Notice(`Clone failed: ${errorMessage(e)}`);
							} finally {
								this.display();
							}
						})
				);
			}
		}
	}

	private renderRegisterNew(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Register a repo").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Point this at an existing -git-repo folder (already git-initialised, with an origin remote) " +
				"to declare it in the nearest folder note's frontmatter.",
		});

		let candidates = findUnregisteredGitRepoFoldersFast(this.app);
		findUnregisteredGitRepoFolders(this.app)
			.then((accurate) => {
				candidates = accurate;
			})
			.catch(() => {
				// Ignore - the fast/synchronous candidate list above still works.
			});

		let chosenPath = "";

		const setting = new Setting(containerEl).setName("Folder path");
		setting.addText((text) => {
			text.setPlaceholder("path/to/my-repo-git-repo");
			new SimplePathSuggest(
				this.app,
				text.inputEl,
				() => candidates,
				(value) => {
					chosenPath = value;
				}
			);
			text.onChange((value) => {
				chosenPath = value;
			});
		});
		setting.addButton((btn) =>
			btn
				.setButtonText("Register")
				.setCta()
				.onClick(async () => {
					const relPath = normalizePath(chosenPath.trim());
					if (!relPath) {
						new Notice("Enter a folder path first.");
						return;
					}
					btn.setDisabled(true).setButtonText("Registering...");
					try {
						const outcome = await registerRepoAtPath(this.app, relPath);
						new Notice(outcome.message);
						this.display();
					} catch (e: unknown) {
						new Notice(`Couldn't register: ${errorMessage(e)}`);
						btn.setDisabled(false).setButtonText("Register");
					}
				})
		);
	}
}
