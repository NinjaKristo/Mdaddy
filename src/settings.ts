// Settings dialog (⚙) and the welcome screen.
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { APP_ASSETS } from "./assets";
import {
  allCommands, conflictsFor, isBindable, keyFor, keyOf, replaceKeys, resetAllKeys, setKey, suspendShortcuts, onKeysChanged,
} from "./commands";

export interface SendTarget { id: string; name: string; program: string; args: string; builtin?: boolean; enabled: boolean; }
export interface FavoritePath { id: string; category: string; label: string; path: string; scope: "children" | "folder" | "off"; }
export interface AiConfig {
  shelfRoot: string; ollamaUrl: string; hfUrl: string; unslothUrl: string; freetokenUrl: string;
  claudePath: string; codexPath: string; claudeModel: string; codexModel: string;
}

export interface SettingsCtx {
  prefGet(k: string): string | null;
  prefSet(k: string, v: string): void;
  showToast(msg: string, kind?: "info" | "danger" | "success"): void;
  applyToolbarSize(px: number): void;
  applySidebarWidth(px: number): void;
  systemPromptPreview(): string;
}

export const PREF = {
  welcomeHide: "mdaddy-welcome-hide",
  instanceDefault: "mdaddy-instance-default",
  appearanceColors: "mdaddy-appearance-colors",
  favorites: "mdaddy-favorites-v1",
  toolbarSize: "mdaddy-toolbar-size",
  headingDragSpeed: "mdaddy-heading-drag-speed",
  pageMargin: "mdaddy-page-margin",
  sidebarWidth: "mded-outline-w-v2",
  imageDir: "mdaddy-image-dir",
  sendTargets: "mdaddy-send-targets",
  ahkSettings: "mdaddy-ahk-settings",
  ai: "mdaddy-ai",
};

export const DEFAULT_TOOLBAR_SIZE = 14;
export const DEFAULT_SIDEBAR_WIDTH = 160;

export const DEFAULT_SEND_TARGETS: SendTarget[] = [
  { id: "obsidian", name: "Obsidian", program: "obsidian", args: "", builtin: true, enabled: true },
  { id: "vscode", name: "VS Code", program: "vscode", args: "{file}", builtin: true, enabled: true },
  { id: "firefox", name: "Firefox", program: "firefox", args: "{html}", builtin: true, enabled: true },
];

export const DEFAULT_AI: AiConfig = {
  shelfRoot: "", ollamaUrl: "http://localhost:11434", hfUrl: "http://localhost:1234/v1",
  unslothUrl: "http://localhost:1234/v1", freetokenUrl: "http://localhost:1234/v1",
  claudePath: "", codexPath: "", claudeModel: "", codexModel: "",
};

let ctx: SettingsCtx;

const APPEARANCE_COLORS: [string, string, string][] = [
  ["Dropdown menus", "--mdaddy-menu-color", "#1fa491"],
  ["Open tab", "--mdaddy-open-tab-color", "#002fa7"],
  ["Unsaved tab X", "--mdaddy-unsaved-tab-color", "#d32626"],
  ["Outline / Files selection", "--mdaddy-outline-files-color", "#002fa7"],
  ["Markdown file names", "--mdaddy-md-file-color", "#002fa7"],
  ["Other file names", "--mdaddy-other-file-color", "#85878f"],
  ["Folder names", "--mdaddy-folder-name-color", "#30343a"],
  ["App background", "--canvas", "#ffffff"],
  ["Sidebar background", "--surface", "#fafafb"],
  ["Menus and dialogs", "--surface-raised", "#ffffff"],
  ["Hover background", "--surface-hover", "#f2f3f5"],
  ["Main text", "--text-primary", "#16181d"],
  ["Secondary text", "--text-secondary", "#3e4048"],
  ["Muted text", "--text-tertiary", "#6e7078"],
  ["Accent", "--accent", "#1fa491"],
  ["Borders", "--border-subtle", "#ebebee"],
  ["Heading 1", "--mdaddy-heading-1-color", "#16181d"], ["Heading 2", "--mdaddy-heading-2-color", "#16181d"],
  ["Heading 3", "--mdaddy-heading-3-color", "#3e4048"], ["Heading 4", "--mdaddy-heading-4-color", "#3e4048"],
  ["Heading 5", "--mdaddy-heading-5-color", "#6e7078"], ["Heading 6", "--mdaddy-heading-6-color", "#6e7078"],
];

