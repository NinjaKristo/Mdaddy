import { register, initShortcuts, keyFor, allCommands, getCommand, type Command } from "./commands";
import { initTooltips, setVditorCommandMap } from "./tooltip";
import { initSettings, openSettingsDialog, showShortcutScreen, toolbarSize, pageMargin, headingDragSpeed, imageDirSetting, loadSendTargets, loadFavorites, DEFAULT_SIDEBAR_WIDTH } from "./settings";
import { initAi, toggleAiPanel, aiSend, buildSystemPrompt } from "./ai";
import { initSend, toggleSendMenu, sendById } from "./send";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog, confirm, ask } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { APP_ASSETS } from "./assets";
// Drag-drop uses HTML5 (dragDropEnabled:false), no longer Tauri's native getCurrentWebview listener
import Vditor from "vditor";
import "vditor/dist/index.css";
import vditorCssText from "vditor/dist/index.css?raw";
// Formula layout for export (needed by KaTeX HTML output; same source and version as the Vditor editor, inlined at build time)
import katexCssText from "vditor/dist/js/katex/katex.min.css?raw";
// Local English i18n (Vditor's en_US converted to an ESM value import): injected as options.i18n,
// Vditor takes the else branch and uses it directly instead of loading the language file from the unpkg CDN, and it complies with the CSP
import enI18n from "./i18n-en";

// Keep a stable reference because Vditor removes its old toolbar DOM during Preview/Raw rebuilds.
const textColorControlsEl = document.getElementById("text-color-controls");
let vditor: Vditor | null = null;
let outlineTimer: number | null = null;
let suppressInput = false; // suppress the input callback during setValue (so switching/linked tabs are not wrongly marked dirty)
let bootFocused = false; // focus the editor after the first mount at startup (after-callback flag, so mode switches don't steal it again)

// v0.3.21 undo/redo/save keyboard interception — must be registered at module top level (before new Vditor):
// Vditor also hangs hotkeys on the window capture layer and "first registered runs first", so a later handler never sees ⌘Z
// (proven with real AHK keyboard + ztrace: s arrives, z is pre-empted). Function hoisting lets this reference the functions below.
window.addEventListener("keydown", (e) => {
  const isZY = e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y";
  // During composition (IME input) only Ctrl+Z/Y pass: undo during composition = break the composition and roll back (same as Word/Typora),
  // letting it through silently falls into Chromium's native undo fighting the custom stack (AHK measured: leftover composing blocked ^z)
  if (e.isComposing && !(isZY && (e.ctrlKey || e.metaKey))) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const inEditor = !!(e.target as Element | null)?.closest?.(".vditor");
  // Review m1 (v0.4.11b): do not steal keys inside the tab rename input — stopPropagation on the target cannot stop the window capture
  // layer; Ctrl+S opening the native dialog / Ctrl+K stealing focus would blur the input = a half-typed name gets submitted
  const inRenameInput = !!(e.target as Element | null)?.closest?.(".tab-rename");
  if ((e.key === "z" || e.key === "Z") && inEditor) {
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) docRedo(); else docUndo();
  } else if ((e.key === "y" || e.key === "Y") && inEditor) {
    e.preventDefault(); e.stopPropagation();
    docRedo();
  }
  void inRenameInput; // save / palette / every other shortcut now lives in the command registry (src/commands.ts)
}, true);
type EditorMode = "ir" | "wysiwyg" | "sv";
let currentMode: EditorMode = "wysiwyg"; // visual by default; sv is the raw Markdown source view
let vditorInited = false; // whether Vditor finished its first initialisation (mode-switch rebuilds do not rerun openDoc/pendingFile)
let switchInFlight = false; // mode-switch rebuild in progress (between destroy → after); blocks reentry to avoid concurrent destroy / duplicate instances / lost content

// ---- UI text (English only) ----
type Lang = "en";
const VDITOR_I18N: Record<Lang, typeof enI18n> = { "en": enI18n };
const VDITOR_LANG: Record<Lang, "en_US"> = { "en": "en_US" };

const UI_TEXT: Record<Lang, Record<string, string>> = {
  "en": {
    menuFile: "File", menuView: "View", openMenu: "Open…", printMenu: "Print…",
    open: "Open", save: "Save", openTip: "Open a .md/.markdown/.txt file (or drag one into the window)", saveTip: "Save the current document", welcomeName: "Welcome", untitled: "Untitled", noDoc: "(none)",
    emptyHint: 'Click "Open" above, or drag a .md file into the window to start editing',
    noHeadings: "(No headings yet: use # to add a section)",
    noOpenFile: '(No file open: click "Open" above or drag a .md file here)',
    deleteChapter: "Delete this section (with content)", closeTab: "Close",
    openFail: "Open failed: ", saveFail: "Save failed: ", closeFail: "Close failed: ",
    saveEmptySuf: '" is empty, save skipped (to avoid clearing the file)',
    saveAs: "Save As…", tabRenameNoPath: "Document not saved yet — no file name to rename",
    saveAsDupTab: "Target file is already open in another tab: ", tabRenameLoading: "Document is still loading, try again in a moment",
    delTitle: "Delete section", delConfirmSuf: '" and all its content?',
    closeSaveMsg: "Unsaved changes. Save?", closeSave: "Save and close", closeDiscard: "Close without saving", closeCancel: "Cancel",
    modeWYSIWYG: "WYSIWYG", modeIR: "Instant Rendering", switchToIR: "Markdown (IR)", switchToWYSIWYG: "WYSIWYG",
    modeWYSIWYGTip: "Current: WYSIWYG mode (visual table editing)", modeIRTip: "Current: Markdown (IR) mode",
    switchToIRTip: "Switch to Markdown (IR)", switchToWYSIWYGTip: "Switch to WYSIWYG to edit tables",
    panelTitle: "Outline · click to navigate · ✕ delete · drag to reorder",
    export: "Export ▾", exportPdf: "PDF", exportHtmlStyled: "HTML (styled)", exportHtmlPlain: "HTML (plain)", exportPng: "PNG image (full length)", exportDocx: "Word (.docx)", exportNoDoc: "(Open or create a document first)", exportEmptyConfirm: "The document is empty. Export anyway?", exportFail: "Export failed: ", exporting: "Exporting PDF, please wait…",
    exportDone: "Exported: ",
    exportImageSlices: "Long document, exported as multiple PNG slices: ", pasteImgUntitledHint: "(Tip: document not saved yet; screenshot stored in app folder)",
    exportStagePage: "Generating pages…", exportStagePrint: "Printing to PDF…", exportStageSave: "Saving file…",
    fontSizeTip: "Font size: select text first, then pick a size",
    selectFirstTip: "Select the text in the editor first, then pick a size",
    wordCount: "words",
    findBtn: "Find",
    findTip: "Find & replace",
    findPlaceholder: "Find…", replacePlaceholder: "Replace with…",
    replaceOne: "Replace", replaceAll: "Replace all",
    replaceManyConfirm: "More than 500 matches. Replace all anyway?",
    histBtn: "History", histTitle: "Version history (auto-archived on save, 50 versions / 30 days per file)", histEmpty: "No versions yet — archives appear after this file is saved over an older version",
    histRestore: "Restore this version", histRestored: "Version loaded (unsaved). Review and press Ctrl+S to write to disk", histRestoreFail: "Restore failed: ", histNoDoc: "(Open a saved document first)", histPreview: "(preview)",
    tblRowUp: "Move row up", tblRowDown: "Move row down",
    sideOutline: "Outline", sideFiles: "Files",
    printBtn: "Print", printTip: "Print the document: system print preview — printer, copies, duplex",
    outlineFilterPh: "Filter outline…", filterFilesPh: "Filter tree / search all drives…",
    esSearching: "Searching all drives…", esNone: "No matches on this computer", esIndexing: "Building drive-wide file index ({n} items scanned) — partial results become searchable within a minute", esFail: "Query failed",
  diagOk: "Diagnostics exported (logs + version + system info). Send this file for bug reports:", diagFail: "Failed to export diagnostics:", esSplitTip: "Drag to resize the name column, double-click to reset",
    diagBtn: "Diagnostics", diagTip: "Export diagnostics: logs + version + system info in one text file, for bug reports",
    recentTitle: "Recent", clearRecentTip: "Clear recent files", clearRecent: "Clear",
    treePathPh: "Path, Enter to go", treeRefreshTip: "Refresh folder",
    gsearchPh: "Search this folder and subfolders, Enter", gsearchNone: "(no match)",
    gsearchNoDoc: "(open a file to search its folder)", gsearchEmpty: "(type a keyword)",
    quickOpenTitle: "Quick open", quickOpenPh: "Type to filter, ↑↓ select, Enter open…", quickOpenEmpty: "(no recent files)",
    treeNoDoc: "(open a file to show its folder)", treeBadPath: "Path not accessible: ", drivesRoot: "This PC", fileTooBig: "File too large (about ",
    fmOpen: "Open", fmNewMd: "New Markdown file", fmNewTxt: "New TXT file", fmNewDir: "New folder",
    fmRename: "Rename", fmDelete: "Delete", fmReveal: "Show in folder", fmCopyPath: "Copy path",
    fmNewIn: "New item here", fmNamePh: "Enter a name…", fmRenameTitle: "Rename to:", fmNewMdTitle: "New Markdown file:", fmNewTxtTitle: "New TXT file:", fmNewDirTitle: "New folder:",
    fmDelTitle: "Delete", fmDelFileMsg: "Delete this file? This cannot be undone.", fmDelDirMsg: "Delete this folder and ALL its contents? This cannot be undone.",
    fmNoBase: "Open a file or locate a folder in the tree first", untitledMd: "Untitled.md", untitledDir: "New folder", fmCopyDone: "Copied", fmOk: "OK", fileTooBigSuf: "K chars, limit 2000K chars). Opening blocked to avoid unresponsiveness; please split the file first.", bigLoad: "Loading a large file…",
    statusSelected: "{n} selected", extChanged: "File \"{f}\" was modified by another program (disk content changed).", extChangedDirty: "File \"{f}\" was modified by another program; this tab has unsaved changes — reloading will discard them.", extDeleted: "File \"{f}\" no longer exists (moved or deleted).",
    extReload: "Reload", extDismiss: "Ignore", extAskReload: "Load the latest file content?",
    bigDocBar: "Large-document mode: edits take effect after ~1.5s (deferred-save channel); saving and undo are unaffected.", bigDocBarIr: "Instant-render mode is extremely slow for large documents; switch to WYSIWYG via the top button. Edits take effect after ~1.5s.",
    tabClose: "Close", tabCloseOthers: "Close others", tabCloseRight: "Close to the right", tabCloseLeft: "Close to the left", tabCloseAll: "Close all", tabCloseSelected: "Close selected",
    themeTip: "Theme: light / dark / eye-care (follows system); drop Typora community themes into the themes folder",
    appName: "Mdaddy",
    statusSaved: "Saved", statusUnsaved: "Unsaved", readMin: "min", sbSide: "Sidebar",
    sbShowSide: "Show sidebar", sbHideSide: "Hide sidebar",
    zoomResetTip: "Zoom: click to reset 100%",
    themeLight: "Light", themeDark: "Dark", themeEye: "Eye care", themePaper: "Warm Paper",
    themeLoadFail: "Failed to load theme",
    copyCode: "Copy", copied: "Copied", copyFail: "Copy failed",
    readingFocus: "Reading focus", cmdkOpen: "Open file…", cmdkGroupCmd: "COMMANDS", cmdkGroupRecent: "Recent files", cmdkEmpty: "(no matching command or file)", cmdkPh: "Type a command or file name…", cmdkFoot: "↑↓ Select · Enter Run · Esc Close",
    readScrollOn: "Auto-scroll on: ↑/↓ adjust speed, double-click blank / Esc / wheel to stop",
    readScrollOff: "Auto-scroll stopped",
    readScrollEnd: "Auto-scroll: reached end of document",
    readScrollSpd: "Auto-scroll speed: {v} px/s (↑/↓ adjust, Esc stop)",
  },
};

const WELCOME_TEXT: Record<Lang, string> = {
  "en": `# Welcome to Mdaddy

- Double-click a .md file or drag it into the window to open
- Open multiple files in **tabs** (they won't overwrite each other)
- Left outline: click to navigate, ✕ to delete a section, drag to reorder
- Top toolbar: Open / Save
- Switch between **WYSIWYG** and **Raw-by-line** with **Ctrl+Alt+M**
`,
};

// ---- v0.5.0 portable-mode preference layer: PORTABLE uses Rust-side Data/settings.json, the installed version keeps localStorage ----
// In portable mode the WebView2 data folder points to %TEMP% (not persistent per machine), so localStorage preferences would be lost;
// everything goes through prefGet/prefSet: loaded once into an in-memory map at startup, fully written on change (low-frequency writes like font size / panel width, no debounce needed).
// Top-level await (millisecond local IPC) ensures module-top-level synchronous reads such as detectLang below see portable values.
let PORTABLE = false;
let PREFS: Record<string, string> = {};
function prefGet(key: string): string | null {
  if (!PORTABLE) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return PREFS[key] ?? null;
}
function prefSet(key: string, val: string): void {
  if (!PORTABLE) {
    try { localStorage.setItem(key, val); } catch { /* storage disabled: only this session */ }
    return;
  }
  PREFS[key] = val;
  void invoke("save_prefs", { v: PREFS }).catch(() => { /* write failed (USB drive removed etc.) → only this session */ });
}
function prefRemove(key: string): void {
  if (!PORTABLE) {
    try { localStorage.removeItem(key); } catch { /* same as above */ }
    return;
  }
  delete PREFS[key];
  void invoke("save_prefs", { v: PREFS }).catch(() => { /* same as above */ });
}
async function initPrefs(): Promise<void> {
  try {
    PORTABLE = await invoke<boolean>("is_portable");
    if (PORTABLE) {
      const v = await invoke<Record<string, unknown> | null>("load_prefs");
      if (v) for (const [k, val] of Object.entries(v)) if (typeof val === "string") PREFS[k] = val;
    }
  } catch { /* invoke failed (extreme case) → behave like the installed version with localStorage */ }
}

interface InstancePromptRequest { id: number; }
const seenInstancePromptIds = new Set<number>();
const instancePromptQueue: InstancePromptRequest[] = [];
let instancePromptActive = false;
let pullingInstanceRequests = false;
let pullInstanceRequestsAgain = false;
async function drainInstanceRequests(): Promise<void> {
  if (pullingInstanceRequests) { pullInstanceRequestsAgain = true; return; }
  pullingInstanceRequests = true;
  do {
    pullInstanceRequestsAgain = false;
    try {
      const requests = await invoke<InstancePromptRequest[]>("take_instance_requests");
      for (const request of requests) {
        if (!seenInstancePromptIds.has(request.id)) {
          seenInstancePromptIds.add(request.id);
          instancePromptQueue.push(request);
        }
      }
    } catch { /* not running in Tauri */ }
  } while (pullInstanceRequestsAgain);
  pullingInstanceRequests = false;
  showNextInstancePrompt();
}
async function initInstancePrompts(): Promise<void> {
  await listen("instance-request", () => { void drainInstanceRequests(); });
  await drainInstanceRequests();
}
function showNextInstancePrompt(): void {
  if (instancePromptActive || !instancePromptQueue.length) return;
  instancePromptActive = true;
  const request = instancePromptQueue.shift()!;
  const defaultAction = prefGet("mdaddy-instance-default") === "open" ? "open" : "new";
  const mask = document.createElement("div");
  mask.className = "modal-mask instance-choice-mask";
  mask.setAttribute("role", "presentation");
  const dialog = document.createElement("div");
  dialog.className = "modal instance-choice-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "instance-choice-title");
  const title = document.createElement("h2");
  title.id = "instance-choice-title";
  title.textContent = "Mdaddy is already open";
  const message = document.createElement("p");
  message.textContent = "Open the existing window or start a separate instance?";
  const actions = document.createElement("div");
  actions.className = "modal-btns";
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open Instance";
  const fresh = document.createElement("button");
  fresh.type = "button";
  fresh.textContent = "New instance";
  const defaultButton = defaultAction === "new" ? fresh : open;
  defaultButton.classList.add("primary");
  actions.append(open, fresh);
  dialog.append(title, message, actions);
  mask.append(dialog);
  document.body.append(mask);
  let resolving = false;
  const resolve = async (action: "open" | "new") => {
    if (resolving) return;
    resolving = true;
    open.disabled = true;
    fresh.disabled = true;
    mask.remove();
    instancePromptActive = false;
    try { await invoke("resolve_instance_request", { requestId: request.id, action }); }
    catch (error) { showToast("Could not handle the Mdaddy instance request: " + error, "danger"); }
    showNextInstancePrompt();
  };
  open.addEventListener("click", () => { void resolve("open"); });
  fresh.addEventListener("click", () => { void resolve("new"); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); defaultButton.click(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); open.click(); }
  });
  defaultButton.focus();
}

function detectLang(): Lang {
  return "en"; // English-only build
}
let currentLang: Lang = detectLang();
function t(key: string): string { return UI_TEXT[currentLang][key] ?? UI_TEXT["en"][key] ?? key; }
/** Large-file size label in thousands of characters (v0.3.25) */
function bigSizeLabel(charCount: number): string {
  if (currentLang === "en") return Math.round(charCount / 1000) + "K";
  return (charCount / 10000).toFixed(1);
}
function welcomeMd(): string { return WELCOME_TEXT[currentLang]; }

// ---- editor font size (selection-based, independent of PDF: PRINT_CSS's fixed 14px stays) ----
// Markdown has no native font-size syntax → use inline HTML: wrap the selected text in <span style="font-size:Npx">.
// WYSIWYG/instant rendering (contenteditable) renders the span directly; lute keeps it when writing back md (<span> appears in the .md, that's normal).
// Source (SV) mode is raw textarea text → insert the span tags as text.
const FONT_SIZE_KEY = "md-editor-fontsize";
const DEFAULT_FONT_SIZE = 16; // dropdown default (only remembers the last used value, never applied to the whole document)
// Clicking the dropdown steals contenteditable focus and collapses the Selection: snapshot the selection on mousedown (capture), apply it on change.
let savedRange: Range | null = null;            // rich-text selection snapshot (cloned, unaffected by later Selection changes)
let savedTa: HTMLTextAreaElement | null = null; // source-mode textarea
let savedStart = 0, savedEnd = 0;               // textarea selection start/end
let fontInputInteracting = false;               // user is interacting with the font-size box (mousedown → blur): caret font-size sync is frozen meanwhile so it does not overwrite the input
let exporting = false;                          // PDF export reentry lock: during the 1-3s msedge print, Ctrl+P / repeated clicks don't re-enter (no stacked overlays or concurrent invokes)
let fontSelHlEls: HTMLElement[] = [];           // requirement 3 custom selection highlight layer: focusing the input blurs contenteditable (Chromium highlight goes transparent), divs keep the selection visible
function loadFontSize(): number {
  // like detectLang: getItem throws in private mode / with storage disabled; without try/catch the whole page goes white
  try {
    const v = parseInt(prefGet(FONT_SIZE_KEY) || "", 10);
    if (v >= 8 && v <= 72) return v;
  } catch { /* storage disabled/corrupt → use the default */ }
  return DEFAULT_FONT_SIZE;
}
// The active contenteditable editor (WYSIWYG / instant rendering); returns null in source mode
function activeEditableArea(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#editor .vditor-wysiwyg, #editor .vditor-ir");
}
// The active source textarea (only exists in SV mode)
function activeSourceTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("#editor .vditor-sv__textarea");
}
// Snapshot the selection before the dropdown steals focus: source mode stores selectionStart/End, rich-text mode stores a cloned Range
function captureFontSizeSelection() {
  const ta = activeSourceTextarea();
  if (ta) { savedTa = ta; savedStart = ta.selectionStart; savedEnd = ta.selectionEnd; return; }
  savedTa = null;
  const editable = activeEditableArea();
  const sel = window.getSelection();
  // only snapshot when the selection is inside the editor (don't mistake a toolbar/other selection for an editor selection)
  if (sel && sel.rangeCount > 0 && editable) {
    const r = sel.getRangeAt(0);
    if (editable.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
    else savedRange = null;
  } else {
    savedRange = null;
  }
}
// Requirement 3: once the number input has focus, contenteditable blurs and Chromium's selection highlight is transparent by default (unlike a textarea, which turns grey).
// Cover the selection with a translucent blue layer from savedRange's viewport rects so it stays visible throughout "click font box → type → apply".
function paintFontSelHl() {
  clearFontSelHl();
  if (!savedRange || savedRange.collapsed) return;       // rich-text selections only: a blurred source textarea turns grey on its own, no need to fake it
  const editable = activeEditableArea();
  if (!editable) return;
  const rects = savedRange.getClientRects();             // a multi-line selection returns several rects, cover each
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const div = document.createElement("div");
    div.className = "fontsel-hl";
    div.style.left = r.left + "px";
    div.style.top = r.top + "px";
    div.style.width = r.width + "px";
    div.style.height = r.height + "px";
    document.body.appendChild(div);
    fontSelHlEls.push(div);
  }
}
function clearFontSelHl() {
  for (const el of fontSelHlEls) el.remove();            // idempotent: safe to call repeatedly (both change and blur call it)
  fontSelHlEls = [];
}
// Apply the font size to the selection: source → setRangeText wraps span tags; rich text → surroundContents wraps a span element
function applyFontSizeToSelection(px: number) {
  // source mode: raw textarea text, insert <span> tags directly
  if (savedTa) {
    if (savedStart === savedEnd) { showToast(t("selectFirstTip"), "info"); return; }
    const selTxt = savedTa.value.substring(savedStart, savedEnd);
    const wrapped = `<span style="font-size:${px}px">${selTxt}</span>`;
    savedTa.focus();
    savedTa.setRangeText(wrapped, savedStart, savedEnd, "end"); // caret moves to the end of the insertion
    savedTa.dispatchEvent(new Event("input", { bubbles: true })); // let Vditor sync doc.content/dirty/outline
    return;
  }
  // rich-text mode: contenteditable selection
  if (!savedRange || savedRange.collapsed) { showToast(t("selectFirstTip"), "info"); return; }
  const editable = activeEditableArea();
  if (!editable) { showToast(t("selectFirstTip"), "info"); return; }
  editable.focus();
  const span = document.createElement("span");
  span.style.fontSize = px + "px";
  try {
    savedRange.surroundContents(span); // wrap directly when the selection doesn't cross element boundaries
  } catch {
    // when the selection crosses element boundaries (partially selects a node) surroundContents throws → extract the fragment and wrap it
    const frag = savedRange.extractContents();
    span.appendChild(frag);
    savedRange.insertNode(span);
  }
  // reselect the wrapped content so different sizes can be applied to several passages in a row
  const nr = document.createRange();
  nr.selectNodeContents(span);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(nr);
  savedRange = nr.cloneRange();
  // DOM changes via the Range API don't fire input: dispatch manually so Vditor syncs doc.content/dirty/outline
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

const BASIC_TEXT_COLORS = ["#111111", "#b42318", "#a44308", "#26703a", "#1b5eb8", "#713e9b", "#765332", "#5a626d"];
function applyTextColorToSelection(color: string): void {
  if (savedTa) {
    if (savedStart === savedEnd) { showToast(t("selectFirstTip"), "info"); return; }
    const selected = savedTa.value.substring(savedStart, savedEnd);
    savedTa.focus();
    savedTa.setRangeText(`<span style="color:${color}">${selected}</span>`, savedStart, savedEnd, "end");
    savedTa.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (!savedRange || savedRange.collapsed) { showToast(t("selectFirstTip"), "info"); return; }
  const editable = activeEditableArea();
  if (!editable) { showToast(t("selectFirstTip"), "info"); return; }
  editable.focus();
  const span = document.createElement("span");
  span.style.color = color;
  try { savedRange.surroundContents(span); }
  catch {
    const fragment = savedRange.extractContents();
    span.appendChild(fragment);
    savedRange.insertNode(span);
  }
  const nextRange = document.createRange();
  nextRange.selectNodeContents(span);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(nextRange);
  savedRange = nextRange.cloneRange();
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

function initTextColors(): void {
  document.getElementById("btn-toolbar-find")?.addEventListener("click", () => {
    const bar = document.getElementById("find-bar");
    if (bar && !bar.hidden) closeFind();
    else openFind(false);
  });
  document.getElementById("btn-reader-toggle")?.addEventListener("click", () => toggleReaderMode());
  const editor = document.getElementById("editor");
  if (editor) new MutationObserver(updateReaderModeIcon).observe(editor, { attributes: true, attributeFilter: ["class"], subtree: true });
  updateReaderModeIcon();
  const wrap = document.getElementById("text-color-wrap");
  const trigger = document.getElementById("text-color-button");
  const menu = document.getElementById("text-color-menu");
  if (!wrap || !trigger || !menu) return;
  trigger.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    captureFontSizeSelection();
    paintFontSelHl();
  });
  trigger.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute("aria-expanded", String(!menu.hidden));
  });
  menu.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  menu.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      const color = button.dataset.color;
      if (color && BASIC_TEXT_COLORS.includes(color)) applyTextColorToSelection(color);
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      clearFontSelHl();
    });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!wrap.contains(event.target as Node)) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      clearFontSelHl();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      clearFontSelHl();
    }
  });
}

// ---- multiple tabs: one Doc per open document ----
interface Doc {
  id: string;
  path: string | null;
  name: string;
  content: string;
  dirty: boolean;
  encoding: string;
  undoStack: string[]; // v0.3.21 custom undo snapshot stack (per doc; Vditor's internal stack granularity is broken: one undo wipes all input)
  redoStack: string[];
  base: string; // on-disk content (used to decide dirty after undo)
  large: boolean; // v0.3.25 large document (>262144 characters): uses the deferred value channel (getValue on 570k characters = 465ms,
  // a synchronous read per key = ~1s block per key, measured with a headless benchmark; one flush after 400ms idle, undo granularity coarsens to per input burst)
  lazy: boolean; // v0.3.26 lazy session restore placeholder: not read from disk (content=""), open_file only on activation (#9 lazily restored tabs)
  loading: boolean; // lazy load in progress (prevents reentry from repeated clicks)
  restoreScroll: number | null; // v0.3.26 session restore: scrollTop to return to after applyContent (consumed once)
  scrollTop: number; // reading position when leaving this document (saved at the start of switchDoc, used for the session)
  metaMtime: number; // v0.3.26 external change baseline: disk mtime (ms) at open/save
  metaSize: number; // same, in bytes (two metrics compared; mtime alone may lack granularity for same-size rewrites)
  bytes: number; // cached UTF-8 byte count (status-bar file size; updated rarely in openDoc/flush/save)
}

// v0.3.25 large-file limit (reset after measurements): headless benchmark, 2.86M characters take 10.9s to render and 466ms per keystroke —
// superlinear degradation starts here. Up to 2M characters can be opened (570k characters = 1.67MB opens and renders in 2.5s).
const MAX_OPEN_CHARS = 2_000_000;
// Large-document deferred value threshold: same as the old refusal line (documents at or below it keep the per-key path, byte-for-byte unchanged for regression safety)
const LARGE_DOC_CHARS = 262144;
let docs: Doc[] = [];
let activeId: string | null = null;
let docCounter = 0;
function newDocId() {
  return "doc-" + ++docCounter;
}
function activeDoc(): Doc | null {
  return docs.find((d) => d.id === activeId) || null;
}

interface Section {
  id: string;
  level: number;
  title: string;
  start: number;
  end: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- v0.4.0 toast: replaces native alert (blocking, jarring). Appears bottom-centre and fades after 2.6s;
// three states info/danger/success (told apart by the left rail colour); identical text is de-duplicated, at most 3 on screen ----
let toastRoot: HTMLElement | null = null;
function showToast(msg: string, kind: "info" | "danger" | "success" = "info", replaceKey?: string): void {
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.id = "toast-root";
    document.body.appendChild(toastRoot);
  }
  // de-dup key = replaceKey (v0.4.10: when adjusting speed each press changes the value, so de-duping by msg failed and stacked several —
  // user report "two speed toasts". Callers passing a fixed key keep a single toast per key, text updated in place + fade timer reset)
  const key = replaceKey || msg;
  for (const el of Array.from(toastRoot.children)) {
    const elh = el as HTMLElement;
    if (elh.dataset.msg === key) {
      elh.textContent = msg; elh.title = msg;
      scheduleToastHide(elh);
      return;
    }
  }
  const t0 = document.createElement("div");
  t0.className = "toast" + (kind === "info" ? "" : " " + kind);
  t0.textContent = msg;
  t0.title = msg; // hover shows the full text of long ellipsised paths
  t0.dataset.msg = key;
  toastRoot.appendChild(t0);
  requestAnimationFrame(() => t0.classList.add("show"));
  while (toastRoot.children.length > 3) toastRoot.firstElementChild!.remove();
  scheduleToastHide(t0);
}
function scheduleToastHide(el: HTMLElement): void {
  window.clearTimeout(Number(el.dataset.timer || 0));
  const tid = window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 260); // remove after the exit transition finishes
  }, 2600);
  el.dataset.timer = String(tid);
}

// prefers-reduced-motion: smooth scrolling degrades to instant (CSS transitions are handled by the global media query; this covers JS-driven scrolling)
function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---- section parsing: based on md source lines, skipping # inside code fences ----
function parseSections(md: string): Section[] {
  const lines = md.split("\n");
  type H = { level: number; line: number; title: string };
  const heads: H[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(ln)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // only ATX headings (#) are recognised; Setext (===/--- underline style) is not in the outline (rare, and --- is ambiguous with a divider)
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) heads.push({ level: m[1].length, line: i, title: m[2] });
  }
  const secs: Section[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    let end = lines.length - 1;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].line - 1;
        break;
      }
    }
    secs.push({ id: "sec-" + i, level: h.level, title: h.title, start: h.line, end });
  }
  return secs;
}

function rebuildOutline() {
  if (!vditor) return;
  const doc = activeDoc();
  const secs = parseSections(doc ? doc.content : mdValue());
  const movedKeys = doc ? movedSectionKeys(doc.base, doc.content) : new Set<string>();
  const secIds = sectionIdentities(secs);
  const ul = document.getElementById("outline")!;
  ul.innerHTML = "";
  // v0.4.0: rebuild the mapping before the empty early-return — switching to a document without headings must also clear the old document's element references,
  // otherwise outlineHeads keeps the previous document's detached nodes (gBCR always 0) and scrollspy goes haywire
  rebuildHeadMap();
  syncHeadingFolds();
  if (secs.length === 0) {
    ul.innerHTML = '<li class="empty">' + esc(t("noHeadings")) + "</li>";
    return;
  }
  secs.forEach((s, idx) => {
    const li = document.createElement("li");
    li.className = "outline-item";
    if (movedKeys.has(secIds[idx])) li.classList.add("moved");
    li.style.paddingLeft = s.level * 12 + 8 + "px";
    li.dataset.id = s.id;
    li.innerHTML =
      `<span class="ot" title="${esc(s.title)}">${esc(s.title)}</span>` +
      `<span class="odel" title="${esc(t("deleteChapter"))}">✕</span>`;
    li.addEventListener("click", () => scrollToHeading(idx));
    li.querySelector(".odel")!.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSection(s.id);
    });
    // section drag reordering: pointer events instead of HTML5 DnD — with dragDropEnabled=true (needed for Tauri file drag-drop),
    // HTML5 drag-and-drop is disabled in the Windows frontend (stated in the Tauri schema), so draggable/dragstart would not work.
    li.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // left button only
      const dragSecId = s.id;
      const startY = e.clientY;
      let moved = false;
      let overLi: HTMLElement | null = null;
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientY - startY) < 5) return; // movement threshold so clicks don't trigger a drag
        if (!moved) { moved = true; li.classList.add("dragging"); }
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const t = el ? (el.closest(".outline-item") as HTMLElement | null) : null;
        document.querySelectorAll(".outline-item.over").forEach((x) => x.classList.remove("over"));
        if (t && t !== li && ul.contains(t)) { t.classList.add("over"); overLi = t; } else overLi = null;
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        li.classList.remove("dragging");
        document.querySelectorAll(".outline-item.over").forEach((x) => x.classList.remove("over"));
        if (moved && overLi && overLi.dataset.id && overLi.dataset.id !== dragSecId) {
          const rect = overLi.getBoundingClientRect();
          const pos: "before" | "after" = ev.clientY - rect.top < rect.height / 2 ? "before" : "after";
          moveSection(dragSecId, overLi.dataset.id, pos);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    ul.appendChild(li);
    const heading = outlineHeads[idx];
    if (heading) {
      heading.classList.toggle("mdaddy-moved-section", movedKeys.has(secIds[idx]));
    }
  });
  applyOutlineFilter(); // reapply the filter after rebuilding (the outline rebuilds live while editing, the filter box is kept)
  updateReadingTrace(); // recompute current section/progress right after content changes (without waiting for the next scroll) — a lost .cur heals here
}

function sectionIdentities(sections: Section[]): string[] {
  const counts = new Map<string, number>();
  return sections.map((section) => {
    const base = `${section.level}:${section.title}`;
    const ordinal = counts.get(base) || 0;
    counts.set(base, ordinal + 1);
    return `${base}\u0000${ordinal}`;
  });
}

/** Detect reordered saved sections by finding the longest saved-order subsequence in the current document. */
function movedSectionKeys(saved: string, current: string): Set<string> {
  const before = parseSections(saved), after = parseSections(current);
  if (!before.length || !after.length) return new Set();
  const beforeIds = sectionIdentities(before), afterIds = sectionIdentities(after);
  const savedIndex = new Map(beforeIds.map((identity, index) => [identity, index]));
  const common = afterIds.map((identity, index) => ({ currentIndex: index, savedIndex: savedIndex.get(identity) }))
    .filter((entry): entry is { currentIndex: number; savedIndex: number } => entry.savedIndex !== undefined);
  if (common.length < 2) return new Set();
  const tails: number[] = [], tailAt: number[] = [], previous = new Array<number>(common.length).fill(-1);
  for (let i = 0; i < common.length; i++) {
    const value = common[i].savedIndex;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (tails[mid] < value) lo = mid + 1; else hi = mid; }
    if (lo > 0) previous[i] = tailAt[lo - 1];
    tails[lo] = value;
    tailAt[lo] = i;
  }
  const kept = new Set<number>();
  let cursor = tailAt[tails.length - 1];
  while (cursor !== undefined && cursor >= 0) { kept.add(common[cursor].currentIndex); cursor = previous[cursor]; }
  return new Set(common.filter((entry) => !kept.has(entry.currentIndex)).map((entry) => afterIds[entry.currentIndex]));
}

function scheduleOutline() {
  if (outlineTimer !== null) window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null;
    rebuildOutline();
  }, 400);
}

// v0.4.0 reading trace: element-level mapping between outline sections ↔ body headings (shared by scrollspy and click-to-navigate).
// The matching algorithm keeps the old scrollToHeading text + same-name index (skipping Setext etc. headings not in the outline),
// but the result is cached as element references — click-to-navigate no longer rescans the whole document, and same-name heading mismatches are fixed at the root (mapping built once).
let outlineHeads: (HTMLElement | null)[] = [];
const foldedSections = new Map<string, Set<string>>();
function foldKey(section: Section): string { return `${section.level}:${section.title}`; }
function syncHeadingFolds(): void {
  document.querySelectorAll<HTMLElement>("#editor .mdaddy-folded-content").forEach((node) => node.classList.remove("mdaddy-folded-content"));
  const doc = activeDoc();
  if (!doc) return;
  const folded = foldedSections.get(doc.id);
  if (!folded?.size) return;
  const sections = parseSections(doc.content);
  sections.forEach((section, idx) => {
    if (!folded.has(foldKey(section))) return;
    const heading = outlineHeads[idx];
    if (!heading) return;
    let node = heading.nextElementSibling as HTMLElement | null;
    while (node) {
      const level = /^H([1-6])$/.exec(node.tagName);
      if (level && Number(level[1]) <= section.level) break;
      node.classList.add("mdaddy-folded-content");
      node = node.nextElementSibling as HTMLElement | null;
    }
  });
}
function updateHeadingControls(heading: HTMLElement | null): void {
  const controls = document.querySelector<HTMLElement>("#heading-controls-layer .heading-controls");
  if (!controls) return;
  if (!heading || !heading.isConnected) { controls.classList.remove("visible"); return; }
  const host = document.getElementById("editor-wrap")!.getBoundingClientRect();
  const rect = heading.getBoundingClientRect();
  const idx = outlineHeads.indexOf(heading);
  const section = parseSections(activeDoc()?.content || "")[idx];
  const folded = !!section && !!activeId && foldedSections.get(activeId)?.has(foldKey(section));
  controls.style.top = rect.top - host.top + Math.max(0, (rect.height - 24) / 2) + "px";
  controls.style.left = Math.max(0, rect.left - host.left - 45) + "px";
  controls.dataset.headingIndex = String(idx);
  const fold = controls.querySelector<HTMLButtonElement>(".heading-fold-button");
  if (fold) {
    fold.dataset.level = heading.tagName.slice(1);
    fold.textContent = folded ? "›" : "⌄";
    fold.title = folded ? "Expand section" : "Collapse section";
    fold.setAttribute("aria-label", fold.title);
  }
  controls.classList.add("visible");
}
function toggleHeadingFold(idx: number): void {
  const doc = activeDoc();
  const section = parseSections(doc?.content || "")[idx];
  if (!doc || !section) return;
  let folded = foldedSections.get(doc.id);
  if (!folded) { folded = new Set<string>(); foldedSections.set(doc.id, folded); }
  const key = foldKey(section);
  if (folded.has(key)) folded.delete(key); else folded.add(key);
  syncHeadingFolds();
  updateHeadingControls(outlineHeads[idx]);
}
function rebuildHeadMap(): void {
  const doc = activeDoc();
  const secs = parseSections(doc ? doc.content : vditor ? mdValue() : "");
  const domHeads = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#editor h1, #editor h2, #editor h3, #editor h4, #editor h5, #editor h6"
    )
  );
  const used = new Set<HTMLElement>();
  outlineHeads = secs.map((target, idx) => {
    const sameBefore = secs.slice(0, idx).filter((s) => s.title === target.title).length;
    let seen = 0;
    for (const h of domHeads) {
      if (used.has(h)) continue;
      if ((h.textContent || "").trim() === target.title) {
        if (seen === sameBefore) { used.add(h); return h; }
        seen++;
      }
    }
    return null; // intermediate render states / special forms don't match: scrollspy skips that slot
  });
  updateHeadingControls(outlineHeads.find((h) => h?.matches(":hover")) || null);
}

function scrollToHeading(idx: number) {
  const h = outlineHeads[idx];
  if (!h) return;
  h.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  setOutlineCurrent(idx); // instant feedback on click (doesn't wait for the scroll event chain)
}

// ---- v0.4.0 reading trace (the brief's signature feature): current outline section + top progress line + status-bar percentage, three views of one source ----
let spyCur = -1;
let spyRaf = false;
function setOutlineCurrent(idx: number): void {
  spyCur = idx;
  const items = document.querySelectorAll("#outline .outline-item");
  items.forEach((li) => li.classList.remove("cur"));
  if (idx < 0 || idx >= items.length) return;
  const li = items[idx];
  li.classList.add("cur");
  // outline follows scrolling: only moves when the target is not visible (block:nearest doesn't steal the scroll position), decoupled from body scrolling so it never loops
  li.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}
function outlineCurIdx(): number {
  const items = document.querySelectorAll("#outline .outline-item");
  for (let i = 0; i < items.length; i++) if (items[i].classList.contains("cur")) return i;
  return -1;
}
function updateReadingTrace(): void {
  const bar = document.getElementById("read-progress");
  const sbPos = document.getElementById("sb-pos");
  const sc = editorScrollEl();
  if (!sc) {
    if (bar) bar.style.transform = "scaleX(0)";
    if (sbPos) sbPos.textContent = "";
    return;
  }
  // progress line + status-bar percentage (same data source)
  const max = sc.scrollHeight - sc.clientHeight;
  const ratio = max > 0 ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 0;
  if (bar) bar.style.transform = `scaleX(${ratio})`;
  if (sbPos) sbPos.textContent = Math.round(ratio * 100) + "%";
  // scrollspy: trigger line = editor viewport top + 90px (a heading is claimed as it enters, one beat after the visual top line, more stable)
  const line = sc.getBoundingClientRect().top + 90;
  let cur = -1;
  for (let i = 0; i < outlineHeads.length; i++) {
    const h = outlineHeads[i];
    if (h && h.getBoundingClientRect().top <= line) cur = i;
  }
  // redraw when the value changes or the DOM lost .cur (rebuildOutline's innerHTML rebuild drops the class while spyCur still holds the old value, fooling a value check)
  if (cur !== spyCur || outlineCurIdx() !== cur) setOutlineCurrent(cur);
  repositionCodeBtn(); // the code-block copy button overlay follows scrolling
}
function onEditorScroll(): void {
  if (spyRaf) return;
  spyRaf = true;
  requestAnimationFrame(() => { spyRaf = false; updateReadingTrace(); });
}
function initReadingTrace(): void {
  // only follow editor scrolling (a global capture scroll would also receive the outline panel's own scrolling — following it would loop)
  document.addEventListener("scroll", (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest("#editor")) onEditorScroll();
  }, true);
  window.addEventListener("resize", onEditorScroll);
}

// Code block language / collapse / copy controls use an overlay outside contenteditable,
// so the controls never enter Markdown when the document is serialized.
async function copyText(s: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(s); return true; }
  catch {
    // fallback: when not in a secure context / the clipboard API is refused, use the old execCommand path
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.cssText = "position:fixed;left:-99999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
let codeLangTimer = 0;
function refreshCodeLangs(): void {
  // idempotent: only write data-lang on pre elements not yet tagged (skip already tagged ones on re-render)
  document.querySelectorAll<HTMLElement>("#editor pre > code[class*='language-']").forEach((c) => {
    const pre = c.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.lang !== undefined) return;
    const m = /language-([\w+#-]+)/.exec(c.className);
    if (m) pre.dataset.lang = m[1];
  });
}
let codeBtnFor: HTMLElement | null = null; // the pre the button currently points at
function positionCodeBtn(pre: HTMLElement | null): void {
  const layer = document.getElementById("code-btn-layer");
  const controls = layer?.querySelector<HTMLElement>(".code-block-controls");
  const collapse = layer?.querySelector<HTMLButtonElement>(".code-collapse-btn");
  const lang = layer?.querySelector<HTMLElement>(".code-lang");
  if (!layer || !controls || !collapse || !lang) return;
  if (!pre) {
    controls.classList.remove("visible");
    codeBtnFor = null;
    return;
  }
  codeBtnFor = pre;
  const host = document.getElementById("editor-wrap")!.getBoundingClientRect();
  const r = pre.getBoundingClientRect();
  const collapseHost = pre.closest<HTMLElement>(".vditor-wysiwyg__block[data-type='code-block']") || pre;
  const code = pre.querySelector("code");
  lang.textContent = pre.dataset.lang || (/language-([\w+#-]+)/.exec(code?.className || "")?.[1] ?? "text");
  collapse.textContent = collapseHost.dataset.collapsed === "true" ? "⌄" : "⌃";
  collapse.title = collapseHost.dataset.collapsed === "true" ? "Expand code block" : "Collapse code block";
  controls.style.top = r.top - host.top + 4 + "px";
  controls.style.right = Math.max(0, host.right - r.right) + 8 + "px";
  controls.classList.add("visible");
}
function repositionCodeBtn(): void {
  if (codeBtnFor && codeBtnFor.isConnected) positionCodeBtn(codeBtnFor);
}
function initCodeBlocks(): void {
  const layer = document.getElementById("code-btn-layer");
  if (!layer) return;
  const controls = document.createElement("div");
  controls.className = "code-block-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Code block controls");
  const lang = document.createElement("span");
  lang.className = "code-lang";
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "code-collapse-btn";
  collapse.textContent = "⌃";
  collapse.setAttribute("aria-label", "Collapse code block");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy-btn";
  copy.setAttribute("aria-label", "Copy code");
  copy.title = "Copy code";
  const copyIcon = `<img src="${APP_ASSETS.copy}" alt="" />`;
  copy.innerHTML = copyIcon;
  for (const button of [collapse, copy]) button.addEventListener("pointerdown", (e) => e.stopPropagation());
  collapse.addEventListener("click", (e) => {
    e.stopPropagation();
    const pre = codeBtnFor;
    if (!pre) return;
    const collapseHost = pre.closest<HTMLElement>(".vditor-wysiwyg__block[data-type='code-block']") || pre;
    collapseHost.dataset.collapsed = collapseHost.dataset.collapsed === "true" ? "false" : "true";
    positionCodeBtn(pre);
  });
  copy.addEventListener("click", async (e) => {
    e.stopPropagation();
    const pre = codeBtnFor;
    if (!pre) return;
    const code = pre.querySelector("code") || pre;
    const ok = await copyText(code.textContent || "");
    copy.textContent = ok ? "✓" : "!";
    copy.title = ok ? t("copied") : t("copyFail");
    window.setTimeout(() => { copy.innerHTML = copyIcon; copy.title = "Copy code"; }, 900);
  });
  controls.append(lang, collapse, copy);
  layer.appendChild(controls);
  // the button positions on whichever code block is hovered (event delegation: Vditor re-renders don't lose the binding)
  const ed = document.getElementById("editor")!;
  ed.addEventListener("pointerover", (e) => {
    const pre = (e.target as Element).closest<HTMLElement>("pre");
    if (pre && pre.querySelector("code")) positionCodeBtn(pre);
  });
  ed.addEventListener("pointerout", (e) => {
    const to = e.relatedTarget as Element | null;
    if (!to || (!to.closest?.("pre") && !layer.contains(to))) positionCodeBtn(null);
  });
  // language badge: editor subtree changes (input / re-render / mode switch) → debounced tagging
  const obs = new MutationObserver(() => {
    window.clearTimeout(codeLangTimer);
    codeLangTimer = window.setTimeout(refreshCodeLangs, 300);
  });
  obs.observe(ed, { childList: true, subtree: true });
  refreshCodeLangs();
}

function initHeadingControls(): void {
  const layer = document.getElementById("heading-controls-layer");
  const editor = document.getElementById("editor");
  if (!layer || !editor) return;
  const controls = document.createElement("div");
  controls.className = "heading-controls";
  const dropLine = document.createElement("div");
  dropLine.id = "heading-drop-indicator";
  dropLine.hidden = true;
  layer.append(dropLine);
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "heading-drag-handle";
  grip.title = "Drag to move section";
  grip.setAttribute("aria-label", "Drag to move section");
  grip.innerHTML = '<svg viewBox="0 0 12 18" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="9" r="1.4"/><circle cx="3" cy="15" r="1.4"/><circle cx="9" cy="15" r="1.4"/></svg>';
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "heading-fold-button";
  fold.textContent = "⌄";
  fold.title = "Collapse section";
  fold.setAttribute("aria-label", fold.title);
  fold.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
  fold.addEventListener("click", (event) => {
    event.stopPropagation();
    const idx = Number(controls.dataset.headingIndex);
    if (Number.isInteger(idx) && idx >= 0) toggleHeadingFold(idx);
  });
  controls.append(grip, fold);
  layer.append(controls);
  editor.addEventListener("pointerover", (event) => {
    const heading = (event.target as Element | null)?.closest<HTMLElement>("h1,h2,h3,h4,h5,h6");
    if (heading && editor.contains(heading)) updateHeadingControls(heading);
  });
  editor.addEventListener("pointerout", (event) => {
    const to = event.relatedTarget as Element | null;
    if (to?.closest?.("#editor h1,#editor h2,#editor h3,#editor h4,#editor h5,#editor h6") || layer.contains(to)) return;
    updateHeadingControls(null);
  });
  layer.addEventListener("pointerout", (event) => {
    const to = event.relatedTarget as Element | null;
    if (!to?.closest?.("#editor h1,#editor h2,#editor h3,#editor h4,#editor h5,#editor h6") && !layer.contains(to)) updateHeadingControls(null);
  });
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startIndex = Number(controls.dataset.headingIndex);
    if (!Number.isInteger(startIndex) || startIndex < 0) return;
    const source = outlineHeads[startIndex];
    if (!source) return;
    const startY = event.clientY;
    let moved = false;
    let target: HTMLElement | null = null;
    let targetPosition: "before" | "after" = "before";
    let dragY = startY;
    let scrollFrame = 0;
    let lastScrollFrame = 0;
    const updateDropLine = (clientY: number) => {
      const headings = Array.from(editor.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
      let best: { heading: HTMLElement; position: "before" | "after"; y: number; distance: number } | null = null;
      for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        for (const boundary of [{ position: "before" as const, y: rect.top }, { position: "after" as const, y: rect.bottom }]) {
          const distance = Math.abs(clientY - boundary.y);
          if (!best || distance < best.distance) best = { heading, position: boundary.position, y: boundary.y, distance };
        }
      }
      target = best?.heading || null;
      targetPosition = best?.position || "before";
      const targetIndex = target ? outlineHeads.indexOf(target) : -1;
      const valid = targetIndex >= 0 && targetIndex !== startIndex;
      dropLine.hidden = !best;
      if (best) {
        const host = document.getElementById("editor-wrap")!.getBoundingClientRect();
        dropLine.style.top = `${best.y - host.top}px`;
        dropLine.classList.toggle("valid", valid);
        dropLine.classList.toggle("provisional", !valid);
      }
      document.querySelectorAll("#editor .mdaddy-drag-target").forEach((el) => el.classList.remove("mdaddy-drag-target"));
      if (valid) target?.classList.add("mdaddy-drag-target");
    };
    const onMove = (moveEvent: PointerEvent) => {
      dragY = moveEvent.clientY;
      if (!moved && Math.abs(moveEvent.clientY - startY) < 5) return;
      moved = true;
      source.classList.add("mdaddy-drag-source");
      updateDropLine(moveEvent.clientY);
      if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollDuringDrag);
    };
    const scrollDuringDrag = (time: number) => {
      if (!moved) { scrollFrame = 0; return; }
      const wrap = document.getElementById("editor-wrap")!.getBoundingClientRect();
      const scroll = editorScrollEl();
      const direction = dragY < wrap.top + 48 ? -1 : dragY > wrap.bottom - 48 ? 1 : 0;
      if (direction && scroll) {
        const elapsed = lastScrollFrame ? Math.min(.05, (time - lastScrollFrame) / 1000) : 1 / 60;
        scroll.scrollTop += direction * headingDragSpeed() * elapsed;
        updateDropLine(dragY);
      }
      lastScrollFrame = time;
      scrollFrame = requestAnimationFrame(scrollDuringDrag);
    };
    const onUp = (_upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      source.classList.remove("mdaddy-drag-source");
      document.querySelectorAll("#editor .mdaddy-drag-target").forEach((el) => el.classList.remove("mdaddy-drag-target"));
      dropLine.hidden = true;
      if (!moved || !target) return;
      const targetIndex = outlineHeads.indexOf(target);
      if (targetIndex < 0 || targetIndex === startIndex) return;
      moveSection(`sec-${startIndex}`, `sec-${targetIndex}`, targetPosition);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  });
  const reposition = () => {
    if (!controls.classList.contains("visible")) return;
    const idx = Number(controls.dataset.headingIndex);
    updateHeadingControls(outlineHeads[idx] || null);
  };
  window.addEventListener("resize", reposition);
  document.addEventListener("scroll", reposition, true);
}

function initImageActions(): void {
  const editor = document.getElementById("editor");
  const layer = document.getElementById("image-actions-layer") as HTMLElement | null;
  if (!editor || !layer) return;
  layer.innerHTML = "";
  const selected = { image: null as HTMLImageElement | null };
  const embedButton = document.createElement("button");
  embedButton.type = "button"; embedButton.textContent = "Embed"; embedButton.title = "Copy an embedded Markdown image";
  const shareXButton = document.createElement("button");
  shareXButton.type = "button"; shareXButton.textContent = "ShareX folder";
  const picturesButton = document.createElement("button");
  picturesButton.type = "button"; picturesButton.textContent = "Pictures folder";
  const scaleLabel = document.createElement("label");
  scaleLabel.className = "image-scale-control";
  scaleLabel.append(document.createTextNode("Scale"));
  const scale = document.createElement("input");
  scale.type = "range"; scale.min = "10"; scale.max = "100"; scale.step = "1"; scale.value = "100";
  scale.title = "Resize image";
  scaleLabel.append(scale);
  layer.append(embedButton, shareXButton, picturesButton, scaleLabel);
  for (const button of [embedButton, shareXButton, picturesButton]) button.addEventListener("pointerdown", (event) => event.stopPropagation());

  const place = (image: HTMLImageElement | null) => {
    selected.image = image;
    if (!image?.isConnected) { layer.hidden = true; return; }
    layer.hidden = false;
    const host = document.getElementById("editor-wrap")!.getBoundingClientRect();
    const rect = image.getBoundingClientRect();
    const naturalWidth = image.naturalWidth || rect.width;
    const scaled = Math.max(10, Math.min(100, Math.round(rect.width / naturalWidth * 100)));
    if (Number(scale.value) !== scaled) scale.value = String(scaled);
    layer.style.left = `${Math.max(6, Math.min(host.width - layer.offsetWidth - 6, rect.left - host.left))}px`;
    layer.style.top = `${Math.max(6, Math.min(host.height - layer.offsetHeight - 6, rect.bottom - host.top + 5))}px`;
    layer.hidden = false;
  };
  const imagePayload = async (image: HTMLImageElement): Promise<{ dataUri: string; alt: string }> => {
    const original = image.dataset.origSrc || image.getAttribute("src") || image.src;
    let b64 = "", mime = "";
    if (original.startsWith("data:")) {
      const match = original.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) throw new Error("This image data URL is not supported.");
      mime = match[1] || "application/octet-stream";
      b64 = match[2] ? match[3] : btoa(decodeURIComponent(match[3]));
    } else if (/^(https?:|blob:)/i.test(original)) {
      const response = await fetch(original);
      if (!response.ok) throw new Error(`Could not read image (${response.status}).`);
      const blob = await response.blob();
      mime = blob.type || "image/png";
      b64 = await fileToBase64(new File([blob], "image", { type: mime }));
    } else {
      const doc = activeDoc();
      if (!doc?.path) throw new Error("Save the document first so Mdaddy can resolve this local image.");
      const dir = doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
      let path = original.replace(/^file:\/\//i, "");
      try { path = decodeURIComponent(path); } catch { /* retain a literal percent in the path */ }
      if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) path = `${dir}/${path.replace(/^\.\//, "")}`;
      b64 = await invoke<string>("read_binary_file", { path });
      mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" } as Record<string, string>)[path.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
    }
    return { dataUri: `data:${mime};base64,${b64}`, alt: image.alt || "" };
  };
  scale.addEventListener("pointerdown", (event) => event.stopPropagation());
  scale.addEventListener("input", () => {
    const image = selected.image;
    if (!image) return;
    image.style.width = `${Math.max(1, Math.round((image.naturalWidth || image.getBoundingClientRect().width) * Number(scale.value) / 100))}px`;
    image.style.height = "auto";
    image.style.maxWidth = "100%";
    place(image);
  });
  scale.addEventListener("change", () => {
    const image = selected.image;
    const doc = activeDoc();
    if (!image || !doc || !vditor) return;
    const source = image.dataset.origSrc || image.getAttribute("src") || "";
    const alt = image.alt || "";
    const before = mdValue();
    const width = Math.max(1, Math.round((image.naturalWidth || image.getBoundingClientRect().width) * Number(scale.value) / 100));
    const escapeRx = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sourceRx = escapeRx(source.replace(/ /g, "%20"));
    const imageRx = new RegExp(`!\\[${escapeRx(alt)}\\]\\(<?${sourceRx}>?[^)]*\\)`, "m");
    const match = before.match(imageRx);
    if (!match || match.index === undefined) {
      showToast("Could not locate this image in the Markdown to save its size", "danger");
      return;
    }
    const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;");
    const title = match[0].match(/\s+["']([^"']*)["']\)?$/)?.[1];
    const titleAttr = title ? ` title="${attr(title)}"` : "";
    const html = `<img src="${attr(source)}" alt="${attr(alt)}"${titleAttr} width="${width}">`;
    const updated = before.slice(0, match.index) + html + before.slice(match.index + match[0].length);
    doc.undoStack.push(before);
    doc.redoStack.length = 0;
    layer.hidden = true;
    selected.image = null;
    restoreDocValue(doc, updated);
  });
  const copy = async (target: "embed" | "sharex" | "pictures") => {
    const image = selected.image;
    if (!image) return;
    try {
      const { dataUri, alt } = await imagePayload(image);
      let source = dataUri;
      if (target !== "embed") {
        const match = dataUri.match(/^data:([^;,]+);base64,(.*)$/s);
        if (!match) throw new Error("This image format cannot be saved to a folder.");
        const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" } as Record<string, string>)[match[1]];
        if (!ext) throw new Error("This image format cannot be saved to a folder.");
        let imageDir: string;
        if (target === "sharex") imageDir = "sharex:recent";
        else imageDir = (await invoke<{ pictures: string }>("known_folders")).pictures;
        const doc = activeDoc();
        const docDir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : "";
        const saved = await invoke<{ rel: string; abs: string }>("save_paste_image", {
          docDir, ext, dataB64: match[2], imageDir, stamp: new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})$/, "$1_$2"),
        });
        source = encodeURI(saved.rel.replace(/\\/g, "/")).replace(/#/g, "%23");
      }
      const value = `![${alt.replace(/[\[\]]/g, "\\$&")}](${source})`;
      const ok = await copyText(value);
      showToast(ok ? (target === "embed" ? "Markdown image embed copied" : `Image saved and Markdown link copied`) : "Clipboard is unavailable", ok ? "success" : "danger");
    } catch (error) { showToast(`Could not read image: ${error}`, "danger"); }
  };
  embedButton.addEventListener("click", () => { void copy("embed"); });
  shareXButton.addEventListener("click", () => { void copy("sharex"); });
  picturesButton.addEventListener("click", () => { void copy("pictures"); });
  editor.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLImageElement>(".vditor-wysiwyg img, .vditor-ir img");
    if (target) place(target);
    else if (!(event.target as Element).closest("#image-actions-layer")) place(null);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!layer.hidden && !layer.contains(event.target as Node) && !(event.target as Element).closest("#editor img")) place(null);
  }, true);
  document.addEventListener("scroll", () => { if (selected.image && !layer.hidden) place(selected.image); }, true);
}

async function deleteSection(id: string) {
  if (!vditor) return;
  const doc = activeDoc();
  if (!doc) return;
  const secs = parseSections(doc.content);
  const s = secs.find((x) => x.id === id);
  if (!s) return;
  let ok = false;
  // delTitle is not prefixed to the body text (otherwise it reads 'Delete section"Title" and all its content?':
  // an orphaned quote + duplicating the 'Delete section' title box).
  // delTitle is still used as the title of the confirm dialog.
  const delQ = '"';
  const delMsg = (currentLang === "en" ? "" : t("delTitle")) + delQ + s.title + t("delConfirmSuf");
  try {
    ok = await confirm(delMsg, { title: t("delTitle"), kind: "warning" });
  } catch {
    ok = window.confirm(delMsg);
  }
  if (!ok) return;
  const previous = doc.content;
  const scrollTop = editorScrollEl()?.scrollTop ?? 0;
  const lines = doc.content.split("\n");
  doc.content = lines.slice(0, s.start).concat(lines.slice(s.end + 1)).join("\n");
  doc.undoStack.push(previous);
  if (doc.undoStack.length > 100) doc.undoStack.shift();
  doc.redoStack.length = 0;
  doc.dirty = true;
  snapReset(doc);
  suppressInput = true;
  vditor.setValue(doc.content);
  suppressInput = false;
  rebuildOutline();
  renderTabs();
  updateTitle();
  const restoreScroll = () => { const scroller = editorScrollEl(); if (scroller) scroller.scrollTop = scrollTop; };
  window.setTimeout(restoreScroll, 0);
  window.setTimeout(restoreScroll, 180);
}

function moveSection(dragId: string, targetId: string, pos: "before" | "after") {
  if (!vditor) return;
  const doc = activeDoc();
  if (!doc) return;
  const secs = parseSections(doc.content);
  const drag = secs.find((x) => x.id === dragId);
  const target = secs.find((x) => x.id === targetId);
  if (!drag || !target || drag === target) return;
  if (target.start >= drag.start && target.end <= drag.end) return;
  const lines = doc.content.split("\n");
  const block = lines.slice(drag.start, drag.end + 1);
  const work = lines.slice();
  work.splice(drag.start, drag.end - drag.start + 1);
  const shift = drag.start < target.start ? drag.end - drag.start + 1 : 0;
  const insertAt = pos === "before" ? target.start - shift : target.end - shift + 1;
  work.splice(insertAt, 0, ...block);
  const previous = doc.content;
  const scrollTop = editorScrollEl()?.scrollTop ?? 0;
  doc.content = work.join("\n");
  doc.undoStack.push(previous);
  if (doc.undoStack.length > 100) doc.undoStack.shift();
  doc.redoStack.length = 0;
  doc.dirty = true;
  snapReset(doc);
  suppressInput = true;
  vditor.setValue(doc.content);
  suppressInput = false;
  rebuildOutline();
  renderTabs();
  updateTitle();
  const restoreScroll = () => { const scroller = editorScrollEl(); if (scroller) scroller.scrollTop = scrollTop; };
  window.setTimeout(restoreScroll, 0);
  window.setTimeout(restoreScroll, 180);
}

// Toolbar tooltip text comes from the i18n injected into Vditor; here we only flip the direction downward,
// to avoid #editor-wrap overflow:hidden clipping it at the top ([TAURI-01] pitfall 4)
function fixToolbarTooltipDirection() {
      document.querySelectorAll<HTMLElement>("#toolbar .vditor-toolbar [data-type]").forEach((btn) => {
    btn.className = btn.className.replace(/vditor-tooltipped__n[we]?/, "vditor-tooltipped__s");
  });
}

// ---- tabs ----
// v0.3.15 tab multi-select (Notepad++ style): Ctrl+Click adds/removes from the selection, which the context menu "Close selected" closes in bulk
const tabSel = new Set<string>();
function renderTabs() {
  const bar = document.getElementById("tabs")!;
  bar.innerHTML = "";
  // v0.3.18 double-click empty tab-bar space = new blank document (same as Notepad++; renderTabs rebuilds the bar each time, so bind on every build)
  bar.ondblclick = (e) => {
    if ((e.target as HTMLElement).closest(".tab")) return; // clicked on a tab: let the tab handle it
    openDoc(null, "", t("untitled"));
  };
  docs.forEach((doc) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (doc.id === activeId ? " active" : "") + (tabSel.has(doc.id) ? " sel" : "") + (doc.lazy ? " lazy" : ""); // v0.3.26 lazy = lazy session placeholder (italic grey)
    tab.dataset.docId = doc.id;
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = (doc.dirty ? "● " : "") + doc.name;
    const close = document.createElement("span");
    close.className = "tab-close" + (doc.dirty ? " dirty" : "");
    close.textContent = "✕";
    close.title = t("closeTab");
    // v0.4.11 double-click the tab name = rename (inline input; reuses the tree context menu's rename_entry + handleRenamed with full linkage)
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation(); // keep it from bubbling to bar.ondblclick (its .tab check already returns, belt and braces)
      startTabRename(doc, name);
    });
    tab.appendChild(name);
    tab.appendChild(close);
    tab.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: add/remove from multi-select (does not switch documents, Notepad++-style selection)
        if (tabSel.has(doc.id)) { tabSel.delete(doc.id); tab.classList.remove("sel"); }
        else { tabSel.add(doc.id); tab.classList.add("sel"); }
        return;
      }
      if (e.shiftKey) {
        // Shift+Click: select the continuous range from the active tab to the clicked tab (v0.3.21 user request)
        const curIdx = docs.findIndex((d) => d.id === activeId);
        const thisIdx = docs.findIndex((d) => d.id === doc.id);
        if (curIdx >= 0 && thisIdx >= 0) {
          const [a, b] = curIdx < thisIdx ? [curIdx, thisIdx] : [thisIdx, curIdx];
          for (let i = a; i <= b; i++) tabSel.add(docs[i].id);
          renderTabs();
          return;
        }
      }
      tabSel.clear();
      bar.querySelectorAll(".tab.sel").forEach((x) => x.classList.remove("sel"));
      switchDoc(doc.id);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDoc(doc.id);
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openTabMenu(doc.id, e.clientX, e.clientY);
    });
    bar.appendChild(tab);
  });
  updateSaveState(); // v0.4.0 status-bar save state: dirty changes always pass through renderTabs (same source as the tab ●)
}

// v0.4.11 double-click tab name to rename: the name span is swapped for an input in place, Enter/blur submits, Esc cancels.
// Uses Rust rename_entry (illegal name / duplicate / drive-root guards all reused) + handleRenamed (tab / tree / address bar linkage).
// Known edge: if the 30s autosave triggers renderTabs while editing, the input is lost — renaming takes seconds, the odds are negligible.
function startTabRename(doc: Doc, nameEl: HTMLElement): void {
  if (!doc.path) { showToast(t("tabRenameNoPath"), "info"); return; }
  if (doc.lazy || doc.loading) { showToast(t("tabRenameLoading"), "info"); return; } // review m2: renaming during loading → loadLazyDoc reading the old path fails and force-closes the tab
  // when double-clicking an inactive tab the first click already triggered switchDoc → renderTabs rebuild, so the closure's nameEl may be detached — look up the live element by docId
  if (!nameEl.isConnected) {
    const cur = document.querySelector(`#tabs .tab[data-doc-id="${doc.id}"] .tab-name`) as HTMLElement | null;
    if (!cur) return; // tab already removed by a rebuild (extreme timing), give up this time
    nameEl = cur;
  }
  const inp = document.createElement("input");
  inp.className = "tab-rename";
  inp.value = doc.name;
  inp.title = doc.path;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = (restore: boolean) => {
    if (done) return;
    done = true;
    const wasConnected = inp.isConnected; // read before replaceWith (on the normal submit path it is always detached after replaceWith)
    if (inp.parentNode) inp.replaceWith(nameEl);
    if (restore) return;
    if (!wasConnected) return; // review M4: the input was removed by a renderTabs rebuild (30s autosave colliding with the rename window etc.) — abandon the submit; better to lose input than save a half-typed name
    const nv = inp.value.trim();
    if (!nv || nv === doc.name) return; // empty / unchanged: finish silently
    invoke<string>("rename_entry", { old: doc.path, newName: nv })
      .then((np) => handleRenamed(doc.path!, np))
      .catch((err) => showToast(String(err), "danger")); // Rust refused (duplicate / illegal name): show it directly
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation(); // block the bubbling global hotkeys and the Vditor pre-emption layer (the window capture layer already yields via the m1 guard)
    if (e.isComposing || e.keyCode === 229) return; // review M3: Enter during IME composition = commit a candidate, not submit (prevents a pinyin string being saved as the name)
    if (e.key === "Enter") { e.preventDefault(); finish(false); }
    else if (e.key === "Escape") { e.preventDefault(); finish(true); }
  });
  inp.addEventListener("blur", () => finish(false));
  inp.addEventListener("click", (e) => e.stopPropagation()); // don't let it reach the tab and trigger switchDoc again
}

// Tab context menu (Notepad++: close / close others / close right / close all; Ctrl+Click multi-select adds "Close selected")
let tabMenuTarget: string | null = null;
function openTabMenu(docId: string, x: number, y: number): void {
  const menu = document.getElementById("tab-menu")!;
  tabMenuTarget = docId;
  const selBtn = menu.querySelector<HTMLButtonElement>('[data-act="close-selected"]')!;
  // shown when the selection has >1 tab (right-clicking any tab can close the selection; the target need not be in it)
  const multi = tabSel.size > 1;
  selBtn.hidden = !multi;
  selBtn.textContent = t("tabCloseSelected"); // v0.3.16 count suffix removed at the user's request
  (menu.querySelector("#tab-close-actions") as HTMLElement).hidden = multi;
  const doc = docs.find((item) => item.id === docId);
  const revert = menu.querySelector<HTMLButtonElement>('[data-act="revert"]')!;
  revert.disabled = !doc?.dirty || !doc.path;
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + "px";
}
function hideTabMenu(): void {
  const m = document.getElementById("tab-menu");
  if (m) m.hidden = true;
  tabMenuTarget = null;
}
function initTabMenu(): void {
  const menu = document.getElementById("tab-menu")!;
  menu.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
    if (!btn || !tabMenuTarget) return;
    const act = btn.dataset.act!;
    const target = tabMenuTarget; // read before hiding (hideTabMenu sets it to null; hide first = closing thin air)
    hideTabMenu();
    // bulk close goes through closeDoc one by one in tab-bar order (dirty ones each ask for confirmation, same as Notepad++)
    const idsInOrder = Array.from(document.querySelectorAll("#tabs .tab")).map(
      (el) => (el as HTMLElement).dataset.docId!
    );
    let toClose: string[];
    if (act === "close") toClose = [target];
    else if (act === "close-others") toClose = idsInOrder.filter((id) => id !== target);
    else if (act === "close-right") toClose = idsInOrder.slice(idsInOrder.indexOf(target) + 1);
    else if (act === "close-left") toClose = idsInOrder.slice(0, idsInOrder.indexOf(target));
    else if (act === "close-all") toClose = idsInOrder;
    else if (act === "close-selected") toClose = idsInOrder.filter((id) => tabSel.has(id));
    else if (act === "revert") {
      const doc = docs.find((item) => item.id === target);
      if (!doc?.dirty || !doc.path) return;
      const ok = await confirm("Discard all changes and restore the saved file?", { title: "Revert to saved", kind: "warning" });
      if (!ok) return;
      if (activeDoc()?.id === doc.id) restoreDocValue(doc, doc.base);
      else {
        doc.content = doc.base;
        doc.dirty = false;
        doc.undoStack.length = 0;
        doc.redoStack.length = 0;
        renderTabs();
      }
      return;
    }
    else return;
    for (const id of toClose) await closeDoc(id);
    tabSel.clear();
    renderTabs();
  });
  // clicking anywhere outside the menu closes it (including scrolling / right-clicking elsewhere)
  window.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hideTabMenu();
  });
}

// ===== v0.3.21 custom undo/redo snapshot stack (per doc) =====
// Vditor's internal undo stack has broken granularity in practice: consecutive input merges into one undo unit (one Ctrl+Z wipes everything),
// and the first Ctrl+Z is often swallowed. The custom stack records snapshots on a dual threshold of "input pause (600ms) + per-step character growth (8 chars)"
// (Word-style step-by-step undo: long typing runs / long IME commits are split too), dispatched by Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z.
let snapBase = ""; // content value before the current step started
let snapStepOpen = false; // whether we're inside an unsealed input step
let snapTimer = 0;
function snapReset(doc: Doc | null): void {
  window.clearTimeout(snapTimer);
  snapBase = doc ? doc.content.replace(/\r\n/g, "\n") : ""; // normalise: disk CRLF vs getValue LF
  snapStepOpen = false;
  syncUndoBtns(); // after switching documents the button disabled state follows the new document's stack
}
const SNAP_STEP_MS = 1500; // Word-style editing-session idle window: holding Backspace to delete a heading can exceed 900ms end to end,
// a 600ms window expires mid-deletion and the second half opens a new step (measured: 7 deletions split into 2 steps, root cause of "one undo only restores half a heading").
// Word's real semantics = consecutive edits of the same kind (with nothing in between) form one step, so the window must cover the whole burst.
const SNAP_STEP_CHARS = 8; // per-step character growth threshold: long typing runs / long IME commits are split every ~8 characters,
// otherwise "typing without pausing" merges the whole document into one step and one Ctrl+Z jumps far back (user feedback 2026-08-31)
let restoreFreezeUntil = 0; // freeze window after an undo/redo restore: the afterRender timer triggered by setValue
// fires after the synchronous suppressInput reset and calls options.input / native input — a stray signal would push the just-popped value
// back on the stack and clear redoStack (root cause of "redo button always grey" + the stack's fake self-repair)
function snapOnInput(doc: Doc, cur: string): void {
  if (Date.now() < restoreFreezeUntil) return;
  if (cur === snapBase && !snapStepOpen) return;
  // character-count splitting only applies to growth (typing): deletions shrink and rely on the time window + navigation splitting — measured: deleting a 7-character heading
  // hit the 8-character line exactly and was cut into two steps (a 25-character intermediate state in the stack), root cause of "one undo only restores half a heading"
  // (confirmed by __snapLog t=9548 curLen=25 baseLen=33)
  if (snapStepOpen && cur.length - snapBase.length >= SNAP_STEP_CHARS) {
    snapBase = cur; snapStepOpen = false; // seal when growth hits the threshold; this event continues to "open a new step" below
  }
  if (!snapStepOpen) {
    // a new step opens: the pre-step value goes on the stack (undo restores it); any new input invalidates the redo branch.
    // de-dup on push (not when docUndo pops): Vditor's value after setValue has normalisation differences,
    // popping "empty steps" on the pop side would remove two adjacent steps at once (measured: root cause of one Ctrl+Z jumping to the start + button greyed)
    snapStepOpen = true;
    if (doc.undoStack[doc.undoStack.length - 1] !== snapBase) {
      doc.undoStack.push(snapBase);
      if (doc.undoStack.length > 100) doc.undoStack.shift(); // stack depth limit
    }
    doc.redoStack.length = 0;
    syncUndoBtns();
  }
  window.clearTimeout(snapTimer);
  lastEditSignalAt = Date.now(); // continuing editing session: navigation keys right after don't split the step
  snapTimer = window.setTimeout(() => { snapBase = cur; snapStepOpen = false; }, SNAP_STEP_MS);
}

// ===== v0.3.25 large-document deferred value sync (a DOM-based approximation of Notepad++'s "single data source" idea) =====
// getValue() on a 570k-character document = 465ms per call (Lute DOM → md full serialisation, no cache). The old input chain called it
// 1-2 times per key = nearly 1s block per key. Large documents now: each key only sets dirty + resets a 400ms idle timer, and when idle one
// read backfills everything (doc.content / undo steps / outline). Consumers like save/export/find already fetch the true value on demand, unaffected.
const LARGE_FLUSH_MS = 1500; // must outlast Vditor's internal afterRender debounce (~1s): reading too early returns the pre-edit
// stale cached value (WebView2 measured: getValue 400ms after typing still lacked the new characters, only after 1.5s) — same window as SNAP_STEP_MS
let valueSyncTimer = 0;
let valueSyncPending = false;
function scheduleValueSync(doc: Doc): void {
  window.clearTimeout(valueSyncTimer);
  valueSyncPending = true;
  valueSyncTimer = window.setTimeout(() => flushValueSync(doc), LARGE_FLUSH_MS);
}
function flushValueSync(doc: Doc): void {
  if (!valueSyncPending) return; // nothing pending (used by the 30s autosave's active reconcile branch: idle reading costs nothing)
  window.clearTimeout(valueSyncTimer);
  valueSyncPending = false;
  if (switchApplyPending) return; // no reads during switch loading (see the switchApplyPending comment)
  if (!vditor || activeDoc()?.id !== doc.id) return; // guard: after switching/closing tabs mdValue() already returns
  // another document's content, backfilling would mix documents (switchDoc already saved the leaving document's value itself)
  if (doc.lazy || doc.loading) return; // v0.3.26 lazy loading window: timer fired late, discard
  const v = mdValue();
  if (v !== "" || doc.content === "") doc.content = v; // empty-value guard (same as options.input)
  doc.large = v.length > LARGE_DOC_CHARS; // a small document that grew past the threshold also switches to the deferred channel
  doc.bytes = utf8Bytes(v); // v0.3.26 status-bar size updated on flush
  snapOnInput(doc, v);
  scheduleOutline();
}
// Caret relocation = split step (Word semantics): after deleting a heading, Ctrl+End/clicking elsewhere and deleting again = a new deletion intent, its own step.
// Can't use selectionchange — Backspace at the start of a line removing a paragraph break always makes the caret jump (a result of the deletion, not user intent),
// which would seal by mistake and set snapBase to the post-deletion value, so that deletion never reaches the stack (measured root cause of lost steps).
// Only navigation-key keydown and editor mousedown count, and only >400ms after the last edit signal (prevents IME candidate picking / delete bursts from splitting).
let lastEditSignalAt = 0;
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
function navSealStep(): void {
  if (activeDoc()?.large) return; // v0.3.25 large documents: sealing needs a full mdValue (465ms), stalling on every navigation jump
  // is unacceptable — undo splitting degrades to the pure time window (the 1500ms timer seals on its own), coarser granularity is an accepted trade-off
  if (snapStepOpen) {
    window.clearTimeout(snapTimer);
    snapBase = mdValue(); snapStepOpen = false; // seal: content before the jump becomes its own step
  }
}
document.addEventListener("keydown", (e) => {
  if (!NAV_KEYS.has(e.key)) return;
  if (Date.now() - lastEditSignalAt < 400) return;
  navSealStep();
}, true);
document.addEventListener("mousedown", (e) => {
  const t = e.target as Element | null;
  if (!t?.closest?.(".vditor-reset")) return;
  if (Date.now() - lastEditSignalAt < 400) return;
  navSealStep();
}, true);
// Test hook: CDP synthetic keydown is intercepted by the Vditor element layer (real keyboards are unaffected, proven by the AHK smoke test),
// so e2e calls the functions directly to test the stack logic; keyboard-chain coverage is left to the real AHK input layer.
(window as any).__mdUndo = () => docUndo();
// Test hook: read-only exposure of docs internal state (dirty/base/stack depth) for e2e diagnosis of save-timing issues
Object.defineProperty(window, "__mdDocs", { get: () => docs });
(window as any).__mdRedo = () => docRedo();
// v0.3.21 deletion step splitting + recording fallback (root cause of the user report "deleted three lines, one Ctrl+Z restored two"):
// Vditor handles Backspace/Delete through its own DOM deletion path and fires no native input event — the per-character threshold gets no
// signal, and that path often doesn't even fire the options.input fallback, so deleted content never reached the undo stack (Ctrl+Z skipped steps).
// ① on keydown: >1500ms since the last delete key (same lesson as the 600ms session window: 7 Backspaces at 400ms would be cut in two)
//    with an open step → seal the previous part (a deletion after a long gap = a new deletion intent)
// ② 80ms after keyup: the value changed but no signal opened a step → call snapOnInput to record the step (covers pure DOM deletions)
let lastDelKeyAt = 0;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  if (e.isComposing) return; // Backspace during composition = deleting the pinyin string, leave it to the IME
  const now = Date.now();
  if (now - lastDelKeyAt > 1500 && snapStepOpen && !activeDoc()?.large) { // v0.3.25 skipped for large documents (same as navSealStep: don't pay 465ms to seal)
    window.clearTimeout(snapTimer);
    snapBase = mdValue(); snapStepOpen = false; // seal: content before the deletion becomes its own step
  }
  lastDelKeyAt = now;
  lastEditSignalAt = now; // during a delete burst navigation keys don't split (a deletion right after Ctrl+End is still the same session)
}, true);
document.addEventListener("keyup", (e) => {
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  window.setTimeout(() => {
    if (suppressInput || !vditor) return;
    const doc = activeDoc();
    if (!doc || snapStepOpen) return; // an input signal already opened a step, don't repeat
    if (doc.large) { scheduleValueSync(doc); return; } // v0.3.25 large documents: the deletion fallback uses the deferred channel
    const v = mdValue();
    if (v !== snapBase) snapOnInput(doc, v); // compare with snapBase: doc.content is refreshed by the 30s autosave, using it would miss steps (user measured: button still grey after deleting a heading)
  }, 80);
}, true);
// v0.3.21 Word-style step signal source: native input is reachable per character. Vditor's options.input hangs on its internal
// afterRender timer and is filtered by composingLock, so typing a whole paragraph often merges into one call — character-threshold splitting
// gets no per-character signal there (measured: 10 characters typed with 40ms delay: native input ×10 vs stack depth 1, no split).
// Skipped during composition (IME typing): serialising the intermediate composition state is toxic (pinyin letters leak into mdValue);
// the committed final value is recorded by the options.input fallback (fires after composingLock is released).
document.addEventListener("input", (e) => {
  if (suppressInput) return;
  if (switchApplyPending) return; // v0.3.25 large-document switch loading: discard signals from the old DOM (prevents mixing documents)
  if ((e as InputEvent).isComposing) return;
  const t = e.target as Element | null;
  if (!t?.closest?.(".vditor")) return;
  const doc = activeDoc();
  if (doc && (doc.lazy || doc.loading)) return; // v0.3.26 lazy loading window: discard old-document signals (prevents mixing)
  if (doc && vditor) {
    // v0.3.25 large documents: mdValue per key (465ms at 570k characters) is unbearable — each key only resets the 400ms idle timer (a cheap
    // signal that preserves the sense that "an edit happened"); when idle flushValueSync reads once and backfills (granularity = input burst).
    // dirty is set immediately: options.input hangs on Vditor's afterRender debounce (slower for large documents), a quick tab close can't rely on it
    if (doc.large) { doc.dirty = true; scheduleValueSync(doc); return; }
    snapOnInput(doc, mdValue());
  }
}, true);
// v0.3.21 undo/redo buttons (Word-style dual channel): hijack clicks on Vditor's own buttons to use the custom stack.
// The capture listener sits on .vditor-toolbar (parent capture runs before the button's own listener, so Vditor's internal undo no longer runs).
function setupUndoToolbar(): void {
  const bar = document.querySelector(".vditor-toolbar");
  if (!bar) return;
  if (!(bar as unknown as { __mdUndoBound?: boolean }).__mdUndoBound) {
    (bar as unknown as { __mdUndoBound?: boolean }).__mdUndoBound = true;
    bar.addEventListener("click", (e) => {
      const ty = (e.target as Element | null)?.closest?.("[data-type]")?.getAttribute("data-type");
      if (ty === "undo") { e.preventDefault(); e.stopPropagation(); docUndo(); }
      else if (ty === "redo") { e.preventDefault(); e.stopPropagation(); docRedo(); }
    }, true);
    // Note: a MutationObserver to correct button state was tried — setAttribute with the same value still queues a mutation record,
    // and the syncUndoBtns ↔ observer microtask storm hung the page outright (confirmed), removed.
  }
  syncUndoBtns();
}
function syncUndoBtns(): void { // grey when the stack is empty (Word style)
  const d = activeDoc();
  // dual-channel greying (2026-08-31 user confirmed "redo button always grey while CDP reads disabled=false"):
  // Vditor's disableToolbar/enableToolbar use the CSS class vditor-menu--disabled (visual grey)
  // without setting the disabled attribute; previously only the attribute was set = "JS reads enabled, user sees grey", a read/write split.
  // The attribute blocks clicks (DOM semantics), the class handles visuals — both must move together, and Vditor's leftover class must be removed.
  // querySelectorAll walks every toolbar instance (after a mode/language rebuild old Vditor nodes may linger,
  // syncing only the first gives "live button always grey, unclickable" — user feedback 2026-08-31: redo button not clickable)
  document.querySelectorAll<HTMLButtonElement>('.vditor-toolbar [data-type="undo"]').forEach((u) => {
    u.disabled = !d || d.undoStack.length === 0;
    u.classList.toggle("vditor-menu--disabled", u.disabled);
  });
  document.querySelectorAll<HTMLButtonElement>('.vditor-toolbar [data-type="redo"]').forEach((r) => {
    r.disabled = !d || d.redoStack.length === 0;
    r.classList.toggle("vditor-menu--disabled", r.disabled);
  });
}
function syncUndoBtnsSoon(): void { // async race fallback: refresh once 300ms after undo/redo (if Vditor's internal
  // async tail touches the button state again, this pulls back the true value; one-shot, not resident)
  window.setTimeout(syncUndoBtns, 300);
}
// Reentry de-dup (v0.3.21 root fix for "one Ctrl+Z undoes two steps"): Vditor's processKeydown also responds to ⌘Z/⌘Y and
// forwards them as button clicks (the toolbar capture layer hijacks → docUndo called a second time, confirmed __undoCnt=2 per keydown).
// Repeated calls within the window run only the first — 80ms measured too short (the forwarding chain via Vditor's internal timer can exceed 80ms).
let lastUndoMs = 0, lastRedoMs = 0;
function docUndo(): void {
  const doc = activeDoc();
  if (!doc || !vditor) return;
  const nowMs = Date.now();
  if (nowMs - lastUndoMs < 700) return; // forwarded duplicate of the same keypress, drop it (Vditor's forwarding chain via the afterRender timer measured up to 577ms late)
  lastUndoMs = nowMs;
  const cur = mdValue();
  if (snapStepOpen) { window.clearTimeout(snapTimer); snapBase = cur; snapStepOpen = false; } // seal the current step
  // Note: no popping of "empty steps" on the pop side — after setValue, Vditor's normalised value makes cur always equal the stack top,
  // and a while loop would pop several steps at once (measured: one Ctrl+Z went straight to the start + button greyed). Push-side de-dup is in snapOnInput.
  // skip steps identical to the current text (strict equality only): a no-op undo looked like "nothing happened, caret jumped to the end"
  while (doc.undoStack.length && doc.undoStack[doc.undoStack.length - 1] === cur) doc.undoStack.pop();
  if (doc.undoStack.length === 0) { syncUndoBtns(); return; }
  doc.redoStack.push(cur);
  restoreDocValue(doc, doc.undoStack.pop()!);
  syncUndoBtnsSoon();
}
function docRedo(): void {
  const doc = activeDoc();
  if (!doc || !vditor || doc.redoStack.length === 0) return;
  const nowMs = Date.now();
  if (nowMs - lastRedoMs < 700) return; // duplicate call from Vditor forwarding a button click, drop it
  lastRedoMs = nowMs;
  const cur = mdValue(); // symmetric with docUndo: the current value goes back on the undo stack (snapBase ≠ current value while a step is open)
  if (snapStepOpen) { window.clearTimeout(snapTimer); snapStepOpen = false; }
  while (doc.redoStack.length && doc.redoStack[doc.redoStack.length - 1] === cur) doc.redoStack.pop();
  if (doc.redoStack.length === 0) { syncUndoBtns(); return; }
  doc.undoStack.push(cur);
  restoreDocValue(doc, doc.redoStack.pop()!);
  syncUndoBtnsSoon();
}
function restoreDocValue(doc: Doc, v: string): void {
  const before = mdValue();
  const scrollTop = editorScrollEl()?.scrollTop ?? 0;
  doc.content = v;
  suppressInput = true;
  restoreFreezeUntil = Date.now() + 800; // freeze window covers the async tail of Vditor's afterRender timer
  vditor!.setValue(v, true);
  suppressInput = false;
  snapBase = v;
  doc.dirty = v !== doc.base; // base = on-disk content; undoing back to match the disk = clean
  updateTitle();
  renderTabs();
  scheduleOutline();
  syncUndoBtns();
  // Vditor's setValue re-renders and moves the caret to the end asynchronously; place it after that settles
  const restoreView = () => {
    placeCaretAtChange(before, v);
    const scroller = editorScrollEl();
    if (scroller) scroller.scrollTop = scrollTop;
  };
  restoreView();
  window.setTimeout(restoreView, 0);
  window.setTimeout(restoreView, 180);
}

/** Put the caret where an undo/redo changed the text (Vditor's setValue leaves it at the end of the document).
 *  Maps the md change offset to the rendered DOM by matching the letters/digits that precede it. */
function placeCaretAtChange(before: string, after: string): void {
  if (before === after) return; // nothing changed: leave the caret where it is
  let p = 0;
  const n = Math.min(before.length, after.length);
  while (p < n && before[p] === after[p]) p++;
  let sa = after.length, sb = before.length;
  while (sa > p && sb > p && after[sa - 1] === before[sb - 1]) { sa--; sb--; }
  const end = sa; // caret goes to the end of the restored text
  const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, "");
  const prefix = norm(after.slice(0, end));
  const root = activeEditableArea() || document.querySelector<HTMLElement>("#editor .vditor-reset");
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (nd) => (nd.parentElement?.closest(".vditor-wysiwyg__preview, .vditor-ir__preview, .vditor-toolbar") ? 2 : 1),
  });
  const nodes: Text[] = [];
  const counts: number[] = [];
  for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) {
    nodes.push(nd as Text);
    counts.push(norm((nd as Text).data).length);
  }
  // walk until we've consumed `prefix.length` normalised characters
  let want = prefix.length, node: Text | null = null, off = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (want <= counts[i]) {
      node = nodes[i];
      let seen = 0;
      off = 0;
      while (off < node.data.length && seen < want) {
        if (/[\p{L}\p{N}]/u.test(node.data[off])) seen++;
        off++;
      }
      break;
    }
    want -= counts[i];
  }
  if (!node && nodes.length) { node = nodes[nodes.length - 1]; off = node.data.length; }
  if (!node) return;
  try {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(node, Math.min(off, node.data.length));
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
  } catch { /* node vanished during re-render */ }
}

// v0.3.25 large-document deferred loading: during the double rAF frames the editor still holds the old document's DOM; typing at that moment entering the input chain
// would write the "old DOM serialised value" into the new activeDoc (mixing documents) — edit signals are always dropped during a switch
let switchApplyPending: string | null = null;
let switchSeq = 0; // rapid tab switching: old rAF callbacks must not overwrite later ones
function switchDoc(id: string) {
  hideEmptyState(); // switching to a document with content, hide the empty state
  tabSel.clear(); // a new activation = multi-select is void (opening files from tree/recent/quick open/ES should all clear the selection, v0.3.21)
  document.getElementById("big-load")?.setAttribute("hidden", ""); // a new switch first clears the notice left by an older deferred load
  document.getElementById("big-doc-bar")?.setAttribute("hidden", ""); // v0.3.26 large-document bar hides on switch
  document.getElementById("ext-mod-bar")?.setAttribute("hidden", ""); // the external-change bar is bound to its document, hide when leaving
  extBarDoc = "";
  // save the current document's content to its Doc (getValue guard: empty values don't overwrite)
  if (vditor) {
    const cur = activeDoc();
    if (cur) {
      const v = mdValue();
      if (v !== "" || cur.content === "") cur.content = v;
      if (!cur.lazy) cur.scrollTop = editorScrollEl()?.scrollTop ?? cur.scrollTop; // v0.3.26 reading position saved on leave
    }
  }
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  // v0.3.26 lazy tab: read from disk first, then load normally (loading prevents repeated clicks; during a large-document load activeId already points at it,
  // so renderTabs highlights correctly; after the read finishes it comes back into switchDoc for applyContent)
  if (doc.lazy) {
    activeId = id;
    renderTabs();
    updateTitle();
    void loadLazyDoc(doc);
    return;
  }
  activeId = id;
  scheduleSessionSave(); // v0.3.26 session: active tab changed
  void checkExternalMod(doc); // v0.3.26 external change detection: check on switch (mtime + size)
  const seq = ++switchSeq;
  const applyContent = (): void => {
    switchApplyPending = null;
    if (seq !== switchSeq || activeId !== id || !vditor) return; // taken over by a faster switch
    // Clear the undo/redo stacks when switching documents and use the new document as the only baseline: Vditor's stack is per instance (not per doc),
    // without clearing, a full diff between old and new documents pollutes the stack and one undo reverts the whole content (root cause of "one undo undoes many steps").
    suppressInput = true;
    vditor.setValue(doc.content, true);
    suppressInput = false;
    snapReset(doc); // undo baseline follows the new document (per-doc stack isolation)
    rebuildOutline();
    // v0.3.26 reading position: setValue resets scrolling to zero, so scroll back after loading (session restore uses restoreScroll,
    // normal switching uses the scrollTop saved on leave — otherwise switching back always lands at the top and overwrites the saved position with 0)
    const target = doc.restoreScroll != null ? doc.restoreScroll : doc.scrollTop;
    doc.restoreScroll = null;
    if (target > 0) {
      window.setTimeout(() => { const el = editorScrollEl(); if (el) el.scrollTop = target; }, 0);
    }
    updateStatus(); // v0.3.26 status bar refreshes on document switch (size / selection reset)
  };
  if (doc.large) {
    // v0.3.25 large documents: a synchronous setValue blocks 1-6s (570k characters 1.2s), so show the loading notice first and yield with a double rAF
    // (so the notice paints first) before loading — the user gets feedback while blocked; applyContent clears the notice as a fallback (including when taken over)
    switchApplyPending = id;
    const hint = document.getElementById("big-load");
    if (hint) { hint.textContent = t("bigLoad"); hint.removeAttribute("hidden"); }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      applyContent();
      document.getElementById("big-load")?.setAttribute("hidden", "");
    }));
  } else {
    applyContent();
  }
  renderTabs();
  updateTitle();
  markTreeCurrent(); // the file tree's current-file highlight follows tab switches (tree not reloaded, expansion state kept)
}

// Empty state after all tabs are closed (closing the welcome page is allowed): covers the editor, prompts to open a file
function showEmptyState() {
  document.getElementById("big-load")?.setAttribute("hidden", ""); // clear any leftover large-file loading notice
  document.getElementById("empty-state")!.hidden = false;
  if (vditor) { suppressInput = true; vditor.setValue("", true); suppressInput = false; }
  const ul = document.getElementById("outline");
  if (ul) ul.innerHTML = '<li class="empty">' + esc(t("noOpenFile")) + "</li>";
  updateTitle(); // fallback: make sure the empty state shows "(none)" as the title instead of a stale document name
}
function hideEmptyState() {
  document.getElementById("empty-state")!.hidden = true;
}

async function closeDoc(id: string) {
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const doc = docs[idx];
  if (doc.dirty) {
    const action = await showCloseConfirm(); // three options: save and close / close without saving / cancel
    if (action === "cancel") return;
    if (action === "save") {
      const ok = await saveDoc(doc);
      if (!ok) return; // save failed or Save As cancelled, don't close
    }
  }
  docs.splice(idx, 1);
  if (activeId === id) {
    activeId = null;
    const next = docs[idx] || docs[idx - 1] || null;
    if (next) switchDoc(next.id);
    else showEmptyState(); // all tabs closed: show the empty state (closing the welcome page is allowed, no forced reopen)
  }
  renderTabs();
  scheduleSessionSave(); // v0.3.26 session: tab structure changed
}

function openDoc(path: string | null, content: string, name?: string, encoding?: string) {
  hideEmptyState(); // hide the empty state when opening a document
  closeFind(); // old match nodes are invalid after a document switch, close the find bar
  // Large-file defence (reset after v0.3.25 measurements): v0.3.16's 256KB refusal line came from the old 500KB render freeze;
  // a 2026-09-07 headless benchmark retest could not reproduce it with the current engine (570k characters render in 2.5s, 2.86M characters in 10.9s,
  // nearly linear scaling); the real root cause was the full getValue serialisation per key (465ms) — solved by the large-document deferred channel.
  // New refusal line 2M characters: beyond it typing lags over 400ms and rendering over 8s, not a usable experience. All open paths
  // (tree / recent / quick open / dnd / command line) are intercepted here.
  if (content.length > MAX_OPEN_CHARS) {
    showToast(t("fileTooBig") + bigSizeLabel(content.length) + t("fileTooBigSuf"), "danger");
    return;
  }
  // same path already open → just switch to it, don't open twice
  if (path) {
    const existing = docs.find((d) => d.path === path);
    if (existing) {
      // v0.4.12 user report "double-clicking a file opens it in the middle": external opens (double-click / tree / recent / quick open / ES) clearly
      // mean "from the top", so clear the reading position saved on leaving the tab (including a lazily restored tab's restoreScroll),
      // otherwise the de-dup switch scrolls back to the last position. Keeping the position only serves two cases: clicking the tab bar to switch back, and resuming a session after restart.
      existing.scrollTop = 0;
      existing.restoreScroll = null;
      switchDoc(existing.id);
      // files that are already open still link the tree: clicking an already-open file in "Recent" (e.g. in another folder) must switch the tree root
      const dir = docDirOf(path);
      if (dir && dir.toLowerCase() !== (ftreeRoot || "").toLowerCase()) void locateTreeAt(dir);
      else markTreeCurrent();
      return;
    }
  }
  // v0.5.1 CRLF normalisation: if a CRLF file on disk went into doc.content as is, the editor's getValue is always the LF version
  // → autosaveDirty wrongly sees dirty every round → the file is silently rewritten (CRLF → LF) without edits, overwriting external changes
  // (confirmed 2026-09-21 while integrating the external-change dialog: while the dialog was pending, the blur autosave wrote old content over the new external version).
  // Normalise at the load point, same rule as base / the undo baseline; saving already uses UTF-8 LF, there is no need to write the format back.
  content = content.replace(/\r\n/g, "\n");
  const doc: Doc = {
    id: newDocId(),
    path,
    name: name || (path ? path.split(/[\\/]/).pop()! : t("untitled")),
    content,
    dirty: false,
    encoding: encoding || "",
    undoStack: [],
    redoStack: [],
    base: content.replace(/\r\n/g, "\n"), // same normalisation as snapReset: disk CRLF vs getValue LF, otherwise dirty never clears after undoing everything
    large: content.length > LARGE_DOC_CHARS, // v0.3.25 large-document deferred value channel
    lazy: false,
    loading: false,
    restoreScroll: null,
    scrollTop: 0,
    metaMtime: 0,
    metaSize: 0,
    bytes: utf8Bytes(content),
  };
  docs.push(doc);
  switchDoc(doc.id);
  refreshMeta(doc); // v0.3.26 external change baseline (async, doesn't block opening)
  if (doc.large) showBigDocBar(); // v0.3.26 large-document bar (ir mode has an extra lag warning)
  scheduleSessionSave(); // v0.3.26 session: tab structure changed
  if (path) {
    pushRecent(path);
    // tree root linkage: only rebuild the whole tree when the folder changes (including clicking a file from another folder in "Recent"), same folder just moves the highlight
    const dir = docDirOf(path);
    if (dir && dir.toLowerCase() !== (ftreeRoot || "").toLowerCase()) void locateTreeAt(dir);
    else markTreeCurrent();
  }
}

// ===== v0.3.26 session persistence (same structure as Notepad++ session.xml) + external change detection + status bar =====
// The session is stored in ui-state.json under the session key: { v:1, tabs:[{p,n,s,m,z}], a } —
// p=path n=file name s=scrollTop m=mtime z=size, a=active tab path. Only documents with a path are included
// (untitled/welcome are not restored); on restore the active tab really reads from disk, the rest are lazy placeholders (read only on activation, #9 lazy restore).
interface SessionTab { p: string; n: string; s: number; m: number; z: number }
let sessionSaveTimer = 0;
function utf8Bytes(s: string): number {
  // for the status-bar file size (estimated UTF-8 bytes on disk; only called on low-frequency paths — open/flush/save)
  return new TextEncoder().encode(s).length;
}
function saveSession(): void {
  // documents without a path (untitled/welcome) are not in the session; lazy placeholders are kept too (they have a path, read on activation)
  const active = activeDoc();
  if (active && !active.lazy) active.scrollTop = editorScrollEl()?.scrollTop ?? active.scrollTop;
  const tabs: SessionTab[] = docs
    .filter((d) => !!d.path)
    .map((d) => ({ p: d.path!, n: d.name, s: Math.round(d.scrollTop), m: d.metaMtime, z: d.metaSize }));
  if (tabs.length === 0) { // an empty session is written too (clears the old one: after the user closes everything it should not restore next time)
    if (uiStateAll.session) saveUiStateKey("session", null);
    return;
  }
  saveUiStateKey("session", { v: 1, tabs, a: active?.path || tabs[0].p });
}
function scheduleSessionSave(): void {
  window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = window.setTimeout(saveSession, 800); // debounce: opening/closing tabs in a row writes only once
}

// A lazy placeholder doc reads from disk on activation (switchDoc detects lazy and comes here; afterwards the normal switchDoc path runs)
async function loadLazyDoc(doc: Doc, silent = false): Promise<void> {
  if (doc.loading || !doc.lazy) return;
  doc.loading = true;
  try {
    const [content, enc] = await invoke<[string, string]>("open_file", { path: doc.path });
    if (content.length > MAX_OPEN_CHARS) { // file grew during the session: same refusal line applies
      showToast(t("fileTooBig") + bigSizeLabel(content.length) + t("fileTooBigSuf"), "danger");
      doc.loading = false;
      closeDoc(doc.id);
      return;
    }
    doc.content = content.replace(/\r\n/g, "\n"); // CRLF normalisation (same as openDoc, prevents phantom dirty)
    doc.encoding = enc || "";
    doc.base = doc.content;
    doc.large = doc.content.length > LARGE_DOC_CHARS;
    doc.bytes = utf8Bytes(doc.content);
    doc.dirty = false;
    doc.lazy = false;
    refreshMeta(doc);
    if (doc.large) showBigDocBar();
  } catch (e) {
    // file was deleted/moved: remove the placeholder tab. silent (startup session restore) does not disturb — a batch of N alerts for dead tabs
    // left by tests/cleanup is unacceptable (seen 2026-09-08); a user actively opening it is still told
    doc.loading = false;
    closeDoc(doc.id);
    if (!silent) showToast(t("openFail") + e, "danger");
    return;
  }
  doc.loading = false;
  switchDoc(doc.id); // lazy=false takes the normal load path (restoreScroll is consumed at the end of applyContent)
}

// Startup session restore: success = true (boot skips the welcome page). Not restored when there is a startup file (double-clicking a .md = clear intent)
async function restoreSession(): Promise<boolean> {
  const s = uiStateAll.session as { v?: number; tabs?: SessionTab[]; a?: string } | null | undefined;
  if (!s || !Array.isArray(s.tabs) || s.tabs.length === 0) return false;
  const tabs = s.tabs.filter((x) => x && typeof x.p === "string").slice(0, 20);
  if (tabs.length === 0) return false;
  const activePath = typeof s.a === "string" ? s.a : tabs[0].p;
  let activeId = "";
  for (const tab of tabs) {
    const doc: Doc = {
      id: newDocId(),
      path: tab.p,
      name: tab.n || tab.p.split(/[\\/]/).pop() || t("untitled"),
      content: "",
      dirty: false,
      encoding: "",
      undoStack: [],
      redoStack: [],
      base: "",
      large: false,
      lazy: true, // all built lazy: the active tab then really reads from disk via loadLazyDoc (lazy set to false).
      // never give the active tab lazy:false directly — loadLazyDoc returns at the start on !doc.lazy, leaving the tab empty forever
      loading: false,
      restoreScroll: tab.s > 0 ? tab.s : null,
      scrollTop: tab.s || 0,
      metaMtime: tab.m || 0,
      metaSize: tab.z || 0,
      bytes: 0,
    };
    docs.push(doc);
    if (tab.p === activePath) activeId = doc.id;
  }
  hideEmptyState();
  if (activeId) {
    const d = docs.find((x) => x.id === activeId)!;
    await loadLazyDoc(d, true); // active tab loads synchronously (including the large-document path/defences); silent = dead files cleared quietly
    if (!docs.some((x) => x.id === activeId)) {
      // active tab is dead: other tabs left → activate the first (lazy, switchDoc reads it); none left → treat as no session and open the welcome page
      if (docs.length === 0) return false;
      const next = docs[0];
      activeId = next.id;
      renderTabs();
      updateTitle();
      void loadLazyDoc(next, true);
    }
  }
  return true;
}

// ----- external change detection: mtime + size compared (same structure as N++ originalFileLastModifTimestamp) -----
async function refreshMeta(doc: Doc): Promise<void> {
  if (!doc.path) return;
  try {
    const m = await invoke<{ mtimeMs: number; size: number }>("file_meta", { path: doc.path });
    doc.metaMtime = m.mtimeMs;
    doc.metaSize = m.size;
  } catch { /* file temporarily unreadable: baseline not updated (the next comparison will still notify) */ }
}
let extBarDoc = ""; // the docId the bar currently points at (invalid after a document switch)
let extAsking = false; // external-change dialog reentry lock: focus / the 30s cycle don't stack dialogs while a confirm is pending
// e2e diagnostic hook (same convention as __sLog, read-only): entry and early-return reasons of checkExternalMod/autosaveDirty
(window as unknown as { __cemLog: unknown[] }).__cemLog = (window as unknown as { __cemLog?: unknown[] }).__cemLog || [];
function cemTrace(msg: string): void {
  const l = (window as unknown as { __cemLog: unknown[] }).__cemLog;
  l.push(Date.now() + " " + msg);
  if (l.length > 50) l.splice(0, l.length - 50);
}
async function checkExternalMod(doc: Doc): Promise<void> {
  if (!doc.path || doc.lazy || !vditor) {
    cemTrace(`cem-guard path=${!!doc.path} lazy=${doc.lazy} vditor=${!!vditor}`);
    return;
  }
  cemTrace("cem-pass");
  try {
    const m = await invoke<{ mtimeMs: number; size: number }>("file_meta", { path: doc.path });
    cemTrace(`cem-meta disk=(${m.mtimeMs},${m.size}) doc=(${doc.metaMtime},${doc.metaSize})`);
    if (activeDoc()?.id !== doc.id) return; // switched away by the time the async result came back: no dialog
    const changed = doc.metaMtime !== 0 && (m.mtimeMs !== doc.metaMtime || m.size !== doc.metaSize);
    if (!changed) { cemTrace("cem-unchanged"); return; }
    // v0.5.2 content fallback: a meta change ≠ a content change — the window before the save baseline syncs, touch / same-content rewrite tools
    // only make the mtime/size readings drift. Read the content first and compare with the editor; if identical, quietly align the baseline and return (no dialog, no disturbance),
    // only real differences go on to the dialog/yellow bar flow below.
    try {
      const [raw] = await invoke<[string, string]>("open_file", { path: doc.path });
      if (activeDoc()?.id !== doc.id) return; // switched away by the time the async result came back: no dialog
      if (raw.replace(/\r\n/g, "\n") === doc.content) {
        cemTrace("cem-same-content");
        doc.metaMtime = m.mtimeMs; doc.metaSize = m.size; // align directly with this round's reading, saves a re-read
        return;
      }
      cemTrace("cem-content-diff");
    } catch { cemTrace("cem-read-err"); /* content read failed (locked etc.): fall back to the original flow based on the meta difference */ }
    // v0.5.1 user request: the external-change dialog asks yes/no (yes = load the latest, no = leave it).
    // Applies to the active document without unsaved local changes (when dirty a dialog risks overwriting, so it still uses the yellow bar for manual judgement; inactive tabs likewise, to avoid chained dialogs).
    cemTrace(`cem-changed dirty=${doc.dirty} asking=${extAsking}`);
    if (!doc.dirty && !extAsking) {
      extAsking = true;
      cemTrace("cem-ask-begin");
      let ok = false;
      try {
        ok = (await ask(t("extChanged").replace("{f}", doc.name) + "\n\n" + t("extAskReload"))) === true;
        cemTrace(`cem-ask-resolved ok=${ok}`);
      } catch (e) { cemTrace(`cem-ask-err ${String(e).slice(0, 100)}`); /* dialog failed, fall back to the yellow bar */ }
      extAsking = false;
      if (activeDoc()?.id !== doc.id) return; // switched away during the dialog: leave it to the check on tab switch
      if (ok) { void reloadFromDisk(doc); return; }
      // no = content untouched; the baseline is refreshed to the current disk version to avoid repeated dialogs, the yellow bar stays as a "Reload" way back
      refreshMeta(doc);
      showExtBar(doc, false);
      return;
    }
    showExtBar(doc, false);
  } catch {
    if (activeDoc()?.id === doc.id) showExtBar(doc, true); // file is gone (deleted/moved)
  }
}
function showExtBar(doc: Doc, deleted: boolean): void {
  const bar = document.getElementById("ext-mod-bar");
  if (!bar) return;
  extBarDoc = doc.id;
  bar.hidden = false;
  const msg = document.getElementById("ext-mod-msg")!;
  msg.textContent = deleted
    ? t("extDeleted").replace("{f}", doc.name)
    : (doc.dirty ? t("extChangedDirty") : t("extChanged")).replace("{f}", doc.name);
  const reloadBtn = document.getElementById("ext-reload") as HTMLButtonElement | null;
  if (reloadBtn) reloadBtn.hidden = deleted; // a missing file has no "Reload", only ignore/close
  const disBtn = document.getElementById("ext-dismiss") as HTMLButtonElement | null;
  if (reloadBtn) reloadBtn.textContent = t("extReload");
  if (disBtn) disBtn.textContent = t("extDismiss");
}
async function reloadFromDisk(doc: Doc): Promise<void> {
  try {
    const [raw, enc] = await invoke<[string, string]>("open_file", { path: doc.path });
    if (raw.length > MAX_OPEN_CHARS) { showToast(t("fileTooBig") + bigSizeLabel(raw.length) + t("fileTooBigSuf"), "danger"); return; }
    const content = raw.replace(/\r\n/g, "\n"); // CRLF normalisation (same as openDoc, prevents phantom dirty)
    doc.content = content;
    doc.base = content;
    doc.large = content.length > LARGE_DOC_CHARS;
    doc.bytes = utf8Bytes(content);
    doc.dirty = false;
    doc.encoding = enc || "";
    doc.undoStack = [];
    doc.redoStack = [];
    if (activeDoc()?.id === doc.id) {
      suppressInput = true;
      vditor!.setValue(content, true);
      suppressInput = false;
      snapReset(doc);
      rebuildOutline();
      doc.scrollTop = 0;
    }
    refreshMeta(doc);
  } catch (e) {
    showToast(t("openFail") + e, "danger");
  }
}

// ----- status bar (since v0.3.26; moved to the bottom precision status bar in v0.4.0): selected characters + total words + estimated reading time -----
let counterLen = 0; // cache of the Vditor counter after(len) (used to rebuild the text on selectionchange)
let statusSelLen = 0;
function updateStatus(): void {
  // v0.4.0 the editor's bottom-left counter pill is retired (hidden by CSS, the Vditor counter remains the data source), the text goes into the bottom status bar
  const parts: string[] = [];
  if (statusSelLen > 0) parts.push(t("statusSelected").replace("{n}", String(statusSelLen)));
  parts.push(`${counterLen} ${t("wordCount")}`);
  const sbCount = document.getElementById("sb-count");
  if (sbCount) sbCount.textContent = parts.join(" · ");
  const sbRead = document.getElementById("sb-read");
  if (sbRead) {
    // estimated reading time: about 400 per minute; not shown for empty/very short documents (restraint)
    sbRead.textContent = counterLen >= 200 ? "≈ " + Math.max(1, Math.round(counterLen / 400)) + " " + t("readMin") : "";
  }
}
// v0.4.0 save state (left part of the status bar): dirty = accent "Unsaved", clean = grey "Saved"; hidden without a document
function updateSaveState(): void {
  const el = document.getElementById("sb-save");
  if (!el) return;
  const d = activeDoc();
  if (!d) { el.hidden = true; return; }
  el.hidden = false;
  if (d.dirty) { el.textContent = "● " + t("statusUnsaved"); el.className = "sb-seg dirty"; }
  else { el.textContent = t("statusSaved"); el.className = "sb-seg saved"; }
}
function trackSelectionStatus(): void {
  const sel = getSelection();
  const editable = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!sel || sel.rangeCount === 0 || !editable || !sel.anchorNode || !editable.contains(sel.anchorNode)) {
    if (statusSelLen !== 0) { statusSelLen = 0; updateStatus(); }
    return;
  }
  const n = sel.toString().length;
  if (n !== statusSelLen) { statusSelLen = n; updateStatus(); }
}

// ----- large-document bar (v0.3.26 degraded mode): editing delay explanation + ir mode lag warning -----
function showBigDocBar(): void {
  const bar = document.getElementById("big-doc-bar");
  if (!bar) return;
  const msg = document.getElementById("big-doc-msg")!;
  msg.textContent = currentMode === "ir" ? t("bigDocBarIr") : t("bigDocBar");
  bar.hidden = false;
}

// ----- find/replace history (v0.3.26, 10 entries like N++): persisted in ui-state.json + datalist dropdown -----
const FIND_HISTORY_MAX = 10;
function findHistoryList(key: "findHist" | "repHist"): string[] {
  const v = uiStateAll[key];
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}
function pushFindHistory(key: "findHist" | "repHist", q: string): void {
  q = q.trim();
  if (!q) return;
  const list = findHistoryList(key).filter((x) => x !== q);
  list.unshift(q);
  saveUiStateKey(key, list.slice(0, FIND_HISTORY_MAX));
  renderFindHistory();
}
function renderFindHistory(): void {
  // native datalist dropdown (zero custom UI cost; well supported by WebView2, an empty history with the list attribute has no side effects)
  const mk = (dlId: string, items: string[]) => {
    const dl = document.getElementById(dlId);
    if (!dl) return;
    dl.innerHTML = "";
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it;
      dl.appendChild(o);
    }
  };
  mk("find-hist-dl", findHistoryList("findHist"));
  mk("rep-hist-dl", findHistoryList("repHist"));
}

// ----- info bar button bindings (external change / large document), attached once at boot -----
function initNoticeBars(): void {
  const reloadBtn = document.getElementById("ext-reload");
  if (reloadBtn) reloadBtn.addEventListener("click", () => {
    const bar = document.getElementById("ext-mod-bar");
    const doc = docs.find((d) => d.id === extBarDoc) || null;
    if (bar) bar.hidden = true;
    extBarDoc = "";
    if (doc) void reloadFromDisk(doc);
  });
  const dismissBtn = document.getElementById("ext-dismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", () => {
    const bar = document.getElementById("ext-mod-bar");
    const doc = docs.find((d) => d.id === extBarDoc) || null;
    if (bar) bar.hidden = true;
    extBarDoc = "";
    if (doc) refreshMeta(doc); // "Ignore" = the new disk state becomes the baseline, no repeated dialogs
  });
  const bigClose = document.getElementById("big-doc-close");
  if (bigClose) bigClose.addEventListener("click", () => {
    document.getElementById("big-doc-bar")?.setAttribute("hidden", "");
  });
}

// ===== v0.3.14 sidebar Files tab (file tree / recent / cross-file search) + quick open + dark theme =====

// ui-state.json is read/written with full merges: zoom/theme/recent share one file. Previously persistZoom wrote only {zoom}
// as a single-key overwrite; after adding theme/recent writes must merge, otherwise each wipes the others' keys.
let uiStateAll: Record<string, unknown> = {};
let uiStateSaveTimer = 0;
let uiStateLoaded = false; // no disk writes before load_ui_state returns (so boot-time applyZoom with {zoom:1} doesn't overwrite the disk theme/recent)
function saveUiStateKey(key: string, val: unknown): void {
  uiStateAll[key] = val;
  if (!uiStateLoaded) return;
  window.clearTimeout(uiStateSaveTimer);
  uiStateSaveTimer = window.setTimeout(() => {
    invoke("save_ui_state", { v: { ...uiStateAll } }).catch(() => { /* a failed save doesn't block the UI */ });
  }, 150);
}

// ----- recent files (recorded on open, de-duplicated and moved to the top, 40 kept) -----
function applyAppAssets(): void {
  document.querySelectorAll<HTMLImageElement>("img[data-app-icon]").forEach((img) => {
    const name = img.dataset.appIcon as keyof typeof APP_ASSETS | undefined;
    const src = name ? APP_ASSETS[name] : undefined;
    if (src) img.src = src;
  });
}

function recentList(): string[] {
  const r = uiStateAll.recent;
  return Array.isArray(r) ? (r as unknown[]).filter((x): x is string => typeof x === "string") : [];
}
function pushRecent(path: string): void {
  const list = recentList().filter((p) => p !== path);
  list.unshift(path);
  saveUiStateKey("recent", list.slice(0, 40));
  renderRecent();
}
function renderRecent(): void {
  const list = recentList().slice(0, 40);
  const buildRows = (ul: HTMLElement, rows: string[], compact: boolean) => {
    ul.innerHTML = "";
    if (rows.length === 0) {
      ul.innerHTML = `<li class="empty">${esc(t("quickOpenEmpty"))}</li>`;
      return;
    }
    for (const p of rows) {
      const li = document.createElement("li");
      const name = p.split(/[\\/]/).pop() || p;
      li.innerHTML = compact
        ? `<span class="rn">${esc(name)}</span>`
        : `<span class="rn">${esc(name)}</span><span class="rp">${esc(p)}</span>`;
      li.title = p;
      li.addEventListener("click", () => {
        closeBrandUi();
        void loadFile(p);
      });
      ul.appendChild(li);
    }
  };
  const preview = document.getElementById("brand-recent-preview");
  const expanded = document.getElementById("brand-recent-list");
  if (preview) buildRows(preview, list.slice(0, 4), true);
  if (expanded) buildRows(expanded, list, false);
}

function closeBrandUi(): void {
  const wrap = document.getElementById("brand-wrap");
  const menu = document.getElementById("brand-menu") as HTMLElement | null;
  if (menu) menu.hidden = true;
  document.getElementById("brand-send-submenu")?.setAttribute("hidden", "");
  document.getElementById("brand-recent-submenu")?.setAttribute("hidden", "");
  document.getElementById("send-menu")?.setAttribute("hidden", "");
  wrap?.classList.remove("submenu-open");
  document.getElementById("btn-brand-menu")?.setAttribute("aria-expanded", "false");
  document.getElementById("brand-send")?.setAttribute("aria-expanded", "false");
  document.getElementById("brand-recents-toggle")?.setAttribute("aria-expanded", "false");
}

let favoriteRenderToken = 0;
let favoritesTreeActive = false;
function renderFavoriteList(): void {
  const host = document.getElementById("favorites-tree");
  if (!host) return;
  const token = ++favoriteRenderToken;
  host.innerHTML = "";
  const favorites = loadFavorites().filter((favorite) => {
    const segments = favorite.path.replace(/[\\/]+$/, "").split(/[\\/]/);
    const isFile = /\.(md|markdown|mdown|txt|pdf|docx?|xlsx?|png|jpe?g|gif|webp|bmp|svg|ico|exe|lnk|zip)$/i.test(favorite.path);
    return favorite.scope !== "off" && !isFile && !segments.some((segment) => segment.startsWith("."));
  });
  host.hidden = favorites.length === 0;
  const groups = new Map<string, typeof favorites>();
  for (const favorite of favorites) {
    const category = favorite.category || "Favorites";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(favorite);
  }
  const createFolder = (entry: TreeEntry, depth: number, expandable: boolean): HTMLElement => {
    const row = document.createElement("div");
    row.className = "node dir favorite-folder";
    row.dataset.path = entry.path;
    row.style.paddingLeft = `${6 + depth * 14}px`;
    row.innerHTML = `<span class="caret"></span><span class="nname" title="${esc(entry.path)}">${esc(entry.name)}</span>`;
    attachFolderIcon(row, entry.path);
    if (expandable) row.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (row.classList.contains("open")) { collapseNode(row); return; }
      row.classList.add("open");
      const kids = document.createElement("div"); kids.className = "kids";
      row.after(kids);
      try {
        const entries = await invoke<TreeEntry[]>("list_md_dir", { path: entry.path });
        if (token !== favoriteRenderToken || !host.contains(row)) return;
        const folders = entries.filter((child) => child.is_dir);
        if (!folders.length) { kids.remove(); row.classList.remove("open"); return; }
        for (const child of folders) kids.append(createFolder(child, depth + 1, true));
      } catch { kids.remove(); row.classList.remove("open"); }
    });
    return row;
  };
  for (const [category, items] of groups) {
    const group = document.createElement("div");
    group.className = "favorite-group";
    const title = document.createElement("div");
    title.className = "favorite-category";
    title.textContent = category;
    group.append(title);
    for (const favorite of items) {
      group.append(createFolder({ name: favorite.label, path: favorite.path, is_dir: true }, 0, favorite.scope === "children"));
    }
    host.append(group);
  }
}

// ----- file tree (v0.3.17 permanent tree = Explorer left-pane pattern): "This PC" + the drive list always sit at the top of the tree,
// clicking a drive/folder = lazy expand in place (no more whole-tree replacement — user feedback "after entering a drive the other drives disappear and I can't go back");
// address bar / ↑ / open linkage = locate-expand (expand level by level along the path to the target folder). -----
type TreeEntry = { name: string; path: string; is_dir: boolean };
const folderIconCache = new Map<string, Promise<string | null>>();
function attachFolderIcon(row: HTMLElement, path: string): void {
  const icon = document.createElement("img");
  icon.className = "folder-icon";
  icon.alt = "";
  icon.src = APP_ASSETS.assetsFolder;
  icon.onerror = () => { icon.onerror = null; icon.src = APP_ASSETS.assetsFolder; };
  const key = path.toLowerCase();
  let request = folderIconCache.get(key);
  if (!request) {
    request = invoke<string | null>("folder_custom_icon", { path }).catch(() => null);
    folderIconCache.set(key, request);
  }
  void request.then((custom) => {
    if (!custom || !row.isConnected) return;
    try { icon.src = convertFileSrc(custom); } catch { /* keep the bundled fallback */ }
  });
  row.insertBefore(icon, row.querySelector(".nname"));
}
function docDirOf(p: string | null): string | null {
  if (!p) return null;
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : null;
}
let ftreeToken = 0; // concurrency guard: a slow folder result is discarded if a newer refresh has started
let ftreeRoot: string | null = null; // current tree root; the whole tree is rebuilt when the folder changes (navigation / open-file linkage)
function makeTreeNode(e: TreeEntry, depth: number): HTMLElement {
  const node = document.createElement("div");
  const editable = /\.(md|markdown|mdown|txt)$/i.test(e.path);
  const markdownFile = /\.(md|markdown|mdown)$/i.test(e.path);
  node.className = "node " + (e.is_dir ? "dir" : "file") + (!e.is_dir && !editable ? " fx" : "") + (markdownFile ? " md-file" : "");
  node.dataset.path = e.path;
  node.dataset.depth = String(depth);
  node.style.paddingLeft = 6 + depth * 14 + "px";
  node.innerHTML =
    `<span class="caret"></span>` + // v0.3.16 arrow is a CSS triangle (glyph rendering differs between environments)
    `<span class="nname" title="${esc(e.path)}">${esc(e.name)}</span>`;
  if (e.is_dir) attachFolderIcon(node, e.path);
  node.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!e.is_dir) {
      // v0.3.21: the tree lists all files — clicking a non-editable extension = show in folder (consistent with the three-way routing of drive-wide results)
      if (editable) loadFile(e.path);
      else invoke("reveal_path", { path: e.path }).catch(() => { /* fail silently */ });
      return;
    }
    if (node.classList.contains("open")) collapseNode(node);
    else void expandNode(node);
  });
  node.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openFtreeMenu(e.path, e.is_dir, ev.clientX, ev.clientY);
  });
  return node;
}
/** Collapse a folder node */
function collapseNode(node: HTMLElement): void {
  node.classList.remove("open");
  const kids = node.nextElementSibling as HTMLElement | null;
  if (kids && kids.classList.contains("kids")) kids.hidden = true;
}
/** Expand a folder node (lazy-loads children; force = re-read even if loaded, used after create/delete/rename) */
async function expandNode(node: HTMLElement, force = false): Promise<void> {
  node.classList.add("open");
  let kids = node.nextElementSibling as HTMLElement | null;
  if (!kids || !kids.classList.contains("kids")) {
    kids = document.createElement("div");
    kids.className = "kids";
    node.after(kids);
  }
  kids.hidden = false;
  if (!kids.dataset.loaded || force) {
    kids.dataset.loaded = "1";
    await ftreeKids(kids, node.dataset.path!, parseInt(node.dataset.depth || "1", 10) + 1);
  }
}
async function ftreeKids(container: HTMLElement, dirPath: string, depth: number): Promise<void> {
  const tok = ftreeToken;
  let entries: TreeEntry[] = [];
  try {
    entries = await invoke<TreeEntry[]>("list_md_dir", { path: dirPath });
  } catch { /* no permission / deleted: leave empty */ }
  if (tok !== ftreeToken) return;
  container.innerHTML = "";
  if (entries.length === 0) {
    container.innerHTML = `<div class="empty">${esc(t("gsearchNone"))}</div>`;
    return;
  }
  for (const e of entries) container.appendChild(makeTreeNode(e, depth));
  applyTreeFilter();
  markTreeCurrent();
}
/** Case-insensitive lookup of a folder/file node in the tree */
function findTreeNode(path: string): HTMLElement | null {
  const low = path.toLowerCase();
  let hit: HTMLElement | null = null;
  document.querySelectorAll("#ftree .node").forEach((n) => {
    if (!hit && (n as HTMLElement).dataset.path && (n as HTMLElement).dataset.path!.toLowerCase() === low) hit = n as HTMLElement;
  });
  return hit;
}
/** File-name filter (reapplied after a tree reload without clearing the filter box — same as the outline filter) */
function applyTreeFilter(): void {
  const fi = document.getElementById("ftree-filter") as HTMLInputElement | null;
  if (!fi) return;
  const q = fi.value.trim().toLowerCase();
  document.querySelectorAll("#ftree .node").forEach((n) => {
    const txt = (n.textContent || "").toLowerCase();
    (n as HTMLElement).style.display = !q || txt.includes(q) ? "" : "none";
  });
}
/** Permanent top-of-tree structure (built once; drive nodes = normal dir nodes, lazily expandable in place) */
function buildPcTree(): void {
  const box = document.getElementById("ftree");
  if (!box) return;
  ftreeToken++;
  ftreeRoot = null;
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement | null;
  if (pathInp) pathInp.value = "";
  const head = document.createElement("div");
  head.className = "node dir open";
  head.innerHTML = `<span class="caret open"></span><span class="nname">${esc(t("drivesRoot"))}</span>`;
  const kids = document.createElement("div");
  kids.className = "kids";
  box.innerHTML = "";
  box.appendChild(head);
  box.appendChild(kids);
  const tok = ftreeToken;
  invoke<TreeEntry[]>("list_drives").then((drives) => {
    if (tok !== ftreeToken) return;
    for (const d of drives) {
      const node = makeTreeNode({ name: d.name, path: d.path, is_dir: true }, 1);
      kids.appendChild(node);
    }
    markTreeCurrent();
  }).catch(() => { /* enumeration failed: leave empty */ });
}
let locateSeq = 0; // locate concurrency guard: a later locate cancels the earlier expansion chain
/** Locate-expand (navigation entry: ↑ parent / address bar Enter / open-file linkage / refresh):
 *  expands level by level from the drive along the path to the target folder, fills the address bar, highlights the target and scrolls it into view. */
async function locateTreeAt(dir: string): Promise<void> {
  const seq = ++locateSeq;
  ftreeRoot = dir;
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement | null;
  if (pathInp) pathInp.value = dir;
  // tree not built (boot should have built it, fallback): build it first and wait for the drive nodes
  if (!document.querySelector("#ftree .node.dir[data-path]")) buildPcTree();
  for (let i = 0; i < 40; i++) {
    if (locateSeq !== seq) return;
    if (document.querySelector("#ftree .node.dir[data-path]")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const norm = dir.replace(/\//g, "\\").replace(/\\+$/, "");
  const segs = norm.split("\\");
  let cur = segs[0] + "\\"; // drive root
  let node = findTreeNode(cur);
  if (!node) return; // drive does not exist (removed etc.)
  await expandNode(node);
  for (let i = 1; i < segs.length; i++) {
    if (locateSeq !== seq) return;
    cur += segs[i];
    const next = findTreeNode(cur);
    if (!next) break; // a level is missing midway (no permission / deleted): stop at the deepest reachable level
    await expandNode(next);
    node = next;
    cur += "\\";
  }
  if (locateSeq !== seq) return;
  document.querySelectorAll("#ftree .node.cur-dir").forEach((n) => n.classList.remove("cur-dir"));
  node.classList.add("cur-dir");
  node.scrollIntoView({ block: "nearest" });
}
/** Reload folder contents (after create/delete/rename): node present = force re-read its kids; absent = locate-expand (expanding the parent chain too) */
async function reloadDir(dir: string): Promise<void> {
  const node = findTreeNode(dir);
  if (node && node.classList.contains("dir")) await expandNode(node, true);
  else await locateTreeAt(dir);
}
function refreshFileTree(): void {
  const dir = docDirOf(activeDoc()?.path || null);
  buildPcTree(); // rebuild the permanent tree (drops the old expansion state, starts at the drive level)
  if (dir) void locateTreeAt(dir); // with a document = locate its folder
}
// current-file highlight: switching tabs only moves the highlight class, no tree reload (keeps the expansion state)
function markTreeCurrent(): void {
  const cur = activeDoc()?.path || "";
  document.querySelectorAll("#ftree .node.file").forEach((n) => {
    n.classList.toggle("cur", (n as HTMLElement).dataset.path === cur);
  });
}

// ===== v0.3.18 Everything drive-wide file-name search (es.exe IPC, shares the filter box with the tree filter) =====
type EsHit = { path: string; is_dir: boolean };
let esToken = 0;
let esDebounce = 0;
/** Start a drive-wide search 300ms after filter-box input settles (continuous typing only sends the last one) */
function scheduleEsSearch(): void {
  const inp = document.getElementById("ftree-filter") as HTMLInputElement | null;
  const ul = document.getElementById("es-results");
  if (!inp || !ul) return;
  window.clearTimeout(esDebounce);
  const q = inp.value.trim();
  if (!q) { ul.hidden = true; ul.innerHTML = ""; return; }
  esDebounce = window.setTimeout(() => void runEsSearch(q), 300);
}
async function runEsSearch(q: string): Promise<void> {
  const ul = document.getElementById("es-results");
  if (!ul) return;
  const tok = ++esToken;
  ul.hidden = false;
  ul.innerHTML = `<li class="empty">${esc(t("esSearching"))}</li>`;
  let hits: EsHit[];
  try {
    hits = await invoke<EsHit[]>("es_search", { query: q, limit: 50 });
  } catch (e) {
    if (tok !== esToken) return;
    const msg = String(e);
    // v0.3.22 custom index: while not ready Rust returns INDEX_BUILDING:<scanned count> (the first index build takes 1-3 minutes)
    const m = msg.match(/^INDEX_BUILDING:(\d+)$/);
    ul.innerHTML = `<li class="empty">${esc(
      m ? t("esIndexing").replace("{n}", Number(m[1]).toLocaleString())
        : t("esFail"))}</li>`;
    return;
  }
  if (tok !== esToken) return; // a newer search has started, this result is void
  if (hits.length === 0) {
    ul.innerHTML = `<li class="empty">${esc(t("esNone"))}</li>`;
    return;
  }
  ul.innerHTML = "";
  for (const h of hits) {
    const li = document.createElement("li");
    li.dataset.path = h.path;
    li.title = h.path;
    const i = Math.max(h.path.lastIndexOf("\\"), h.path.lastIndexOf("/"));
    const name = i >= 0 ? h.path.slice(i + 1) : h.path;
    const parent = i > 0 ? h.path.slice(0, i) : "";
    li.innerHTML = `<span class="ef">${h.is_dir ? "📁 " : ""}${esc(name)}</span><span class="es-split" title="${esc(t("esSplitTip"))}"></span><span class="ep">${esc(parent)}</span>`;
    li.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest(".es-split")) return; void esHitOpen(h); });
    li.addEventListener("dblclick", (e) => { if ((e.target as HTMLElement).closest(".es-split")) return; void esLocateTree(h); });
    ul.appendChild(li);
  }
}
/** Double-clicking a drive-wide hit = locate in the tree (v0.3.21 user request): file = expand along the path to its folder and highlight the file node; folder = locate and expand its contents */
async function esLocateTree(h: EsHit): Promise<void> {
  switchSidePane("files"); // the locate action must happen on the Files tab to be visible
  if (h.is_dir) {
    await locateTreeAt(h.path);
    const n = findTreeNode(h.path);
    if (n && n.classList.contains("dir")) await expandNode(n);
  } else {
    const dir = docDirOf(h.path);
    if (dir) await locateTreeAt(dir);
    const n = findTreeNode(h.path);
    if (n) {
      n.scrollIntoView({ block: "nearest" });
      n.classList.add("cur"); // manually highlight the target file (markTreeCurrent only knows the active document)
      window.setTimeout(() => n.classList.remove("cur"), 4000); // temporary highlight fades after 4s
    }
  }
}
/** Column resizing (v0.3.20): dragging any row's divider = the whole list's name column widens/narrows together (width stored as a ul variable), persisted + double-click to reset */
function setupEsSplitter(): void {
  const ul = document.getElementById("es-results");
  if (!ul || (ul as any).__splitterReady) return;
  (ul as any).__splitterReady = true;
  const saved = prefGet("mdes-name-w");
  if (saved) ul.style.setProperty("--es-name-w", saved);
  let dragging = false;
  ul.addEventListener("mousedown", (e) => {
    const sp = (e.target as HTMLElement).closest(".es-split");
    if (!sp) return;
    e.preventDefault();
    dragging = true;
    const x0 = e.clientX;
    const w0 = (ul.querySelector(".ef") as HTMLElement | null)?.offsetWidth ?? Math.round(ul.clientWidth * 0.45);
    const maxW = ul.clientWidth - 60; // the path column keeps at least 60px (drive-level tail); for more width drag the sidebar wider first (side-gutter)
    const mv = (ev: MouseEvent) => {
      const w = Math.min(Math.max(w0 + ev.clientX - x0, 60), Math.max(maxW, 60));
      ul.style.setProperty("--es-name-w", `${w}px`);
    };
    const up = () => {
      dragging = false;
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      prefSet("mdes-name-w", ul.style.getPropertyValue("--es-name-w"));
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });
  // double-click the divider = reset to the default 45%
  ul.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest(".es-split")) return;
    ul.style.removeProperty("--es-name-w");
    prefRemove("mdes-name-w");
  });
  // suppress the row click after dragging (so a drag doesn't open a file by mistake)
  ul.addEventListener("click", (e) => {
    if (dragging) { e.stopImmediatePropagation(); dragging = false; }
  }, true);
}
/** Routing a drive-wide hit click: text files = open for editing; folders = locate in tree; others = show in Explorer */
async function esHitOpen(h: EsHit): Promise<void> {
  if (h.is_dir) {
    switchSidePane("files");
    void locateTreeAt(h.path);
    return;
  }
  if (/\.(md|markdown|mdown|txt)$/i.test(h.path)) {
    loadFile(h.path);
    return;
  }
  invoke("reveal_path", { path: h.path }).catch(() => { /* Explorer failed, silent */ });
}

// ===== v0.3.17 file tree context menu: new MD/TXT/folder, rename, delete, Explorer, copy path =====
let ftreeMenuPath: string | null = null; // context-menu target; null = empty tree area (new items go in the currently located folder ftreeRoot)
let ftreeMenuIsDir = false;
function hideFtreeMenu(): void {
  const m = document.getElementById("ftree-menu");
  if (m) m.hidden = true;
  ftreeMenuPath = null;
}
function openFtreeMenu(path: string | null, isDir: boolean, x: number, y: number): void {
  const menu = document.getElementById("ftree-menu")!;
  ftreeMenuPath = path;
  ftreeMenuIsDir = isDir;
  const show = (act: string, on: boolean) => {
    const b = menu.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
    if (b) b.hidden = !on;
  };
  const isDriveRoot = !!path && /^[A-Za-z]:\\?$/.test(path);
  show("open", !!path && !isDir); // files only
  show("new-md", !path || isDir); // folder/empty area: create inside it (drive root = create at the drive root, allowed)
  show("new-txt", !path || isDir);
  show("new-dir", !path || isDir);
  show("rename", !!path && !isDriveRoot); // drive roots can't be renamed/deleted
  show("delete", !!path && !isDriveRoot);
  show("reveal", !!path);
  show("copy-path", !!path);
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + "px";
}
/** #ftree-modal has two uses: ask for a name (input=true, Enter confirms / Esc cancels) or confirm (input=false). resolve null = cancelled */
function ftreeAsk(opts: { title: string; msg?: string; input?: boolean; initial?: string; okText?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = document.getElementById("ftree-modal")!;
    const input = document.getElementById("ftree-modal-input") as HTMLInputElement;
    const msg = document.getElementById("ftree-modal-msg")!;
    const okBtn = document.getElementById("ftree-modal-ok") as HTMLButtonElement;
    const cancelBtn = document.getElementById("ftree-modal-cancel") as HTMLButtonElement;
    document.getElementById("ftree-modal-title")!.textContent = opts.title;
    okBtn.textContent = opts.okText || t("fmOk");
    msg.hidden = !opts.msg;
    if (opts.msg) msg.textContent = opts.msg;
    input.hidden = !opts.input;
    if (opts.input) {
      input.value = opts.initial || "";
      input.placeholder = t("fmNamePh");
    }
    mask.hidden = false;
    if (opts.input) { input.focus(); input.select(); }
    const done = (v: string | null) => {
      mask.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(opts.input ? input.value.trim() : ""); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    };
    okBtn.onclick = () => done(opts.input ? input.value.trim() : "");
    cancelBtn.onclick = () => done(null);
  });
}
/** Force close (no save prompt): the file was deleted, there is nowhere to save the content */
function forceCloseDoc(id: string): void {
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  docs.splice(idx, 1);
  if (activeId === id) {
    activeId = null;
    const next = docs[idx] || docs[idx - 1] || null;
    if (next) switchDoc(next.id);
    else showEmptyState();
  }
  renderTabs();
}
/** Close every document whose path == target or lies under the target folder (cascades when a folder is deleted) */
function forceCloseDocsUnder(path: string): void {
  const low = path.toLowerCase();
  const dead = docs.filter((d) => {
    if (!d.path) return false;
    const p = d.path.toLowerCase();
    return p === low || p.startsWith(low + "\\");
  });
  for (const d of dead) forceCloseDoc(d.id);
  markTreeCurrent();
}
/** Rename linkage for open documents: path/name updated (folder rename = prefix replace, child files follow), dirty kept (content unchanged, saving goes to the new path) */
function handleRenamed(oldPath: string, newPath: string): void {
  const low = oldPath.toLowerCase();
  for (const d of docs) {
    if (!d.path) continue;
    const p = d.path.toLowerCase();
    if (p === low) {
      d.path = newPath;
      d.name = newPath.split(/[\\/]/).pop()!;
    } else if (p.startsWith(low + "\\")) {
      d.path = newPath + d.path.slice(oldPath.length);
    }
  }
  // the located folder itself or an ancestor was renamed: the address bar follows
  const fr = (ftreeRoot || "").toLowerCase();
  if (fr === low) ftreeRoot = newPath;
  else if (fr.startsWith(low + "\\")) ftreeRoot = newPath + (ftreeRoot || "").slice(oldPath.length);
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement | null;
  if (pathInp && ftreeRoot) pathInp.value = ftreeRoot;
  renderTabs();
  updateTitle();
  const dir = docDirOf(newPath);
  if (dir) void reloadDir(dir);
  markTreeCurrent();
  // review m3 (v0.4.11b) consolidation: the recent list paths follow (prevents openFail on dead-path clicks) + session tab paths follow
  // (previously only the tab double-click entry saved the session and the tree context-menu entry didn't — the two entries diverged, unified in this function)
  saveUiStateKey("recent", recentList().map((p) => {
    const pl = p.toLowerCase();
    if (pl === low) return newPath;
    if (pl.startsWith(low + "\\")) return newPath + p.slice(oldPath.length); // folder rename: child file paths follow
    return p;
  }));
  renderRecent();
  scheduleSessionSave();
}
function copyTextToClipboard(text: string): void {
  const done = () => showToast(t("fmCopyDone") + " " + text, "success");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { /* silent */ }
  ta.remove();
}
function initFtreeMenu(): void {
  const menu = document.getElementById("ftree-menu")!;
  // right-click on the empty tree area: new item (base = the currently located folder)
  const box = document.getElementById("ftree");
  if (box) box.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".node")) return; // the node itself already handled it
    e.preventDefault();
    openFtreeMenu(null, false, e.clientX, e.clientY);
  });
  menu.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
    if (!btn || btn.hidden) return;
    const path = ftreeMenuPath; // read before hiding
    const isDir = ftreeMenuIsDir;
    hideFtreeMenu();
    const act = btn.dataset.act!;
    // folder base for each action: folder right-click = inside it; file right-click = its folder; empty area = located folder
    const baseDir = path ? (isDir ? path : docDirOf(path)) : ftreeRoot;
    const parentDir = path ? docDirOf(path) : null;
    try {
      if (act === "open" && path) { loadFile(path); return; }
      if (act === "new-md" || act === "new-txt") {
        if (!baseDir) { showToast(t("fmNoBase"), "info"); return; }
        const kind = act === "new-txt" ? "txt" : "md";
        const title = kind === "txt" ? t("fmNewTxtTitle") : t("fmNewMdTitle");
        const name = await ftreeAsk({ title, input: true, initial: kind === "txt" ? "Untitled.txt" : t("untitledMd") });
        if (!name) return;
        const full = await invoke<string>("create_text_file", { dir: baseDir, name, kind });
        await reloadDir(baseDir);
        loadFile(full); // open the newly created file for editing right away
        return;
      }
      if (act === "new-dir") {
        if (!baseDir) { showToast(t("fmNoBase"), "info"); return; }
        const name = await ftreeAsk({ title: t("fmNewDirTitle"), input: true, initial: t("untitledDir") });
        if (!name) return;
        await invoke<string>("create_dir", { dir: baseDir, name });
        await reloadDir(baseDir);
        return;
      }
      if (act === "rename" && path) {
        const cur = path.split(/[\\/]/).pop()!;
        const newName = await ftreeAsk({ title: t("fmRenameTitle"), input: true, initial: cur });
        if (!newName || newName === cur) return;
        const newPath = await invoke<string>("rename_entry", { old: path, newName });
        handleRenamed(path, newPath);
        return;
      }
      if (act === "delete" && path) {
        const okGo = await ftreeAsk({ title: t("fmDelTitle"), msg: isDir ? t("fmDelDirMsg") : t("fmDelFileMsg"), okText: t("fmDelete") });
        if (okGo === null) return; // null = cancelled; "" = confirmed (confirm without input returns an empty string)
        await invoke("delete_entry", { path });
        forceCloseDocsUnder(path);
        if (parentDir) await reloadDir(parentDir);
        return;
      }
      if (act === "reveal" && path) { invoke("reveal_path", { path }); return; }
      if (act === "copy-path" && path) { copyTextToClipboard(path); return; }
    } catch (err) {
      showToast(String(err), "danger"); // Rust-side Err (duplicate / illegal name / permissions etc.) shown directly
    }
  });
  // clicking anywhere outside the menu closes it
  window.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hideFtreeMenu();
  });
}

// ----- cross-file search: Ctrl+Shift+F focuses the input, Enter searches all text files in the current document's folder -----
type SearchHit = { file: string; line_no: number; line_text: string };
let gsearchToken = 0;
function runGlobalSearch(): void {
  const inp = document.getElementById("gsearch-input") as HTMLInputElement | null;
  const ul = document.getElementById("gsearch-results");
  if (!inp || !ul) return;
  const q = inp.value.trim();
  // v0.3.17 per the user's meaning: "sibling files" = the folder of the currently open file first; without a document fall back to the tree's located folder
  const dir = docDirOf(activeDoc()?.path || null) || ftreeRoot;
  ul.innerHTML = "";
  ul.hidden = !q; // without a keyword the whole block collapses (takes no space above the tree)
  if (!q) return;
  if (!dir) { ul.hidden = false; ul.innerHTML = `<li class="empty">${esc(t("gsearchNoDoc"))}</li>`; return; }
  ul.hidden = false;
  ul.innerHTML = `<li class="empty">…</li>`;
  const tok = ++gsearchToken;
  invoke<SearchHit[]>("search_md_files", { root: dir, query: q }).then((hits) => {
    if (tok !== gsearchToken) return;
    ul.hidden = false;
    ul.innerHTML = "";
    if (hits.length === 0) {
      ul.innerHTML = `<li class="empty">${esc(t("gsearchNone"))}</li>`;
      return;
    }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const h of hits) {
      const li = document.createElement("li");
      const name = h.file.split(/[\\/]/).pop() || h.file;
      const marked = esc(h.line_text).replace(rx, (m) => `<mark>${m}</mark>`);
      li.innerHTML = `<span class="gf">${esc(name)}</span><span class="gl">${h.line_no}</span><span class="gt">${marked}</span>`;
      li.title = h.file + ":" + h.line_no;
      li.addEventListener("click", () => {
        // after opening the target file, reuse the find bar to locate the first match (highlight/jump/replace chain all reused)
        const go = () => {
          openFind(false);
          const fi = document.getElementById("find-input") as HTMLInputElement;
          fi.value = q;
          refreshFind(true);
          gotoMatch(0);
          fi.focus();
          fi.select();
        };
        if (activeDoc()?.path === h.file) go();
        else loadFile(h.file).then(go);
      });
      ul.appendChild(li);
    }
  }).catch((e) => {
    if (tok !== gsearchToken) return;
    ul.innerHTML = `<li class="empty">${esc(String(e)).slice(0, 80)}</li>`;
  });
}

// ----- quick open (Ctrl+Shift+O): fuzzy filter over recent files, ↑↓ to select, Enter to open -----
let qoSel = 0;
let qoFiltered: string[] = [];
function renderQoList(): void {
  const ul = document.getElementById("qo-list");
  if (!ul) return;
  ul.innerHTML = "";
  if (qoFiltered.length === 0) {
    ul.innerHTML = `<li class="empty">${esc(t("quickOpenEmpty"))}</li>`;
    return;
  }
  qoSel = Math.min(Math.max(qoSel, 0), qoFiltered.length - 1);
  qoFiltered.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === qoSel) li.classList.add("sel");
    const name = p.split(/[\\/]/).pop() || p;
    li.innerHTML = `<span class="rn">${esc(name)}</span><span class="rp">${esc(p)}</span>`;
    li.title = p;
    li.addEventListener("click", () => { closeQuickOpen(); loadFile(p); });
    ul.appendChild(li);
  });
  ul.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
}
function openQuickOpen(): void {
  (document.getElementById("quickopen-modal") as HTMLElement).hidden = false;
  const inp = document.getElementById("qo-input") as HTMLInputElement;
  qoFiltered = recentList().filter((p) => p.toLowerCase().includes(inp.value.trim().toLowerCase()));
  qoSel = 0;
  renderQoList();
  inp.focus();
  inp.select();
}
function closeQuickOpen(): void {
  (document.getElementById("quickopen-modal") as HTMLElement).hidden = true;
}

// ===== v0.4.0 command palette (Ctrl+K): commands + recent files, three sections =====
// Design principle: commands always reuse existing bindings (button click / existing functions); the palette only does "discover and jump",
// it never duplicates business logic — export goes through the bound #export-menu buttons, always the same path as the toolbar menu.
interface CmdkItem { kind: "cmd" | "file"; label: string; sub?: string; kbd?: string; run: () => void; }
let cmdkItems: CmdkItem[] = [];
let cmdkSel = 0;
function buildCmdkItems(): CmdkItem[] {
  return allCommands()
    .filter((c) => !c.fixed && c.id !== "app.palette")
    .map<CmdkItem>((c) => ({ kind: "cmd", label: `${c.group}: ${c.label}`, kbd: keyFor(c.id) || undefined, run: c.run }));
}
function renderCmdkList(): void {
  const input = document.getElementById("cmdk-input") as HTMLInputElement;
  const list = document.getElementById("cmdk-list")!;
  const q = input.value.trim().toLowerCase();
  const cmds = buildCmdkItems().filter((c) => !q || c.label.toLowerCase().includes(q));
  const files = recentList()
    .filter((p) => !q || (p.split(/[\\/]/).pop() || "").toLowerCase().includes(q) || p.toLowerCase().includes(q))
    .slice(0, 5)
    .map<CmdkItem>((p) => ({
      kind: "file",
      label: p.split(/[\\/]/).pop() || p,
      sub: p.replace(/[\\/][^\\/]*$/, ""),
      run: () => { void loadFile(p); },
    }));
  cmdkItems = [...cmds, ...files];
  cmdkSel = Math.min(cmdkSel, Math.max(0, cmdkItems.length - 1));
  list.innerHTML = "";
  if (cmdkItems.length === 0) {
    list.innerHTML = `<div class="cmdk-empty">${esc(t("cmdkEmpty"))}</div>`;
    return;
  }
  let lastKind = "";
  cmdkItems.forEach((it, i) => {
    if (it.kind !== lastKind) {
      lastKind = it.kind;
      const g = document.createElement("div");
      g.className = "cmdk-group";
      g.textContent = it.kind === "file" ? t("cmdkGroupRecent") : t("cmdkGroupCmd");
      list.appendChild(g);
    }
    const el = document.createElement("div");
    el.className = "cmdk-item" + (i === cmdkSel ? " sel" : "");
    el.innerHTML = `<span class="l">${esc(it.label)}</span>`
      + (it.sub ? `<span class="p">${esc(it.sub)}</span>` : "")
      + (it.kbd ? `<span class="k">${esc(it.kbd)}</span>` : "");
    el.addEventListener("mouseenter", () => { if (cmdkSel !== i) { cmdkSel = i; refreshCmdkSel(); } });
    el.addEventListener("click", () => { execCmdk(i); });
    list.appendChild(el);
  });
}
function refreshCmdkSel(): void {
  document.querySelectorAll("#cmdk-list .cmdk-item").forEach((el, i) => el.classList.toggle("sel", i === cmdkSel));
  const cur = document.querySelectorAll("#cmdk-list .cmdk-item")[cmdkSel];
  (cur as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
}
function execCmdk(i: number): void {
  const it = cmdkItems[i];
  closeCmdk();
  if (it) it.run();
}
function openCmdk(): void {
  (document.getElementById("cmdk-modal") as HTMLElement).hidden = false;
  const input = document.getElementById("cmdk-input") as HTMLInputElement;
  input.value = "";
  cmdkSel = 0;
  renderCmdkList();
  input.focus();
}
function closeCmdk(): void {
  (document.getElementById("cmdk-modal") as HTMLElement).hidden = true;
}
function toggleCmdk(): void {
  const m = document.getElementById("cmdk-modal");
  if (!m) return;
  if (m.hidden) openCmdk(); else closeCmdk();
}
function initCmdk(): void {
  const input = document.getElementById("cmdk-input") as HTMLInputElement;
  input.addEventListener("input", () => { cmdkSel = 0; renderCmdkList(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdkItems.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      cmdkSel = (cmdkSel + d + cmdkItems.length) % cmdkItems.length;
      refreshCmdkSel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      execCmdk(cmdkSel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCmdk();
    }
  });
  // clicking the overlay closes it (clicking the panel itself does not)
  document.getElementById("cmdk-modal")?.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).id === "cmdk-modal") closeCmdk();
  });
}

// ---- v0.4.0 reading focus (Ctrl+Shift+D / command palette): collapse the sidebar + tone down the toolbar/tab bar (keeping their space). ----
// Separate from F8 typing focus (paragraph dimming): one is for "writing immersion", the other for "reading immersion". The status bar stays (position awareness kept).
let readingFocusOn = false;
function setReadingFocus(on: boolean): void {
  readingFocusOn = on;
  document.body.classList.toggle("reading-focus", on);
  const f = document.getElementById("sb-focus");
  if (f) f.textContent = t("readingFocus");
  if (on) setSideCollapsed(true, true); // collapse navigation (persisted: collapsing in focus mode is user intent, kept across restarts)
}

// ----- themes (v0.3.15: light / dark / eye-care bean green). The shell uses CSS variables (html[data-theme]),
// Vditor's editor content theme uses content-theme/<name>.css (light/dark/eye, eye is our own).
// ⚠ setTheme's real signature = (theme, contentTheme, codeTheme, contentThemePath): v0.3.14 passed the
// cdn as the second argument by mistake — the UI theme switched but the content theme stayed light (root cause of white tables in dark mode).
type ThemeName = "light" | "dark" | "eye" | "paper"; // v0.4.0 ink-black (oled) merged into dark
let themeName: string = "light"; // one of the four built-ins or "user:<file name>" (v0.4.0 custom themes)
/** The current theme's Vditor (UI level, contentTheme) pair — shared by applyTheme / loadUserTheme / after-rebuild.
 *  contentTheme must map to a css that really exists (the bundled folder has light/dark; eye/paper styling comes from the app shell): eye/paper → light;
 *  the user:* level is decided by userThemeDark detected in loadUserTheme (light before detection finishes / without a background value). */
function vditorThemeTrio(): ["dark" | "classic", string] {
  if (themeName === "dark" || (themeName.startsWith("user:") && userThemeDark)) return ["dark", "dark"];
  if (themeName === "eye") return ["classic", "light"];
  return ["classic", "light"];
}
/** Single entry point for applying the Vditor level. v0.4.1 root fix: without the third argument codeTheme, setTheme always defaults to the light
 *  github theme (.hljs{background:#fff}) → in dark mode code blocks / formula source code get a white background (measured
 *  CODE.language-js.hljs=rgb(255,255,255)). The dark level switches to github-dark accordingly.
 *  v0.4.1b correction: codeTheme follows "how dark the code block background is" rather than the Vditor level — the light level's code blocks are
 *  Swiss dark (#16181d), pairing them with github (white background, dark tokens) both regressed to white and made text unreadable, so they use github-dark;
 *  eye/paper/light user themes have light code blocks and keep github. Backgrounds are handled uniformly by the transparency rules in styles.css. */
function vditorApplyTheme(): void {
  const [vd, ct] = vditorThemeTrio();
  const darkCode = themeName === "dark" || (themeName.startsWith("user:") && userThemeDark);
  try {
    vditor?.setTheme(vd, ct, darkCode ? "github-dark" : "github", "/vditor-assets/dist/css/content-theme");
  } catch { /* not ready: applied after mounting in the after callback */ }
}
function applyTheme(name: string, persist = true): void {
  themeName = name;
  if (name.startsWith("user:")) {
    // custom theme: the shell is driven by injected CSS + the inline variable bridge, data-theme falls back to the light base level (tokens are overridden afterwards)
    document.documentElement.dataset.theme = "light";
    void loadUserTheme(name.slice(5));
  } else {
    unloadUserTheme();
    document.documentElement.dataset.theme = name;
    vditorApplyTheme();
  }
  // v0.4.0 the theme entry moved to the status bar (lighter toolbar): button text + popup menu check state
  const sbt = document.getElementById("sb-theme");
  if (sbt) { sbt.textContent = t(themeNameKey(name)); sbt.title = t("themeTip"); }
  document.querySelectorAll("#theme-menu button").forEach((b) => {
    b.classList.toggle("cur", (b as HTMLElement).dataset.theme === name);
  });
  if (persist) saveUiStateKey("theme", name);
}
/** Real content-theme name (shared by boot options and applyTheme): eye/paper/user themes use the light base under app CSS overrides. */
function contentThemeOf(name: string): string {
  if (name === "eye" || name === "paper" || name.startsWith("user:")) return "light";
  return name;
}
function initTheme(): void {
  // never chosen (no valid theme value on disk) → follow the system, and don't write to disk (only fixed once chosen)
  const v = uiStateAll.theme;
  // v0.4.0 oled merged into dark: old ui-state values of oled map to dark, so the dark experience is kept
  const v0 = typeof v === "string" ? (v === "oled" ? "dark" : v) : "";
  const okUser = v0.startsWith("user:") && userThemeNames.includes(v0.slice(5)); // theme file deleted → fall back
  const saved = okUser || ["light", "dark", "eye", "paper"].includes(v0) ? v0 : null;
  const name = saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(name, saved !== null);
}
/** Theme name → i18n key (shared by the status-bar button and the popup menu). The user: prefix returns the file name (t() falls back to the key itself) */
function themeNameKey(name: string): string {
  if (name.startsWith("user:")) return name.slice(5);
  return name === "light" ? "themeLight" : name === "dark" ? "themeDark"
    : name === "eye" ? "themeEye" : "themePaper";
}

// ===== v0.4.0 custom themes (compatible with Typora community themes) =====
// themes folder (%APPDATA%/<identifier>/themes/): one .css = one theme (file name = theme name, same as
// Typora's themes folder convention; _ prefix = disabled). Load chain: Rust reads the raw text → typoraCompat() rewrites
// selectors at runtime (#write → #editor .vditor-reset etc.) → injected as <style id="user-theme-style"> →
// Typora variables in :root are bridged to the app's semantic tokens (inline overrides every theme block) → --bg-color brightness
// decides the dark/light level (Vditor controls / content-theme follow it).
let userThemeNames: string[] = []; // filled by scanUserThemes; used by initTheme validation / palette commands
let userThemeActive = "";
let userThemeDark = false; // remembers the dark level: used for options.theme when a mode switch rebuilds Vditor
/** Typora core variables → app semantic tokens (undefined ones are not bridged, keeping the base level's values) */
const TOKEN_BRIDGE: Array<[string, string]> = [
  ["--side-bar-bg-color", "--canvas"],
  ["--bg-color", "--surface"],
  ["--text-color", "--text-primary"],
  ["--primary-color", "--accent"],
];
/** Selector rewrite table: Typora DOM → this app's/Vditor DOM (literal replace; prefixed forms like #write h1 are naturally compatible) */
function typoraCompat(css: string): string {
  const rep = (s: string, from: string, to: string) => s.split(from).join(to); // lib < es2021 has no replaceAll
  return rep(rep(css, "#write", "#editor .vditor-reset"), // body container; keeping the id gives (1,1,0), beating content-theme's (0,1,0)
    ".md-fences", "pre");                                  // code block container (#write .md-fences → #editor .vditor-reset pre)
}
/** Extract a variable value from CSS text (whole-text search: Typora theme variables mostly live in :root/html blocks; var() chains are returned as is, inline can resolve them too) */
function cssVarOf(css: string, name: string): string | null {
  const m = new RegExp(name.replace(/[-]/g, "\\-") + "\\s*:\\s*([^;{}]+)").exec(css);
  return m ? m[1].trim() : null;
}
/** Parse #hex/#rgba/rgb() into [r,g,b] (returns null on failure — var() reference chains etc.) */
function parseColor(s: string): [number, number, number] | null {
  s = s.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    return null;
  }
  m = /rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/.exec(s);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
/** Linear RGB mix: f>0 towards white, f<0 towards black (for deriving shades) */
function shade(c: [number, number, number], f: number): string {
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${m(c[0])}, ${m(c[1])}, ${m(c[2])})`;
}
async function loadUserTheme(name: string): Promise<void> {
  let css = "";
  try {
    css = await invoke<string>("read_theme_css", { name });
  } catch (e) {
    // file deleted / read failed: unload + fall back to light (not persisted — the stale disk value is validated and falls back by initTheme on the next start)
    showToast(t("themeLoadFail") + ": " + name + " (" + e + ")", "danger");
    unloadUserTheme();
    applyTheme("light", false);
    return;
  }
  userThemeActive = name;
  let el = document.getElementById("user-theme-style") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "user-theme-style";
    document.head.appendChild(el);
  }
  // first rule as a safety net: body background/text colour follow the theme variables (prevents content-theme's white background leaking when the theme doesn't style #write;
  // same specificity (1,1,0) and placed first, so the user's own rules can override it)
  el.textContent =
    "#editor .vditor-reset{background-color:var(--bg-color,#fff);color:var(--text-color,#000);}\n" +
    typoraCompat(css);
  // shell token bridge: inline variables override every html[data-theme] theme block (including base-level values).
  // --canvas falls back to --bg-color: drake-family themes only define --bg-color, not --side-bar-bg-color (measured)
  const root = document.documentElement;
  for (const [src, dst] of TOKEN_BRIDGE) {
    const val = cssVarOf(css, src) || (dst === "--canvas" ? cssVarOf(css, "--bg-color") : null);
    if (val) root.style.setProperty(dst, val);
    if (val && dst === "--accent") root.style.setProperty("--accent2", val);
  }
  // light/dark derivation: when bg parses, fill in borders / secondary text / hover surface (a dark theme bridging only the four core tokens leaves light grey lines, depth becomes unusable).
  // the value chain stops at the first that parses — drake-dark's --side-bar-bg-color is a var(--bg-color) reference,
  // concatenating it directly makes parseColor fail and wrongly picks light (measured); the var() reference itself still bridges fine (inline can resolve it)
  const bgVal = ["--side-bar-bg-color", "--bg-color"]
    .map((n) => cssVarOf(css, n))
    .find((v) => v && parseColor(v)) || "";
  const bg = parseColor(bgVal);
  const txtVal = cssVarOf(css, "--text-color") || "";
  const txt = parseColor(txtVal);
  if (bg && txt) {
    const dark = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114 < 140; // ITU-R BT.601 weighted luminance
    userThemeDark = dark;
    root.style.setProperty("--border-subtle", shade(bg, dark ? 0.14 : -0.08));
    root.style.setProperty("--border-strong", shade(bg, dark ? 0.26 : -0.18));
    root.style.setProperty("--surface-hover", shade(bg, dark ? 0.07 : -0.045));
    root.style.setProperty("--surface-raised", shade(bg, dark ? 0.05 : -0.02));
    root.style.setProperty("--text-secondary", txtVal);
    root.style.setProperty("--text-tertiary", txtVal);
    vditorApplyTheme(); // userThemeDark is updated, vditorThemeTrio picks the level from it (including the hljs codeTheme)
  } else {
    userThemeDark = false;
    vditorApplyTheme();
  }
}
/** Unload the custom theme: remove the injected styles + clear inline tokens (the html[data-theme] theme block values take effect again automatically) */
function unloadUserTheme(): void {
  if (!userThemeActive && !document.getElementById("user-theme-style")) return;
  userThemeActive = "";
  userThemeDark = false;
  document.getElementById("user-theme-style")?.remove();
  const rs = document.documentElement.style;
  for (const [, dst] of TOKEN_BRIDGE) rs.removeProperty(dst);
  rs.removeProperty("--accent2");
  for (const p of ["--border-subtle", "--border-strong", "--surface-hover", "--surface-raised", "--text-secondary", "--text-tertiary"]) {
    rs.removeProperty(p);
  }
}
/** Scan the themes folder and render the dynamic theme menu items (called at boot and on refresh) */
async function scanUserThemes(): Promise<void> {
  try {
    userThemeNames = await invoke<string[]>("list_theme_files");
  } catch {
    userThemeNames = [];
  }
  const menu = document.getElementById("theme-menu");
  if (!menu) return;
  menu.querySelectorAll("button[data-theme^='user:'], .menu-sep.user-sep").forEach((n) => n.remove());
  if (userThemeNames.length === 0) return;
  const sep = document.createElement("div");
  sep.className = "menu-sep user-sep";
  menu.appendChild(sep);
  for (const n of userThemeNames) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.theme = "user:" + n;
    b.textContent = n;
    b.addEventListener("click", () => {
      applyTheme("user:" + n);
      menu.hidden = true;
    });
    menu.appendChild(b);
  }
}

// ---- v0.4.0 sidebar collapse (one of the prerequisites of reading focus; instant toggle — drag-resize needs width to follow the pointer immediately) ----
let sideCollapsed = false;
function setSideCollapsed(on: boolean, persist = true): void {
  sideCollapsed = on;
  document.getElementById("outline-panel")?.classList.toggle("collapsed", on);
  const btn = document.getElementById("sb-side");
  if (btn) {
    btn.textContent = t("sbSide");
    btn.title = on ? t("sbShowSide") : t("sbHideSide");
    btn.classList.toggle("folded", on); // collapsed state is one shade greyer, hinting "collapsed"
  }
  if (persist) saveUiStateKey("sideCollapsed", on);
}

// ----- outline filter: typing hides non-matching items instantly; must be reapplied after rebuildOutline (otherwise the filter state is lost) -----
function applyOutlineFilter(): void {
  const of = document.getElementById("outline-filter") as HTMLInputElement | null;
  if (!of) return;
  const q = of.value.trim().toLowerCase();
  document.querySelectorAll("#outline .outline-item").forEach((li) => {
    const txt = (li.textContent || "").toLowerCase();
    (li as HTMLElement).style.display = !q || txt.includes(q) ? "" : "none";
  });
}

// ----- sidebar tab switching (Outline | Files) -----
function switchSidePane(which: "outline" | "files"): void {
  const isOutline = which === "outline";
  document.getElementById("side-tab-outline")!.classList.toggle("active", isOutline);
  document.getElementById("side-tab-files")!.classList.toggle("active", !isOutline);
  (document.getElementById("side-pane-outline") as HTMLElement).hidden = !isOutline;
  (document.getElementById("side-pane-files") as HTMLElement).hidden = isOutline;
  // build the tree only the first time the Files tab is entered (saves startup cost); in the drives state ftreeRoot=null, so "not built" = no nodes in the tree
  if (!isOutline && !ftreeRoot && !document.querySelector("#ftree .node")) refreshFileTree();
}

function initSidePanels(): void {
  document.getElementById("side-tab-outline")!.addEventListener("click", () => switchSidePane("outline"));
  document.getElementById("side-tab-files")!.addEventListener("click", () => switchSidePane("files"));
  const treeModeButton = document.getElementById("ftree-mode-toggle")!;
  const setTreeMode = (favorites: boolean) => {
    favoritesTreeActive = favorites;
    (document.getElementById("ftree") as HTMLElement).hidden = favorites;
    (document.getElementById("favorites-tree") as HTMLElement).hidden = !favorites;
    for (const id of ["ftree-path", "ftree-refresh", "gsearch-input", "gsearch-results", "ftree-filter", "es-results", "recent-title", "recent-list"]) {
      const element = document.getElementById(id) as HTMLElement | null;
      if (element) element.hidden = favorites;
    }
    treeModeButton.textContent = favorites ? "This PC" : "Favorites";
    treeModeButton.title = favorites ? "Switch to This PC tree" : "Switch to Favorites tree";
    if (favorites) renderFavoriteList();
  };
  treeModeButton.addEventListener("click", () => setTreeMode(!favoritesTreeActive));
  setTreeMode(false);
  // file tree navigation: address bar Enter to jump / ⟳ refresh (v0.3.18 the ↑ parent button was removed — the tree keeps drives permanently, navigation goes through the tree/address bar)
  const pathInp = document.getElementById("ftree-path") as HTMLInputElement;
  pathInp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = pathInp.value.trim();
    if (!v) return;
    invoke<TreeEntry[]>("list_md_dir", { path: v }).then(() => void locateTreeAt(v)).catch(() => {
      pathInp.value = ftreeRoot || "";
      showToast(t("treeBadPath") + v, "danger");
    });
  });
  document.getElementById("ftree-refresh")!.addEventListener("click", () => { refreshFileTree(); });
  // file-name filter = in-tree filter + Everything drive-wide search on two tracks + clearing recent files (user request: recent should be clearable by hand)
  (document.getElementById("ftree-filter") as HTMLInputElement).addEventListener("input", () => {
    applyTreeFilter();
    scheduleEsSearch();
  });
  setupEsSplitter(); // drive-wide results name column resizing (v0.3.20)
  document.getElementById("recent-clear")!.addEventListener("click", () => {
    saveUiStateKey("recent", []);
    renderRecent();
  });
  refreshFileTree();
  (document.getElementById("outline-filter") as HTMLInputElement).addEventListener("input", applyOutlineFilter);
  // cross-file search: runs on Enter (cross-file invoke has an IO cost, not searched per key)
  (document.getElementById("gsearch-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runGlobalSearch(); }
  });
  // quick open modal
  const qoMask = document.getElementById("quickopen-modal")!;
  const qoInp = document.getElementById("qo-input") as HTMLInputElement;
  qoMask.addEventListener("mousedown", (e) => { if (e.target === qoMask) closeQuickOpen(); });
  qoInp.addEventListener("input", () => {
    qoFiltered = recentList().filter((p) => p.toLowerCase().includes(qoInp.value.trim().toLowerCase()));
    qoSel = 0;
    renderQoList();
  });
  qoInp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); qoSel++; renderQoList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); qoSel--; renderQoList(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const p = qoFiltered[qoSel];
      if (p) { closeQuickOpen(); loadFile(p); }
    } else if (e.key === "Escape") { e.preventDefault(); closeQuickOpen(); }
  });
  // theme dropdown (three-way choice)
  // v0.4.0 theme menu (pops out of the status bar sb-theme, replaces the toolbar theme-select dropdown)
  const themeMenu = document.getElementById("theme-menu")!;
  themeMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      applyTheme((b as HTMLElement).dataset.theme as ThemeName);
      themeMenu.hidden = true;
    });
  });
  document.getElementById("sb-theme")!.addEventListener("click", (e) => {
    e.stopPropagation();
    if (themeMenu.hidden) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      themeMenu.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    }
    themeMenu.hidden = !themeMenu.hidden;
  });
  document.addEventListener("pointerdown", (e) => {
    if (!themeMenu.hidden && !(e.target as Element | null)?.closest?.("#theme-menu, #sb-theme")) {
      themeMenu.hidden = true;
    }
  });
  // sidebar toggle buttons (☰ toolbar, « sidebar header, ◫ status bar); the shortcut lives in the command registry
  for (const id of ["sb-side", "btn-side-toggle", "side-collapse"]) {
    document.getElementById(id)?.addEventListener("click", () => setSideCollapsed(!sideCollapsed));
  }
  // v0.4.8 reading scroll (double-click empty body space toggles auto-scroll)
  setupReadingScroll();
}

function updateTitle() {
  // v0.3.16 the toolbar file-name display was removed at the user's request (tabs already show it); the encoding badge stays
  document.getElementById("encoding-badge")!.textContent = activeDoc()?.encoding ? ` ${activeDoc()!.encoding}` : "";
}

async function loadFile(path: string) {
  try {
    const [content, enc] = await invoke<[string, string]>("open_file", { path });
    // v0.3.26 large document × ir mode interception: benchmarks show editing a large document in ir mode doesn't settle within 60s (2026-09-07 three-mode benchmark),
    // so switch to wysiwyg first, then open. Reuses pendingFile's existing timing: only after switchMode's rebuild completes (after restoring the old document)
    // is the new document opened with openDoc, avoiding out-of-order double setValue.
    if (content.length > LARGE_DOC_CHARS && currentMode === "ir") {
      pendingLargeOpen = { path, content, enc: enc || "" };
      switchMode("wysiwyg");
      return;
    }
    openDoc(path, content, undefined, enc);
  } catch (e) {
    showToast(t("openFail") + e, "danger");
  }
}
let pendingLargeOpen: { path: string; content: string; enc: string } | null = null;

// Opening a PDF: smart routing. Doesn't use open_file (its whitelist only reads text types, a PDF would be refused).
// find_pdf_source looks for a same-name .md/.html source: source found → open the source for editing (re-export over the PDF afterwards);
// no source → open_pdf_external launches PDF4QT; if not detected (PDF4QT_NOT_FOUND) fall back to the system default PDF app.
async function handleOpenPdf(pdfPath: string) {
  let src: string | null = null;
  try {
    src = await invoke<string | null>("find_pdf_source", { pdfPath });
  } catch (e) {
    showToast(t("openFail") + e, "danger");
    return;
  }
  if (src) {
    const srcName = src.split(/[\\/]/).pop()!;
    const msg = `Found source "${srcName}". Open it to edit? (Re-export to overwrite this PDF after changes.)`;
    const ok = await confirm(msg, {
      title: "Open Source",
      kind: "info",
    }).catch(() => false);
    if (ok) loadFile(src);
    return;
  }
  // no source: launch PDF4QT to edit
  const msg2 = "No source file found. Open this PDF in PDF4QT to edit?";
  const ok2 = await confirm(msg2, {
    title: "Open in PDF4QT",
    kind: "info",
  }).catch(() => false);
  if (!ok2) return;
  try {
    await invoke("open_pdf_external", { path: pdfPath });
  } catch (e) {
    if (String(e).includes("PDF4QT_NOT_FOUND")) {
      // fallback: the system default PDF app (equivalent if the user set PDF4QT as the .pdf default)
      try {
        await openPath(pdfPath);
      } catch (e2) {
        showToast(t("openFail") + e2, "danger");
      }
    } else {
      showToast(t("openFail") + e, "danger");
    }
  }
}

let pendingFile: string | null = null;

// Caret fallback for the table floating bar's "move row up/down": the most recently clicked cell. A document-level capture listener attached once
// (the editor's pre.vditor-reset is destroyed and rebuilt by Vditor, a listener on the element would be lost with it).
let lastTblCell: HTMLTableCellElement | null = null;
document.addEventListener("mousedown", (e) => {
  const c = (e.target as Element | null)?.closest?.(".vditor-reset td, .vditor-reset th");
  if (c) lastTblCell = c as HTMLTableCellElement;
}, true);

// Build the Vditor options: toolbar/input/after all in one place, mode comes from the argument (reused when destroying/rebuilding to switch modes)
type VditorOptions = NonNullable<ConstructorParameters<typeof Vditor>[1]>;
function vditorOptions(mode: EditorMode): VditorOptions {
  return {
    mode,
    lang: VDITOR_LANG[currentLang],
    i18n: VDITOR_I18N[currentLang], // inject the local i18n (current language), toolbar tooltips use it automatically
    cdn: "/vditor-assets", // lute (markdown engine) / icons / methods etc. load locally, CSP-compliant, no dependence on unpkg
    // v0.3.14+ theme: rebuilds (mode/language switches) follow the current theme; switching while running uses vditor.setTheme
    // v0.4.0 custom themes: data-theme stays light, the level is remembered in userThemeDark detected by loadUserTheme
    theme: (themeName === "dark" || userThemeDark) ? ("dark" as const) : ("classic" as const),
    height: "100%",
    cache: { enable: false },
    // word count (type text = counted on the rendered text; the unit is added in after).
    // v0.3.15 per user feedback, separate character/word counts + reading time were removed ("too complicated, users have to think about characters vs words"), back to a single total
    counter: {
      enable: true, type: "text",
      after: (len: number) => {
        // v0.3.26 the status bar takes over the counter slot: N selected · N words total · size (selectionchange rebuilds it via updateStatus)
        counterLen = len;
        updateStatus();
      },
    },
    // :emoji: completion images load from local resources (default is the unpkg CDN, blocked by the CSP and unavailable offline)
    hint: { emojiPath: "/vditor-assets/dist/images/emoji" },
    // the outline uses our own left panel, Vditor's built-in outline is not enabled; position must be "right" —
    // Vditor's toolbar padding-left formula adds the outline width (188px) whenever position=="left",
    // even with enable=false, showing up as a big blank on the left of the format toolbar (root cause of the user report "it looks better flush left")
    outline: { enable: false, position: "right" },
    // Vditor 3.11.2's popover highlight chain calls options.customWysiwygToolbar(...) without a guard:
    // it always fires when the caret enters a table/quote/list/footnote, and throws a TypeError if not configured (source of PAGEERROR noise).
    // v0.3.10 gave it an empty implementation to silence it; v0.3.12 extended it to complete the table floating bar: it natively has alignment (left/centre/right) + insert/delete
    // rows and columns, but no "move whole row up/down" (the native up/down buttons move the whole table block, measured swapping it with the preceding paragraph),
    // so two buttons are added here (swap tr within tbody; row order is content, serialised into the source by Lute).
    // De-dup can only check the button itself: after saving Vditor clears and rebuilds the popover's children (buttons lost) but reuses
    // the panel element — a dataset marker would linger and skip reinjection (a pitfall measured in e2e T3).
    customWysiwygToolbar: (type: string, popover?: HTMLElement) => {
      if (type !== "table" || !popover || popover.querySelector(".mded-tbl-btn")) return;
      // v0.4.5 hide the native up/down (move the whole table block): same icons as our two buttons (move the current row),
      // the user decided two pairs of arrows is redundant, keep one pair. Hidden, not removed — Vditor's Ctrl+Shift+U/D hotkeys are implemented as
      // popover.querySelector('[data-type="up"]').click() (dist processKeydown), so removing them
      // would kill the hotkeys and the move-table feature too; display:none hides them visually while the DOM keeps the hotkeys alive. Vditor
      // regenerates the buttons every time it rebuilds the popover, so this must be set on every callback (the de-dup guard sits on .mded-tbl-btn).
      popover.querySelectorAll<HTMLButtonElement>('button[data-type="up"], button[data-type="down"]')
        .forEach((b) => { b.style.display = "none"; });
      // v0.4.7 table popover all on one line: Vditor appends row/column number inputs after the buttons (span>input,
      // inline, not float) + a " x " text node — inline content triggers CSS float rule 4 (the top of a later float
      // may not be higher than the top of the line box containing that inline), pinning our two buttons to the second/third row (user report
      // "move row up/down sitting on the second/third row looks bad"). Make these inline items float:left too so they flow together;
      // lifting the panel's 320px width cap is in styles.css (12 buttons + two inputs ~350px need one line).
      popover.querySelectorAll<HTMLElement>("span.vditor-tooltipped").forEach((s) => {
        s.style.cssText += ";float:left;margin:2px 2px 0";
      });
      for (const n of [...popover.childNodes]) {
        if (n.nodeType === 3 && (n.nodeValue || "").trim()) {
          const s = document.createElement("span");
          s.style.cssText = "float:left;margin:3px 2px 0";
          s.textContent = n.nodeValue;
          popover.replaceChild(s, n);
        }
      }
      // caret fallback chain: selection anchorNode → the most recently really clicked cell (the button's mousedown
      // preventDefault keeps the selection, but caret shape / re-renders can still invalidate anchorNode; the cache is most reliable)
      const lastCell = (): HTMLTableCellElement | null => lastTblCell;
      const curCell = (): HTMLTableCellElement | null => {
        const n = document.getSelection()?.anchorNode;
        const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
        return (el?.closest(".vditor-reset td, .vditor-reset th") as HTMLTableCellElement)
          || lastCell();
      };
      const syncDoc = (): void => { // same as the input callback: direct DOM operations must also update the content cache + dirty flag
        const doc = activeDoc();
        if (doc && vditor) {
          const v = mdValue();
          if (v !== "" || doc.content === "") {
            // v0.3.21 custom undo stack catch-up: direct DOM operations (move row up/down etc.) don't fire input events,
            // without recording a step they can't be undone (proven by the B19 redo chain). Discrete button operations record one step each (no 900ms merging).
            if (doc.content !== "" && v !== doc.content) {
              doc.undoStack.push(doc.content);
              if (doc.undoStack.length > 100) doc.undoStack.shift();
              doc.redoStack.length = 0;
            }
            doc.content = v;
          }
          doc.dirty = true;
        }
        updateTitle(); renderTabs(); scheduleOutline(); syncUndoBtns();
      };
      const moveRow = (dir: -1 | 1): void => {
        const cell = curCell();
        const tr = cell?.closest("tr");
        const body = tr?.parentElement;
        if (!cell || !tr || !body || body.tagName !== "TBODY") return; // the header row doesn't take part in moves
        const sib = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling;
        if (!sib) return;
        body.insertBefore(tr, dir < 0 ? sib : sib.nextElementSibling);
        const back = tr.cells[Math.min(cell.cellIndex, tr.cells.length - 1)];
        if (back) {
          const range = document.createRange();
          range.selectNodeContents(back);
          const sel = document.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        syncDoc();
      };
      // v0.4.7 the separator must be float:left to flow with the buttons: panel buttons are all laid out by .vditor-icon{float:left},
      // an inline element triggers CSS float rule 4 (the top of a later float may not be higher than the top of the line box
      // containing that inline), pinning our two buttons to the second/third row (user report "move row up/down in the second/third column").
      const sep = document.createElement("span");
      sep.style.cssText = "float:left;width:1px;height:16px;background:currentColor;opacity:.25;margin:2px 3px 0";
      popover.appendChild(sep);
      // v0.4.9 grey out by caret row position (the visual side of the moveRow guard, user decision): header row / not tbody = both buttons
      // grey (moving only makes sense for data rows); first tbody row greys move-up, last row greys move-down (no neighbour to swap with).
      // The popover is rebuilt on every caret selection change (recomputed on injection); moveRow's sib guard remains the behavioural safety net.
      const cell0 = curCell();
      const tr0 = cell0?.closest("tr");
      const body0 = tr0?.parentElement;
      const inTbody = !!(body0 && body0.tagName === "TBODY");
      const canUp = inTbody && !!tr0!.previousElementSibling;
      const canDown = inTbody && !!tr0!.nextElementSibling;
      ([["up", "tblRowUp", () => moveRow(-1)],
        ["down", "tblRowDown", () => moveRow(1)]] as [string, string, () => void][]).forEach(([icon, key, fn]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vditor-icon vditor-tooltipped vditor-tooltipped__n mded-tbl-btn";
        btn.setAttribute("aria-label", t(key));
        btn.innerHTML = `<svg><use xlink:href="#vditor-icon-${icon}"></use></svg>`;
        btn.disabled = (icon === "up" && !canUp) || (icon === "down" && !canDown);
        btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the click from stealing the selection (curCell depends on it)
        btn.addEventListener("click", fn);
        popover.appendChild(btn);
      });
    },
    preview: {
      // content theme follows the theme switch (light/dark/eye; eye = our own eye-care bean green)
      theme: { current: contentThemeOf(themeName), path: "/vditor-assets/dist/css/content-theme" },
      hljs: { lineNumber: true, style: "github" },
      // KaTeX maths (engine resources are local; inlineDigit allows an inline $ followed by a digit)
      math: { engine: "KaTeX", inlineDigit: true },
      // automatically add spaces between CJK and Latin text (render layer only, not written back to the source)
      markdown: { autoSpace: true },
      // local relative-path images preview in the editor: the source keeps relative paths (portable), rendering converts them to
      // asset:// URLs (the webview can't resolve relative file paths against the app origin and would show broken images)
      transform: (html: string): string => resolvePreviewImages(html),
    },
    // pasted/dropped images are saved automatically (Typora style): saved document → assets/Screenshot_timestamp.png in the same folder +
    // relative-path reference; untitled document → absolute-path reference in %APPDATA% pasted/. Returns null to suppress the default upload UI.
    upload: {
      handler: (files: File[]): Promise<null> => handlePasteImages(files),
    },
    toolbar: [
      "headings", "bold", "italic", "strike", "|",
      "line", "quote", "list", "ordered-list", "check", "outdent", "indent", "|",
      "code", "inline-code", "link", "table", "|",
      "undo", "redo", "|", // v0.3.21 buttons visible (clicks use the custom stack): only when Vditor sees toolbar.elements.undo does it disable its own ⌘Z keyboard branch,
      // letting Ctrl+Z reach the custom stack handler; removing the config = Vditor pre-empts it (both real keyboard and CDP intercepted, proven with AHK + ztrace)
      "edit-mode", "fullscreen",
      {
        name: "os-fullscreen",
        tip: "Full screen",
        tipPosition: "s",
        icon: '<svg viewBox="0 0 32 32"><path d="M4 12V4h8v3H7v5zm16-8h8v8h-3V7h-5zM7 20v5h5v3H4v-8zm18 0h3v8h-8v-3h5z"/></svg>',
        click: () => { void toggleOsFullscreen(); },
      },
    ],
    input: () => {
      if (suppressInput) return;
      if (switchApplyPending) return; // v0.3.25 large-document switch loading: discard signals from the old DOM (prevents mixing documents)
      const doc = activeDoc();
      if (doc && (doc.lazy || doc.loading)) return; // v0.3.26 lazy loading window: vditor still holds the old document, discard (prevents mixing)
      if (doc && vditor) {
        if (doc.large) { // v0.3.25 large document: deferred value channel (the native input capture layer already set dirty and scheduled)
          scheduleValueSync(doc);
        } else {
          const v = mdValue();
          if (v !== "" || doc.content === "") doc.content = v; // guard: empty values don't overwrite
          doc.dirty = true;
          doc.large = v.length > LARGE_DOC_CHARS; // a small document that grew past the threshold (e.g. pasting a large block) switches to the deferred channel
          snapOnInput(doc, v); // v0.3.21 custom undo stack: record snapshots split by input pauses
        }
      }
      updateTitle();
      renderTabs();
      scheduleOutline();
    },
    after: () => {
      // Keep the Find and text-color controls at the end of the top-line formatting toolbar.
      // Vditor rebuilds this row when switching Preview/Raw, so reattach the persistent control after each mount.
      const formatToolbar = document.querySelector("#editor .vditor-toolbar");
      // Keep the formatter on the app's top line beside the brand. Moving the
      // live toolbar preserves Vditor's bound controls while allowing the shell
      // row to grow and wrap naturally at narrow window widths.
      if (formatToolbar) {
        const shell = document.getElementById("toolbar");
        shell?.querySelectorAll<HTMLElement>(":scope > .vditor-toolbar").forEach((old) => {
          if (old !== formatToolbar) old.remove();
        });
        shell?.appendChild(formatToolbar);
      }
      if (formatToolbar && textColorControlsEl) {
        formatToolbar.appendChild(textColorControlsEl);
        textColorControlsEl.removeAttribute("hidden");
      }
      styleToolbarGlyphs();
      fixToolbarTooltipDirection();
      setupUndoToolbar(); // v0.3.21 undo/redo button hijack (rebound after a mode/language switch rebuilds the toolbar)
      // v0.4.1 reassert the Vditor level after every mount/rebuild (including the hljs codeTheme — options has no such field,
      // without it a rebuild in dark mode falls back to light hljs white backgrounds for code blocks / formula source)
      vditorApplyTheme();
      // v0.3.21 root fix for "undo lit but clicking does nothing / redo always grey": Vditor's built-in Undo.resetIcon enables/disables
      // buttons based on **its own stack** — its redo stack is always empty (the undo branch is disabled) → after every edit it disables redo,
      // after opening a document it enables undo, racing the custom stack's button state; whoever sets last is the symptom (confirmed at dist line 14274).
      // The instance method is monkey-patched to a no-op; the initial grey state it sets during construction (empty-stack semantics) happens to be kept.
      const vu = (vditor as unknown as { undo?: { resetIcon?: (v: unknown) => void } }).undo;
      if (vu?.resetIcon) vu.resetIcon = () => {};
      // v0.3.21 focus the editor at startup (first mount only): back when the outline tab was the default, focus stayed on body after startup,
      // so "open and type" failed (CDP diagnosis confirmed activeElement=BODY; a delayed focus at the end of boot misses because pre
      // isn't rendered yet, only after guarantees the mount is done). Mode/language rebuilds also go through after, the flag prevents stealing focus again.
      if (!bootFocused) {
        bootFocused = true;
        window.setTimeout(() => {
          const ed = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null;
          if (ed && (document.activeElement === document.body || document.activeElement === null)) ed.focus();
        }, 0);
      }
      // v0.3.11 spell check: Vditor explicitly sets spellcheck="false" on pre.vditor-reset (3 places in the dist source),
      // the editor element is fixed and not rebuilt, so setting it back to true in after keeps it working (mode/language rebuilds go through after again).
      // WebView2/Chromium built-in checking: red squiggles + right-click suggestions for misspelt English words.
      document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset")
        ?.setAttribute("spellcheck", activeDoc()?.large ? "false" : "true"); // v0.3.25 spell check off for large documents (checking tens of thousands of nodes burns CPU)
      rebindImagePreview(); // v0.3.11 local image preview in the editor (wysiwyg; observer reattached after a rebuild)
      rebindTableResize(); // v0.3.11 table column resizing (edge detection + persisted reapplication)
      closeFind(); // a mode/language switch destroys and rebuilds: all old match nodes are invalid
      if (!vditorInited) {
        // first initialisation: restore the last session (v0.3.26: tabs + reading positions), open the welcome page only without a session;
        // with a startup file (double-clicking a .md) = restore the session, then append and activate the target file (changed in v0.5.1: the old v0.3.26 semantics
        // "with an argument only open that file, no session" made the first two tabs vanish when the user double-clicked a third md, a counter-intuitive report)
        vditorInited = true;
        if (pendingFile) {
          const f = pendingFile;
          pendingFile = null;
          void restoreSession().finally(() => loadFile(f));
        } else {
          void restoreSession().then((ok) => {
            if (!ok) openDoc(null, welcomeMd(), t("welcomeName"));
          });
        }
      } else {
        // rebuild after a mode switch: restore the current document's content into the new editor
        const doc = activeDoc();
        if (doc && vditor) {
          // after a mode/language switch destroys and rebuilds the instance, also clear the stack and set the baseline (same as switchDoc, prevents diff leaks)
          suppressInput = true;
          vditor.setValue(doc.content, true);
          suppressInput = false;
          snapReset(doc);
        }
        rebuildOutline();
        renderTabs();
        updateTitle();
        // relay for the v0.3.26 large document × ir interception: after the mode rebuild completes open the file that was really wanted (set by loadFile)
        if (pendingLargeOpen) {
          const p = pendingLargeOpen;
          pendingLargeOpen = null;
          openDoc(p.path, p.content, undefined, p.enc || undefined);
        }
      }
      updateModeUI();
      switchInFlight = false; // rebuild complete, release the reentry lock
    },
  };
}

function initVditor() {
  vditor = new Vditor("editor", vditorOptions(currentMode));
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    (window as unknown as { __vd?: unknown }).__vd = vditor;
  }
}

// Trigger Vditor undo/redo: click the toolbar undo/redo button (goes through Vditor's native toolbar → undo path).
// Calling internal.undo.undo directly lacks the toolbar handler's wrap-up, and renderDiff triggers an afterRender cascade, making one keypress
// pop two steps; a button click is fully equivalent to the user clicking the toolbar button, and single-step behaviour is verified correct. Reused by the Ctrl+Z/Y/Shift+Z shortcuts.
function doUndo() {
  if (!vditor) return;
  document.querySelector<HTMLElement>('#toolbar .vditor-toolbar [data-type="undo"]')?.click();
}
function doRedo() {
  if (!vditor) return;
  document.querySelector<HTMLElement>('#toolbar .vditor-toolbar [data-type="redo"]')?.click();
}

// Switch edit mode: Vditor 3.11.2 has no runtime changeMode, the only reliable way = destroy the instance + rebuild with the target mode.
// In IR mode tables are source (pipes), not visually editable; in WYSIWYG mode table cells can be clicked and edited,
// and entering a table with the caret shows a toolbar: insert row above/below / insert column left/right / delete row/column / align / delete table.
function switchMode(mode: EditorMode) {
  // reentry lock: between destroy → after callback vditor is mid-rebuild; repeated button clicks / hammering Ctrl+Alt+M could re-enter during
  // the vditor=null window, triggering concurrent destroy/new and causing leftover DOM, duplicate instances or lost content. Ignored while rebuilding.
  if (!vditor || currentMode === mode || switchInFlight) return;
  switchInFlight = true;
  // clear font-size interaction state: after a rebuild savedRange/savedTa point at destroyed old DOM, and fontInputInteracting stuck at true would freeze requirement 2 sync
  fontInputInteracting = false; savedRange = null; savedTa = null; savedStart = 0; savedEnd = 0;
  clearFontSelHl();
  // before destroying, write the current editor content back to doc (getValue empty-read guard: empty values don't overwrite)
  const cur = activeDoc();
  if (cur) {
    const v = mdValue();
    if (v !== "" || cur.content === "") cur.content = v;
  }
  currentMode = mode;
  // destroy clears inline styles on the mount point (including --doc-zoom): save and restore, otherwise the zoom silently returns to 100% after switching modes
  const savedZoom = document.getElementById("editor")?.style.getPropertyValue("--doc-zoom") || "";
  vditor.destroy();
  vditor = null;
  vditor = new Vditor("editor", vditorOptions(mode));
  if (savedZoom) document.getElementById("editor")?.style.setProperty("--doc-zoom", savedZoom);
  updateModeUI(); // updated once more when the after callback is ready
}

function toggleSourceMode(): void {
  if (!vditor || switchInFlight) return;
  switchMode(currentMode === "wysiwyg" ? "ir" : "wysiwyg");
}

// Update the top mode switch button text + current mode badge
function updateModeUI() {
  const btn = document.getElementById("btn-mode");
  const badge = document.getElementById("mode-badge");
  const label = currentMode === "ir" ? "Show WYSIWYG" : "Show raw-by-line";
  if (btn) { setBtn("btn-mode", label); btn.title = `${label} (Ctrl+Alt+M)`; }
  const vm = document.getElementById("vm-mode"); if (vm) vm.textContent = label;
  if (badge) {
    badge.textContent = currentMode === "sv" ? "RAW" : currentMode === "ir" ? t("modeIR") : t("modeWYSIWYG");
    badge.title = currentMode === "sv" ? "Raw Markdown source" : currentMode === "ir" ? t("modeIRTip") : t("modeWYSIWYGTip");
    badge.className = `mode-badge ${currentMode === "sv" ? "source" : currentMode}`;
  }
}

// v0.3.28 toolbar button text: split into "icon + text" spans (narrow windows keep only the icon via @container).
// Matches a leading emoji (including variation selector U+FE0F / skin-tone modifiers) or ⇄; without an icon the whole text is the label (btn-mode switch text).
// Note: ZWJ emoji sequences (such as family sequences) are not handled — the current i18n has none; extend this before introducing them.
function setBtn(id: string, text: string) {
  const b = document.getElementById(id);
  if (!b) return;
  const m = /^([⇄\p{Extended_Pictographic}](?:\u{FE0F}|\p{Emoji_Modifier})*)\s?([\s\S]*)$/u.exec(text);
  b.textContent = "";
  if (m) {
    const ico = document.createElement("span"); ico.className = "tb-ico"; ico.textContent = m[1];
    b.appendChild(ico);
    if (m[2]) { const lb = document.createElement("span"); lb.className = "tb-label"; lb.textContent = m[2]; b.appendChild(lb); }
  } else {
    b.textContent = text;
  }
}

// Update all static DOM text to the current language (called on initialisation)
function applyAllText() {
  const bo = document.getElementById("btn-open"); if (bo) { setBtn("btn-open", t("open")); bo.title = t("openTip"); }
  const bs = document.getElementById("btn-save"); if (bs) { setBtn("btn-save", t("save")); bs.title = t("saveTip"); }
  setBtn("btn-export", t("export"));
  // v0.3.29 export menu text moved into i18n (closes the m6 gap logged in the v0.3.28 review)
  const expItems: Array<[string, string]> = [
    ["pdf", "exportPdf"], ["html", "exportHtmlStyled"], ["html-plain", "exportHtmlPlain"],
    ["image", "exportPng"], ["docx", "exportDocx"],
  ];
  for (const [k, key] of expItems) {
    const el = document.querySelector(`#export-menu button[data-export="${k}"]`);
    if (el) el.textContent = t(key);
  }
  const bp = document.getElementById("btn-print"); if (bp) { setBtn("btn-print", t("printBtn")); bp.title = t("printTip"); }
  const bfd = document.getElementById("btn-find"); if (bfd) { setBtn("btn-find", t("findBtn")); bfd.title = t("findTip"); }
  const bh = document.getElementById("btn-history"); if (bh) { setBtn("btn-history", t("histBtn")); bh.title = t("histTitle"); }
  const bd = document.getElementById("btn-diag"); if (bd) { setBtn("btn-diag", t("diagBtn")); bd.title = t("diagTip"); }
  const fi = document.getElementById("find-input") as HTMLInputElement | null; if (fi) fi.placeholder = t("findPlaceholder");
  const ri = document.getElementById("replace-input") as HTMLInputElement | null; if (ri) ri.placeholder = t("replacePlaceholder");
  const ro = document.getElementById("replace-one"); if (ro) ro.textContent = t("replaceOne");
  const ra = document.getElementById("replace-all"); if (ra) ra.textContent = t("replaceAll");
  const pt = document.getElementById("panel-title"); if (pt) pt.textContent = t("panelTitle");
  // v0.3.14/15 sidebar Files tab + quick open + themes + tab context menu
  const sto = document.getElementById("side-tab-outline"); if (sto) sto.textContent = t("sideOutline");
  const stf = document.getElementById("side-tab-files"); if (stf) stf.textContent = t("sideFiles");
  const ofi = document.getElementById("outline-filter") as HTMLInputElement | null; if (ofi) ofi.placeholder = t("outlineFilterPh");
  const ffi = document.getElementById("ftree-filter") as HTMLInputElement | null; if (ffi) ffi.placeholder = t("filterFilesPh");
  const rt = document.getElementById("recent-title"); const rts = rt ? rt.querySelector("span") : null; if (rts) rts.textContent = t("recentTitle");
  const rc = document.getElementById("recent-clear"); if (rc) { rc.title = t("clearRecentTip"); rc.textContent = t("clearRecent"); }
  const fp = document.getElementById("ftree-path") as HTMLInputElement | null; if (fp) fp.placeholder = t("treePathPh");
  const fr = document.getElementById("ftree-refresh"); if (fr) fr.title = t("treeRefreshTip");
  const gsi = document.getElementById("gsearch-input") as HTMLInputElement | null; if (gsi) gsi.placeholder = t("gsearchPh");
  const qot = document.getElementById("qo-title"); if (qot) qot.textContent = t("quickOpenTitle");
  const qoi = document.getElementById("qo-input") as HTMLInputElement | null; if (qoi) qoi.placeholder = t("quickOpenPh");
  const cki = document.getElementById("cmdk-input") as HTMLInputElement | null; if (cki) cki.placeholder = t("cmdkPh");
  const ckf = document.getElementById("cmdk-foot"); if (ckf) ckf.textContent = t("cmdkFoot");
  // v0.4.0 File/View menu text (menu items all reuse existing keys)
  const bfm2 = document.getElementById("btn-file-menu"); if (bfm2) bfm2.textContent = t("menuFile") + " ▾";
  const bvm2 = document.getElementById("btn-view-menu"); if (bvm2) bvm2.textContent = t("menuView") + " ▾";
  const setTxt = (id: string, key: string) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  setTxt("fm-open", "openMenu"); setTxt("fm-save", "save"); setTxt("fm-save-as", "saveAs"); setTxt("fm-history", "histBtn");
  setTxt("fm-export-pdf", "exportPdf"); setTxt("fm-export-html", "exportHtmlStyled");
  setTxt("fm-export-html-plain", "exportHtmlPlain"); setTxt("fm-export-image", "exportPng");
  setTxt("fm-export-docx", "exportDocx"); setTxt("fm-print", "printMenu"); setTxt("fm-diag", "diagBtn");
  setTxt("vm-reading", "readingFocus"); setTxt("vm-side", "sbSide");
  setTxt("vm-cmdk", "cmdkOpen"); setTxt("vm-qopen", "quickOpenTitle");
  // v0.4.0 status bar + theme menu (theme-select was removed from the toolbar)
  const sbz = document.getElementById("sb-zoom"); if (sbz) sbz.title = t("zoomResetTip");
  setSideCollapsed(sideCollapsed, false); // refresh the sidebar button text (state unchanged, nothing written)
  document.querySelectorAll<HTMLElement>("#theme-menu button").forEach((b) => {
    const nm = b.dataset.theme as string | undefined;
    if (nm) b.textContent = t(themeNameKey(nm)); // the user: prefix returns the file name, t() falls back to it as is
  });
  const tm = document.getElementById("tab-menu");
  if (tm) {
    const setTxt = (act: string, key: string) => {
      const b = tm.querySelector(`button[data-act="${act}"]`);
      if (b && act !== "close-selected") b.textContent = t(key); // "Close selected" carries a dynamic count, refreshed when opened
    };
    setTxt("close", "tabClose"); setTxt("close-others", "tabCloseOthers");
    setTxt("close-all", "tabCloseAll"); // close-right/left text is set dynamically by openTabMenu based on tab position
  }
  renderRecent();
  const eh = document.getElementById("empty-hint"); if (eh) eh.textContent = t("emptyHint");
  const cmsg = document.getElementById("cc-msg"); if (cmsg) cmsg.textContent = t("closeSaveMsg");
  const csave = document.getElementById("cc-save"); if (csave) csave.textContent = t("closeSave");
  const cdisc = document.getElementById("cc-discard"); if (cdisc) cdisc.textContent = t("closeDiscard");
  const ccan = document.getElementById("cc-cancel"); if (ccan) ccan.textContent = t("closeCancel");
  const sel = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (sel) sel.value = currentLang;
  const fss = document.getElementById("font-size-select") as HTMLInputElement | null;
  if (fss) fss.title = t("fontSizeTip");
  document.documentElement.lang = currentLang; // a11y: screen reader pronunciation / CSS :lang follow the language
  document.title = t("appName"); // browser tab / Tauri window / taskbar title follow the language
  updateModeUI();
}

// Switch the UI language: persisted (localStorage) + Vditor rebuild (inject the new language's i18n) + static text update
function setLang(lang: Lang) {
  // reentry lock: no reentry while a mode switch (switchMode) rebuild is in flight (switchInFlight), avoiding concurrent destroy/new causing double instances / leftover DOM / lost content
  if (lang === currentLang || switchInFlight) return;
  currentLang = lang;
  // clear font-size interaction state (same as switchMode): after a rebuild savedRange/savedTa dangle and fontInputInteracting must be reset
  fontInputInteracting = false; savedRange = null; savedTa = null; savedStart = 0; savedEnd = 0;
  clearFontSelHl();
  try { prefSet("md-editor-lang", lang); } catch { /* storage disabled, only this session */ }
  applyAllText();
  if (vditor) {
    switchInFlight = true; // locked during the language rebuild, mutually exclusive with switchMode (released in the after callback)
    const cur = activeDoc();
    if (cur) {
      const v = mdValue();
      if (v !== "" || cur.content === "") cur.content = v;
      // the welcome page (no path) updates its content with the language; user documents (with a path) keep their content
      if (!cur.path) { cur.content = welcomeMd(); cur.name = t("welcomeName"); cur.dirty = false; }
    }
    // same as switchMode: a language rebuild must also keep --doc-zoom (the real cause of the report "the text got bigger after switching language" —
    // the font size didn't change, the 80% zoom was cleared by destroy and the view went back to 100%)
    const savedZoom = document.getElementById("editor")?.style.getPropertyValue("--doc-zoom") || "";
    vditor.destroy();
    vditor = null;
    vditor = new Vditor("editor", vditorOptions(currentMode));
    if (savedZoom) document.getElementById("editor")?.style.setProperty("--doc-zoom", savedZoom);
  }
}

// In WYSIWYG mode show the table floating panel (vditor-panel) when the caret enters a table cell.
// In Vditor 3.11.2 the "caret enters table → show panel" logic doesn't fire for a wysiwyg instance after a destroy/rebuild,
// so selectionchange is watched here to show/hide the panel; the native add/remove row/column buttons inside it work fine.
function bindTablePopoverVisibility() {
  document.addEventListener("selectionchange", () => {
    if (!vditor || currentMode !== "wysiwyg") return;
    const wysEl = document.querySelector("#editor .vditor-wysiwyg");
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel") as HTMLElement | null;
    if (!wysEl || !popover) return;
    const sel = window.getSelection();
    const anchor = sel && sel.anchorNode;
    // the selection can land on a text node (whose parentElement is the cell) or directly on an empty cell element (the cell itself);
    // take the "start element" first and then closest, so an empty cell with anchor.parentElement=tr isn't missed (cellFound=false → panel not shown)
    const startEl = anchor ? (anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement) : null;
    const cell = startEl ? startEl.closest("td,th") : null;
    // show the panel when the caret is in a table cell or inside the panel (clicking buttons / typing row/column counts);
    // clicking panel buttons / the row/column inputs moves the selection onto the popover, which must count as "still editing the table",
    // otherwise the panel vanishes at the first touch (no repeated row/column changes, no editing the row/column numbers)
    const inPopover = startEl ? popover.contains(startEl) : false;
    if ((cell && wysEl.contains(cell)) || inPopover) {
      popover.classList.remove("vditor-panel--none");
      popover.style.display = "block";
      if (cell && wysEl.contains(cell)) {
        // only reposition when the caret is in the table; keep it in place while clicking the panel to avoid jumping
        const cellRect = (cell as HTMLElement).getBoundingClientRect();
        const wysRect = (wysEl as HTMLElement).getBoundingClientRect();
        popover.style.left = Math.max(0, cellRect.left - wysRect.left) + "px";
        const popH = popover.offsetHeight;
        let top = cellRect.top - wysRect.top - popH - 4;
        if (top < 4) top = cellRect.bottom - wysRect.top + 4; // no room above, place it below
        popover.style.top = top + "px";
      }
    } else {
      popover.style.display = "none";
      popover.classList.add("vditor-panel--none");
    }
  });
}

// The table panel's row/column number boxes: don't add/remove immediately while typing (avoids per-character triggering — to change the row count to 20, typing "2" first would
// shrink to 2 rows immediately and delete the data from row 3 on). Instead add/remove to the target value once on confirm (Enter/blur).
// spinner ±1 uses the same channel: clicking the spinner changes the box value, rows/columns change only on confirm.
let tableInputIgnore = false; // temporary pass-through (on confirm, dispatch input so Vditor adds/removes)
function commitTableInput(t: HTMLInputElement) {
  tableInputIgnore = true;
  t.dispatchEvent(new Event("input", { bubbles: true })); // let it through: Vditor adds/removes to the target row/column count from value
  window.setTimeout(() => { tableInputIgnore = false; }, 100);
}
function bindTableInputConfirm() {
  // capture interception: stop Vditor adding/removing on every input event (passes through when tableInputIgnore)
  document.addEventListener("input", (e) => {
    if (tableInputIgnore) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel");
    if (!popover || !popover.contains(t)) return;
    e.stopImmediatePropagation(); // block Vditor's input listener (per-character add/remove)
  }, true);
  // Enter confirms → add/remove to the current value in one go
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel");
    if (!popover || !popover.contains(t)) return;
    e.preventDefault();
    commitTableInput(t);
    t.blur();
  }, true);
  // blur confirms → add/remove to the current value in one go
  document.addEventListener("focusout", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
    const popover = document.querySelector("#editor .vditor-wysiwyg .vditor-panel");
    if (!popover || !popover.contains(t)) return;
    commitTableInput(t);
  }, true);
}

// Close confirmation dialog: returns the user's choice save and close / close without saving / cancel
// Reentry lock: concurrent calls (a second CloseRequested triggered by destroy, or rapid × clicks) share the same Promise, so the first never hangs
let closeConfirmInFlight: Promise<"save" | "discard" | "cancel"> | null = null;
function showCloseConfirm(): Promise<"save" | "discard" | "cancel"> {
  if (closeConfirmInFlight) return closeConfirmInFlight;
  closeConfirmInFlight = new Promise((resolve) => {
    const mask = document.getElementById("close-confirm")!;
    mask.hidden = false;
    const onAction = (action: "save" | "discard" | "cancel") => {
      mask.hidden = true;
      document.getElementById("cc-save")!.onclick = null;
      document.getElementById("cc-discard")!.onclick = null;
      document.getElementById("cc-cancel")!.onclick = null;
      closeConfirmInFlight = null;
      resolve(action);
    };
    document.getElementById("cc-save")!.onclick = () => onAction("save");
    document.getElementById("cc-discard")!.onclick = () => onAction("discard");
    document.getElementById("cc-cancel")!.onclick = () => onAction("cancel");
  });
  return closeConfirmInFlight;
}

// Save a single document: save directly if it has a path, otherwise Save As; returns whether saving succeeded
// getValue guard: empty values don't overwrite doc.content (prevents an IR-mode empty read from wiping the file)
async function saveDoc(doc: Doc): Promise<boolean> {
  if (vditor && activeDoc()?.id === doc.id) {
    const v = mdValue();
    if (v !== "" || doc.content === "") doc.content = v;
  }
  (window as any).__sLog = (window as any).__sLog || []; // diagnostics: value and stack at save time
  if ((window as any).__sLog.length < 40)
    (window as any).__sLog.push({ v: doc.content.slice(-16), u: doc.undoStack.length, r: doc.redoStack.length });
  let path = doc.path;
  if (!path) {
    const sp = await saveDialog({ filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!sp) return false; // user cancelled Save As
    path = sp as string;
    doc.path = path;
    doc.name = path.split(/[\\/]/).pop()!;
  }
  if (doc.content === "") {
    const seq = '"';
    showToast(seq + doc.name + t("saveEmptySuf"), "info");
    return false;
  }
  try {
    const sm = await invoke<{ mtimeMs: number; size: number }>("save_file", { path, content: doc.content });
    doc.dirty = false;
    doc.base = doc.content; // v0.3.21 the undo stack's clean baseline follows the save
    doc.bytes = utf8Bytes(doc.content); // v0.3.26 status-bar size
    // v0.5.2 external change baseline = handle metadata returned by the save: reading back by path right after the rename may get the old directory entry
    // (the old refreshMeta stored the stale value and never refreshed it — root cause of the false "modified externally" dialog after saving)
    doc.metaMtime = sm.mtimeMs;
    doc.metaSize = sm.size;
    if (activeDoc()?.id === doc.id) scheduleOutline();
    scheduleSessionSave();
    return true;
  } catch (e) {
    showToast(t("saveFail") + doc.name + " — " + e, "danger");
    return false;
  }
}

// v0.4.11 Save As (multi-format): MD = write to the new path, the current document switches to the new file (old file untouched, same as Typora);
// PDF/HTML/PNG/DOCX = export a copy (current document untouched) — forwards to the existing export buttons + pickExportPath path injection,
// reusing the progress overlay / formula rendering / image embedding / empty-document confirmation chain with zero duplication.
// Path selection: production = saveDialog (multiple save types); e2e self-test = export_selftest_dir, skipping the dialog the same way
async function pickSaveAsPath(doc: Doc): Promise<string | null> {
  try {
    const dir = await invoke<string | null>("export_selftest_dir");
    if (dir) return dir.replace(/[\\/]+$/, "") + "/" + (doc.path || t("untitled") + ".md").split(/[\\/]/).pop()!;
  } catch { /* normal startup */ }
  const sp = await saveDialog({
    defaultPath: doc.path || t("untitled") + ".md",
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "HTML", extensions: ["html"] },
      { name: "PNG", extensions: ["png"] },
      { name: "Word", extensions: ["docx"] },
    ],
  });
  return sp ? (sp as string) : null;
}
async function saveDocAs(doc: Doc): Promise<boolean> {
  if (vditor && activeDoc()?.id === doc.id) {
    const v = mdValue();
    if (v !== "" || doc.content === "") doc.content = v; // same guard as saveDoc: empty values don't overwrite
  }
  const path = await pickSaveAsPath(doc);
  if (!path) return false; // user cancelled
  // extensions other than .md: call the export function for that extension with the chosen path (same semantics as Typora's "Save As" type choice;
  // v0.4.11b review M1 rework = pass parameters directly, nothing left behind on empty-document / reentry-lock early returns)
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") { void exportPdf(path); return true; }
  if (ext === "html") { void exportHtml(true, path); return true; }
  if (ext === "png") { void exportImagePng(path); return true; }
  if (ext === "docx") { void exportDocx(path); return true; }
  // MD: block empty content (the export branches guard empty documents in their own chain)
  if (doc.content === "") {
    const seq = '"';
    showToast(seq + doc.name + t("saveEmptySuf"), "info");
    return false;
  }
  // review M5: target already open in another tab → refuse (two tabs with the same path would overwrite each other via the 30s autosave)
  const dup = docs.find((d) => d !== doc && d.path && d.path.toLowerCase() === path.toLowerCase());
  if (dup) { showToast(t("saveAsDupTab") + dup.name, "info"); return false; }
  try {
    const sm = await invoke<{ mtimeMs: number; size: number }>("save_file", { path, content: doc.content });
    doc.path = path;
    doc.name = path.split(/[\\/]/).pop()!;
    doc.dirty = false;
    doc.base = doc.content; // the undo stack's clean baseline follows (same as saveDoc)
    doc.encoding = "UTF-8"; // always written as UTF-8 without BOM (same as manual save)
    doc.bytes = utf8Bytes(doc.content);
    doc.metaMtime = sm.mtimeMs; doc.metaSize = sm.size; // v0.5.2 external change baseline = handle metadata returned by the save (same as saveDoc)
    pushRecent(path);
    renderTabs();
    updateTitle();
    if (activeDoc()?.id === doc.id) scheduleOutline();
    scheduleSessionSave();
    showToast(t("saveAs") + " " + doc.name, "success");
    return true;
  } catch (e) {
    showToast(t("saveFail") + doc.name + " — " + e, "danger");
    return false;
  }
}

// Save all unsaved documents (used by "Save and close" before closing the window)
async function saveAllDirty() {
  for (const doc of docs) {
    if (doc.dirty) await saveDoc(doc);
  }
}

// ---- autosave (batch 2): silently writes only documents that are dirty and have a path ----
// untitled documents are skipped (nowhere to write); failures are silent but dirty is kept (the title * stays = noticeably unsaved), every 30s + on window blur
const AUTOSAVE_INTERVAL_MS = 30_000;
let autosaveTimer: number | undefined;
async function autosaveDirty(): Promise<void> {
  if (!vditor) { cemTrace("as-guard vditor"); return; }
  if (switchApplyPending) { cemTrace("as-guard switchApplyPending"); return; } // v0.3.25 large-document switch loading: mdValue would return the old document now, skip this round
  if (activeDoc()?.lazy || activeDoc()?.loading) { cemTrace("as-guard lazy/loading"); return; } // v0.3.26 lazy loading window: same, prevents writing the old document into a placeholder tab
  // fallback: when focus leaves right after typing, Vditor's input callback may still be inside its debounce window (dirty not set) —
  // read the true value from the editor and compare without waiting for the callback (proven by fullcheck A11b: blurring right after typing lost the last part)
  const a = activeDoc();
  if (a?.path) {
    if (a.large) { flushValueSync(a); } // v0.3.25 large document: only read when something is pending (idle reading costs nothing on the 30s tick)
    else {
      const v = mdValue();
      if ((v !== "" || a.content === "") && v !== a.content) { a.content = v; a.dirty = true; }
    }
  }
  for (const doc of docs) {
    if (!doc.dirty || !doc.path) continue;
    if (activeDoc()?.id === doc.id && !doc.large) { // v0.3.25 large documents just read the true value in flushValueSync above, don't pay 465ms twice
      const v = mdValue();
      if (v !== "" || doc.content === "") doc.content = v; // guard: empty values don't overwrite (same as saveDoc)
    }
    if (doc.content === "") continue;
    try {
      const sm = await invoke<{ mtimeMs: number; size: number }>("save_file", { path: doc.path, content: doc.content });
      doc.dirty = false;
      doc.encoding = "UTF-8"; // always written as UTF-8 without BOM (same as manual save)
      doc.metaMtime = sm.mtimeMs; doc.metaSize = sm.size; // v0.5.2 external change baseline = handle metadata returned by the save (same as saveDoc)
      doc.bytes = utf8Bytes(doc.content);
      if (activeDoc()?.id === doc.id) { updateTitle(); renderTabs(); }
    } catch { /* fail silently: dirty kept, retried next round */ }
  }
  // v0.5.1 better external change awareness: the 30s cycle also checks the active document (when a file is changed externally while the editor is open,
  // the dialog appears without switching tabs/windows; after our own save the baseline is refreshed, so we never flag ourselves)
  const act = activeDoc();
  if (act && !act.dirty) void checkExternalMod(act);
}
function startAutosave() {
  if (autosaveTimer !== undefined) return;
  autosaveTimer = window.setInterval(() => { void autosaveDirty(); }, AUTOSAVE_INTERVAL_MS);
  window.addEventListener("blur", () => { window.setTimeout(() => { void autosaveDirty(); }, 200); });
}

// ---- focus mode + typewriter mode (batch 2, Typora's F8/F9 counterparts) ----

// Editor scroll container: search upward from pre.vditor-reset itself for the first scrollable element (measured: scrolling happens on pre itself, overflowY:auto)
function editorScrollEl(): HTMLElement | null {
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null;
  let el: HTMLElement | null = root;
  while (el) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

// ---- v0.4.8 reading scroll: double-click empty body space to toggle smooth auto-scrolling (a "read long text" mode instead of the wheel) ----
// Speed calibration (user asked "what speed is most comfortable for reading moving text"): when reading while scrolling the eye doesn't track letter by letter — the gaze
// moves down within a band of the screen and sweeps back after a screenful (return sweep); the comfortable upper bound ≈ one's silent reading throughput. Average silent reading
// is ~350 characters/minute for dense scripts (study range 250-400); full width ~60 characters/line, line height ~26px → ~12 s/line ≈ 2-3 px/s.
// Default 6.0 px/s (raised from 3.0 in v0.4.9: real reading feedback "a bit slow" — the theoretical 2-3px/s calibration was conservative,
// the real comfort range skews toward the upper silent reading speed, 6px/s ≈ skimming pace; ↑↓ still fine-tune live);
// individual differences are large (academic consensus is to let users choose) → ↑↓ keys adjust ±0.5 live and persist.
// The key for eye comfort = slow + continuous: requestAnimationFrame accumulates speed increments per frame and only writes scrollTop when the
// write granularity (0.5px) is reached (sub-pixel assignments are quantised back to 0 by the engine, see the rsAcc comment); at 3px/s
// that's ≈ 6 half-pixel steps per second, imperceptibly smooth, avoiding the "jittering text" of whole-pixel timer jumps.
let rsOn = false;
let rsSpeed = 6.0; // px/s, adjustment range [0.5, 100]. v0.4.9 default 3 → 6 (real reading "a bit slow");
// v0.4.10 max 30 → 100 (user reported not fast enough) + graded steps (see keydown). The user's speed persists in
// ui-state.rsSpeed, restored at boot (the default only applies on first use)
let rsLast = 0;
let rsRaf = 0;
let rsPos = 0; // JS-side floating-point true position (relative to rsBase) — the single source of truth for speed
let rsBase = 0; // scrollTop baseline at start / container change
let rsEl: HTMLElement | null = null; // container reference tracking (reset the baseline when it changes)
function rsShowSpd(): void { showToast(t("readScrollSpd").replace("{v}", rsSpeed.toFixed(1)), "info", "rs-spd"); }
function rsStop(silent = false): void {
  if (!rsOn) return;
  rsOn = false;
  cancelAnimationFrame(rsRaf);
  if (!silent) showToast(t("readScrollOff"), "info");
}
// v0.4.9b absolute-value writes (v0.4.8's increment + read-back compensation measured ~2× amplification and was rejected): inside a zoomed container
// scrollTop is written and read on different scales and small values are quantised — write 0.5 read 0, write 1 read 1.111 (=1/0.9),
// write ≥10 reads back identical (measured mapping experiment). Any approach where "the read-back value feeds the speed calculation" gets scrambled
// by this mapping (measured displacement always n/0.9). Instead JS accumulates speed in the float rsPos and writes the absolute value
// rsBase+rsPos each frame: engine quantisation is self-consistent, once the position leaves the small-value zone (<10px) read-back is identical and speed is exactly rsSpeed;
// the first <10px have a 1/0.9 (~11%) error, passed within a second, unnoticeable.
function rsLoop(ts: number): void {
  if (!rsOn) return;
  const dt = (ts - rsLast) / 1000; rsLast = ts;
  const el = editorScrollEl();
  if (!el || !document.body.contains(el)) { rsStop(true); return; } // container gone due to a mode switch / document rebuild
  if (el !== rsEl) { rsEl = el; rsBase = el.scrollTop; rsPos = 0; }
  rsPos += rsSpeed * dt;
  el.scrollTop = rsBase + rsPos;
  if (el.scrollTop >= el.scrollHeight - el.clientHeight - 0.5) { rsStop(true); showToast(t("readScrollEnd"), "info"); return; }
  rsRaf = requestAnimationFrame(rsLoop);
}
function rsStart(): void {
  const el = editorScrollEl();
  if (!el) return;
  rsOn = true; rsLast = performance.now();
  rsEl = null; // reset the baseline on the first frame (keeping the last container reference would skip baseline initialisation)
  rsRaf = requestAnimationFrame(rsLoop);
  showToast(t("readScrollOn"), "info");
}
// Whether the double-click landed on body "blank space" (not on text). caretRangeFromPoint's startContainer can't be used:
// clicks in the blank space right of a line end / between lines "snap" to the nearest text node (startContainer is always text),
// so all visual blank space would be misjudged as text. Use character-level detection instead: take the snapped text node, check each character's Rect against the click point
// to see whether it really lands on a character's rect (±2px tolerance) — line gaps / right of line ends / space between paragraphs / images all count as blank,
// only landing on a character lets the default double-click select a word. The toolbar and overlays are not body text.
function rsDblHitBlank(e: MouseEvent): boolean {
  const tgt = e.target as HTMLElement | null;
  if (!tgt || tgt.closest(".vditor-toolbar, .vditor-panel, .vditor-hint, .vditor-tip")) return false;
  const ed = document.getElementById("editor");
  if (!ed || !ed.contains(tgt)) return false;
  const d = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const hit = d.caretRangeFromPoint ? d.caretRangeFromPoint(e.clientX, e.clientY) : null;
  const n = hit?.startContainer;
  if (!n || n.nodeType !== 3 || !(n.nodeValue || "")) return true;
  const rng = document.createRange();
  for (let i = 0; i < (n.nodeValue || "").length; i++) {
    rng.setStart(n, i); rng.setEnd(n, i + 1);
    const cr = rng.getBoundingClientRect();
    if (e.clientX >= cr.left - 2 && e.clientX <= cr.right + 2 && e.clientY >= cr.top - 2 && e.clientY <= cr.bottom + 2) {
      return false; // clicked on a character rect = text area
    }
  }
  return true;
}
function setupReadingScroll(): void {
  // double-click blank toggles (delegated to #editor: Vditor mode/language subtree rebuilds don't lose it). A dblclick sequence includes
  // two clicks, so don't stop on mousedown — stop paths = double-click again / Esc / wheel / typing / blur; a single click on the body doesn't stop it
  document.getElementById("editor")!.addEventListener("dblclick", (e) => {
    if (!rsDblHitBlank(e)) return;
    e.preventDefault();
    if (rsOn) rsStop(); else rsStart();
  });
  // keyboard (window capture layer, same strategy as Ctrl+Z/S — Vditor's element-layer keydown calls stopPropagation):
  // Esc = stop; ↑↓/+- = adjust speed (intercepted, caret doesn't move); any other key = stop (typing/editing intent, default not blocked)
  window.addEventListener("keydown", (e) => {
    if (!rsOn) return;
    if (e.key === "Escape") { rsStop(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "+" || e.key === "=" || e.key === "-") {
      e.preventDefault(); e.stopPropagation();
      // v0.4.10 graded steps: with a fixed 0.5 step, going from 6 to the max took hundreds of presses (user report "is 30 really the fastest,
      // still slow") — max raised to 100 (fast skimming), the step grows with speed: <10 uses 0.5 fine steps,
      // 10-30 uses 2, ≥30 uses 5, so 6 → 100 takes about 25 presses
      const dir = e.key === "ArrowDown" || e.key === "-" ? -1 : 1;
      const step = (rsSpeed >= 30 ? 5 : rsSpeed >= 10 ? 2 : 0.5) * dir;
      rsSpeed = Math.min(100, Math.max(0.5, rsSpeed + step));
      saveUiStateKey("rsSpeed", rsSpeed); // speed persisted: remembered next launch
      rsShowSpd();
      return;
    }
    rsStop(); // any other key (including typing, page keys) = user edit/navigation intent, stop scrolling and step aside
  }, true);
  // manual wheel = stop (the user takes over scrolling); window blur = stop
  document.getElementById("editor")!.addEventListener("wheel", () => { rsStop(); }, { passive: true, capture: true });
  window.addEventListener("blur", () => { rsStop(true); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) rsStop(true); });
}

// Scroll the caret into the view band (40% line): reused by paste-follow (typewriter mode itself was removed at the user's request).
// Smoothly compensates once it drifts more than about one line (~28px)
function typewriterScroll() {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // no visible caret (e.g. focus in an input box)
  const sc = editorScrollEl();
  if (!sc) return;
  const cur = r.top - sc.getBoundingClientRect().top;
  const target = sc.clientHeight * 0.4;
  const delta = cur - target;
  if (Math.abs(delta) > 28) sc.scrollTo({ top: sc.scrollTop + delta, behavior: reducedMotion() ? "auto" : "smooth" });
}

function bindPasteCaretFollow() {
  // paste follows the caret (unrelated to typewriter, general UX): after pasting long text the caret ends up outside the viewport,
  // so the viewport must scroll there (user measured "I have to page manually to find the caret").
  // The listener must be in the capture phase: Vditor's element-level paste handling calls stopPropagation, so it never bubbles to document.
  // The anchor check runs 350ms later: at the moment of pasting the anchor is in Vditor's temporary receiving node (outside the editor),
  // and only lands at the end of the paste after insertion (probe confirmed anchorIn=True). Retried at two points against re-render races.
  let pasteAt = 0;
  document.addEventListener("paste", () => {
    pasteAt = Date.now();
    window.setTimeout(() => { if (Date.now() - pasteAt < 4000) scrollCaretIntoBand(); }, 350);
    window.setTimeout(() => { if (Date.now() - pasteAt < 4000) scrollCaretIntoBand(); }, 900);
  }, true);
}

// Caret into band: selections outside the editor are ignored; visible = no change; outside the viewport = scroll to the 40% band; invalid rect (render race) = native fallback
function scrollCaretIntoBand() {
  const sel = getSelection();
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!sel || sel.rangeCount === 0 || !root || !root.contains(sel.anchorNode ?? null)) return;
  const sc = editorScrollEl();
  if (!sc) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  const scRect = sc.getBoundingClientRect();
  if (r.height > 0 && r.top >= scRect.top - 5 && r.bottom <= scRect.bottom + 5) return; // already visible
  if (r.height > 0) { typewriterScroll(); return; }
  const el = sel.getRangeAt(0).startContainer.parentElement as HTMLElement | null;
  el?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
}

// ---- find/replace (batch 2): overlay highlight layer approach ----
// Highlights are drawn on a fixed overlay (not in the contenteditable DOM → doesn't pollute the md source / undo stack);
// single replace uses execCommand (typing pipeline, full undo); replace all works at the source level (snapshot nodes get invalidated by Vditor re-renders, the source level is absolutely reliable)
interface FindMatch { node: Text; start: number; end: number; }
let findMatches: FindMatch[] = [];
let findIndex = -1;
// v0.3.11 regex mode: the find bar ".*" toggle (kept for the session). Literal mode is case-insensitive; regex defaults to gi
// (consistent with literal behaviour), metacharacters active, replace supports $1 references. An invalid regex counts as 0 hits and is flagged in the count area.
let findRegexOn = false;

function buildFindRegex(query: string): RegExp | null {
  try { return new RegExp(query, "gi"); } catch { return null; }
}

function scanMatches(query: string): FindMatch[] {
  const out: FindMatch[] = [];
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset");
  if (!root || !query) return out;
  const re = findRegexOn ? buildFindRegex(query) : null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      // 1=FILTER_ACCEPT 2=FILTER_REJECT (TS lib's filter type lacks the FILTER constants, so numbers are used)
      return (!p || p.closest(".vditor-hint, .vditor-panel")) ? 2 : 1; // the editor's own UI is not searched
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (findRegexOn) {
      if (!re) break; // invalid regex: empty result
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t.data)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; } // empty match (e.g. a*) prevents an infinite loop
        out.push({ node: t, start: m.index, end: m.index + m[0].length });
      }
    } else {
      const hay = t.data.toLowerCase();
      const q = query.toLowerCase();
      let i = hay.indexOf(q);
      while (i !== -1) {
        out.push({ node: t, start: i, end: i + q.length });
        i = hay.indexOf(q, i + q.length);
      }
    }
  }
  return out;
}

function renderFindOverlay() {
  const ov = document.getElementById("find-overlay");
  const cnt = document.getElementById("find-count");
  if (!ov) return;
  ov.innerHTML = "";
  findMatches.forEach((m, i) => {
    try {
      const r = document.createRange();
      r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
      for (const rect of r.getClientRects()) {
        const d = document.createElement("div");
        d.className = "find-mark" + (i === findIndex ? " current" : "");
        d.style.left = rect.left + "px";
        d.style.top = rect.top + "px";
        d.style.width = Math.max(rect.width, 4) + "px";
        d.style.height = rect.height + "px";
        ov.appendChild(d);
      }
    } catch { /* node already removed by a Vditor re-render: skip this match */ }
  });
  if (cnt) cnt.textContent = findMatches.length === 0 ? "0/0" : `${findIndex + 1}/${findMatches.length}`;
}

function gotoMatch(idx: number) {
  if (findMatches.length === 0) { findIndex = -1; renderFindOverlay(); return; }
  findIndex = ((idx % findMatches.length) + findMatches.length) % findMatches.length;
  const m = findMatches[findIndex];
  try {
    const r = document.createRange();
    r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
    const rect = r.getBoundingClientRect();
    if (rect.top < 130 || rect.bottom > innerHeight - 60) m.node.parentElement?.scrollIntoView({ block: "center" });
  } catch { /* same as above */ }
  renderFindOverlay();
}

function refreshFind(resetIndex: boolean) {
  if (document.getElementById("find-bar")?.hidden) return;
  const q = (document.getElementById("find-input") as HTMLInputElement).value;
  findMatches = scanMatches(q);
  if (resetIndex || findIndex >= findMatches.length) findIndex = findMatches.length > 0 ? 0 : -1;
  renderFindOverlay();
  // flag an invalid regex explicitly (0/0 being indistinguishable from "not found" would mislead debugging)
  const cnt = document.getElementById("find-count");
  if (cnt && findRegexOn && q && !buildFindRegex(q)) cnt.textContent = "Invalid";
}

function openFind(withReplace: boolean) {
  const bar = document.getElementById("find-bar")!;
  const wasOpen = !bar.hidden; // v0.3.12: when the bar is already open (e.g. Ctrl+F then Ctrl+H to expand the replace row)
  bar.hidden = false;          // don't prefill from the selection — otherwise a leftover editor selection would overwrite the find term the user typed
  if (withReplace) document.getElementById("replace-row")!.hidden = false;
  const inp = document.getElementById("find-input") as HTMLInputElement;
  // prefill with the selected text (≤200 characters); without a selection keep the last keyword
  const selText = wasOpen ? "" : (getSelection()?.toString() ?? "");
  if (selText && selText.length <= 200 && selText.includes("\n") === false) {
    inp.value = selText;
    refreshFind(true);
  }
  inp.focus();
  inp.select();
}

function closeFind() {
  const bar = document.getElementById("find-bar");
  if (!bar || bar.hidden) return;
  bar.hidden = true;
  document.getElementById("replace-row")!.hidden = true;
  findMatches = [];
  findIndex = -1;
  document.getElementById("find-overlay")!.innerHTML = "";
  (document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null)?.focus?.();
}

// Single replace: select with a DOM Range → insert with execCommand (goes through Vditor's typing pipeline: content/undo/outline linkage)
// Focus must return to the editor before resetting the selection: after clicking "Replace" focus is on the button, and execCommand's
// "replace the current selection" doesn't take effect (shows up as inserting without deleting the old word)
function replaceCurrent() {
  const m = findMatches[findIndex];
  if (!m || !vditor) return;
  const repRaw = (document.getElementById("replace-input") as HTMLInputElement).value;
  // regex mode: expand $1/$2 into the actual group contents of the current hit, then go through insertText (typing pipeline / full undo)
  let rep = repRaw;
  if (findRegexOn) {
    const q = (document.getElementById("find-input") as HTMLInputElement).value;
    const hit = m.node.data.slice(m.start, m.end);
    try { rep = hit.replace(new RegExp(q, "i"), repRaw); } catch { /* invalid regex treated literally */ }
  }
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset, .vditor-ir pre.vditor-reset") as HTMLElement | null;
  try {
    const r = document.createRange();
    r.setStart(m.node, m.start); r.setEnd(m.node, m.end);
    root?.focus();
    const sel = getSelection(); sel!.removeAllRanges(); sel!.addRange(r);
    if (!document.execCommand("insertText", false, rep)) return;
  } catch { return; }
  refreshFind(false);
}

// Replace all: DOM replacement loop (each round rescans for a fresh snapshot and replaces the first hit).
// v0.3.12 rework: the old path getValue → setValue(newSrc, **true**) cleared the undo stack = replace all was completely
// irreversible (hard evidence on disk in full testing; a mistaken replace could only be rescued from version history). Changed to the same
// execCommand("insertText") typing pipeline as single replace — one undo step per replacement, Ctrl+Z rolls back one by one (Word semantics).
// The original reason DOM snapshots were abandoned (Vditor re-rendering after execCommand invalidates snapshot nodes) is solved by "rescan every round".
// Semantics note: single/all replace both act on the rendered text (keyword hits containing md markup are consistent);
// insertText inserts the replacement as is, a literal rep containing $&/$1 is not expanded (the String.replace pitfall is gone).
// Replace all: one source-level replacement + setValue without clearing the undo stack (finalised in v0.3.14).
// History lesson: v0.3.13 used a "per-hit execCommand loop" (one undo step each), but Vditor fully re-renders after each
// replacement and resets the selection anchor to element level, so the "already processed boundary" filter stopped working — when the replacement itself
// contained a match ((\d+) → #$1# produces #123#, whose 123 matches again) it snowballed into an infinite loop; e2e B4 confirmed 1500 rounds
// hitting the guard and a mangled document (find-count 1502). After two position-based patches (node equality / FOLLOWING bit,
// compareBoundaryPoints) were both defeated by "re-render resets the anchor", it switched to a single source-level pass like Typora/VSCode:
// one setValue write-back (no second argument = undo stack not cleared), one Ctrl+Z undoes the whole
// replace all (Word semantics). Literal mode uses split/join ($ not expanded); regex mode uses native $1/$& semantics.
// Scope note: the find highlight counts rendered text, replace all works on the source — counts can differ for matches across syntax markup,
// they agree for plain content (Typora's replace all is also source-level).
function replaceAllMatches() {
  if (!vditor) return;
  const q = (document.getElementById("find-input") as HTMLInputElement).value;
  if (!q) return;
  const repRaw = (document.getElementById("replace-input") as HTMLInputElement).value;
  const src = mdValue();
  let out: string;
  if (findRegexOn) {
    let re: RegExp | null = null;
    try { re = new RegExp(q, "gi"); } catch { return; } // invalid regex: do nothing (find-count already shows "Invalid")
    out = src.replace(re, repRaw);
  } else {
    out = src.split(q).join(repRaw);
  }
  if (out === src) { refreshFind(true); return; } // 0 hits
  // v0.3.21 note for the custom undo stack era: historically replace all relied on "setValue without the second argument = Vditor's built-in stack not cleared" for
  // a one-step Ctrl+Z (finalised in v0.3.14); once the custom stack took over the keyboard Vditor's undo is unreachable, so without recording a step explicitly
  // replace all is completely irreversible (B5 confirmed: stack depth 0, Ctrl+Z had nothing to undo). Now the pre-replacement source is one step, Word semantics.
  const doc0 = activeDoc();
  if (doc0) {
    doc0.undoStack.push(src);
    if (doc0.undoStack.length > 100) doc0.undoStack.shift();
    doc0.redoStack.length = 0; // a new edit invalidates the redo branch
  }
  suppressInput = true;
  try { vditor.setValue(out); } finally { suppressInput = false; }
  const doc = activeDoc();
  if (doc) { doc.content = out; doc.dirty = true; }
  snapReset(doc); // align snapBase with the replaced value: later typing opens steps from the correct baseline and doesn't record out twice
  scheduleOutline(); updateTitle(); refreshFind(true);
}

let findInputDebounce: number | undefined;
function bindFindBar() {
  const inp = document.getElementById("find-input") as HTMLInputElement;
  inp.setAttribute("list", "find-hist-dl"); // v0.3.26 find history dropdown (datalist)
  (document.getElementById("replace-input") as HTMLInputElement)?.setAttribute("list", "rep-hist-dl");
  inp.addEventListener("input", () => {
    window.clearTimeout(findInputDebounce);
    findInputDebounce = window.setTimeout(() => refreshFind(true), 250);
  });
  inp.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // Enter/Esc during IME composition belong to the IME
    if (e.key === "Enter") {
      e.preventDefault();
      if (inp.value.trim()) pushFindHistory("findHist", inp.value); // v0.3.26 record history on execution (same as N++)
      gotoMatch(e.shiftKey ? findIndex - 1 : findIndex + 1);
    }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  // all find bar buttons use pointerdown (fires on press): click needs down + up on the same element,
  // and a tiny drag / overlay flash / IME state change eats the event without any error — users reported "it won't click" three times.
  // pointerdown is physically reliable; every handler is idempotent, so a following click re-entering is harmless.
  const onDown = (id: string, fn: () => void) => {
    document.getElementById(id)!.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
  };
  onDown("find-next", () => gotoMatch(findIndex + 1));
  onDown("find-prev", () => gotoMatch(findIndex - 1));
  // regex mode toggle: rescan immediately after toggling (the .* highlight state is the current semantics)
  document.getElementById("find-re")!.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    findRegexOn = !findRegexOn;
    (e.currentTarget as HTMLElement).classList.toggle("active", findRegexOn);
    refreshFind(true);
  });
  // ✕ uses pointerdown rather than click: click needs down + up on the same element, any disturbance (tiny drag,
  // overlay flash, IME state change) eats the event without any error — users reported "clicking ✕ does nothing" twice.
  // pointerdown fires on press; closeFind is idempotent (returns directly if bar.hidden), a following click re-entering is harmless.
  document.getElementById("find-close")!.addEventListener("pointerdown", (e) => { e.preventDefault(); closeFind(); });
  // the ⇄ "expand/collapse replace" button was removed at the user's request: the replace row is controlled only by Ctrl+H
  onDown("replace-one", replaceCurrent);
  onDown("replace-all", () => {
    if (findMatches.length > 500 && !confirm(t("replaceManyConfirm"))) return;
    // v0.3.26 record history when replacing (find term + replacement)
    const fq = (document.getElementById("find-input") as HTMLInputElement).value.trim();
    const rq = (document.getElementById("replace-input") as HTMLInputElement).value.trim();
    if (fq) pushFindHistory("findHist", fq);
    if (rq) pushFindHistory("repHist", rq);
    replaceAllMatches();
  });
  (document.getElementById("replace-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  // global Esc fallback: Esc also closes when focus isn't in the find bar inputs (e.g. in the editor)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    const bar = document.getElementById("find-bar");
    if (bar && !bar.hidden) { e.preventDefault(); closeFind(); }
  });
  // no "click outside to close" (user decision 2026-08-27: the find bar must stay while clicking into the body to edit, and only close on ✕).
  // close paths = ✕ button / Esc (including the global fallback outside the inputs) / 🔍 button toggle.
  // 🔍 find button toggles: open → closed (user expectation: click again to dismiss). Ctrl+F/H still only open (shortcuts while editing don't toggle closed)
  // The old standalone Find button was removed from the toolbar; the current
  // magnifier is #btn-toolbar-find and is wired by initTextColors().
  document.getElementById("btn-find")?.addEventListener("click", () => {
    const bar = document.getElementById("find-bar")!;
    if (!bar.hidden) closeFind(); else openFind(false);
  });
  // Ctrl+F / Ctrl+H (WebView2 has no native find UI). Must use the capture phase + stopPropagation:
  // the hotkey of Vditor's built-in toolbar headings button is ⌘H (Ctrl+H opens the "heading 1-6" dropdown),
  // and its keydown is bound to the editor element, running before the window bubbling handler — without interception both the replace box and the heading menu would pop up.
  // Ctrl+F / Ctrl+H / Ctrl+P are commands in the registry (src/commands.ts), which intercepts in the capture phase before Vditor
  // content changes → highlights sync (document input capture catches contenteditable typing, avoiding touching vditor's shared input callback chain)
  // exclude the find bar's own input: otherwise it would clear find-input's 250ms timer (the same debounce variable stepped on → findIndex always -1)
  document.addEventListener("input", (e) => {
    const tid = (e.target as HTMLElement)?.id;
    if (tid === "find-input" || tid === "replace-input") return;
    if (document.getElementById("find-bar")?.hidden) return;
    window.clearTimeout(findInputDebounce);
    findInputDebounce = window.setTimeout(() => refreshFind(false), 400);
  });
  // scroll → redraw highlights (Ranges follow the DOM, viewport rects need re-reading)
  let findScrollRaf = false;
  document.addEventListener("scroll", () => {
    if (document.getElementById("find-bar")?.hidden || findScrollRaf) return;
    findScrollRaf = true;
    requestAnimationFrame(() => { findScrollRaf = false; renderFindOverlay(); });
  }, true);
  window.addEventListener("resize", () => { if (!document.getElementById("find-bar")?.hidden) renderFindOverlay(); });
}

// Resolve relative image srcs to absolute file:// paths: the Rust side writes the full HTML to a temp file for msedge to render,
// and the msedge process's working folder isn't the document folder, so a relative ./x.png would point into the temp folder and fail.
// Only relative paths (./ or without a protocol) are handled; remote (http/https) and data: base64 stay as is.
// When the doc isn't saved (path=null) the folder can't be resolved → left as is (not a regression, same as before).
function resolveImageSources(fragment: HTMLElement, docPath: string | null) {
  if (!docPath) return;
  // use the document's folder as the base (Windows backslashes unified to slashes)
  const dir = docPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  fragment.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    let src = img.getAttribute("src");
    if (!src) return;
    // v0.3.11 image preview display-layer asset URLs (getHTML generated from the polluted source) → decode back to the absolute disk path,
    // then go through the existing chain below (absolute paths stay as is, the browser normalises them per file:///)
    const am = src.match(/^(?:https?:)?\/\/asset\.localhost\/(.+)$/);
    if (am) {
      try { src = decodeURIComponent(am[1]).replace(/\/$/, ""); img.setAttribute("src", src); }
      catch { /* decode failed, keep as is */ }
    }
    // absolute resources with a protocol (http/https/file) or data: base64 stay as is
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith("data:")) return;
    const clean = src.replace(/^\.\//, "");
    if (/^[a-zA-Z]:[\\/]/.test(clean)) return; // already an absolute Windows path
    const abs = dir + "/" + clean;
    // convert to a file:/// URL: backslash → slash, encodeURI handles non-ASCII characters and spaces
    img.setAttribute("src", "file:///" + encodeURI(abs.replace(/\\/g, "/")));
  });
}

// Wrap the rendered HTML fragment into a complete standalone document for Rust-side msedge headless export.
// The whole Vditor CSS is inlined (compiled into a string constant at build time via ?raw), so the export render rules (.vditor-reset / code highlighting / tables / quotes)
// match the editor; @page sets A4 paper and margins; print styles prevent page-break splits and scale images.
// This HTML is loaded from file:// by a separate msedge process, not through the Tauri webview, so the app CSP (script-src 'self') doesn't apply.
// v0.3.8 fix: katex css's @font-face references fonts/*.woff2 by relative path, which always 404s in the temp html,
// and Chromium print-to-pdf waiting on document.fonts.ready hangs outright (root cause of the overlay never disappearing after D1 and blocking all input) —
// font declarations are stripped at build time, formula glyphs fall back to system fonts (layout like sub/superscripts is controlled by css classes, unaffected), the export has zero external resources.
const katexCssNoFonts = katexCssText.replace(/@font-face\s*\{[^}]*\}/g, "");
function wrapExportHtml(fragmentHtml: string): string {
  const langAttr = "en";
  return `<!DOCTYPE html>
<html lang="${langAttr}">
<head>
<meta charset="UTF-8">
<style>
${vditorCssText}
${katexCssNoFonts}
@page { size: A4; margin: 15mm; }
html, body {
  margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Segoe UI", system-ui, sans-serif;
  font-size: 14px; line-height: 1.75;
}
.vditor-reset { max-width: none; margin: 0; padding: 0; }
pre { white-space: pre-wrap; word-break: break-word; }
/* tables may break across pages; rows stay intact and thead repeats */
pre, tr, blockquote, img { break-inside: avoid; }
img { max-width: 100%; }
/* wide tables: fixed layout + forced wrapping so they fit the A4 page */
.vditor-reset table { border-collapse: collapse; width: 100%; table-layout: fixed; display: table; overflow: visible; }
.vditor-reset table th, .vditor-reset table td { overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
</style>
</head>
<body class="vditor-reset"><div class="vditor-reset">${fragmentHtml}</div></body>
</html>`;
}

// ===== v0.3.0 export centre: HTML two variants / long image / DOCX (v0.3.2 removed "copy rich text", v0.3.5 removed the Pandoc bridge) =====


/** File → plain base64 (without the data: prefix) */
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve((fr.result as string).split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(f);
  });
}

/** Pasted/dropped image saved: Rust writes to assets/ (or pasted/ for untitled documents) → insert the reference */
async function handlePasteImages(files: File[]): Promise<null> {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length || !vditor) return null;
  const doc = activeDoc();
  const docDir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : "";
  for (const f of imgs) {
    try {
      const b64 = await fileToBase64(f);
      if (imageDirSetting() === "embed") {
        vditor.insertValue(`\n![](data:${f.type || "image/png"};base64,${b64})\n`);
        continue;
      }
      const ext = (f.name.split(".").pop() || "png").toLowerCase();
      const d0 = new Date(), pad = (x: number) => String(x).padStart(2, "0");
      const stamp = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}_${pad(d0.getHours())}${pad(d0.getMinutes())}${pad(d0.getSeconds())}`;
      const r = await invoke<{ rel: string; abs: string }>("save_paste_image", { docDir, ext, dataB64: b64, imageDir: imageDirSetting(), stamp });
      vditor.insertValue(`\n![](${r.rel})\n`);
    } catch (e) {
      console.error("paste image save failed:", e);
    }
  }
  return null; // suppress Vditor's default upload UI
}

/** Render-layer image path conversion: the source keeps portable relative paths, previews convert them to asset:// URLs (the webview resolves them on the file system) */
function resolvePreviewImages(html: string): string {
  const doc = activeDoc();
  const docDir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
  return html.replace(/(src=")([^"]+)(")/g, (m, p1: string, src: string, p3: string) => {
    if (/^(https?:|data:|blob:|asset:|\/vditor-assets)/i.test(src)) return m;
    let abs: string | null = null;
    if (/^[A-Za-z]:\//.test(src)) abs = src; // absolute path (screenshot pasted into an untitled document)
    else if (docDir) abs = docDir + "/" + src.split("?")[0]; // relative path resolved against the document folder
    if (!abs) return m;
    try { return p1 + convertFileSrc(abs) + p3; } catch { return m; }
  });
}

// ===== v0.3.11 local image preview in the editor (wysiwyg) =====
// Architecture: v0.3.0 traded off "portable source vs display in the editor" — now we want both: the display layer converts relative srcs to
// asset:// (a MutationObserver keeps covering Vditor re-renders), and the serialisation layer always goes through mdValue() to turn asset
// URLs back into relative paths. IR mode keeps using preview.transform (resolvePreviewImages), no interference.
let imgPreviewObserver: MutationObserver | null = null;
function rebindImagePreview(): void {
  imgPreviewObserver?.disconnect();
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset") as HTMLElement | null;
  if (!root) return;
  const fix = (): void => {
    const doc = activeDoc();
    const dir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
    root.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
      const src = img.getAttribute("src") || "";
      // already a display URL (asset) or remote/base64/app resource: leave it. data-orig-src marks it to prevent reentry loops
      if (img.dataset.origSrc !== undefined || !src) return;
      if (/^(https?:|data:|blob:|asset:|\/\/|\/vditor-assets)/i.test(src)) return;
      let abs: string | null = null;
      if (/^[A-Za-z]:[\\/]/.test(src)) abs = src.replace(/\\/g, "/"); // absolute path pasted into an untitled document
      else if (dir) abs = dir + "/" + src.split("?")[0];
      if (!abs) return;
      img.dataset.origSrc = src;
      try { img.src = convertFileSrc(abs); } catch { delete img.dataset.origSrc; }
    });
  };
  fix();
  imgPreviewObserver = new MutationObserver(() => fix());
  imgPreviewObserver.observe(root, { childList: true, subtree: true });
}

// ===== v0.3.11 table column resizing (view-layer approach: md source untouched, widths persisted per document + table signature) =====
// Interaction = Excel/Word-style edge detection: moving the mouse within 6px of a header cell's right edge shows a col-resize cursor, dragging changes the column width,
// the right neighbour compensates (total table width stays stable). table-layout:fixed + first-row th.style.width set the widths (Lute serialisation
// only takes text and alignment, styles never reach the source — e2e asserts getValue stays clean). After Vditor re-renders clear the style,
// the observer reapplies them. The export chain writes the widths into the output alongside resolveImageSources (see applyExportWidths).
const COLW_KEY = "mded-colw-v1";
let tblWidthObserver: MutationObserver | null = null;

function colwAll(): Record<string, Record<string, number[]>> {
  try { return JSON.parse(prefGet(COLW_KEY) || "{}"); } catch { return {}; }
}
function tableSig(tb: HTMLTableElement): string {
  return (tb.rows[0]?.innerText || "").replace(/\s+/g, "").slice(0, 60);
}
function docKeyOf(): string {
  const doc = activeDoc();
  return doc?.path || ("name:" + (doc?.name || ""));
}
/** Apply stored widths to all current tables (called after re-render / document switch / startup) */
function applyTableWidths(): void {
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset");
  if (!root) return;
  const saved = colwAll()[docKeyOf()] || {};
  root.querySelectorAll<HTMLTableElement>("table").forEach((tb) => {
    const w = saved[tableSig(tb)];
    if (!w) return;
    tb.style.tableLayout = "fixed";
    const first = tb.rows[0];
    if (!first) return;
    [...first.cells].forEach((c, i) => { if (w[i] > 0) (c as HTMLElement).style.width = w[i] + "px"; });
  });
}
/** For export: write the editor's current column widths into the export fragment's tables (HTML/PDF/PNG match what you see) */
/** v0.3.24 export tables distribute column widths by content weight: under table-layout:fixed the browser uses the first row's cell widths as
 * the column basis — set percentages on each table's first row instead of equal shares (the # column no longer matches a long-text column's width, long text wraps automatically).
 * Works with applyExportWidths: this function runs first to set percentages as a fallback, then the px widths the user dragged in the editor override them. */
function applyTableColWeights(fragment: HTMLElement): void {
  fragment.querySelectorAll<HTMLTableElement>("table").forEach((tb) => {
    const first = tb.rows[0];
    if (!first) return;
    const cells = [...first.cells];
    const n = cells.length;
    if (n < 2) return;
    const weights = new Array(n).fill(1);
    for (const tr of tb.rows) {
      [...tr.cells].forEach((c, i) => { if (i < n) weights[i] = Math.max(weights[i], visualLen(c.textContent || ""), 1); });
    }
    const pct = allocColWidths(weights, 1000).map((x) => (x / 10).toFixed(1) + "%");
    cells.forEach((c, i) => { (c as HTMLElement).style.width = pct[i]; });
  });
}
function applyExportWidths(fragment: HTMLElement): void {
  const saved = colwAll()[docKeyOf()] || {};
  fragment.querySelectorAll<HTMLTableElement>("table").forEach((tb) => {
    const w = saved[tableSig(tb)];
    if (!w) return;
    tb.style.tableLayout = "fixed";
    const first = tb.rows[0];
    if (!first) return;
    [...first.cells].forEach((c, i) => { if (w[i] > 0) (c as HTMLElement).style.width = w[i] + "px"; });
  });
}
/** v0.3.24 mermaid diagrams scale with zoom: mermaid outputs SVG as width=100% + inline
 * max-width:Npx, while zoom = CSS zoom on #editor .vditor-content — zoom enlarges content but doesn't widen
 * the container (physical width is bound by the window), so a width:100% SVG always looks as wide as the container and zoom has no effect on it (reproduced in headless
 * Chrome). Use an explicit natural px width instead (scales with zoom ✓, also verified), with the outer container
 * scrolling horizontally as a fallback. Idempotent: after processing max-width becomes none, so the px regex no longer matches. */
function fitMermaidSvgs(): void {
  document.querySelectorAll<SVGSVGElement>(".vditor-reset svg").forEach((svg) => {
    const m = /max-width:\s*([\d.]+)px/.exec(svg.getAttribute("style") || "");
    if (!m) return;
    svg.style.width = m[1] + "px";
    svg.style.maxWidth = "none";
    const holder = svg.parentElement;
    if (holder) holder.style.overflowX = "auto"; // scroll instead of breaking the layout when wider than the container
  });
}

function rebindTableResize(): void {
  tblWidthObserver?.disconnect();
  const root = document.querySelector(".vditor-wysiwyg pre.vditor-reset") as HTMLElement | null;
  if (!root) return;
  applyTableWidths();
  fitMermaidSvgs();
  tblWidthObserver = new MutationObserver(() => { applyTableWidths(); fitMermaidSvgs(); });
  tblWidthObserver.observe(root, { childList: true, subtree: true });

  // edge cursor (mousemove throttled toggling, no DOM handles added — zero injection, zero serialisation risk)
  root.addEventListener("mousemove", (e) => {
    const cell = (e.target as HTMLElement).closest?.("th,td") as HTMLElement | null;
    if (!cell) { root.style.cursor = ""; return; }
    const r = cell.getBoundingClientRect();
    const near = e.clientX > r.right - 6 && e.clientX < r.right + 4;
    root.style.cursor = near ? "col-resize" : "";
  });
  root.addEventListener("mouseleave", () => { root.style.cursor = ""; });
  root.addEventListener("mousedown", (e) => {
    const cell = (e.target as HTMLElement).closest?.("th,td") as HTMLElement | null;
    if (!cell || !cell.closest("table")) return;
    const r = cell.getBoundingClientRect();
    if (!(e.clientX > r.right - 6 && e.clientX < r.right + 4)) return;
    const tb = cell.closest("table") as HTMLTableElement;
    const idx = (cell as HTMLTableCellElement).cellIndex;
    const first = tb.rows[0];
    if (!first || idx >= first.cells.length) return;
    // anchor: the editor's real current column widths (the rendered state may differ from the stored values, start from the rect)
    const colRect = (first.cells[idx] as HTMLElement).getBoundingClientRect();
    const nextCell = first.cells[idx + 1] as HTMLElement | undefined;
    const nextRect = nextCell?.getBoundingClientRect();
    const startX = e.clientX;
    const w0 = colRect.width, w1 = nextRect?.width ?? 0;
    tb.style.tableLayout = "fixed";
    (first.cells[idx] as HTMLElement).style.width = w0 + "px";
    if (nextCell) nextCell.style.width = w1 + "px"; // pin the right neighbour's width, dragging only resizes this column + compresses the neighbour
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const nw = Math.max(30, w0 + dx);
      (first.cells[idx] as HTMLElement).style.width = nw + "px";
      if (nextCell) nextCell.style.width = Math.max(30, w1 - dx) + "px";
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const widths = [...first.cells].map((c) => Math.round((c as HTMLElement).getBoundingClientRect().width));
      const all = colwAll();
      const k = docKeyOf();
      all[k] = all[k] || {};
      all[k][tableSig(tb)] = widths;
      try { prefSet(COLW_KEY, JSON.stringify(all)); } catch { /* storage disabled: only this session */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** v0.3.12 the outline sidebar can be resized (like Word's navigation pane): drag within 5px of the right edge, clamp [180, 520]
 *  and no more than half the viewport, width persisted in localStorage. The panel is static, attached once. */
const OUTLINE_W_KEY = "mded-outline-w-v2"; // v2: default width 180 (the user wants to start narrowest), old v1 width values void
const OUTLINE_W_MIN = 120, OUTLINE_W_MAX = 520;
function initOutlineResize(): void {
  const panel = document.getElementById("outline-panel");
  const gutter = document.getElementById("side-gutter");
  if (!panel || !gutter) return;
  const clamp = (w: number): number =>
    Math.min(OUTLINE_W_MAX, Math.max(OUTLINE_W_MIN, Math.min(w, Math.floor(window.innerWidth / 2))));
  try {
    const saved = parseInt(prefGet(OUTLINE_W_KEY) || "", 10);
    panel.style.width = clamp(isNaN(saved) ? DEFAULT_SIDEBAR_WIDTH : saved) + "px";
  } catch { /* storage disabled: use the CSS default width */ }
  // v0.3.15: events hang on a separate handle (no more panel edge detection) — when the outline/file list overflows, the right edge is
  // taken by the native scrollbar, and on real machines mousedown was eaten by the scrollbar = couldn't drag (CDP e2e can't see the non-DOM layer)
  gutter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    gutter.classList.add("dragging");
    const startX = e.clientX, w0 = panel.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent): void => {
      panel.style.width = clamp(w0 + (ev.clientX - startX)) + "px";
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      gutter.classList.remove("dragging");
      try { prefSet(OUTLINE_W_KEY, String(Math.round(panel.getBoundingClientRect().width))); } catch { /* storage disabled: only this session */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** Get the "clean" md source: the wysiwyg display-layer conversion writes img src as asset URLs (DOM serialisation pollution),
 *  so restore portable relative paths before save/export/find. Every getValue call site goes through this function (single exit). */
function mdValue(): string {
  if (!vditor) return "";
  const v = (vditor as { getValue(): string }).getValue(); // indirect call so the global replace below doesn't hit itself
  if (!v.includes("asset.localhost")) return v;
  const doc = activeDoc();
  const dir = doc?.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : null;
  // `![alt](http://asset.localhost/F%3A/dir/x.png)` and `<img src="http://asset.localhost/...">`
  return v.replace(/(\]\(|src=")(?:https?:)?\/\/asset\.localhost\/([^)"\s]+)/g, (m, p1: string, enc: string) => {
    try {
      const abs = decodeURIComponent(enc).replace(/\/$/, "");
      let rel = abs;
      if (dir && abs.toLowerCase().startsWith(dir.toLowerCase() + "/")) rel = abs.slice(dir.length + 1);
      // spaces/brackets would break md link syntax, escape when needed; non-ASCII paths stay as is (same form as when inserted)
      return p1 + rel.replace(/([ ()])/g, (c) => ({ " ": "%20", "(": "%28", ")": "%29" }[c] as string));
    } catch { return m; }
  });
}

/** Load local scripts on demand (/vditor-assets is same-origin, CSP-compliant; de-duplicated cache). Used by export rendering of math/mermaid */
const _loadedScripts = new Map<string, Promise<void>>();
function loadLocalScript(src: string): Promise<void> {
  let p = _loadedScripts.get(src);
  if (!p) {
    p = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("load " + src));
      document.head.appendChild(s);
    });
    _loadedScripts.set(src, p);
  }
  return p;
}

/** v0.3.8 (P1#1 fix): render math/mermaid blocks in place inside the export fragment.
 * Background: getHTML keeps source semantics for $$..$$/```mermaid blocks (<div class="language-math">tex</div>),
 * so in exported HTML/PDF/PNG formulas were plain text and diagrams were code blocks — fine in the editor, lost in the deliverable.
 * Here the blocks are rendered before export: math via KaTeX (the same local library as Vditor), mermaid via mermaid.render.
 * mathOutput: "html" = HTML + MathML dual output (styled variant / PDF / PNG, katex css is in the export template);
 *             "mathml" = pure MathML (the plain variant has no CSS, the browser renders it natively with zero dependencies).
 * Any failure degrades to keeping the source text and never blocks the export. */
/** v0.3.24 minimal mermaid renderer shape (shared by both export pipelines) */
type MmRenderer = { initialize: (o: object) => void; render: (id: string, code: string) => Promise<{ svg: string }> };
/** mermaid SVG string → natural pixel size (viewBox first, width/height as fallback) */
function mmSvgSize(svg: string): { w: number; h: number } {
  try {
    const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const w = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(el.getAttribute("width") || "") || 0;
    const h = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(el.getAttribute("height") || "") || 0;
    return { w, h };
  } catch { return { w: 0, h: 0 }; }
}
/** v0.3.24 round four: very wide mermaid exports switch to vertical automatically.
 * LR/RL panoramas (sample 3596px wide) squeezed into the A4 content area end up at ~15% scale; the diagram is there but the text is unreadable = not fixed.
 * Here the direction declaration LR/RL → TB is re-rendered on the export copy (the user's source file is untouched), and of the two versions the one
 * that scales larger in the A4 content area (550×933px@96dpi, same basis as DOCX MAXW) wins; TB is only used when it's clearly
 * better (>1.15×), so small jitters don't flip the layout back and forth. Any failure keeps the original direction. */
const MM_DIR_RE = /^(\s*(?:flowchart|graph)\s+)(LR|RL)(?=\s)/m;
const MM_FIT_W = 550, MM_FIT_H = 933;
async function pickExportMermaidSvg(mermaid: MmRenderer, code: string, idBase: string): Promise<string | null> {
  let best: { svg: string; scale: number } | null = null;
  try {
    const { svg } = await mermaid.render(idBase + "-a", code);
    const { w, h } = mmSvgSize(svg);
    if (w && h) best = { svg, scale: Math.min(MM_FIT_W / w, MM_FIT_H / h) };
  } catch { return null; }
  if (best && MM_DIR_RE.test(code)) {
    try {
      const { svg } = await mermaid.render(idBase + "-b", code.replace(MM_DIR_RE, "$1TB "));
      const { w, h } = mmSvgSize(svg);
      if (w && h) {
        const scale = Math.min(MM_FIT_W / w, MM_FIT_H / h);
        if (best && scale > best.scale * 1.15) best = { svg, scale };
      }
    } catch { /* TB re-render failed, keep the original direction */ }
  }
  return best ? best.svg : null;
}

async function renderSpecialBlocks(root: HTMLElement, mathOutput: "html" | "mathml"): Promise<void> {
  const maths = [...root.querySelectorAll<HTMLElement>(".language-math")];
  if (maths.length) {
    try {
      await loadLocalScript("/vditor-assets/dist/js/katex/katex.min.js");
      const katex = (window as unknown as { katex?: { render: (tex: string, el: HTMLElement, o: object) => void } }).katex;
      if (katex) {
        for (const el of maths) {
          const tex = (el.textContent || "").trim();
          if (!tex) continue;
          const out = document.createElement("div");
          out.className = "export-math";
          try { katex.render(tex, out, { displayMode: true, throwOnError: false, output: mathOutput }); el.replaceWith(out); }
          catch { /* syntax error in a single block: keep the source text */ }
        }
      }
    } catch { /* library failed to load: keep the source text (degrade without blocking the export) */ }
  }
  const mms = [...root.querySelectorAll<HTMLElement>(".language-mermaid")];
  if (mms.length) {
    try {
      await loadLocalScript("/vditor-assets/dist/js/mermaid/mermaid.min.js");
      const mermaid = (window as unknown as { mermaid?: { initialize: (o: object) => void; render: (id: string, code: string) => Promise<{ svg: string }> } }).mermaid;
      if (mermaid) {
        // v0.3.24 htmlLabels:false initialised the same way as the DOCX image path (renderMermaidPng) —
        // mermaid.initialize merges a global config, so inconsistent forms between the two paths would override each other; plain <text> labels
        // also let the SVG rasterise through <img> (foreignObject limitation, see the renderMermaidPng comment)
        mermaid.initialize({ startOnLoad: false, securityLevel: "loose", htmlLabels: false, flowchart: { htmlLabels: false } });
        for (let i = 0; i < mms.length; i++) {
          const code = (mms[i].textContent || "").trim();
          if (!code) continue;
          // very wide LR/RL diagrams switch to vertical TB (HTML/PDF pipeline, see the pickExportMermaidSvg comment)
          try { const svg = await pickExportMermaidSvg(mermaid as MmRenderer, code, "export-mm-" + Date.now() + "-" + i); if (svg) mms[i].innerHTML = svg; }
          catch { /* single diagram render error: keep the source */ }
        }
      }
    } catch { /* same as above */ }
  }
}

/** v0.3.24 mermaid source → PNG (bytes + original viewBox size), for embedding images in DOCX export.
 * Route: mermaid.render produces SVG → set explicit pixel width/height on a DOMParser copy → load into <img> →
 * rasterise at 2x on a white canvas (zooming in Word stays sharp; a transparent background turns into a black block in Word's dark mode).
 * Key: initialize must turn off htmlLabels — Chromium doesn't render foreignObject inside an SVG rasterised via <img>
 * (security restriction), only plain <text> renders.
 * Any failure returns null, and the caller degrades to keeping the source text. */
async function renderMermaidPng(code: string, seq: number): Promise<{ data: Uint8Array; w: number; h: number } | null> {
  try {
    await loadLocalScript("/vditor-assets/dist/js/mermaid/mermaid.min.js");
    const mermaid = (window as unknown as { mermaid?: { initialize: (o: object) => void; render: (id: string, code: string) => Promise<{ svg: string }> } }).mermaid;
    if (!mermaid) return null;
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", htmlLabels: false, flowchart: { htmlLabels: false } });
    // very wide LR/RL diagrams go through pickExportMermaidSvg first (possibly re-rendered on a TB copy)
    const svgPicked = await pickExportMermaidSvg(mermaid as MmRenderer, code, "docx-mm-" + seq);
    if (!svgPicked) return null;
    const docXml = new DOMParser().parseFromString(svgPicked, "image/svg+xml");
    const svgEl = docXml.documentElement;
    // the natural size follows viewBox (mermaid always has it); width/style are only a fallback
    const vb = (svgEl.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    let w = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(svgEl.getAttribute("width") || "") || 0;
    let h = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(svgEl.getAttribute("height") || "") || 0;
    if (!w || !h) return null;
    const RASTER = 2;
    const cw = Math.min(6000, Math.ceil(w * RASTER)), ch = Math.min(6000, Math.ceil(h * RASTER));
    svgEl.setAttribute("width", String(cw));
    svgEl.setAttribute("height", String(ch));
    svgEl.removeAttribute("style"); // remove the max-width:100% limit so the explicit pixel width applies
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgEl)], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("svg load")); img.src = url; });
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return null;
      return { data: new Uint8Array(await blob.arrayBuffer()), w, h };
    } finally { URL.revokeObjectURL(url); }
  } catch { /* degrade to source text */ return null; }
}

/** Export fragment (shared pipeline for HTML both variants / PNG / PDF: getHTML + relative image resolution + math/mermaid rendering), returns null on failure */
async function exportFragment(mathOutput: "html" | "mathml" = "html"): Promise<string | null> {
  const doc = activeDoc();
  if (!doc || !vditor) { showToast(t("exportNoDoc"), "info"); return null; }
  let fragmentHtml = "";
  try { fragmentHtml = vditor.getHTML(); } catch (e) { showToast(t("exportFail") + e, "danger"); return null; }
  if (!fragmentHtml) { showToast(t("exportNoDoc"), "info"); return null; }
  const tmp = document.createElement("div");
  tmp.innerHTML = fragmentHtml;
  resolveImageSources(tmp, doc.path);
  applyTableColWeights(tmp); // v0.3.24 first-row percentage column widths by content weight (fixed layout basis)
  applyExportWidths(tmp); // v0.3.11 column widths dragged in the editor carried into the export (px overrides percentages)
  await renderSpecialBlocks(tmp, mathOutput);
  return tmp.innerHTML;
}

// v0.4.11b direct parameter passing (review M1 rework): when "Save As…" picks a non-md format, saveDocAs passes the chosen path directly
// to the matching export function (pathOverride) instead of a global injection — an injection leaked leftovers on export-chain early returns (empty document / reentry lock),
// and later normal exports would silently write to the leftover path. Direct passing leaves nothing behind.
async function pickExportPath(ext: string, filterName: string, pathOverride?: string): Promise<string | null> {
  if (pathOverride) return pathOverride;
  const doc = activeDoc();
  const baseName = (doc?.name || t("untitled")).replace(/\.[^.]+$/, "");
  // e2e self-test mode (--export-selftest <dir>): skip the native dialog and build the path directly, same code path as production
  try {
    const dir = await invoke<string | null>("export_selftest_dir");
    if (dir) return dir.replace(/[\\/]+$/, "") + "/" + baseName + ext;
  } catch { /* normal startup */ }
  const sp = await saveDialog({
    defaultPath: baseName + ext,
    filters: [{ name: filterName, extensions: [ext.slice(1)] }],
  });
  return sp ? (sp as string) : null;
}

/** HTML export: styled variant = full layout (same template as PDF); plain variant = bare fragment without CSS (formulas rendered with MathML, zero dependencies) */
async function exportHtml(styled: boolean, pathOverride?: string): Promise<void> {
  const frag = await exportFragment(styled ? "html" : "mathml");
  if (!frag) return;
  const path = await pickExportPath(".html", "HTML", pathOverride);
  if (!path) return;
  const langAttr = "en";
  const html = styled ? wrapExportHtml(frag)
    : `<!DOCTYPE html>\n<html lang="${langAttr}">\n<head><meta charset="UTF-8"></head>\n<body>\n${frag}\n</body>\n</html>\n`;
  try {
    await invoke("write_export_file", { path, content: html });
    showToast(t("exportDone") + path, "success");
  } catch (e) { showToast(t("exportFail") + e, "danger"); }
}

/** Long image: render in an off-screen container → html2canvas → PNG. Automatically split beyond the canvas limit (a differentiator Typora itself can't do) */
async function exportImagePng(pathOverride?: string): Promise<void> {
  const frag = await exportFragment("html");
  if (!frag) return;
  const path = await pickExportPath(".png", "PNG", pathOverride);
  if (!path) return;
  const overlay = document.getElementById("export-overlay");
  const msg = document.getElementById("export-msg");
  if (overlay) { (document.getElementById("export-pct") as HTMLElement).style.width = "10%"; msg!.textContent = "Rendering…"; overlay.hidden = false; }
  try {
    const { default: html2canvas } = await import("html2canvas");
    const holder = document.createElement("div");
    holder.className = "vditor-reset";
    holder.style.cssText = "position:fixed;left:-20000px;top:0;width:820px;background:#fff;padding:24px 32px;";
    holder.innerHTML = wrapExportHtml(frag)
      .replace(/^[\s\S]*?<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, ""); // take the body content (styles are in the wrap's <style>, carried along)
    const styleEl = document.createElement("style");
    styleEl.textContent = wrapExportHtml("").match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
    holder.prepend(styleEl);
    document.body.appendChild(holder);
    const canvas = await html2canvas(holder, { scale: 2, backgroundColor: "#ffffff", logging: false, useCORS: true });
    holder.remove();
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "70%";
    // canvas max side 32767; very tall content exports split as name_pageN.png
    const MAXH = 30000;
    const slices: string[] = [];
    if (canvas.height <= MAXH) {
      slices.push(canvas.toDataURL("image/png"));
    } else {
      const n = Math.ceil(canvas.height / MAXH);
      for (let i = 0; i < n; i++) {
        const c = document.createElement("canvas");
        c.width = canvas.width; c.height = Math.min(MAXH, canvas.height - i * MAXH);
        c.getContext("2d")!.drawImage(canvas, 0, -i * MAXH);
        slices.push(c.toDataURL("image/png"));
      }
    }
    const base = path.replace(/\.png$/i, "");
    for (let i = 0; i < slices.length; i++) {
      const p = slices.length === 1 ? path : `${base}_page${i + 1}.png`;
      await invoke("save_binary_file", { path: p, dataB64: slices[i].split(",")[1] });
    }
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "100%";
    showToast(slices.length === 1 ? t("exportDone") + path : t("exportImageSlices") + slices.length, "success");
  } catch (e) {
    showToast(t("exportFail") + e, "danger");
  } finally {
    if (overlay) overlay.hidden = true;
  }
}

/** v0.3.9 print body: content goes through the same pipeline as export (formula/diagram rendering, file:// image resolution, A4 template styles) into
 * #print-root (hidden off-screen), only it remains when printing; then Rust ShowPrintUI opens the system print preview
 * (WebView2 silently ignores window.print() — the host is responsible for printing, measured: no window at all).
 * The template CSS is injected wrapped in @media print: zero disturbance on screen, print layout matches the PDF export (including @page A4).
 * After the preview closes the WebView fires afterprint to clean up; 120s fallback (extreme case where the print engine sends no event). */
let printingCleanupTimer = 0;
function cleanupPrintRoot(): void {
  document.getElementById("print-root")?.remove();
  if (printingCleanupTimer) { window.clearTimeout(printingCleanupTimer); printingCleanupTimer = 0; }
}

// ===== v0.3.11 version history: list + preview + restore (restore = load into the editor and mark dirty, not written to disk directly — the user confirms with Ctrl+S) =====
let histSelected = "";
function fmtHistTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function openHistory(): Promise<void> {
  const doc = activeDoc();
  const modal = document.getElementById("history-modal") as HTMLElement;
  const list = document.getElementById("hist-list") as HTMLUListElement;
  const preview = document.getElementById("hist-preview") as HTMLPreElement;
  const restoreBtn = document.getElementById("hist-restore") as HTMLButtonElement;
  if (!doc?.path) { showToast(t("histNoDoc"), "info"); return; }
  document.getElementById("hist-title")!.textContent = `${doc.name} · ` + t("histTitle");
  list.innerHTML = ""; preview.textContent = t("histPreview"); histSelected = "";
  restoreBtn.disabled = true;
  modal.hidden = false;
  let versions: { file: string; mtimeMs: number; size: number }[] = [];
  try { versions = await invoke("list_versions", { path: doc.path }); }
  catch (e) { showToast(t("histRestoreFail") + e, "danger"); modal.hidden = true; return; }
  if (versions.length === 0) {
    const li = document.createElement("li");
    li.textContent = t("histEmpty");
    li.style.cursor = "default"; li.style.color = "#999";
    list.appendChild(li);
    return;
  }
  versions.forEach((v, i) => {
    const li = document.createElement("li");
    const tm = document.createElement("span");
    tm.textContent = fmtHistTime(v.mtimeMs);
    const sz = document.createElement("span");
    sz.className = "hv-size";
    sz.textContent = (v.size / 1024).toFixed(1) + " KB";
    li.appendChild(tm); li.appendChild(sz);
    li.addEventListener("click", async () => {
      list.querySelectorAll("li").forEach((x) => x.classList.remove("sel"));
      li.classList.add("sel");
      histSelected = v.file;
      restoreBtn.disabled = false;
      try { preview.textContent = (await invoke<string>("read_version", { file: v.file })).slice(0, 2000); }
      catch { preview.textContent = "(…)"; }
    });
    if (i === 0) { // select the latest version by default (the next version is the predecessor of the current disk content)
      // the first version is not auto-selected: restoring is an explicit action, an accidental restore of an old version is costly. Only highlighted as a hint
    }
    list.appendChild(li);
  });
}
function bindHistory(): void {
  document.getElementById("btn-history")!.addEventListener("click", () => { void openHistory(); });
  // v0.3.23 export diagnostics: Rust collects logs + version + system info into a single txt (bug reports go from verbal repro to self-evident logs)
  document.getElementById("btn-diag")!.addEventListener("click", async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const sp = await saveDialog({
      defaultPath: `mdaddy-diagnostics-${stamp}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!sp) return;
    try {
      const saved = await invoke<string>("export_diagnostics", { path: sp });
      showToast(t("diagOk") + "  " + saved, "success");
    } catch (e) {
      showToast(t("diagFail") + "  " + e, "danger");
    }
  });
  document.getElementById("hist-close")!.addEventListener("click", () => {
    (document.getElementById("history-modal") as HTMLElement).hidden = true;
  });
  document.getElementById("history-modal")!.addEventListener("pointerdown", (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).hidden = true; // clicking the overlay closes it
  });
  document.getElementById("hist-restore")!.addEventListener("click", async () => {
    if (!histSelected || !vditor) return;
    const doc = activeDoc();
    try {
      const content = await invoke<string>("read_version", { file: histSelected });
      suppressInput = true;
      vditor.setValue(content, true);
      suppressInput = false;
      if (doc) { doc.content = content; doc.dirty = true; updateTitle(); scheduleOutline(); }
      (document.getElementById("history-modal") as HTMLElement).hidden = true;
      showToast(t("histRestored"), "success");
    } catch (e) { showToast(t("histRestoreFail") + e, "danger"); }
  });
}
async function printCurrentDoc(): Promise<void> {
  if (!vditor || exporting) return; // reentry lock: shared by all entries (toolbar button / Ctrl+P), prevents stacked print previews
  const frag = await exportFragment("html");
  if (!frag) return;
  cleanupPrintRoot();
  const root = document.createElement("div");
  root.id = "print-root";
  const css = wrapExportHtml("").match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  root.innerHTML = `<style>@media print{\n${css}\n}</style><div class="vditor-reset">${frag}</div>`;
  document.body.appendChild(root);
  try {
    await invoke("print_webview");
    window.addEventListener("afterprint", cleanupPrintRoot, { once: true });
    printingCleanupTimer = window.setTimeout(cleanupPrintRoot, 120000);
  } catch (e) {
    cleanupPrintRoot();
    showToast(t("exportFail") + e, "danger");
  }
}

/** Footnote definition rescue: Vditor's WYSIWYG DOM rendering of complex documents loses the footnote definition section (engine limitation;
 * with the DOM-is-source architecture getValue loses them too). Before export, missing definitions are appended to the md from the original file on disk —
 * the original is only read, never written back, so exported footnotes are complete; unsaved new documents without an original do their best. */
async function rescueFootnoteDefs(md: string, docPath: string | null | undefined): Promise<string> {
  const refs = new Set((md.match(/\[\^([^\]\s]+)\](?!:)/g) || []).map((s) => s.slice(2, -1)));
  const defs = new Set((md.match(/^\[\^([^\]\s]+)\]:/gm) || []).map((s) => s.slice(2, -2)));
  const missing = [...refs].filter((l) => !defs.has(l));
  if (!missing.length || !docPath) return md;
  try {
    const [orig] = await invoke<[string, string]>("open_file", { path: docPath });
    const defLines: string[] = [];
    for (const ln of orig.split("\n")) {
      const m = ln.match(/^\[\^([^\]\s]+)\]:/);
      if (m && missing.includes(m[1])) defLines.push(ln);
    }
    if (defLines.length) return md.replace(/\s*$/, "\n\n") + defLines.join("\n") + "\n";
  } catch { /* original file unreadable → best effort */ }
  return md;
}

/** Parse width/height + type from image bytes (PNG IHDR / JPEG SOF / GIF / BMP magic), returns null for non-images */
function imageSize(b: Uint8Array): { w: number; h: number; type: "png" | "jpg" | "gif" | "bmp" } | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (dv.getUint32(0) === 0x89504e47) return { w: dv.getUint32(16), h: dv.getUint32(20), type: "png" };
    if (dv.getUint32(0) === 0x47494638) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true), type: "gif" };
    if (dv.getUint16(0) === 0x424d && b.length > 26) return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)), type: "bmp" };
    if (dv.getUint16(0) === 0xffd8) { // JPEG: scan SOF0-15 segments (excluding DHT/DAC/JPG)
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5), type: "jpg" };
        }
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch { /* invalid header → null */ }
  return null;
}

/** v0.3.24 visual width: CJK/full-width characters count 2, others 1 — the measure for distributing table column widths by content weight */
function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return n;
}

/** v0.3.24 column width distribution: weights (visual width of each column's content) → total DXA/percentage basis.
 * Split proportionally by weight, each column at least total*7% so none is squashed, the remainder goes to the last column; the sum always equals total.
 * DOCX (DXA pixels) and exported HTML (percentages) share the same algorithm. */
function allocColWidths(weights: number[], total: number): number[] {
  const n = Math.max(1, weights.length);
  const w = Array.from({ length: n }, (_, i) => Math.max(weights[i] || 1, 1));
  const min = Math.floor(total * 0.07);
  const sum = w.reduce((a, b) => a + b, 0);
  const widths = w.map((x) => Math.max(min, Math.round(total * x / sum)));
  const wsum = widths.reduce((a, b) => a + b, 0);
  widths[n - 1] += total - wsum; // remainder absorbed (after min raises, wsum may exceed total; a negative remainder works the same)
  return widths.map((x) => Math.max(x, 1));
}

/** markdown-it token → docx element conversion (covers: headings / paragraphs / inline styles / links / nested lists (native numbering) / quotes (including nesting and inner lists) / code blocks / tables / images (truly embedded) / footnotes / dividers) */
async function exportDocx(pathOverride?: string): Promise<void> {
  const doc = activeDoc();
  if (!doc || !vditor) { showToast(t("exportNoDoc"), "info"); return; }
  const md = await rescueFootnoteDefs(mdValue(), doc.path);
  if (!md) { showToast(t("exportNoDoc"), "info"); return; }
  const path = await pickExportPath(".docx", "Word", pathOverride);
  if (!path) return;
  const overlay = document.getElementById("export-overlay");
  if (overlay) { (document.getElementById("export-pct") as HTMLElement).style.width = "20%"; (document.getElementById("export-msg") as HTMLElement).textContent = "DOCX…"; overlay.hidden = false; }
  try {
    const MarkdownIt = (await import("markdown-it")).default;
    const docx = await import("docx");
    const mdit = new MarkdownIt({ html: false, linkify: true });
    mdit.use((await import("markdown-it-footnote")).default);
    const tokens = mdit.parse(md, {});

    const { Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, TableLayoutType } = docx;
    const FONT = "Microsoft YaHei";
    const MONO = "Consolas";

    // prefetch local images in the document (relative paths resolved against the document folder) → bytes + size, for real embedding via ImageRun;
    // unreadable / not local → degrade to an [Image:] placeholder text
    const imgCache = new Map<string, { data: Uint8Array; w: number; h: number; type: "png" | "jpg" | "gif" | "bmp" }>();
    const docDir = doc.path ? doc.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : "";
    for (const tk of tokens) {
      if (tk.type !== "inline" || !tk.children) continue;
      for (const c of tk.children) {
        if (c.type !== "image") continue;
        const src = String(c.attrGet("src") || "").split("?")[0];
        // v0.3.8 (P1#3 fix): markdown-it's normalizeLink encodes non-ASCII src URLs
        // (assets/Screenshot_x.png with non-ASCII names → assets/%E6%88%AA...), on disk the name is not encoded → fs can't find it → degraded placeholder, image lost.
        // Decode back to the original name before building the path (both encoded and original forms may appear in src; keep as is if decoding fails).
        let srcDec = src;
        try { if (/%[0-9a-f]{2}/i.test(src)) srcDec = decodeURIComponent(src); } catch { srcDec = src; }
        if (!src || /^(https?:|asset:|data:)/i.test(srcDec) || imgCache.has(src)) continue;
        const abs = /^[a-zA-Z]:[\\/]/.test(srcDec) ? srcDec : (docDir ? docDir + "/" + srcDec : "");
        if (!abs) continue;
        try {
          const b64 = await invoke<string>("read_binary_file", { path: abs.replace(/\//g, "\\") });
          const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const size = imageSize(bin);
          if (size) imgCache.set(src, { data: bin, w: size.w, h: size.h, type: size.type });
        } catch { /* degrade to placeholder */ }
      }
    }

    // recursive helper: from start to the matching *_close, merge inline results into out, return the close index (function declaration hoisted, so inlineRuns can reference it ahead)
    function collectInline(toks: any[], start: number, style: any, out: any[]): number {
      const close = `${toks[start - 1].type.replace("_open", "_close")}`;
      let j = start;
      for (; j < toks.length && toks[j].type !== close; j++) { /* find close */ }
      out.push(...inlineRuns(toks.slice(start, j), style));
      return j;
    }
    // inline token recursion → TextRun/ExternalHyperlink array
    const inlineRuns = (toks: any[], base: { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean } = {}): any[] => {
      const out: any[] = [];
      for (let i = 0; i < toks.length; i++) {
        const tk = toks[i];
        if (tk.type === "text") {
          out.push(new TextRun({ text: tk.content, bold: base.bold, italics: base.italics, strike: base.strike, font: base.code ? MONO : FONT }));
        } else if (tk.type === "code_inline") {
          out.push(new TextRun({ text: tk.content, font: MONO, color: "C7254E", shading: { type: "clear", fill: "F9F2F4" } }));
        } else if (tk.type === "softbreak" || tk.type === "hardbreak") {
          out.push(new TextRun({ text: " ", font: FONT }));
        } else if (tk.type === "strong_open") i = collectInline(toks, i + 1, { ...base, bold: true }, out);
        else if (tk.type === "em_open") i = collectInline(toks, i + 1, { ...base, italics: true }, out);
        else if (tk.type === "s_open") i = collectInline(toks, i + 1, { ...base, strike: true }, out);
        else if (tk.type === "link_open") {
          const href = tk.attrGet("href") || "";
          let j = i + 1;
          for (; j < toks.length && toks[j].type !== "link_close"; j++) { /* collect */ }
          const inner = inlineRuns(toks.slice(i + 1, j), { ...base, bold: true });
          out.push(new ExternalHyperlink({ link: href, children: inner }));
          i = j;
        } else if (tk.type === "image") {
          const src = String(tk.attrGet("src") || "").split("?")[0];
          const img = imgCache.get(src);
          if (img) {
            const MAXW = 550; // usable A4 width ~15cm ≈ 550px@96dpi, larger images scale down proportionally
            const scale = img.w > MAXW ? MAXW / img.w : 1;
            out.push(new docx.ImageRun({ type: img.type, data: img.data, transformation: { width: Math.round(img.w * scale), height: Math.round(img.h * scale) } }));
          } else {
            out.push(new TextRun({ text: `[Image: ${String(tk.attrGet("src") || "")}]`, font: FONT, italics: true, color: "888888" }));
          }
        } else if (tk.type === "footnote_ref") {
          out.push(new docx.FootnoteReferenceRun(Number(tk.meta?.id ?? 0) + 1));
        }
      }
      return out;
    };

    // lists → Word native numbering (navigation / continued numbering correct; nesting = a separate reference per level,
    // fixing the old "inner list resets the outer ordered state" and approximate bullets). One reference per list,
    // ordered lists with start>1 write the start number into the level definition.
    const blocks: any[] = [];
    const { LevelFormat, AlignmentType } = docx;
    const numberingConfigs: any[] = [];
    let listSeq = 0;
    const listStack: { reference: string; level: number }[] = [];
    // footnotes (markdown-it-footnote): FootnoteReferenceRun(id+1) in the body, definitions collected at the end of the block;
    // docx requires key≥1, markdown-it's meta.id starts at 0
    const footnotesMap: Record<string, { children: any[] }> = {};

    // main loop driven by inline: paragraph content lives in the inline token (markdown-it marks paragraph_open/close of tight lists
    // as hidden, so per-token branching would miss them — look at open, not hidden, per the measured token stream)
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.type === "heading_open") {
        const lvl = parseInt(tk.tag.slice(1), 10);
        const inline = tokens[i + 1];
        blocks.push(new Paragraph({
          heading: ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as any[])[lvl - 1],
          children: inlineRuns(inline.children || []),
        }));
        i += 2;
      } else if (tk.type === "inline") {
        if (listStack.length > 0) {
          const L = listStack[listStack.length - 1];
          blocks.push(new Paragraph({
            numbering: { reference: L.reference, level: L.level },
            children: inlineRuns(tk.children || []),
            spacing: { after: 60 },
          }));
        } else {
          blocks.push(new Paragraph({ children: inlineRuns(tk.children || []), spacing: { after: 120 } }));
        }
      } else if (tk.type === "bullet_list_open" || tk.type === "ordered_list_open") {
        const ordered = tk.type === "ordered_list_open";
        const depth = listStack.length; // 0-based nesting level
        const reference = `mdl${++listSeq}`;
        const start = parseInt(String(tk.attrGet("start") || "1"), 10) || 1;
        numberingConfigs.push({
          reference,
          levels: [{
            level: depth,
            format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
            text: ordered ? "%1." : ["•", "◦", "▪", "·"][Math.min(depth, 3)],
            alignment: AlignmentType.START,
            ...(ordered && start > 1 ? { start } : {}),
            style: { paragraph: { indent: { left: 480 * (depth + 1), hanging: ordered ? 360 : 280 } } },
          }],
        });
        listStack.push({ reference, level: depth });
      } else if (tk.type === "list_item_open") {
        /* numbering is left to Word numbering */
      } else if (tk.type === "bullet_list_close" || tk.type === "ordered_list_close") {
        listStack.pop();
      } else if (tk.type === "blockquote_open") {
        // scan the whole block to the matching close (depth starts at 1 = including itself): nested quotes indent by depth;
        // lists inside quotes approximate with text markers; paragraphs likewise live in inline
        let depth = 1; let j = i + 1;
        let bqListDepth = 0; let bqOrdered = false; let bqIdx = 0;
        for (; j < tokens.length; j++) {
          const t2 = tokens[j];
          if (t2.type === "blockquote_open") depth++;
          else if (t2.type === "blockquote_close") { depth--; if (depth === 0) break; }
          else if (t2.type === "bullet_list_open" || t2.type === "ordered_list_open") { bqOrdered = t2.type === "ordered_list_open"; bqIdx = 0; bqListDepth++; }
          else if (t2.type === "bullet_list_close" || t2.type === "ordered_list_close") bqListDepth = Math.max(0, bqListDepth - 1);
          else if (t2.type === "list_item_open") bqIdx++;
          else if (t2.type === "inline") {
            const marker = bqListDepth > 0 ? (bqOrdered ? `${bqIdx}. ` : "• ") : "";
            blocks.push(new Paragraph({
              children: [new TextRun({ text: marker, font: FONT, italics: true }), ...inlineRuns(t2.children || [], { italics: true })],
              indent: { left: 480 * depth }, spacing: { after: 100 },
            }));
          }
        }
        i = j;
      } else if (tk.type === "footnote_block_open") {
        // collect footnote definitions into footnotesMap, no longer in the body
        let j = i + 1; let curId = -1; let curRuns: any[] = [];
        const flushFn = () => {
          if (curId >= 0 && curRuns.length) footnotesMap[String(curId + 1)] = { children: [new Paragraph({ children: curRuns })] };
          curRuns = [];
        };
        for (; j < tokens.length && tokens[j].type !== "footnote_block_close"; j++) {
          const t2 = tokens[j];
          if (t2.type === "footnote_open") { flushFn(); curId = Number(t2.meta?.id ?? -1); }
          else if (t2.type === "inline") curRuns.push(...inlineRuns(t2.children || []));
        }
        flushFn();
        i = j;
      } else if (tk.type === "fence" && /mermaid/i.test(tk.info || "")) {
        // v0.3.24: mermaid blocks are rendered and embedded as PNG (previously the fence code text, so the image was lost in Word —
        // nice in the editor, missing from the deliverable, exactly the gap users reported). Failure degrades to keeping the source text without blocking the export.
        const png = await renderMermaidPng(tk.content || "", blocks.length);
        if (png) {
          // v0.3.24: constrained by both width and height (usable A4 550×933px@96dpi, same basis as pickExportMermaidSvg) —
          // a diagram re-laid out vertically as TB may exceed the page height, limiting only the width would overflow the page bottom
          const scale = Math.min(550 / png.w, 933 / png.h, 1);
          blocks.push(new Paragraph({
            children: [new docx.ImageRun({ type: "png", data: png.data, transformation: { width: Math.round(png.w * scale), height: Math.round(png.h * scale) } })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
          }));
        } else {
          const lines = (tk.content || "").split("\n");
          blocks.push(new Paragraph({
            children: lines.map((ln: string, k: number) => new TextRun({ text: (k ? "\n" : "") + ln, font: MONO, size: 18, color: "333333", shading: { type: "clear", fill: "F5F5F5" } })),
            spacing: { before: 80, after: 80 },
          }));
        }
      } else if (tk.type === "fence" || tk.type === "code_block") {
        const lines = (tk.content || "").split("\n");
        blocks.push(new Paragraph({
          children: lines.map((ln: string, k: number) => new TextRun({ text: (k ? "\n" : "") + ln, font: MONO, size: 18, color: "333333", shading: { type: "clear", fill: "F5F5F5" } })),
          spacing: { before: 80, after: 80 },
        }));
      } else if (tk.type === "hr") {
        blocks.push(new Paragraph({ text: "", border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "CCCCCC" } }, spacing: { after: 120 } }));
      } else if (tk.type === "table_open") {
        // v0.3.24 wide table fix: the old cell width = 9000/(closed cells + 1) accumulated along the row — on one row
        // 9000/4500/3000/2250 decreasing, a row total of 18750 DXA ≈ 33cm >> the ~9026 usable on portrait A4,
        // pushing right columns off the page (root cause of exported "tables cut off"); and columnWidths was never written, tblGrid all fake 100s.
        // New method: pre-scan the whole table for the column count + the visual width weight of each column's longest cell, split 9000 DXA proportionally
        // (each column at least 7% so none is squashed), FIXED layout + columnWidths writing a real tblGrid, long text wraps inside cells.
        let j = i + 1;
        const rowCells: { inline: any[]; isHead: boolean }[][] = [];
        const colWeight: number[] = [];
        let curRow: { inline: any[]; isHead: boolean }[] = []; let curInline: any[] = [];
        let nCols = 0;
        for (; j < tokens.length && tokens[j].type !== "table_close"; j++) {
          const tt = tokens[j];
          if (tt.type === "tr_open") { curRow = []; }
          else if (tt.type === "th_open" || tt.type === "td_open") { curInline = []; }
          else if (tt.type === "inline") curInline = tt.children || [];
          else if (tt.type === "th_close" || tt.type === "td_close") {
            const isHead = tt.type === "th_close";
            curRow.push({ inline: curInline, isHead });
            const wgt = curInline.reduce((s, c) => s + visualLen(String(c.content || "")), 0);
            const ci = curRow.length - 1;
            colWeight[ci] = Math.max(colWeight[ci] || 0, wgt, 1);
          } else if (tt.type === "tr_close") { rowCells.push(curRow); nCols = Math.max(nCols, curRow.length); }
        }
        const widths = allocColWidths(colWeight.slice(0, nCols), 9000);
        const rows = rowCells.map((r) => r.map((cell, ci) => new TableCell({
          width: { size: widths[Math.min(ci, nCols - 1)], type: WidthType.DXA },
          shading: cell.isHead ? { type: "clear", fill: "EEEEEE" } : undefined,
          children: [new Paragraph({ children: inlineRuns(cell.inline, { bold: cell.isHead }) })],
        }))).map((cells, ri) => new TableRow({ children: cells, ...(ri === 0 ? { tableHeader: true } : {}) }));
        // ^ v0.3.24: first row tableHeader — tables continued across pages repeat the header automatically (on the PDF side Chrome repeats thead at page breaks,
        // Word needs an explicit declaration; the final visual check found that without it Word's continued tables had bare rows without column names)
        blocks.push(new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows }));
        blocks.push(new Paragraph({ text: "" }));
        i = j;
      } else if (tk.type === "inline") {
        // top-level image paragraphs (paragraph already covers them; this is a fallback for top-level inline)
      }
    }
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "80%";
    const d = new docx.Document({
      ...(Object.keys(footnotesMap).length ? { footnotes: footnotesMap } : {}),
      ...(numberingConfigs.length ? { numbering: { config: numberingConfigs } } : {}),
      sections: [{ children: blocks }],
    });
    const blob = await docx.Packer.toBlob(d);
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve((fr.result as string).split(",")[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    await invoke("save_binary_file", { path, dataB64: b64 });
    if (overlay) (document.getElementById("export-pct") as HTMLElement).style.width = "100%";
    showToast(t("exportDone") + path, "success");
  } catch (e) {
    showToast(t("exportFail") + e, "danger");
  } finally {
    if (overlay) overlay.hidden = true;
  }
}

// v0.4.0 File/View menus: Word/Typora-style arrangement (low-frequency items in menus, high-frequency ones directly visible).
// Forwarding principle — menu item click → existing button click / existing function, this function has zero business logic.
function bindFileViewMenus(): void {
  // The app shell was simplified to remove the File/View header menus. This binder is
  // retained for builds that still include those controls, but must not abort boot
  // when the menu markup is intentionally absent: the later sidebar, search, reader,
  // text-color, logo, and shortcut-screen handlers are initialized after this call.
  const fileButton = document.getElementById("btn-file-menu");
  const viewButton = document.getElementById("btn-view-menu");
  const fileMenu = document.getElementById("file-menu");
  const viewMenu = document.getElementById("view-menu");
  if (!fileButton || !viewButton || !fileMenu || !viewMenu) return;
  const closeBoth = () => {
    fileMenu.hidden = true;
    viewMenu.hidden = true;
  };
  // two menu headers: mutually exclusive toggles
  for (const [btnId, menuId, wrapId] of [
    ["btn-file-menu", "file-menu", "file-wrap"],
    ["btn-view-menu", "view-menu", "view-wrap"],
  ] as const) {
    document.getElementById(btnId)!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeBoth();
      const m = document.getElementById(menuId)!;
      m.hidden = false;
      void wrapId; // kept for structural symmetry (positioning is done by CSS)
    });
  }
  // click outside to close
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    if (!t?.closest?.("#file-wrap, #view-wrap")) closeBoth();
  });
  // close on selection (bubbles to the container which closes it, the forwarding handler runs first)
  for (const mid of ["file-menu", "view-menu"]) {
    document.getElementById(mid)?.addEventListener("click", () => {
      document.getElementById(mid)!.hidden = true;
    });
  }
  // —— File menu: everything forwards to existing buttons ——
  const fwd = (id: string, targetId: string) => {
    document.getElementById(id)?.addEventListener("click", () => {
      (document.getElementById(targetId) as HTMLButtonElement | null)?.click();
    });
  };
  fwd("fm-open", "btn-open"); fwd("fm-save", "btn-save"); fwd("fm-history", "btn-history");
  // v0.4.11 Save As: no existing button anchor, called directly (same zero-duplication principle as vm-reading — the logic lives only in saveDocAs)
  document.getElementById("fm-save-as")?.addEventListener("click", () => {
    const d = activeDoc();
    if (d) void saveDocAs(d);
  });
  fwd("fm-print", "btn-print"); fwd("fm-diag", "btn-diag");
  const fwdSel = (id: string, sel: string) => {
    document.getElementById(id)?.addEventListener("click", () => {
      (document.querySelector(sel) as HTMLButtonElement | null)?.click();
    });
  };
  fwdSel("fm-export-pdf", '#export-menu button[data-export="pdf"]');
  fwdSel("fm-export-html", '#export-menu button[data-export="html"]');
  fwdSel("fm-export-html-plain", '#export-menu button[data-export="html-plain"]');
  fwdSel("fm-export-image", '#export-menu button[data-export="image"]');
  fwdSel("fm-export-docx", '#export-menu button[data-export="docx"]');
  // —— View menu: forward to buttons + call toggle functions directly ——
  fwd("vm-mode", "btn-mode");
  document.getElementById("vm-reading")?.addEventListener("click", () => setReadingFocus(!readingFocusOn));
  document.getElementById("vm-side")?.addEventListener("click", () => setSideCollapsed(!sideCollapsed));
  document.getElementById("vm-cmdk")?.addEventListener("click", () => toggleCmdk());
  document.getElementById("vm-qopen")?.addEventListener("click", () => openQuickOpen());
}

function bindExportMenu(): void {
  const btn = document.getElementById("btn-export")!;
  const menu = document.getElementById("export-menu")!;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest("button[data-export]") as HTMLButtonElement | null;
    if (!item || item.disabled) return;
    menu.hidden = true;
    // v0.3.8 (P2 fix): confirm before exporting an empty document — the old behaviour silently produced a blank PDF, users might send an empty file by mistake.
    // The welcome document / a cleared unsaved state are both empty; only continue after confirmation (the e2e dialog handler accept covers it too).
    // review M2 (v0.4.11b): confirm is an async tauri plugin function; without await, !Promise is always false = the guard
    // had been dead code since v0.3.8, fixed here by adding await.
    const curVal = vditor?.getValue()?.trim();
    if (!curVal && !(await confirm(t("exportEmptyConfirm")))) return;
    const kind = item.dataset.export;
    if (kind === "pdf") exportPdf();
    else if (kind === "html") exportHtml(true);
    else if (kind === "html-plain") exportHtml(false);
    else if (kind === "image") exportImagePng();
    else if (kind === "docx") exportDocx();
  });
  // v0.3.21 print became its own toolbar button (user feedback: it felt odd in the "Export" menu — export = make a file, print = send to a printer)
  document.getElementById("btn-print")!.addEventListener("click", async () => {
    // same guard as the export menu items: confirm an empty document first (prevents printing blank paper), the reentry lock is exporting inside printCurrentDoc
    // review M2 (v0.4.11b): confirm is async, without await = dead guard, fixed here
    const curVal = vditor?.getValue()?.trim();
    if (!curVal && !(await confirm(t("exportEmptyConfirm")))) return;
    printCurrentDoc();
  });
  // click outside to close (capture, same pattern as the find bar; excluding the export button itself); Esc closes too (consistent overlay interaction)
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden) return;
    if (e.target instanceof Node && (menu.contains(e.target) || btn.contains(e.target))) return;
    menu.hidden = true;
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { e.preventDefault(); menu.hidden = true; }
  });
}

// Export the current document as PDF: take Vditor's rendered HTML → resolve relative images → wrap into a full document → hand to the Rust side
// msedge --headless --print-to-pdf produces a vector PDF (text selectable and searchable, native Chromium pagination, no canvas limit).
// Replaces the old html2pdf.js (an off-screen container at left:-99999px made html2canvas render blank = white paper, and the ~32767px canvas limit cut long text).
async function exportPdf(pathOverride?: string) {
  if (!vditor || exporting) return;   // reentry lock: Ctrl+P / repeated clicks during an export (msedge print 1-3s) are ignored
  const doc = activeDoc();
  if (!doc) { showToast(t("exportNoDoc"), "info"); return; }
  // first write the editor's live content back to doc (same as saving, getValue empty-read guard: empty values don't overwrite)
  const v = mdValue();
  if (v !== "" || doc.content === "") doc.content = v;

  // get the rendered HTML fragment (getHTML may throw in some abnormal states, try/catch as a fallback); since v0.3.8 includes math/mermaid rendering
  const fragHtml = await exportFragment("html");
  if (!fragHtml) return;
  const fullHtml = wrapExportHtml(fragHtml);

  // choose the save path (default file name = document name.pdf). The reentry lock covers saveDialog → export completion: between saveDialog
  // closing and the lock being set there is a tiny window where rapid export clicks could re-enter, so lock early to close it. exporting is
  // always released in finally (cancel/success/error all pass through finally), no lock leaks. The overlay/unlisten/est referenced in finally
  // must be declared before try — the cancel branch returns before assignment (then unlisten=null,
  // overlay=hidden, est=null), so all are handled null-safely.

  // progress overlay: Rust pushes real percentages at observable steps (page/printing/saving); engine printing is a black box,
  // where the frontend estimate curve smoothly approaches 90% (never above 90), jumping to 100% only when invoke really resolves — honest, never faking completion.
  const overlay = document.getElementById("export-overlay");
  const exportMsg = document.getElementById("export-msg");
  const bar = document.getElementById("export-progress-bar");
  const pctEl = document.getElementById("export-pct");
  const setPct = (p: number) => {
    if (bar) (bar as HTMLElement).style.width = p + "%";
    if (pctEl) pctEl.textContent = Math.round(p) + "%";
  };

  // estimate curve: only in the printing black-box phase, every 120ms cur += (90-cur)*0.12, exponential decay towards 90.
  let est: number | null = null;
  let cur = 0;
  const stopEst = () => { if (est !== null) { clearInterval(est); est = null; } };
  const startEst = (from: number) => {
    stopEst();
    cur = from;
    est = window.setInterval(() => { cur += (90 - cur) * 0.12; setPct(cur); }, 120);
  };

  let unlisten: (() => void) | null = null;
  let done = false; // completion flag: set true after invoke resolves, so a late saving event can't push 100% back to 95%
  let resultMsg = "";
  let resultOk = true;
  try {
    exporting = true;
    // always via pickExportPath: production opens the native save dialog; e2e (--export-selftest) builds the path directly.
    // The old implementation called saveDialog directly — in headless e2e nobody clicks the dialog, await never returns, so the PDF item could never be tested.
    const savePath = await pickExportPath(".pdf", "PDF", pathOverride);
    if (!savePath) { return; } // user cancelled: exporting released by finally (overlay still hidden, unlisten still null)

    if (overlay) overlay.hidden = false;
    setPct(5);
    if (exportMsg) exportMsg.textContent = t("exportStagePage");

    unlisten = await listen<[string, number]>("export-pdf-progress", (e) => {
      if (done) return; // already done: ignore late saving events, avoiding 100 → 95 going backwards
      const [stage, pct] = e.payload;
      stopEst();
      setPct(pct);
      if (stage === "printing") {
        if (exportMsg) exportMsg.textContent = t("exportStagePrint");
        startEst(pct);                     // black-box phase: estimate towards 90, real completion is taken over by resolve
      } else if (stage === "page") {
        if (exportMsg) exportMsg.textContent = t("exportStagePage");
      } else if (stage === "saving") {
        if (exportMsg) exportMsg.textContent = t("exportStageSave");
      }
    });
    await invoke("export_pdf", { html: fullHtml, path: savePath });
    done = true;
    // v0.5.2: removed v0.3.0's "linked source" companion .md copy — exporting a PDF should only produce the PDF (user feedback);
    // find_pdf_source still works when opening a PDF if a real same-name .md exists on disk
    stopEst();
    setPct(100);
    if (exportMsg) exportMsg.textContent = "Exported.";
    await new Promise<void>(r => setTimeout(r, 350)); // let 100% linger briefly before wrapping up, so the progress bar doesn't just flash
    const doneLabel = "Exported: ";
    resultMsg = "✅ " + doneLabel + savePath;
  } catch (e) {
    resultOk = false;
    resultMsg = t("exportFail") + e;
  } finally {
    stopEst();
    if (unlisten) unlisten();              // remove the event listener to avoid leaks (runs on success/error/cancel)
    exporting = false;                     // release the reentry lock (single release point, no lock leaks)
    if (overlay) overlay.hidden = true;    // close the overlay before showing the result, so the progress bar and result box don't coexist
  }
  showToast(resultMsg, resultOk ? "success" : "danger");
}

async function boot() {
  applyAppAssets();
  // v0.5.0 load portable preferences: must happen before any prefGet. Not a module top-level await — during module evaluation the IPC
  // channel isn't ready, invoke stays pending forever and hangs the whole module (including this boot) (lesson learned);
  // during boot IPC is ready (the next line's get_startup_file is also an invoke, the existing convention).
  await initPrefs();
  await initInstancePrompts();
  { // at module top level detectLang ran before portable values were loaded (fell back to navigator); correct with the portable value here — the UI isn't built yet, direct assignment is safe
    const pl = prefGet("md-editor-lang");
    if (pl === "en") currentLang = pl;
  }
  try {
    const sf = await invoke<string | null>("get_startup_file");
    if (sf) pendingFile = sf;
  } catch {
    // ignored outside tauri
  }
  // v0.3.26 session restore prerequisite: ui-state must be ready before initVditor (the after first-init branch uses
  // session data to decide "restore session or welcome page", and an async then would lose the race against Vditor construction). Rust reads a small
  // JSON in <5ms, no perceptible startup cost. uiStateLoaded is set true synchronously, so the old then timing issue (memRecent merge) is gone.
  try {
    uiStateAll = (await invoke<Record<string, unknown> | null>("load_ui_state")) || {};
  } catch {
    uiStateAll = {};
  }
  uiStateLoaded = true;
  // v0.4.9 restore the reading scroll speed (the user's last speed takes priority over the default 6.0)
  if (typeof uiStateAll.rsSpeed === "number") {
    rsSpeed = Math.min(100, Math.max(0.5, uiStateAll.rsSpeed as number));
  }

  // preview/raw switch: the top mode button and Ctrl+Alt+M use the same command
  document.getElementById("btn-mode")!.addEventListener("click", () => {
    toggleSourceMode();
  });
  // undo/redo shortcut takeover: with undo/redo buttons configured in Vditor's toolbar, its internal keydown
  // skips Ctrl+Z when `!toolbar.elements.undo` (always false) (vditor index.js:8915), leaving it to the browser's native
  // contenteditable undo — and native undo often fails on Vditor's complex rendered DOM ("Ctrl+Z sometimes does nothing").
  // Here the capture phase calls Vditor's undo stack directly with preventDefault, without conflicting with the toolbar buttons or Ctrl+Alt+M.
  window.addEventListener("keydown", (e) => {
    if (!vditor) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return; // Ctrl/Meta only, avoiding Ctrl+Alt+M
    // focus must be inside the editor, so native undo in dialogs/inputs isn't hijacked
    const editorEl = document.querySelector("#editor .vditor-wysiwyg, #editor .vditor-ir, #editor .vditor-sv");
    const ae = document.activeElement;
    if (!editorEl || !ae || !editorEl.contains(ae)) return;
    const k = e.key.toLowerCase();
    // stopImmediatePropagation: stop the event reaching Vditor's own Ctrl+Z handler on the editor pre element
    // (vditor simulates clicking the undo button and undoes again), otherwise stacking with doUndo makes one keypress undo two steps.
    if (k === "z" && e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); doRedo(); }       // Ctrl+Shift+Z = redo
    else if (k === "z") { e.preventDefault(); e.stopImmediatePropagation(); doUndo(); }                // Ctrl+Z = undo
    else if (k === "y") { e.preventDefault(); e.stopImmediatePropagation(); doRedo(); }                // Ctrl+Y = redo
  }, true);
  // block the browser's native contenteditable undo/redo: the keydown listener above already takes over via doUndo
  // (using Vditor's undo stack). But keydown's preventDefault can't stop Chromium's native undo — it runs through the
  // beforeinput(inputType=historyUndo) channel and goes out of sync with Vditor's stack, showing up as one Ctrl+Z
  // undoing two steps. Intercepting historyUndo/historyRedo in the capture phase with preventDefault ensures only Vditor's stack responds.
  document.addEventListener("beforeinput", (e: Event) => {
    const it = (e as InputEvent).inputType;
    if (it === "historyUndo" || it === "historyRedo") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  updateModeUI();
  applyAllText(); // initialise static text
  const langSel = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (langSel) {
    langSel.value = currentLang; // synced with the dropdown default after the portable value correction (installed version: already identical, unnoticeable)
    langSel.addEventListener("change", () => setLang(langSel.value as Lang));
  }
  // editor font size (selection-based): select text in the editor first, then pick a size in the dropdown → the selected text is wrapped in an inline <span style="font-size:Npx">.
  // clicking the dropdown steals contenteditable focus and collapses the selection: snapshot the selection on mousedown (capture), apply the snapshot on change.
  const fssInit = document.getElementById("font-size-select") as HTMLInputElement | null;
  if (fssInit) {
    fssInit.value = String(loadFontSize()); // only restores the "last used" font size value, never applied to the whole document
    fssInit.title = t("fontSizeTip");
    // mousedown(capture) + preventDefault: stop the input's default focus stealing from collapsing the editor selection, snapshot the selection (savedRange) first;
    // but the async focus(input) still blurs contenteditable — in Chromium the blurred selection highlight is transparent by default (unlike a textarea, which turns grey),
    // so before focus paintFontSelHl() covers savedRange's rects with a translucent blue layer, keeping the selection visible throughout (requirement 3). Programmatic focus doesn't collapse the selection, the Range is kept as an apply fallback.
    fssInit.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      fontInputInteracting = true;        // freeze caret font-size sync so it doesn't overwrite the value the user is about to type
      captureFontSizeSelection();         // snapshot the selection before focus is stolen (fallback against selection changes)
      paintFontSelHl();                   // focusing the input will blur contenteditable (highlight transparent) → draw the custom highlight layer first so the selection stays visible
      setTimeout(() => fssInit.focus({ preventScroll: true }), 0);
    }, true);
    fssInit.addEventListener("blur", () => { fontInputInteracting = false; clearFontSelHl(); });
    fssInit.addEventListener("change", () => {
      // change commit semantics (not input): avoids splitting "12" into px=1 then px=12 per character
      let px = parseInt(fssInit.value, 10);
      if (isNaN(px)) {
        // empty/invalid input: write back the last used size, giving the user clear feedback instead of silently doing nothing
        fssInit.value = String(loadFontSize());
        return;
      }
      if (px < 8) px = 8;   // clamp to the valid range and write back, out-of-range input is corrected on display
      if (px > 72) px = 72;
      fssInit.value = String(px);
      applyFontSizeToSelection(px);
      clearFontSelHl();                   // after apply the real selection is reselected and highlighted again (rich text) → remove the custom layer
      try { prefSet(FONT_SIZE_KEY, String(px)); } catch { /* storage disabled, only this session */ }
    });
    // when the caret is on some text, sync the toolbar font size display to that text's actual rendered size (display only, never triggers apply).
    // rich-text mode only (contenteditable): the source-mode textarea is raw text with no inline font size concept, skipped.
    document.addEventListener("selectionchange", () => {
      if (fontInputInteracting) return;                  // the user is working the font box: don't write back, avoid overwriting their input
      if (activeSourceTextarea()) return;                // no sync in source mode
      const editable = activeEditableArea();
      if (!editable) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || !editable.contains(node)) return;     // selection not in the editor: leave it
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
      if (!el) return;
      const px = parseInt(getComputedStyle(el).fontSize, 10);
      if (px >= 8 && px <= 72) fssInit.value = String(px); // only update the display, never trigger applyFontSizeToSelection
    });
    // the highlight layer is fixed to the viewport: editor scrolling / window resizing shift savedRange's rects → redraw to stay aligned (only during interaction, cost is controlled)
    const repaintHl = () => { if (fontInputInteracting) paintFontSelHl(); };
    document.addEventListener("scroll", repaintHl, true); // capture: scroll doesn't bubble, the capture phase catches vditor's internal scroll container
    window.addEventListener("resize", repaintHl);
  }
  bindTablePopoverVisibility(); // WYSIWYG table panel display (covers Vditor not triggering it automatically after a rebuild)
  bindTableInputConfirm(); // table row/column number boxes: add/remove only on confirm (Enter/blur), avoiding per-character data deletion

  initVditor();

  // single instance: double-clicking a .md while running → new tab
  await listen<string>("open-file", (e) => loadFile(e.payload));

  // confirm before closing the window: with unsaved changes the user chooses save and close / close without saving / cancel
  try {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      saveSession(); // v0.3.26 session: write the session first whichever close path is taken (the debounce timer may not get another tick)
      if (!docs.some((d) => d.dirty)) return; // no unsaved changes, close normally
      e.preventDefault();
      const action = await showCloseConfirm();
      if (action === "cancel") return; // cancel: don't close
      if (action === "save") await saveAllDirty(); // save and close: save documents that have a path first
      saveSession(); // saveAllDirty changed content/structure: write once more
      try {
        await win.destroy();
      } catch (e) {
        showToast(t("closeFail") + e, "danger");
      }
    });
  } catch {
    // ignored outside tauri
  }
  // drag-to-open: on Windows/WebView2 wry's native drag-drop has a timing race (registered before the WebView2 child window's drop target
  // is ready → interception fails → no tauri://drag-drop event, measured: nothing happens at all).
  // Use HTML5 drag-drop instead: with dragDropEnabled:false WebView2's native HTML5 drop fires reliably.
  // Cost: HTML5 can't get the original path (browser security) → PDFs go through IPC as bytes into a temp file handed to PDF4QT;
  // md/txt are read as text straight into the editor. When the original path / source linkage is needed, use the Open button (already available).
  try {
    const DRAG_PDF_MAX = 5 * 1024 * 1024; // bytes over IPC, limited to 5MB; for larger files use the Open button
    window.addEventListener("dragover", (e) => {
      e.preventDefault(); // without this drop never fires
    });
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (/\.pdf$/i.test(f.name)) {
        if (f.size > DRAG_PDF_MAX) {
          showToast("PDF > 5MB, please use the Open button.", "danger");
          return;
        }
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          await invoke("open_dropped_pdf", { content: Array.from(buf), name: f.name });
        } catch (err) {
          showToast("Open failed: " + err, "danger");
        }
      } else if (/\.(md|markdown|mdown|txt)$/i.test(f.name)) {
        const text = await f.text();
        openDoc(null, text, f.name, "UTF-8");
      }
    });
    // self-test: with --dnd-selftest at startup, synthesize one drop to verify the HTML5 drag-drop → IPC → temp file chain (kept in, never fires on a normal launch)
    if (await invoke<boolean>("dnd_selftest_enabled").catch(() => false)) {
      const blob = new Blob(["%PDF-1.4\n%selftest\n"], { type: "application/pdf" });
      const file = new File([blob], "__dnd_selftest__.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  } catch {
    // ignored outside tauri
  }

  document.getElementById("btn-open")!.addEventListener("click", async () => {
    const p = await openDialog({
      multiple: false,
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] },
        { name: "PDF", extensions: ["pdf"] },
      ],
    });
    if (!p) return;
    const ps = p as string;
    if (/\.pdf$/i.test(ps)) handleOpenPdf(ps);
    else loadFile(ps);
  });

  document.getElementById("btn-save")!.addEventListener("click", async () => {
    if (!vditor) return;
    const doc = activeDoc();
    if (!doc) return;
    const v = mdValue();
    if (v !== "" || doc.content === "") doc.content = v; // guard: empty values don't overwrite
    let path = doc.path;
    if (!path) {
      const sp = await saveDialog({ filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (!sp) return;
      path = sp as string;
      doc.path = path;
      doc.name = path.split(/[\\/]/).pop()!;
    }
    try {
      const sm = await invoke<{ mtimeMs: number; size: number }>("save_file", { path, content: doc.content });
      doc.dirty = false;
      doc.encoding = "UTF-8"; // always written as UTF-8 without BOM, refresh the marker so it doesn't contradict the original encoding
      doc.metaMtime = sm.mtimeMs; doc.metaSize = sm.size; // v0.5.2 external change baseline (same as saveDoc)
      updateTitle();
      renderTabs();
    } catch (e) {
      showToast(t("saveFail") + e, "danger");
    }
  });

  // export centre dropdown (PDF/HTML/image/Word/print). Ctrl+P = print, intercepted in the capture phase above
  bindExportMenu();

  // v0.4.0 File/View menus (toolbar consolidation): menu items always forward to existing button clicks —
  // the old buttons were retired as hidden #legacy-btns anchors (bindings untouched), same zero-duplication principle as the command palette
  bindFileViewMenus();

  // Ctrl+S save (standard in editors; previously only the save button + 30s autosave, a gap found in real user testing)
  // Ctrl+Shift+S Save As (v0.4.11, same as Word/Typora)
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      const doc = activeDoc();
      if (!doc) return;
      if (e.shiftKey) void saveDocAs(doc);
      else void saveDoc(doc);
    }
  });

  startAutosave();
  bindPasteCaretFollow();
  bindFindBar();
  bindHistory(); // v0.3.11 version history (toolbar 🕘 button)
  initOutlineResize(); // v0.3.12 outline sidebar resizing (Word-style edge drag + persistence)
  // version number: prefer the real Tauri runtime version (matches the build output), fall back to the hard-coded index.html value on failure
  try {
    const v = await getVersion();
    if (v) document.getElementById("app-version")!.textContent = "v" + v;
  } catch { /* dev browser mode has no Tauri, keep the fallback value */ }
  // restore the focus state from the last session (typewriter mode was removed at the user's request, leftover key cleaned up)
  try {
    prefRemove("md-editor-typewriter");
  } catch { /* storage disabled */ }
  // v0.3.14 sidebar Files tab (file tree / recent / cross-file search) + quick open + themes; v0.3.15 tab context menu
  initSidePanels();
  initTabMenu();
  initFtreeMenu();
  initNoticeBars(); // v0.3.26 external change / large-document info bar buttons
  initReadingTrace(); // v0.4.0 reading trace: scrollspy + top progress line
  initCodeBlocks(); // code block language / collapse / copy controls
  initHeadingControls();
  initImageActions();
  initTextColors();
  initCmdk(); // v0.4.0 command palette (Ctrl+K)
  switchSidePane("outline"); // v0.3.21 show the Outline tab by default (user decision 2026-08-30; the Files tab is one click away)
  // Word-style zoom: Ctrl+wheel / Ctrl+plus/minus / Ctrl+0 reset / bottom-right slider — only scales the text content area
  // (.vditor-content); the format toolbar (.vditor-toolbar) / app toolbar / outline / tabs are not scaled.
  // Implementation = CSS variable --doc-zoom on the mount point (Vditor mode/language subtree rebuilds don't lose it); zoom takes part in layout,
  // rect / selection / find highlight coordinates stay consistent, document content unchanged. Range 0.5–2.0 in 10% steps.
  // Persisted = Rust-side ui-state.json (%APPDATA%): localStorage flushes to disk asynchronously and is lost on a forced kill.
  let zoomLevel = 1.0;
  const persistZoom = () => { saveUiStateKey("zoom", zoomLevel); };
  const applyZoom = () => {
    document.getElementById("editor")?.style.setProperty("--doc-zoom", String(zoomLevel));
    const zb = document.getElementById("zoom-badge");
    if (zb) zb.textContent = Math.round(zoomLevel * 100) + "%";
    const sz = document.getElementById("sb-zoom");
    if (sz) sz.textContent = Math.round(zoomLevel * 100) + "%";
    const zs = document.getElementById("zoom-slider") as HTMLInputElement | null;
    if (zs) zs.value = String(Math.round(zoomLevel * 100));
    persistZoom();
  };
  // v0.4.0 status-bar zoom badge: click to reset to 100% (same path as Ctrl+0)
  document.getElementById("sb-zoom")?.addEventListener("click", () => {
    zoomLevel = 1.0; applyZoom(); revealZoomBar();
  });
  // v0.3.26: ui-state is already ready from the synchronous await at the start of boot, used directly here (the memRecent merge needed by the old then timing
  // is gone — loading completes before any pushRecent)
  await scanUserThemes(); // v0.4.0 custom themes: scan first (initTheme validation / dynamic menu items depend on the result)
  initTheme();
  if (uiStateAll.sideCollapsed === true) setSideCollapsed(true, false); // v0.4.0 restore the sidebar collapsed state (not written back)
  renderRecent();
  renderFindHistory(); // v0.3.26 find history datalist
  const diskZoom = typeof uiStateAll.zoom === "number" ? (uiStateAll.zoom as number) : NaN;
  if (diskZoom >= 0.5 && diskZoom <= 2.0) zoomLevel = diskZoom;
  // v0.3.26 status bar: selection changes update "N selected" (attached separately from the font-size selectionchange, different responsibilities)
  document.addEventListener("selectionchange", trackSelectionStatus);
  // v0.3.26 external change detection: check the current document when the window regains focus (the most common moment to notice external changes)
  window.addEventListener("focus", () => {
    const d = activeDoc();
    if (d) void checkExternalMod(d);
  });
  // v0.3.26 session fallback: exit paths that skip onCloseRequested, such as crashes / forced kills
  window.addEventListener("beforeunload", saveSession);
  // v0.3.27 the zoom slider is hidden by default: it only appears for 3s on zoom actions (wheel / plus/minus / 0 / slider / buttons),
  // and doesn't disappear while hovered/dragged (dragging fires input continuously, resetting the timer); normally it takes no space in the bottom-right.
  let zoomHideTimer = 0;
  const revealZoomBar = () => {
    const bar = document.getElementById("zoom-bar");
    if (!bar) return;
    bar.classList.add("zoom-show");
    window.clearTimeout(zoomHideTimer);
    zoomHideTimer = window.setTimeout(() => bar.classList.remove("zoom-show"), 3000);
  };
  const zoomBy = (d: number) => {
    zoomLevel = Math.min(2.0, Math.max(0.5, Math.round((zoomLevel + d) * 100) / 100));
    applyZoom();
    revealZoomBar();
  };
  document.getElementById("zoom-slider")?.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    if (v >= 0.5 && v <= 2.0) { zoomLevel = v; applyZoom(); revealZoomBar(); }
  });
  document.getElementById("zoom-out")?.addEventListener("click", () => zoomBy(-0.1));
  document.getElementById("zoom-in")?.addEventListener("click", () => zoomBy(0.1));
  let lastWheelZoom = 0;
  window.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelZoom < 90) return; // continuous touchpad pinch deltas merge into 10% steps
    lastWheelZoom = now;
    zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
  zoomApi = { zoomIn: () => zoomBy(0.1), zoomOut: () => zoomBy(-0.1), reset: () => { zoomLevel = 1.0; applyZoom(); revealZoomBar(); } };
  // no auto-hide while hovering the slider (fades 3s after dragging stops)
  const zbEl = document.getElementById("zoom-bar");
  zbEl?.addEventListener("mouseenter", () => window.clearTimeout(zoomHideTimer));
  zbEl?.addEventListener("mouseleave", revealZoomBar);
  applyZoom();
  initMdaddyFeatures();
  // Settings initializes its preference context in initMdaddyFeatures; apply the saved margin only after that context exists.
  document.documentElement.style.setProperty("--page-side-margin", `${pageMargin()}px`);
}

window.addEventListener("DOMContentLoaded", boot);

// ===== Mdaddy features: command registry, settings, welcome, AI assistant, send menu, full screen / reader mode =====
let zoomApi = { zoomIn: () => {}, zoomOut: () => {}, reset: () => {} };
let lastEditorSelection = "";

async function toggleOsFullscreen(force?: boolean): Promise<void> {
  const w = getCurrentWindow();
  const on = force ?? !(await w.isFullscreen());
  await w.setFullscreen(on);
  document.body.classList.toggle("os-fullscreen", on);
}

/** Reader mode = Vditor's full-window editor (toolbar and app chrome hidden). */
function toggleReaderMode(): void {
  clickTool("fullscreen");
  window.setTimeout(updateReaderModeIcon, 50);
}

function styleToolbarGlyphs(): void {
  const glyphs: Record<string, string> = {
    headings: '<span class="mdaddy-toolbar-glyph mdaddy-glyph-heading" aria-hidden="true">H</span>',
    bold: '<span class="mdaddy-toolbar-glyph mdaddy-glyph-bold" aria-hidden="true">B</span>',
    italic: '<span class="mdaddy-toolbar-glyph mdaddy-glyph-italic" aria-hidden="true">i</span>',
    quote: '<svg class="mdaddy-quote-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h6v6H7.7c.2 2.4 1.3 4 3.3 4.9v3.1C6.8 17.5 5 14.4 5 10.1V5Zm8 0h6v6h-3.3c.2 2.4 1.3 4 3.3 4.9v3.1c-4.2-1.5-6-4.6-6-8.9V5Z"/></svg>',
    check: '<svg class="mdaddy-check-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1.2" fill="#15191b"/><path d="m6.8 12.2 3.5 3.4 7-7.2" fill="none" stroke="#1fa491" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  for (const [type, html] of Object.entries(glyphs)) {
    const button = document.querySelector<HTMLElement>(`#toolbar .vditor-toolbar [data-type="${type}"]`);
    if (!button || button.querySelector(".mdaddy-toolbar-glyph, .mdaddy-quote-glyph, .mdaddy-check-glyph")) continue;
    button.innerHTML = html;
  }
}

function updateReaderModeIcon(): void {
  const full = !!document.querySelector("#editor .vditor--fullscreen");
  const img = document.querySelector<HTMLImageElement>("#btn-reader-toggle img");
  const button = document.getElementById("btn-reader-toggle");
  if (img) img.src = full ? APP_ASSETS.editMode : APP_ASSETS.readerMode;
  if (button) {
    button.title = full ? "Return to editing" : "Reader mode";
    button.setAttribute("aria-label", button.title);
  }
}

function clickTool(type: string): void {
  const b = document.querySelector<HTMLElement>(`#toolbar .vditor-toolbar [data-type="${type}"]`);
  if (!b || b.classList.contains("vditor-menu--disabled")) return;
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setHeading(level: number): void {
  clickTool("headings");
  const item = document.querySelector<HTMLElement>(`#toolbar .vditor-toolbar [data-tag="h${level}"]`);
  item?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  document.querySelectorAll<HTMLElement>("#toolbar .vditor-toolbar .vditor-hint, #toolbar .vditor-toolbar .vditor-panel--arrow")
    .forEach((p) => { p.style.display = "none"; });
}

function cycleTheme(): void {
  const order = ["light", "dark", "eye", "paper"];
  const i = order.indexOf(themeName);
  applyTheme(order[(i + 1) % order.length]);
}

function cycleTab(dir: 1 | -1): void {
  if (docs.length < 2) return;
  const i = docs.findIndex((d) => d.id === activeId);
  switchDoc(docs[(i + dir + docs.length) % docs.length].id);
}

function applyToolbarSize(px: number): void {
  document.documentElement.style.setProperty("--tb-icon", `${px}px`);
}
function applySidebarWidth(px: number): void {
  const panel = document.getElementById("outline-panel");
  if (panel) panel.style.width = `${px}px`;
  if (sideCollapsed) setSideCollapsed(false);
}

/** Make sure the active document exists on disk (save it, or write a temp copy when untitled). */
async function ensureDocFile(): Promise<string | null> {
  const doc = activeDoc();
  if (!doc) { showToast(t("exportNoDoc"), "info"); return null; }
  if (doc.path) {
    if (doc.dirty && !(await saveDoc(doc))) return null;
    return doc.path;
  }
  const dir = await invoke<string>("temp_dir_path");
  const name = (doc.name || "Untitled").replace(/[\\/:*?"<>|]/g, "_").replace(/(\.md)?$/i, ".md");
  const path = `${dir}\\${name}`;
  await invoke("write_export_file", { path, content: mdValue() });
  return path;
}

function registerCommands(): void {
  const tool = (type: string) => () => clickTool(type);
  const exp = (k: string) => () => (document.querySelector(`#export-menu button[data-export="${k}"]`) as HTMLElement | null)?.click();
  const click = (id: string) => () => (document.getElementById(id) as HTMLElement | null)?.click();
  const cmd = (group: string, id: string, label: string, defaultKey: string, run: () => void, extra: Partial<Command> = {}) =>
    register({ group, id, label, defaultKey, run, ...extra });

  cmd("File", "file.new", "New document", "Ctrl+N", () => openDoc(null, "", t("untitled")));
  cmd("File", "file.open", "Open…", "Ctrl+O", click("btn-open"));
  cmd("File", "file.quickOpen", "Quick open (recent files)", "Ctrl+Shift+O", () => openQuickOpen());
  cmd("File", "file.save", "Save", "Ctrl+S", () => { const d = activeDoc(); if (d) void saveDoc(d); });
  cmd("File", "file.saveAs", "Save As…", "Ctrl+Shift+S", () => { const d = activeDoc(); if (d) void saveDocAs(d); });
  cmd("File", "file.close", "Close tab", "Ctrl+W", () => { if (activeId) void closeDoc(activeId); });
  cmd("File", "file.nextTab", "Next tab", "Ctrl+Tab", () => cycleTab(1));
  cmd("File", "file.prevTab", "Previous tab", "Ctrl+Shift+Tab", () => cycleTab(-1));
  cmd("File", "file.history", "Version history", "Ctrl+Alt+V", click("btn-history"));
  cmd("File", "file.print", "Print…", "Ctrl+P", () => void printCurrentDoc());
  cmd("File", "file.diagnostics", "Export diagnostics", "Ctrl+Alt+Shift+D", click("btn-diag"));

  cmd("Export", "export.pdf", "Export PDF", "Ctrl+Alt+P", exp("pdf"));
  cmd("Export", "export.html", "Export HTML (styled)", "Ctrl+Alt+H", exp("html"));
  cmd("Export", "export.htmlPlain", "Export HTML (plain)", "Ctrl+Alt+Shift+H", exp("html-plain"));
  cmd("Export", "export.png", "Export PNG image", "Ctrl+Alt+G", exp("image"));
  cmd("Export", "export.docx", "Export Word (.docx)", "Ctrl+Alt+W", exp("docx"));

  cmd("Edit", "edit.undo", "Undo", "Ctrl+Z", () => docUndo(), { fixed: true });
  cmd("Edit", "edit.redo", "Redo", "Ctrl+Y", () => docRedo(), { fixed: true });
  cmd("Edit", "edit.find", "Find", "Ctrl+F", () => openFind(false));
  cmd("Edit", "edit.replace", "Find & replace", "Ctrl+H", () => openFind(true));
  cmd("Edit", "edit.searchFolder", "Search this folder and subfolders", "Ctrl+Shift+F", () => {
    closeFind();
    if (sideCollapsed) setSideCollapsed(false);
    switchSidePane("files");
    (document.getElementById("gsearch-input") as HTMLInputElement).focus();
  });

  const fmt = (id: string, label: string, key: string, run: () => void) => cmd("Format", id, label, key, run, { editorOnly: true });
  fmt("fmt.headings", "Headings menu", "Alt+H", tool("headings"));
  for (let i = 1; i <= 6; i++) fmt(`fmt.h${i}`, `Heading ${i}`, `Ctrl+${i}`, () => setHeading(i));
  fmt("fmt.bold", "Bold", "Ctrl+B", tool("bold"));
  fmt("fmt.italic", "Italic", "Ctrl+I", tool("italic"));
  fmt("fmt.strike", "Strikethrough", "Ctrl+D", tool("strike"));
  fmt("fmt.line", "Horizontal line", "Ctrl+Shift+H", tool("line"));
  fmt("fmt.quote", "Quote", "Ctrl+;", tool("quote"));
  fmt("fmt.list", "Bulleted list", "Ctrl+L", tool("list"));
  fmt("fmt.orderedList", "Numbered list", "Ctrl+Shift+L", tool("ordered-list"));
  fmt("fmt.check", "Task list", "Ctrl+J", tool("check"));
  fmt("fmt.outdent", "Outdent", "Ctrl+[", tool("outdent"));
  fmt("fmt.indent", "Indent", "Ctrl+]", tool("indent"));
  fmt("fmt.code", "Code block", "Ctrl+U", tool("code"));
  fmt("fmt.inlineCode", "Inline code", "Ctrl+G", tool("inline-code"));
  fmt("fmt.link", "Link", "Ctrl+K", tool("link"));
  fmt("fmt.table", "Table", "Ctrl+T", tool("table"));

  cmd("View", "view.sidebar", "Show / hide sidebar", "Ctrl+Shift+B", () => setSideCollapsed(!sideCollapsed));
  cmd("View", "view.outline", "Sidebar: Outline", "Ctrl+Shift+1", () => { if (sideCollapsed) setSideCollapsed(false); switchSidePane("outline"); });
  cmd("View", "view.files", "Sidebar: Files", "Ctrl+Shift+2", () => { if (sideCollapsed) setSideCollapsed(false); switchSidePane("files"); });
  cmd("View", "view.fullscreen", "Full screen", "F11", () => void toggleOsFullscreen());
  cmd("View", "view.reader", "Reader mode", "F9", () => toggleReaderMode());
  cmd("View", "view.readingFocus", "Reading focus", "Ctrl+Shift+D", () => setReadingFocus(!readingFocusOn));
  cmd("View", "view.autoScroll", "Auto-scroll", "F7", () => { if (rsOn) rsStop(); else rsStart(); });
  cmd("View", "view.editMode", "Toggle WYSIWYG / Raw-by-line", "Ctrl+Alt+M", toggleSourceMode);
  cmd("View", "view.zoomIn", "Zoom in", "Ctrl+=", () => zoomApi.zoomIn());
  cmd("View", "view.zoomOut", "Zoom out", "Ctrl+-", () => zoomApi.zoomOut());
  cmd("View", "view.zoomReset", "Reset zoom", "Ctrl+0", () => zoomApi.reset());
  cmd("View", "view.themeCycle", "Next theme", "Ctrl+Alt+T", cycleTheme);
  ([["light", "Light", 1], ["dark", "Dark", 2], ["eye", "Eye care", 3], ["paper", "Warm paper", 4]] as const)
    .forEach(([nm, label, n]) => cmd("View", `view.theme.${nm}`, `Theme: ${label}`, `Ctrl+Alt+${n}`, () => applyTheme(nm)));

  const sendKeys: Record<string, string> = { obsidian: "Ctrl+Alt+O", vscode: "Ctrl+Alt+C", firefox: "Ctrl+Alt+F" };
  for (const tg of loadSendTargets()) cmd("Send", `send.${tg.id}`, `Send to ${tg.name}`, sendKeys[tg.id] || "", () => sendById(tg.id));

  cmd("AI", "ai.toggle", "AI assistant panel", "Ctrl+Shift+A", () => toggleAiPanel());
  cmd("AI", "ai.send", "Send AI message", "Ctrl+Enter", () => aiSend(),
    { enabled: () => !!document.getElementById("ai-panel") && !document.getElementById("ai-panel")!.hidden });

  cmd("App", "app.settings", "Settings", "Ctrl+,", () => openSettingsDialog());
  cmd("App", "app.palette", "Command palette", "Ctrl+Shift+P", () => toggleCmdk());
  cmd("App", "app.shortcuts", "Shortcut screen", "F1", () => showShortcutScreen(true));
}

function initMdaddyFeatures(): void {
  initShortcuts(prefGet("mdaddy-shortcuts"), (json) => prefSet("mdaddy-shortcuts", json));
  registerCommands();
  setVditorCommandMap({
    headings: "fmt.headings", bold: "fmt.bold", italic: "fmt.italic", strike: "fmt.strike", line: "fmt.line",
    quote: "fmt.quote", list: "fmt.list", "ordered-list": "fmt.orderedList", check: "fmt.check", outdent: "fmt.outdent",
    indent: "fmt.indent", code: "fmt.code", "inline-code": "fmt.inlineCode", link: "fmt.link", table: "fmt.table",
    undo: "edit.undo", redo: "edit.redo", "edit-mode": "view.editMode", fullscreen: "view.reader", "os-fullscreen": "view.fullscreen",
  });
  initTooltips();
  initSettings({
    prefGet, prefSet, showToast,
    applyToolbarSize, applySidebarWidth,
    systemPromptPreview: () => buildSystemPrompt("(your document)", "Document.md", "C:\\path\\to\\Document.md", ""),
  });
  applyToolbarSize(toolbarSize());
  initAi({
    docText: () => (vditor ? mdValue() : activeDoc()?.content || ""),
    docName: () => activeDoc()?.name || "Untitled",
    docPath: () => activeDoc()?.path || null,
    selectionText: () => lastEditorSelection,
    applyDocument: (md) => {
      const doc = activeDoc();
      if (!doc || !vditor) return;
      doc.undoStack.push(mdValue());
      if (doc.undoStack.length > 100) doc.undoStack.shift();
      doc.redoStack.length = 0;
      restoreDocValue(doc, md);
    },
    insertAtCursor: (md) => { if (vditor) { vditor.focus(); vditor.insertValue(md); } },
    showToast, keyFor,
  });
  initSend({
    ensureFile: ensureDocFile,
    buildHtml: async () => { const f = await exportFragment("html"); return f ? wrapExportHtml(f) : null; },
    docBaseName: () => activeDoc()?.name || "Untitled.md",
    showToast, keyFor,
  });
  document.addEventListener("mdaddy:open-settings", (e) => openSettingsDialog((e as CustomEvent).detail));
  document.addEventListener("mdaddy:send-targets-changed", () => {
    for (const tg of loadSendTargets()) {
      if (!getCommand(`send.${tg.id}`)) register({ group: "Send", id: `send.${tg.id}`, label: `Send to ${tg.name}`, defaultKey: "", run: () => sendById(tg.id) });
    }
  });
  // remember the editor selection so the AI panel knows what was selected after focus moves to it
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    const node = sel?.anchorNode as Node | null;
    if (node && (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest("#editor .vditor-reset")) {
      lastEditorSelection = sel && !sel.isCollapsed ? sel.toString().slice(0, 4000) : "";
    }
  });
  // Esc leaves OS full screen (when nothing else wants Esc)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !document.body.classList.contains("os-fullscreen")) return;
    if (document.querySelector(".modal-mask:not([hidden])") || !document.getElementById("find-bar")!.hidden) return;
    void toggleOsFullscreen(false);
  });
  document.getElementById("ftree-favs")?.addEventListener("click", () => openSettingsDialog("favorites"));
  const logoButton = document.getElementById("btn-brand-logo");
  const brand = document.getElementById("btn-brand-menu");
  const brandWrap = document.getElementById("brand-wrap");
  const brandMenu = document.getElementById("brand-menu") as HTMLElement | null;
  logoButton?.addEventListener("click", (event) => { event.stopPropagation(); setSideCollapsed(!sideCollapsed); });
  brand?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!brandMenu) return;
    if (!brandMenu.hidden) { closeBrandUi(); return; }
    closeBrandUi();
    brandMenu.hidden = false;
    brand.setAttribute("aria-expanded", "true");
    renderRecent();
  });
  document.addEventListener("pointerdown", (event) => {
    if (brandMenu && !brandMenu.hidden && !(event.target as Element).closest("#brand-wrap")) closeBrandUi();
  }, true);
  document.getElementById("brand-settings")?.addEventListener("click", () => { closeBrandUi(); openSettingsDialog(); });
  document.getElementById("brand-ai")?.addEventListener("click", () => { closeBrandUi(); toggleAiPanel(); });
  document.getElementById("brand-send")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const panel = document.getElementById("brand-send-submenu") as HTMLElement | null;
    const button = event.currentTarget as HTMLButtonElement;
    const wasOpen = !!panel && !panel.hidden;
    closeBrandUi();
    if (!wasOpen && panel && brandMenu) {
      brandMenu.hidden = false;
      brand?.setAttribute("aria-expanded", "true");
      panel.hidden = false;
      brandWrap?.classList.add("submenu-open");
      button.setAttribute("aria-expanded", "true");
      toggleSendMenu(true);
    }
  });
  document.getElementById("brand-recents-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const panel = document.getElementById("brand-recent-submenu") as HTMLElement | null;
    const button = event.currentTarget as HTMLButtonElement;
    const wasOpen = !!panel && !panel.hidden;
    closeBrandUi();
    if (!wasOpen && panel && brandMenu) {
      brandMenu.hidden = false;
      brand?.setAttribute("aria-expanded", "true");
      renderRecent();
      panel.hidden = false;
      brandWrap?.classList.add("submenu-open");
      button.setAttribute("aria-expanded", "true");
    }
  });
  document.addEventListener("mdaddy:close-brand-submenus", closeBrandUi);
  document.addEventListener("mdaddy:favorites-changed", renderFavoriteList);
  renderFavoriteList();
  const menuItems: Array<[string, () => void]> = [
    ["fm-new", () => openDoc(null, "", t("untitled"))],
    ["vm-fullscreen", () => void toggleOsFullscreen()],
    ["vm-reader", () => toggleReaderMode()],
    ["vm-autoscroll", () => { if (rsOn) rsStop(); else rsStart(); }],
    ["vm-outline", () => { if (sideCollapsed) setSideCollapsed(false); switchSidePane("outline"); }],
    ["vm-files", () => { if (sideCollapsed) setSideCollapsed(false); switchSidePane("files"); }],
    ["vm-welcome", () => showShortcutScreen(true)],
  ];
  for (const [id, run] of menuItems) {
    document.getElementById(id)?.addEventListener("click", () => {
      (document.getElementById("view-menu") as HTMLElement).hidden = true;
      (document.getElementById("file-menu") as HTMLElement).hidden = true;
      run();
    });
  }
  // panels opening/closing (AI, sidebar) change the editor width: keep the code-block copy button attached to its block
  new ResizeObserver(() => repositionCodeBtn()).observe(document.getElementById("editor-wrap")!);
  showShortcutScreen();
}
