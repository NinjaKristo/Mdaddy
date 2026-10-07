// "Send ▾" menu: hand the current document to another app (Obsidian, VS Code, Firefox, plus user-added apps).
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadSendTargets, SendTarget } from "./settings";

export interface SendCtx {
  /** make sure the document is on disk; returns its path (saves, or writes a temp copy for untitled docs) */
  ensureFile(): Promise<string | null>;
  /** styled standalone HTML of the document */
  buildHtml(): Promise<string | null>;
  docBaseName(): string;
  showToast(msg: string, kind?: "info" | "danger" | "success"): void;
  keyFor(id: string): string;
}

let ctx: SendCtx;

async function htmlCopy(): Promise<string | null> {
  const html = await ctx.buildHtml();
  if (!html) return null;
  const dir = await invoke<string>("temp_dir_path");
  const path = `${dir}\\${ctx.docBaseName().replace(/\.[^.]+$/, "")}-preview.html`;
  await invoke("write_export_file", { path, content: html });
  return path;
}

export async function sendTo(t: SendTarget): Promise<void> {
  try {
    const file = await ctx.ensureFile();
    if (!file) return;
    if (t.program === "obsidian") {
      await openUrl(`obsidian://open?path=${encodeURIComponent(file)}`);
    } else {
      const needsHtml = t.args.includes("{html}");
      const html = needsHtml ? await htmlCopy() : null;
      if (needsHtml && !html) { ctx.showToast("Could not build the HTML preview", "danger"); return; }
      const args = (t.args || "{file}").match(/"[^"]*"|\S+/g)!.map((a) =>
        a.replace(/^"|"$/g, "").replace("{file}", file).replace("{html}", html || ""));
      await invoke("launch_app", { program: t.program, args });
    }
    ctx.showToast(`Sent to ${t.name}`, "success");
  } catch (e) {
    ctx.showToast(`Send to ${t.name} failed: ${e}`, "danger");
  }
}

export function sendById(id: string): void {
  const t = loadSendTargets().find((x) => x.id === id);
  if (t) void sendTo(t);
}

function renderMenu(menu: HTMLElement): void {
  menu.innerHTML = "";
  const close = () => {
    menu.hidden = true;
    document.dispatchEvent(new CustomEvent("mdaddy:close-brand-submenus"));
  };
  const targets = loadSendTargets().filter((t) => t.enabled);
  for (const t of targets) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t.name;
    b.dataset.cmd = `send.${t.id}`;
    b.dataset.tip = `Send to ${t.name}`;
    b.addEventListener("click", () => { close(); void sendTo(t); });
    menu.append(b);
  }
  const sep = document.createElement("div");
  sep.className = "menu-sep";
  const more = document.createElement("button");
  more.type = "button";
  more.textContent = "+";
  more.title = "Add app";
  more.setAttribute("aria-label", "Add app");
  more.addEventListener("click", () => {
    close();
    document.dispatchEvent(new CustomEvent("mdaddy:open-settings", { detail: "send" }));
  });
  menu.append(sep, more);
}

export function toggleSendMenu(force?: boolean): void {
  const menu = document.getElementById("send-menu");
  if (!menu) return;
  const on = force ?? menu.hidden;
  if (on) renderMenu(menu);
  menu.hidden = !on;
}

export function initSend(c: SendCtx): void {
  ctx = c;
  const btn = document.getElementById("btn-send");
  btn?.addEventListener("click", (e) => { e.stopPropagation(); toggleSendMenu(); });
  document.addEventListener("pointerdown", (e) => {
    const menu = document.getElementById("send-menu");
    if (menu && !menu.hidden && !(e.target as HTMLElement).closest("#send-wrap,#brand-wrap")) {
      menu.hidden = true;
      document.dispatchEvent(new CustomEvent("mdaddy:close-brand-submenus"));
    }
  }, true);
}