function readAppearanceColors(): Record<string, string> {
  try {
    const parsed = JSON.parse(ctx.prefGet(PREF.appearanceColors) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch { /* invalid old value is ignored */ }
  return {};
}

function applyAppearanceColors(colors = readAppearanceColors()): void {
  const root = document.documentElement;
  for (const [, token] of APPEARANCE_COLORS) {
    const value = colors[token];
    if (typeof value === "string" && CSS.supports("color", value)) root.style.setProperty(token, value);
    else root.style.removeProperty(token);
  }
}

export function loadSendTargets(): SendTarget[] {
  try {
    const v = JSON.parse(ctx.prefGet(PREF.sendTargets) || "null");
    if (Array.isArray(v)) {
      const safe = v.filter((t: SendTarget) => !/wechat|weixin|zhihu/i.test(`${t.id} ${t.name} ${t.program}`));
      if (safe.length !== v.length) ctx.prefSet(PREF.sendTargets, JSON.stringify(safe));
      // make sure built-ins stay present even after edits
      const ids = new Set(safe.map((t: SendTarget) => t.id));
      return [...DEFAULT_SEND_TARGETS.filter((d) => !ids.has(d.id)), ...safe];
    }
  } catch { /* fall through */ }
  return DEFAULT_SEND_TARGETS.map((t) => ({ ...t }));
}
function saveSendTargets(list: SendTarget[]): void {
  ctx.prefSet(PREF.sendTargets, JSON.stringify(list));
  document.dispatchEvent(new CustomEvent("mdaddy:send-targets-changed"));
}

export function loadAiConfig(): AiConfig {
  try { return { ...DEFAULT_AI, ...JSON.parse(ctx.prefGet(PREF.ai) || "{}") }; } catch { return { ...DEFAULT_AI }; }
}
function saveAiConfig(c: AiConfig): void {
  ctx.prefSet(PREF.ai, JSON.stringify(c));
  document.dispatchEvent(new CustomEvent("mdaddy:ai-config-changed"));
}

export function imageDirSetting(): string {
  return ctx.prefGet(PREF.imageDir) || "embed";
}

export function toolbarSize(): number {
  const n = parseInt(ctx.prefGet(PREF.toolbarSize) || "", 10);
  return isNaN(n) ? DEFAULT_TOOLBAR_SIZE : Math.min(24, Math.max(10, n));
}
export function pageMargin(): number {
  const n = parseInt(ctx.prefGet(PREF.pageMargin) || "", 10);
  return isNaN(n) ? 96 : Math.min(180, Math.max(24, n));
}
export function headingDragSpeed(): number {
  const n = parseInt(ctx.prefGet(PREF.headingDragSpeed) || "", 10);
  return isNaN(n) ? 360 : Math.min(900, Math.max(100, n));
}
export function sidebarWidth(): number {
  const n = parseInt(ctx.prefGet(PREF.sidebarWidth) || "", 10);
  return isNaN(n) ? DEFAULT_SIDEBAR_WIDTH : n;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v; else if (k === "text") el.textContent = v; else el.setAttribute(k, v);
  }
  for (const k of kids) el.append(k);
  return el;
}

// ---------- shortcuts table (shared by settings and welcome) ----------
function groupedCommands() {
  const groups = new Map<string, ReturnType<typeof allCommands>>();
  for (const c of allCommands()) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }
  return groups;
}

const WELCOME_GROUP_ORDER = ["File", "View", "Export", "Edit", "Format", "Send", "AI", "App"];

/** Shortcut list for the Shortcut Screen: one flowing list, laid out in 4 columns by CSS. */
function shortcutKeys(): HTMLElement {
  const wrap = h("div", { class: "wk-cols" });
  const groups = groupedCommands();
  const names = [...WELCOME_GROUP_ORDER.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !WELCOME_GROUP_ORDER.includes(g))];
  for (const g of names) {
    const rows = groups.get(g)!.filter((c) => keyFor(c.id));
    if (!rows.length) continue;
    wrap.append(h("div", { class: "wk-head", text: g }));
    for (const c of rows) wrap.append(h("div", { class: "wk-row" }, h("span", { class: "wk-label", text: c.label }), h("kbd", { text: keyFor(c.id) })));
  }
  return wrap;
}

