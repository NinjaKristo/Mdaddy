# MD Editor test plan (since v0.3.21)

> Goal: new features get a smoke run first, then regression; real user behaviour is simulated with AHK (OS-level keyboard/mouse), feature assertions are hard checks via CDP / the file system.
> This is the single entry point: before changing any feature, read the "module → group map", then run the matching groups + the smoke set.

## 1. Five-layer system

| Layer | Content | When | Time |
|---|---|---|---|
| L0 | `cd src-tauri && cargo test` (49 cases) | every Rust change | ~10s |
| L1 | Smoke set: `e2e_user_J_v0321.py` + `ahk_smoke_v1.ahk` | every delivery/deploy | ~3min |
| L2 | Targeted regression: run affected groups per the "module → group map" | when a mapped module changes | ~1min per group |
| L3 | Full: B/C/D/E/F/G/H/I/J + `e2e_fullcheck_v037.py` | before release | ~15min |
| L4 | AHK real keyboard/mouse: `ahk_smoke_v1.ahk` (6 assertions) | before release (desktop must be online) | ~2min |

## 2. Module → group map

| Changed module | Must run |
|---|---|
| Undo/save/autosave (main.ts snap*/saveDoc/autosaveDirty) | B, fullcheck(A11), AHK |
| Tabs (renderTabs/multi-select/overflow) | B, J |
| File tree / ES search / locate (makeTreeNode/runEsSearch/esLocateTree) | E, H, I, J |
| Themes/styles (styles.css/applyTheme) | D, J |
| Export/print | fullcheck(E), C |
| Portable mode (lib.rs portable_dir/data_root/settings · main.ts pref layer · v0.5.0) | cargo test + group P |
| lib.rs (Rust commands) | cargo test + related groups |

Group P script: `output/md-editor-portable-v050/e2e_portable_v050.py` (P1 three startup locations / P2 language → settings.json / P3 restart persistence / P4 installed-version regression / P5 zip structure; **point TEMP/TMP back to drive C when running** — confirmed by group J on 2026-09-21: with TEMP on drive F, tree expansion list_md_dir got caught by the F-drive IO hang and falsely hung).

2026-09-21 J script drift fixed (17/18): #theme-select (v0.3.x UI) → click #sb-theme + #theme-menu buttons; J10/J10b assertions updated to the current design (light H1 = ink #16181d, graded colours in the eye-care theme #1a5e8a). **Since v0.5.1 session semantics changed: launching with an argument = restore session + append the argument file** (previously = open only the argument file) — J0 setup must back up and delete %APPDATA%\com.github.frandy820.md-editor\ui-state.json (restore afterwards), otherwise the leftover session pollutes the four-tab assertion. J2a (tree highlight) still drifts, to be investigated.

v0.5.1 targeted scripts (output/md-editor-portable-v050/): verify_v051_session_startup.py (S1-S5 session semantics + T1 startup time); verify_v051_ahk.py + ahk_v051_extmod.ahk (A1/A2 real clicks on the external-change yes/no dialog + A3 typing + ^s, **AHK window matching must use the `ahk_class #32770` prefix — a bare "#32770" is a title match and always MISSES**); e2e_user_flow_v051.py (8 user-flow scenarios against the v0.5.1 zip).

## 3. Smoke set commands

```bash
cd output/md-editor-typora-scan
python e2e_user_J_v0321.py          # 18 assertions (v0.3.21 full feature set)
"/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe" ahk_smoke_v1.ahk   # desktop must be online
```

## 4. AHK script notes (ahk_smoke_v1.ahk)

- 6 assertions: type + ^S / ^Z one-step undo / ^Y redo / autosave on blur / double-click tab bar new + Save As dialog / clean exit.
- Assertions use real side effects (file content / Save As dialog / process alive), no page JS injection. All 6 PASS on 2026-08-30.
- **Script encoding must be UTF-8 with BOM** (AHK v2 reads BOM-less files as ANSI, so non-ASCII assertion literals break = false FAIL).
- **Always type digits only** (e.g. 1357924680): a pinyin IME composes letter sequences into other characters, digits pass straight through.
- **Prerequisite: the RDP input channel is online** — session "running" ≠ channel connected (flaky in practice): zero characters typed + file at pure baseline = channel down; wait until the user desktop is truly active; when down, SendInput/SendEvent/keybd_event all fail.
- **Enter the Save As dialog path by clipboard paste** (`A_Clipboard := path; Send "^v"`): typing the path with Send gets swallowed by the IME/focus layer.
- Blur with `WinActivate ahk_class Progman` (clicking fixed desktop coordinates opens the Start menu over the window); window position/size drift each run (the app remembers its last window), so coordinate assertions only use client-relative maths.
- Diagnostic hooks (in page): `window.__zTrace` (z/y keydown guard state), `window.__sLog` (value + stack depth on every save), `window.__mdDocs` (docs, read-only), `window.__mdUndo/__mdRedo`.

## 5. Rules for new features

1. Add assertions for a new feature to the latest group (currently J) or open a new group K/L…; assertions must be hard checks (file content / DOM geometry / process state), never just "element exists".
2. Features that change keyboard interaction must pass AHK (CDP has blind spots for modifier + letter keys: z is lost, s gets through; synthetic KeyboardEvents are intercepted by the Vditor element layer).
3. Test hooks: `window.__mdUndo/__mdRedo/__mdDocs` (read-only), for e2e only, never written into user documents.
4. Deploy chain: `npm run build` → `cd src-tauri && cargo build --release --bins --features tauri/custom-protocol` → copy to F:\software (md5 compare).
5. **Element references in long scripts like fullcheck must follow version changes** (lesson: #file-title was removed in v0.3.16, the script did not follow, D4a gave false negatives for two versions).

## 6. Seven test blind spots and countermeasures (lessons learned)

| Blind spot | Countermeasure |
|---|---|
| CDP drops modifier + letter keys | verify real keyboard behaviour only at the AHK layer |
| Synthetic events intercepted by the element layer | the app exposes __md* test hooks to bypass |
| isComposing left over after non-ASCII SendText | AHK always types English + SetEng() |
| Window title does not follow document.title | assert with ahk_exe / class name, not the title |
| mkdtemp does not clean itself | rmtree leftovers at script start |
| localStorage persistence pollutes the baseline | clear explicitly before asserting |
| e2e false green (skip/timeout counts as pass) | read the tail summary, drive every FAIL to zero |
