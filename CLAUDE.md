# Mdaddy (md-editor) — Project rules

> Lightweight Windows desktop Markdown editor: Tauri 2 + Vditor, WYSIWYG + visual table editing, single portable exe, no telemetry.
> This file only covers rules specific to this project; general rules live in the global CLAUDE.md.

## 1. Project scope

- **What it solves**: local Markdown editing (visual tables / tabs / themes / drive-wide file-name search / multi-format export), distributed as a single zero-dependency exe.
- **Current state**: v0.6.0 — English-only, own app identity (`com.ninjakristo.mdaddy`, process `mdaddy.exe`, data in `%APPDATA%\Mdaddy`), so it runs alongside the old md-editor.
- **v0.6.0 modules**: `src/commands.ts` (every command + rebindable shortcut, capture listener registered before Vditor) · `src/tooltip.ts` (app-wide hover tips with italic shortcut) · `src/settings.ts` (⚙ settings + welcome screen) · `src/ai.ts` (AI panel: Ollama / shelf HF·Unsloth·freetoken via OpenAI-compatible server / Claude Pro via `claude -p` / ChatGPT Plus via `codex exec`) · `src/send.ts` (Send to Obsidian / VS Code / Firefox / custom) · `src-tauri/src/extras.rs` (local-only HTTP, CLI runner, shelf scan, known folders, launch_app).
- **Vditor runtime assets** (`public/vditor-assets`, gitignored) are copied by `scripts/copy-vditor-assets.mjs` on every dev/build — if they are missing the editor never starts (no toolbar, files don't open).
- **Out of scope**: no cloud sync / accounts / online collaboration; no thumbnails for relative-path images in WYSIWYG mode (keeps the source portable; images are embedded only on export — a known trade-off).
- **No Asian characters anywhere in the repo or the build.** Source, comments, docs, tests and the bundled output must stay free of CJK characters. `scripts/strip-cjk.ts` (Vite plugin) translates/escapes the CJK text shipped inside third-party libraries at build time — keep it in `vite.config.ts`.

## 2. Architecture and layout

| Item | Content |
|---|---|
| Stack | Tauri 2 (Rust) · TypeScript + Vite · Vditor 3 (editor core) · markdown-it (export rendering) |
| Frontend | `src/main.ts` (main logic: undo stack / tabs / file tree / export / drive index) · `i18n-en.ts` · `styles.css` · `index.html` |
| Backend | `src-tauri/src/lib.rs` + `main.rs` (Rust commands: file IO / encoding detection / drive index / single-instance forwarding) |
| Tests | `tests/TEST-PLAN.md` (single entry point: five layers + module → group map + blind-spot countermeasures); scripts in `output/md-editor-typora-scan/` (e2e_user_J_v0321.py · ahk_smoke_v1.ahk) + `output/md-editor-largefile-v0325/` (e2e_user_L_v0325.py large-file suite + headless benchmarks) |
| Version | package.json 0.1.0 (not tracked); the real version is in tauri.conf.json / git tag |
| Icon | Windows/app icons are generated from vector source `Assets/MdaddyIcon-App.svg` (a square-padded form of `Assets/MdaddyIcon.svg`) with `npx tauri icon`; do not copy an older raster `.ico` |

**Startup chain**: `npm run dev` (Vite) → `npm run tauri dev`; production: see the deploy chain below.

### Five-layer test system (tests/TEST-PLAN.md is the single entry point, check before changing anything)

| Layer | Content | When | Time |
|---|---|---|---|
| L0 | `cd src-tauri && cargo test` (54 cases) | every Rust change | ~10s |
| L1 | Smoke: e2e_user_J_v0321.py (18 assertions) + ahk_smoke_v26.ahk (7 assertions) | every delivery/deploy | ~3min |
| L2 | Targeted regression: run affected groups per the module → group map | when a mapped module changes | ~1min/group |
| L3 | Full: B/C/D/E/F/G/H/I/J + e2e_fullcheck | before release | ~15min |
| L4 | AHK real keyboard/mouse (OS level, real side effects, no JS injection) | before release (desktop must be online) | ~2min |

Note: older e2e/AHK scripts match Chinese UI text; after the English-only change they must be updated to the English strings before they are trusted again.

### Module → group map (which group to run for which module)

| Changed module | Must run |
|---|---|
| Undo/save/autosave (main.ts snap*/saveDoc/autosaveDirty) | B, fullcheck(A11), AHK |
| Large-document deferred value sync (valueSync*/openDoc limits/switchDoc loading) | L, B, AHK |
| Tabs (renderTabs/multi-select/overflow) | B, J |
| Session persistence / lazy restore / external-change detection / status bar / find history (v0.3.26 saveSession · loadLazyDoc · checkExternalMod · trackSelectionStatus · findHist*) | M, fullcheck, B |
| File tree / drive search / locate | E, H, I, J |
| Themes/styles (styles.css/applyTheme) | D, J |
| Export/print | fullcheck(E), C |
| lib.rs (Rust commands) | cargo test + related groups |

Group M scripts: `output/md-editor-session-v0326/` (e2e_user_M_v0326.py M1-13 + m_big_ws.py/m_ir2.py M14-18; **never use playwright connect_over_cdp** — it occasionally hangs after the handshake against the deployed WebView; always use raw CDP websocket + suppress_origin=True). Three historical fullcheck drifts (classified 2026-09-08, not product bugs): A1/B2 = since v0.3.26 launching with an argument no longer opens the welcome page and the session excludes it (expected change); D2 = script typing vs. clicking ✕ timing drift (the product dialog verified fine independently).

### AHK external testing rules (each one learned the hard way)

- Script encoding must be **UTF-8 with BOM** (without BOM it is read as ANSI and non-ASCII assertion literals break = false FAIL).
- Always type **digits only** (letter sequences get composed by a pinyin IME).
- Prerequisite: RDP input channel online — session "running" ≠ channel connected; zero characters typed + file at pure baseline = channel down, wait until the desktop is truly active.
- Enter Save As dialog paths by **clipboard paste** (typing the path with Send is swallowed by the IME/focus layer).
- Blur with `WinActivate ahk_class Progman`; window position drifts each run, so coordinate assertions only use client-relative maths.
- Put scripts + logs in **C: Temp** and point TEMP/TMP back to drive C (confirmed 2026-09-07: AHK writing to drive F hung the whole script with zero output); an ExitApp-only minimal script tells an interpreter hang from an IO hang.
- **A user at the machine = live keyboard/mouse interference** (confirmed 2026-09-08: first run 4/7, three typing checks put nothing in the document — the user switched windows during long Sleep gaps and clicks landed elsewhere; AHK5, protected by WinWaitActive, passed alone = counter-proof): before every typing assertion always `WinActivate + WinWaitActive` to relock the foreground, and log WinActive after typing; for "nothing typed + file at baseline" suspect interference before the product.
- After testing against an old exe, always check `tasklist | grep md-editor`: a renamed copy (e.g. .prev0) gets a process name that follows the file name, `taskkill /IM md-editor.exe` misses it → the single-instance forwarding black hole swallows every later launch, easily misdiagnosed as a product regression.
- 7 assertions: type + ^S / ^Z one-step undo / ^Y redo / autosave on blur / double-click tab bar new + Save As / clean exit / session written after exit (AHK7, v0.3.26).
- Page diagnostic hooks (read-only): `window.__mdUndo/__mdRedo/__mdDocs/__sLog/__zTrace`.

**Boundaries not to change lightly (high-risk interaction areas)**:
- **Undo/redo**: custom multi-step stack (100 steps/document) + Vditor's own stack, dual channel; steps split on a 600ms pause + 8-character dual threshold; the signal source **must hook the native input event** (`options.input` is merged by afterRender, typing a whole paragraph fires only once — root fix c13db25); Vditor `resetIcon` overrides button state from its own stack (monkey-patched to a no-op); Backspace/Delete do not fire input, so keydown >400ms since the last one seals the step + keyup 80ms fallback.
- **IME composition**: Ctrl+Z during pinyin composition ends the composition first, then undoes; AHK always types digits only.
- **Vditor hotkey pre-emption**: the Vditor element layer intercepts synthetic KeyboardEvents — real keyboard behaviour with modifiers can only be verified at the AHK layer.
- **Blur save timing**: the autosave-on-blur value read has an async race; changes to the save chain must run group B + fullcheck(A11).
- Large-file defences (reset in v0.3.25: >2,000,000 characters refused / >262,144 characters use the large-document deferred value channel; Rust 16MB hard limit), encoding detection (UTF-8/BOM/GBK, always saved as UTF-8 without BOM).
- **Known limit · huge single-paragraph documents** (scoped 2026-09-08, same symptom in v0.3.25 = existing Vditor engine issue, not a v0.3.26 regression): when the Markdown source has no blank-line paragraph breaks (one giant line or soft-wrapped consecutive lines) and is 100k+ characters, the JS main thread blocks for a long time after WYSIWYG load (evaluate/input all time out, CPU idle, non-JS commands fine). The same size split by blank lines (270k) is fine, and a 570k-character novel compilation (naturally paragraphed) is fine. Do not judge large-document performance by character count alone; paragraph structure is the key variable.
- **v0.3.26 session structure**: ui-state.json `session:{v:1,tabs:[{p,n,s,m,z}],a}` (path/name/scrollTop/mtime/size/active); restored tabs are all built lazy, the active tab awaits loadLazyDoc (lazy=false after open_file) — **never give the active tab lazy:false directly** (loadLazyDoc returns early on `!doc.lazy`, leaving the content empty forever). Guards against cross-document leaks during loading (lazy/loading checks) live in options.input / native input / flushValueSync / autosaveDirty; do not remove them when changing the loading chain.

## 3. Common commands

### Permanent release acceptance rule

- Every UI delivery/checkpoint must update `release/Mdaddy.exe` from the current build. Do not treat a successful Vite or Cargo build alone as a completed UI change.
- Use `bash scripts/build-release.sh`: it regenerates platform icons from the authored SVG, builds the frontend, builds and copies the executable, verifies byte-for-byte parity, then runs the smoke and UI-controls E2E tests against `release/Mdaddy.exe` in isolated data profiles.
- The app is single-instance. If an Mdaddy process is already open, do not kill it or let tests silently forward to it. Close it normally when safe, then rerun the release tests; until then, report the UI test as blocked.
- Keep `tests/e2e/cdp.py` pointed at the release executable so the acceptance checks cover what will actually be launched from `release/`.

```bash
# Full release build (frontend THEN exe, copies to release/Mdaddy.exe). Never cargo-build without npm run build first.
bash scripts/build-release.sh

# In-repo e2e against the real exe (isolated portable copy, never touches the real profile)
cd tests/e2e && python smoke.py && python features.py   # features.py needs Ollama running + claude CLI signed in

npm run dev                     # Vite frontend dev
npm run tauri dev               # desktop shell dev
npm run build                   # tsc && vite build (run after any TS change; type errors fail the build)

# L0 Rust tests (run after any Rust change, ~10s)
cd src-tauri && cargo test

# L1 smoke (before delivery, ~3min; scripts in output/md-editor-typora-scan/)
python e2e_user_J_v0321.py                              # 18 assertions
"/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe" ahk_smoke_v26.ahk  # 7 assertions, desktop must be online (run the script from C: Temp)

# Production build and acceptance test (frontend, exe, release copy, then E2E)
bash scripts/build-release.sh
# → release/Mdaddy.exe; byte-compared with src-tauri/target/release/mdaddy.exe
```

- cargo lives in `~/.cargo/bin` (not on the Bash PATH by default: `export PATH="$HOME/.cargo/bin:$PATH"`).
- `npm install` needs `--allow-remote=all` (the lockfile points at registry.npmmirror.com tarballs).
- AHK prerequisite: RDP input channel online (session "running" ≠ channel connected; zero characters typed = channel down, wait for an active desktop); scripts must be UTF-8 **with BOM**.

## 4. Development constraints

- **Before changing anything**: check the module → group map in `tests/TEST-PLAN.md` to see which test groups the change affects.
- **New features must be covered**: add assertions to the latest group (currently J) or open a new group; assertions must be hard checks (file content / DOM geometry / process state), never just "element exists"; keyboard interaction changes must pass AHK.
- **Change with care**: `main.ts` snap*/saveDoc/autosaveDirty (undo + save chain) · Vditor instantiation options · `lib.rs` file IO commands.
- **Minimum checks before committing**: `npm run build` with zero type errors · affected test groups green · Rust changes: cargo test all green · README kept in sync · no CJK characters anywhere (repo and `dist/`).
- Element references in long scripts like fullcheck must follow version changes (lesson: #file-title was removed in v0.3.16, the script did not follow, D4a gave false negatives for two versions).

## 5. Acceptance criteria

| Item | Hard requirement |
|---|---|
| Rust | cargo test all green |
| Smoke | e2e_user_J 18 assertions + AHK 7 assertions all pass (real keyboard/mouse, real side effects) |
| Undo semantics | type a paragraph → undo steps back in small chunks (not the whole paragraph at once); Ctrl+Z during IME composition does not corrupt text; replace-all / table batch operations undo in one step |
| Save | Ctrl+S / blur / 30s autosave write identical content; version history archiving works (50 versions / 30 days) |
| Export | PDF text selectable and searchable; docx tables/footnotes/images truly embedded; relative-path images embedded on export |
| Distribution | single exe runs clean; release copy md5 matches the build output |

## 6. Security and risk

- **Privacy**: no telemetry; the drive index stores only file names/paths, never content — any new index/log feature must not write document content outside the exe folder.
- **Run log** (since v0.3.23): 512KB rolling, three generations kept; the diagnostics bundle contains only system info + logs, **never document content**.
- **Needs human confirmation (R3)**: public releases / GitHub pushes · deleting version-history archives · changing the save encoding policy (always UTF-8 without BOM is established behaviour).
- **Forbidden**: bypassing the large-file defences (since v0.3.25 = frontend 2,000,000 characters + Rust 16MB + large-document deferred channel; benchmarks in output/md-editor-largefile-v0325/, do not loosen or tighten without new benchmarks) · hooking the undo step signal on Vditor options.input (proven not to work) · removing the BOM from AHK scripts.
- Several local versions are not pushed to GitHub — **review the commit sequence and sensitive data by hand before pushing**.

## 7. Current focus and to-dos

### Known test blind spots (lessons learned, read before changing tests)

| Blind spot | Countermeasure |
|---|---|
| CDP drops modifier + letter keys (z lost, s arrives) | verify real keyboard behaviour only at the AHK layer |
| Synthetic events intercepted by the Vditor element layer | the app exposes read-only __md* test hooks to bypass |
| isComposing left over after non-ASCII SendText | AHK always types English/digits + SetEng() |
| Long scripts with stale element references (#file-title lesson) | update fullcheck references with each version to avoid false negatives |
| The deployed exe's WebView2 does not dispatch dialog events to CDP (bare alert proven 2026-09-07) | dialog assertions use side effects (docs state / files on disk), never a dialog handler |
| AHK without BOM breaks non-ASCII assertions | save scripts as UTF-8 with BOM, run once after editing to rule out a false FAIL |

### Keyboard shortcut reference (check for conflicts when changing bindings)

`Ctrl+Z/Y/Shift+Z` undo/redo · `Ctrl+F/H` find/replace · `Ctrl+S` save · `Ctrl+P` print · `Ctrl+Shift+O` quick open · `Ctrl+Shift+F` search sibling files · `F8` focus mode · `Ctrl+wheel/0` zoom/reset · `Ctrl+Click/Shift+Click` tab multi-select. Before adding a shortcut, check Vditor's built-in hotkey table; on conflict, yield to Vditor or hook at the capture layer.

### Regression checks around editing-behaviour changes

| Change type | Before | After |
|---|---|---|
| Undo/redo/save chain | run group B for a baseline | B + fullcheck(A11) + AHK ^Z/^Y assertions |
| Keyboard interaction/shortcuts | record current bindings | matching group + AHK (CDP has blind spots for modifier + letter) |
| Vditor instantiation options | — | smoke 18 assertions (options changes have a wide impact) |
| Export chain | group C baseline | C + fullcheck(E) + open the output by hand and check the content |
| File IO (lib.rs) | cargo test | cargo test + E/H/I/J |

- **P0**: v0.3.23 run log + diagnostics bundle shipped — watch log rolling and diagnostics export stability in real use.
- **P1**: custom drive-wide index (replacing es.exe) first version shipped — improve how the 1-3 minute cold index build feels to users.
- **P1**: six undo/redo root causes closed (a4d258a) — keep group B + fullcheck(A11) green to prevent regressions.
- **To confirm**: whether package.json version 0.1.0 should be bumped with each release (the real version lives in tauri.conf.json / git).

### UI text rules

- The UI is English-only: all strings live in `UI_TEXT["en"]` in `main.ts` and in `i18n-en.ts` (Vditor tooltips); `index.html` holds English fallbacks for static labels.
- Run group J after changing UI text (tab/toolbar assertions match text).
- Never let full-width punctuation leak into code identifiers (historical trap: a whole script block died on a syntax error).

### Export formats and checks

| Format | Key acceptance points |
|---|---|
| PDF | vector, text selectable and searchable; page breaks never cut a table row |
| HTML | styled / plain variants; relative-path images embedded |
| PNG long image | very long documents split into several images, numbered consecutively |
| docx | native nested numbered lists, tables, footnotes, images truly embedded (not links) |

## 8. Rollback

- Roll back via the local git repository (tag/commit); local is ahead of the remote — rollbacks only touch local, push scope is decided separately.
