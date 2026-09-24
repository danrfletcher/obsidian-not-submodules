import { App, FileSystemAdapter } from "obsidian";
import { RepoEntry } from "./types";
import { ALWAYS_SKIPPED_NAMES, buildRegistryFromScan } from "./scan";

export function getBasePath(app: App): string | null {
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
	return null;
}

/** Folder names never worth descending into (Obsidian internals, vault-hygiene conventions). */
export function defaultIgnoredNames(app: App): Set<string> {
	return new Set([...ALWAYS_SKIPPED_NAMES, app.vault.configDir]);
}

/** Refresh entry point used by the settings tab - manual only, never run automatically. */
export async function scanAndBuildRegistry(
	app: App,
	previousRegistry: RepoEntry[]
): Promise<{ entries: RepoEntry[]; warnings: string[] }> {
	const basePath = getBasePath(app);
	if (!basePath) {
		return { entries: previousRegistry, warnings: ["Could not resolve the vault's location on disk."] };
	}
	return buildRegistryFromScan(basePath, previousRegistry, defaultIgnoredNames(app));
}
