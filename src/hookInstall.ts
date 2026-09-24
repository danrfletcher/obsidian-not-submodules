import * as fs from "fs";
import * as path from "path";
import { HOOK_MARKER, PRE_COMMIT_HOOK_SCRIPT } from "./hookScript";

export type HookStatus = "installed" | "missing" | "foreign";

function hookPath(vaultBasePath: string): string {
	return path.join(vaultBasePath, ".git", "hooks", "pre-commit");
}

/** Whether the vault's `.git/hooks/pre-commit` (if any) is ours, absent, or someone else's. */
export function checkHookStatus(vaultBasePath: string): HookStatus {
	const p = hookPath(vaultBasePath);
	let content: string;
	try {
		content = fs.readFileSync(p, "utf8");
	} catch {
		return "missing";
	}
	return content.includes(HOOK_MARKER) ? "installed" : "foreign";
}

export type InstallOutcome =
	| { status: "installed"; message: string }
	| { status: "reinstalled"; message: string }
	| { status: "foreign-hook-exists"; message: string };

/**
 * Installs the pre-commit hook, refusing to overwrite a hook this plugin
 * didn't install itself - an existing foreign hook is left completely
 * untouched, and the caller is told to resolve it by hand.
 */
export function installHook(vaultBasePath: string): InstallOutcome {
	const status = checkHookStatus(vaultBasePath);
	const p = hookPath(vaultBasePath);

	if (status === "foreign") {
		return {
			status: "foreign-hook-exists",
			message:
				`A pre-commit hook already exists at "${path.relative(vaultBasePath, p)}" that this plugin didn't install. ` +
				"Resolve it manually (back it up, merge it, or remove it) before installing.",
		};
	}

	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
	fs.chmodSync(p, 0o755);

	return status === "installed"
		? { status: "reinstalled", message: "Git hook reinstalled." }
		: { status: "installed", message: "Git hook installed." };
}
