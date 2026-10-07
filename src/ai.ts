// Integrated AI assistant. Providers, in order: model-shelf models (Ollama, HF, Unsloth, freetoken — one
// separator between each), then a heavier bar, then the $20/mth subscriptions (Claude Pro via the Claude Code
// CLI, ChatGPT Plus via the Codex CLI). The system prompt tells the model everything it needs to edit the
// document; replies that contain an edit block get an "Apply" button (applied as one undo step).
import { invoke } from "@tauri-apps/api/core";
import { loadAiConfig } from "./settings";

export interface AiCtx {
  docText(): string;
  docName(): string;
  docPath(): string | null;
  selectionText(): string;
  applyDocument(md: string): void;
  insertAtCursor(md: string): void;
  showToast(msg: string, kind?: "info" | "danger" | "success"): void;
  keyFor(id: string): string;
}

type Provider = "ollama" | "hf" | "unsloth" | "freetoken" | "claude" | "codex";
interface Msg { role: "user" | "assistant"; content: string; }

const DOC_OPEN = "<<<MDADDY_DOCUMENT";
const DOC_CLOSE = "MDADDY_DOCUMENT>>>";
const INS_OPEN = "<<<MDADDY_INSERT";
const INS_CLOSE = "MDADDY_INSERT>>>";

let ctx: AiCtx;
let panel: HTMLElement | null = null;
let history: Msg[] = [];
let busy = false;

export function buildSystemPrompt(doc: string, name: string, path: string | null, selection: string): string {
  return [
    "You are the AI assistant built into Mdaddy, a simple Windows desktop Markdown editor.",
    "The user is editing the Markdown document shown below and talks to you from a side panel.",
    "",
    "HOW TO CHANGE THE DOCUMENT",
    "- To rewrite or edit the document, reply with the COMPLETE updated document (every line, not a diff) between these exact marker lines:",
    `${DOC_OPEN}`,
    "...the full new markdown...",
    `${DOC_CLOSE}`,
    "- To add new text at the user's cursor without touching the rest, use instead:",
    `${INS_OPEN}`,
    "...markdown to insert...",
    `${INS_CLOSE}`,
    "- Use at most one block per reply, never wrap the block in a code fence, and put a one or two sentence summary of what you changed outside the block.",
    "- If the user only asks a question, answer normally and do not include a block.",
    "- The user reviews your block and presses Apply; it becomes a single undo step (Ctrl+Z reverts it).",
    "",
    "WHAT THE EDITOR SUPPORTS",
    "- CommonMark + GitHub Flavored Markdown: headings, lists, task lists (- [ ]), tables with alignment, blockquotes, fenced code with a language tag.",
    "- Footnotes ([^1]), KaTeX math ($inline$ and $$block$$), mermaid diagrams in ```mermaid fences, inline HTML such as <span style=\"font-size:20px\">.",
    "- Images are referenced by relative path (for example assets/Screenshot_20260101_120000.png); keep existing image and link paths exactly as they are.",
    "- Keep the user's front matter, heading style, list markers and line breaks unless asked to change them. Write in the language the document uses.",
    "",
    `DOCUMENT: ${name}${path ? ` (${path})` : " (not saved yet)"}`,
    selection ? `THE USER HAS THIS TEXT SELECTED (apply requests to it when it makes sense):\n${selection}\n` : "",
    "--- DOCUMENT START ---",
    doc,
    "--- DOCUMENT END ---",
  ].join("\n");
}

function parseReply(text: string): { kind: "doc" | "insert" | null; body: string; note: string } {
  for (const [open, close, kind] of [[DOC_OPEN, DOC_CLOSE, "doc"], [INS_OPEN, INS_CLOSE, "insert"]] as const) {
    const a = text.indexOf(open);
    if (a < 0) continue;
    const b = text.indexOf(close, a + open.length);
    let body = text.slice(a + open.length, b < 0 ? undefined : b).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    body = body.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, "$1"); // tolerate a stray fence
    const note = (text.slice(0, a) + (b < 0 ? "" : text.slice(b + close.length))).trim();
    return { kind, body, note };
  }
  return { kind: null, body: "", note: text.trim() };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ---------- model list ----------
