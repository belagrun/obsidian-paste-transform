import { App, Notice, Plugin, PluginSettingTab, Setting, TextAreaComponent } from 'obsidian';

interface PasteTransformSettings {
	patterns: string[];
	replacers: string[];
	enabled: boolean[];   // habilita/desabilita cada par (regex/replace)
	comments: string[];   // ← NOVO: comentário por regra
	settingsFormatVersion: number;
	debugMode: boolean;
}

const DEFAULT_SETTINGS: PasteTransformSettings = {
	patterns: [
		"^https://github.com/[^/]+/([^/]+)/issues/(\\d+)$",
		"^https://github.com/[^/]+/([^/]+)/pull/(\\d+)$",
		"^https://github.com/[^/]+/([^/]+)$",
		"^https://\\w+.wikipedia.org/wiki/([^\\s]+)$",
	],
	replacers: [
		"[🐈‍⬛🔨 $1#$2]($&)",
		"[🐈‍⬛🛠︎ $1#$2]($&)",
		"[🐈‍⬛ $1]($&)",
		"[📖 $1]($&)",
	],
	enabled: [true, true, true, true],
	comments: ["", "", "", ""],     // ← padrão vazio
	settingsFormatVersion: 3,        // bump do formato
	debugMode: false,
}

class ReplaceRule {
	pattern: RegExp;
	replacer: string;
	constructor(pattern: string, replacer: string) {
		this.pattern = new RegExp(pattern, 'g');
		this.replacer = replacer;
	}
}

export default class PasteTransform extends Plugin {
	settings: PasteTransformSettings;
	rules: ReplaceRule[] = [];

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PasteTransformSettingsTab(this.app, this));
		this.registerEvent(this.app.workspace.on("editor-paste", (event) => this.onPaste(event)));
	}

	onPaste(event: ClipboardEvent) {
		if (event.defaultPrevented) {
			if (this.settings.debugMode) console.log("It doesn't try to apply rules because event prevented already.");
			return;
		}
		const types = event.clipboardData?.types;
		if (this.settings.debugMode) console.log("transform plugin, clipboard content types:", types);
		if (types === undefined || types.length != 1 || types[0] != "text/plain") return;

		const plainText = event.clipboardData?.getData("text/plain");
		if (!plainText) return;

		const result = this.applyRules(plainText);
		if (this.settings.debugMode) console.log(`Replaced '${plainText}' -> '${result}'`);

		if (result != plainText) {
			this.app.workspace.activeEditor?.editor?.replaceSelection(result);
			event.preventDefault();
		}
	}

	onunload() {}

	// ---------------- settings / compile ----------------

	private migrateSettingsIfNeeded(s: PasteTransformSettings) {
		// v1 -> v2: criar enabled
		if (!Array.isArray(s.enabled)) s.enabled = [];
		// v2 -> v3: criar comments
		if (!Array.isArray(s.comments)) s.comments = [];

		const n = Math.min(s.patterns.length, s.replacers.length);

		for (let i = 0; i < n; i++) {
			if (typeof s.enabled[i] !== 'boolean') s.enabled[i] = true;
			if (typeof s.comments[i] !== 'string') s.comments[i] = "";
		}
		s.enabled = s.enabled.slice(0, n);
		s.comments = s.comments.slice(0, n);

		s.settingsFormatVersion = 3;
	}

	private syncArrayLengths() {
		// garante enabled/comments alinhados ao min(patterns, replacers)
		const n = Math.min(this.settings.patterns.length, this.settings.replacers.length);
		if (!Array.isArray(this.settings.enabled)) this.settings.enabled = [];
		if (!Array.isArray(this.settings.comments)) this.settings.comments = [];

		for (let i = this.settings.enabled.length; i < n; i++) this.settings.enabled[i] = true;
		for (let i = this.settings.comments.length; i < n; i++) this.settings.comments[i] = "";

		this.settings.enabled = this.settings.enabled.slice(0, n);
		this.settings.comments = this.settings.comments.slice(0, n);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.migrateSettingsIfNeeded(this.settings);
		this.compileRules();
	}

	compileRules() {
		this.rules = [];
		const n = Math.min(this.settings.patterns.length, this.settings.replacers.length);
		for (let i = 0; i < n; i++) {
			if (this.settings.enabled[i] !== false) {
				this.rules.push(new ReplaceRule(this.settings.patterns[i], this.settings.replacers[i]));
			}
		}
	}

	async saveSettings() {
		this.syncArrayLengths();
		await this.saveData(this.settings);
	}

	// ---------------- transform ----------------

	public applyRules(source: string | null | undefined): string {
		if (source == null) return "";
		let result = source;
		for (const rule of this.rules) {
			if (source.search(rule.pattern) != -1) {
				result = source.replace(rule.pattern, rule.replacer);
				break;
			}
		}
		return result;
	}
}

