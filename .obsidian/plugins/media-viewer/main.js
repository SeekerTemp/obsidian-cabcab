const { Plugin, ItemView } = require("obsidian");

const VIEW_TYPE_MEDIA_VIEWER = "media-viewer-pane";

/* ------------------------------------------------------------------------ *
 * core — pure functions. No Obsidian API, no I/O, no `this`.
 * Everything between this banner and the next one runs under plain node with
 * a stubbed `require("obsidian")`, which is the only way this maths gets
 * verified without launching Obsidian. See tests/core.test.js.
 * ------------------------------------------------------------------------ */

/* (filled in by MV-CORE) */

/* ------------------------------------------------------------------------ *
 * End of core. Everything below touches Obsidian.
 * ------------------------------------------------------------------------ */

class MediaViewerView extends ItemView {
  getViewType() {
    return VIEW_TYPE_MEDIA_VIEWER;
  }

  getDisplayText() {
    return "Media Viewer";
  }

  getIcon() {
    return "image";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("media-viewer");
    root.createDiv({ cls: "mv-empty", text: "No folder selected." });
  }

  async onClose() {
    this.contentEl.empty();
  }
}

class MediaViewerPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_MEDIA_VIEWER, (leaf) => new MediaViewerView(leaf));

    this.addRibbonIcon("image", "Open Media Viewer", () => this.activateView());

    this.addCommand({
      id: "open-media-viewer",
      name: "Open Media Viewer",
      callback: () => this.activateView(),
    });
  }

  // Reuse an existing pane rather than stacking duplicates; a second ribbon
  // click should reveal the pane already open, not open another.
  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_MEDIA_VIEWER, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }
}

module.exports = MediaViewerPlugin;
