// Minimal `require("obsidian")` stub. Obsidian is not installable outside the
// app, so the tests load main.js against these placeholders: enough shape for
// the module to evaluate, nothing more. Only `core` is exercised.
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  registerView() {}
  registerEvent() {}
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}
class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
  }
}
class Notice {
  constructor(message) {
    this.message = message;
  }
}
class TFile {}
class TFolder {}
class PluginSettingTab {}
class Setting {}
class Menu {}
const normalizePath = (p) => String(p).split("\\").join("/").replace(/[/]+/g, "/");

module.exports = {
  Plugin,
  ItemView,
  Notice,
  TFile,
  TFolder,
  PluginSettingTab,
  Setting,
  Menu,
  normalizePath,
};
