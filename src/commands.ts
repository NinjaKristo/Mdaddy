// Central command + shortcut registry. Every feature registers a command with a default hotkey;
// users can rebind any of them in Settings > Shortcuts (stored in prefs as JSON {id: "Ctrl+Shift+X" | ""}).
// The keydown listener is attached on window in the capture phase at module load, i.e. before Vditor
// registers its own hotkeys, so customised keys win over Vditor's built-ins.

export interface Command {
  id: string;
  label: string;
  group: string;
  defaultKey: string;
  run: () => void;
  /** only fire while the editor (or nothing editable) has focus — formatting commands */
  editorOnly?: boolean;
  /** shown in lists but not rebindable (undo/redo are owned by the custom undo stack) */
  fixed?: boolean;
  /** when it returns false the key is left alone (e.g. "send AI message" only while the AI panel is open) */
  enabled?: () => boolean;
}

const commands = new Map<string, Command>();
let custom: Record<string, string> = {};
let persist: (json: string) => void = () => {};
let suspended = false;
const listeners = new Set<() => void>();

const CODE_NAMES: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Space: "Space", Enter: "Enter", Tab: "Tab",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown", Delete: "Delete", Insert: "Insert", Backspace: "Backspace",
  Escape: "Esc", NumpadAdd: "=", NumpadSubtract: "-",
};

/** KeyboardEvent → canonical "Ctrl+Alt+Shift+K" string ("" for bare modifier presses). Layout independent (uses e.code). */
export function keyOf(e: KeyboardEvent): string {
  const c = e.code || "";
  let k = "";
  if (/^Key[A-Z]$/.test(c)) k = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) k = c.slice(5);
  else if (/^Numpad[0-9]$/.test(c)) k = c.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) k = c;
  else if (CODE_NAMES[c]) k = CODE_NAMES[c];
  if (!k) return "";
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, k].join("+");
}

/** A binding must use Ctrl or Alt, or be a function key (so plain typing never triggers commands). */
export function isBindable(key: string): boolean {
  if (!key) return false;
  const parts = key.split("+");
  const main = parts[parts.length - 1];
  if (/^F\d+$/.test(main)) return true;
  return parts.includes("Ctrl") || parts.includes("Alt");
}

export function initShortcuts(saved: string | null, save: (json: string) => void): void {
  persist = save;
  try { custom = saved ? JSON.parse(saved) : {}; } catch { custom = {}; }
}

export function register(cmd: Command): void {
  commands.set(cmd.id, cmd);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

/** Current key for a command ("" = unbound). */
export function keyFor(id: string): string {
  const c = commands.get(id);
  if (!c) return "";
  if (!c.fixed && Object.prototype.hasOwnProperty.call(custom, id)) return custom[id];
  return c.defaultKey;
}

export function setKey(id: string, key: string): void {
  const c = commands.get(id);
  if (!c || c.fixed) return;
  if (key === c.defaultKey) delete custom[id];
  else custom[id] = key;
  persist(JSON.stringify(custom));
  listeners.forEach((f) => f());
}

export function resetAllKeys(): void {
  custom = {};
  persist(JSON.stringify(custom));
  listeners.forEach((f) => f());
}

/** Replace all user bindings in one write. `keys` contains a complete or partial id→key map. */
export function replaceKeys(keys: Record<string, string>): void {
  custom = {};
  for (const [id, key] of Object.entries(keys)) {
    const command = commands.get(id);
    if (!command || command.fixed || key === command.defaultKey) continue;
    custom[id] = key;
  }
  persist(JSON.stringify(custom));
  listeners.forEach((f) => f());
}

/** Other commands currently using `key`. */
export function conflictsFor(key: string, exceptId: string): Command[] {
  if (!key) return [];
  return allCommands().filter((c) => c.id !== exceptId && keyFor(c.id) === key);
}

export function onKeysChanged(f: () => void): void {
  listeners.add(f);
}

/** Pause global shortcut handling (while the settings key-capture box is recording). */
export function suspendShortcuts(on: boolean): void {
  suspended = on;
}

export function runCommand(id: string): void {
  commands.get(id)?.run();
}

function editableTarget(t: EventTarget | null): "editor" | "field" | "none" {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return "none";
  if (el.closest(".vditor")) return "editor";
  if (el.closest("input, textarea, select, [contenteditable='true']")) return "field";
  return "none";
}

window.addEventListener("keydown", (e) => {
  if (suspended || e.isComposing) return;
  const key = keyOf(e);
  if (!key || !isBindable(key)) return;
  // Undo/redo stay with the dedicated handler in main.ts (custom undo stack).
  if (key === "Ctrl+Z" || key === "Ctrl+Y" || key === "Ctrl+Shift+Z") return;
  const where = editableTarget(e.target);
  for (const c of commands.values()) {
    if (c.fixed || keyFor(c.id) !== key) continue;
    if (c.enabled && !c.enabled()) continue;
    if (c.editorOnly && where === "field") return; // e.g. Ctrl+B inside the AI prompt box: leave it to the field
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    try { c.run(); } catch (err) { console.error("command failed", c.id, err); }
    return;
  }
}, true);
