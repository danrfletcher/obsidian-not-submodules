import { Plugin } from "obsidian";
import { NotSubmodulesSettingTab } from "./settingsTab";
import { RepoEntry } from "./types";

interface PluginData {
	registry: RepoEntry[];
}

export default class NotSubmodulesPlugin extends Plugin {
	/** Last known scan result, persisted across sessions so a Refresh has something to continuity-match against. */
	registry: RepoEntry[] = [];

	async onload() {
		const data = (await this.loadData()) as PluginData | null;
		this.registry = data?.registry ?? [];

		this.addSettingTab(new NotSubmodulesSettingTab(this.app, this));
	}

	async saveRegistry(entries: RepoEntry[]): Promise<void> {
		this.registry = entries;
		const data: PluginData = { registry: entries };
		await this.saveData(data);
	}
}