export function showShortcutScreen(force = false): void {
  if (!force && ctx.prefGet(PREF.welcomeHide) === "1") return;
  document.getElementById("shortcut-screen")?.remove();
  const brand = h("div", { class: "settings-brand shortcut-screen-brand" });
  const mark = h("button", { type: "button", class: "settings-brand-mark", title: "Show / hide sidebar", "aria-label": "Show / hide sidebar" },
    h("img", { src: APP_ASSETS.logoMark, alt: "" }));
  const wordmark = h("img", { class: "settings-brand-wordmark", src: APP_ASSETS.logoWordmark, alt: "Mdaddy" });
  const menu = h("button", { type: "button", class: "settings-brand-menu", title: "Open Mdaddy menu", "aria-label": "Open Mdaddy menu" },
    h("img", { src: APP_ASSETS.chevron, alt: "" }));
  mark.addEventListener("click", () => document.getElementById("btn-brand-logo")?.click());
  menu.addEventListener("click", () => document.getElementById("btn-brand-menu")?.click());
  brand.append(mark, wordmark, menu);
  const close = h("button", { type: "button", class: "primary shortcut-screen-close", text: "Close" });
  const openSettings = h("button", { type: "button", text: "Settings" });
  const modal = h("div", { id: "shortcut-screen", class: "modal-mask", role: "dialog", "aria-modal": "true", "aria-label": "Keyboard shortcuts" },
    h("div", { class: "modal shortcut-screen-modal" },
      h("div", { class: "shortcut-screen-head" }, brand, h("h2", { text: "Shortcuts" }), close),
      h("div", { class: "shortcut-screen-body" }, shortcutKeys()),
      h("div", { class: "modal-btns shortcut-screen-foot" }, openSettings, h("span", { class: "grow" }), close.cloneNode(true))));
  const shut = () => modal.remove();
  close.addEventListener("click", shut);
  modal.querySelector(".shortcut-screen-foot .shortcut-screen-close")?.addEventListener("click", shut);
  openSettings.addEventListener("click", () => { shut(); openSettingsDialog("shortcuts"); });
  modal.addEventListener("pointerdown", (e) => { if (e.target === modal) shut(); });
  modal.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } });
  document.body.append(modal);
  close.focus();
}

// ---------- settings ----------
type Section = "shortcuts" | "appearance" | "images" | "favorites" | "send" | "ai";
const SECTIONS: [Section, string][] = [
  ["shortcuts", "Shortcuts"], ["appearance", "Appearance"],
  ["images", "Images"], ["favorites", "Favorites"], ["send", "Send to"], ["ai", "AI assistant"],
];

export function loadFavorites(): FavoritePath[] {
  try {
    const parsed = JSON.parse(ctx.prefGet(PREF.favorites) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FavoritePath => item && typeof item.id === "string" && typeof item.category === "string" &&
      typeof item.label === "string" && typeof item.path === "string" && ["children", "folder", "off"].includes(item.scope));
  } catch { return []; }
}

export function saveFavorites(items: FavoritePath[]): void {
  ctx.prefSet(PREF.favorites, JSON.stringify(items));
  document.dispatchEvent(new CustomEvent("mdaddy:favorites-changed"));
}

