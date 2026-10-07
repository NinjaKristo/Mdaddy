// Build-time plugin: removes every CJK character from the bundled output.
// Third-party libraries (Vditor, html2canvas, markdown-it) ship some Chinese text:
// Vditor's built-in help/about panels and copy fallbacks, license headers, and a few
// functional character tables (IME punctuation checks, CJK list numbering, regexes).
// Visible phrases are translated to English; anything left is rewritten as a \uXXXX
// escape so behaviour is unchanged but no Asian characters remain in the shipped files.
import type { Plugin } from "vite";

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;

const PHRASES: [string, string][] = [
  ["B3log \u5f00\u6e90", "B3log Open Source"],
  ["\u590d\u5236\u5230\u516c\u4f17\u53f7", "Copy for WeChat"],
  ["\u590d\u5236\u5230\u77e5\u4e4e", "Copy for Zhihu"],
  ["\u5df2\u590d\u5236\uff0c\u53ef\u5230", "Copied, paste it into "],
  ["\u5fae\u4fe1\u516c\u4f17\u53f7\u5e73\u53f0", "WeChat"],
  ["\u77e5\u4e4e", "Zhihu"],
  ["\u8fdb\u884c\u7c98\u8d34", ""],
  ["\u5df2\u590d\u5236\u5230\u526a\u5207\u677f", "Copied to clipboard"],
  ["\u5df2\u590d\u5236", "Copied"],
  ["\u590d\u5236", "Copy"],
  ["Markdown \u4f7f\u7528\u6307\u5357", "Markdown guide"],
  ["\u8bed\u6cd5\u901f\u67e5\u624b\u518c", "Syntax cheat sheet"],
  ["\u57fa\u7840\u8bed\u6cd5", "Basic syntax"],
  ["\u6269\u5c55\u8bed\u6cd5", "Extended syntax"],
  ["\u952e\u76d8\u5feb\u6377\u952e", "Keyboard shortcuts"],
  ["Vditor \u652f\u6301", "Vditor support"],
  ["\u5b98\u65b9\u8ba8\u8bba\u533a", "Community forum"],
  ["\u5f00\u53d1\u624b\u518c", "Developer guide"],
  ["\u6f14\u793a\u5730\u5740", "Demo"],
  ["\u4e0b\u4e00\u4ee3\u7684 Markdown \u7f16\u8f91\u5668\uff0c\u4e3a\u672a\u6765\u800c\u6784\u5efa", "The next-generation Markdown editor, built for the future"],
  ["Vditor \u662f\u4e00\u6b3e\u6d4f\u89c8\u5668\u7aef\u7684 Markdown \u7f16\u8f91\u5668\uff0c\u652f\u6301\u6240\u89c1\u5373\u6240\u5f97\u3001\u5373\u65f6\u6e32\u67d3\uff08\u7c7b\u4f3c Typora\uff09\u548c\u5206\u5c4f\u9884\u89c8\u6a21\u5f0f\u3002",
    "Vditor is a browser-based Markdown editor with WYSIWYG, instant rendering (like Typora) and split-view modes."],
  ["\u5b83\u4f7f\u7528 TypeScript \u5b9e\u73b0\uff0c\u652f\u6301\u539f\u751f JavaScript \u4ee5\u53ca Vue\u3001React\u3001Angular \u548c Svelte \u7b49\u6846\u67b6\u3002",
    "It is written in TypeScript and works with plain JavaScript as well as Vue, React, Angular and Svelte."],
  ["\u9879\u76ee\u5730\u5740\uff1a", "Project: "],
  ["\u5f00\u6e90\u534f\u8bae\uff1a", "License: "],
  ["\u7ec4\u4ef6\u7248\u672c\uff1a", "Version: "],
  ["\u8d5e\u52a9\u6350\u8d60\uff1a", "Sponsor: "],
];

function clean(code: string, js: boolean): string {
  for (const [zh, en] of PHRASES) code = code.split(zh).join(en);
  return code.replace(CJK, (c) => (js ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0") : ""));
}

export default function stripCjk(): Plugin {
  return {
    name: "strip-cjk",
    apply: "build",
    enforce: "post",
    generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type === "chunk") f.code = clean(f.code, true);
        else if (typeof f.source === "string") f.source = clean(f.source, f.fileName.endsWith(".js"));
      }
    },
  };
}
