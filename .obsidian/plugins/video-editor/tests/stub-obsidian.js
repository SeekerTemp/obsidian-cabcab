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
  addSettingTab(tab) {
    this.settingTab = tab;
    return tab;
  }
  async loadData() {
    return null;
  }
  async saveData() {}
}
/* Enough ItemView to build a pane and read what it drew. The real one owns a
   container whose second child is the content area — the element every view
   empties and fills — so the stub gives it exactly that shape. */
class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf && leaf.app ? leaf.app : null;
    this.containerEl =
      typeof document !== "undefined" && document.createElement
        ? document.createElement("div")
        : null;
    if (this.containerEl) {
      this.containerEl.appendChild(document.createElement("div"));
      this.containerEl.appendChild(document.createElement("div"));
    }
  }
  registerDomEvent(element, type, handler) {
    element.addEventListener(type, handler);
  }
  registerEvent() {}
  registerInterval() {}
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

// Enough Menu for the grid's context menu: items record what they were given
// so a test can read the menu rather than the click that built it.
class Menu {
  constructor() {
    this.items = [];
    this.shownAt = null;
  }
  addItem(build) {
    const item = {
      setTitle(title) {
        this.title = title;
        return this;
      },
      setIcon(icon) {
        this.icon = icon;
        return this;
      },
      onClick(handler) {
        this.click = handler;
        return this;
      },
    };
    build(item);
    this.items.push(item);
    return this;
  }
  showAtMouseEvent(event) {
    this.shownAt = event;
    return this;
  }
}
const normalizePath = (p) => String(p).split("\\").join("/").replace(/[/]+/g, "/");

/* Obsidian’s icon painter. The real one injects an SVG; the stub records the
   name on the element, which is what a test actually wants to assert and what
   keeps a missing icon from reading as a passing test. */
function setIcon(element, name) {
  if (!element) return;
  element.dataset.icon = String(name);
}

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
  setIcon,
};
