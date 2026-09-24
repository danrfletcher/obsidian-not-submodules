import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { checkHookStatus, installHook } from "../hookInstall";
import { HOOK_MARKER } from "../hookScript";

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-hookinstall-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

function hookPath(repo: string): string {
	return path.join(repo, ".git", "hooks", "pre-commit");
}

test("checkHookStatus: missing when no hook file exists", (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	assert.strictEqual(checkHookStatus(repo), "missing");
});

test("checkHookStatus: foreign when a hook exists without our marker", (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	fs.mkdirSync(path.dirname(hookPath(repo)), { recursive: true });
	fs.writeFileSync(hookPath(repo), "#!/bin/sh\necho 'someone else'\n");
	assert.strictEqual(checkHookStatus(repo), "foreign");
});

test("checkHookStatus: installed once our hook is written", (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	installHook(repo);
	assert.strictEqual(checkHookStatus(repo), "installed");
});

test("installHook: fresh install writes an executable hook and reports 'installed'", (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	const outcome = installHook(repo);
	assert.strictEqual(outcome.status, "installed");
	const stat = fs.statSync(hookPath(repo));
	assert.ok(stat.mode & 0o111, "hook should be executable");
	assert.ok(fs.readFileSync(hookPath(repo), "utf8").includes(HOOK_MARKER));
});

test("installHook: installing again over our own hook reports 'reinstalled'", (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	installHook(repo);
	const outcome = installHook(repo);
	assert.strictEqual(outcome.status, "reinstalled");
});

test("installHook: refuses to overwrite a foreign hook, leaving it byte-for-byte untouched", (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	fs.mkdirSync(path.dirname(hookPath(repo)), { recursive: true });
	const foreignContent = "#!/bin/sh\necho 'do not touch me'\n";
	fs.writeFileSync(hookPath(repo), foreignContent);

	const outcome = installHook(repo);
	assert.strictEqual(outcome.status, "foreign-hook-exists");
	assert.strictEqual(fs.readFileSync(hookPath(repo), "utf8"), foreignContent);
});