async function fillModels(sel: HTMLSelectElement): Promise<void> {
  const cfg = loadAiConfig();
  const prev = sel.value || localStorageGet("mdaddy-ai-last") || "";
  sel.innerHTML = "";
  const add = (value: string, label: string, disabled = false, cls = "") => {
    const o = document.createElement("option");
    o.value = value; o.textContent = label; o.disabled = disabled;
    if (cls) o.className = cls;
    sel.append(o);
  };
  const sep = () => add("", "────────────", true, "sep");
  // Ollama
  add("", "Ollama", true, "grp");
  try {
    const raw = await invoke<string>("ai_http", { method: "GET", url: `${cfg.ollamaUrl.replace(/\/$/, "")}/api/tags`, body: null });
    const tags = (JSON.parse(raw).models || []) as { name: string }[];
    if (!tags.length) add("", "  (no Ollama models pulled)", true);
    for (const m of tags) add(`ollama::${m.name}`, `  ${m.name}`);
  } catch { add("", "  (Ollama not running)", true); }
  // shelf groups
  let shelf: { hf: { name: string }[]; unsloth: { name: string }[]; freetoken: { name: string }[] } = { hf: [], unsloth: [], freetoken: [] };
  try { shelf = await invoke("ai_shelf_models", { root: cfg.shelfRoot }); } catch { /* keep empty */ }
  for (const [key, label] of [["hf", "HF"], ["unsloth", "Unsloth"], ["freetoken", "freetoken"]] as const) {
    sep();
    add("", label, true, "grp");
    const list = shelf[key];
    if (!list.length) add("", "  (none on the shelf)", true);
    for (const m of list) add(`${key}::${m.name}`, `  ${m.name}`);
  }
  // subscriptions
  add("", "━━━━━━━━━━━━", true, "sep heavy");
  let avail: [boolean, boolean] = [false, false];
  try { avail = await invoke("ai_cli_available", { exeClaude: cfg.claudePath, exeCodex: cfg.codexPath }); } catch { /* ignore */ }
  add("claude::", `Claude Pro ($20/mth)${avail[0] ? "" : " — CLI not found"}`, !avail[0]);
  add("codex::", `ChatGPT Plus ($20/mth)${avail[1] ? "" : " — CLI not found"}`, !avail[1]);
  const opts = [...sel.options];
  const pick = opts.find((o) => o.value === prev && !o.disabled) || opts.find((o) => o.value && !o.disabled);
  if (pick) sel.value = pick.value;
}

function localStorageGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------- calling the model ----------
async function openAiCompatible(base: string, shelfName: string, messages: { role: string; content: string }[]): Promise<string> {
  const root = base.replace(/\/$/, "");
  let model = shelfName;
  try { // pick the loaded model that best matches the shelf name
    const ids = (JSON.parse(await invoke<string>("ai_http", { method: "GET", url: `${root}/models`, body: null })).data || [])
      .map((m: { id: string }) => m.id) as string[];
    const leaf = shelfName.split("/").pop()!.toLowerCase();
    model = ids.find((i) => i.toLowerCase().includes(leaf)) || ids.find((i) => leaf.includes(i.toLowerCase())) || ids[0] || shelfName;
  } catch (e) {
    throw new Error(`No model server at ${root}. Start LM Studio / llama-server with "${shelfName}" loaded, or set the server address in Settings > AI. (${e})`);
  }
  const raw = await invoke<string>("ai_http", {
    method: "POST", url: `${root}/chat/completions`,
    body: JSON.stringify({ model, messages, stream: false }),
  });
  return JSON.parse(raw).choices?.[0]?.message?.content ?? "";
}

