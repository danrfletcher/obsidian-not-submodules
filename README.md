# Not Submodules

An [Obsidian](https://obsidian.md) plugin that replaces git submodules with
plain nested git repos - discovered by scanning your vault's filesystem and
kept out of your vault's own git history by a self-maintaining pre-commit
hook, instead of `.gitmodules`.

Submodules are brittle, especially on mobile and when using Obsidian with
iOS through terminal emulators such as iSH. This plugin avoids them
entirely: nested repos are just ordinary git repositories living inside
your vault, automatically found and ignored by the vault's own repo - no
folder-naming convention, no frontmatter, no manual registration step.

## How it works

- Click **Refresh** in Settings and the plugin walks your vault for nested
  `.git` entries, classifying each as an **original** clone, a git
  **worktree**, or a real git **submodule** (read-only, sourced from
  `.gitmodules`).
- Locations that share the same origin remote (however they're named,
  wherever they live) are grouped into one entry, so a repo cloned in more
  than one place - or a clone plus its worktrees - shows up as one thing,
  not several.
- **Install git hook** installs a plain POSIX pre-commit hook that
  re-scans your vault on every commit and keeps a managed block in
  `.gitignore` in sync automatically - no naming convention, no manual
  `.gitignore` editing, ever.
- A repo folder can be renamed, or its remote URL respelled (SSH vs
  HTTPS), without looking like a deletion - the next Refresh recognises it
  as the same location.

## Features

- **Initialise git repo** - one-click `git init` for the vault itself, if
  it isn't a git repository yet.
- **Install git hook** - installs the self-maintaining pre-commit hook;
  refuses to overwrite a hook it didn't install itself, and offers to
  reinstall if it ever goes missing (hooks aren't tracked by git, so a
  fresh clone or checkout won't have one).
- **Refresh** - rescans the vault's filesystem and rebuilds the list.
  Manual only - nothing scans automatically on startup.
- **Originals & Worktrees, per repo** - Clone / Push / Pull / Delete /
  Remove and a branch dropdown (switching to a remote-only branch fetches
  it first) for every location; **New** clones the origin again at a vault
  path you choose. Delete leaves a location listed as "missing" until you
  Remove it; a repo with no locations left disappears on the next Refresh.
- **Stash / Pop Stash** - a dirty working tree greys out the branch
  dropdown and offers Stash; Pop Stash is only enabled while you're back on
  the branch the stash came from.
- **Worktree repair** - detects a worktree whose folder was moved outside
  `git worktree move` and offers a one-click repair.
- **Submodules** - a read-only section listing every real git submodule
  declared in `.gitmodules`, including ones not yet initialized on disk.
- **Migration** - existing installs of the plugin's old naming-convention
  system are carried forward automatically: an on-update popup (or a
  persistent settings banner if you dismiss it) rescans your vault,
  installs the hook, and removes the old static `.gitignore` line, all in
  one step. Nothing you'd already registered is lost.

## Installation

This plugin is desktop-only (`isDesktopOnly: true`), since it shells out
to your local `git`.

Manual installation: copy `main.js`, `manifest.json`, and `styles.css`
from a [release](../../releases) into
`<your-vault>/.obsidian/plugins/not-submodules/`, then enable it in
Obsidian's Community plugins settings.

## Development

```
npm install
npm run dev     # watch build
npm run build   # type-check + production build
npm test        # unit + integration tests (tsx --test)
```

## License

MIT