function sectionFavorites(): HTMLElement {
  const box = h("div");
  const list = h("div", { class: "favorite-settings-list" });
  const modeName = (scope: FavoritePath["scope"]) => scope === "children" ? "Folder + child folders" : scope === "folder" ? "This folder only" : "Hidden";
  const render = () => {
    const items = loadFavorites();
    list.innerHTML = "";
    if (!items.length) list.append(h("p", { class: "hint", text: "No favorite paths yet. Add a folder or file to show it in the Files sidebar." }));
    items.forEach((item) => {
      const label = h("input", { type: "text", value: item.label, title: "Display name" }) as HTMLInputElement;
      const category = h("input", { type: "text", value: item.category, title: "Category label" }) as HTMLInputElement;
      const path = h("input", { type: "text", value: item.path, title: "Folder or file path" }) as HTMLInputElement;
      const saveRow = () => {
        const all = loadFavorites();
        const target = all.find((favorite) => favorite.id === item.id);
        if (!target) return;
        target.label = label.value.trim() || item.label;
        target.category = category.value.trim() || "Favorites";
        target.path = path.value.trim() || item.path;
        saveFavorites(all);
      };
      for (const input of [label, category, path]) input.addEventListener("change", saveRow);
      const scope = h("button", { type: "button", class: "favorite-scope", text: modeName(item.scope), title: "Cycle folder visibility" });
      scope.addEventListener("click", () => {
        const all = loadFavorites(), target = all.find((favorite) => favorite.id === item.id);
        if (!target) return;
        target.scope = target.scope === "children" ? "folder" : target.scope === "folder" ? "off" : "children";
        saveFavorites(all); render();
      });
      const remove = h("button", { type: "button", text: "Remove", title: `Remove ${item.label}` });
      remove.addEventListener("click", () => { saveFavorites(loadFavorites().filter((favorite) => favorite.id !== item.id)); render(); });
      list.append(h("div", { class: "favorite-settings-row" }, label, category, path, scope, remove));
    });
  };
  const category = h("input", { type: "text", placeholder: "Category (e.g. Work)" }) as HTMLInputElement;
  const path = h("input", { type: "text", placeholder: "Choose or enter a folder/file path" }) as HTMLInputElement;
  const browse = h("button", { type: "button", text: "Browse…" });
  browse.addEventListener("click", async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") path.value = selected;
  });
  const add = h("button", { type: "button", class: "primary", text: "+ Add favorite" });
  add.addEventListener("click", () => {
    const value = path.value.trim();
    if (!value) { ctx.showToast("Choose a folder or enter a path first", "danger"); return; }
    const name = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || value;
    const items = loadFavorites();
    items.push({ id: `favorite-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, category: category.value.trim() || "Favorites", label: name, path: value, scope: "children" });
    saveFavorites(items); path.value = ""; render();
  });
  box.append(h("h3", { text: "Favorite folders and files" }),
    h("p", { class: "hint", text: "Favorites appear below the folder tree. Cycle each entry through folder and child folders, this folder only, then hidden. Group them with your own category labels." }),
    list, h("div", { class: "row favorite-add-row" }, category, path, browse, add));
  render();
  return box;
}

function sectionShortcuts(): HTMLElement {
  const box = h("div");
  const show = h("button", { type: "button", text: "Show shortcut screen" });
  show.addEventListener("click", () => { closeSettings(); showShortcutScreen(true); });
  const hide = h("input", { type: "checkbox" }) as HTMLInputElement;
  hide.checked = ctx.prefGet(PREF.welcomeHide) !== "1";
  hide.addEventListener("change", () => ctx.prefSet(PREF.welcomeHide, hide.checked ? "0" : "1"));
  const instanceDefault = h("select") as HTMLSelectElement;
  instanceDefault.append(
    h("option", { value: "new", text: "New instance" }),
    h("option", { value: "open", text: "Open existing instance" }),
  );
  instanceDefault.value = ctx.prefGet(PREF.instanceDefault) || "new";
  instanceDefault.addEventListener("change", () => ctx.prefSet(PREF.instanceDefault, instanceDefault.value));
  box.append(
    h("h3", { text: "Shortcut screen" }),
    h("label", { class: "chk" }, hide, " Show shortcut screen when Mdaddy starts"),
    h("div", { class: "row" }, show),
    h("h3", { text: "When Mdaddy is already open" }),
    h("label", { class: "field" }, h("span", { text: "Default choice" }), instanceDefault),
    h("p", { class: "hint", text: "A second launch asks whether to focus the open window or start a new instance. Enter selects this default." }),
    h("h3", { class: "shortcuts-list-heading", text: "Keyboard shortcuts" }),
  );
  const filter = h("input", { type: "search", class: "shortcuts-filter", placeholder: "Filter shortcuts by name, group, or key…", autocomplete: "off" }) as HTMLInputElement;
  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: "" }) as HTMLInputElement;
  const exportBtn = h("button", { type: "button", text: "Export shortcuts…" });
  const importBtn = h("button", { type: "button", text: "Import shortcuts…" });
  exportBtn.addEventListener("click", async () => {
    const path = await saveDialog({ defaultPath: "Mdaddy-shortcuts.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    const shortcuts = Object.fromEntries(allCommands().filter((command) => !command.fixed).map((command) => [command.id, keyFor(command.id)]));
    try {
      await invoke("write_export_file", { path, content: JSON.stringify({ format: "mdaddy-shortcuts", version: 1, shortcuts }, null, 2) });
      ctx.showToast("Shortcuts exported", "success");
    } catch (error) { ctx.showToast(`Shortcut export failed: ${error}`, "danger"); }
  });
  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { format?: unknown; version?: unknown; shortcuts?: unknown };
      if (parsed?.format !== "mdaddy-shortcuts" || parsed.version !== 1 || !parsed.shortcuts || typeof parsed.shortcuts !== "object" || Array.isArray(parsed.shortcuts)) {
        throw new Error("This file is not a supported Mdaddy shortcuts export.");
      }
      const incoming = parsed.shortcuts as Record<string, unknown>;
      const commands = allCommands();
      const known = new Map(commands.filter((command) => !command.fixed).map((command) => [command.id, command]));
      const proposed = Object.fromEntries(commands.map((command) => [command.id, keyFor(command.id)]));
      for (const [id, value] of Object.entries(incoming)) {
        const command = known.get(id);
        if (!command || typeof value !== "string" || (value !== "" && !isBindable(value))) throw new Error(`Invalid shortcut entry: ${id}`);
        proposed[id] = value;
      }
      const used = new Map<string, string>();
      for (const command of commands) {
        const key = proposed[command.id];
        if (!key) continue;
        const earlier = used.get(key);
        if (earlier) throw new Error(`Duplicate shortcut ${key}: ${earlier} and ${command.label}`);
        used.set(key, command.label);
      }
      replaceKeys(proposed);
      render();
      ctx.showToast("Shortcuts imported", "success");
    } catch (error) { ctx.showToast(`Shortcut import failed: ${error}`, "danger"); }
  });
  box.append(h("div", { class: "row shortcut-tools" }, filter, exportBtn, importBtn), fileInput);
  const reset = h("button", { type: "button", text: "Reset all to defaults" });
  reset.addEventListener("click", () => { resetAllKeys(); render(); });
  box.append(h("div", { class: "row" }, reset));
  const table = h("div", { class: "kb-edit" });
  const render = () => {
    table.innerHTML = "";
    const query = filter.value.trim().toLowerCase();
    for (const [g, cmds] of groupedCommands()) {
      const visible = cmds.filter((command) => !query || `${g} ${command.label} ${command.id} ${keyFor(command.id)}`.toLowerCase().includes(query));
      if (!visible.length) continue;
      table.append(h("h4", { text: g }));
      for (const c of visible) {
        const btn = h("button", { type: "button", class: "kb-capture" + (c.fixed ? " fixed" : ""), text: keyFor(c.id) || "—" });
        if (c.fixed) btn.disabled = true;
        const def = h("button", { type: "button", class: "kb-default", text: "↺" });
        def.dataset.tip = `Default: ${c.defaultKey || "none"}`;
        def.hidden = c.fixed || keyFor(c.id) === c.defaultKey;
        def.addEventListener("click", () => { setKey(c.id, c.defaultKey); render(); });
        btn.addEventListener("click", () => {
          btn.textContent = "Press keys…";
          btn.classList.add("recording");
          suspendShortcuts(true);
          const onKey = (e: KeyboardEvent) => {
            e.preventDefault(); e.stopPropagation();
            if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
            const done = () => { window.removeEventListener("keydown", onKey, true); suspendShortcuts(false); render(); };
            if (e.key === "Escape") return done();
            if (e.key === "Backspace" && !e.ctrlKey && !e.altKey) { setKey(c.id, ""); return done(); }
            const k = keyOf(e);
            if (!isBindable(k)) { btn.textContent = "Needs Ctrl / Alt / F-key"; return; }
            const clash = conflictsFor(k, c.id);
            if (clash.some((x) => x.fixed)) { ctx.showToast(`${k} is reserved for ${clash[0].label}`, "danger"); return done(); }
            for (const x of clash) setKey(x.id, ""); // the newest assignment wins
            if (clash.length) ctx.showToast(`${k} moved from "${clash.map((x) => x.label).join(", ")}"`, "info");
            setKey(c.id, k);
            done();
          };
          window.addEventListener("keydown", onKey, true);
        });
        table.append(h("div", { class: "kb-row" }, h("span", { text: c.label }), h("span", { class: "grow" }), def, btn));
      }
    }
  };
  filter.addEventListener("input", render);
  render();
  box.append(table);
  return box;
}

function slider(label: string, min: number, max: number, val: number, unit: string, on: (v: number) => void): HTMLElement {
  const out = h("span", { class: "val", text: `${val}${unit}` });
  const inp = h("input", { type: "range", min: String(min), max: String(max), step: "1", value: String(val) }) as HTMLInputElement;
  inp.addEventListener("input", () => { const v = parseInt(inp.value, 10); out.textContent = `${v}${unit}`; on(v); });
  return h("label", { class: "slider" }, h("span", { text: label }), inp, out);
}

function sectionAppearance(): HTMLElement {
  const box = h("div", {});
  box.append(
    h("h3", { text: "Toolbar" }),
    slider("Icon size", 10, 24, toolbarSize(), "px", (v) => { ctx.prefSet(PREF.toolbarSize, String(v)); ctx.applyToolbarSize(v); }),
    slider("Writing page side margins", 24, 180, pageMargin(), "px", (v) => {
      ctx.prefSet(PREF.pageMargin, String(v));
      document.documentElement.style.setProperty("--page-side-margin", `${v}px`);
    }),
    h("h3", { text: "Sidebar (Outline / Files)" }),
    slider("Width", 120, 420, sidebarWidth(), "px", (v) => { ctx.prefSet(PREF.sidebarWidth, String(v)); ctx.applySidebarWidth(v); }),
    h("h3", { text: "Heading drag" }),
    slider("Edge scroll speed", 100, 900, headingDragSpeed(), "px/s", (v) => ctx.prefSet(PREF.headingDragSpeed, String(v))),
    h("p", { class: "hint", text: `You can also drag the sidebar edge, or hide it with ${keyFor("view.sidebar")}.` }),
  );
  const colors = readAppearanceColors();
  const rows = h("div", { class: "appearance-color-list" });
  const save = () => {
    ctx.prefSet(PREF.appearanceColors, JSON.stringify(colors));
    applyAppearanceColors(colors);
  };
  for (const [label, token, defaultValue] of APPEARANCE_COLORS) {
    const input = h("input", { type: "color", value: colors[token] || defaultValue, title: `Choose ${label} color` }) as HTMLInputElement;
    input.addEventListener("input", () => { colors[token] = input.value; save(); });
    const row = h("label", { class: "appearance-color-row" }, h("span", { text: label }), input);
    rows.append(row);
  }
  const reset = h("button", { type: "button", text: "Default colors" });
  reset.addEventListener("click", () => {
    ctx.prefSet(PREF.appearanceColors, "{}");
    for (const [, token] of APPEARANCE_COLORS) delete colors[token];
    applyAppearanceColors(colors);
    box.replaceWith(sectionAppearance());
  });
  box.append(h("h3", { text: "Interface colors" }), rows, h("div", { class: "row" }, reset));
  return box;
}

function sectionImages(): HTMLElement {
  const box = h("div");
  const cur = imageDirSetting();
  const inp = h("input", { type: "text", placeholder: "Next to the document (assets folder)" }) as HTMLInputElement;
  inp.value = cur === "sharex:recent" || cur === "embed" ? "" : cur;
  const mode = h("p", { class: "hint" });
  const save = (v: string) => {
    ctx.prefSet(PREF.imageDir, v);
    mode.textContent = v === "embed" ? "Pasted images are embedded in the Markdown file."
      : v === "" ? "Pasted images go into an assets folder next to your document."
      : v === "sharex:recent" ? "Pasted images go into ShareX's newest screenshot folder (checked each time you paste)."
        : `Pasted images go into ${v}`;
  };
  save(cur);
  inp.addEventListener("change", () => save(inp.value.trim()));
  const bDoc = h("button", { type: "button", text: "Next to document" });
  const bEmbed = h("button", { type: "button", text: "Embed (default)" });
  const bPics = h("button", { type: "button", text: "Pictures folder" });
  const bShare = h("button", { type: "button", text: "ShareX recent" });
  const bPick = h("button", { type: "button", text: "Browse…" });
  bDoc.addEventListener("click", () => { inp.value = ""; save(""); });
  bEmbed.addEventListener("click", () => { inp.value = ""; save("embed"); });
  bPics.addEventListener("click", async () => {
    const k = await invoke<{ pictures: string }>("known_folders");
    inp.value = k.pictures; save(k.pictures);
  });
  bShare.addEventListener("click", async () => {
    const k = await invoke<{ sharexRecent: string | null }>("known_folders");
    if (!k.sharexRecent) { ctx.showToast("ShareX screenshot folder not found", "danger"); return; }
    inp.value = ""; save("sharex:recent");
    mode.textContent += ` Right now that is ${k.sharexRecent}`;
  });
  bPick.addEventListener("click", async () => {
    const p = await openDialog({ directory: true, multiple: false });
    if (typeof p === "string") { inp.value = p; save(p); }
  });
  box.append(h("h3", { text: "Default for pasted images" }), h("div", { class: "row" }, bEmbed, bPics, bShare, bDoc, bPick),
    h("label", { class: "field" }, h("span", { text: "Custom folder" }), inp), mode);
  return box;
}

function sectionSend(): HTMLElement {
  const box = h("div");
  const list = h("div", { class: "send-list" });
  const render = () => {
    const targets = loadSendTargets();
    list.innerHTML = "";
    targets.forEach((t, i) => {
      const en = h("input", { type: "checkbox" }) as HTMLInputElement;
      en.checked = t.enabled;
      en.addEventListener("change", () => { targets[i].enabled = en.checked; saveSendTargets(targets); });
      const row = h("div", { class: "send-row" }, en, h("b", { text: t.name }));
      if (t.builtin) {
        row.append(h("span", { class: "hint", text: t.id === "obsidian" ? "opens the file via obsidian:// (file must be inside a vault)"
          : t.id === "firefox" ? "opens a styled HTML preview" : "opens the .md file" }));
      } else {
        row.append(h("span", { class: "hint", text: `${t.program} ${t.args}` }));
        const del = h("button", { type: "button", text: "Remove" });
        del.addEventListener("click", () => { targets.splice(i, 1); saveSendTargets(targets); render(); });
        row.append(del);
      }
      list.append(row);
    });
  };
  render();
  const name = h("input", { type: "text", placeholder: "Name (e.g. Typora)" }) as HTMLInputElement;
  const prog = h("input", { type: "text", placeholder: "Program .exe path" }) as HTMLInputElement;
  const args = h("input", { type: "text", placeholder: "Arguments", value: "{file}" }) as HTMLInputElement;
  const browse = h("button", { type: "button", text: "Browse…" });
  browse.addEventListener("click", async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "Programs", extensions: ["exe"] }] });
    if (typeof p === "string") { prog.value = p; if (!name.value) name.value = p.split(/[\\/]/).pop()!.replace(/\.exe$/i, ""); }
  });
  const add = h("button", { type: "button", class: "primary", text: "Add" });
  add.addEventListener("click", () => {
    if (!name.value.trim() || !prog.value.trim()) { ctx.showToast("Give the target a name and a program", "danger"); return; }
    const targets = loadSendTargets();
    targets.push({ id: "custom-" + Date.now(), name: name.value.trim(), program: prog.value.trim(), args: args.value.trim() || "{file}", enabled: true });
    saveSendTargets(targets);
    name.value = ""; prog.value = ""; args.value = "{file}";
    render();
  });
  let ahkConfig: { runtime?: string; target?: string; script?: string } = {};
  try { ahkConfig = JSON.parse(ctx.prefGet(PREF.ahkSettings) || "{}"); } catch { ahkConfig = {}; }
  const ahkExe = h("input", { type: "text", placeholder: "AutoHotkey v2 executable", value: ahkConfig.runtime || "" }) as HTMLInputElement;
  const targetExe = h("input", { type: "text", placeholder: "Application that opens the saved file", value: ahkConfig.target || "" }) as HTMLInputElement;
  const ahkScript = h("input", { type: "text", placeholder: "Save the generated .ahk script", value: ahkConfig.script || "" }) as HTMLInputElement;
  const saveAhkConfig = () => {
    ahkConfig = { runtime: ahkExe.value.trim(), target: targetExe.value.trim(), script: ahkScript.value.trim() };
    ctx.prefSet(PREF.ahkSettings, JSON.stringify(ahkConfig));
  };
  for (const input of [ahkExe, targetExe, ahkScript]) input.addEventListener("change", saveAhkConfig);
  const pickExecutable = (input: HTMLInputElement) => async () => {
    const selected = await openDialog({ multiple: false, filters: [{ name: "Programs", extensions: ["exe"] }] });
    if (typeof selected === "string") { input.value = selected; saveAhkConfig(); }
  };
  const pickAhk = h("button", { type: "button", text: "Browse…" });
  const pickTarget = h("button", { type: "button", text: "Browse…" });
  pickAhk.addEventListener("click", pickExecutable(ahkExe));
  pickTarget.addEventListener("click", pickExecutable(targetExe));
  const scriptPath = h("button", { type: "button", text: "Choose script path…" });
  scriptPath.addEventListener("click", async () => {
    const selected = await saveDialog({ defaultPath: "Mdaddy-Edit-File.ahk", filters: [{ name: "AutoHotkey v2", extensions: ["ahk"] }] });
    if (selected) { ahkScript.value = selected; saveAhkConfig(); }
  });
  const editScript = h("button", { type: "button", text: "Edit script" });
  editScript.addEventListener("click", async () => {
    if (!ahkScript.value.trim()) { ctx.showToast("Choose a script path first", "danger"); return; }
    try { await openPath(ahkScript.value.trim()); } catch (error) { ctx.showToast(`Could not open AutoHotkey script: ${error}`, "danger"); }
  });
  const addAhk = h("button", { type: "button", class: "primary", text: "Create / update AutoHotkey Edit action" });
  addAhk.addEventListener("click", async () => {
    const runtime = ahkExe.value.trim(), app = targetExe.value.trim(), script = ahkScript.value.trim();
    if (!runtime || !app || !script) { ctx.showToast("Choose AutoHotkey, the target app, and a script path", "danger"); return; }
    saveAhkConfig();
    const escapedApp = app.replace(/"/g, '""');
    const body = `#Requires AutoHotkey v2.0\n#SingleInstance Force\n\n; Receives the saved Markdown file path from Mdaddy.\nif (A_Args.Length < 1) {\n    MsgBox("Run this action from Mdaddy so it can pass a saved file path.")\n    ExitApp()\n}\ntargetApp := "${escapedApp}"\nRun('"' . targetApp . '" "' . A_Args[1] . '"')\n`;
    try {
      await invoke("write_export_file", { path: script, content: body });
      const target: SendTarget = { id: "custom-autohotkey-edit", name: "AutoHotkey Edit / Run", program: runtime, args: `"${script}" "{file}"`, enabled: true };
      const targets = loadSendTargets();
      const index = targets.findIndex((item) => item.id === target.id);
      if (index < 0) targets.push(target); else targets[index] = { ...target, builtin: targets[index].builtin };
      saveSendTargets(targets); render();
      ctx.showToast("AutoHotkey Edit / Run action is ready", "success");
    } catch (error) { ctx.showToast(`Could not create AutoHotkey action: ${error}`, "danger"); }
  });
  box.append(h("h3", { text: "Send targets" }), list,
    h("h3", { text: "Add another app" }),
    h("p", { class: "hint", text: "In arguments, {file} is the saved .md path and {html} is a styled HTML copy." }),
    h("div", { class: "row" }, name), h("div", { class: "row" }, prog, browse), h("div", { class: "row" }, args, add),
    h("h3", { text: "AutoHotkey edit / run" }),
    h("p", { class: "hint", text: "Creates an editable AutoHotkey v2 script that opens the saved Markdown file in the application you choose." }),
    h("div", { class: "row" }, ahkExe, pickAhk), h("div", { class: "row" }, targetExe, pickTarget),
    h("div", { class: "row" }, ahkScript, scriptPath, editScript, addAhk));
  return box;
}

function sectionAi(): HTMLElement {
  const c = loadAiConfig();
  const box = h("div");
  const field = (label: string, key: keyof AiConfig, ph: string) => {
    const inp = h("input", { type: "text", placeholder: ph }) as HTMLInputElement;
    inp.value = c[key];
    inp.addEventListener("change", () => { c[key] = inp.value.trim(); saveAiConfig(c); });
    return h("label", { class: "field" }, h("span", { text: label }), inp);
  };
  const prompt = h("pre", { class: "ai-prompt-preview" });
  prompt.textContent = ctx.systemPromptPreview();
  box.append(
    h("h3", { text: "Model shelf" }),
    field("Shelf folder", "shelfRoot", "MODEL_SHELF_ROOT or C:\\Models"),
    h("h3", { text: "Local servers" }),
    field("Ollama", "ollamaUrl", "http://localhost:11434"),
    h("p", { class: "hint", text: "HF, Unsloth and freetoken models are served by any OpenAI-compatible server on this PC (LM Studio, llama-server, ...)." }),
    field("HF server", "hfUrl", "http://localhost:1234/v1"),
    field("Unsloth server", "unslothUrl", "http://localhost:1234/v1"),
    field("freetoken server", "freetokenUrl", "http://localhost:1234/v1"),
    h("h3", { text: "Subscriptions ($20/mth)" }),
    h("p", { class: "hint", text: "Claude Pro runs through the Claude Code CLI and ChatGPT Plus through the Codex CLI, using the accounts you are signed in to. Leave paths empty to auto-detect." }),
    field("Claude Code path", "claudePath", "auto"),
    field("Claude model", "claudeModel", "default (e.g. sonnet, opus)"),
    field("Codex path", "codexPath", "auto"),
    field("Codex model", "codexModel", "default"),
    h("h3", { text: "What the AI is told" }),
    prompt,
  );
  return box;
}

let modalEl: HTMLElement | null = null;

export function closeSettings(): void {
  modalEl?.remove();
  modalEl = null;
  suspendShortcuts(false);
}

export function openSettingsDialog(section: Section = "shortcuts"): void {
  closeSettings();
  const nav = h("nav", { class: "settings-nav" });
  const body = h("div", { class: "settings-body" });
  const settingsBrand = h("div", { class: "settings-brand" });
  const brandMark = h("button", { type: "button", class: "settings-brand-mark", title: "Show / hide sidebar", "aria-label": "Show / hide sidebar" },
    h("img", { src: APP_ASSETS.logoMark, alt: "" }));
  const wordmark = h("img", { class: "settings-brand-wordmark", src: APP_ASSETS.logoWordmark, alt: "Mdaddy" });
  const brandMenu = h("button", { type: "button", class: "settings-brand-menu", title: "Open Mdaddy menu", "aria-label": "Open Mdaddy menu" },
    h("img", { src: APP_ASSETS.chevron, alt: "" }));
  brandMark.addEventListener("click", () => document.getElementById("btn-brand-logo")?.click());
  brandMenu.addEventListener("click", () => document.getElementById("btn-brand-menu")?.click());
  settingsBrand.append(brandMark, wordmark, brandMenu);
  const show = (s: Section) => {
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.sec === s));
    body.innerHTML = "";
    body.append(
      s === "shortcuts" ? sectionShortcuts() : s === "appearance" ? sectionAppearance()
        : s === "images" ? sectionImages() : s === "favorites" ? sectionFavorites() : s === "send" ? sectionSend() : sectionAi());
  };
  for (const [s, label] of SECTIONS) {
    const b = h("button", { type: "button", text: label });
    b.dataset.sec = s;
    b.addEventListener("click", () => show(s));
    nav.append(b);
  }
  const close = h("button", { type: "button", class: "settings-close", text: "✕" });
  close.dataset.tip = "Close";
  close.addEventListener("click", closeSettings);
  modalEl = h("div", { id: "settings-modal", class: "modal-mask" },
    h("div", { class: "modal settings-modal" },
      h("div", { class: "settings-head" }, settingsBrand, h("h2", { text: "Settings" }), close),
      h("div", { class: "settings-main" }, nav, body)));
  modalEl.addEventListener("pointerdown", (e) => { if (e.target === modalEl) closeSettings(); });
  modalEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector(".kb-capture.recording")) { e.stopPropagation(); closeSettings(); }
  });
  document.body.append(modalEl);
  show(section);
  (nav.querySelector("button.active") as HTMLElement)?.focus();
}

export function initSettings(c: SettingsCtx): void {
  ctx = c;
  applyAppearanceColors();
  loadSendTargets(); // immediately strip removed WeChat / Zhihu targets from the persisted preferences
  onKeysChanged(() => document.dispatchEvent(new CustomEvent("mdaddy:keys-changed")));
}
