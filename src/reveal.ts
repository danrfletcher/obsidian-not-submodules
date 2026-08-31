import { App } from "obsidian";

/**
 * Reveals a vault path in Obsidian's built-in file explorer (left sidebar
 * navigation tree) - the same effect as right-clicking a file and choosing
 * "Reveal file in navigation". Returns false (and does nothing visible) if
 * the path doesn't exist in the vault or the file explorer isn't open/available.
 */
export function revealInFileExplorer(app: App, vaultPath: string): boolean {
	const file = vaultPath === "" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(vaultPath);
	if (!file) return false;

	const leaves = app.workspace.getLeavesOfType("file-explorer");
	if (leaves.length === 0) return false;

	const view = leaves[0].view as unknown as { revealInFolder?: (f: unknown) => void };
	if (typeof view.revealInFolder !== "function") return false;

	view.revealInFolder(file);
	void app.workspace.revealLeaf(leaves[0]);
	return true;
}