// ============================================================================

class PasteTransformSettingsTab extends PluginSettingTab {
	plugin: PasteTransform;

	constructor(app: App, plugin: PasteTransform) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		let patternsTa: TextAreaComponent | null = null;
		let replacersTa: TextAreaComponent | null = null;
		let trySource: TextAreaComponent | null = null;
		let tryDest: TextAreaComponent | null = null;

		const plugin = this.plugin;

		const handleChanges = () => {
			try {
				tryDest?.setValue(plugin.applyRules(trySource?.getValue()));
			} catch (e) {
				tryDest?.setValue("ERROR:\n" + e);
			}
		};

		const handleTextChange = async (value: string, setAttr: (values: string[]) => any) => {
			const values = value.split("\n");
			if (values.length > 0 && values.last() == "") values.pop();

			setAttr(values);

			try {
				plugin.syncArrayLengths(); // alinhar enabled/comments quando linhas mudam
				plugin.compileRules();
				handleChanges();
				await plugin.saveSettings();
				renderRuleList();          // re-renderiza toggles + comentários
			} catch (e) {
				tryDest?.setValue("ERROR:\n" + e);
			}
		};

		// --- Patterns (textarea)
		new Setting(containerEl)
			.setName("Transform rules — Patterns (regex)")
			.setDesc("Digite uma regex por linha. Índices alinham com Replace rules.")
			.addTextArea((ta) => {
				patternsTa = ta;
				patternsTa.setPlaceholder("pattern 1\npattern 2\n");
				patternsTa.setValue(this.plugin.settings.patterns.join("\n"));
				patternsTa.onChange(async (value) => {
					await handleTextChange(value, (values) => {
						plugin.settings.patterns = values;
					});
				});
			});

		// --- Replacers (textarea)
		new Setting(containerEl)
			.setName("Transform rules — Replace rules")
			.setDesc("Digite um replacer por linha. Alinha por índice com Patterns.")
			.addTextArea((ta) => {
				replacersTa = ta;
				replacersTa.setPlaceholder("replacer 1\nreplacer 2\n");
				replacersTa.setValue(this.plugin.settings.replacers.join("\n"));
				replacersTa.onChange(async (value) => {
					await handleTextChange(value, (values) => {
						plugin.settings.replacers = values;
					});
				});
			});

		// --- Lista de Regras: toggle + comentário por regra
		const ruleSection = containerEl.createEl("div");
		ruleSection.createEl("h4", { text: "Enable/disable por regra + Comentário" });

		const renderRuleList = () => {
			ruleSection.querySelectorAll(".pte-rule-row").forEach((el) => el.remove());

			const n = Math.min(plugin.settings.patterns.length, plugin.settings.replacers.length);
			for (let i = 0; i < n; i++) {
				// Linha 1: toggle + preview
				const row = ruleSection.createDiv({ cls: "pte-rule-row" });
				new Setting(row)
					.setName(`Regra ${i + 1}`)
					.setDesc(
						plugin.settings.patterns[i]
							? `/${plugin.settings.patterns[i]}/  →  "${plugin.settings.replacers[i] ?? ""}"`
							: "(linha vazia)"
					)
					.addToggle((toggle) => {
						toggle.setValue(plugin.settings.enabled[i] !== false);
						toggle.onChange(async (value) => {
							plugin.settings.enabled[i] = value;
							await plugin.saveSettings();
							plugin.compileRules();
							handleChanges();
						});
					});

				// Linha 2: comentário (embaixo do label)
				new Setting(row)
					.setName("") // sem título, fica como sublinha
					.setDesc("Comentário (opcional) sobre o que esta regra faz")
					.addText((inp) => {
						inp.setPlaceholder("Explique a finalidade desta regex…");
						inp.setValue(plugin.settings.comments[i] ?? "");
						inp.onChange(async (v) => {
							plugin.settings.comments[i] = v;
							await plugin.saveSettings();
						});
					});
			}
		};
		renderRuleList();

		// --- Teste das regras
		new Setting(containerEl)
			.setName("Try rules")
			.setDesc("Write original text here")
			.addTextArea((ta) => {
				trySource = ta;
				ta.setPlaceholder("Sample text");
				ta.onChange((_v) => handleChanges());
			});

		new Setting(containerEl)
			.setName("Result")
			.setDesc("The result of rules apply to original text")
			.addTextArea((ta) => {
				tryDest = ta;
				ta.setPlaceholder("Transform result");
				ta.setDisabled(true);
			});

		// --- Debug
		new Setting(containerEl)
			.setName("Debug mode")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.debugMode);
				toggle.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
