const { Modal, Notice, Plugin, Setting, TFile } = require("obsidian");

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv", "avi", "3gp"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const DEFAULT_SETTINGS = { configFolder: "assets/config", configBasePath: "assets/config/config.base", categoryLinkPrefix: "", metadataMenuMappingEnabled: null };
const CONFIG_SOURCE_ORDER = ["categories", "eras", "weathers", "roles", "asset_types", "outfit_types", "entities"];
const EXCLUDED_CONFIG_FILES = new Set(["sources.md", "list.md"]);

class MetadataMenuMapping {
	constructor(plugin, obsidianApi) {
		this.plugin = plugin;
		this.Modal = obsidianApi.Modal;
		this.Notice = obsidianApi.Notice;
		this.Setting = obsidianApi.Setting;
	}

	isAvailable() {
		return this.plugin.app.plugins.enabledPlugins.has("metadata-menu") && Boolean(this.plugin.app.plugins.getPlugin("metadata-menu"));
	}

	async promptIfNeeded() {
		if (!this.isAvailable() || this.plugin.settings.metadataMenuMappingPrompted) return;
		this.plugin.settings.metadataMenuMappingPrompted = true;
		await this.plugin.saveSettings();
		const ModalClass = this.Modal;
		const SettingClass = this.Setting;
		const Prompt = class extends ModalClass {
			constructor(plugin, onDecision) {
				super(plugin.app);
				this.onDecision = onDecision;
			}

			onOpen() {
				this.titleEl.setText("Metadata Menu detected");
				this.contentEl.createEl("p", { text: "Do you want to map Asset Renamer configuration values to Metadata Menu Select fields?" });
				new SettingClass(this.contentEl)
					.addButton((button) => button.setButtonText("Map fields").setCta().onClick(() => { this.onDecision(true); this.close(); }))
					.addButton((button) => button.setButtonText("Keep disabled").onClick(() => { this.onDecision(false); this.close(); }));
			}
		};
		new Prompt(this.plugin, async (shouldMap) => {
			this.plugin.settings.metadataMenuMappingEnabled = shouldMap;
			await this.plugin.saveSettings();
			if (shouldMap) await this.sync();
		}).open();
	}

	async sync() {
		if (!this.plugin.settings.metadataMenuMappingEnabled || !this.isAvailable()) return;
		const metadataMenu = this.plugin.app.plugins.getPlugin("metadata-menu");
		const fields = [];
		for (const file of this.plugin.getConfigSourceFiles()) {
			const values = await this.plugin.loadConfigValues(file);
			if (!values.length) continue;
			const valuesList = {};
			values.forEach((value, index) => { valuesList[String(index)] = `[[${value}]]`; });
			fields.push({
				name: this.plugin.getSourcePropertyName(file.basename),
				type: "Select",
				id: `asset-renamer-${file.basename.toLowerCase()}`,
				path: "",
				options: { sourceType: "ValuesList", valuesList, valuesListNotePath: "", valuesFromDVQuery: "" }
			});
		}
		const sourceProperties = new Set(fields.map((field) => field.name));
		metadataMenu.presetFields = metadataMenu.presetFields.filter((field) => !sourceProperties.has(field.name));
		metadataMenu.presetFields.push(...fields);
		await metadataMenu.saveSettings();
		new this.Notice(`Mapped ${fields.length} Asset Renamer source fields to Metadata Menu.`);
	}
}

class AssetRenamerModal extends Modal {
	constructor(plugin, noteFile, propertyName = "Cover") {
		super(plugin.app);
		this.plugin = plugin;
		this.noteFile = noteFile;
		this.propertyName = propertyName;
		this.selectedImage = this.getPropertyFile();
		this.mediaFiles = plugin.app.vault.getFiles().filter((file) => MEDIA_EXTENSIONS.has(file.extension.toLowerCase()));
		this.sourceValues = new Map();
		this.valueSelects = [];
		this.sourceEntries = [];
		this.categorySelect = null;
	}

