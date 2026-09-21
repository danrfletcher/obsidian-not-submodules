import { Notice, Plugin } from "obsidian";
import { errorMessage } from "./errors";
import { NotSubmodulesSettingTab } from "./settingsTab";
import { RepoEntry, SubmoduleEntry } from "./types";
import { getBasePath } from "./registry";
import { checkHookStatus, installHook } from "./hookInstall";
import { describeMigrationResult, MigrationResult, needsMigration, runMigrationAt } from "./migration";
import { MigrationModal } from "./migrationModal";

interface PluginData {
	registry: RepoEntry[];
	/** Whether this plugin has ever installed the hook in this vault (survives it going missing on a fresh clone). */
	hookInstalled: boolean;
	/** Last known submodules (PR-5) - read-only, refreshed the same way as the main registry. */
	submodules: SubmoduleEntry[];
}

export default class NotSubmodulesPlugin extends Plugin {
	/** Last known scan result, persisted across sessions so a Refresh has something to continuity-match against. */
	registry: RepoEntry[] = [];
	/** Mirrors `PluginData.hookInstalled` - whether we've ever successfully installed the hook in this vault. */
	hookInstalled = false;
	submodules: SubmoduleEntry[] = [];

	async onload() {
		const data = (await this.loadData()) as PluginData | null;
		this.registry = data?.registry ?? [];
		this.hookInstalled = data?.hookInstalled ?? false;
		this.submodules = data?.submodules ?? [];

		this.addSettingTab(new NotSubmodulesSettingTab(this.app, this));
		this.checkHookHealth();
		this.checkMigration();
	}

	async saveScanResult(entries: RepoEntry[], submodules: SubmoduleEntry[]): Promise<void> {
		this.registry = entries;
		this.submodules = submodules;
		await this.persist();
	}

	async saveRegistry(entries: RepoEntry[]): Promise<void> {
		this.registry = entries;
		await this.persist();
	}

	async setHookInstalled(installed: boolean): Promise<void> {
		this.hookInstalled = installed;
		await this.persist();
	}

	/** The one atomic "Migrate now" action, shared by the on-update popup and the settings-page banner. */
	async migrate(): Promise<MigrationResult> {
		const basePath = getBasePath(this.app);
		if (!basePath) throw new Error("Couldn't resolve the vault's location on disk.");

		const result = await runMigrationAt(basePath, this.registry);
		this.registry = result.entries;
		this.submodules = result.submodules;
		if (result.hookOutcome !== "foreign-hook-exists") this.hookInstalled = true;
		await this.persist();
		return result;
	}

	private async persist(): Promise<void> {
		const data: PluginData = { registry: this.registry, hookInstalled: this.hookInstalled, submodules: this.submodules };
		await this.saveData(data);
	}

	/**
	 * Git hooks are never tracked by git itself, so a vault cloned onto a new
	 * machine (or a fresh checkout) won't have one even though the plugin
	 * code did travel with it. If we previously installed it here and it's
	 * since gone missing, offer a one-time reinstall - shown once per load,
	 * since onload only ever runs once per session.
	 */
	private checkHookHealth(): void {
		if (!this.hookInstalled) return;
		const basePath = getBasePath(this.app);
		if (!basePath) return;
		if (checkHookStatus(basePath) !== "missing") return;

		const fragment = createFragment((el) => {
			el.appendText(
				"not-submodules: the git hook is missing from this copy of the vault (hooks aren't tracked by git, " +
					"so a fresh clone or checkout won't have it). "
			);
			const button = el.createEl("button", { text: "Reinstall now" });
			button.onclick = () => {
				const outcome = installHook(basePath);
				new Notice(outcome.message);
				notice.hide();
			};
		});
		const notice = new Notice(fragment, 0);
	}

	/**
	 * Shown once per load (onload only ever runs once per session) when the
	 * vault still shows the one reliable sign of a pre-rebuild install - the
	 * old static .gitignore line. Dismissing it leaves the settings-page
	 * banner as the persistent fallback; both drive the same `migrate()`.
	 */
	private checkMigration(): void {
		const basePath = getBasePath(this.app);
		if (!basePath || !needsMigration(basePath)) return;

		new MigrationModal(this.app, async () => {
			try {
				const result = await this.migrate();
				new Notice(describeMigrationResult(result));
			} catch (e: unknown) {
				new Notice(`Migration failed: ${errorMessage(e)}`);
			}
		}).open();
	}
}
