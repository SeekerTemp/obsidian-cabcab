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
  // Recorded rather than dropped, so a test can check that a command is
  // registered and can invoke it the way the palette would.
  addCommand(command) {
    (this.commands = this.commands || []).push(command);
    return command;
  }
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
/* Every Notice is recorded, because what the user is told when something goes
   wrong is behaviour worth asserting rather than a side effect to ignore. A
   test that cares clears the list first. */
class Notice {
  constructor(message) {
    this.message = message;
    Notice.messages.push(String(message));
  }
}
Notice.messages = [];
class TFile {}
class TFolder {}

/* Enough Modal to build one and read what it drew. The real one owns a
   container element and a lifecycle; the stub gives it a contentEl of the
   kind the DOM stub makes, and records whether it was opened. */
class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl =
      typeof document !== "undefined" && document.createElement
        ? document.createElement("div")
        : null;
    this.opened = false;
  }
  open() {
    this.opened = true;
    Modal.opened.push(this);
    if (typeof this.onOpen === "function") this.onOpen();
    return this;
  }
  close() {
    this.opened = false;
    if (typeof this.onClose === "function") this.onClose();
  }
}
Modal.opened = [];

/* A settings tab, and the fluent builder Obsidian's settings use. Each Setting
   records what it was given, so a test can assert that a control exists and
   drive its callback the way a click would. */
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl =
      typeof document !== "undefined" && document.createElement
        ? document.createElement("div")
        : null;
  }
}

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.name = "";
    this.desc = "";
    this.controls = [];
    (Setting.created = Setting.created || []).push(this);
  }
  setName(name) {
    this.name = name;
    return this;
  }
  setDesc(desc) {
    this.desc = desc;
    return this;
  }
  setHeading() {
    this.heading = true;
    return this;
  }
  addToggle(build) {
    const control = { kind: "toggle", value: false };
    control.setValue = (value) => {
      control.value = value;
      return control;
    };
    control.onChange = (fn) => {
      control.change = fn;
      return control;
    };
    build(control);
    this.controls.push(control);
    return this;
  }
  addSlider(build) {
    const control = { kind: "slider", value: 0 };
    control.setLimits = (min, max, step) => {
      Object.assign(control, { min, max, step });
      return control;
    };
    control.setValue = (value) => {
      control.value = value;
      return control;
    };
    control.setDynamicTooltip = () => control;
    control.onChange = (fn) => {
      control.change = fn;
      return control;
    };
    build(control);
    this.controls.push(control);
    return this;
  }
  addText(build) {
    const control = { kind: "text", value: "" };
    control.setPlaceholder = (text) => {
      control.placeholder = text;
      return control;
    };
    control.setValue = (value) => {
      control.value = value;
      return control;
    };
    control.onChange = (fn) => {
      control.change = fn;
      return control;
    };
    build(control);
    this.controls.push(control);
    return this;
  }
  addDropdown(build) {
    const control = { kind: "dropdown", options: {}, value: "" };
    control.addOption = (value, label) => {
      control.options[value] = label;
      return control;
    };
    control.setValue = (value) => {
      control.value = value;
      return control;
    };
    control.onChange = (fn) => {
      control.change = fn;
      return control;
    };
    build(control);
    this.controls.push(control);
    return this;
  }
  addButton(build) {
    const control = { kind: "button" };
    control.setButtonText = (text) => {
      control.text = text;
      return control;
    };
    control.setCta = () => control;
    control.onClick = (fn) => {
      control.click = fn;
      return control;
    };
    build(control);
    this.controls.push(control);
    return this;
  }
}
Setting.created = [];

class Menu {}
const normalizePath = (p) => String(p).split("\\").join("/").replace(/[/]+/g, "/");

module.exports = {
  Plugin,
  ItemView,
  Modal,
  Notice,
  TFile,
  TFolder,
  PluginSettingTab,
  Setting,
  Menu,
  normalizePath,
};
