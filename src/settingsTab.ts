import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type NotSubmodulesPlugin from "./main";
import { LocationKind, RepoEntry, RepoLocation } from "./types";
import {
	gitInit,
	hasGitDir,
	gitClone,
	gitPull,
	gitPush,
	gitIsDirty,
	gitCurrentBranch,
	gitListBranches,
	gitCheckoutLocalBranch,
	gitCheckoutRemoteBranch,
	gitStashStatus,
	gitStashPush,
	gitStashPop,
	gitWorktreeList,
	gitWorktreeRepair,
	BranchList,
} from "./gitUtils";
import { getBasePath, scanAndBuildRegistry } from "./registry";
import { checkHookStatus, installHook } from "./hookInstall";
import { computeLocationUiState, deleteLocation, removeLocationFromRegistry, validateNewClonePath } from "./locationActions";
import { revealInFileExplorer } from "./reveal";
import { errorMessage } from "./errors";
import * as path from "path";

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

interface LiveLocationState {
	isDirty: boolean;
	hasStash: boolean;
	stashBranch: string | null;
	currentBranch: string | null;
	branches: BranchList;
	worktreeBroken: boolean;
}

const EMPTY_BRANCHES: BranchList = { local: [], remote: [] };

export class NotSubmodulesSettingTab extends PluginSettingTab {
	plugin: NotSubmodulesPlugin;
	/** Vault paths currently mid-action (Clone/Push/Pull/Stash/...) - blocks a second concurrent op on the same location. */
	private busyPaths = new Set<string>();

	constructor(app: App, plugin: NotSubmodulesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderGitInitSetting(containerEl);
		this.renderHookSetting(containerEl);
		void this.renderRepoList(containerEl);
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

	private async renderRepoList(containerEl: HTMLElement): Promise<void> {
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
						const { entries, warnings, submodules } = await scanAndBuildRegistry(this.app, this.plugin.registry);
						await this.plugin.saveScanResult(entries, submodules);
						for (const warning of warnings) new Notice(warning);
						const count = entries.reduce((sum, e) => sum + e.locations.length, 0);
						new Notice(
							`Found ${count} repo location${count === 1 ? "" : "s"} across ${entries.length} repo${entries.length === 1 ? "" : "s"}.`
						);
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
			this.renderSubmodulesSection(containerEl);
			return;
		}

		const basePath = getBasePath(this.app);
		if (!basePath) return;

		for (const entry of this.plugin.registry) {
			await this.renderRepoEntry(containerEl, entry, basePath);
		}

		this.renderSubmodulesSection(containerEl);
	}

	/**
	 * Read-only and purely informational (PR-5) - driven entirely by
	 * .gitmodules, refreshed by the same Refresh click as the main
	 * registry. No Clone/Push/Pull/New/Delete/Remove/branch dropdown:
	 * nothing here can be anything other than an already-declared real
	 * git submodule.
	 */
	private renderSubmodulesSection(containerEl: HTMLElement): void {
		if (this.plugin.submodules.length === 0) return;

		new Setting(containerEl).setName("Submodules").setHeading();
		for (const sub of this.plugin.submodules) {
			new Setting(containerEl)
				.setName(sub.vaultPath)
				.setDesc(`${sub.url}${sub.initialized ? "" : " · not initialized on disk"}`);
		}
	}

	private absPathOf(basePath: string, vaultPath: string): string {
		return path.join(basePath, ...vaultPath.split("/"));
	}

	/** The first cloned Original location in this entry - the working directory `git worktree` commands for its worktrees must run from. */
	private findMainRepoAbsPath(entry: RepoEntry, basePath: string): string | null {
		const original = entry.locations.find((l) => l.kind === "original" && l.isCloned);
		return original ? this.absPathOf(basePath, original.vaultPath) : null;
	}

