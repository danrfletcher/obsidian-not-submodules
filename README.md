# Not Submodules

An [Obsidian](https://obsidian.md) plugin that replaces git submodules with
plain nested git repos - ignored via `.gitignore` and tracked with a simple
YAML frontmatter convention on folder notes, instead of `.gitmodules`.

Submodules are brittle, especially on mobile and when using Obsidian with
iOS through terminal emulators such as iSH. This plugin avoids them
entirely: nested repos are just ordinary git repositories living inside
your vault, ignored by the vault's own repo, and declared in your notes so
they're easy to find, clone, and sync.

## How it works

- A nested repo lives in a folder named `<repo-name>-git-repo`.
- The vault's `.gitignore` gets a `*-git-repo/` line so nested repos are
  never tracked by the vault's own git history.
- A "folder note" (a markdown file with the same name as its parent
  folder - matching the [folder-notes](https://github.com/LostPaul/obsidian-folder-notes)
  plugin's `insideFolder` convention) declares the repos that live under
  it via a `git_repos` frontmatter key:

  ```yaml
  ---
  git_repos:
    - https://github.com/danrfletcher/obsidian-inline-agents.git
    - https://github.com/danrfletcher/obsidian-not-submodules.git
  ---
  ```

## Features

- **Initialise git repo** - one-click `git init` for the vault itself, if
  it isn't a git repository yet.
- **Ignore nested repos** - one-click append of `*-git-repo/` to the
  vault's `.gitignore` (creating it if needed).
- **Nested git repos list** - every registered repo, with Clone / Pull /
  Push controls, right in Settings.
- **Bulk actions** - "Clone all missing", "Pull all", and "Push all",
  each hidden automatically when there's nothing for it to do.
- **Register a repo** - point the plugin at an existing `-git-repo` folder
  (with an autocomplete path picker) and it declares it in the right
  folder note automatically, creating the folder note - and, if the repo
  sits at the vault root, a dedicated parent folder for it - when needed.
- **Command palette & ribbon icon** - register the repo containing your
  current file without leaving it.
- **Reveal in navigator** - click a repo's name in the list to reveal it
  (or, if it isn't cloned yet, its parent folder) in the file explorer.

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
```

## License

MIT
