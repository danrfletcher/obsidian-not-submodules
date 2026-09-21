import { LocationKind } from "./types";
import { normalizeOriginUrl } from "./gitUtils";

/** What the previous registry knew about one location, flattened for matching against a fresh scan. */
export interface PreviousLocationInfo {
	vaultPath: string;
	continuityKey: string;
	kind: LocationKind;
	originUrl: string;
}

/** One freshly-scanned location, as far as continuity matching cares. */
export interface CurrentLocationInfo {
	vaultPath: string;
	originUrl: string | null;
}

export interface ContinuityResult {
	/** current.vaultPath -> the continuityKey it should carry (reused identity, or a fresh one). */
	continuityKeys: Map<string, string>;
	/** Previous locations not found again by this scan and not recognised as moved - still real, just missing. */
	vanished: PreviousLocationInfo[];
}

function basenameOf(vaultPath: string): string {
	const parts = vaultPath.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? vaultPath;
}

/**
 * Recognises a rescanned location as one already known, rather than
 * "deleted + new", across drift (Q28). Vault path is primary: an exact path
 * match short-circuits everything else, matched or not. Only when there's
 * exactly one vanished previous location and exactly one new current
 * location does the "folder name or origin drifted" leniency apply (matching
 * on either); with more than one plausible candidate on either side, every
 * one of them is treated as new/unregistered rather than guessed at.
 */
export function matchContinuity(
	previous: PreviousLocationInfo[],
	current: CurrentLocationInfo[]
): ContinuityResult {
	const continuityKeys = new Map<string, string>();
	const matchedPreviousPaths = new Set<string>();

	for (const cur of current) {
		const exact = previous.find((p) => p.vaultPath === cur.vaultPath);
		if (exact) {
			continuityKeys.set(cur.vaultPath, exact.continuityKey);
			matchedPreviousPaths.add(exact.vaultPath);
		}
	}

	const currentPaths = new Set(current.map((c) => c.vaultPath));
	const vanishedCandidates = previous.filter(
		(p) => !matchedPreviousPaths.has(p.vaultPath) && !currentPaths.has(p.vaultPath)
	);
	const newCandidates = current.filter((c) => !continuityKeys.has(c.vaultPath));

	if (vanishedCandidates.length === 1 && newCandidates.length === 1) {
		const [vanished] = vanishedCandidates;
		const [fresh] = newCandidates;
		const nameMatches = basenameOf(vanished.vaultPath) === basenameOf(fresh.vaultPath);
		const originMatches = !!fresh.originUrl && normalizeOriginUrl(fresh.originUrl) === normalizeOriginUrl(vanished.originUrl);
		if (nameMatches || originMatches) {
			continuityKeys.set(fresh.vaultPath, vanished.continuityKey);
			matchedPreviousPaths.add(vanished.vaultPath);
		}
	}

	for (const cur of current) {
		if (!continuityKeys.has(cur.vaultPath)) continuityKeys.set(cur.vaultPath, cur.vaultPath);
	}

	const vanished = previous.filter((p) => !matchedPreviousPaths.has(p.vaultPath) && !currentPaths.has(p.vaultPath));

	return { continuityKeys, vanished };
}
