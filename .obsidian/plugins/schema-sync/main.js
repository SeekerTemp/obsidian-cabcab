const { Plugin, ItemView, Modal, Notice, TFile, SuggestModal, MarkdownView, PluginSettingTab, Setting, normalizePath } = require("obsidian");

// Deliberately permissive defaults. This is a note editor, not a DBMS: edits
// apply as you make them, and the cost is that a malformed edit lands rather
// than being caught at a gate.
const DEFAULT_SETTINGS = {
  requireEditUnlock: false,
  confirmDestructiveActions: true,
  promptForUndeclaredProperties: true,
  // schemaName -> [property names answered "leave it alone"]. Persisted, because
  // a session-only memory would re-ask about every scratch property on restart.
  ignoredProperties: {},
};

const SCHEMA_FOLDER = "data/schema";
const LEGACY_SCHEMA_FOLDER = "schemas";
const DATA_FOLDER = "data/record";
const CONFIG_FOLDER = "data/config";
const ROOT_CONFIG_FOLDER = "config";
const ASSET_FOLDER = "data/assets";
const BASE_FOLDER = "data";
const BASE_VIEW_FOLDER = "data/base";
const PLACEHOLDER_PREFIX = "_placeholder.";
const LIST_FOLDER = "data/config";
const TABLE_FOLDER = "data/tables";
const ASSET_CONFIG_FOLDER = "assets/config";
const SCHEMA_MAPPING_FILE = "data/config/schema-mappings.md";
const LEGACY_MAPPING_FILE = "config/schema-mappings.md";
const SAMPLE_DATABASE = "AssetDatabase";
const VIEW_TYPE_SCHEMA_SYNC = "schema-sync-dashboard";
const IDENTITY_FIELDS = new Set(["id", "name"]);
// `attachment` is a string carrying a [[wikilink]] to a media file. Asset
// Renamer builds its property dropdown from a note's frontmatter keys, so an
// attachment field becomes editable there as soon as the key exists.
const FIELD_TYPES = ["string", "number", "boolean", "array", "object", "attachment"];
// Keys that appear in a frontmatter cache but are not the note's own properties:
// `implements` is ours, and `position` is injected by Obsidian's metadata cache.
// Neither is ever something to offer to add to a schema.
const RESERVED_PROPERTIES = new Set(["implements", "position"]);
// Unbound fields are documentation only: shown in the definition editor and the
// schema note, but never pushed into records, config lists, base views or DBML.
const isBound = (definition) => definition.bind !== false;
const storageType = (type) => (type === "attachment" ? "string" : type);

/* ------------------------------------------------------------------------ *
 * Pure generators. No Obsidian API, no I/O, no `this`.
 * Everything between this banner and the next one is unit-testable under
 * plain node, which is the only way the output formats can be verified
 * without launching Obsidian.
 * ------------------------------------------------------------------------ */

function emptyValue(type) {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

function inferFieldType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined) return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

function reorderFields(fields, fromName, toName) {
  const names = Object.keys(fields);
  const from = names.indexOf(fromName);
  const to = names.indexOf(toName);
  if (from < 0 || to < 0 || from === to) return { ...fields };
  names.splice(to, 0, ...names.splice(from, 1));
  return Object.fromEntries(names.map((name) => [name, fields[name]]));
}

function setFieldBind(fields, name, bind) {
  if (!fields[name]) return { ...fields };
  return Object.fromEntries(Object.entries(fields).map(([key, definition]) => [key, key === name ? { ...definition, bind } : definition]));
}

// Renames a key while holding its position, so reordering and renaming stay
// independent operations.
function renameField(fields, oldName, newName) {
  return Object.fromEntries(Object.entries(fields).map(([name, definition]) => [name === oldName ? newName : name, definition]));
}

function isEmptyValue(value) {
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function yamlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

function frontmatterText(values) {
  return Object.entries(values).map(([name, value]) => `${name}: ${yamlValue(value)}`).join("\n");
}

function recordValuesFor(schemaName, fields) {
  const values = { implements: schemaName };
  for (const [name, definition] of Object.entries(fields)) {
    if (!isBound(definition)) continue;
    values[name] = definition.hasDefault ? definition.defaultValue : emptyValue(definition.type);
  }
  return values;
}

function renderRecordFrontmatter(schemaName, fields) {
  return frontmatterText(recordValuesFor(schemaName, fields));
}

// Obsidian Bases YAML. Shape mirrors the vault's own working config/config.base:
// filters nested inside the view, plain-scalar expressions, trailing `sort: []`.
function renderBaseYaml(schemaName, fields, recordFolder) {
  const columns = ["file.name", ...Object.entries(fields).filter(([, d]) => isBound(d)).map(([name]) => name)];
  return [
    "# Generated by Schema Sync. Edits are overwritten on the next sync.",
    "views:",
    "  - type: table",
    `    name: ${schemaName}`,
    "    filters:",
    "      and:",
    `        - file.inFolder("${recordFolder}")`,
    "    order:",
    ...columns.map((column) => `      - ${column}`),
    "    sort: []",
    "",
  ].join("\n");
}

// Everything below this line in a generated file belongs to the user and is
// carried across verbatim. Generated files are rebuilt wholesale, so without a
// protected region anything written into one is destroyed on the next sync.
const NOTES_MARKER = "<!-- schema-sync:notes -->";

function extractUserNotes(raw) {
  const index = String(raw || "").indexOf(NOTES_MARKER);
  // Fully trimmed, not just one leading newline: withUserNotes re-adds fixed
  // spacing, so anything left here accumulates a blank line on every sync.
  return index < 0 ? "" : String(raw).slice(index + NOTES_MARKER.length).trim();
}

function withUserNotes(body, raw) {
  return [
    body,
    NOTES_MARKER,
    "",
    extractUserNotes(raw) || "_Anything you write below this marker is preserved across syncs._",
    "",
  ].join("\n");
}

// Reads back a .config.md table as value -> notes cell, dropping the header and
// separator rows, so regeneration can union rather than replace.
function parseConfigRows(raw) {
  const rows = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    rows.push(cells);
  }
  if (rows.length >= 2 && /^:?-{2,}:?$/.test(rows[1][0] || "")) rows.splice(0, 2);
  const parsed = new Map();
  for (const [first, ...rest] of rows) {
    const link = String(first || "").match(/^\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]$/);
    const value = (link ? link[1] : first || "").trim();
    if (value) parsed.set(value, rest.join(" | ").trim());
  }
  return parsed;
}

function parseConfigValues(raw) {
  return [...parseConfigRows(raw).keys()];
}

