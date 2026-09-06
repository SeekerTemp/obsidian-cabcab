const { Plugin, ItemView, Modal, Notice, TFile, SuggestModal, normalizePath } = require("obsidian");

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
    const entities = this.plugin.dataFiles().filter((file) => this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.implements === schemaName && !file.basename.startsWith(PLACEHOLDER_PREFIX));
    if (!this.selectedEntity || !entities.some((file) => file.path === this.selectedEntity.path)) this.selectedEntity = entities[0];
    const selectedFrontmatter = this.selectedEntity ? this.plugin.app.metadataCache.getFileCache(this.selectedEntity)?.frontmatter || {} : {};
    const fieldRows = Object.entries(fields).map(([name, definition]) => { const value = Object.prototype.hasOwnProperty.call(selectedFrontmatter, name) ? selectedFrontmatter[name] : definition.hasDefault ? definition.defaultValue : "—"; return `<div class="schema-sync-property"><span><b>${name}</b><small>${definition.type}${definition.required ? " · required" : ""}</small></span><code>${this.plugin.yamlValue(value)}</code></div>`; }).join("");
    this.contentEl.empty();
    this.contentEl.addClass("schema-sync-view");
        this.contentEl.innerHTML = `<div class="schema-sync-head"><div><small>SCHEMA SYNC / VAULT ARCHITECTURE</small><h1>Schema dashboard</h1></div><button data-action="sync">Sync schema system</button></div><div class="schema-sync-grid"><section><small class="schema-sync-label">01 / Registry</small><h2>Manage schemas</h2><div class="schema-sync-list">${schemas.map(([name, schemaFields]) => `<button class="schema-sync-schema ${name === schemaName ? "is-active" : ""}" data-schema="${name}"><span>${name.slice(0, 1)}</span><b>${name}</b><small>${Object.keys(schemaFields).length} properties</small></button>`).join("")}</div></section><section><small class="schema-sync-label">02 / Relation</small><h2>Entity mapping</h2><div class="schema-sync-count"><b>${entities.length}</b><small>mapped entities</small></div><div class="schema-sync-entities">${entities.map((file) => { const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}; const missing = Object.keys(fields).filter((name) => !(name in fm) && fields[name].required).length; return `<button class="schema-sync-entity ${file.path === this.selectedEntity?.path ? "is-active" : ""}" data-entity="${file.path}"><b>${file.basename}</b><small>${file.path}</small><em class="${missing ? "is-warning" : ""}">${missing ? `${missing} issue` : "In sync"}</em></button>`; }).join("") || "<p class=\"schema-sync-empty\">No mapped entities.</p>"}</div></section><section><small class="schema-sync-label">03 / Resolved entity</small><h2>${this.selectedEntity?.basename || "Select an entity"}</h2><small class="schema-sync-path">${this.selectedEntity?.path || "Choose a note from the mapping panel"}</small><div class="schema-sync-inherits">↳ Inherits from <b>${schemaName || "—"}</b></div><div class="schema-sync-properties">${this.selectedEntity ? fieldRows : "<p class=\"schema-sync-empty\">No entity selected.</p>"}</div></section></div>`;
        const grid = this.contentEl.querySelector(".schema-sync-grid");
        const sections = grid ? [...grid.children] : [];
        if (grid && sections.length === 3) {
          grid.append(sections[0], sections[2], sections[1]);
        }
        const editorPanel = this.contentEl.querySelector(".schema-sync-grid > section:nth-child(2)");
        if (editorPanel) {
          editorPanel.innerHTML = `<small class="schema-sync-label">02 / Definition</small><h2>Edit ${schemaName || "schema"}</h2><p class="schema-sync-editor-help">Changes save automatically when a field is edited.</p><div class="schema-sync-field-editor">${Object.entries(fields).map(([name, definition]) => `<div class="schema-sync-field-row" data-schema-row="${name}"><input data-field-name value="${name}" aria-label="Field name" /><select data-field-type aria-label="Field type">${["string", "number", "boolean", "array", "object"].map((type) => `<option value="${type}" ${definition.type === type ? "selected" : ""}>${type}</option>`).join("")}</select><input data-field-default value="${this.plugin.editorValue(definition.hasDefault ? definition.defaultValue : "")}" placeholder="default" aria-label="Default value" /><select data-field-relation aria-label="Foreign key target"><option value="">no foreign key</option>${schemas.map(([target]) => `<option value="${target}" ${definition.relation?.target === target ? "selected" : ""}>→ ${target}</option>`).join("")}</select><label><input data-field-required type="checkbox" ${definition.required ? "checked" : ""} /> required</label><button data-delete-field="${name}" title="Remove field">×</button></div>`).join("") || "<p class=\"schema-sync-empty\">No fields defined.</p>"}</div>`;
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
          editorPanel.querySelectorAll("[data-schema-row]").forEach((row) => {
            row.querySelectorAll("input, select").forEach((control) => { control.disabled = true; });
            const editButton = document.createElement("button");
            editButton.className = "schema-sync-row-action";
            editButton.dataset.editField = row.dataset.schemaRow;
            editButton.title = `Edit ${row.dataset.schemaRow}`;
            editButton.textContent = "✎";
            row.insertBefore(editButton, row.querySelector("[data-delete-field]"));
          });
          editorPanel.querySelectorAll("[data-delete-field]").forEach((button) => button.addEventListener("click", () => void this.plugin.deleteSchemaField(schemaName, button.dataset.deleteField)));
          editorPanel.querySelectorAll("[data-edit-field]").forEach((button) => button.addEventListener("click", () => {
            const row = button.closest("[data-schema-row]");
            row?.querySelectorAll("input, select").forEach((control) => { control.disabled = false; });
            row?.classList.add("is-editing");
          }));
          editorPanel.querySelector("[data-action=add-definition-field]")?.addEventListener("click", () => void this.plugin.updateSchema(schemaName));
          editorPanel.querySelectorAll("[data-schema-row] input, [data-schema-row] select").forEach((control) => control.addEventListener("change", () => void this.plugin.saveSchemaFromDashboard(schemaName, editorPanel)));
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
            wrapper.append(selectButton, duplicateButton, deleteButton);
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
        if (entities.length === 0 && schemaName) {
          const implementButton = document.createElement("button");
          implementButton.className = "schema-sync-implement";
          implementButton.textContent = `Implement ${schemaName} to config/entity.md`;
          implementButton.dataset.action = "implement-entity";
          this.contentEl.querySelector(".schema-sync-entities")?.appendChild(implementButton);
        }
    this.contentEl.querySelectorAll("[data-schema]").forEach((el) => el.addEventListener("click", () => { this.selectedSchema = el.dataset.schema; this.selectedEntity = null; this.render(); }));
    this.contentEl.querySelectorAll("[data-entity]").forEach((el) => el.addEventListener("click", () => {
      const file = this.plugin.app.vault.getAbstractFileByPath(el.dataset.entity);
      if (file instanceof TFile) void this.plugin.app.workspace.getLeaf(true).openFile(file);
    }));
    this.contentEl.querySelector("[data-action=sync]")?.addEventListener("click", () => void this.plugin.syncSystem(true));
    this.contentEl.querySelector("[data-action=open-base]")?.addEventListener("click", () => void this.plugin.openBaseNote(schemaName));
        this.contentEl.querySelector("[data-action=create-schema]")?.addEventListener("click", () => void this.plugin.createSchema());
        this.contentEl.querySelector("[data-action=update-schema]")?.addEventListener("click", () => void this.plugin.updateSchema(schemaName));
        this.contentEl.querySelector("[data-action=delete-schema]")?.addEventListener("click", () => void this.plugin.deleteSchema(schemaName));
        this.contentEl.querySelector("[data-action=bind-fields]")?.addEventListener("click", () => void this.plugin.bindFields(schemaName));
        this.contentEl.querySelector("[data-action=unbind-fields]")?.addEventListener("click", () => void this.plugin.unbindFields(schemaName));
        this.contentEl.querySelector("[data-action=reattach-schema]")?.addEventListener("click", () => void this.plugin.reattachSchema());
        this.contentEl.querySelector("[data-action=implement-entity]")?.addEventListener("click", () => void this.plugin.implementEntity(schemaName));
        this.contentEl.querySelector("[data-action=create-schema-registry]")?.addEventListener("click", () => void this.plugin.createSchema());
        this.contentEl.querySelectorAll("[data-duplicate-schema]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.duplicateSchema(button.dataset.duplicateSchema); }));
        this.contentEl.querySelectorAll("[data-delete-schema]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.deleteSchema(button.dataset.deleteSchema); }));
  }
}

class SchemaSyncPlugin extends Plugin {
  pending = new Map();
  patching = new Set();
  schemas = new Map();
  schemaValidationTimeout = null;
  schemaReloadTimeout = null;

  async onload() {
    this.registerView(VIEW_TYPE_SCHEMA_SYNC, (leaf) => new SchemaSyncView(leaf, this));
    this.addRibbonIcon("workflow", "Open schema dashboard", () => {
      void this.openDashboard();
    });
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText("Schema Sync: loading");

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path.startsWith(`${SCHEMA_FOLDER}/`)) {
          this.scheduleSchemaValidation();
        } else {
          this.scheduleValidation(file);
        }
      })
    );
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && (file.path.startsWith(`${ASSET_CONFIG_FOLDER}/`) || file.path.startsWith(`${CONFIG_FOLDER}/`) || file.path.startsWith(`${ROOT_CONFIG_FOLDER}/`)) && file.path !== SCHEMA_MAPPING_FILE && file.path !== LEGACY_MAPPING_FILE) {
        void this.checkImplementationColumns(file);
      }
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.isSchemaFile(file)) this.scheduleSchemaReload();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.isSchemaFile(file)) this.scheduleSchemaReload();
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
    await this.app.vault.create(normalizePath(`${SCHEMA_FOLDER}/${name}.schema.md`), this.schemaMarkdownWithSource(name, schemaFields, `${CONFIG_FOLDER}/${name}.config.md`));
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

  dbmlMarkdown(name, fields) {
    const columns = Object.entries(fields).map(([fieldName, definition]) => `  ${fieldName} ${definition.type === "number" ? "int" : definition.type === "boolean" ? "boolean" : "varchar"}${definition.required ? " [not null]" : ""}`).join("\n");
    return `# ${name} Database\n\n
generated base view for DBML Visualizer.\n\n\`\`\`dbml title="${name} ERD"\nTable ${name} {\n${columns}\n}\n\`\`\`\n`;
  }

  async openBaseNote(schemaName) {
    const databaseName = this.pascalCase(SAMPLE_DATABASE);
    const baseFile = this.app.vault.getAbstractFileByPath(`${BASE_FOLDER}/${databaseName}.base.md`);
    if (baseFile instanceof TFile) await this.app.workspace.getLeaf(true).openFile(baseFile);
    else new Notice("No .base view exists yet. Run Sync database first.");
  }

  schemaFile(schemaName) {
    return this.app.vault.getMarkdownFiles().find((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const fileNameSchema = file.path.startsWith(`${SCHEMA_FOLDER}/`) && file.basename.endsWith(".schema")
        ? file.basename.slice(0, -".schema".length)
        : frontmatter?.schema;
      return (file.path.startsWith(`${SCHEMA_FOLDER}/`) || file.path.startsWith(`${LEGACY_SCHEMA_FOLDER}/`)) && fileNameSchema === schemaName;
    });
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

  schemaMarkdown(name, fields) {
    const fieldLines = Object.entries(fields).map(([fieldName, definition]) => {
      const lines = [`  - ${fieldName}:`, `      type: ${definition.type}`];
      if (definition.required) lines.push("      required: true");
      if (definition.hasDefault) lines.push(`      default: ${this.yamlValue(definition.defaultValue)}`);
      if (definition.relation?.target) lines.push(`      relation: ${definition.relation.target}`);
      return lines.join("\n");
    });
    return `---\nschema: ${name}\nfields:\n${fieldLines.join("\n")}\n---\n\n# ${name} Schema\n\nDefines the base fields for any ${name} note.\n`;
  }

  schemaMarkdownWithSource(name, fields, sourcePath) {
    const content = this.schemaMarkdown(name, fields);
    const sourceLink = sourcePath.replace(/\.md$/i, "");
    return content.replace(`schema: ${name}\n`, `schema: ${name}\nschemaSource: ${sourcePath}\n`).replace("\nDefines the base fields", `\nSource implementation: [[${sourceLink}]]\n\nDefines the base fields`);
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
    const content = this.schemaMarkdownWithSource(schemaName, fields, file.path);
    if (existing) await this.app.vault.modify(existing, content);
    else {
      await this.ensureFolder(SCHEMA_FOLDER);
      await this.app.vault.create(normalizePath(`${SCHEMA_FOLDER}/${this.pascalCase(schemaName)}.schema.md`), content);
    }
    const mappings = { ...this.currentMappings(), [schemaName]: { target: file.path, fields: Object.fromEntries(Object.keys(fields).map((name) => [name, name])) } };
    await this.saveMappings(mappings);
    await this.loadSchemas();
    this.refreshDashboards();
    new Notice(`Attached ${file.path} as schema ${schemaName}.`);
  }

  async checkImplementationColumns(file) {
    const raw = await this.app.vault.read(file);
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
      nextFields[column] = { type, required: false, hasDefault: false, defaultValue: undefined };
    }
    const schemaFile = this.schemaFile(schemaName);
    if (!schemaFile) return;
    await this.app.vault.modify(schemaFile, this.schemaMarkdownWithSource(schemaName, nextFields, file.path));
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
    if (!name || !["string", "number", "boolean", "array", "object"].includes(type)) return null;
    const definition = { type, required: options.includes("required"), hasDefault: false, defaultValue: undefined };
    const defaultOption = options.find((option) => option !== "required");
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

  async saveSchemaFromDashboard(schemaName, editor) {
    const file = this.schemaFile(schemaName);
    if (!file) return;
    const fields = {};
    for (const row of editor.querySelectorAll("[data-schema-row]")) {
      const name = row.querySelector("[data-field-name]")?.value.trim() || row.dataset.schemaRow;
      const type = row.querySelector("[data-field-type]")?.value || "string";
      const required = row.querySelector("[data-field-required]")?.checked === true;
      const relationTarget = row.querySelector("[data-field-relation]")?.value || "";
      const rawDefault = row.querySelector("[data-field-default]")?.value || "";
      const definition = { type, required, hasDefault: rawDefault.length > 0, defaultValue: undefined };
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
    const source = this.schemaSource(schemaName);
      await this.app.vault.modify(file, source ? this.schemaMarkdownWithSource(schemaName, fields, source) : this.schemaMarkdown(schemaName, fields));
    await this.addSchemaFieldsToImplementation(schemaName, fields);
    await this.syncEntityFieldsForSchema(schemaName, fields);
    this.schemas.set(schemaName, fields);
    this.refreshDashboards();
    new Notice(`${schemaName} schema saved.`);
  }

  async deleteSchemaField(schemaName, fieldName) {
    const file = this.schemaFile(schemaName);
    if (!file || !window.confirm(`Remove field "${fieldName}" from ${schemaName}?`)) return;
    const fields = { ...(this.schemas.get(schemaName) || {}) };
    delete fields[fieldName];
    const source = this.schemaSource(schemaName);
    await this.app.vault.modify(file, source ? this.schemaMarkdownWithSource(schemaName, fields, source) : this.schemaMarkdown(schemaName, fields));
    await this.loadSchemas();
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
      await this.app.vault.create(path, this.schemaMarkdown(schemaName, fields));
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
      const source = this.schemaSource(schemaName);
      await this.app.vault.modify(file, source ? this.schemaMarkdownWithSource(schemaName, fields, source) : this.schemaMarkdown(schemaName, fields));
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

  async saveMappings(mappings) {
    await this.ensureFolder("config");
    const file = this.mappingFile();
    const records = this.currentRecordMappings();
    const content = `---\nschemaMappings: ${JSON.stringify(mappings)}\nrecordMappings: ${JSON.stringify(records)}\n---\n\n# Schema Mappings\n\nField bindings are tracked by vault path, not note name.\n`;
    if (file instanceof TFile) await this.app.vault.modify(file, content);
    else await this.app.vault.create(SCHEMA_MAPPING_FILE, content);
  }

  currentRecordMappings() {
    const file = this.mappingFile();
    return file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.recordMappings || {} : {};
  }

  async trackRecord(filePath, schemaName) {
    const records = { ...this.currentRecordMappings(), [filePath]: { schema: schemaName } };
    await this.saveRecordMappings(records);
  }

  async saveRecordMappings(records) {
    await this.ensureFolder("config");
    const file = this.mappingFile();
    const mappings = this.currentMappings();
    const content = `---\nschemaMappings: ${JSON.stringify(mappings)}\nrecordMappings: ${JSON.stringify(records)}\n---\n\n# Schema Mappings\n\nField bindings are tracked by vault path, not note name.\n`;
    if (file instanceof TFile) await this.app.vault.modify(file, content);
    else await this.app.vault.create(SCHEMA_MAPPING_FILE, content);
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
    if (changed) {
      await this.ensureFolder("config");
      const file = this.mappingFile();
      const content = `---\nschemaMappings: ${JSON.stringify(schemaMappings)}\nrecordMappings: ${JSON.stringify(records)}\n---\n\n# Schema Mappings\n\nField bindings are tracked by vault path, not note name.\n`;
      if (file instanceof TFile) await this.app.vault.modify(file, content);
      else await this.app.vault.create(SCHEMA_MAPPING_FILE, content);
    }
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
    const movedConfig = newPath.startsWith(`${CONFIG_FOLDER}/`) || newPath.startsWith(`${ASSET_CONFIG_FOLDER}/`);
    if (movedConfig) {
      const movedFile = this.app.vault.getAbstractFileByPath(newPath);
      if (movedFile instanceof TFile) void this.checkImplementationColumns(movedFile);
    }
  }

  async implementEntity(schemaName) {
    const existingData = this.dataFiles().some((file) => this.app.metadataCache.getFileCache(file)?.frontmatter?.implements === schemaName && !file.basename.startsWith(PLACEHOLDER_PREFIX));
    if (existingData) return new Notice(`${schemaName} already has entity data.`);
    const path = "config/entity.md";
    const existing = this.app.vault.getAbstractFileByPath(path);
    const values = { implements: schemaName, ...this.defaultsFor(this.schemas.get(schemaName) || {}) };
    if (existing instanceof TFile) {
      const raw = await this.app.vault.read(existing);
      const frontmatter = this.app.metadataCache.getFileCache(existing)?.frontmatter || {};
      if (frontmatter.implements && frontmatter.implements !== "Temp" && frontmatter.implements !== schemaName) {
        return new Notice(`config/entity.md already implements ${frontmatter.implements}.`);
      }
      const nextFrontmatter = `---\n${this.frontmatterText(values)}\n---`;
      const nextContent = raw.match(/^---[\s\S]*?---/) ? raw.replace(/^---[\s\S]*?---/, nextFrontmatter) : `${nextFrontmatter}\n${raw}`;
      await this.app.vault.modify(existing, nextContent.replace(/^#\s+.*$/m, `# ${schemaName} Entity`));
      await this.trackRecord(existing.path, schemaName);
      await this.loadSchemas();
      this.refreshDashboards();
      new Notice(`config/entity.md now implements ${schemaName}.`);
      return;
    }
    await this.ensureFolder("config");
    await this.app.vault.create(path, `---\n${this.frontmatterText(values)}\n---\n# ${schemaName} Entity\n\nImplementation template generated from the ${schemaName} schema.\n`);
    await this.trackRecord(path, schemaName);
    await this.loadSchemas();
    this.refreshDashboards();
    new Notice(`Created config/entity.md implementing ${schemaName}.`);
  }

  onunload() {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    if (this.schemaValidationTimeout) clearTimeout(this.schemaValidationTimeout);
    if (this.schemaReloadTimeout) clearTimeout(this.schemaReloadTimeout);
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
      setTimeout(() => {
        this.pending.delete(file.path);
        void this.validateFile(file, true);
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
    for (const [schemaName, fields] of this.schemas) {
      await this.syncEntityFieldsForSchema(schemaName, fields);
    }
    await this.syncBaseViews();
    await this.ensurePlaceholders();
    await this.importLists();
    await this.syncSchemaDocs();
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
          if (fieldName in current) continue;
          current[fieldName] = definition.hasDefault ? definition.defaultValue : this.entityValueForDefinition(fieldName, definition);
        }
      });
    }
  }

  entityValueForDefinition(fieldName, definition) {
    if (definition.type === "string") return definition.required ? `TODO_${fieldName}` : "";
    return this.emptyValue(definition.type);
  }

  dbmlForSchemas() {
    const tables = [...this.schemas.entries()].map(([name, fields]) => {
      const columns = Object.entries(fields).map(([fieldName, definition]) => `  ${fieldName} ${definition.type === "number" ? "int" : definition.type === "boolean" ? "boolean" : "varchar"}${definition.required ? " [not null]" : ""}`).join("\n");
      return `Table ${name} {\n${columns}\n}`;
    });
    const relations = [];
    for (const [name, fields] of this.schemas) {
      for (const [fieldName, definition] of Object.entries(fields)) {
        if (definition.relation?.target && this.schemas.has(definition.relation.target)) {
          const targetFields = this.schemas.get(definition.relation.target);
          const targetKey = targetFields?.id ? "id" : targetFields?.name ? "name" : Object.keys(targetFields || {})[0];
          if (targetKey) relations.push(`Ref: ${name}.${fieldName} > ${definition.relation.target}.${targetKey}`);
        }
      }
    }
    return `${tables.join("\n\n")}\n${relations.join("\n")}`;
  }

  dbmlForSchema(schemaName, fields) {
    const columns = Object.entries(fields).map(([fieldName, definition]) => `  ${fieldName} ${definition.type === "number" ? "int" : definition.type === "boolean" ? "boolean" : "varchar"}${definition.required ? " [not null]" : ""}`).join("\n");
    const relations = Object.entries(fields).filter(([, definition]) => definition.relation?.target && this.schemas.has(definition.relation.target)).map(([fieldName, definition]) => {
      const targetFields = this.schemas.get(definition.relation.target);
      const targetKey = targetFields?.id ? "id" : targetFields?.name ? "name" : Object.keys(targetFields || {})[0];
      return targetKey ? `Ref: ${schemaName}.${fieldName} > ${definition.relation.target}.${targetKey}` : "";
    }).filter(Boolean);
    return `Table ${schemaName} {\n${columns}\n}\n${relations.join("\n")}`;
  }

  async syncBaseViews() {
    if (this.schemas.size === 0) return;
    await this.ensureFolder(BASE_VIEW_FOLDER);
    const databaseName = this.pascalCase(SAMPLE_DATABASE);
    const aggregateContent = `# ${databaseName} Database\n\nGenerated DBML base view for the DBML Visualizer plugin.\n\n\`\`\`dbml title="${databaseName} ERD"\n${this.dbmlForSchemas()}\n\`\`\`\n`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.startsWith(`${BASE_FOLDER}/`) && file.path.endsWith(".base.md") && file.path !== `${BASE_FOLDER}/${databaseName}.base.md`) {
        await this.app.vault.delete(file);
      }
      if (file.path.startsWith(`${BASE_VIEW_FOLDER}/`) && file.path.endsWith(".base.md")) {
        await this.app.vault.delete(file);
      }
      if (file.path.startsWith(`${TABLE_FOLDER}/`) && file.path.endsWith(".table.md")) {
        await this.app.vault.delete(file);
      }
    }
    const aggregatePath = normalizePath(`${BASE_FOLDER}/${databaseName}.base.md`);
    const aggregateFile = this.app.vault.getAbstractFileByPath(aggregatePath);
    if (aggregateFile instanceof TFile) await this.app.vault.modify(aggregateFile, aggregateContent);
    else await this.app.vault.create(aggregatePath, aggregateContent);
    for (const [schemaName, fields] of this.schemas) {
      const nativePath = normalizePath(`${BASE_VIEW_FOLDER}/${this.pascalCase(schemaName)}.base`);
      const nativeContent = `# ${this.pascalCase(schemaName)} Base\n\n${this.dbmlForSchema(this.pascalCase(schemaName), fields)}\n`;
      const nativeFile = this.app.vault.getAbstractFileByPath(nativePath);
      if (nativeFile instanceof TFile) await this.app.vault.modify(nativeFile, nativeContent);
      else await this.app.vault.create(nativePath, nativeContent);
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

  defaultsFor(fields) {
    const values = {};
    for (const [name, definition] of Object.entries(fields)) {
      if (definition.hasDefault) values[name] = definition.defaultValue;
      else if (definition.required) values[name] = definition.type === "string" ? `TODO_${name}` : this.emptyValue(definition.type);
    }
    return values;
  }

  emptyValue(type) {
    if (type === "number") return 0;
    if (type === "boolean") return false;
    if (type === "array") return [];
    if (type === "object") return {};
    return "";
  }

  yamlValue(value) {
    if (typeof value === "string") return JSON.stringify(value);
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }

  frontmatterText(values) {
    return Object.entries(values).map(([name, value]) => `${name}: ${this.yamlValue(value)}`).join("\n");
  }

  async ensurePlaceholders() {
    for (const [schemaName, fields] of this.schemas) {
      const folder = await this.folderForSchema(schemaName);
      await this.ensureFolder(folder);
      const path = normalizePath(`${folder}/${PLACEHOLDER_PREFIX}${schemaName}.md`);
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      const values = { implements: schemaName, ...this.defaultsFor(fields) };
      await this.app.vault.create(path, `---\n${this.frontmatterText(values)}\n---\n# ${schemaName} Placeholder\n\nUse this file as a template and duplicate it when creating new ${schemaName} notes.\n`);
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
        const values = { implements: schemaName, ...this.defaultsFor(fields) };
        if (labelField) values[labelField] = name;
        await this.app.vault.create(path, `---\n${this.frontmatterText(values)}\n---\n# ${name}\n\nAuto-generated from ${schemaName}.csv list import.\n`);
      }
    }
  }

  async syncSchemaDocs() {
    for (const [schemaName, fields] of this.schemas) {
      const schemaFile = this.app.vault.getMarkdownFiles().find((file) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return file.path.startsWith(`${SCHEMA_FOLDER}/`) && frontmatter?.schema === schemaName;
      });
      if (!schemaFile) continue;
      const raw = await this.app.vault.read(schemaFile);
      const body = raw.replace(/\n## Field Reference[\s\S]*$/i, "").trimEnd();
      const rows = Object.entries(fields).map(([name, field]) => `| ${name} | ${field.type} | ${field.hasDefault ? this.yamlValue(field.defaultValue) : "-"} | ${field.required ? "yes" : "no"} |`);
      const reference = `\n\n## Field Reference\n\n| Field | Type | Default | Required |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`;
      const next = `${body}${reference}`;
      if (next !== raw) await this.app.vault.modify(schemaFile, next);
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
      if (!file.path.startsWith(`${SCHEMA_FOLDER}/`) && !file.path.startsWith(`${LEGACY_SCHEMA_FOLDER}/`)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter || typeof frontmatter.schema !== "string") continue;
      const normalizedName = file.path.startsWith(`${SCHEMA_FOLDER}/`) && file.basename.endsWith(".schema")
        ? file.basename.slice(0, -".schema".length)
        : frontmatter.schema;
      this.schemas.set(normalizedName, this.readFields(frontmatter.fields));
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
      if (!entry || typeof entry !== "object") continue;
      for (const [name, rawDefinition] of Object.entries(entry)) {
        if (!rawDefinition || typeof rawDefinition !== "object") continue;
        const definition = rawDefinition;
        fields[name] = {
          type: definition.type || "string",
          required: definition.required === true,
          hasDefault: Object.prototype.hasOwnProperty.call(definition, "default"),
          defaultValue: definition.default,
          relation: typeof definition.relation === "string" ? { target: definition.relation } : definition.relation,
        };
      }
    }
    return fields;
  }

  async validateFile(file, showNotice) {
    if (file.basename.startsWith(PLACEHOLDER_PREFIX)) return 0;
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
      if (!(name in frontmatter) || frontmatter[name] === null || frontmatter[name] === undefined) {
        if (definition.hasDefault) defaults[name] = definition.defaultValue;
        else if (definition.required) errors.push(`${name} is required`);
        continue;
      }
      const actual = this.valueType(frontmatter[name]);
      if (actual !== definition.type) errors.push(`${name} expects ${definition.type}, got ${actual}`);
    }

    for (const name of Object.keys(frontmatter)) {
      if (name !== "implements" && !Object.prototype.hasOwnProperty.call(fields, name)) {
        errors.push(`${name} is not declared by schema ${frontmatter.implements}`);
      }
    }

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