	private async gatherLiveState(loc: RepoLocation, absPath: string, mainRepoAbsPath: string | null): Promise<LiveLocationState> {
		const [isDirty, stashStatus, currentBranch, branches] = await Promise.all([
			gitIsDirty(absPath).catch(() => false),
			gitStashStatus(absPath).catch(() => ({ hasStash: false, branch: null })),
			gitCurrentBranch(absPath).catch(() => null),
			gitListBranches(absPath).catch(() => EMPTY_BRANCHES),
		]);

		let worktreeBroken = false;
		if (loc.kind === "worktree" && mainRepoAbsPath && currentBranch) {
			try {
				// Match by branch, not path: a stale git-internal pointer means
				// git's own worktree list still shows the *old* path as broken -
				// it has no idea the folder now lives somewhere else. The branch
				// travels with the worktree regardless (one worktree per branch),
				// so it's the reliable correlation key here.
				const worktrees = await gitWorktreeList(mainRepoAbsPath);
				worktreeBroken = worktrees.some((w) => w.branch === currentBranch && w.broken);
			} catch {
				// Main repo unreachable - leave as not-broken rather than guessing.
			}
		}

		return { isDirty, hasStash: stashStatus.hasStash, stashBranch: stashStatus.branch, currentBranch, branches, worktreeBroken };
	}

	private async renderRepoEntry(containerEl: HTMLElement, entry: RepoEntry, basePath: string): Promise<void> {
		new Setting(containerEl)
			.setName(entry.repoName)
			.setDesc(entry.originUrl || "No resolvable origin remote yet - not trackable across locations until it has one.")
			.setHeading();

		const originals = entry.locations.filter((l) => l.kind !== "worktree");
		const worktrees = entry.locations.filter((l) => l.kind === "worktree");
		const mainRepoAbsPath = this.findMainRepoAbsPath(entry, basePath);

		containerEl.createEl("p", { text: "Originals", cls: "not-submodules-section-label" });
		for (const loc of originals) {
			await this.renderLocationRow(containerEl, entry, loc, basePath, mainRepoAbsPath);
		}
		if (entry.originUrl) this.renderNewLocationRow(containerEl, entry, basePath);

		containerEl.createEl("p", { text: "Worktrees", cls: "not-submodules-section-label" });
		if (worktrees.length === 0) {
			containerEl.createEl("p", { text: "No worktrees.", cls: "setting-item-description" });
		}
		for (const loc of worktrees) {
			await this.renderLocationRow(containerEl, entry, loc, basePath, mainRepoAbsPath);
		}
	}

	private renderNewLocationRow(containerEl: HTMLElement, entry: RepoEntry, basePath: string): void {
		let chosenPath = "";
		const setting = new Setting(containerEl).setName("New").setDesc("Clones this repo's origin again at a vault path you choose.");
		setting.addText((text) => {
			text.setPlaceholder(`path/to/${entry.repoName}`);
			text.onChange((value) => {
				chosenPath = value;
			});
		});
		setting.addButton((btn) =>
			btn
				.setButtonText("Clone")
				.setCta()
				.onClick(async () => {
					const relPath = chosenPath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
					if (!relPath) {
						new Notice("Enter a vault path first.");
						return;
					}
					const absPath = this.absPathOf(basePath, relPath);
					const validation = validateNewClonePath(absPath);
					if (!validation.ok) {
						new Notice(validation.reason);
						return;
					}
					btn.setDisabled(true).setButtonText("Cloning...");
					try {
						await gitClone(entry.originUrl, absPath);
						const updated = this.plugin.registry.map((e) =>
							e.normalizedOrigin === entry.normalizedOrigin
								? {
										...e,
										locations: [
											...e.locations,
											{
												vaultPath: relPath,
												kind: "original" as const,
												continuityKey: relPath,
												isCloned: true,
												isDirty: false,
												hasStash: false,
											},
										],
								  }
								: e
						);
						await this.plugin.saveRegistry(updated);
						new Notice(`Cloned ${entry.repoName} to "${relPath}".`);
					} catch (e: unknown) {
						new Notice(`Clone failed: ${errorMessage(e)}`);
					} finally {
						this.display();
					}
				})
		);
	}

