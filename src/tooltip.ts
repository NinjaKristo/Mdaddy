// App-wide hover tips. Replaces native title tooltips and Vditor's CSS tooltips (which were clipped by the
// sidebar and the window edge) with one fixed-position layer on top of everything, kept inside the window.
// The current shortcut for the element's command is appended as small italic text.
import { keyFor } from "./commands";

let tip: HTMLDivElement | null = null;
let current: HTMLElement | null = null;
let showTimer = 0;
/** maps a Vditor toolbar data-type to a command id, so toolbar tips show the user's binding */
let vditorTypeToCmd: Record<string, string> = {};

export function setVditorCommandMap(m: Record<string, string>): void {
  vditorTypeToCmd = m;
}

function tipTarget(el: EventTarget | null): HTMLElement | null {
  let n = el as HTMLElement | null;
  while (n && n !== document.body) {
    if (n.nodeType === 1) {
      if (n.title) { // adopt native titles so the browser tooltip never shows
        n.dataset.tip = n.title;
        n.removeAttribute("title");
      }
      if (n.dataset?.tip || (n.classList.contains("vditor-tooltipped") && n.getAttribute("aria-label"))) return n;
    }
    n = n.parentElement;
  }
  return null;
}

function textFor(el: HTMLElement): { text: string; key: string } {
  let text = el.dataset.tip || el.getAttribute("aria-label") || "";
  // Vditor appends its own hotkey like "Bold <Ctrl+B>": strip it, ours is authoritative
  text = text.replace(/\s*<[^>]*>\s*$/, "").trim();
  let cmd = el.dataset.cmd || "";
  if (!cmd) {
    const type = el.getAttribute("data-type") || el.closest("[data-type]")?.getAttribute("data-type") || "";
    if (type && el.closest(".vditor-toolbar, .vditor-panel")) cmd = vditorTypeToCmd[type] || "";
  }
  const key = cmd ? keyFor(cmd) : (el.dataset.key || "");
  return { text, key };
}

function place(el: HTMLElement): void {
  if (!tip) return;
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let top = r.top - th - 6; // prefer above
  if (top < 4) top = r.bottom + 6; // no room: below
  if (top + th > vh - 4) top = Math.max(4, vh - th - 4);
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(4, Math.min(left, vw - tw - 4));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function show(el: HTMLElement): void {
  const { text, key } = textFor(el);
  if (!text && !key) return;
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "app-tip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }
  tip.innerHTML = "";
  const t = document.createElement("span");
  t.className = "tip-text";
  t.textContent = text;
  tip.appendChild(t);
  if (key) {
    const k = document.createElement("sub");
    k.className = "tip-key";
    k.textContent = key;
    tip.appendChild(k);
  }
  tip.hidden = false;
  tip.style.visibility = "hidden";
  tip.style.top = "0px";
  tip.style.left = "0px";
  requestAnimationFrame(() => {
    if (!tip || current !== el) return;
    place(el);
    tip.style.visibility = "visible";
  });
}

export function hideTip(): void {
  window.clearTimeout(showTimer);
  current = null;
  if (tip) tip.hidden = true;
}

export function initTooltips(): void {
  document.addEventListener("pointerover", (e) => {
    const el = tipTarget(e.target);
    if (el === current) return;
    hideTip();
    if (!el) return;
    current = el;
    showTimer = window.setTimeout(() => { if (current === el && el.isConnected) show(el); }, 350);
  }, true);
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("keydown", hideTip, true);
  window.addEventListener("blur", hideTip);
  document.addEventListener("scroll", hideTip, true);
}
