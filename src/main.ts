import { Notice, Plugin, TFile } from "obsidian";
import { NotSubmodulesSettingTab } from "./settingsTab";
import { findEnclosingGitRepoFolder, registerRepoAtPath } from "./registerRepo";

export default class NotSubmodulesPlugin extends Plugin {
	async onload() {
		this.addSettingTab(new NotSubmodulesSettingTab(this.app, this));

		this.addCommand({
			id: "register-current-git-repo",
			name: "Register this git repo (not-submodules)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const repoFolder = findEnclosingGitRepoFolder(file);
				if (!repoFolder) return false;
				if (!checking) {
					this.registerFromFile(file);
				}
				return true;
			},
		});

		this.addRibbonIcon("git-branch", "Register this git repo (not-submodules)", () => {
			const file = this.app.workspace.getActiveFile();
			if (!file) {
				new Notice("Open a file inside a -git-repo folder first.");
				return;
			}
			this.registerFromFile(file);
		});
	}

	private async registerFromFile(file: TFile) {
		const repoFolder = findEnclosingGitRepoFolder(file);
		if (!repoFolder) {
			new Notice("This file isn't inside a -git-repo folder.");
			return;
		}
		try {
			const outcome = await registerRepoAtPath(this.app, repoFolder.path);
			new Notice(outcome.message);
		} catch (e: any) {
			new Notice(`Couldn't register: ${e?.message ?? e}`);
		}
	}
}
