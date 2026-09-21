import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistryFromScan, scanSubmodules } from "../scan";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "not-submodules-submodules-"));
}

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

test("scanSubmodules: a well-formed .gitmodules yields path/url pairs, flagged initialized when the working tree exists", () => {
	const root = tmpDir();
	fs.writeFileSync(
		path.join(root, ".gitmodules"),
		[
			'[submodule "foo"]',
			"\tpath = vendor/foo",
			"\turl = https://example.com/foo.git",
			'[submodule "bar"]',
			"\tpath = vendor/bar",
			"\turl = https://example.com/bar.git",
			"",
		].join("\n")
	);
	fs.mkdirSync(path.join(root, "vendor", "foo", ".git"), { recursive: true });
	// vendor/bar deliberately has no .git - not initialized.

	const submodules = scanSubmodules(root).sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
	assert.deepStrictEqual(submodules, [
		{ vaultPath: "vendor/bar", url: "https://example.com/bar.git", initialized: false },
		{ vaultPath: "vendor/foo", url: "https://example.com/foo.git", initialized: true },
	]);
});

test("scanSubmodules: no .gitmodules yields an empty list, never throws", () => {
	const root = tmpDir();
	assert.doesNotThrow(() => scanSubmodules(root));
	assert.deepStrictEqual(scanSubmodules(root), []);
});

test("scanSubmodules: a malformed .gitmodules yields an empty list rather than crashing", () => {
	const root = tmpDir();
	fs.writeFileSync(path.join(root, ".gitmodules"), "\0\0\0 not remotely ini-shaped {{{ [[[ ===");
	assert.doesNotThrow(() => scanSubmodules(root));
});

test("scanSubmodules: an empty .gitmodules yields an empty list", () => {
	const root = tmpDir();
	fs.writeFileSync(path.join(root, ".gitmodules"), "");
	assert.deepStrictEqual(scanSubmodules(root), []);
});

test("scanSubmodules: the declared path is reported exactly as written, even if it doesn't match reality on disk", () => {
	const root = tmpDir();
	fs.writeFileSync(
		path.join(root, ".gitmodules"),
		['[submodule "foo"]', "\tpath = declared/path/foo", "\turl = https://example.com/foo.git", ""].join("\n")
	);
	// Nothing exists at declared/path/foo on disk at all.
	const submodules = scanSubmodules(root);
	assert.strictEqual(submodules.length, 1);
	assert.strictEqual(submodules[0].vaultPath, "declared/path/foo");
	assert.strictEqual(submodules[0].initialized, false);
});

test("integration: a real git-submodule-add-created submodule appears in scanSubmodules and nowhere in the main registry", async (t) => {
	const remote = tmpDir();
	git(["init", "-q"], remote);
	git(["config", "user.email", "test@example.com"], remote);
	git(["config", "user.name", "Test"], remote);
	fs.writeFileSync(path.join(remote, "README.md"), "remote\n");
	git(["add", "-A"], remote);
	git(["commit", "-q", "-m", "init"], remote);
	t.after(() => fs.rmSync(remote, { recursive: true, force: true }));

	const host = tmpDir();
	t.after(() => fs.rmSync(host, { recursive: true, force: true }));
	git(["init", "-q"], host);
	git(["config", "user.email", "test@example.com"], host);
	git(["config", "user.name", "Test"], host);
	fs.writeFileSync(path.join(host, "README.md"), "host\n");
	git(["add", "-A"], host);
	git(["commit", "-q", "-m", "init"], host);
	git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", remote, "vendor/sub"], host);

	const submodules = scanSubmodules(host);
	assert.strictEqual(submodules.length, 1);
	assert.strictEqual(submodules[0].vaultPath, "vendor/sub");
	assert.strictEqual(submodules[0].initialized, true);

	const { entries } = await buildRegistryFromScan(host, []);
	const allLocationPaths = entries.flatMap((e) => e.locations.map((l) => l.vaultPath));
	assert.ok(!allLocationPaths.includes("vendor/sub"), "a real submodule must never appear in the main registry");
});

test("integration: a submodule and an unrelated tracked repo sharing the same origin are never merged into one entry", async (t) => {
	const remote = tmpDir();
	git(["init", "-q"], remote);
	git(["config", "user.email", "test@example.com"], remote);
	git(["config", "user.name", "Test"], remote);
	fs.writeFileSync(path.join(remote, "README.md"), "remote\n");
	git(["add", "-A"], remote);
	git(["commit", "-q", "-m", "init"], remote);
	t.after(() => fs.rmSync(remote, { recursive: true, force: true }));

	const host = tmpDir();
	t.after(() => fs.rmSync(host, { recursive: true, force: true }));
	git(["init", "-q"], host);
	git(["config", "user.email", "test@example.com"], host);
	git(["config", "user.name", "Test"], host);
	fs.writeFileSync(path.join(host, "README.md"), "host\n");
	git(["add", "-A"], host);
	git(["commit", "-q", "-m", "init"], host);
	git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", remote, "vendor/sub"], host);

	// An unrelated plain clone of the exact same remote, elsewhere in the vault - tracked normally, not as a submodule.
	git(["clone", "-q", remote, path.join(host, "libs", "plain-clone")], host);

	const submodules = scanSubmodules(host);
	assert.strictEqual(submodules.length, 1);
	assert.strictEqual(submodules[0].vaultPath, "vendor/sub");

	const { entries } = await buildRegistryFromScan(host, []);
	const plainCloneEntry = entries.find((e) => e.locations.some((l) => l.vaultPath === "libs/plain-clone"));
	assert.ok(plainCloneEntry, "the plain clone should appear in the main registry");
	assert.strictEqual(plainCloneEntry!.locations.length, 1, "must not be merged with the submodule's location");
	assert.ok(!plainCloneEntry!.locations.some((l) => l.vaultPath === "vendor/sub"));
});

test("integration: a deinitialized submodule is still listed, flagged as not initialized", async (t) => {
	const remote = tmpDir();
	git(["init", "-q"], remote);
	git(["config", "user.email", "test@example.com"], remote);
	git(["config", "user.name", "Test"], remote);
	fs.writeFileSync(path.join(remote, "README.md"), "remote\n");
	git(["add", "-A"], remote);
	git(["commit", "-q", "-m", "init"], remote);
	t.after(() => fs.rmSync(remote, { recursive: true, force: true }));

	const host = tmpDir();
	t.after(() => fs.rmSync(host, { recursive: true, force: true }));
	git(["init", "-q"], host);
	git(["config", "user.email", "test@example.com"], host);
	git(["config", "user.name", "Test"], host);
	fs.writeFileSync(path.join(host, "README.md"), "host\n");
	git(["add", "-A"], host);
	git(["commit", "-q", "-m", "init"], host);
	git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", remote, "vendor/sub"], host);
	git(["commit", "-q", "-m", "add submodule"], host);

	git(["submodule", "deinit", "-f", "vendor/sub"], host);

	const submodules = scanSubmodules(host);
	assert.strictEqual(submodules.length, 1);
	assert.strictEqual(submodules[0].vaultPath, "vendor/sub");
	assert.strictEqual(submodules[0].initialized, false);
});