	private async renderLocationRow(
		containerEl: HTMLElement,
		entry: RepoEntry,
		loc: RepoLocation,
		basePath: string,
		mainRepoAbsPath: string | null
	): Promise<void> {
		const absPath = this.absPathOf(basePath, loc.vaultPath);
		const parentFolderPath = vaultDirname(loc.vaultPath);
		const busy = this.busyPaths.has(loc.vaultPath);

		const live: LiveLocationState = loc.isCloned && !busy
			? await this.gatherLiveState(loc, absPath, mainRepoAbsPath)
			: { isDirty: false, hasStash: false, stashBranch: null, currentBranch: null, branches: EMPTY_BRANCHES, worktreeBroken: false };

		const ui = computeLocationUiState({
			isCloned: loc.isCloned,
			isDirty: live.isDirty,
			hasStash: live.hasStash,
			currentBranch: live.currentBranch,
			stashBranch: live.stashBranch,
			worktreeBroken: live.worktreeBroken,
		});

		const setting = new Setting(containerEl)
			.setName(loc.vaultPath)
			.setDesc(`${kindLabel(loc.kind)}${loc.isCloned ? "" : " · missing"}${live.isDirty ? " · dirty" : ""}`);

		setting.nameEl.setCssStyles({ cursor: "pointer" });
		setting.nameEl.addEventListener("click", () => {
			const target = loc.isCloned ? loc.vaultPath : parentFolderPath;
			if (!revealInFileExplorer(this.app, target)) new Notice("Couldn't reveal it in the file navigator.");
		});

		if (loc.isCloned) {
			setting.addDropdown((dropdown) => {
				for (const b of live.branches.local) dropdown.addOption(b, b);
				for (const b of live.branches.remote) dropdown.addOption(b, `${b} (remote)`);
				if (live.currentBranch) dropdown.setValue(live.currentBranch);
				dropdown.setDisabled(!ui.branchDropdownEnabled || busy);
				dropdown.onChange(async (value) => {
					if (this.busyPaths.has(loc.vaultPath)) return;
					this.busyPaths.add(loc.vaultPath);
					try {
						if (live.branches.remote.includes(value)) {
							await gitCheckoutRemoteBranch(absPath, value);
						} else {
							await gitCheckoutLocalBranch(absPath, value);
						}
					} catch (e: unknown) {
						new Notice(`Switching branch failed: ${errorMessage(e)}`);
					} finally {
						this.busyPaths.delete(loc.vaultPath);
						this.display();
					}
				});
			});

			if (ui.stashButtonVisible) {
				setting.addButton((btn) =>
					btn.setButtonText("Stash").onClick(() =>
						this.runLocationAction(loc.vaultPath, btn, "Stashing...", async () => {
							await gitStashPush(absPath);
							new Notice(`Stashed changes in ${loc.vaultPath}.`);
						})
					)
				);
			}

			if (ui.popStashVisible) {
				setting.addButton((btn) => {
					btn.setButtonText("Pop Stash").setDisabled(!ui.popStashEnabled || busy);
					if (ui.popStashNote) btn.setTooltip(ui.popStashNote);
					btn.onClick(() =>
						this.runLocationAction(loc.vaultPath, btn, "Popping...", async () => {
							await gitStashPop(absPath);
							new Notice(`Popped stash in ${loc.vaultPath}.`);
						})
					);
					return btn;
				});
			}

			if (ui.repairVisible && mainRepoAbsPath) {
				setting.addButton((btn) =>
					btn
						.setButtonText("Repair")
						.setWarning()
						.onClick(() =>
							this.runLocationAction(loc.vaultPath, btn, "Repairing...", async () => {
								await gitWorktreeRepair(mainRepoAbsPath, absPath);
								new Notice(`Repaired worktree at ${loc.vaultPath}.`);
							})
						)
				);
			}

			setting.addButton((btn) =>
				btn
					.setButtonText("Pull")
					.setDisabled(busy)
					.onClick(() =>
						this.runLocationAction(loc.vaultPath, btn, "Pulling...", async () => {
							await gitPull(absPath);
							new Notice(`Pulled ${loc.vaultPath}.`);
						})
					)
			);
			setting.addButton((btn) =>
				btn
					.setButtonText("Push")
					.setDisabled(busy)
					.onClick(() =>
						this.runLocationAction(loc.vaultPath, btn, "Pushing...", async () => {
							await gitPush(absPath);
							new Notice(`Pushed ${loc.vaultPath}.`);
						})
					)
			);
			setting.addButton((btn) =>
				btn
					.setButtonText("Delete")
					.setWarning()
					.setDisabled(!ui.deleteEnabled || busy)
					.onClick(() => {
						if ((live.isDirty || live.hasStash) && !confirm(`"${loc.vaultPath}" has uncommitted changes${live.hasStash ? " and a stash" : ""} that will be permanently lost. Delete anyway?`)) {
							return;
						}
						return this.runLocationAction(loc.vaultPath, btn, "Deleting...", async () => {
							await deleteLocation(loc.kind, absPath, mainRepoAbsPath);
							await this.markLocationMissing(entry.normalizedOrigin, loc.vaultPath);
							new Notice(`Deleted ${loc.vaultPath}. It stays listed as missing until you Remove it.`);
						});
					})
			);
		} else {
			// A missing worktree can't be re-cloned - it can only come back via
			// git worktree add against its main repo, which "New" doesn't do -
			// so a missing worktree offers nothing but Remove.
			if (entry.originUrl && loc.kind !== "worktree") {
				setting.addButton((btn) =>
					btn
						.setButtonText("Clone")
						.setCta()
						.onClick(() =>
							this.runLocationAction(loc.vaultPath, btn, "Cloning...", async () => {
								await gitClone(entry.originUrl, absPath);
								new Notice(`Cloned ${loc.vaultPath}.`);
							})
						)
				);
			}
			setting.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.setDisabled(!ui.removeEnabled || busy)
					.onClick(async () => {
						const updated = removeLocationFromRegistry(this.plugin.registry, entry.normalizedOrigin, loc.vaultPath);
						await this.plugin.saveRegistry(updated);
						new Notice(`Removed ${loc.vaultPath} from the registry.`);
						this.display();
					})
			);
		}
	}

	/** Marks a location as missing in the persisted registry immediately after Delete, rather than waiting for the next Refresh. */
	private async markLocationMissing(normalizedOrigin: string, vaultPath: string): Promise<void> {
		const updated = this.plugin.registry.map((e) =>
			e.normalizedOrigin === normalizedOrigin
				? { ...e, locations: e.locations.map((l) => (l.vaultPath === vaultPath ? { ...l, isCloned: false } : l)) }
				: e
		);
		await this.plugin.saveRegistry(updated);
	}

	/** Runs one location's action, blocking a second concurrent action on the same location, and always repaints afterward. */
	private async runLocationAction(
		vaultPath: string,
		btn: { setDisabled(disabled: boolean): unknown; setButtonText(text: string): unknown },
		inProgressLabel: string,
		action: () => Promise<void>
	): Promise<void> {
		if (this.busyPaths.has(vaultPath)) return;
		this.busyPaths.add(vaultPath);
		btn.setDisabled(true);
		btn.setButtonText(inProgressLabel);
		try {
			await action();
		} catch (e: unknown) {
			new Notice(`Failed: ${errorMessage(e)}`);
		} finally {
			this.busyPaths.delete(vaultPath);
			this.display();
		}
	}
}
