# obsidian-cabcab

An Obsidian vault and the plugins written for it. `main` carries the whole thing:
every plugin, every setting, the snippets and the themes. Development happens on
branches that carry far less.

## The plugins

| Plugin | What it is | Docs |
| --- | --- | --- |
| **Schema Sync** | CabCab Scheme DB — markdown as a database. Schemas, records and value lists are notes; it keeps them consistent and generates the Bases tables and the DBML ERD. Asset Renamer is built into it. | [README](.obsidian/plugins/schema-sync/README.md) · [manual](.obsidian/plugins/schema-sync/docs/manual.md) · [agent contract](.obsidian/plugins/schema-sync/docs/agent-contract.md) |
| **Media Viewer** | A pane for browsing the vault's images and video. | [README](.obsidian/plugins/media-viewer/README.md) |
| **Video Editor** | Trimming and conversion over a local ffmpeg. | [README](.obsidian/plugins/video-editor/README.md) · [setup](.obsidian/plugins/video-editor/docs/SETUP.md) |

Each plugin's README is the record of what it is and why it works the way it
does. Design notes and handoffs sit in its `docs/` folder beside it.

[`CLAUDE.md`](CLAUDE.md) loads automatically in an agent session and carries the
rules for writing into `data/`.

## Branches

| Branch | Carries |
| --- | --- |
| `main` | The whole vault. Plugins land here to be tested together. |
| `feature/<plugin>` | `.githooks/`, `.obsidian/` minus snippets and themes, and only the plugins under development. Everything else is ignored. |
| `data/<project>` | One project's notes, with `data/` tracked. Plugins come from `main`. |

Scope a feature branch with:

```bash
.githooks/scope-branch <plugin> [<plugin>...]
```

**Plugin work reaches `main` by copying the plugin folder across, or by
cherry-picking — never by merging a feature branch.** Those branches have every
other plugin *untracked*, so a merge arrives as "delete everything else".
[`.githooks/pre-push`](.githooks/pre-push) refuses a push to `main` that deletes
anything under `.obsidian/plugins/`, `.obsidian/snippets/`, `.obsidian/themes/`
or the vault's content folders. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

The same asymmetry runs the other way: `data/` belongs on a `data/<project>`
branch, and the hook refuses to push it onto `main` or a feature branch.
