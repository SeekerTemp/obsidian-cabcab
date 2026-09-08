# Media Viewer — task handoff index

One task per session. Start a session by naming the keyword, for example:

> `MV-GRID` — continue from the handoff index

Each task reads the design spec
([`2026-09-08-media-viewer-design.md`](2026-09-08-media-viewer-design.md)) for
the detail, does the work, commits on `feature/media-viewer`, and ticks its box
here.

Rules that hold for every task:

- Plain JavaScript, no build step. Everything lives in
  `.obsidian/plugins/media-viewer/main.js`, with pure logic in the `core` block
  at the top of the file, exported as `module.exports.core`.
- Anything in `core` gets node tests in `tests/core.test.js`, run with a stubbed
  `require("obsidian")` — the pattern Schema Sync already uses.
- One commit per task. Reload Obsidian to test.
- A task is done when its **Verify** line actually passes, not when the code
  looks right.

---

## M1 — Browse

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 1 | `MV-SCAFFOLD` | Plugin loads: `manifest.json` (`isDesktopOnly: true`), `main.js`, `styles.css`, ribbon icon opening an empty `ItemView` | all three files | — | Plugin appears in settings, ribbon opens an empty pane |
| 2 | `MV-CORE` | `core` block + node test harness: extension classification, zoom clamping, clone-path and sidecar-path builders with collision suffixes | `main.js`, `tests/core.test.js` | 1 | `node tests/core.test.js` passes |
| 3 | `MV-INDEX` | `MediaIndex`: ordered media for one folder from `vault.getFiles()`; `create`/`modify`/`delete`/`rename` handling, **idempotent by path**; `.instance.md` never listed | `main.js` | 2 | Adding a file to the folder updates the list once, not twice |
| 4 | `MV-FOLDER` | Folder selection: pane follows the active file, **Open in Media Viewer** on a folder's context menu, last folder remembered | `main.js` | 3 | Clicking a PNG shows its folder; restart restores it |
| 5 | `MV-GRID` | Thumbnail grid: `IntersectionObserver` lazy loading, LRU cap, selection keyed by **path**, image/video/both filter | `main.js`, `styles.css` | 4 | 500-file folder scrolls smoothly; only visible thumbs load |
| 6 | `MV-IMAGE` | Image viewer: wheel and `W`/`S` zoom, pan, fit-to-pane, reset to 100%, `A`/`D` sibling navigation | `main.js`, `styles.css` | 5 | Zoom, pan and keyboard navigation all work |
| 7 | `MV-LAYOUT` | Container-query layout so the pane reflows on **pane** width when docked in a split | `styles.css` | 6 | Narrow split stacks; wide split sits side by side |

## M2 — Video

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 8 | `MV-VIDEO` | Video viewer: `Space` play/pause, scrub bar, position and duration readout, `W`/`S` seek ±5s, frame-step | `main.js`, `styles.css` | 6 | An mp4 plays, scrubs and frame-steps |
| 9 | `MV-SPEED` | Playback speed 0.25x–4x | `main.js` | 8 | Speed control changes playback rate |
| 10 | `MV-VTHUMB` | Video thumbnails: seek to 1s, draw once to canvas, cache as blob URL | `main.js` | 8 | Videos show real frames in the grid |
| 11 | `MV-REVERSE` | Reverse playback by stepping `currentTime` under `requestAnimationFrame`; **measure achieved frame rate**; reduced-resolution scrub fallback | `main.js` | 9, 21 | Reverse plays; the measured rate is logged. If unusable on real files, say so — dropping this is allowed |
| 12 | `MV-FRAME` | Frame capture to `<stem>+frame+<ms>ms+<ts>.png` | `main.js` | 10 | Captured PNG matches the displayed frame |

## M3 — Edit

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 13 | `MV-CROPMATH` | Crop mapping in `core`: divide by zoom, **floor top-left, ceil bottom-right**, clamp, reject sub-1x1. Tests across zoom levels, all rotation/flip combinations, and selections overhanging the edge | `main.js`, `tests/core.test.js` | 2 | `node tests/core.test.js` passes. **This is the task the old app got wrong** |
| 14 | `MV-SESSION` | `EditSession`: fixed pipeline `rotate → flip → crop → resize`, crop stored in oriented space, undo/redo, canvas render | `main.js` | 13 | Crop then rotate then undo behaves predictably |
| 15 | `MV-BUDGET` | Decode budget: refuse over 40 MP naming the dimensions; downscaled display proxy over 4096px with maths still in full source coordinates | `main.js` | 14 | A huge PNG is refused cleanly instead of freezing the pane |
| 16 | `MV-OVERLAY` | `CropOverlay`: drag-select on the viewer in place, eight resize handles, aspect lock, live source-pixel readout | `main.js`, `styles.css` | 15 | A selection can be adjusted by its handles, not just redrawn |
| 17 | `MV-TRANSFORM` | Rotate 90°, flip H/V, resize by dimensions or scale, with the crop rect carried through rotation | `main.js` | 16 | Rotating with a crop set keeps the same region selected |
| 18 | `MV-SAVE` | Format-following encode (JPEG/WebP at quality, PNG otherwise) then `vault.createBinary`; selection follows to the new file with **no rescan** | `main.js` | 17 | Cropping a JPEG yields a JPEG, not a 15 MB PNG. Scroll position survives |

