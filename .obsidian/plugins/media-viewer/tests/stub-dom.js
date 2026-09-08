// A DOM small enough to read, big enough to drive the grid.
//
// The alternative is jsdom, which this vault has no npm to install and which
// would still not implement IntersectionObserver — the one browser API the
// grid actually depends on. So the stub implements exactly what main.js
// touches, plus a manual way to say "these tiles are on screen now".
//
// It also carries Obsidian's own HTMLElement extensions (createDiv, addClass,
// empty, setText and friends), because main.js uses them as freely as the
// standard ones.

function classListOf(className) {
  return String(className || "").split(/\s+/).filter(Boolean);
}

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.text = "";
    this.title = "";
    // Set by the grid on <img>; the stub records it rather than fetching it.
    this.src = "";
  }

  /* Tree */

  get firstElementChild() {
    return this.children.length ? this.children[0] : null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    return index === -1 || index === siblings.length - 1 ? null : siblings[index + 1];
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.isRoot === true;
  }

  appendChild(child) {
    return this.insertBefore(child, null);
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at !== -1) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /* Selectors. Only the class form is supported, which is all main.js uses —
     anything else throws rather than quietly matching nothing. */

  matches(selector) {
    if (!selector.startsWith(".")) throw new Error("stub-dom supports class selectors only: " + selector);
    return classListOf(this.className).includes(selector.slice(1));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  /* Attributes and classes */

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  hasClass(name) {
    return classListOf(this.className).includes(name);
  }

  addClass(...names) {
    const current = classListOf(this.className);
    for (const name of names) if (!current.includes(name)) current.push(name);
    this.className = current.join(" ");
  }

  removeClass(...names) {
    this.className = classListOf(this.className)
      .filter((name) => !names.includes(name))
      .join(" ");
  }

  toggleClass(names, force) {
    const list = Array.isArray(names) ? names : [names];
    if (force) this.addClass(...list);
    else this.removeClass(...list);
  }

  /* Content */

  get textContent() {
    return this.text;
  }

  set textContent(value) {
    this.text = String(value);
  }

  setText(value) {
    this.text = String(value);
  }

  empty() {
    for (const child of this.children.slice()) child.parentNode = null;
    this.children = [];
  }

  createDiv(options) {
    return this.createEl("div", options);
  }

  createEl(tag, options) {
    const element = new StubElement(tag);
    const settings = options || {};
    if (settings.cls) element.className = settings.cls;
    if (settings.text !== undefined) element.setText(settings.text);
    if (settings.value !== undefined) element.value = settings.value;
    if (settings.attr) for (const [name, value] of Object.entries(settings.attr)) element.setAttribute(name, value);
    this.appendChild(element);
    return element;
  }

  /* Events */

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type];
    if (list) this.listeners[type] = list.filter((entry) => entry !== handler);
  }

  // Bubbles, because the grid's click handling is delegated and that is the
  // behaviour under test.
  dispatch(type, event) {
    const payload = Object.assign({ type, target: this }, event);
    let node = this;
    while (node) {
      for (const handler of (node.listeners[type] || []).slice()) handler(payload);
      node = node.parentNode;
    }
  }

  fire(type, event) {
    for (const handler of (this.listeners[type] || []).slice()) {
      handler(Object.assign({ type, target: this }, event));
    }
  }

  scrollIntoView() {
    this.scrolledIntoView = true;
  }
}

// An IntersectionObserver that observes, and otherwise does nothing until a
// test says what is on screen. Real scrolling is not something node can offer,
// so the stub makes the trigger explicit instead of pretending.
class StubIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options || {};
    this.observed = new Set();
    StubIntersectionObserver.instances.push(this);
  }

  observe(element) {
    this.observed.add(element);
  }

  unobserve(element) {
    this.observed.delete(element);
  }

  disconnect() {
    this.observed.clear();
    this.disconnected = true;
  }

  // Report the given elements as on or off screen. Elements not observed are
  // ignored, exactly as the real one would.
  trigger(elements, isIntersecting) {
    const entries = elements
      .filter((element) => this.observed.has(element))
      .map((element) => ({ target: element, isIntersecting }));
    if (entries.length) this.callback(entries, this);
  }
}
StubIntersectionObserver.instances = [];

// Installs the stub globals. Returns the document root so a test can mount a
// view into something `isConnected` reports as attached.
function installDom() {
  const root = new StubElement("body");
  root.isRoot = true;
  global.document = {
    body: root,
    createElement: (tag) => new StubElement(tag),
  };
  global.IntersectionObserver = StubIntersectionObserver;
  StubIntersectionObserver.instances = [];
  // The grid defers one reload through setTimeout; tests drive it by hand.
  const pending = [];
  global.window = {
    setTimeout: (fn) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => {},
  };
  return {
    root,
    // Runs whatever the grid deferred, so the eviction-reload path can be
    // asserted rather than raced.
    runTimers() {
      const queued = pending.splice(0, pending.length);
      for (const fn of queued) fn();
      return queued.length;
    },
    // Drops deferred work without running it. Called when a test sets up, so
    // that a count of deferrals measures that test rather than the one before.
    clearTimers() {
      return pending.splice(0, pending.length).length;
    },
    observers: StubIntersectionObserver.instances,
  };
}

module.exports = { StubElement, StubIntersectionObserver, installDom };