function renderConfigNote(attributeName, sources, values, existingRaw) {
  const existing = parseConfigRows(existingRaw);
  const merged = [...new Set([...existing.keys(), ...(values || []).map((value) => String(value))]
    .map((value) => value.trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const body = [
    "---",
    `configFor: [${(sources || []).join(", ")}]`,
    "---",
    "",
    `# ${attributeName}`,
    "",
    `Unique \`${attributeName}\` values available for selection. Generated by Schema Sync; rows and notes added by hand are preserved across syncs.`,
    "",
    `| ${attributeName} | Notes |`,
    "| --- | --- |",
    // The Notes cell is carried over. Rebuilding it empty each sync is what
    // destroyed anything written into this column.
    ...merged.map((value) => `| [[${value}]] | ${existing.get(value) || ""} |`),
    "",
  ].join("\n");
  return withUserNotes(body, existingRaw);
}

function coerceDefault(raw, type) {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "array" || type === "object") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// The Field Reference table is an input as well as generated output: rows typed
// there by hand are adopted into `fields:` on the next sync. Editing the table
// is the obvious way to add a field when working in the note directly.
function parseFieldReferenceRows(raw) {
  const section = String(raw || "").match(/##\s+Field Reference\s*\r?\n([\s\S]*)$/i);
  if (!section) return [];
  const rows = [];
  for (const line of section[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    // The Field cell is a wikilink now, and an aliased one carries a "|" of its
    // own, so it arrives split across two cells. Rejoin before reading columns.
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells[0].startsWith("[[") && !cells[0].endsWith("]]")) cells.splice(0, 2, `${cells[0]}|${cells[1]}`);
    const [rawName, type, defaultCell, required, bound, relation] = cells;
    const name = normalizeFieldName(rawName);
    if (!name || /^:?-{2,}:?$/.test(name) || name.toLowerCase() === "field") continue;
    const definition = {
      // Every blank cell resolves to the quiet option: string, no default,
      // not required, not bound, no relation.
      type: FIELD_TYPES.includes(type) ? type : "string",
      required: /^(yes|true)$/i.test(required || ""),
      hasDefault: false,
      defaultValue: undefined,
      // Binding is opt-in: a row typed by hand stays UNBOUND until asked for.
      bind: /^(yes|true)$/i.test(bound || ""),
    };
    if (relation && relation !== "-") definition.relation = { target: relation };
    if (defaultCell && defaultCell !== "-") {
      definition.hasDefault = true;
      try { definition.defaultValue = JSON.parse(defaultCell); }
      catch { definition.defaultValue = coerceDefault(defaultCell, definition.type); }
    }
    // The generator always writes yes or no here. A blank cell therefore means
    // a human typed this row, which is what separates a new field from a stale
    // row left behind by one deleted from `fields:`.
    rows.push({ name, definition, handAdded: !/^(yes|no|true|false)$/i.test(bound || "") });
  }
  return rows;
}

function parseFieldReference(raw) {
  return Object.fromEntries(parseFieldReferenceRows(raw).map(({ name, definition }) => [name, definition]));
}

// Only hand-typed rows are adopted. Without this, deleting a field from `fields:`
// achieves nothing: its still-generated row in the table is read straight back
// in, and the two copies resurrect each other forever.
function handAddedFields(raw) {
  return Object.fromEntries(parseFieldReferenceRows(raw).filter((row) => row.handAdded).map(({ name, definition }) => [name, definition]));
}

// One value list per schema plus field, namespaced by schema so two schemas may
// both declare `trait` without sharing a note. The folder carries the convention
// that `.config.md` used to; the file is named for the field so a link to it
// reads as the field name. Shared by the generator and the dashboard's
// open-config button so the two cannot drift apart.
function configPathFor(schemaName, fieldName, definition) {
  if (!definition || definition.type !== "string" || definition.relation?.target || !isBound(definition)) return null;
  if (IDENTITY_FIELDS.has(String(fieldName).toLowerCase())) return null;
  return `${CONFIG_FOLDER}/${schemaName}/${fieldName}.md`;
}

// A template is deliberately blank, so validating it would report every required
// field as missing on every pass. That is the whole of what the _placeholder.
// prefix decides.
function shouldValidateNote(basename) {
  return !String(basename).startsWith(PLACEHOLDER_PREFIX);
}

// The single rule for what a note is offering to add to its schema. Note kind is
// deliberately not an input: adding a property to a template is the plainest
// statement of schema intent there is, and for some schemas the template is the
// only note that ever exists. Sharing one guard with shouldValidateNote() is
// what silenced this prompt outright once the last numbered record was deleted.
function undeclaredPropertyFor({ schemaName, frontmatter, fields, ignored, asking }) {
  if (!frontmatter || !fields) return null;
  return Object.keys(frontmatter).find((name) =>
    !RESERVED_PROPERTIES.has(name)
    && !Object.prototype.hasOwnProperty.call(fields, name)
    && !ignored.has(name)
    && !asking.has(`${schemaName}.${name}`)) || null;
}

const ILLEGAL_FIELD_NAME = /[\\/:#^|[\]]/;

// A field name typed as a wikilink is the user reaching for the value list the
// field points at. Keep the target, drop the brackets: the link belongs in the
// Field Reference cell, which the generator writes, not in `fields:`. A trailing
// ".config" goes too — Asset Renamer used to derive property names from config
// filenames, which is where fields called "Cultures.config" came from.
function normalizeFieldName(raw) {
  let text = String(raw ?? "").trim();
  const link = text.match(/^\[\[([^\]]+)\]\]$/);
  if (link) {
    text = link[1].split("|")[0].split("#")[0];
    text = text.slice(text.lastIndexOf("/") + 1);
  }
  return text.trim().replace(/\.config$/i, "").trim();
}

// A field name is a file name now, so it has to survive being one.
function fieldNameError(name) {
  if (!name) return "A field name cannot be blank.";
  if (ILLEGAL_FIELD_NAME.test(name)) return `"${name}" cannot be a field name: / \\ : # ^ | [ and ] are not allowed in a file name.`;
  return null;
}

// Merging two config notes would silently discard one side's hand-written Notes
// column, which is the whole reason these files are never auto-deleted. Two
// fields in one schema cannot share a name, so an occupied target can only be a
// leftover from an earlier failed rename — report it and let the user clear it
// with the orphan cleanup, rather than merging behind their back.
function configRenamePlan({ schemaName, oldName, newName, existingPaths }) {
  const from = `${CONFIG_FOLDER}/${schemaName}/${oldName}.md`;
  if (!existingPaths.has(from)) return { action: "none" };
  const to = `${CONFIG_FOLDER}/${schemaName}/${newName}.md`;
  if (existingPaths.has(to)) return { action: "conflict", from, to };
  return { action: "rename", from, to, configFor: `${schemaName}.${newName}` };
}

// A value list is orphaned only when its field is gone from the schema entirely,
// or the schema itself is gone. Bind state is deliberately irrelevant: unbinding
// a field is the reversible first press of the × button, and throwing away its
// curated values would make that press destructive after all.
function orphanedConfigs(notes, schemas) {
  return notes.filter(({ schemaName, fieldName }) => {
    const fields = schemas.get(schemaName);
    return !fields || !Object.prototype.hasOwnProperty.call(fields, fieldName);
  });
}

// What the Field column points at. A link means "this field has somewhere to
// go"; plain text means it has not. Path-qualified because Obsidian resolves a
// wikilink by basename alone, and two schemas may both declare `trait`. Aliased
// so the cell still reads as the bare field name.
function fieldReferenceLink(schemaName, fieldName, definition, schemas) {
  const target = definition?.relation?.target;
  if (target) {
    // A foreign key never gets a list of its own: it points at the one list the
    // target entity already owns, so values cannot drift between the two.
    const targetFields = schemas?.get?.(target);
    const ownField = targetFields && Object.prototype.hasOwnProperty.call(targetFields, target) ? targetFields[target] : null;
    if (ownField && configPathFor(target, target, ownField)) return `[[${target}/${target}|${fieldName}]]`;
    // Nothing to point at — an entity keyed by `id` has no list, because
    // identity fields are excluded — so fall back to its definition.
    return `[[${target}.schema|${fieldName}]]`;
  }
  return configPathFor(schemaName, fieldName, definition) ? `[[${schemaName}/${fieldName}|${fieldName}]]` : fieldName;
}

// Carries every property a field has, Relation included, so the table is a
// lossless representation of `fields:` and a bottom-to-top pull cannot drop
// anything it is unable to express.
function renderFieldReference(schemaName, fields, schemas) {
  const rows = Object.entries(fields).map(([name, field]) =>
    `| ${fieldReferenceLink(schemaName, name, field, schemas)} | ${field.type} | ${field.hasDefault ? yamlValue(field.defaultValue) : "-"} | ${field.required ? "yes" : "no"} | ${isBound(field) ? "yes" : "no"} | ${field.relation?.target || "-"} |`);
  return `## Field Reference\n\n| Field | Type | Default | Required | Bound | Relation |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

function renderSchemaFields(fields) {
  return Object.entries(fields).map(([fieldName, definition]) => {
    const lines = [`  - ${fieldName}:`, `      type: ${definition.type}`];
    if (definition.required) lines.push("      required: true");
    if (definition.hasDefault) lines.push(`      default: ${yamlValue(definition.defaultValue)}`);
    if (definition.relation?.target) lines.push(`      relation: ${definition.relation.target}`);
    // Written only when false, so existing schema notes stay byte-identical.
    if (!isBound(definition)) lines.push("      bind: false");
    return lines.join("\n");
  }).join("\n");
}

function defaultSchemaBody(name, sourcePath) {
  const intro = sourcePath ? `Source implementation: [[${String(sourcePath).replace(/\.md$/i, "")}]]\n\n` : "";
  return `${intro}Defines the base fields for any ${name} note.`;
}

// Strips frontmatter, the title heading, and the generated Field Reference,
// leaving the author's prose so a rewrite does not destroy it.
function schemaBodyOf(raw) {
  // Stops at the Field Reference, which is regenerated. Anything below the
  // notes marker is recovered separately by extractUserNotes.
  return String(raw || "")
    .replace(/^---[\s\S]*?\n---\n?/, "")
    .replace(/\n?##\s+Field Reference[\s\S]*$/i, "")
    .replace(new RegExp(`${NOTES_MARKER}[\\s\\S]*$`), "")
    .replace(/^#\s+.*$/m, "")
    .trim();
}

function renderSchemaNote(name, fields, sourcePath, body, existingRaw, schemas) {
  const frontmatter = ["---", `schema: ${name}`];
  if (sourcePath) frontmatter.push(`schemaSource: ${sourcePath}`);
  frontmatter.push("fields:");
  const fieldBlock = renderSchemaFields(fields);
  if (fieldBlock) frontmatter.push(fieldBlock);
  frontmatter.push("---");
  const prose = (body && body.trim()) || defaultSchemaBody(name, sourcePath);
  const head = `${frontmatter.join("\n")}\n\n# ${name} Schema\n\n${prose}\n\n${renderFieldReference(name, fields, schemas)}`;
  return withUserNotes(head, existingRaw);
}

function dbmlColumnType(type) {
  return type === "number" ? "int" : type === "boolean" ? "boolean" : "varchar";
}

function dbmlRefTarget(targetFields) {
  if (!targetFields) return undefined;
  if (targetFields.id) return "id";
  if (targetFields.name) return "name";
  return Object.keys(targetFields)[0];
}

function renderDbml(schemas) {
  const entries = typeof schemas?.entries === "function" ? [...schemas.entries()] : Object.entries(schemas || {});
  const lookup = new Map(entries);
  const tables = entries.map(([name, fields]) => {
    const columns = Object.entries(fields)
      .filter(([, definition]) => isBound(definition))
      .map(([fieldName, definition]) => `  ${fieldName} ${dbmlColumnType(definition.type)}${definition.required ? " [not null]" : ""}`)
      .join("\n");
    return `Table ${name} {\n${columns}\n}`;
  });
  const relations = [];
  for (const [name, fields] of entries) {
    for (const [fieldName, definition] of Object.entries(fields)) {
      if (!isBound(definition)) continue;
      const target = definition.relation?.target;
      if (!target || !lookup.has(target)) continue;
      const key = dbmlRefTarget(lookup.get(target));
      if (key) relations.push(`Ref: ${name}.${fieldName} > ${target}.${key}`);
    }
  }
  return `${tables.join("\n\n")}\n${relations.join("\n")}`;
}

function renderErdNote(databaseName, schemas, existingRaw) {
  const body = `# ${databaseName} Database\n\nGenerated DBML base view for the DBML Visualizer plugin.\n\n\`\`\`dbml title="${databaseName} ERD"\n${renderDbml(schemas)}\n\`\`\`\n`;
  return withUserNotes(body, existingRaw);
}

/* --------------------------- end pure generators -------------------------- */

class SchemaInputModal extends Modal {
  constructor(app, title, placeholder, defaultValue, onSubmit) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    const input = contentEl.createEl("input", { type: "text", placeholder: this.placeholder });
    input.value = this.defaultValue || "";
    input.style.width = "100%";
    const submit = contentEl.createEl("button", { text: "Continue" });
    submit.addEventListener("click", () => {
      const value = input.value.trim();
      this.close();
      if (value) {
        Promise.resolve(this.onSubmit(value)).catch((error) => {
          new Notice(`Schema action failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit.click();
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() { this.contentEl.empty(); }
}

class ConfirmDeleteModal extends Modal {
  constructor(app, title, body, confirmLabel, onResolve) {
    super(app);
    this.title = title;
    this.body = body;
    this.confirmLabel = confirmLabel;
    this.onResolve = onResolve;
    this.answered = false;
  }

  resolve(confirmed, remember) {
    if (this.answered) return;
    this.answered = true;
    this.onResolve({ confirmed, remember });
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.body });
    const remember = contentEl.createEl("label", { cls: "schema-sync-modal-remember" });
    const checkbox = remember.createEl("input", { type: "checkbox" });
    remember.appendText(" Don't ask again this session");
    const actions = contentEl.createDiv({ cls: "schema-sync-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.resolve(false, false));
    const confirm = actions.createEl("button", { text: this.confirmLabel, cls: "mod-warning" });
    confirm.addEventListener("click", () => this.resolve(true, checkbox.checked));
    confirm.focus();
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(false, false);
  }
}

class UndeclaredPropertyModal extends Modal {
  constructor(app, { property, type, schemaName, recordName }, onResolve) {
    super(app);
    this.property = property;
    this.type = type;
    this.schemaName = schemaName;
    this.recordName = recordName;
    this.onResolve = onResolve;
    this.answered = false;
  }

  resolve(choice) {
    if (this.answered) return;
    this.answered = true;
    this.onResolve(choice);
    this.close();
  }

  option(parent, label, description, choice, cls) {
    const row = parent.createDiv({ cls: "schema-sync-choice" });
    const button = row.createEl("button", { text: label, cls: cls || "" });
    button.addEventListener("click", () => this.resolve(choice));
    row.createEl("small", { text: description });
    return button;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `"${this.property}" is not in the ${this.schemaName} schema` });
    contentEl.createEl("p", { text: `${this.recordName} has a property the schema does not declare. It was read as ${this.type}.` });
    const options = contentEl.createDiv({ cls: "schema-sync-choices" });
    this.option(options, "Define and bind", `Adds ${this.property} to ${this.schemaName} and to every ${this.schemaName} record, then opens the dashboard so you can set its type and default.`, "bind", "mod-cta");
    this.option(options, "Define, unbound", `Adds ${this.property} to ${this.schemaName} as documentation only. Other records are left alone, and you can bind it later when you want it everywhere.`, "unbind");
    this.option(options, "Leave it alone", `Keeps ${this.property} as a property of this record only. Nothing is written to the schema, and you will not be asked about it again.`, "ignore");
    contentEl.createEl("small", { cls: "schema-sync-choice-footer", text: "Turn these prompts off in Settings → Schema Sync." });
  }

  onClose() {
    this.contentEl.empty();
    // Dismissing the modal is not an answer: stay quiet now, ask again later.
    this.resolve("defer");
  }
}

class SchemaSyncView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedSchema = null;
    this.selectedEntity = null;
  }

  getViewType() { return VIEW_TYPE_SCHEMA_SYNC; }
  getDisplayText() { return "Schema Sync"; }
  getIcon() { return "workflow"; }

  async onOpen() { this.render(); }
  async onClose() { this.contentEl.empty(); }

  render() {
    const schemas = [...this.plugin.schemas.entries()];
    if (!this.selectedSchema || !this.plugin.schemas.has(this.selectedSchema)) this.selectedSchema = schemas[0]?.[0];
    const schemaName = this.selectedSchema;
    const fields = this.plugin.schemas.get(schemaName) || {};
    // Templates are listed too. A schema whose only file is _placeholder.X used
    // to report "No mapped entities", which read as nothing being mapped at all.
    const entities = this.plugin.dataFiles().filter((file) => this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.implements === schemaName);
    if (!this.selectedEntity || !entities.some((file) => file.path === this.selectedEntity.path)) this.selectedEntity = entities[0];
    const selectedFrontmatter = this.selectedEntity ? this.plugin.app.metadataCache.getFileCache(this.selectedEntity)?.frontmatter || {} : {};
    const fieldRows = Object.entries(fields).map(([name, definition]) => { const value = Object.prototype.hasOwnProperty.call(selectedFrontmatter, name) ? selectedFrontmatter[name] : definition.hasDefault ? definition.defaultValue : "—"; return `<div class="schema-sync-property"><span><b>${name}</b><small>${definition.type}${definition.required ? " · required" : ""}</small></span><code>${this.plugin.yamlValue(value)}</code></div>`; }).join("");
    this.contentEl.empty();
    this.contentEl.addClass("schema-sync-view");
        this.contentEl.innerHTML = `<div class="schema-sync-head"><div><small>SCHEMA SYNC / VAULT ARCHITECTURE</small><h1>Schema dashboard</h1></div><div class="schema-sync-head-actions"><button data-action="reload" class="schema-sync-danger" title="Bottom to top: the Field Reference table in each .schema note becomes the definition. Rows deleted there drop the field. Blank cells mean string, no default, not required, unbound, no relation.">↑ Pull from notes</button><button data-action="sync" title="Top to bottom: push the schema out to records, config lists, base views and the ERD">↓ Sync schema system</button></div></div><div class="schema-sync-grid"><section><small class="schema-sync-label">01 / Registry</small><h2>Manage schemas</h2><div class="schema-sync-list">${schemas.map(([name, schemaFields]) => `<button class="schema-sync-schema ${name === schemaName ? "is-active" : ""}" data-schema="${name}"><span>${name.slice(0, 1)}</span><b>${name}</b><small>${Object.keys(schemaFields).length} properties</small></button>`).join("")}</div></section><section><small class="schema-sync-label">02 / Relation</small><h2>Entity mapping</h2><div class="schema-sync-count"><b>${entities.length}</b><small>mapped entities</small></div><div class="schema-sync-entities">${entities.map((file) => { const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}; const isTemplate = file.basename.startsWith(PLACEHOLDER_PREFIX); const missing = Object.keys(fields).filter((name) => !(name in fm) && fields[name].required).length; const badge = isTemplate ? "template" : missing ? `${missing} issue` : "In sync"; return `<button class="schema-sync-entity ${file.path === this.selectedEntity?.path ? "is-active" : ""}" data-entity="${file.path}"><b>${file.basename}</b><small>${file.path}</small><em class="${isTemplate ? "is-template" : missing ? "is-warning" : ""}">${badge}</em></button>`; }).join("") || "<p class=\"schema-sync-empty\">No mapped entities.</p>"}</div></section><section><small class="schema-sync-label">03 / Resolved entity</small><h2>${this.selectedEntity?.basename || "Select an entity"}</h2><small class="schema-sync-path">${this.selectedEntity?.path || "Choose a note from the mapping panel"}</small><div class="schema-sync-inherits">↳ Inherits from <b>${schemaName || "—"}</b></div><div class="schema-sync-properties">${this.selectedEntity ? fieldRows : "<p class=\"schema-sync-empty\">No entity selected.</p>"}</div></section></div>`;
        const grid = this.contentEl.querySelector(".schema-sync-grid");
        const sections = grid ? [...grid.children] : [];
        if (grid && sections.length === 3) {
          grid.append(sections[0], sections[2], sections[1]);
        }
        const editorPanel = this.contentEl.querySelector(".schema-sync-grid > section:nth-child(2)");
        if (editorPanel) {
          editorPanel.innerHTML = `<small class="schema-sync-label">02 / Definition</small><h2>Edit ${schemaName || "schema"}</h2><p class="schema-sync-editor-help">${this.plugin.settings.requireEditUnlock ? "Click ✎ to edit a row." : "Edit any row directly — changes save as you make them."} Enter commits, Escape reverts. Drag ⠿ to reorder. <b>Default</b> is the value a new record starts this field at — leave it blank for an empty value. <b>Bind</b> off keeps a field documented here but out of records, config lists, base views and the ERD.</p><div class="schema-sync-field-editor${this.plugin.settings.requireEditUnlock ? "" : " is-live"}"><div class="schema-sync-field-row schema-sync-field-head"><span></span><span>Field</span><span>Type</span><span title="Value a new record starts this field at">Default</span><span title="Points this field at another schema, drawn as a relation in the ERD">Relation</span><span title="Written to records, config lists, base views and the ERD">Bind</span><span title="Reports an issue when missing or blank in a record">Req</span><span title="Open this field's value list">☰</span><span class="schema-sync-edit-col"></span><span></span></div>${Object.entries(fields).map(([name, definition]) => `<div class="schema-sync-field-row" data-schema-row="${name}"><span class="schema-sync-drag" draggable="true" title="Drag to reorder">⠿</span><input data-field-name value="${name}" aria-label="Field name" /><select data-field-type aria-label="Field type">${FIELD_TYPES.map((type) => `<option value="${type}" ${definition.type === type ? "selected" : ""}>${type}</option>`).join("")}</select><input data-field-default value="${this.plugin.editorValue(definition.hasDefault ? definition.defaultValue : "")}" placeholder="default" aria-label="Default value" /><select data-field-relation aria-label="Foreign key target"><option value="">no foreign key</option>${schemas.map(([target]) => `<option value="${target}" ${definition.relation?.target === target ? "selected" : ""}>→ ${target}</option>`).join("")}</select><input data-field-bind type="checkbox" ${definition.bind === false ? "" : "checked"} aria-label="Bound" title="Bound: written to records, config lists, base views and the ERD. Unbound: documented here only." /><input data-field-required type="checkbox" ${definition.required ? "checked" : ""} aria-label="Required" title="Reports an issue when this field is missing or blank in a record" /><button data-open-config="${name}" class="schema-sync-row-action ${configPathFor(schemaName, name, definition) ? "" : "is-muted"}" title="${configPathFor(schemaName, name, definition) ? `Open ${configPathFor(schemaName, name, definition)}` : `${name} has no value list`}">☰</button><button data-delete-field="${name}" class="${definition.bind === false ? "schema-sync-row-delete" : ""}" title="${definition.bind === false ? `Remove ${name} from the schema` : `Unbind ${name} — stops writing it anywhere, keeps existing values`}">×</button></div>`).join("") || "<p class=\"schema-sync-empty\">No fields defined.</p>"}</div>`;
          const definitionHeader = document.createElement("div");
          definitionHeader.className = "schema-sync-definition-header";
          const definitionTitle = editorPanel.querySelector("h2");
          if (definitionTitle) {
            definitionTitle.parentElement?.insertBefore(definitionHeader, definitionTitle);
            definitionHeader.appendChild(definitionTitle);
          }
          const addFieldButton = document.createElement("button");
          addFieldButton.className = "schema-sync-add-field";
          addFieldButton.textContent = "+ Add field";
          addFieldButton.dataset.action = "add-definition-field";
          definitionHeader.appendChild(addFieldButton);
          const lockRow = (row) => {
            row.querySelectorAll("input, select").forEach((control) => { control.disabled = true; });
            row.classList.remove("is-editing");
          };
          // Snapshot on unlock so Escape has something exact to restore to.
          const snapshotRow = (row) => [...row.querySelectorAll("input, select")].map((control) => (control.type === "checkbox" ? control.checked : control.value));
          const restoreRow = (row, snapshot) => {
            [...row.querySelectorAll("input, select")].forEach((control, index) => {
              if (control.type === "checkbox") control.checked = snapshot[index];
              else control.value = snapshot[index];
            });
          };
          // Live editing is the default: no gate, changes apply as they are made.
          // The lock is opt-in for anyone who wants the extra step.
          const requireUnlock = this.plugin.settings.requireEditUnlock;
          editorPanel.querySelectorAll("[data-schema-row]").forEach((row) => {
            if (!requireUnlock) {
              // Escape still reverts, so snapshot whenever the row takes focus.
              row.addEventListener("focusin", () => {
                if (!row.dataset.snapshot) row.dataset.snapshot = JSON.stringify(snapshotRow(row));
              });
              row.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && row.dataset.snapshot) {
                  event.preventDefault();
                  event.stopPropagation();
                  restoreRow(row, JSON.parse(row.dataset.snapshot));
                  delete row.dataset.snapshot;
                  row.querySelectorAll("input, select").forEach((control) => control.blur());
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  event.target.blur();
                }
              });
              return;
            }
            lockRow(row);
            const editButton = document.createElement("button");
            editButton.className = "schema-sync-row-action";
            editButton.dataset.editField = row.dataset.schemaRow;
            editButton.title = `Edit ${row.dataset.schemaRow}`;
            editButton.textContent = "✎";
            row.insertBefore(editButton, row.querySelector("[data-delete-field]"));
          });
          editorPanel.querySelectorAll("[data-delete-field]").forEach((button) => button.addEventListener("click", () => void this.plugin.deleteSchemaField(schemaName, button.dataset.deleteField)));
          editorPanel.querySelectorAll("[data-open-config]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.openFieldConfig(schemaName, button.dataset.openConfig); }));
          editorPanel.querySelectorAll("[data-edit-field]").forEach((button) => button.addEventListener("click", () => {
            const row = button.closest("[data-schema-row]");
            // Guard against a second click stacking another set of key handlers
            // on the same row.
            if (!row || row.classList.contains("is-editing")) return;
            row.querySelectorAll("input, select").forEach((control) => { control.disabled = false; });
            row.classList.add("is-editing");
            const snapshot = snapshotRow(row);
            row.querySelectorAll("input, select").forEach((control) => {
              control.addEventListener("keydown", (event) => {
                // Escape must abandon the edit outright. Relying on the browser
                // to revert an input is not dependable inside Electron.
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  restoreRow(row, snapshot);
                  lockRow(row);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  control.blur();
                }
              });
            });
          }));
          editorPanel.querySelector("[data-action=add-definition-field]")?.addEventListener("click", () => void this.plugin.updateSchema(schemaName));
          editorPanel.querySelectorAll("[data-schema-row] input, [data-schema-row] select").forEach((control) => control.addEventListener("change", () => {
            if (control.disabled) return;
            void this.plugin.saveSchemaFromDashboard(schemaName, editorPanel);
          }));
          let draggedRow = null;
          editorPanel.querySelectorAll(".schema-sync-drag").forEach((handle) => {
            const row = handle.closest("[data-schema-row]");
            handle.addEventListener("dragstart", (event) => {
              draggedRow = row;
              row.classList.add("is-dragging");
              event.dataTransfer.effectAllowed = "move";
              // Firefox and Electron both refuse to start a drag without data.
              event.dataTransfer.setData("text/plain", row.dataset.schemaRow);
            });
            handle.addEventListener("dragend", () => {
              row.classList.remove("is-dragging");
              editorPanel.querySelectorAll(".is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
              draggedRow = null;
            });
          });
          editorPanel.querySelectorAll("[data-schema-row]").forEach((row) => {
            row.addEventListener("dragover", (event) => {
              if (!draggedRow || draggedRow === row) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              row.classList.add("is-drop-target");
            });
            row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
            row.addEventListener("drop", (event) => {
              event.preventDefault();
              row.classList.remove("is-drop-target");
              if (!draggedRow || draggedRow === row) return;
              void this.plugin.reorderSchemaFields(schemaName, draggedRow.dataset.schemaRow, row.dataset.schemaRow);
            });
          });
        }
        const relationLabel = this.contentEl.querySelector(".schema-sync-grid > section:nth-child(3) .schema-sync-label");
        if (relationLabel) relationLabel.textContent = "03 / Relation";
        const registry = this.contentEl.querySelector(".schema-sync-grid > section:nth-child(1)");
        if (registry) {
          const registryHeader = document.createElement("div");
          registryHeader.className = "schema-sync-registry-header";
          const registryTitle = registry.querySelector("h2");
          if (registryTitle) {
            registryTitle.parentElement?.insertBefore(registryHeader, registryTitle);
            registryHeader.appendChild(registryTitle);
          }
          const newButton = document.createElement("button");
          newButton.className = "schema-sync-new-button";
          newButton.textContent = "+ New schema";
          newButton.dataset.action = "create-schema-registry";
          registryHeader.appendChild(newButton);
          registry.querySelectorAll(".schema-sync-schema").forEach((row) => {
            const schemaNameForRow = row.dataset.schema;
            const wrapper = document.createElement("div");
            wrapper.className = "schema-sync-schema-row";
            const selectButton = document.createElement("button");
            selectButton.className = row.className;
            selectButton.dataset.schema = schemaNameForRow;
            selectButton.innerHTML = row.innerHTML;
            const openButton = document.createElement("button");
            openButton.className = "schema-sync-row-action";
            openButton.dataset.openSchema = schemaNameForRow;
            openButton.title = `Open ${schemaNameForRow}.schema.md`;
            openButton.textContent = "↗";
            const duplicateButton = document.createElement("button");
            duplicateButton.className = "schema-sync-row-action";
            duplicateButton.dataset.duplicateSchema = schemaNameForRow;
            duplicateButton.title = `Duplicate ${schemaNameForRow}`;
            duplicateButton.textContent = "⧉";
            const deleteButton = document.createElement("button");
            deleteButton.className = "schema-sync-row-action schema-sync-row-delete";
            deleteButton.dataset.deleteSchema = schemaNameForRow;
            deleteButton.title = `Delete ${schemaNameForRow}`;
            deleteButton.textContent = "×";
            wrapper.append(selectButton, openButton, duplicateButton, deleteButton);
            row.replaceWith(wrapper);
          });
        }
        const actionBar = document.createElement("div");
        actionBar.className = "schema-sync-action-bar";
        [
          ["Add / update field", "update-schema"],
          ["Delete schema", "delete-schema"],
          ["Bind fields", "bind-fields"],
          ["Unbind fields", "unbind-fields"],
          ["Reattach from file", "reattach-schema"],
          ["Open ERD base", "open-base"],
        ].forEach(([label, action]) => {
          const button = document.createElement("button");
          button.textContent = label;
          button.dataset.action = action;
          actionBar.appendChild(button);
        });
        this.contentEl.querySelector(".schema-sync-head")?.appendChild(actionBar);
        const mapping = this.plugin.currentMappings()[schemaName];
        const mappingNote = document.createElement("small");
        mappingNote.className = "schema-sync-mapping-note";
        mappingNote.textContent = mapping ? `Bound to ${mapping.target}` : "No target config binding";
        this.contentEl.querySelector(".schema-sync-inherits")?.after(mappingNote);
        const relationPanel = this.contentEl.querySelector(".schema-sync-grid > section:nth-child(3)");
        if (relationPanel && schemaName) {
          // Each entity row gets duplicate and asset-renamer actions, mirroring
          // the 01/Registry row layout.
          relationPanel.querySelectorAll(".schema-sync-entity").forEach((entityRow) => {
            const entityPath = entityRow.dataset.entity;
            const wrapper = document.createElement("div");
            wrapper.className = "schema-sync-entity-row";
            const openButton = document.createElement("button");
            openButton.className = entityRow.className;
            openButton.dataset.entity = entityPath;
            openButton.innerHTML = entityRow.innerHTML;
            const duplicateButton = document.createElement("button");
            duplicateButton.className = "schema-sync-row-action";
            duplicateButton.dataset.duplicateEntity = entityPath;
            duplicateButton.title = "Duplicate this record";
            duplicateButton.textContent = "⧉";
            const assetButton = document.createElement("button");
            assetButton.className = "schema-sync-row-action";
            assetButton.dataset.assetEntity = entityPath;
            assetButton.title = "Open Asset Renamer for this record";
            assetButton.textContent = "🖼";
            const deleteButton = document.createElement("button");
            deleteButton.className = "schema-sync-row-action schema-sync-row-delete";
            deleteButton.dataset.deleteEntity = entityPath;
            deleteButton.title = "Delete this record";
            deleteButton.textContent = "×";
            wrapper.append(openButton, duplicateButton, assetButton, deleteButton);
            entityRow.replaceWith(wrapper);
          });
          // Always offered, not only when the schema has no records yet.
          const implementButton = document.createElement("button");
          implementButton.className = "schema-sync-implement";
          implementButton.textContent = `+ New ${schemaName} record`;
          implementButton.dataset.action = "implement-entity";
          this.contentEl.querySelector(".schema-sync-entities")?.appendChild(implementButton);
        }
        this.contentEl.querySelectorAll("[data-duplicate-entity]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.duplicateRecord(button.dataset.duplicateEntity); }));
        this.contentEl.querySelectorAll("[data-asset-entity]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.openAssetRenamer(button.dataset.assetEntity); }));
        this.contentEl.querySelectorAll("[data-delete-entity]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.deleteRecord(button.dataset.deleteEntity); }));
    this.contentEl.querySelectorAll("[data-schema]").forEach((el) => el.addEventListener("click", () => { this.selectedSchema = el.dataset.schema; this.selectedEntity = null; this.render(); }));
    this.contentEl.querySelectorAll("[data-entity]").forEach((el) => el.addEventListener("click", () => {
      const file = this.plugin.app.vault.getAbstractFileByPath(el.dataset.entity);
      if (file instanceof TFile) void this.plugin.app.workspace.getLeaf(true).openFile(file);
    }));
    this.contentEl.querySelector("[data-action=sync]")?.addEventListener("click", () => void this.plugin.syncSystem(true));
    this.contentEl.querySelector("[data-action=reload]")?.addEventListener("click", () => void this.plugin.reloadFromDisk());
    this.contentEl.querySelector("[data-action=open-base]")?.addEventListener("click", () => void this.plugin.openBaseNote(schemaName));
        this.contentEl.querySelector("[data-action=create-schema]")?.addEventListener("click", () => void this.plugin.createSchema());
        this.contentEl.querySelector("[data-action=update-schema]")?.addEventListener("click", () => void this.plugin.updateSchema(schemaName));
        this.contentEl.querySelector("[data-action=delete-schema]")?.addEventListener("click", () => void this.plugin.deleteSchema(schemaName));
        this.contentEl.querySelector("[data-action=bind-fields]")?.addEventListener("click", () => void this.plugin.bindFields(schemaName));
        this.contentEl.querySelector("[data-action=unbind-fields]")?.addEventListener("click", () => void this.plugin.unbindFields(schemaName));
        this.contentEl.querySelector("[data-action=reattach-schema]")?.addEventListener("click", () => void this.plugin.reattachSchema());
        this.contentEl.querySelector("[data-action=implement-entity]")?.addEventListener("click", () => void this.plugin.implementEntity(schemaName));
        this.contentEl.querySelector("[data-action=create-schema-registry]")?.addEventListener("click", () => void this.plugin.createSchema());
        this.contentEl.querySelectorAll("[data-open-schema]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.openSchemaNote(button.dataset.openSchema); }));
        this.contentEl.querySelectorAll("[data-duplicate-schema]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.duplicateSchema(button.dataset.duplicateSchema); }));
        this.contentEl.querySelectorAll("[data-delete-schema]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.deleteSchema(button.dataset.deleteSchema); }));
  }
}

class SchemaSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  toggle(name, description, key, onChange) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
          if (onChange) onChange();
        }));
  }

  display() {
    this.containerEl.empty();
    this.toggle(
      "Require unlock before editing a field",
      "Off by default: rows in 02 / Definition are editable straight away and save as you change them. Turn it on to put a ✎ button on every row that has to be clicked first — slower, but harder to change a schema by accident. Escape still reverts a row in either mode.",
      "requireEditUnlock",
      () => this.plugin.refreshDashboards(),
    );
    this.toggle(
      "Ask about undeclared record properties",
      "On by default. When a record gains a property its schema does not declare, offers to define it — bound to every record, or documented but unbound for a one-off. Answering \"leave it alone\" is remembered, so a record's private annotations are only ever asked about once.",
      "promptForUndeclaredProperties",
    );
    new Setting(this.containerEl)
      .setName("Forget dismissed properties")
      .setDesc(`Clears the list of properties you chose to leave alone, so they are offered again. Currently ${Object.values(this.plugin.settings.ignoredProperties).reduce((total, list) => total + list.length, 0)} remembered.`)
      .addButton((button) => button.setButtonText("Forget all").onClick(async () => {
        this.plugin.settings.ignoredProperties = {};
        await this.plugin.saveSettings();
        this.display();
      }));
    this.toggle(
      "Confirm before removing a field or deleting a record",
      "On by default. Pressing × on a bound field only unbinds it, which is never confirmed; this gates the second press that drops the field, and record deletion. Records go to the trash, so both are recoverable.",
      "confirmDestructiveActions",
    );
  }
}

class SchemaSyncPlugin extends Plugin {
  settings = { ...DEFAULT_SETTINGS };
  pending = new Map();
  patching = new Set();
  schemas = new Map();
  schemaValidationTimeout = null;
  schemaReloadTimeout = null;
  // Schema notes the user is editing by hand. While a path is in here the sync
  // will not rewrite it; edits flow the other way, from note to registry.
  safetyOff = new Set();
  // "Don't ask again" for field deletion, deliberately session-scoped so it
  // never persists across a restart.
  skipDeleteConfirm = false;
  skipRecordDeleteConfirm = false;
  safetyPrompted = new Set();
  lastAdopted = new Map();
  // Guards against a second modal for the same property while one is open, and
  // against re-asking after the modal is dismissed without an answer.
  askingAbout = new Set();
  // Schema notes edited while focused. Their sync is held until focus leaves the
  // file, so typing is never interrupted by a vault-wide rewrite.
  pendingSchemaEdits = new Set();
  schemaPreviewTimeout = null;

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SchemaSyncSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_SCHEMA_SYNC, (leaf) => new SchemaSyncView(leaf, this));
    this.addRibbonIcon("workflow", "Open schema dashboard", () => {
      void this.openDashboard();
    });
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("Schema Sync: loading");

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!this.isSchemaPath(file.path)) return this.scheduleValidation(file);
        // While the note is the focused file it belongs to the user. Hold the
        // sync, and only refresh the dashboard so edits are still visible.
        if (this.activeNotePath() === file.path) {
          this.pendingSchemaEdits.add(file.path);
          this.scheduleSchemaPreview();
          return;
        }
        this.scheduleSchemaValidation();
      })
    );
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && (file.path.startsWith(`${ASSET_CONFIG_FOLDER}/`) || file.path.startsWith(`${CONFIG_FOLDER}/`) || file.path.startsWith(`${ROOT_CONFIG_FOLDER}/`)) && file.path !== SCHEMA_MAPPING_FILE && file.path !== LEGACY_MAPPING_FILE) {
        void this.checkImplementationColumns(file);
      }
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.isSchemaFile(file)) return this.scheduleSchemaReload();
      // A record appearing from anywhere — the file explorer, Sync, a template —
      // has to reach the 03 panel, not just records this plugin created.
      if (file instanceof TFile && this.isRecordFile(file)) this.refreshDashboards();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.isSchemaFile(file)) return this.scheduleSchemaReload();
      if (!(file instanceof TFile) || !this.isRecordFile(file)) return;
      const timeout = this.pending.get(file.path);
      if (timeout) clearTimeout(timeout);
      this.pending.delete(file.path);
      void this.forgetRecord(file.path);
      this.refreshDashboards();
    }));
    // Leaving a schema note is the signal that editing is finished. Both events
    // fire on a pane or file switch; flushing is idempotent, so both call it.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.releaseClosedSafetyFiles();
      void this.refreshFromSchemaNotes();
    }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      this.releaseClosedSafetyFiles();
      void this.flushPendingSchemaEdits();
      // Told once per open, never asked. A blocking confirm here stole focus
      // from the editor, and there is nothing left to decide: an open schema
      // note is never rewritten.
      if (!this.isSchemaFile(file) || this.safetyPrompted.has(file.path)) return;
      this.safetyPrompted.add(file.path);
      new Notice(`${file.basename} is yours to edit. Schema Sync will not rewrite it while it is open, and will pick up your changes — including rows added to the Field Reference table — when you move off it.`, 6000);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.isSchemaPath(file.path) || this.isSchemaPath(oldPath)) this.scheduleSchemaReload();
      void this.handleTrackedRename(oldPath, file.path);
    }));
    this.addCommand({
      id: "validate-schema-notes",
      name: "Validate schema notes",
      callback: () => this.validateVault(true),
    });
    this.addCommand({
      id: "sync-schema-system",
      name: "Sync schema system",
      callback: () => this.syncSystem(true),
    });
    // Deferral already protects a note while it is focused. This is for the
    // longer case: keeping a schema note pinned open, untouched, across syncs.
    this.addCommand({
      id: "toggle-schema-safety",
      name: "Toggle schema safety for the active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!this.isSchemaFile(file)) return false;
        if (!checking) {
          if (this.safetyOff.delete(file.path)) new Notice(`Safety on for ${file.basename}. Sync may rewrite it again.`);
          else {
            this.safetyOff.add(file.path);
            new Notice(`Safety off for ${file.basename}. Sync will not rewrite it while it stays open.`);
          }
        }
        return true;
      },
    });
    this.addCommand({
      id: "open-schema-dashboard",
      name: "Open schema dashboard",
      callback: () => this.openDashboard(),
    });
    this.addCommand({
      id: "open-schema-erd",
      name: "Open schema ERD",
      callback: () => this.openBaseNote([...this.schemas.keys()][0]),
    });

    this.app.workspace.onLayoutReady(() => void this.initializeDatabase());
  }

  // getActiveFile() keeps returning the last opened note even when focus has
  // moved to a non-file view such as this plugin's dashboard, which left edits
  // pending forever. The active markdown view is the honest signal.
  activeNotePath() {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
  }

  // Reads every schema note's Field Reference and adopts rows that are not yet
  // declared in `fields:`. Registry only — the file is written later, and only
  // when it is not the note being edited.
  async adoptFieldReferenceEdits() {
    for (const [schemaName, fields] of this.schemas) {
      const file = this.schemaFile(schemaName);
      if (!file) continue;
      const tableFields = handAddedFields(await this.app.vault.read(file));
      const adopted = Object.entries(tableFields).filter(([name]) => !Object.prototype.hasOwnProperty.call(fields, name));
      if (adopted.length === 0) {
        this.lastAdopted.delete(schemaName);
        continue;
      }
      this.schemas.set(schemaName, { ...fields, ...Object.fromEntries(adopted) });
      // The note cannot be written back while it is open, so adoption repeats on
      // every sync. Only announce it when the set of adopted names changes.
      const signature = adopted.map(([name]) => name).join(",");
      if (this.lastAdopted.get(schemaName) === signature) continue;
      this.lastAdopted.set(schemaName, signature);
      new Notice(`${schemaName}: adopted ${signature.split(",").join(", ")} from the Field Reference table.`);
    }
  }

  // Runs on every pane switch. Re-reads the schema notes and re-renders so the
  // dashboard always matches the file, whether or not a metadata change was
  // recorded. Writes nothing itself; the full sync only follows if there were
  // edits waiting to be applied.
  async refreshFromSchemaNotes() {
    await this.loadSchemas();
    await this.adoptFieldReferenceEdits();
    this.refreshDashboards();
    await this.flushPendingSchemaEdits();
  }

  // Bottom-to-top, and destructive by design. Sync pushes the schema outward to
  // records and views; this pulls the schema note back in and lets it win. The
  // Field Reference table becomes the field set, so a row deleted there deletes
  // the field — the one thing an ordinary sync deliberately will not do.
  async reloadFromDisk() {
    await this.loadSchemas();
    const plan = [];
    for (const [schemaName, current] of this.schemas) {
      const file = this.schemaFile(schemaName);
      if (!file) continue;
      const table = parseFieldReference(await this.app.vault.read(file));
      // No table yet means nothing to pull from; frontmatter stands.
      if (Object.keys(table).length === 0) continue;
      const removed = Object.keys(current).filter((name) => !(name in table));
      const added = Object.keys(table).filter((name) => !(name in current));
      plan.push({ schemaName, file, fields: table, removed, added });
    }
    if (plan.length === 0) return new Notice("No Field Reference tables to pull from.");

    const removals = plan.filter((entry) => entry.removed.length);
    if (removals.length) {
      const detail = removals.map((entry) => `${entry.schemaName}: ${entry.removed.join(", ")}`).join("\n");
      const answer = await new Promise((resolve) => new ConfirmDeleteModal(
        this.app,
        "Pull from schema notes?",
        `The Field Reference tables become the definition. These fields are not in a table and will be dropped from the schema:\n\n${detail}\n\nValues already stored in records are left untouched.`,
        "Pull and drop",
        resolve,
      ).open());
      if (!answer.confirmed) return;
    }

    for (const entry of plan) {
      await this.app.vault.modify(entry.file, renderSchemaNote(entry.schemaName, entry.fields, this.app.metadataCache.getFileCache(entry.file)?.frontmatter?.schemaSource, schemaBodyOf(await this.app.vault.read(entry.file)), await this.app.vault.read(entry.file), this.schemas));
      this.schemas.set(entry.schemaName, entry.fields);
    }
    this.pendingSchemaEdits.clear();
    this.lastAdopted.clear();
    this.refreshDashboards();
    const changed = plan.filter((entry) => entry.added.length || entry.removed.length);
    new Notice(changed.length
      ? `Pulled from schema notes. ${changed.map((entry) => `${entry.schemaName}: ${entry.added.length} added, ${entry.removed.length} dropped`).join("; ")}. Run Sync schema system to push this out to records.`
      : `Pulled from schema notes. Nothing changed in ${plan.length} schema(s).`, 8000);
  }

  // Dashboard-only refresh: reads the registry from the metadata cache and
  // re-renders. Writes nothing, so it is safe to run against a note being typed.
  scheduleSchemaPreview() {
    if (this.schemaPreviewTimeout) clearTimeout(this.schemaPreviewTimeout);
    this.schemaPreviewTimeout = setTimeout(async () => {
      this.schemaPreviewTimeout = null;
      await this.loadSchemas();
      this.refreshDashboards();
    }, 400);
  }

  // Runs the deferred sync once the user has moved off the edited note. Files
  // still focused stay pending, so a flush triggered by an unrelated pane switch
  // does not touch the note being worked on.
  async flushPendingSchemaEdits() {
    if (this.pendingSchemaEdits.size === 0) return;
    const active = this.activeNotePath();
    const ready = [...this.pendingSchemaEdits].filter((path) => path !== active);
    if (ready.length === 0) return;
    for (const path of ready) this.pendingSchemaEdits.delete(path);
    await this.syncSystem(false);
    const names = ready.map((path) => path.split("/").pop().replace(/\.schema\.md$/, ""));
    new Notice(`Schema Sync: applied your edits to ${names.join(", ")}.`);
  }

  // Safety is scoped to "while the note is open", so anything no longer open in
  // a leaf is re-armed.
  // Every path currently open in a leaf, in any pane or sidebar.
  openNotePaths() {
    const open = new Set();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const path = leaf.view?.file?.path;
      if (path) open.add(path);
    });
    return open;
  }

  releaseClosedSafetyFiles() {
    const open = this.openNotePaths();
    for (const path of [...this.safetyOff]) if (!open.has(path)) this.safetyOff.delete(path);
    for (const path of [...this.safetyPrompted]) if (!open.has(path)) this.safetyPrompted.delete(path);
  }

  async openDashboard() {
    await this.loadSchemas();
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_SCHEMA_SYNC, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async initializeDatabase() {
    await this.ensureFirstLaunch();
    await this.syncSystem(false);
  }

  isSchemaPath(path) {
    return path.startsWith(`${SCHEMA_FOLDER}/`) || path.startsWith(`${LEGACY_SCHEMA_FOLDER}/`);
  }

  isSchemaFile(file) {
    return file instanceof TFile && this.isSchemaPath(file.path) && file.extension === "md";
  }

  scheduleSchemaReload() {
    if (this.schemaReloadTimeout) clearTimeout(this.schemaReloadTimeout);
    this.schemaReloadTimeout = setTimeout(async () => {
      this.schemaReloadTimeout = null;
      await this.loadSchemas();
      this.refreshDashboards();
      await this.syncBaseViews();
    }, 300);
  }

  async ensureFirstLaunch() {
    const schemaFiles = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${SCHEMA_FOLDER}/`));
    if (schemaFiles.length > 0) return;
    const legacySchemas = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${LEGACY_SCHEMA_FOLDER}/`) && this.app.metadataCache.getFileCache(file)?.frontmatter?.schema);
    if (legacySchemas.length > 0) {
      if (window.confirm("Legacy schemas were found. Normalize them into data/schema using PascalCase names?")) {
        await this.ensureFolder(SCHEMA_FOLDER);
        for (const file of legacySchemas) {
          const name = this.pascalCase(this.app.metadataCache.getFileCache(file).frontmatter.schema);
          const target = normalizePath(`${SCHEMA_FOLDER}/${name}.schema.md`);
          if (!this.app.vault.getAbstractFileByPath(target)) await this.app.vault.create(target, await this.app.vault.read(file));
        }
        await this.loadSchemas();
      }
      return;
    }
    if (window.confirm("No database schema exists yet. Create a sample database with the normalized data folders?")) {
      await this.createSampleDatabase();
    }
  }

  pascalCase(value) {
    return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("") || "Database";
  }

  async createSampleDatabase() {
    const name = this.pascalCase(window.prompt("Database name", SAMPLE_DATABASE) || SAMPLE_DATABASE);
    const schemaFields = {
      name: { type: "string", required: true, hasDefault: false, defaultValue: undefined },
      description: { type: "string", required: false, hasDefault: true, defaultValue: "" },
      assetCount: { type: "number", required: false, hasDefault: true, defaultValue: 0 },
    };
    await Promise.all([SCHEMA_FOLDER, CONFIG_FOLDER, ASSET_FOLDER, BASE_VIEW_FOLDER, DATA_FOLDER].map((folder) => this.ensureFolder(folder)));
    await this.app.vault.create(normalizePath(`${SCHEMA_FOLDER}/${name}.schema.md`), renderSchemaNote(name, schemaFields, `${CONFIG_FOLDER}/${name}/name.md`, undefined, undefined, this.schemas));
    await this.app.vault.create(normalizePath(`${CONFIG_FOLDER}/${name}.config.md`), `# ${name} Config\n\n| name | description | assetCount |\n| --- | --- | --- |\n`);
    await this.app.vault.create(normalizePath(`${DATA_FOLDER}/${name}Instance.md`), `---\nimplements: ${name}\nname: Sample ${name}\ndescription: "Sample record"\nassetCount: 0\n---\n\n# Sample ${name}\n`);
    await this.createSampleAsset(name);
    await this.saveMappings({ [name]: { target: `${CONFIG_FOLDER}/${name}.config.md`, fields: { name: "name", description: "description", assetCount: "assetCount" } } });
    await this.loadSchemas();
    await this.syncBaseViews();
    this.refreshDashboards();
    new Notice(`${name} database created under data/.`);
  }

  async createSampleAsset(name) {
    const path = normalizePath(`${ASSET_FOLDER}/${name}Placeholder.jpg`);
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const jpegBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8Qf//Z";
    const bytes = Uint8Array.from(atob(jpegBase64), (character) => character.charCodeAt(0));
    await this.app.vault.createBinary(path, bytes.buffer);
  }

  databaseName() {
    return this.pascalCase(SAMPLE_DATABASE);
  }

  async openBaseNote(schemaName) {
    const databaseName = this.pascalCase(SAMPLE_DATABASE);
    const baseFile = this.app.vault.getAbstractFileByPath(`${BASE_FOLDER}/${databaseName}.base.md`);
    if (baseFile instanceof TFile) await this.app.workspace.getLeaf(true).openFile(baseFile);
    else new Notice("No .base view exists yet. Run Sync database first.");
  }

  // The single source of truth for a schema's name. The filename wins; the
  // `schema:` property is only a fallback for legacy notes that lack the
  // `.schema` suffix. Every lookup must go through this, or the two identities
  // drift and one schema's generated content lands in another's file.
  schemaKeyFor(file) {
    if (!this.isSchemaPath(file.path)) return undefined;
    if (file.basename.endsWith(".schema")) return file.basename.slice(0, -".schema".length);
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.schema;
  }

  schemaFile(schemaName) {
    return this.app.vault.getMarkdownFiles().find((file) => this.isSchemaPath(file.path) && this.schemaKeyFor(file) === schemaName);
  }

  schemaSource(schemaName) {
    const file = this.schemaFile(schemaName);
    return file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.schemaSource : undefined;
  }

  refreshDashboards() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SCHEMA_SYNC)) {
      leaf.view.render();
    }
  }

  // Rewrites an existing schema note in place, carrying its prose across. Every
  // field-editing path goes through here so none of them can wipe the body.
  async writeSchemaFile(schemaName, fields, sourceOverride) {
    const file = this.schemaFile(schemaName);
    if (!file) return null;
    const raw = await this.app.vault.read(file);
    const sourcePath = sourceOverride !== undefined ? sourceOverride : this.schemaSource(schemaName);
    await this.app.vault.modify(file, renderSchemaNote(schemaName, fields, sourcePath, schemaBodyOf(raw), raw, this.schemas));
    return file;
  }

  async writeFile(path, content) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) return this.app.vault.create(path, content);
    if (await this.app.vault.read(existing) !== content) await this.app.vault.modify(existing, content);
    return existing;
  }

  parseConfigColumns(raw) {
    const table = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|") && line.endsWith("|"));
    if (table.length >= 2) {
      const columns = table[0].slice(1, -1).split("|").map((value) => value.trim()).filter(Boolean);
      const separator = table[1].slice(1, -1).split("|").every((value) => /^\s*:?-{2,}:?\s*$/.test(value));
      if (separator && columns.length > 0) return columns;
    }
    const values = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return values.length > 0 ? ["name"] : [];
  }

  fieldsFromConfig(raw) {
    return Object.fromEntries(this.parseConfigColumns(raw).map((name) => [name.replace(/[^\w-]/g, "_") || "field", {
      type: "string",
      required: name.toLowerCase() === "name",
      hasDefault: false,
      defaultValue: undefined,
      // Imported, not authored. Bind it deliberately in 02/Definition.
      bind: false,
    }]));
  }

  async reattachSchema() {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${ASSET_CONFIG_FOLDER}/`));
    const plugin = this;
    const modal = new class extends SuggestModal {
      getSuggestions(query) {
        const normalized = query.toLowerCase();
        return files.filter((file) => file.path.toLowerCase().includes(normalized));
      }
      renderSuggestion(file, element) { element.createEl("div", { text: file.path }); }
      async onChooseSuggestion(file) { await plugin.reattachFromFile(file); }
    }(this.app);
    modal.setPlaceholder("Choose an Asset Renamer config file");
    modal.open();
  }

  async reattachFromFile(file) {
    const raw = await this.app.vault.read(file);
    const schemaName = file.basename.replace(/Schema$/i, "").replace(/[^\w-]/g, "_") || "ImportedConfig";
    const fields = this.fieldsFromConfig(raw);
    const existing = this.schemaFile(schemaName);
    if (existing && !window.confirm(`Schema ${schemaName} exists. Replace its fields from ${file.path}?`)) return;
    if (existing) await this.writeSchemaFile(schemaName, fields, file.path);
    else {
      await this.ensureFolder(SCHEMA_FOLDER);
      await this.app.vault.create(normalizePath(`${SCHEMA_FOLDER}/${this.pascalCase(schemaName)}.schema.md`), renderSchemaNote(schemaName, fields, file.path, undefined, undefined, this.schemas));
    }
    const mappings = { ...this.currentMappings(), [schemaName]: { target: file.path, fields: Object.fromEntries(Object.keys(fields).map((name) => [name, name])) } };
    await this.saveMappings(mappings);
    await this.loadSchemas();
    this.refreshDashboards();
    new Notice(`Attached ${file.path} as schema ${schemaName}.`);
  }

  async checkImplementationColumns(file) {
    // Value lists this plugin generates live in the same folder; they are not
    // implementation targets and must not raise "define these columns" prompts.
    if (this.app.metadataCache.getFileCache(file)?.frontmatter?.configFor) return;
    const raw = await this.app.vault.read(file);
    // Checked against the raw text as well: the metadata cache lags a write, and
    // a missed guard here means a modal on every generated config file.
    if (/^configFor:/m.test(raw)) return;
    const columns = this.parseConfigColumns(raw);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const mappings = this.currentMappings();
    const entry = Object.entries(mappings).find(([, mapping]) => mapping.target === file.path);
    const schemaName = typeof frontmatter.implements === "string" ? frontmatter.implements : entry?.[0];
    if (!schemaName || !this.schemaFile(schemaName)) return;
    const fields = this.schemas.get(schemaName) || {};
    const implementationProperties = Object.keys(frontmatter).filter((name) => name !== "implements");
    const tableProperties = columns.length >= 2 ? columns : [];
    const unknown = [...new Set([...implementationProperties, ...tableProperties])].filter((name) => !Object.prototype.hasOwnProperty.call(fields, name));
    if (unknown.length === 0) return;
    if (!window.confirm(`${file.path} added ${unknown.join(", ")}. Define these columns in the ${schemaName} schema?`)) return;
    const nextFields = { ...fields };
    for (const column of unknown) {
      const value = frontmatter[column];
      const type = value === null ? "string" : Array.isArray(value) ? "array" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "object" ? "object" : "string";
      // Inferred from a file the plugin did not author, so it stays unbound:
      // documented, but never written back into records or a config list.
      nextFields[column] = { type, required: false, hasDefault: false, defaultValue: undefined, bind: false };
    }
    if (!this.schemaFile(schemaName)) return;
    await this.writeSchemaFile(schemaName, nextFields, file.path);
    await this.loadSchemas();
    this.refreshDashboards();
    new Notice(`Added ${unknown.length} field(s) to ${schemaName}.`);
  }

  async addSchemaFieldsToImplementation(schemaName, fields) {
    const source = this.schemaSource(schemaName) || this.currentMappings()[schemaName]?.target;
    if (!source) return;
    const file = this.app.vault.getAbstractFileByPath(source);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.read(file);
    const columns = this.parseConfigColumns(raw);
    if (columns.length < 2) return;
    const missing = Object.keys(fields).filter((field) => !columns.includes(field));
    if (missing.length === 0) return;
    const lines = raw.split(/\r?\n/).map(line => line.trim());
    const tableIndex = lines.findIndex((line) => line.trim().startsWith("|") && line.trim().endsWith("|"));
    const separatorIndex = tableIndex + 1;
    if (tableIndex < 0 || !lines[separatorIndex]) return;
    const addCells = (line) => `${line.trimEnd().slice(0, -1)} ${missing.map((field) => `| ${field} `).join("")}|`;
    lines[tableIndex] = addCells(lines[tableIndex]);
    lines[separatorIndex] = addCells(lines[separatorIndex].replace(/\|\s*$/, "|"));
    await this.app.vault.modify(file, lines.join("\n"));
  }

  parseFieldSpec(spec) {
    const [name, type = "string", ...options] = spec.split(":").map((part) => part.trim());
    if (!name || !FIELD_TYPES.includes(type)) return null;
    const definition = { type, required: options.includes("required"), hasDefault: false, defaultValue: undefined, bind: !options.includes("unbound") };
    const defaultOption = options.find((option) => option !== "required" && option !== "unbound");
    if (defaultOption !== undefined) {
      definition.hasDefault = true;
      if (type === "number") definition.defaultValue = Number(defaultOption);
      else if (type === "boolean") definition.defaultValue = defaultOption === "true";
      else if (type === "array" || type === "object") {
        try { definition.defaultValue = JSON.parse(defaultOption); } catch { definition.defaultValue = defaultOption; }
      } else definition.defaultValue = defaultOption;
    }
    return { name, definition };
  }

  editorValue(value) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }

  // Moves a renamed key in every record implementing the schema, preserving the
  // value. Without this a rename silently orphans the data: the schema forgets
  // the old key and validation then reports it as undeclared on every note.
  async renameRecordField(schemaName, oldName, newName) {
    for (const file of this.dataFiles()) {
      if (this.app.metadataCache.getFileCache(file)?.frontmatter?.implements !== schemaName) continue;
      await this.app.fileManager.processFrontMatter(file, (current) => {
        if (!(oldName in current) || newName in current) return;
        current[newName] = current[oldName];
        delete current[oldName];
      });
    }
  }

  // Renaming a field used to leave its value list behind under the old name,
  // and the next sync generated a second one alongside it.
  async renameFieldConfig(schemaName, oldName, newName) {
    const existingPaths = new Set(this.app.vault.getMarkdownFiles().map((each) => each.path));
    const plan = configRenamePlan({ schemaName, oldName, newName, existingPaths });
    if (plan.action === "none") return;
    if (plan.action === "conflict") {
      return new Notice(`${plan.to} already exists, so "${oldName}" kept its value list at ${plan.from}. Clear the leftover from 01 / Registry, then rename again.`, 10000);
    }
    const file = this.app.vault.getAbstractFileByPath(plan.from);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.renameFile(file, normalizePath(plan.to));
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.configFor = [plan.configFor];
    });
  }

  async saveSchemaFromDashboard(schemaName, editor) {
    const file = this.schemaFile(schemaName);
    if (!file) return;
    const fields = {};
    const renames = [];
    for (const row of editor.querySelectorAll("[data-schema-row]")) {
      const original = row.dataset.schemaRow;
      const input = row.querySelector("[data-field-name]");
      // A name typed as [[link]] is the user reaching for the value list, not
      // asking for brackets in the field name.
      const typed = normalizeFieldName(input?.value);
      // A bad name is a mistake, not an instruction. Restore what was there and
      // abandon the whole save rather than writing a half-renamed schema.
      const nameError = input ? fieldNameError(typed) : null;
      if (nameError) {
        input.value = original;
        new Notice(`${nameError} Reverted to "${original}".`);
        return;
      }
      const name = typed || original;
      // Case-insensitive: the two names are two file names now, and this vault
      // is on a case-insensitive filesystem.
      if (Object.keys(fields).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
        if (input) input.value = original;
        new Notice(`${schemaName} already has a field named "${name}".`);
        return;
      }
      if (name !== original) renames.push([original, name]);
      const rawType = row.querySelector("[data-field-type]")?.value;
      const type = FIELD_TYPES.includes(rawType) ? rawType : "string";
      const required = row.querySelector("[data-field-required]")?.checked === true;
      const bind = row.querySelector("[data-field-bind]")?.checked !== false;
      const relationTarget = row.querySelector("[data-field-relation]")?.value || "";
      const rawDefault = row.querySelector("[data-field-default]")?.value || "";
      const definition = { type, required, bind, hasDefault: rawDefault.length > 0, defaultValue: undefined };
      if (definition.hasDefault) {
        if (type === "number") definition.defaultValue = Number(rawDefault);
        else if (type === "boolean") definition.defaultValue = rawDefault === "true";
        else if (type === "array" || type === "object") {
          try { definition.defaultValue = JSON.parse(rawDefault); } catch { definition.defaultValue = rawDefault; }
        } else definition.defaultValue = rawDefault;
      }
      if (relationTarget) definition.relation = { target: relationTarget };
      fields[name] = definition;
    }
    // Before writeSchemaFile: renameFile makes Obsidian rewrite every
    // [[Schema/field|field]] in the vault, and our own regeneration of the
    // schema note has to be the last write to land.
    for (const [oldName, newName] of renames) {
      await this.renameRecordField(schemaName, oldName, newName);
      await this.renameFieldConfig(schemaName, oldName, newName);
    }
    await this.writeSchemaFile(schemaName, fields);
    await this.addSchemaFieldsToImplementation(schemaName, fields);
    await this.syncEntityFieldsForSchema(schemaName, fields);
    this.schemas.set(schemaName, fields);
    this.refreshDashboards();
    new Notice(renames.length ? `${schemaName} saved; renamed ${renames.map(([o, n]) => `${o} → ${n}`).join(", ")} in records.` : `${schemaName} schema saved.`);
  }

  // Two-stage and non-destructive first. Deleting a bound field unbinds it: the
  // field stops being written anywhere, and values already in records survive as
  // free-form properties rather than being orphaned. Deleting an already-unbound
  // field is the one that actually removes it.
  async deleteSchemaField(schemaName, fieldName) {
    const file = this.schemaFile(schemaName);
    if (!file) return;
    const current = this.schemas.get(schemaName) || {};
    const definition = current[fieldName];
    if (!definition) return;
    if (isBound(definition)) {
      // No confirmation: unbinding writes nothing away and is reversible from
      // the bind dropdown in the same row.
      const next = setFieldBind(current, fieldName, false);
      await this.writeSchemaFile(schemaName, next);
      this.schemas.set(schemaName, next);
      await this.syncBaseViews();
      this.refreshDashboards();
      new Notice(`"${fieldName}" unbound. It is no longer written to records, config lists, base views or the ERD, and existing values are left in place. Press × again to remove it from ${schemaName}.`, 8000);
      return;
    }
    if (this.settings.confirmDestructiveActions && !this.skipDeleteConfirm) {
      // Mirrors Obsidian's own "don't ask again" on file deletion, and like it
      // the choice lasts only for this session.
      const answer = await new Promise((resolve) => new ConfirmDeleteModal(this.app, `Remove "${fieldName}" from ${schemaName}?`, `It is already unbound, so nothing is written to it. This drops it from the schema entirely. Values already stored in records are left untouched and become ordinary free-form properties.`, "Remove field", resolve).open());
      if (!answer.confirmed) return;
      if (answer.remember) this.skipDeleteConfirm = true;
    }
    const fields = { ...current };
    delete fields[fieldName];
    await this.writeSchemaFile(schemaName, fields);
    this.schemas.set(schemaName, fields);
    await this.syncBaseViews();
    this.refreshDashboards();
    new Notice(`"${fieldName}" removed from ${schemaName}.`);
  }

  async reorderSchemaFields(schemaName, fromName, toName) {
    const fields = this.schemas.get(schemaName);
    if (!fields) return;
    const next = reorderFields(fields, fromName, toName);
    await this.writeSchemaFile(schemaName, next);
    this.schemas.set(schemaName, next);
    await this.syncBaseViews();
    this.refreshDashboards();
  }

  promptSchemaValue(title, placeholder, defaultValue, callback) {
    new SchemaInputModal(this.app, title, placeholder, defaultValue, callback).open();
  }

  async createSchema() {
    this.promptSchemaValue("New schema", "PascalCase schema name", "", async (name) => {
      const schemaName = this.pascalCase(name);
      if (this.schemas.has(schemaName)) return new Notice(`Schema "${schemaName}" already exists.`);
      this.promptSchemaValue("Initial fields", "name:string:required, hp:number:100", "name:string:required", async (spec) => {
        const fields = {};
        for (const item of spec.split(",")) {
          const parsed = this.parseFieldSpec(item.trim());
          if (parsed) fields[parsed.name] = parsed.definition;
        }
        await this.writeNewSchema(schemaName, fields);
      });
    });
  }

  async writeNewSchema(schemaName, fields) {
    await this.ensureFolder(SCHEMA_FOLDER);
    const path = normalizePath(`${SCHEMA_FOLDER}/${schemaName}.schema.md`);
    if (this.app.vault.getAbstractFileByPath(path)) return new Notice(`Schema file already exists: ${path}`);
    try {
      await this.app.vault.create(path, renderSchemaNote(schemaName, fields, undefined, undefined, undefined, this.schemas));
      await this.loadSchemas();
      this.selectedSchema = schemaName;
      this.refreshDashboards();
      new Notice(`Schema "${schemaName}" created.`);
    } catch (error) {
      new Notice(`Could not create schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async duplicateSchema(schemaName) {
    const sourceFields = this.schemas.get(schemaName);
    if (!sourceFields) return;
    this.promptSchemaValue("Duplicate schema", "New PascalCase schema name", `${schemaName}Copy`, async (requestedName) => {
      const targetName = this.pascalCase(requestedName);
      if (this.schemas.has(targetName)) return new Notice(`Schema "${targetName}" already exists.`);
      const fields = Object.fromEntries(Object.entries(sourceFields).map(([name, definition]) => [name, { ...definition, relation: definition.relation ? { ...definition.relation } : undefined }]));
      await this.writeNewSchema(targetName, fields);
      new Notice(`Schema "${targetName}" duplicated from "${schemaName}".`);
    });
  }

  async updateSchema(schemaName) {
    const file = this.schemaFile(schemaName);
    if (!file) return;
    this.promptSchemaValue("Add field", "field:type[:default|:required]", "", async (spec) => {
      const parsed = this.parseFieldSpec(spec);
      if (!parsed) return new Notice("Use string, number, boolean, array, or object as the field type.");
      const fields = { ...(this.schemas.get(schemaName) || {}), [parsed.name]: parsed.definition };
      await this.writeSchemaFile(schemaName, fields);
      await this.addSchemaFieldsToImplementation(schemaName, fields);
      await this.syncEntityFieldsForSchema(schemaName, fields);
      this.schemas.set(schemaName, fields);
      this.refreshDashboards();
      new Notice(`Field "${parsed.name}" added to ${schemaName}.`);
    });
  }

  async deleteSchema(schemaName) {
    const file = this.schemaFile(schemaName);
    if (!file || !window.confirm(`Delete schema "${schemaName}"? Existing entity notes will not be deleted.`)) return;
    await this.app.vault.delete(file);
    await this.loadSchemas();
    this.refreshDashboards();
    new Notice(`Schema "${schemaName}" deleted.`);
  }

  mappingFile() {
    return this.app.vault.getAbstractFileByPath(SCHEMA_MAPPING_FILE) || this.app.vault.getAbstractFileByPath(LEGACY_MAPPING_FILE);
  }

  currentMappings() {
    const file = this.mappingFile();
    return file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.schemaMappings || {} : {};
  }

  async bindFields(schemaName) {
    const fields = this.schemas.get(schemaName) || {};
    const target = window.prompt("Target config path", "assets/config/Entities.md");
    if (!target?.trim()) return;
    const bindings = {};
    for (const fieldName of Object.keys(fields)) {
      const value = window.prompt(`Target attribute for ${fieldName}`, fieldName);
      if (value?.trim()) bindings[fieldName] = value.trim();
    }
    const mappings = { ...this.currentMappings(), [schemaName]: { target: target.trim(), fields: bindings } };
    await this.saveMappings(mappings);
    this.refreshDashboards();
    new Notice(`Bindings saved for ${schemaName}.`);
  }

  async unbindFields(schemaName) {
    const mappings = { ...this.currentMappings() };
    if (!mappings[schemaName]) return new Notice(`No bindings found for ${schemaName}.`);
    delete mappings[schemaName];
    await this.saveMappings(mappings);
    this.refreshDashboards();
    new Notice(`Bindings removed for ${schemaName}.`);
  }

  // Single writer for the mappings note. Previously three near-identical copies
  // of this existed, and all of them created the folder "config" while writing
  // to data/config/schema-mappings.md.
  async writeMappingsFile(schemaMappings, records, generatedPaths) {
    await this.ensureFolder(CONFIG_FOLDER);
    const content = `---\nschemaMappings: ${JSON.stringify(schemaMappings)}\nrecordMappings: ${JSON.stringify(records)}\ngeneratedPaths: ${JSON.stringify(generatedPaths)}\n---\n\n# Schema Mappings\n\nField bindings are tracked by vault path, not note name.\n`;
    const file = this.mappingFile();
    if (!(file instanceof TFile)) return this.app.vault.create(SCHEMA_MAPPING_FILE, content);
    // Compare before writing: syncSystem calls this on every run, and a
    // no-op write still churns the file's mtime and Obsidian Sync.
    if (await this.app.vault.read(file) !== content) await this.app.vault.modify(file, content);
    return file;
  }

  async saveMappings(mappings) {
    await this.writeMappingsFile(mappings, this.currentRecordMappings(), this.currentGeneratedPaths());
  }

  async saveGeneratedPaths(generatedPaths) {
    await this.writeMappingsFile(this.currentMappings(), this.currentRecordMappings(), generatedPaths);
  }

  currentRecordMappings() {
    const file = this.mappingFile();
    return file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.recordMappings || {} : {};
  }

  currentGeneratedPaths() {
    const file = this.mappingFile();
    return file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.generatedPaths || {} : {};
  }

  async trackRecord(filePath, schemaName) {
    const records = { ...this.currentRecordMappings(), [filePath]: { schema: schemaName } };
    await this.saveRecordMappings(records);
  }

  async saveRecordMappings(records) {
    await this.writeMappingsFile(this.currentMappings(), records, this.currentGeneratedPaths());
  }

  async updateTrackedPath(oldPath, newPath) {
    const schemaMappings = { ...this.currentMappings() };
    let changed = false;
    for (const mapping of Object.values(schemaMappings)) {
      if (mapping.target === oldPath) {
        mapping.target = newPath;
        changed = true;
      }
    }
    const records = { ...this.currentRecordMappings() };
    if (records[oldPath]) {
      records[newPath] = records[oldPath];
      delete records[oldPath];
      changed = true;
    }
    const generatedPaths = { ...this.currentGeneratedPaths() };
    if (generatedPaths[oldPath]) {
      generatedPaths[newPath] = generatedPaths[oldPath];
      delete generatedPaths[oldPath];
      changed = true;
    }
    if (changed) await this.writeMappingsFile(schemaMappings, records, generatedPaths);
  }

  async handleTrackedRename(oldPath, newPath) {
    await this.updateTrackedPath(oldPath, newPath);
    const sourceSchemas = this.app.vault.getMarkdownFiles().filter((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return this.isSchemaPath(file.path) && frontmatter?.schemaSource === oldPath;
    });
    for (const schemaFile of sourceSchemas) {
      await this.app.fileManager.processFrontMatter(schemaFile, (frontmatter) => {
        frontmatter.schemaSource = newPath;
      });
    }
    this.refreshDashboards();
    const movedConfig = newPath.startsWith(`${CONFIG_FOLDER}/`) || newPath.startsWith(`${ASSET_CONFIG_FOLDER}/`);
    if (movedConfig) {
      const movedFile = this.app.vault.getAbstractFileByPath(newPath);
      if (movedFile instanceof TFile) void this.checkImplementationColumns(movedFile);
    }
  }

  // Creates a real record in the schema's own records folder, carrying every
  // field. Repeatable: each press takes the next free number, starting at 2 so
  // the numbering sits alongside the unnumbered _placeholder template.
  async implementEntity(schemaName) {
    const fields = this.schemas.get(schemaName);
    if (!fields) return new Notice(`Schema "${schemaName}" was not found.`);
    const folder = await this.folderForSchema(schemaName);
    await this.ensureFolder(folder);
    const stem = PLACEHOLDER_PREFIX.slice(0, -1);
    let index = 2;
    let path = normalizePath(`${folder}/${stem}${index}.${schemaName}.md`);
    while (this.app.vault.getAbstractFileByPath(path)) {
      index += 1;
      path = normalizePath(`${folder}/${stem}${index}.${schemaName}.md`);
    }
    await this.app.vault.create(path, `---\n${renderRecordFrontmatter(schemaName, fields)}\n---\n# ${schemaName} ${index}\n\nRecord generated from the ${schemaName} schema. Rename this note once it holds real data.\n\n${NOTES_MARKER}\n\n`);
    await this.trackRecord(path, schemaName);
    this.refreshDashboards();
    new Notice(`Created ${path}.`);
  }

  async forgetRecord(recordPath) {
    const records = this.currentRecordMappings();
    if (!records[recordPath]) return;
    const next = { ...records };
    delete next[recordPath];
    await this.saveRecordMappings(next);
  }

  async deleteRecord(recordPath) {
    const file = this.app.vault.getAbstractFileByPath(recordPath);
    if (!(file instanceof TFile)) return new Notice("That record no longer exists.");
    if (this.settings.confirmDestructiveActions && !this.skipRecordDeleteConfirm) {
      const answer = await new Promise((resolve) => new ConfirmDeleteModal(this.app, `Delete "${file.basename}"?`, `${file.path} will be moved to trash.`, "Delete record", resolve).open());
      if (!answer.confirmed) return;
      if (answer.remember) this.skipRecordDeleteConfirm = true;
    }
    // trashFile honours the vault's own "move to system trash" setting rather
    // than deleting outright.
    if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(file);
    else await this.app.vault.trash(file, true);
    await this.forgetRecord(recordPath);
    this.refreshDashboards();
    new Notice(`Deleted ${file.basename}.`);
  }

  // Fires when a record gains a property its schema does not declare. Asks once
  // per property; "leave it alone" is remembered on disk so a record's private
  // annotations never nag again.
  async checkUndeclaredProperties(file) {
    if (!this.settings.promptForUndeclaredProperties) return;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const schemaName = frontmatter?.implements;
    if (typeof schemaName !== "string") return;
    const fields = this.schemas.get(schemaName);
    const ignored = new Set(this.settings.ignoredProperties[schemaName] || []);
    // Templates are included on purpose — see undeclaredPropertyFor().
    const unknown = undeclaredPropertyFor({ schemaName, frontmatter, fields, ignored, asking: this.askingAbout });
    if (!unknown) return;

    const key = `${schemaName}.${unknown}`;
    this.askingAbout.add(key);
    const type = this.inferRecordFieldType(frontmatter[unknown]);
    const choice = await new Promise((resolve) => new UndeclaredPropertyModal(
      this.app,
      { property: unknown, type, schemaName, recordName: file.basename },
      resolve,
    ).open());

    if (choice === "defer") {
      this.askingAbout.delete(key);
      return;
    }
    if (choice === "ignore") {
      this.settings.ignoredProperties[schemaName] = [...ignored, unknown];
      await this.saveSettings();
      new Notice(`"${unknown}" left as a property of ${file.basename} alone.`);
      return;
    }

    const bind = choice === "bind";
    const next = { ...fields, [unknown]: { type, required: false, hasDefault: false, defaultValue: undefined, bind } };
    await this.writeSchemaFile(schemaName, next);
    this.schemas.set(schemaName, next);
    if (bind) await this.syncEntityFieldsForSchema(schemaName, next);
    await this.syncBaseViews();
    this.refreshDashboards();
    if (bind) {
      new Notice(`"${unknown}" added to ${schemaName} and to every ${schemaName} record.`);
      await this.openDashboardAt(schemaName);
    } else {
      new Notice(`"${unknown}" documented in ${schemaName} as unbound. Other records are untouched; bind it when you want it everywhere.`, 7000);
    }
  }

  // An [[link]] to a non-markdown file is an attachment, not a plain string.
  inferRecordFieldType(value) {
    if (typeof value === "string") {
      const link = value.trim().match(/^\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]$/);
      const target = link ? this.app.metadataCache.getFirstLinkpathDest(link[1].trim(), "") : null;
      if (target && target.extension && target.extension.toLowerCase() !== "md") return "attachment";
    }
    return inferFieldType(value);
  }

  async openDashboardAt(schemaName) {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCHEMA_SYNC)[0];
    const leaf = existing || this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_SCHEMA_SYNC, active: true });
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view?.selectedSchema !== undefined) {
      leaf.view.selectedSchema = schemaName;
      leaf.view.render();
    }
  }

  async openSchemaNote(schemaName) {
    const file = this.schemaFile(schemaName);
    if (!file) return new Notice(`No schema file found for "${schemaName}".`);
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  // Opens the value list backing a field. When there is no list, says which of
  // the rules excluded it rather than failing silently.
  async openFieldConfig(schemaName, fieldName) {
    const definition = (this.schemas.get(schemaName) || {})[fieldName];
    if (!definition) return new Notice(`"${fieldName}" is not a field of ${schemaName}.`);
    const configPath = configPathFor(schemaName, fieldName, definition);
    if (!configPath) {
      if (!isBound(definition)) return new Notice(`"${fieldName}" is unbound, so it has no value list. Set bind to yes to generate one.`);
      if (definition.relation?.target) return new Notice(`"${fieldName}" is a relation to ${definition.relation.target} — its values come from that entity's own value list, not one of its own.`);
      if (IDENTITY_FIELDS.has(fieldName.toLowerCase())) return new Notice(`"${fieldName}" is an identity key rather than a category, so it has no value list.`);
      return new Notice(`Only string fields get a value list; "${fieldName}" is ${definition.type}.`);
    }
    const path = normalizePath(configPath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return new Notice(`${path} has not been generated yet. Run Sync schema system first.`);
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async duplicateRecord(recordPath) {
    const source = this.app.vault.getAbstractFileByPath(recordPath);
    if (!(source instanceof TFile)) return new Notice("That record no longer exists.");
    const raw = await this.app.vault.read(source);
    const folder = source.parent?.path && source.parent.path !== "/" ? source.parent.path : DATA_FOLDER;
    let index = 2;
    let path = normalizePath(`${folder}/${source.basename} ${index}.md`);
    while (this.app.vault.getAbstractFileByPath(path)) {
      index += 1;
      path = normalizePath(`${folder}/${source.basename} ${index}.md`);
    }
    const created = await this.app.vault.create(path, raw);
    const schemaName = this.app.metadataCache.getFileCache(source)?.frontmatter?.implements;
    if (typeof schemaName === "string") await this.trackRecord(path, schemaName);
    this.refreshDashboards();
    await this.app.workspace.getLeaf(true).openFile(created);
    new Notice(`Duplicated to ${path}.`);
  }

  // Asset Renamer builds its property picker from the note's frontmatter keys,
  // so an attachment-typed field is selectable there with no changes on its side.
  async openAssetRenamer(recordPath) {
    const file = this.app.vault.getAbstractFileByPath(recordPath);
    if (!(file instanceof TFile)) return new Notice("That record no longer exists.");
    await this.app.workspace.getLeaf(true).openFile(file);
    const command = this.app.commands?.commands?.["asset-renamer:open-asset-renamer"];
    if (!command) return new Notice("Asset Renamer is not enabled.");
    this.app.commands.executeCommandById("asset-renamer:open-asset-renamer");
  }

  onunload() {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    if (this.schemaValidationTimeout) clearTimeout(this.schemaValidationTimeout);
    if (this.schemaReloadTimeout) clearTimeout(this.schemaReloadTimeout);
    if (this.schemaPreviewTimeout) clearTimeout(this.schemaPreviewTimeout);
  }

  scheduleSchemaValidation() {
    if (this.schemaValidationTimeout) clearTimeout(this.schemaValidationTimeout);
    this.schemaValidationTimeout = setTimeout(() => {
      this.schemaValidationTimeout = null;
      void this.syncSystem(false);
    }, 250);
  }

  scheduleValidation(file) {
    if (!(file instanceof TFile) || !this.isRecordFile(file)) return;
    const previous = this.pending.get(file.path);
    if (previous) clearTimeout(previous);
    this.pending.set(
      file.path,
      setTimeout(async () => {
        this.pending.delete(file.path);
        await this.validateFile(file, true);
        await this.checkUndeclaredProperties(file);
      }, 250)
    );
  }

  async validateVault(showSummary) {
    await this.loadSchemas();
    const files = this.dataFiles();
    let issues = 0;
    for (const file of files) issues += await this.validateFile(file, false);
    this.statusBar.setText(issues ? `Schema Sync: ${issues} issue(s)` : "Schema Sync: OK");
    if (showSummary) {
      new Notice(issues ? `Schema Sync found ${issues} issue(s).` : "Schema Sync: all notes are valid.");
    }
  }

  async syncSystem(showNotice) {
    await this.loadSchemas();
    // Runs before records so a field added by hand to a Field Reference table
    // reaches records, config lists and base views on this pass, not the next.
    await this.adoptFieldReferenceEdits();
    for (const [schemaName, fields] of this.schemas) {
      await this.syncEntityFieldsForSchema(schemaName, fields);
    }
    await this.ensurePlaceholders();
    await this.importLists();
    // Config lists read record values, so they must run after records are
    // back-filled. Base views depend only on schema fields.
    await this.syncConfigLists();
    const generated = {};
    await this.syncBaseViews(generated);
    await this.cleanupGeneratedPaths(generated);
    await this.saveGeneratedPaths(generated);
    // showNotice is true only for a user-pressed sync, which is exactly when
    // normalising an open schema note is wanted.
    await this.syncSchemaDocs(showNotice);
    await this.validateVault(showNotice);
    this.refreshDashboards();
  }

  async syncEntityFieldsForSchema(schemaName, fields) {
    const entities = this.dataFiles().filter((file) => !file.basename.startsWith(PLACEHOLDER_PREFIX));
    for (const file of entities) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.implements !== schemaName) continue;
      await this.app.fileManager.processFrontMatter(file, (current) => {
        for (const [fieldName, definition] of Object.entries(fields)) {
          if (!isBound(definition) || fieldName in current) continue;
          current[fieldName] = definition.hasDefault ? definition.defaultValue : emptyValue(definition.type);
        }
      });
    }
  }

  // `.base` is Obsidian Bases YAML; `.base.md` is a note wrapping a DBML fence
  // for the DBML Visualizer plugin. Two unrelated formats — writing DBML into a
  // `.base` file is what made Bases report "unable to parse file".
  async syncBaseViews(generated = {}) {
    if (this.schemas.size === 0) return;
    await this.ensureFolder(BASE_VIEW_FOLDER);
    for (const [schemaName, fields] of this.schemas) {
      const folder = await this.folderForSchema(schemaName);
      const path = normalizePath(`${BASE_VIEW_FOLDER}/${schemaName}.base`);
      await this.writeFile(path, renderBaseYaml(schemaName, fields, folder));
      generated[path] = schemaName;
    }
    await this.syncErd(generated);
  }

  async syncErd(generated = {}) {
    const path = normalizePath(`${BASE_FOLDER}/${this.databaseName()}.base.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const existingRaw = existing instanceof TFile ? await this.app.vault.read(existing) : "";
    await this.writeFile(path, renderErdNote(this.databaseName(), this.schemas, existingRaw));
    generated[path] = "*";
  }

  // Only paths this plugin recorded as generated are ever deleted. The previous
  // implementation cleared every .base / .base.md under data/, taking
  // hand-authored files with it.
  async cleanupGeneratedPaths(generated) {
    for (const path of Object.keys(this.currentGeneratedPaths())) {
      if (Object.prototype.hasOwnProperty.call(generated, path)) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.app.vault.delete(file);
    }
  }

  // One .config.md per attribute name, shared across every schema declaring it.
  // Values found in records are unioned with whatever the file already holds, so
  // hand-added options are never dropped. These are deliberately not registered
  // as generated paths: they carry user-curated content and must survive a field
  // being renamed or removed.
  async syncConfigLists() {
    await this.relocateConfigNotes();
    const targets = new Map();
    for (const [schemaName, fields] of this.schemas) {
      for (const [fieldName, definition] of Object.entries(fields)) {
        const path = configPathFor(schemaName, fieldName, definition);
        if (path) targets.set(path, { schemaName, fieldName, values: new Set() });
      }
    }
    if (targets.size === 0) return;
    for (const file of this.dataFiles()) {
      if (file.basename.startsWith(PLACEHOLDER_PREFIX)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter || typeof frontmatter.implements !== "string") continue;
      for (const entry of targets.values()) {
        if (entry.schemaName !== frontmatter.implements) continue;
        const raw = frontmatter[entry.fieldName];
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          const text = typeof value === "string" ? value.trim().replace(/^\[\[|\]\]$/g, "").trim() : "";
          if (text) entry.values.add(text);
        }
      }
    }
    for (const [path, entry] of targets) {
      await this.ensureFolder(`${CONFIG_FOLDER}/${entry.schemaName}`);
      const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
      const existingRaw = existing instanceof TFile ? await this.app.vault.read(existing) : "";
      await this.writeFile(normalizePath(path), renderConfigNote(entry.fieldName, [`${entry.schemaName}.${entry.fieldName}`], [...entry.values], existingRaw));
    }
  }

  // Notes written by an older version sit flat in data/config/. Move each into
  // its schema's folder before generation runs, so generation does not create an
  // empty note at the new path and leave the old one looking like an orphan.
  async relocateConfigNotes() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.parent?.path !== CONFIG_FOLDER) continue;
      const sources = this.app.metadataCache.getFileCache(file)?.frontmatter?.configFor;
      const source = Array.isArray(sources) ? sources[0] : null;
      if (typeof source !== "string" || !source.includes(".")) continue;
      const schemaName = source.slice(0, source.indexOf("."));
      const fieldName = source.slice(source.indexOf(".") + 1);
      if (!this.schemas.has(schemaName)) continue;
      const destination = normalizePath(`${CONFIG_FOLDER}/${schemaName}/${fieldName}.md`);
      if (file.path === destination || this.app.vault.getAbstractFileByPath(destination)) continue;
      await this.ensureFolder(`${CONFIG_FOLDER}/${schemaName}`);
      await this.app.fileManager.renameFile(file, destination);
      new Notice(`Moved ${file.name} to ${destination}.`);
    }
  }

  dataFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isRecordFile(file));
  }

  isRecordFile(file) {
    if (file.path === "config/entity.md") return true;
    if (!file.path.startsWith("data/")) return false;
    return !file.path.startsWith(`${SCHEMA_FOLDER}/`) && !file.path.startsWith(`${CONFIG_FOLDER}/`) && !file.path.startsWith(`${TABLE_FOLDER}/`) && !file.path.endsWith(".base.md") && file.extension === "md";
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      await this.app.vault.createFolder(normalized);
    }
  }

  async folderForSchema(schemaName) {
    const counts = new Map();
    for (const file of this.dataFiles()) {
      if (file.basename.startsWith(PLACEHOLDER_PREFIX)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.implements !== schemaName) continue;
      const folder = file.path.slice(0, file.path.lastIndexOf("/"));
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    let winner = "";
    let max = 0;
    for (const [folder, count] of counts) {
      if (count > max) {
        winner = folder;
        max = count;
      }
    }
    return winner || `${DATA_FOLDER}/${schemaName.toLowerCase()}s`;
  }

  // Every field, not just required and defaulted ones. Records and placeholders
  // must carry the whole schema so the columns exist to be filled in.
  recordValuesFor(schemaName, fields) {
    return recordValuesFor(schemaName, fields);
  }

  emptyValue(type) {
    return emptyValue(type);
  }

  yamlValue(value) {
    return yamlValue(value);
  }

  frontmatterText(values) {
    return frontmatterText(values);
  }

  // Back-fills an existing placeholder rather than skipping it, so fields added
  // to a schema after the placeholder was created still appear. Values already
  // present are left alone.
  async ensurePlaceholders() {
    for (const [schemaName, fields] of this.schemas) {
      const folder = await this.folderForSchema(schemaName);
      await this.ensureFolder(folder);
      const path = normalizePath(`${folder}/${PLACEHOLDER_PREFIX}${schemaName}.md`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.fileManager.processFrontMatter(existing, (current) => {
          current.implements = schemaName;
          for (const [name, definition] of Object.entries(fields)) {
            if (name in current) continue;
            current[name] = definition.hasDefault ? definition.defaultValue : emptyValue(definition.type);
          }
        });
        continue;
      }
      await this.app.vault.create(path, `---\n${renderRecordFrontmatter(schemaName, fields)}\n---\n# ${schemaName} Placeholder\n\nUse this file as a template and duplicate it when creating new ${schemaName} notes.\n\n${NOTES_MARKER}\n\n`);
    }
  }

  async importLists() {
    const listFiles = this.app.vault.getFiles().filter((file) =>
      file.path.startsWith(`${LIST_FOLDER}/`) && file.extension.toLowerCase() === "csv"
    );
    for (const listFile of listFiles) {
      const schemaName = listFile.basename;
      const fields = this.schemas.get(schemaName);
      if (!fields) continue;
      const folder = await this.folderForSchema(schemaName);
      await this.ensureFolder(folder);
      const raw = await this.app.vault.read(listFile);
      const names = [...new Set(raw.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.split(",")[0].trim().replace(/^"(.*)"$/, "$1")).filter((name) => name && !/^name$/i.test(name)))];
      const labelField = fields.name ? "name" : Object.keys(fields).find((name) => fields[name].required && fields[name].type === "string") || Object.keys(fields)[0];
      for (const name of names) {
        const safeName = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "") || "Untitled";
        const path = normalizePath(`${folder}/${safeName}.md`);
        if (this.app.vault.getAbstractFileByPath(path)) continue;
        const values = recordValuesFor(schemaName, fields);
        if (labelField) values[labelField] = name;
        await this.app.vault.create(path, `---\n${frontmatterText(values)}\n---\n# ${name}\n\nAuto-generated from ${schemaName}.csv list import.\n`);
      }
    }
  }

  // Rewrites each schema note so its `schema:` property, title heading and
  // Field Reference all agree with its filename. Idempotent: a second pass over
  // a repaired file produces identical text and writes nothing.
  // Background syncs never touch a note that is open in any leaf: flushing runs
  // on active-leaf-change, when the note is no longer active but is very much
  // still open, and rewriting it there reloads the buffer under the cursor.
  // An explicitly pressed sync does normalise open notes — the user asked for it,
  // so a cursor jump is expected rather than destructive.
  async syncSchemaDocs(force) {
    const open = force ? new Set() : this.openNotePaths();
    const active = this.activeNotePath();
    for (const [schemaName, fields] of this.schemas) {
      const file = this.schemaFile(schemaName);
      if (!file) continue;
      // Even a forced sync leaves the note being typed in alone.
      if (this.safetyOff.has(file.path) || open.has(file.path) || active === file.path) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const raw = await this.app.vault.read(file);
      // A note whose declared name disagrees with its filename has prose about
      // the wrong entity, so it is reset rather than carried over.
      const body = frontmatter?.schema === schemaName ? schemaBodyOf(raw) : undefined;
      const next = renderSchemaNote(schemaName, fields, frontmatter?.schemaSource, body, raw, this.schemas);
      if (next !== raw) await this.app.vault.modify(file, next);
    }
  }

  async syncTables() {
    await this.ensureFolder(TABLE_FOLDER);
    for (const [schemaName, fields] of this.schemas) {
      const fieldNames = Object.keys(fields);
      const rows = this.dataFiles().filter((file) => !file.basename.startsWith(PLACEHOLDER_PREFIX)).map((file) => ({ file, frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter })).filter((item) => item.frontmatter?.implements === schemaName);
      const header = ["note", "implements", ...fieldNames];
      const line = (values) => `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
      const content = `# ${schemaName} Table DB\n\nAuto-generated mapping table for notes implementing \`${schemaName}\`. Paths are identities; note names may repeat.\n\n${line(header)}\n${line(header.map(() => "---"))}\n${rows.length ? rows.map(({ file, frontmatter }) => line([file.path, schemaName, ...fieldNames.map((name) => this.yamlValue(frontmatter[name]))])).join("\n") : line(["_none_", schemaName, ...fieldNames.map(() => "")])}\n`;
      const path = normalizePath(`${TABLE_FOLDER}/${schemaName}.table.md`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modify(existing, content);
      else await this.app.vault.create(path, content);
    }
  }

  async loadSchemas() {
    this.schemas.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isSchemaPath(file.path)) continue;
      const key = this.schemaKeyFor(file);
      if (typeof key !== "string" || !key) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      this.schemas.set(key, this.readFields(frontmatter?.fields));
    }
  }

  readFields(rawFields) {
    const fields = {};
    const entries = Array.isArray(rawFields)
      ? rawFields
      : rawFields && typeof rawFields === "object"
        ? Object.entries(rawFields).map(([name, meta]) => ({ [name]: meta }))
        : [];
    for (const entry of entries) {
      // `- fieldName` with nothing under it is a half-written field, not a
      // reason to drop it silently. Treat it as a plain bound string.
      if (typeof entry === "string" && entry.trim()) {
        fields[entry.trim()] = { type: "string", required: false, hasDefault: false, defaultValue: undefined, bind: false };
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      for (const [name, rawDefinition] of Object.entries(entry)) {
        const declared = rawDefinition && typeof rawDefinition === "object" ? rawDefinition : null;
        const definition = declared || {};
        // A field with no type declared is a placeholder for a decision not yet
        // made. It stays unbound until it is given one.
        const bindsByDefault = Boolean(declared && declared.type);
        fields[name] = {
          type: FIELD_TYPES.includes(definition.type) ? definition.type : "string",
          required: definition.required === true,
          hasDefault: Object.prototype.hasOwnProperty.call(definition, "default"),
          defaultValue: definition.default,
          relation: typeof definition.relation === "string" ? { target: definition.relation } : definition.relation,
          // An explicit bind wins; otherwise a typed field binds and an
          // untyped placeholder does not.
          bind: typeof definition.bind === "boolean" ? definition.bind : bindsByDefault,
        };
      }
    }
    return fields;
  }

  async validateFile(file, showNotice) {
    if (!shouldValidateNote(file.basename)) return 0;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter || typeof frontmatter.implements !== "string") return 0;

    if (this.schemas.size === 0) await this.loadSchemas();
    const fields = this.schemas.get(frontmatter.implements);
    if (!fields) {
      if (showNotice) new Notice(`${file.path}: schema "${frontmatter.implements}" was not found.`);
      return 1;
    }

    const errors = [];
    const defaults = {};
    for (const [name, definition] of Object.entries(fields)) {
      // Unbound fields are never written to records, so they are never missing.
      if (!isBound(definition)) continue;
      if (!(name in frontmatter) || frontmatter[name] === null || frontmatter[name] === undefined) {
        if (definition.hasDefault) defaults[name] = definition.defaultValue;
        else if (definition.required) errors.push(`${name} is required`);
        continue;
      }
      const actual = this.valueType(frontmatter[name]);
      // An attachment is stored as a string holding a [[wikilink]].
      if (actual !== storageType(definition.type)) {
        errors.push(`${name} expects ${definition.type}, got ${actual}`);
        continue;
      }
      // Records now carry every field, so a required field arrives present but
      // blank. Without this the whole vault would validate clean.
      if (definition.required && isEmptyValue(frontmatter[name])) errors.push(`${name} is required`);
    }

    // Properties a record carries that its schema does not declare are the
    // note's own business: scratch annotations, kept local, never reported and
    // never pushed back into the schema. Nothing removes them either.

    if (Object.keys(defaults).length > 0 && !this.patching.has(file.path)) {
      this.patching.add(file.path);
      try {
        await this.app.fileManager.processFrontMatter(file, (current) => {
          for (const [name, value] of Object.entries(defaults)) {
            if (!(name in current) || current[name] === null || current[name] === undefined) current[name] = value;
          }
        });
      } finally {
        this.patching.delete(file.path);
      }
    }

    if (showNotice && errors.length > 0) {
      new Notice(`${file.path}: ${errors.join("; ")}`, 10000);
    }
    return errors.length;
  }

  valueType(value) {
    if (Array.isArray(value)) return "array";
    if (value === null) return "null";
    return typeof value;
  }
}

module.exports = SchemaSyncPlugin;

// Exposed for the out-of-vault test script. Obsidian ignores extra exports.
module.exports.generators = {
  emptyValue,
  isEmptyValue,
  isBound,
  storageType,
  reorderFields,
  renameField,
  inferFieldType,
  setFieldBind,
  yamlValue,
  frontmatterText,
  recordValuesFor,
  renderRecordFrontmatter,
  renderBaseYaml,
  parseConfigValues,
  parseConfigRows,
  configPathFor,
  configRenamePlan,
  orphanedConfigs,
  normalizeFieldName,
  fieldNameError,
  shouldValidateNote,
  undeclaredPropertyFor,
  extractUserNotes,
  NOTES_MARKER,
  renderConfigNote,
  fieldReferenceLink,
  renderFieldReference,
  parseFieldReference,
  handAddedFields,
  coerceDefault,
  schemaBodyOf,
  renderSchemaNote,
  renderDbml,
  renderErdNote,
};