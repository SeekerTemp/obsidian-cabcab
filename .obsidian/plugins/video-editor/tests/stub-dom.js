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
    this.style = {};
    this.disabled = false;
    // Layout the stub cannot compute. Tests set these to say how big the pane
    // is; zero stands in for "not laid out yet", which the real pane also goes
    // through before its first frame.
    this.clientWidth = 0;
    this.clientHeight = 0;
    // What an <img> reports once decoded. A test sets them, then fires "load".
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    // Form value, for the scrub bar. A range's value is a string in the real
    // DOM, which is why the plugin converts rather than trusting the type.
    this.value = "";
    /* What a <video> reports. duration is NaN before metadata arrives, which
       is the state most of the transport's guards exist for, so it starts
       there rather than at a convenient zero. A test sets these and fires
       "loadedmetadata". */
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.loadCount = 0;
  }

  /* Media element methods. play() resolves, because the interesting rejection
     — a codec the browser will not decode — is driven by a test replacing this
     method rather than by the stub guessing when to fail. */
  play() {
    this.paused = false;
    this.fire("play");
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) {
      this.paused = true;
      this.fire("pause");
    }
  }

  load() {
    this.loadCount += 1;
  }

  /* Canvas. Node has no 2D context, so the stub records the call instead of
     performing it: what the thumbnailer has to get right is the size it draws
     at and the fact that it draws the seeked element at all, and both of those
     are visible from here. */
  getContext(type) {
    if (type !== "2d") return null;
    if (!this.context) {
      const canvas = this;
      this.context = {
        canvas,
        transforms: [],
        setTransform(a, b, c, d, e, f) {
          this.transforms.push([a, b, c, d, e, f]);
        },
        resetTransform() {
          this.transforms.push([1, 0, 0, 1, 0, 0]);
        },
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawn: [],
        drawImage(source, x, y, width, height) {
          this.drawn.push({ source, x, y, width, height });
        },
      };
    }
    return this.context;
  }

  /* The encode path a save takes. The stub does not compress anything — what
     the save has to get right is the type it asks for, the quality it passes
     and the bytes it hands to the vault, and all three are visible from here.

     `failEncode` on the canvas makes toBlob hand back null, which is how a
     real browser reports a format it has no encoder for. */
  toBlob(callback, type, quality) {
    this.encoded = { type, quality };
    if (this.failEncode) {
      callback(null);
      return;
    }
    const size = (this.width || 0) * (this.height || 0);
    callback({
      type: type || "image/png",
      size,
      canvas: this,
      quality,
      async arrayBuffer() {
        return new ArrayBuffer(size);
      },
    });
  }

  // Encoded frames are compared by identity in the tests, so the URL carries
  // enough to tell two of them apart.
  toDataURL(type, quality) {
    this.encoded = { type, quality };
    return "data:" + (type || "image/png") + ";base64,stub-" + this.width + "x" + this.height;
  }

  // Derived from clientWidth/clientHeight, positioned at the origin. Enough
  // for the pan maths, which only ever asks for the centre.
  getBoundingClientRect() {
    return {
      left: this.rectLeft || 0,
      top: this.rectTop || 0,
      width: this.clientWidth,
      height: this.clientHeight,
      right: (this.rectLeft || 0) + this.clientWidth,
      bottom: (this.rectTop || 0) + this.clientHeight,
    };
  }

  setPointerCapture(pointerId) {
    this.capturedPointer = pointerId;
  }

  releasePointerCapture(pointerId) {
    if (this.capturedPointer === pointerId) this.capturedPointer = null;
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
    // A value attribute is an input's initial value in the real DOM, and the
    // scrub bar is built with one.
    if (name === "value") this.value = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
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

  createSpan(options) {
    return this.createEl("span", options);
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
  /* Document-level listeners exist because a timeline drag has to keep
     tracking the pointer once it leaves the strip — a drag that stops when the
     cursor leaves the element is a drag that fights the user. */
  const documentListeners = {};
  global.document = {
    body: root,
    createElement: (tag) => new StubElement(tag),
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = documentListeners[type];
      if (!list) return;
      const at = list.indexOf(handler);
      if (at !== -1) list.splice(at, 1);
    },
    fire(type, event) {
      for (const handler of (documentListeners[type] || []).slice()) handler(event || {});
      return (documentListeners[type] || []).length;
    },
  };

  /* Blobs and object URLs, for the filmstrip. The stub hands back a counted
     fake URL and remembers whether it was revoked, because leaking one still
     per resize on a sixty-minute file is exactly the bug worth a test. */
  let blobCounter = 0;
  const liveUrls = new Set();
  global.Blob = class Blob {
    constructor(parts, options) {
      this.parts = parts || [];
      this.type = (options || {}).type || "";
      this.size = this.parts.reduce((sum, part) => sum + (part && part.length ? part.length : 0), 0);
    }
  };
  global.URL = {
    createObjectURL() {
      blobCounter += 1;
      const url = "blob:stub/" + blobCounter;
      liveUrls.add(url);
      return url;
    },
    revokeObjectURL(url) {
      liveUrls.delete(url);
    },
  };
  global.liveObjectUrls = liveUrls;
  global.IntersectionObserver = StubIntersectionObserver;
  /* Animation frames, driven by hand. Reverse playback is a seek per frame,
     and a loop that ran on its own would either never stop or run as fast as
     node can, neither of which is a test. */
  const frames = [];
  global.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  global.cancelAnimationFrame = (handle) => {
    if (handle >= 1 && handle <= frames.length) frames[handle - 1] = null;
  };
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
    liveUrls,
    fireDocument(type, event) {
      return global.document.fire(type, event);
    },
    // Runs whatever animation frames are queued, once. Returns how many ran,
    // so a test can assert that a loop stopped rather than merely paused.
    runFrames() {
      const queued = frames.splice(0, frames.length);
      let ran = 0;
      for (const fn of queued) {
        if (!fn) continue;
        ran += 1;
        fn();
      }
      return ran;
    },
    clearFrames() {
      return frames.splice(0, frames.length).length;
    },
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
