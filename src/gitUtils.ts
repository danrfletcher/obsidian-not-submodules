import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileP = promisify(execFileCb);

export interface GitResult {
	stdout: string;
	stderr: string;
}

interface ExecFileError extends Error {
	stderr?: unknown;
}

function toExecFileError(e: unknown): ExecFileError {
	return e instanceof Error ? (e as ExecFileError) : new Error(String(e));
}

/** Stringifies a Buffer/string/anything without referencing the Buffer type directly. */
function stringifyMaybeBuffer(v: unknown): string {
	if (typeof v === "string") return v;
	if (v == null) return "";
	if (typeof v === "object" && "toString" in v && typeof (v as { toString: unknown }).toString === "function") {
		return String(v);
	}
	return "";
}

/** Run a git command with argv-style args (no shell involved, so no quoting issues). */
export async function runGit(args: string[], cwd: string, timeoutMs = 120000): Promise<GitResult> {
	try {
		const { stdout, stderr } = await execFileP("git", args, {
			cwd,
			maxBuffer: 20 * 1024 * 1024,
			timeout: timeoutMs,
		});
		return { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
	} catch (e: unknown) {
		const err = toExecFileError(e);
		const stderrText = stringifyMaybeBuffer(err.stderr);
		const msg = (stderrText && stderrText.trim()) || err.message || String(e);
		throw new Error(msg.trim());
	}
}

export async function gitInit(cwd: string): Promise<GitResult> {
	return runGit(["init"], cwd);
}

/** Clones `url` into `targetAbsPath` (which must not already exist). */
export async function gitClone(url: string, targetAbsPath: string): Promise<GitResult> {
	const parent = path.dirname(targetAbsPath);
	return runGit(["clone", "--", url, targetAbsPath], parent);
}

export async function gitPull(cwd: string): Promise<GitResult> {
	return runGit(["pull"], cwd);
}

export async function gitPush(cwd: string): Promise<GitResult> {
	return runGit(["push"], cwd);
}

export async function gitRemoteUrl(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await runGit(["remote", "get-url", "origin"], cwd);
		const url = stdout.trim();
		return url || null;
	} catch {
		return null;
	}
}

export function hasGitDir(absPath: string): boolean {
	try {
		return fs.existsSync(path.join(absPath, ".git"));
	} catch {
		return false;
	}
}

export function repoNameFromUrl(url: string): string {
	const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
	const parts = cleaned.split(/[/:]/).filter(Boolean);
	return parts[parts.length - 1] || "repo";
}

/**
 * Normalizes a git origin URL so that SSH and HTTPS forms of the same
 * host+path compare equal (Q30) - used both for grouping locations into one
 * repo entry and for continuity matching across an origin spelling change.
 *
 * Handles: scheme-form URLs (https://, ssh://, git://, ...), SCP-like SSH
 * syntax (git@host:path), embedded credentials (user[:pass]@host), a
 * trailing ".git", and host case. Never throws - empty or unparseable input
 * produces a stable (possibly empty) string the caller can treat as falsy.
 */
export function normalizeOriginUrl(url: string): string {
	if (typeof url !== "string") return "";
	const trimmed = url.trim();
	if (!trimmed) return "";

	const schemeMatch = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/);
	let rest: string;
	if (schemeMatch) {
		rest = schemeMatch[1];
	} else {
		// SCP-like syntax: [user@]host:path (e.g. git@github.com:user/repo.git).
		const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
		rest = scpMatch ? `${scpMatch[1]}/${scpMatch[2]}` : trimmed;
	}

	// Strip embedded credentials (user or user:pass before an "@").
	rest = rest.replace(/^[^@/\s]+@/, "");

	const slashIdx = rest.indexOf("/");
	const rawHost = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
	const rawPath = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);

	const host = rawHost.trim().toLowerCase();
	const pathPart = rawPath
		.trim()
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");

	if (!host && !pathPart) return "";
	if (host && pathPart) return `${host}/${pathPart}`;
	return host || pathPart;
}

/**
 * Cleans up a git URL as typed/pasted by hand into frontmatter: trims
 * whitespace and strips stray trailing commas/semicolons - an easy typo
 * when hand-editing a YAML list (e.g. carrying over comma habits from
 * JSON), which would otherwise silently break folder-path matching for
 * that entry (the derived folder name would include the stray punctuation
 * and never match the real -git-repo folder on disk).
 */
export function sanitizeGitUrl(raw: unknown): string {
	return String(raw ?? "")
		.trim()
		.replace(/[,;]+$/, "")
		.trim();
}