async function callModel(choice: string, system: string, msgs: Msg[]): Promise<string> {
  const [prov, name] = choice.split("::") as [Provider, string];
  const cfg = loadAiConfig();
  const chat = [{ role: "system", content: system }, ...msgs];
  if (prov === "ollama") {
    const raw = await invoke<string>("ai_http", {
      method: "POST", url: `${cfg.ollamaUrl.replace(/\/$/, "")}/api/chat`,
      body: JSON.stringify({ model: name, messages: chat, stream: false }),
    });
    return JSON.parse(raw).message?.content ?? "";
  }
  if (prov === "hf" || prov === "unsloth" || prov === "freetoken") {
    const url = prov === "hf" ? cfg.hfUrl : prov === "unsloth" ? cfg.unslothUrl : cfg.freetokenUrl;
    return openAiCompatible(url, name, chat);
  }
  // subscription CLIs take one prompt: system + transcript
  const transcript = msgs.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`).join("\n\n");
  const prompt = `${system}\n\nCONVERSATION SO FAR\n${transcript}\n\nReply to the last USER message now.`;
  return invoke<string>("ai_cli", {
    provider: prov, prompt,
    model: prov === "claude" ? cfg.claudeModel : cfg.codexModel,
    exePath: prov === "claude" ? cfg.claudePath : cfg.codexPath,
  });
}

// ---------- UI ----------
function renderMsg(log: HTMLElement, m: Msg): void {
  const box = el("div", `ai-msg ${m.role}`);
  if (m.role === "user") {
    box.textContent = m.content;
  } else {
    const r = parseReply(m.content);
    if (r.note) box.append(el("div", "ai-note", r.note));
    if (r.kind) {
      const pre = el("pre", "ai-block");
      pre.textContent = r.body.length > 1500 ? r.body.slice(0, 1500) + "\n…" : r.body;
      const actions = el("div", "ai-actions");
      const apply = el("button", "primary", r.kind === "doc" ? "Apply to document" : "Insert at cursor");
      apply.addEventListener("click", () => {
        if (r.kind === "doc") ctx.applyDocument(r.body); else ctx.insertAtCursor(r.body);
        apply.disabled = true; apply.textContent = "Applied ✓";
        ctx.showToast(`AI change applied — ${ctx.keyFor("edit.undo") || "Ctrl+Z"} to undo`, "success");
      });
      const copy = el("button", "", "Copy");
      copy.addEventListener("click", () => { void navigator.clipboard.writeText(r.body); copy.textContent = "Copied"; });
      actions.append(apply, copy);
      box.append(el("div", "ai-tag", r.kind === "doc" ? "Proposed new document" : "Proposed insertion"), pre, actions);
    }
  }
  log.append(box);
  log.scrollTop = log.scrollHeight;
}

async function send(): Promise<void> {
  if (!panel || busy) return;
  const input = panel.querySelector<HTMLTextAreaElement>("#ai-input")!;
  const sel = panel.querySelector<HTMLSelectElement>("#ai-model")!;
  const log = panel.querySelector<HTMLElement>("#ai-log")!;
  const text = input.value.trim();
  if (!text) return;
  if (!sel.value) { ctx.showToast("Pick a model first", "danger"); return; }
  localStorageSet("mdaddy-ai-last", sel.value);
  const withDoc = panel.querySelector<HTMLInputElement>("#ai-with-doc")!.checked;
  const system = withDoc
    ? buildSystemPrompt(ctx.docText(), ctx.docName(), ctx.docPath(), ctx.selectionText())
    : buildSystemPrompt("(the user chose not to share the document for this message)", ctx.docName(), ctx.docPath(), "");
  history.push({ role: "user", content: text });
  renderMsg(log, history[history.length - 1]);
  input.value = "";
  busy = true;
  const wait = el("div", "ai-msg assistant pending", "Thinking…");
  log.append(wait);
  log.scrollTop = log.scrollHeight;
  panel.classList.add("busy");
  try {
    const reply = await callModel(sel.value, system, history);
    history.push({ role: "assistant", content: reply || "(empty reply)" });
    wait.remove();
    renderMsg(log, history[history.length - 1]);
  } catch (e) {
    wait.remove();
    history.pop();
    const err = el("div", "ai-msg error", String(e instanceof Error ? e.message : e));
    log.append(err);
    log.scrollTop = log.scrollHeight;
  } finally {
    busy = false;
    panel.classList.remove("busy");
  }
}

function build(): HTMLElement {
  const p = el("aside");
  p.id = "ai-panel";
  p.innerHTML = `
    <div class="ai-head">
      <b>AI assistant</b>
      <span class="grow"></span>
      <button type="button" id="ai-refresh" data-tip="Refresh model list">⟳</button>
      <button type="button" id="ai-clear" data-tip="New conversation">New</button>
      <button type="button" id="ai-close" data-cmd="ai.toggle" data-tip="Close AI panel">✕</button>
    </div>
    <select id="ai-model" data-tip="Model"></select>
    <div id="ai-log"><div class="ai-empty">Ask for an edit ("make this more concise", "add a summary table") or a question about your document.</div></div>
    <label class="chk"><input type="checkbox" id="ai-with-doc" checked> Share the document with the AI</label>
    <textarea id="ai-input" rows="3" placeholder="Ask the AI…"></textarea>
    <div class="ai-foot"><span class="hint" id="ai-hint"></span><span class="grow"></span><button type="button" class="primary" id="ai-send" data-cmd="ai.send" data-tip="Send">Send</button></div>`;
  return p;
}

export function toggleAiPanel(force?: boolean): void {
  if (!panel) return;
  const on = force ?? panel.hidden;
  panel.hidden = !on;
  document.body.classList.toggle("ai-open", on);
  if (on) {
    const sel = panel.querySelector<HTMLSelectElement>("#ai-model")!;
    if (!sel.options.length) void fillModels(sel);
    panel.querySelector<HTMLTextAreaElement>("#ai-input")!.focus();
  }
}

export function aiSend(): void { void send(); }

export function initAi(c: AiCtx): void {
  ctx = c;
  panel = build();
  panel.hidden = true;
  document.getElementById("main")!.append(panel);
  const sel = panel.querySelector<HTMLSelectElement>("#ai-model")!;
  panel.querySelector("#ai-refresh")!.addEventListener("click", () => void fillModels(sel));
  panel.querySelector("#ai-clear")!.addEventListener("click", () => {
    history = [];
    panel!.querySelector("#ai-log")!.innerHTML = "";
  });
  panel.querySelector("#ai-close")!.addEventListener("click", () => toggleAiPanel(false));
  panel.querySelector("#ai-send")!.addEventListener("click", () => void send());
  const input = panel.querySelector<HTMLTextAreaElement>("#ai-input")!;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); void send(); }
  });
  const hint = panel.querySelector<HTMLElement>("#ai-hint")!;
  const setHint = () => { hint.textContent = `${ctx.keyFor("ai.send") || "Ctrl+Enter"} to send`; };
  setHint();
  document.addEventListener("mdaddy:keys-changed", setHint);
  document.addEventListener("mdaddy:ai-config-changed", () => { sel.innerHTML = ""; if (!panel!.hidden) void fillModels(sel); });
}
