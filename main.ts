/* main.ts — Paste Transform (N×N) com Hotkey de Toggle, Status Bar e UI completa
 * Pronto para colar no VS Code — da primeira à última linha.
 */

import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TextAreaComponent,
  Notice,
  MarkdownView,
} from 'obsidian';

/** ===== Modelo N×N ===== */
type Id = string;
interface PatternItem { id: Id; text: string; }
interface ReplacerItem { id: Id; text: string; }
interface LinkItem {
  id: Id;
  patternId: Id;
  replacerId: Id;
  enabled: boolean;
  comment?: string;
}

/** ===== Settings ===== */
interface PasteTransformSettings {
  patterns: PatternItem[] | string[];
  replacers: ReplacerItem[] | string[];
  links?: LinkItem[];
  enabled?: boolean[];   // legado
  comments?: string[];   // legado
  settingsFormatVersion: number;
  debugMode: boolean;
  /** Ativo/Desativado (controlado por hotkey, status bar e settings) */
  active: boolean;
}

/** ===== Defaults ===== */
function uid(prefix = 'id'): Id {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_SETTINGS: PasteTransformSettings = {
  patterns: [
    { id: uid('p'), text: "^https://github.com/[^/]+/([^/]+)/issues/(\\d+)$" },
    { id: uid('p'), text: "^https://github.com/[^/]+/([^/]+)/pull/(\\d+)$" },
    { id: uid('p'), text: "^https://github.com/[^/]+/([^/]+)$" },
    { id: uid('p'), text: "^https://\\w+.wikipedia.org/wiki/([^\\s]+)$" },
  ],
  replacers: [
    { id: uid('r'), text: "[🐈‍⬛🔨 $1#$2]($&)" },
    { id: uid('r'), text: "[🐈‍⬛🛠︎ $1#$2]($&)" },
    { id: uid('r'), text: "[🐈‍⬛ $1]($&)" },
    { id: uid('r'), text: "[📖 $1]($&)" },
  ],
  links: [],
  settingsFormatVersion: 300,
  debugMode: false,
  active: true,
};

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
  private patternMap = new Map<Id, string>();
  private replacerMap = new Map<Id, string>();
  private statusEl?: HTMLElement;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PasteTransformSettingsTab(this.app, this));

    // Evento de paste
    this.registerEvent(this.app.workspace.on("editor-paste", (event) => this.onPaste(event)));

    // Comando para Hotkeys
    this.addCommand({
      id: 'paste-transform-toggle-active',
      name: 'Toggle Paste Transform (enable/disable)',
      callback: () => this.toggleActive(),
      // hotkey default opcional — você pode remover e configurar só pelas Hotkeys
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'P' }],
    });

    // Status bar clicável
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    this.statusEl.addEventListener('click', () => this.toggleActive());
    this.updateStatusEl();
  }

  onunload() {
    // Nada específico além do cleanup padrão do Obsidian
  }

  onPaste(event: ClipboardEvent) {
    // Respeita o estado ativo
    if (!this.settings.active) return;

    if (event.defaultPrevented) {
      if (this.settings.debugMode) console.log("Event already prevented.");
      return;
    }
    const types = event.clipboardData?.types;
    if (!types || types.length !== 1 || types[0] !== "text/plain") return;

    const plainText = event.clipboardData?.getData("text/plain");
    if (!plainText) return;

    const result = this.applyRules(plainText);
    if (result !== plainText) {
      // Tenta via MarkdownView (mais robusto)
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.editor) {
        view.editor.replaceSelection(result);
        event.preventDefault();
        return;
      }
      // Fallback para API nova (se disponível)
      // @ts-expect-error - activeEditor pode não existir em versões antigas
      const ed = this.app.workspace.activeEditor?.editor;
      if (ed?.replaceSelection) {
        ed.replaceSelection(result);
        event.preventDefault();
      }
    }
  }

  /** Migração v1(1×1) → v300(N×N) */
  private migrateIfNeeded(s: PasteTransformSettings) {
    const looksNew =
      Array.isArray(s.patterns) &&
      (s.patterns as any[]).length > 0 &&
      typeof (s.patterns as any[])[0] === 'object' &&
      Array.isArray(s.replacers);

    if (looksNew) {
      (s.patterns as any[]).forEach((p: any) => { if (!p.id) p.id = uid('p'); });
      (s.replacers as any[]).forEach((r: any) => { if (!r.id) r.id = uid('r'); });
      if (!Array.isArray(s.links)) s.links = [];
      s.settingsFormatVersion = 300;
      return;
    }

    const oldPatterns = Array.isArray(s.patterns) ? (s.patterns as string[]) : [];
    const oldReplacers = Array.isArray(s.replacers) ? (s.replacers as string[]) : [];

    const patterns: PatternItem[] = oldPatterns.map(t => ({ id: uid('p'), text: t }));
    const replacers: ReplacerItem[] = oldReplacers.map(t => ({ id: uid('r'), text: t }));

    const n = Math.min(patterns.length, replacers.length);
    const links: LinkItem[] = [];
    for (let i = 0; i < n; i++) {
      const enabled = Array.isArray(s.enabled) && typeof s.enabled[i] === 'boolean' ? !!s.enabled[i] : true;
      const comment = Array.isArray(s.comments) && typeof s.comments[i] === 'string' ? s.comments[i] : "";
      links.push({ id: uid('link'), patternId: patterns[i].id, replacerId: replacers[i].id, enabled, comment });
    }

    s.patterns = patterns;
    s.replacers = replacers;
    s.links = links;
    s.settingsFormatVersion = 300;
    delete (s as any).enabled;
    delete (s as any).comments;
  }

  private normalizeDefaultsIfEmpty(s: PasteTransformSettings) {
    if (!Array.isArray(s.links) || s.links.length === 0) {
      const ps = s.patterns as PatternItem[];
      const rs = s.replacers as ReplacerItem[];
      const n = Math.min(ps.length, rs.length);
      s.links = [];
      for (let i = 0; i < n; i++) {
        s.links.push({ id: uid('link'), patternId: ps[i].id, replacerId: rs[i].id, enabled: true, comment: "" });
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.migrateIfNeeded(this.settings);
    this.normalizeDefaultsIfEmpty(this.settings);
    this.compileRules();
  }

  async saveSettings() { await this.saveData(this.settings); }

  compileRules() {
    this.rules = [];
    this.patternMap.clear();
    this.replacerMap.clear();

    const patterns = this.settings.patterns as PatternItem[];
    const replacers = this.settings.replacers as ReplacerItem[];
    for (const p of patterns) this.patternMap.set(p.id, p.text);
    for (const r of replacers) this.replacerMap.set(r.id, r.text);

    for (const L of this.settings.links || []) {
      if (!L.enabled) continue;
      const p = this.patternMap.get(L.patternId);
      const r = this.replacerMap.get(L.replacerId);
      if (typeof p !== 'string' || typeof r !== 'string') continue;
      try { this.rules.push(new ReplaceRule(p, r)); }
      catch (e) { /* ignora inválidas */ }
    }
  }

  applyRules(source: string | null | undefined): string {
    if (source == null) return "";
    let result = source;
    for (const rule of this.rules) {
      if (source.search(rule.pattern) !== -1) {
        result = source.replace(rule.pattern, rule.replacer);
        break;
      }
    }
    return result;
  }

  /** Toggle global (hotkey, status bar, settings) */
  async toggleActive(force?: boolean) {
    const next = force ?? !this.settings.active;
    this.settings.active = next;
    await this.saveSettings();
    this.compileRules();
    this.updateStatusEl();
    new Notice(`Paste Transform ${next ? 'ativado' : 'desativado'}`);
  }

  private updateStatusEl() {
    if (!this.statusEl) return;
    this.statusEl.setText(this.settings.active ? 'PT: ON' : 'PT: OFF');
    this.statusEl.setAttribute(
      'aria-label',
      this.settings.active ? 'Paste Transform ativo — clique para desativar' : 'Paste Transform desativado — clique para ativar'
    );
  }
}

/** =====================  UI / Settings  ===================== */

class PasteTransformSettingsTab extends PluginSettingTab {
  plugin: PasteTransform;

  constructor(app: App, plugin: PasteTransform) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // CSS
    const STYLE_ID = "pte-2col-style";
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.pte-root{ border:1px solid var(--background-modifier-border); border-radius:12px; padding:12px; }
.pte-hdr{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; gap: 8px; }
.pte-ttl{ margin:0; font-weight:700; }
.pte-stage{ position:relative; display:grid; grid-template-columns:1fr 1fr; gap:12px; min-height:160px; }
.pte-col{ background:var(--background-primary-alt); border:1px solid var(--background-modifier-border); border-radius:10px; padding:10px; }
.pte-col-head{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:6px; gap: 8px; }
.pte-col-title{ margin:0; font-weight:700; }
.pte-count{ color:var(--text-muted); }
.pte-form{ display:flex; gap:8px; margin-bottom:8px; }
.pte-inp{ flex:1; border:1px solid var(--background-modifier-border); border-radius:10px; padding:6px 10px; }
.pte-list{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.pte-item{ display:grid; grid-template-columns:28px 1fr auto auto auto; gap:6px; align-items:center;
  background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:10px; padding:6px 8px; }
.pte-txt{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pte-btn{ border:1px solid var(--background-modifier-border); border-radius:8px; padding:4px 8px; background:var(--background-primary-alt); cursor:pointer; }
.pte-btn.ghost{ background:transparent; }
.pte-btn.danger{ border-color:#c44a4a80; }
.pte-pending{ outline:2px dashed var(--interactive-accent); outline-offset:2px; }
.pte-layer{ position:absolute; inset:0; pointer-events:none; }
.pte-svg{ width:100%; height:100%; display:block; }
.pte-xwrap{ position:absolute; inset:0; pointer-events:none; }
.pte-xh{ position:absolute; width:24px; height:24px; border-radius:999px; transform:translate(-50%,-50%); pointer-events:auto; border:1px solid var(--background-modifier-border); background:var(--background-secondary); }
.pte-xh-top{ clip-path: inset(0 0 50% 0 round 999px); }
.pte-xh-bot{ clip-path: inset(50% 0 0 0 round 999px); }
.pte-xh span{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); font-size:.8em; }
.pte-xh-bot.enabled{ background:var(--interactive-accent); color:var(--text-on-accent,#fff); }
.pte-links-mini{ grid-column: 1 / -1; margin-top:4px; display:flex; flex-wrap:wrap; gap:4px; }
.pte-mini{ display:inline-flex; align-items:center; gap:6px; border:1px solid var(--background-modifier-border); border-radius:999px; padding:2px 8px; background:var(--background-primary); }
.pte-mini input{ margin:0; }
.pte-links-panel{ margin-top: 12px; }
@media (max-width:800px){ .pte-stage{ grid-template-columns:1fr; } }
      `;
      document.head.appendChild(style);
    }

    // Header
    const root = containerEl.createDiv({ cls: "pte-root" });
    const hdr = root.createDiv({ cls: "pte-hdr" });
    hdr.createEl("h3", { text: "Paste Transform — Regras N×N", cls: "pte-ttl" });

    // Toggle global (ativo/desativado)
    new Setting(hdr)
      .setName('Ativo')
      .setDesc('Quando desativado, o plugin ignora o evento de colar.')
      .addToggle(t => {
        t.setValue(this.plugin.settings.active);
        t.onChange(async v => { await this.plugin.toggleActive(v); });
      });

    hdr.createEl("span", {
      text: "Clique em 🔗 para selecionar um lado e depois no outro item para ligar. Botão no meio da linha: ✕ (topo) remove, ✓ (baixo) habilita/desabilita.",
    });

    // Stage + layers
    const stage = root.createDiv({ cls: "pte-stage" });
    const layer = stage.createDiv({ cls: "pte-layer" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("pte-svg");
    layer.appendChild(svg);
    const xwrap = stage.createDiv({ cls: "pte-xwrap" });

    let pending: null | { side: 'left' | 'right'; id: Id } = null;

    const buildColumn = (side: 'left' | 'right', title: string) => {
      const wrap = stage.createDiv({ cls: "pte-col" });
      const head = wrap.createDiv({ cls: "pte-col-head" });
      head.createEl("h4", { text: title, cls: "pte-col-title" });
      const count = head.createEl("span", { text: "(0)", cls: "pte-count" });

      const form = wrap.createEl("form", { cls: "pte-form" });
      const inp = form.createEl("input", { type: "text", placeholder: "Novo item…", cls: "pte-inp" });
      form.createEl("button", { type: "submit", text: "Adicionar", cls: "pte-btn" });
      const list = wrap.createEl("ul", { cls: "pte-list" });

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = (inp.value || "").trim();
        if (!v) return;
        if (side === 'left') (this.plugin.settings.patterns as PatternItem[]).push({ id: uid('p'), text: v });
        else (this.plugin.settings.replacers as ReplacerItem[]).push({ id: uid('r'), text: v });
        inp.value = "";
        await this.plugin.saveSettings();
        this.plugin.compileRules();
        render();
      });

      return { wrap, count, list };
    };

    const left = buildColumn('left', 'Patterns (regex)');
    const right = buildColumn('right', 'Replace rules');

    const clearNode = (n: Element | SVGElement) => { while (n.firstChild) n.removeChild(n.firstChild); };
    const getArrays = () => {
      const patterns = this.plugin.settings.patterns as PatternItem[];
      const replacers = this.plugin.settings.replacers as ReplacerItem[];
      const links = this.plugin.settings.links as LinkItem[];
      return { patterns, replacers, links };
    };

    const saveDebounced = debounce(async () => {
      await this.plugin.saveSettings();
      this.plugin.compileRules();
    }, 250);

    const renderColumn = (side: 'left' | 'right') => {
      const { patterns, replacers } = getArrays();
      const arr = side === 'left' ? patterns : replacers;
      const view = side === 'left' ? left : right;

      view.count.textContent = `(${arr.length})`;
      clearNode(view.list);

      for (const item of arr) {
        const li = view.list.createEl("li", { cls: "pte-item" });
        li.setAttribute("data-id", item.id);

        const handle = li.createEl("button", { text: "↕️", title: "Arrastar (disabled)", cls: "pte-btn ghost" });
        const text = li.createEl("span", { text: item.text, title: item.text, cls: "pte-txt" });
        const linkBtn = li.createEl("button", { text: "🔗", title: "Criar ligação com item da outra coluna", cls: "pte-btn" });
        const editBtn = li.createEl("button", { text: "✏️", title: "Editar", cls: "pte-btn" });
        const delBtn  = li.createEl("button", { text: "🗑️", title: "Excluir", cls: "pte-btn danger" });

        // editar inline
        const activateEdit = () => {
          if (li.classList.contains("editing")) return;
          li.classList.add("editing");
          const input = li.createEl("input", { type: "text", value: item.text, cls: "pte-inp" });
          text.replaceWith(input);
          input.focus(); input.select();
          const commit = async () => {
            const nv = (input.value || "").trim();
            if (!nv) { cancel(); return; }
            (item as any).text = nv;
            await this.plugin.saveSettings();
            this.plugin.compileRules();
            render();
          };
          const cancel = () => { input.replaceWith(text); li.classList.remove("editing"); };
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") cancel(); });
          input.addEventListener("blur", commit);
        };
        editBtn.addEventListener("click", activateEdit);
        text.addEventListener("dblclick", activateEdit);

        // excluir item (e links)
        delBtn.addEventListener("click", async () => {
          if (side === 'left') {
            const ps = this.plugin.settings.patterns as PatternItem[];
            const i = ps.findIndex(p => p.id === item.id);
            if (i >= 0) ps.splice(i, 1);
            this.plugin.settings.links = (this.plugin.settings.links || []).filter(L => L.patternId !== item.id);
          } else {
            const rs = this.plugin.settings.replacers as ReplacerItem[];
            const i = rs.findIndex(r => r.id === item.id);
            if (i >= 0) rs.splice(i, 1);
            this.plugin.settings.links = (this.plugin.settings.links || []).filter(L => L.replacerId !== item.id);
          }
          await this.plugin.saveSettings();
          this.plugin.compileRules();
          render();
        });

        // criar link
        linkBtn.addEventListener("click", () => {
          if (!pending) {
            pending = { side, id: item.id };
            li.classList.add("pte-pending");
          } else if (pending.side === side) {
            const prev = (side === 'left' ? left.list : right.list).querySelector(`li[data-id="${pending.id}"]`) as HTMLElement | null;
            prev?.classList.remove("pte-pending");
            pending = { side, id: item.id };
            li.classList.add("pte-pending");
          } else {
            // cruzar lados
            const a = pending.side === 'left' ? pending.id : item.id;
            const b = pending.side === 'right' ? pending.id : item.id;
            const leftIds = new Set((this.plugin.settings.patterns as PatternItem[]).map(p => p.id));
            let pId = a, rId = b;
            if (!leftIds.has(pId)) { pId = b; rId = a; }

            const links = this.plugin.settings.links as LinkItem[];
            if (!links.some(L => L.patternId === pId && L.replacerId === rId)) {
              links.push({ id: uid('link'), patternId: pId, replacerId: rId, enabled: true, comment: "" });
              saveDebounced();
            }
            (stage.querySelectorAll('.pte-pending') as NodeListOf<Element>).forEach(n => n.classList.remove('pte-pending'));
            pending = null;
            drawLines();
            renderMiniLinksForAll();
          }
        });

        handle.addEventListener("click", (e) => e.preventDefault());

        // ---- Mini-links (enable/disable) neste item ----
        const mini = li.createDiv({ cls: "pte-links-mini" });
        const renderMini = () => {
          mini.empty();
          const all = (this.plugin.settings.links || []).filter(L =>
            side === 'left' ? L.patternId === item.id : L.replacerId === item.id
          );
          const { patterns, replacers } = getArrays();
          const pMap = new Map(patterns.map(p => [p.id, p.text]));
          const rMap = new Map(replacers.map(r => [r.id, r.text]));
          for (const L of all) {
            const label = mini.createDiv({ cls: "pte-mini" });
            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = L.enabled !== false;
            chk.addEventListener("change", async () => {
              L.enabled = chk.checked;
              await this.plugin.saveSettings();
              this.plugin.compileRules();
              drawLines();
            });
            label.appendChild(chk);
            const otherTxt = side === 'left' ? (rMap.get(L.replacerId) || "?") : (pMap.get(L.patternId) || "?");
            label.createSpan({ text: otherTxt });
          }
          if (all.length === 0) {
            mini.createSpan({ text: "Sem ligações", cls: "pte-muted" });
          }
        };
        (li as any)._renderMini = renderMini; // guardamos pra atualizar depois
        renderMini();
      }
    };

    const renderMiniLinksForAll = () => {
      stage.querySelectorAll(".pte-item").forEach((li: any) => {
        if (typeof li._renderMini === 'function') li._renderMini();
      });
    };

    const drawLines = () => {
      const { patterns, replacers, links } = getArrays();
      const leftMap = new Map(patterns.map(p => [p.id, left.list.querySelector(`li[data-id="${p.id}"]`) as HTMLElement]));
      const rightMap = new Map(replacers.map(r => [r.id, right.list.querySelector(`li[data-id="${r.id}"]`) as HTMLElement]));

      const stageRect = stage.getBoundingClientRect();
      clearNode(svg);
      clearNode(xwrap);

      for (const L of links) {
        const a = leftMap.get(L.patternId);
        const b = rightMap.get(L.replacerId);
        if (!a || !b) continue;

        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();

        const x1 = ar.right - stageRect.left;
        const y1 = ar.top + ar.height / 2 - stageRect.top;
        const x2 = br.left - stageRect.left;
        const y2 = br.top + br.height / 2 - stageRect.top;
        const dx = Math.max(40, (x2 - x1) * 0.5);

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", L.enabled ? "var(--interactive-accent)" : "var(--text-muted)");
        path.setAttribute("stroke-width", L.enabled ? "2" : "1.5");
        path.setAttribute("opacity", L.enabled ? "0.95" : "0.45");
        path.style.pointerEvents = "none";
        svg.appendChild(path);

        // botão dividido: topo = remover ✕, baixo = toggle ✓
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;

        const topBtn = xwrap.createDiv({ cls: "pte-xh pte-xh-top" });
        (topBtn as HTMLElement).style.left = `${mx}px`;
        (topBtn as HTMLElement).style.top  = `${my}px`;
        topBtn.createSpan({ text: "✕" });
        topBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          this.plugin.settings.links = (this.plugin.settings.links || []).filter(K => K.id !== L.id);
          await this.plugin.saveSettings();
          this.plugin.compileRules();
          render();
        });

        const botBtn = xwrap.createDiv({ cls: `pte-xh pte-xh-bot ${L.enabled ? 'enabled' : ''}` });
        (botBtn as HTMLElement).style.left = `${mx}px`;
        (botBtn as HTMLElement).style.top  = `${my}px`;
        botBtn.createSpan({ text: "✓" });
        botBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          L.enabled = !L.enabled;
          await this.plugin.saveSettings();
          this.plugin.compileRules();
          drawLines();
          renderMiniLinksForAll();
        });
      }
    };

    const renderLinksPanel = () => {
      const prev = root.querySelector(".pte-links-panel");
      if (prev) prev.remove();

      const panel = root.createDiv({ cls: "pte-links-panel" });
      panel.createEl("h4", { text: "Ligações (sumário + comentário)" });

      const table = panel.createEl("div");
      const { patterns, replacers, links } = getArrays();
      const pMap = new Map(patterns.map(p => [p.id, p.text]));
      const rMap = new Map(replacers.map(r => [r.id, r.text]));

      (links || []).forEach((L, idx) => {
        const row = table.createDiv({ cls: "pte-link-row" });
        const status = L.enabled !== false ? "habilitada" : "desabilitada";
        new Setting(row)
          .setName(`Regra #${idx + 1} — ${status}`)
          .setDesc(`/${pMap.get(L.patternId) || "?"}/ → "${rMap.get(L.replacerId) || "?"}"`);

        new Setting(row)
          .setName("")
          .setDesc("Comentário (opcional)")
          .addText(inp => {
            inp.setPlaceholder("Explique a finalidade desta regra…");
            inp.setValue(L.comment || "");
            inp.onChange(async v => { L.comment = v; await this.plugin.saveSettings(); });
          });
      });
    };

    const render = () => {
      renderColumn('left');
      renderColumn('right');
      setTimeout(() => { drawLines(); }, 30);
      renderLinksPanel();
    };

    const on = debounce(() => drawLines(), 50);
    window.addEventListener("resize", on);
    document.addEventListener("scroll", on, true);

    // Try/Result
    new Setting(root)
      .setName("Try rules")
      .setDesc("Cole aqui um texto para testar as regras.")
      .addTextArea(ta => {
        ta.setPlaceholder("Sample text…");
        ta.onChange(v => { const out = this.plugin.applyRules(v); tryDest?.setValue(out); });
      });

    let tryDest: TextAreaComponent | null = null;
    new Setting(root)
      .setName("Result")
      .setDesc("Resultado da transformação")
      .addTextArea(ta => { tryDest = ta; ta.setPlaceholder("Transform result…"); ta.setDisabled(true); });

    new Setting(root)
      .setName("Debug mode")
      .addToggle(t => {
        t.setValue(this.plugin.settings.debugMode);
        t.onChange(async v => { this.plugin.settings.debugMode = v; await this.plugin.saveSettings(); });
      });

    render();

    function debounce<T extends (...args: any[]) => any>(fn: T, wait = 250) {
      let t: number | null = null as any;
      return (...args: Parameters<T>) => { if (t) window.clearTimeout(t); t = window.setTimeout(() => fn(...args), wait); };
    }
  }
}
