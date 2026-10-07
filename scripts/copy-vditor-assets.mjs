// Copies the Vditor runtime assets (lute engine, icons, KaTeX, highlight.js, mermaid, content themes...)
// from node_modules/vditor/dist into public/vditor-assets/dist, which the app loads via `cdn: "/vditor-assets"`.
// Without these files the editor never initialises (no toolbar, files cannot be opened), so this runs
// automatically before every dev/build. On the way in it drops non-English UI translations and removes
// CJK characters from text files (escaped in JS so behaviour is unchanged, stripped elsewhere).
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const SRC = "node_modules/vditor/dist";
const DEST = "public/vditor-assets/dist";
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;
const SKIP = new Set(["ts", "types", "index.js", "index.min.js", "method.js", "method.min.js"]);

if (!existsSync(SRC)) {
  console.error("copy-vditor-assets: node_modules/vditor missing, run npm install first");
  process.exit(1);
}
rmSync("public/vditor-assets", { recursive: true, force: true });
cpSync(SRC, DEST, {
  recursive: true,
  filter: (p) => {
    const rel = p.slice(SRC.length + 1).replace(/\\/g, "/");
    if (SKIP.has(rel) || rel.endsWith(".d.ts")) return false;
    if (rel.startsWith("js/i18n/") && !rel.endsWith("en_US.js")) return false;
    return true;
  },
});

let cleaned = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const ext = extname(name).toLowerCase();
    if (![".js", ".css", ".json", ".html", ".svg", ".md", ".txt"].includes(ext)) continue;
    const text = readFileSync(p, "utf8");
    if (!CJK.test(text)) continue;
    CJK.lastIndex = 0;
    const out = ext === ".js"
      ? text.replace(CJK, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
      : ext === ".css"
        ? text.replace(CJK, (c) => "\\" + c.charCodeAt(0).toString(16) + " ")
        : text.replace(CJK, "");
    writeFileSync(p, out);
    cleaned++;
  }
};
walk(DEST);
console.log(`copy-vditor-assets: copied to ${DEST}, cleaned ${cleaned} file(s)`);