	getPropertyFile() {
		const value = this.app.metadataCache.getFileCache(this.noteFile)?.frontmatter?.[this.propertyName];
		if (typeof value !== "string") return null;
		const link = value.match(/^\[\[([^#|\]]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]$/);
		const path = link ? link[1] : value.trim();
		return path ? this.app.metadataCache.getFirstLinkpathDest(path, this.noteFile.path) : null;
	}

	getPropertyNames() {
		const frontmatter = this.app.metadataCache.getFileCache(this.noteFile)?.frontmatter ?? {};
		return [...new Set([this.propertyName, ...Object.keys(frontmatter)])].sort((left, right) => {
			if (left === "Cover") return -1;
			if (right === "Cover") return 1;
			return left.localeCompare(right);
		});
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(`Asset renamer: ${this.noteFile.basename}`);
		const root = contentEl.createDiv({ cls: "asset-renamer-modal" });
		this.createTargetControls(root);
		this.createFilenameControls(root);
		await this.createSourceControls(root);
		this.createActions(root);
	}

	createTargetControls(root) {
		root.createEl("h3", { text: "Media property" });
		const propertySelect = this.addSelectRow(root, "Property");
		for (const property of this.getPropertyNames()) propertySelect.add(new Option(property, property));
		propertySelect.value = this.propertyName;
		const folderSelect = this.addSelectRow(root, "Folder");
		const mediaSelect = this.addSelectRow(root, "Media");
		const preview = root.createDiv({ cls: "asset-renamer-preview" });
		const folders = [...new Set(this.mediaFiles.map((file) => file.parent.path))].sort();
		for (const folder of folders) folderSelect.add(new Option(folder, folder));

		const updatePreview = () => {
			preview.empty();
			if (!(this.selectedImage instanceof TFile)) {
				preview.style.display = "none";
				return;
			}
			const resourcePath = this.app.vault.getResourcePath(this.selectedImage);
			const extension = this.selectedImage.extension.toLowerCase();
			const media = VIDEO_EXTENSIONS.has(extension) ? preview.createEl("video") : preview.createEl("img");
			media.src = resourcePath;
			media.setAttribute("controls", "true");
			media.setAttribute("alt", this.selectedImage.name);
			if (media instanceof HTMLVideoElement) media.controls = true;
			preview.style.display = "block";
		};
		const loadMedia = (folder) => {
			mediaSelect.replaceChildren(new Option("Select media...", ""));
			for (const file of this.mediaFiles.filter((item) => item.parent.path === folder)) mediaSelect.add(new Option(file.name, file.path));
			if (this.selectedImage?.parent?.path === folder) mediaSelect.value = this.selectedImage.path;
			updatePreview();
		};
		const loadProperty = () => {
			this.propertyName = propertySelect.value;
			this.selectedImage = this.getPropertyFile();
			folderSelect.value = this.selectedImage?.parent?.path ?? folders[0] ?? "";
			loadMedia(folderSelect.value);
		};
		propertySelect.addEventListener("change", loadProperty);
		folderSelect.value = this.selectedImage?.parent?.path ?? folders[0] ?? "";
		folderSelect.addEventListener("change", () => loadMedia(folderSelect.value));
		mediaSelect.addEventListener("change", () => {
			this.selectedImage = this.app.vault.getAbstractFileByPath(mediaSelect.value);
			updatePreview();
		});
		loadMedia(folderSelect.value);
	}

	createFilenameControls(root) {
		root.createEl("h3", { text: "Filename builder" });
		const row = root.createDiv({ cls: "asset-renamer-row" });
		row.createSpan({ text: "Preview" });
		this.filenamePreview = row.createEl("code", { text: `..._${this.timestamp()}` });
	}

	async createSourceControls(root) {
		const files = this.plugin.getConfigSourceFiles();
		for (const [index, file] of files.entries()) {
			const select = this.addSelectRow(root, file.basename);
			select.add(new Option("Select value...", ""));
			const values = await this.loadValues(file);
			for (const value of values) select.add(new Option(value, value));
			const currentValue = this.getBoundSourceValue(file.basename, values, index);
			const matchingOption = [...select.options].find((option) => this.plugin.normalizeToken(option.value) === this.plugin.normalizeToken(currentValue));
			if (matchingOption) select.value = matchingOption.value;
			select.addEventListener("change", () => this.updateFilenamePreview());
			this.valueSelects.push(select);
			const entry = { file, select, property: this.plugin.getSourcePropertyName(file.basename) };
			this.sourceEntries.push(entry);
			if (entry.property === "Category") this.categorySelect = select;
		}
	}

	getBoundSourceValue(sourceName, values, index) {
		const property = this.plugin.getSourcePropertyName(sourceName);
		const frontmatter = this.app.metadataCache.getFileCache(this.noteFile)?.frontmatter ?? {};
		const direct = this.plugin.parseMetadataValue(frontmatter[property]);
		if (direct && values.includes(direct)) return direct;
		const composite = this.plugin.parseCompositeValues(frontmatter.Category);
		return composite.find((value) => values.includes(value)) ?? composite[index] ?? "";
	}

	createActions(root) {
		const actions = root.createDiv({ cls: "asset-renamer-actions" });
		const configButton = actions.createEl("button", { text: "Configure sources" });
		configButton.addEventListener("click", () => { this.close(); new ConfigModal(this.plugin).open(); });
		const renameButton = actions.createEl("button", { text: `Rename ${this.propertyName} media`, cls: "mod-cta" });
		renameButton.addEventListener("click", () => this.rename(renameButton));
	}

	addSelectRow(root, label) {
		const row = root.createDiv({ cls: "asset-renamer-row" });
		row.createSpan({ text: label });
		return row.createEl("select");
	}

	async loadValues(file) {
		if (!this.sourceValues.has(file.path)) {
			const values = (await this.app.vault.read(file)).split(/\r?\n/).map((line) => this.parseValue(line)).filter(Boolean);
			this.sourceValues.set(file.path, [...new Set(values)]);
		}
		return this.sourceValues.get(file.path);
	}

	parseValue(line) {
		let value = line.trim();
		if (!value || value.startsWith("//") || /^\|?\s*-{3,}/.test(value)) return "";
		if (value.startsWith("|")) value = value.split("|").map((cell) => cell.trim()).filter(Boolean)[0] ?? "";
		const link = value.match(/\[\[([^#|\]]+)/);
		if (link) value = link[1];
		if (value.includes(":")) value = value.split(":", 1)[0].trim();
		return value.replace(/^\|\s*/, "").trim();
	}

	joinedName() {
		return this.valueSelects.map((select) => select.value).filter(Boolean).map((value) => String(value).trim().toLowerCase().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")).filter(Boolean).join("_");
	}

	timestamp() {
		const now = new Date();
		const pad = (value) => String(value).padStart(2, "0");
		return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	}

	updateFilenamePreview() {
		const name = this.joinedName();
		this.filenamePreview.textContent = name ? `${name}_${this.timestamp()}` : `..._${this.timestamp()}`;
	}

	async rename(button) {
		const name = this.joinedName();
		if (!name) return new Notice("Select at least one value.");
		if (!(this.selectedImage instanceof TFile)) return new Notice("Select media from the folder browser.");
		button.disabled = true;
		try {
			const filename = `${name}_${this.timestamp()}.${this.selectedImage.extension}`;
			const folder = this.selectedImage.parent.path === "/" ? "" : `${this.selectedImage.parent.path}/`;
			const targetPath = `${folder}${filename}`;
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing && existing !== this.selectedImage) throw new Error(`A file already exists: ${targetPath}`);
			if (targetPath !== this.selectedImage.path) await this.app.fileManager.renameFile(this.selectedImage, targetPath);
			await this.app.fileManager.processFrontMatter(this.noteFile, (frontmatter) => {
				frontmatter[this.propertyName] = `[[${targetPath}]]`;
				for (const entry of this.sourceEntries) {
					if (entry.select.value) frontmatter[entry.property] = `[[${entry.select.value}]]`;
				}
				if (!this.categorySelect?.value) frontmatter.Category = name;
			});
			new Notice(`Renamed to ${filename}`);
			this.close();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Could not rename the media.");
			button.disabled = false;
		}
	}
}

class BulkCategoryModal extends Modal {
	constructor(plugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.notes = [];
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Bulk rename category dependencies");
		const root = contentEl.createDiv({ cls: "asset-renamer-modal" });
		root.createEl("p", { text: "Rename a category binding across notes and their Cover attachments." });
		const oldInput = this.addTextRow(root, "Current category", "bandit-robbery");
		const newInput = this.addTextRow(root, "New category", "bandit-robbery1-2-3");
		const summary = root.createEl("p", { cls: "asset-renamer-summary", text: "Enter a category to scan the vault." });
		const scanButton = root.createEl("button", { text: "Scan dependencies" });
		const renameButton = root.createEl("button", { text: "Rename all dependencies", cls: "mod-cta" });
		renameButton.disabled = true;
		scanButton.addEventListener("click", async () => {
			this.notes = this.plugin.findCategoryNotes(oldInput.value.trim());
			const attachmentCount = new Set(this.notes.map(({ image }) => image?.path).filter(Boolean)).size;
			summary.textContent = `${this.notes.length} note(s), ${attachmentCount} unique attachment(s) found.`;
			renameButton.disabled = !this.notes.length || !newInput.value.trim() || newInput.value.trim() === oldInput.value.trim();
		});
		renameButton.addEventListener("click", async () => {
			renameButton.disabled = true;
			try {
				await this.plugin.bulkRenameCategory(oldInput.value.trim(), newInput.value.trim(), this.notes);
				this.close();
			} catch (error) {
				new Notice(error instanceof Error ? error.message : "Bulk category rename failed.");
				renameButton.disabled = false;
			}
		});
	}

	addTextRow(root, label, value) {
		const row = root.createDiv({ cls: "asset-renamer-row" });
		row.createSpan({ text: label });
		const input = row.createEl("input", { type: "text", value });
		input.addEventListener("input", () => input.dispatchEvent(new Event("change")));
		return input;
	}
}

class BulkReloadModal extends Modal {
	constructor(plugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.records = [];
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Bulk reload attachment names");
		const root = contentEl.createDiv({ cls: "asset-renamer-modal" });
		root.createEl("p", { text: "Read each note's current Category link and update only its Cover filename. The timestamp ID suffix and note metadata are preserved." });
		const summary = root.createEl("p", { cls: "asset-renamer-summary", text: "Scanning category-bound attachments..." });
		const reloadButton = root.createEl("button", { text: "Reload attachment names", cls: "mod-cta" });
		this.records = await this.plugin.findCategoryAttachmentRecords();
		const uniqueImages = new Set(this.records.map(({ image }) => image.path));
		summary.textContent = `${this.records.length} note(s), ${uniqueImages.size} attachment(s) ready. No Category or timestamp values will be changed.`;
		reloadButton.disabled = !this.records.length;
		reloadButton.addEventListener("click", async () => {
			reloadButton.disabled = true;
			try {
				await this.plugin.reloadAttachmentNames(this.records);
				this.close();
			} catch (error) {
				new Notice(error instanceof Error ? error.message : "Attachment name reload failed.");
				reloadButton.disabled = false;
			}
		});
	}
}

class ConfigModal extends Modal {
	constructor(plugin) { super(plugin.app); this.plugin = plugin; }

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Asset renamer sources");
		new Setting(contentEl).setName("Config folder").setDesc("Markdown files in this folder become filename source select boxes.").addText((text) => text.setValue(this.plugin.settings.configFolder).onChange(async (value) => {
			this.plugin.settings.configFolder = value.trim().replace(/\\/g, "/");
			await this.plugin.saveSettings();
		}));
		new Setting(contentEl).setName("config.base path").setDesc("Bases file generated for the selected config folder.").addText((text) => text.setValue(this.plugin.settings.configBasePath).onChange(async (value) => {
			this.plugin.settings.configBasePath = value.trim().replace(/\\/g, "/");
			await this.plugin.saveSettings();
		}));
		new Setting(contentEl).setName("Category link prefix").setDesc("Prefix used when binding categories.md values to the Category property.").addText((text) => text.setValue(this.plugin.settings.categoryLinkPrefix).onChange(async (value) => {
			this.plugin.settings.categoryLinkPrefix = value.trim();
			await this.plugin.saveSettings();
		}));
		const metadataMenuAvailable = this.plugin.metadataMenuMapping.isAvailable();
		new Setting(contentEl).setName("Metadata Menu mapping").setDesc(metadataMenuAvailable ? "Create selectors for configured source properties in Metadata Menu." : "Metadata Menu is not enabled, so mapping is disabled.").addToggle((toggle) => toggle.setValue(this.plugin.settings.metadataMenuMappingEnabled === true).setDisabled(!metadataMenuAvailable).onChange(async (value) => {
			this.plugin.settings.metadataMenuMappingEnabled = value;
			await this.plugin.saveSettings();
			if (value) await this.plugin.metadataMenuMapping.sync();
		}));
		new Setting(contentEl).setName("Generate config.base").setDesc("Create or update the Bases view.").addButton((button) => button.setButtonText("Generate").setCta().onClick(async () => {
			await this.plugin.generateConfigBase();
			this.close();
		}));
	}
}

module.exports = class AssetRenamerPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (typeof this.settings.metadataMenuMappingEnabled !== "boolean") this.settings.metadataMenuMappingEnabled = false;
		if (typeof this.settings.metadataMenuMappingPrompted !== "boolean") this.settings.metadataMenuMappingPrompted = false;
		this.metadataMenuMapping = new MetadataMenuMapping(this, { Modal, Notice, Setting });
		this.addCommand({ id: "open-asset-renamer", name: "Open asset renamer for active note", checkCallback: (checking) => this.openForActiveNote(checking) });
		this.addCommand({ id: "configure-asset-renamer", name: "Configure asset renamer sources", callback: () => new ConfigModal(this).open() });
		this.addCommand({ id: "bulk-rename-category", name: "Bulk rename category dependencies", callback: () => new BulkCategoryModal(this).open() });
		this.addCommand({ id: "bulk-reload-attachment-names", name: "Bulk reload attachment names from metadata", callback: () => new BulkReloadModal(this).open() });
		this.addRibbonIcon("image", "Open asset renamer for active note", () => this.openForActiveNote(false));
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFile && file.extension === "md") menu.addItem((item) => item.setTitle("Open asset renamer").setIcon("image").onClick(() => new AssetRenamerModal(this, file).open()));
		}));
		this.registerEvent(this.app.workspace.onLayoutReady(() => this.metadataMenuMapping.promptIfNeeded()));
	}

	openForActiveNote(checking) {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") return false;
		if (!checking) new AssetRenamerModal(this, file).open();
		return true;
	}

	async saveSettings() { await this.saveData(this.settings); }

	getConfigSourceFiles() {
		return this.app.vault.getMarkdownFiles()
			.filter((file) => file.parent.path === this.settings.configFolder && !EXCLUDED_CONFIG_FILES.has(file.name.toLowerCase()))
			.sort((left, right) => {
				const leftIndex = CONFIG_SOURCE_ORDER.indexOf(left.basename.toLowerCase());
				const rightIndex = CONFIG_SOURCE_ORDER.indexOf(right.basename.toLowerCase());
				if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
				return left.name.localeCompare(right.name);
			});
	}

	getSourcePropertyName(sourceName) {
		const normalized = sourceName.toLowerCase();
		const names = {
			categories: "Category",
			eras: "Era",
			weathers: "Weather",
			roles: "Role",
			entities: "Entity",
			asset_types: "Asset_type",
			outfit_types: "Outfit_type"
		};
		return names[normalized] ?? sourceName;
	}

	parseMetadataValue(value) {
		if (Array.isArray(value)) return value.map((item) => this.parseMetadataValue(item)).find(Boolean) ?? "";
		if (typeof value !== "string") return "";
		value = value.trim().replace(/^['"]|['"]$/g, "");
		const link = value.match(/^\[\[([^#|\]]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]$/);
		return (link ? link[1] : value).trim();
	}

	parseCompositeValues(value) {
		if (typeof value !== "string") return [];
		const links = [...value.matchAll(/\[\[([^#|\]]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]);
		if (links.length) return links;
		return value.split("_").map((part) => part.trim()).filter(Boolean);
	}

	getCategoryValue(noteFile) {
		const value = this.app.metadataCache.getFileCache(noteFile)?.frontmatter?.Category;
		if (typeof value !== "string") return "";
		const link = value.match(/^\[\[([^#|\]]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]$/);
		const target = link ? link[1] : value.trim();
		if (this.settings.categoryLinkPrefix && target.startsWith(this.settings.categoryLinkPrefix)) return target.slice(this.settings.categoryLinkPrefix.length);
		if (target.startsWith("categories.")) return target.slice("categories.".length);
		return target;
	}

	getLinkedFile(noteFile, propertyName) {
		const value = this.app.metadataCache.getFileCache(noteFile)?.frontmatter?.[propertyName];
		if (typeof value !== "string") return null;
		const link = value.match(/^\[\[([^#|\]]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]$/);
		const path = link ? link[1] : value.trim();
		const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, noteFile.path) : null;
		return file instanceof TFile && MEDIA_EXTENSIONS.has(file.extension.toLowerCase()) ? file : null;
	}

	findCategoryNotes(category) {
		return this.app.vault.getMarkdownFiles()
			.map((note) => ({ note, image: this.getLinkedFile(note, "Cover") }))
			.filter(({ note }) => this.getCategoryValue(note) === category);
	}

	async findCategoryAttachmentRecords() {
		const sourceValues = new Map();
		for (const file of this.getConfigSourceFiles()) sourceValues.set(file.basename, await this.loadConfigValues(file));
		return this.app.vault.getMarkdownFiles()
			.map((note) => ({ note, category: this.getCategoryValue(note), name: this.getFilenameName(note, sourceValues), image: this.getLinkedFile(note, "Cover") }))
			.filter(({ name, image }) => name && image && image.basename.match(/_(\d{8}_\d{6})$/));
	}

	async loadConfigValues(file) {
		return [...new Set((await this.app.vault.read(file)).split(/\r?\n/).map((line) => this.parseConfigValue(line)).filter(Boolean))];
	}

	parseConfigValue(line) {
		let value = line.trim();
		if (!value || value.startsWith("//") || /^\|?\s*-{3,}/.test(value)) return "";
		if (value.startsWith("|")) value = value.split("|").map((cell) => cell.trim()).filter(Boolean)[0] ?? "";
		const link = value.match(/\[\[([^#|\]]+)/);
		if (link) value = link[1];
		if (value.includes(":")) value = value.split(":", 1)[0].trim();
		return value.replace(/^\|\s*/, "").trim();
	}

	getFilenameName(noteFile, sourceValues = new Map()) {
		const frontmatter = this.app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
		const composite = this.parseCompositeValues(frontmatter.Category);
		const values = this.getConfigSourceFiles()
			.map((file) => {
				const direct = this.parseMetadataValue(frontmatter[this.getSourcePropertyName(file.basename)]);
				const candidates = sourceValues.get(file.basename) ?? [];
				if (direct && (!candidates.length || candidates.includes(direct))) return direct;
				return composite.find((value) => candidates.includes(value)) ?? "";
			})
			.filter(Boolean);
		return this.normalizeToken(values.length ? values.join("_") : composite.join("_"));
	}

	normalizeToken(value) {
		return String(value).trim().toLowerCase().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	}

	async bulkRenameCategory(oldCategory, newCategory, notes) {
		if (!oldCategory || !newCategory || oldCategory === newCategory) throw new Error("Enter two different category values.");
		const oldToken = this.normalizeToken(oldCategory);
		const newToken = this.normalizeToken(newCategory);
		const imageTargets = new Map();
		for (const { image } of notes) {
			if (!image || imageTargets.has(image.path)) continue;
			const prefix = `${oldToken}_`;
			const newName = image.basename.startsWith(prefix) ? `${newToken}_${image.basename.slice(prefix.length)}` : `${newToken}_${image.basename}`;
			const folder = image.parent.path === "/" ? "" : `${image.parent.path}/`;
			imageTargets.set(image.path, `${folder}${newName}.${image.extension}`);
		}
		for (const targetPath of imageTargets.values()) {
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing && !imageTargets.has(existing.path)) throw new Error(`A file already exists: ${targetPath}`);
		}
		const renamedPaths = new Map();
		for (const [oldPath, targetPath] of imageTargets) {
			const image = this.app.vault.getAbstractFileByPath(oldPath);
			if (!(image instanceof TFile)) continue;
			if (oldPath !== targetPath) await this.app.fileManager.renameFile(image, targetPath);
			renamedPaths.set(oldPath, targetPath);
		}
		for (const { note, image } of notes) {
			await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
				frontmatter.Category = `[[${this.settings.categoryLinkPrefix}${newToken}]]`;
				const newCover = image ? renamedPaths.get(image.path) : null;
				if (newCover) frontmatter.Cover = `[[${newCover}]]`;
			});
		}
		new Notice(`Updated ${notes.length} note(s) and ${renamedPaths.size} attachment(s).`);
	}

	async reloadAttachmentNames(records) {
		const imageTargets = new Map();
		for (const { image, name } of records) {
			const suffix = image.basename.match(/_(\d{8}_\d{6})$/)?.[1];
			if (!suffix) continue;
			const targetPath = `${image.parent.path === "/" ? "" : `${image.parent.path}/`}${name}_${suffix}.${image.extension}`;
			const previous = imageTargets.get(image.path);
			if (previous && previous !== targetPath) throw new Error(`One attachment is bound to conflicting categories: ${image.path}`);
			imageTargets.set(image.path, targetPath);
		}
		for (const targetPath of imageTargets.values()) {
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing && !imageTargets.has(existing.path)) throw new Error(`A file already exists: ${targetPath}`);
		}
		let renamedCount = 0;
		for (const [oldPath, targetPath] of imageTargets) {
			if (oldPath === targetPath) continue;
			const image = this.app.vault.getAbstractFileByPath(oldPath);
			if (!(image instanceof TFile)) continue;
			await this.app.fileManager.renameFile(image, targetPath);
			renamedCount += 1;
		}
		new Notice(`Reloaded ${renamedCount} attachment name(s); timestamps and metadata were unchanged.`);
	}

	async generateConfigBase() {
		const path = this.settings.configBasePath;
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const baseName = path.slice(path.lastIndexOf("/") + 1);
		const content = `views:\n  - type: table\n    name: Configuration records\n    filters:\n      and:\n        - file.inFolder("${this.settings.configFolder}")\n        - file.name != "${baseName}"\n    order:\n      - file.name\n      - file.path\n    sort:\n      - property: file.name\n        direction: ASC\n`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.modify(file, content);
		else await this.app.vault.create(path, content);
		new Notice(`Generated ${path}`);
	}
};