## M4 — Lineage

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 19 | `MV-STORE` | `LineageStore`: read, write and discover `.instance.md`; `media:` authoritative over filename; notes marker preserved on every rewrite | `main.js`, `tests/core.test.js` | 18 | A note round-trips with text below the marker intact |
| 20 | `MV-TRACK` | Note written on every derived save (with `crop`, `transform`, `status`, `labels`), **plus a root note for the source**. Viewing writes nothing. **Mark as reviewed** command | `main.js` | 19 | One crop produces two notes. Opening a file produces none |
| 21 | `MV-RESOLVE` | `MetadataResolver`: walk the `source:` chain, first declaring ancestor wins, cycle guard, 32-hop cap, missing-ancestor reporting | `main.js`, `tests/core.test.js` | 20 | Editing a parent field changes what a grandchild resolves |
| 22 | `MV-PANEL` | Lineage panel: parent, children, and which fields are inherited from where | `main.js`, `styles.css` | 21 | The chain is visible and navigable |
| 23 | `MV-RENAME` | `rename` handling: **short-circuit on untracked files**, sidecar follows its own media, every `source:` link rewritten, children never renamed | `main.js` | 22 | Rename a parent via Asset Renamer with Obsidian link-updating **off** — children still resolve |
| 24 | `MV-REPAIR` | **Repair lineage** for a missing or broken note; vault-wide lineage break report; dangling `source:` reported never silently fixed | `main.js` | 23 | Deleting a note and repairing restores it |

## M5 — Diagnostics

Build `MV-LOG` early if anything above is hard to debug — task 11 already depends
on it for its frame-rate measurement.

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 25 | `MV-LOG` | `DebugLog`: 2000-entry ring buffer, 500 ms debounced flush to `.obsidian/plugins/media-viewer/debug.log`, structured greppable lines, `window.onerror` and `unhandledrejection` capture, off by default | `main.js`, `.gitignore` | 1 | Toggle on, cause an error, `cat` the log and see it |
| 26 | `MV-TIMING` | Timings for scan, first-visible-thumbs, decode, encode, save and resolution; rename cascades log every rewritten link; **Copy debug log** command | `main.js` | 25 | Log shows `ms=` for each operation |

## M6 — Polish

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 27 | `MV-ERRORS` | Every row of the spec's error-handling table, guarded so one bad file never kills the grid; failed save keeps the edit session open | `main.js` | 24 | A folder of corrupt files still browses |
| 28 | `MV-SETTINGS` | Settings tab: recursive scan, JPEG/WebP quality, sidecar creation, debug logging | `main.js` | 27 | Settings persist across reload |
| 29 | `MV-PERF` | Manual performance pass at 20 / 100 / 500+ files; record numbers in this file | — | 28 | Numbers recorded below |
| 30 | `MV-README` | Plugin `README.md` in the vault's documentation style | `README.md` | 29 | — |

## M7 — Overview tab (deferred)

Not part of the first build. The data it needs already exists after M4.

| # | Keyword | Goal | Needs |
| --- | --- | --- | --- |
| 31 | `MV-OVERVIEW` | Unreviewed list (all vault media minus those with notes), unlabelled list, lineage breaks, filter by `status:` and folder | 24 |

---

## Progress

- [ ] 1 `MV-SCAFFOLD`
- [ ] 2 `MV-CORE`
- [ ] 3 `MV-INDEX`
- [ ] 4 `MV-FOLDER`
- [ ] 5 `MV-GRID`
- [ ] 6 `MV-IMAGE`
- [ ] 7 `MV-LAYOUT`
- [ ] 8 `MV-VIDEO`
- [ ] 9 `MV-SPEED`
- [ ] 10 `MV-VTHUMB`
- [ ] 11 `MV-REVERSE`
- [ ] 12 `MV-FRAME`
- [ ] 13 `MV-CROPMATH`
- [ ] 14 `MV-SESSION`
- [ ] 15 `MV-BUDGET`
- [ ] 16 `MV-OVERLAY`
- [ ] 17 `MV-TRANSFORM`
- [ ] 18 `MV-SAVE`
- [ ] 19 `MV-STORE`
- [ ] 20 `MV-TRACK`
- [ ] 21 `MV-RESOLVE`
- [ ] 22 `MV-PANEL`
- [ ] 23 `MV-RENAME`
- [ ] 24 `MV-REPAIR`
- [ ] 25 `MV-LOG`
- [ ] 26 `MV-TIMING`
- [ ] 27 `MV-ERRORS`
- [ ] 28 `MV-SETTINGS`
- [ ] 29 `MV-PERF`
- [ ] 30 `MV-README`
- [ ] 31 `MV-OVERVIEW` (deferred)

## Performance numbers

Filled in by `MV-PERF`.

| Files | Scan ms | First visible thumbs ms | Notes |
| --- | --- | --- | --- |
| 20 | | | |
| 100 | | | |
| 500+ | | | |
