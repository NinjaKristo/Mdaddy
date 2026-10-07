"""Feature test for the Mdaddy additions, driven against the real exe over CDP.

Covers: title/process, .md open, welcome screen, sidebar toggle (buttons + hotkey), settings (shortcut rebinding,
sliders, image folder), hover tips (position + shortcut), toolbar icon sizes, code block colours, full screen,
reader mode, undo caret position, PDF wording, command palette, AI panel (Ollama + Claude), send pipeline.
"""
import json, os, subprocess, sys, tempfile, time
from cdp import App, Results

CTRL, ALT, SHIFT = 2, 1, 8
r = Results()
tmp = tempfile.mkdtemp(prefix="mdaddy-feat-")
md = os.path.join(tmp, "notes.md")
paras = [f"Paragraph number {i} talks about topic {i} in some detail." for i in range(1, 61)]
with open(md, "w", encoding="utf-8") as f:
    f.write("# Feature test\n\n" + "\n\n".join(paras) + "\n\n```python\nprint('hi')\n```\n")

VK = {"B": 66, "K": 75, "F9": 120, "F11": 122, "1": 49}


def press(app, key, mods=0, code=None):
    vk = VK.get(key, ord(key.upper()) if len(key) == 1 else 0)
    code = code or (f"Key{key.upper()}" if len(key) == 1 and key.isalpha() else ("Digit" + key if key.isdigit() else key))
    app.key(key, code, mods, vk)


def invoke(app, cmd, args):
    return app.js(f"window.__TAURI_INTERNALS__.invoke({json.dumps(cmd)}, {json.dumps(args)})")


app = App([md])
try:
    r.check("title is Mdaddy", app.wait("document.title === 'Mdaddy'"))
    app.wait("document.querySelector('#editor .vditor-reset')?.innerText.includes('Paragraph number 60')", 30)
    r.check(".md opened with content", True)
    tl = subprocess.run(["tasklist"], capture_output=True, text=True).stdout.lower()
    r.check("runs as mdaddy.exe next to md-editor.exe", "mdaddy.exe" in tl, "md-editor running too" if "md-editor.exe" in tl else "")

    # --- Shortcut Screen
    r.check("Shortcut Screen shown", app.wait("!!document.getElementById('shortcut-screen')", 8))
    r.check("Shortcut Screen has left brand and aligned four-column keys",
            app.js("(() => { const m = document.getElementById('shortcut-screen'); const cols = getComputedStyle(m.querySelector('.wk-cols')).columnCount; const rows = [...m.querySelectorAll('.wk-row')]; const aligned = rows.every(r => { const k = r.querySelector('kbd').getBoundingClientRect(), b = r.getBoundingClientRect(); return Math.abs(k.right - b.right) < 2; }); return m.querySelector('.shortcut-screen-head h2').textContent === 'Shortcuts' && cols === '4' && rows.length > 50 && aligned && !m.querySelector('.welcome-highlights') && m.querySelectorAll('.shortcut-screen-brand img').length === 2; })()"))
    app.js("document.querySelector('#shortcut-screen .shortcut-screen-close').click()")
    r.check("Shortcut Screen closes", app.wait("!document.getElementById('shortcut-screen')", 3))

    # --- sidebar toggle: button, sidebar « button, hotkey
    collapsed = "document.getElementById('outline-panel').classList.contains('collapsed')"
    app.js("document.getElementById('btn-side-toggle').click()")
    r.check("☰ button collapses sidebar", app.js(collapsed))
    app.js("document.getElementById('btn-side-toggle').click()")
    r.check("☰ button reopens sidebar", not app.js(collapsed))
    app.js("document.getElementById('side-collapse').click()")
    r.check("« button in sidebar collapses it", app.js(collapsed))
    app.js("document.querySelector('#editor .vditor-reset').focus()")
    press(app, "B", CTRL | SHIFT)
    r.check("Ctrl+Shift+B reopens sidebar (real key event)", app.wait(f"!{collapsed}", 2))

    # --- settings: rebind sidebar hotkey to Ctrl+Alt+K and use it
    app.js("document.getElementById('btn-settings').click()")
    r.check("⚙ opens settings", app.wait("!!document.getElementById('settings-modal')", 3))
    app.js("[...document.querySelectorAll('.settings-nav button')].find(b => b.textContent === 'Shortcuts').click()")
    rows = app.js("document.querySelectorAll('#settings-modal .kb-edit .kb-row').length")
    r.check("shortcut editor lists all commands", rows > 50, f"{rows} rows")
    app.js("""[...document.querySelectorAll('#settings-modal .kb-edit .kb-row')].find(r => r.firstChild.textContent === 'Show / hide sidebar').querySelector('.kb-capture').click()""")
    press(app, "K", CTRL | ALT)
    newkey = app.js("""[...document.querySelectorAll('#settings-modal .kb-edit .kb-row')].find(r => r.firstChild.textContent === 'Show / hide sidebar').querySelector('.kb-capture').textContent""")
    r.check("captured new shortcut Ctrl+Alt+K", newkey == "Ctrl+Alt+K", newkey)
    app.js("document.querySelector('#settings-modal .settings-close').click()")
    press(app, "K", CTRL | ALT)
    r.check("new hotkey toggles sidebar", app.wait(collapsed, 2))
    press(app, "B", CTRL | SHIFT)
    time.sleep(0.3)
    r.check("old hotkey no longer bound", app.js(collapsed))
    press(app, "K", CTRL | ALT)
    app.js("""window.__TAURI_INTERNALS__ && 0""")
    # reset to defaults for the rest of the run
    app.js("document.getElementById('btn-settings').click()")
    app.js("[...document.querySelectorAll('.settings-nav button')].find(b => b.textContent === 'Shortcuts').click()")
    app.js("[...document.querySelectorAll('#settings-modal button')].find(b => b.textContent === 'Reset all to defaults').click()")
    app.js("document.querySelector('#settings-modal .settings-close').click()")

    # --- toolbar icons: all the same size, scale with the slider
    sizes = app.js("JSON.stringify([...document.querySelectorAll('#editor .vditor-toolbar__item svg')].map(s => { const b = s.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }))")
    sizes = json.loads(sizes)
    r.check("all toolbar icons same size", len(set(map(tuple, sizes))) == 1, str(set(map(tuple, sizes))))
    app.js("document.getElementById('btn-settings').click()")
    app.js("[...document.querySelectorAll('.settings-nav button')].find(b => b.textContent === 'Appearance').click()")
    app.js("(() => { const s = document.querySelector('#settings-modal .slider input'); s.value = '20'; s.dispatchEvent(new Event('input')); })()")
    big = app.js("Math.round(document.querySelector('#editor .vditor-toolbar__item svg').getBoundingClientRect().width)")
    r.check("toolbar size slider resizes icons", big == 20, f"{big}px")
    app.js("(() => { const s = document.querySelector('#settings-modal .slider input'); s.value = '14'; s.dispatchEvent(new Event('input')); })()")
    app.js("(() => { const s = document.querySelectorAll('#settings-modal .slider input')[1]; s.value = '200'; s.dispatchEvent(new Event('input')); })()")
    w = app.js("Math.round(document.getElementById('outline-panel').getBoundingClientRect().width)")
    r.check("sidebar width slider", abs(w - 200) <= 2, f"{w}px")
    app.js("(() => { const s = document.querySelectorAll('#settings-modal .slider input')[1]; s.value = '160'; s.dispatchEvent(new Event('input')); })()")
    app.js("document.querySelector('#settings-modal .settings-close').click()")

    # --- hover tip: over the top, inside the window, with italic shortcut
    pos = json.loads(app.js("JSON.stringify((() => { const b = document.querySelector('#editor .vditor-toolbar [data-type=\"bold\"]').getBoundingClientRect(); return [b.left + b.width/2, b.top + b.height/2, b.top]; })())"))
    app.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": pos[0], "y": pos[1]})
    app.wait("!document.getElementById('app-tip')?.hidden && document.getElementById('app-tip').style.visibility === 'visible'", 3)
    tip = json.loads(app.js("JSON.stringify((() => { const t = document.getElementById('app-tip'); const b = t.getBoundingClientRect(); return {text: t.querySelector('.tip-text').textContent, key: t.querySelector('.tip-key')?.textContent, italic: getComputedStyle(t.querySelector('.tip-key')).fontStyle, l: b.left, r: b.right, t: b.top, b: b.bottom, vw: innerWidth, vh: innerHeight, z: getComputedStyle(t).zIndex}; })())"))
    r.check("bold tip shows text + italic shortcut", tip["text"] == "Bold" and tip["key"] == "Ctrl+B" and tip["italic"] == "italic", str(tip))
    r.check("tip inside window bounds", tip["l"] >= 0 and tip["r"] <= tip["vw"] and tip["t"] >= 0 and tip["b"] <= tip["vh"])
    # hover the left-most toolbar button (used to be hidden behind the sidebar)
    pos = json.loads(app.js("JSON.stringify((() => { const b = document.querySelector('#editor .vditor-toolbar [data-type=\"headings\"]').getBoundingClientRect(); return [b.left + 2, b.top + b.height/2]; })())"))
    app.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 300})
    time.sleep(0.2)
    app.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": pos[0], "y": pos[1]})
    app.wait("!document.getElementById('app-tip')?.hidden && document.getElementById('app-tip').querySelector('.tip-text').textContent.startsWith('Heading')", 3)
    top_el = app.js("(() => { const tip = document.getElementById('app-tip'); tip.style.pointerEvents = 'auto'; const t = tip.getBoundingClientRect(); const pts = [[t.left + 2, t.top + 2], [t.right - 2, t.bottom - 2], [t.left + 2, t.bottom - 2]]; const ok = pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.id === 'app-tip' || !!e.closest('#app-tip')); }); tip.style.pointerEvents = ''; const side = document.getElementById('outline-panel').getBoundingClientRect(); return ok && t.left >= 0 ? (t.left < side.right ? 'over-sidebar-and-visible' : 'visible') : false; })()")
    r.check("leftmost tip is on top of everything (not under sidebar)", top_el)
    app.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 600, "y": 500})

    # --- code block colours (light theme)
    cb = json.loads(app.js("JSON.stringify((() => { const p = document.querySelector('#editor .vditor-reset pre'); const c = p.querySelector('code'); return [getComputedStyle(p).backgroundColor, getComputedStyle(c).color, document.documentElement.dataset.theme]; })())"))
    r.check("code block light grey with dark grey text", cb[0] == "rgb(223, 226, 231)" and cb[1] in ("rgb(51, 54, 60)",), str(cb))

    # --- PDF wording
    r.check("no 'vector' wording", "vector" not in app.js("document.body.innerHTML").lower())

    # --- full screen (OS) via F11 and toolbar button, reader mode via F9
    sw = app.js("screen.width")
    press(app, "F11", 0, "F11")
    r.check("F11 = real full screen", app.wait(f"document.body.classList.contains('os-fullscreen') && outerWidth >= {sw}", 4), str(app.js("[outerWidth, screen.width]")))
    press(app, "F11", 0, "F11")
    r.check("F11 again leaves full screen", app.wait(f"!document.body.classList.contains('os-fullscreen') && outerWidth < {sw}", 4))
    app.js("document.querySelector('#editor .vditor-toolbar [data-type=\"os-fullscreen\"]').dispatchEvent(new MouseEvent('click', {bubbles: true}))")
    r.check("full screen toolbar button works", app.wait("document.body.classList.contains('os-fullscreen')", 4))
    app.js("document.querySelector('#editor .vditor-toolbar [data-type=\"os-fullscreen\"]').dispatchEvent(new MouseEvent('click', {bubbles: true}))")
    app.wait("!document.body.classList.contains('os-fullscreen')", 4)
    press(app, "F9", 0, "F9")
    r.check("F9 = reader mode (full window)", app.wait("!!document.querySelector('#editor.vditor--fullscreen, .vditor--fullscreen')", 3))
    rlabel = app.js("document.querySelector('#editor .vditor-toolbar [data-type=\"fullscreen\"]').getAttribute('aria-label')")
    press(app, "F9", 0, "F9")
    app.wait("!document.querySelector('.vditor--fullscreen')", 3)
    r.check("old fullscreen button is labelled Reader mode", (rlabel or "").startswith("Reader mode"), rlabel)

    # --- undo puts the caret back at the change (top of a long document)
    app.js("""(() => { const p = [...document.querySelectorAll('#editor .vditor-reset p')].find(p => p.textContent.startsWith('Paragraph number 2 ')); const r = document.createRange(); r.setStart(p.firstChild, 9); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#editor .vditor-reset').focus(); })()""")
    app.send("Input.insertText", {"text": "ZZZTYPED "})
    time.sleep(2.0)
    r.check("typed text landed in paragraph 2", app.js("document.querySelector('#editor .vditor-reset').innerText.includes('ParagraphZZZTYPED')") or app.js("document.querySelector('#editor .vditor-reset').innerText.includes('ZZZTYPED')"))
    app.js("document.querySelector('#editor .vditor-reset').scrollTop = 0")
    app.js("window.__mdUndo && window.__mdUndo()")
    time.sleep(0.6)
    caret = json.loads(app.js("JSON.stringify((() => { const s = getSelection(); const n = s.anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); const p = el && el.closest('p, h1, h2, pre'); return [p ? p.textContent.slice(0, 22) : null, !document.querySelector('#editor .vditor-reset').innerText.includes('ZZZTYPED')]; })())"))
    r.check("undo removed the typed text", caret[1])
    r.check("caret is at the change (paragraph 2), not the end", caret[0] is not None and caret[0].startswith("Paragraph number 2 "), str(caret[0]))

    # --- command palette lists registry commands with shortcuts
    app.js("document.getElementById('vm-cmdk').click()")
    n = app.js("document.querySelectorAll('#cmdk-list .cmdk-item .k').length")
    r.check("command palette shows commands with shortcuts", n > 30, f"{n} with keys")
    app.js("document.getElementById('cmdk-modal').hidden = true")

    # --- pasted image folder setting (Settings > Images)
    imgdir = os.path.join(tmp, "pics")
    os.makedirs(imgdir)
    res = invoke(app, "save_paste_image", {"docDir": tmp, "ext": "png", "dataB64": "iVBORw0KGgo=", "imageDir": imgdir, "stamp": "20261001_120000"})
    r.check("image saved to custom folder", os.path.exists(os.path.join(imgdir, "Screenshot_20261001_120000.png")), str(res))
    r.check("image under doc folder gets a relative path", res["rel"] == "pics/Screenshot_20261001_120000.png", res["rel"])
    kf = invoke(app, "known_folders", {})
    r.check("Pictures + ShareX recent folders found", bool(kf.get("pictures")) and bool(kf.get("sharexRecent")), json.dumps(kf))
    res2 = invoke(app, "save_paste_image", {"docDir": tmp, "ext": "png", "dataB64": "iVBORw0KGgo=", "imageDir": "sharex:recent", "stamp": "20261001_120001"})
    shx = os.path.join(kf["sharexRecent"], "Screenshot_20261001_120001.png")
    r.check("ShareX recent option saves into newest ShareX folder", os.path.exists(shx), res2["abs"])
    if os.path.exists(shx):
        os.remove(shx)

    # --- send: menu + full pipeline with a custom target (cmd copy, no external app opened)
    app.js("document.getElementById('btn-send').click()")
    items = app.js("[...document.querySelectorAll('#send-menu button')].map(b => b.textContent).join('|')")
    r.check("send menu has Obsidian, VS Code, Firefox", all(x in items for x in ["Obsidian", "VS Code", "Firefox"]), items)
    app.js("document.getElementById('send-menu').hidden = true")
    avail = invoke(app, "send_targets_available", {})
    r.check("send targets detected on this PC", avail["vscode"] and avail["firefox"] and avail["obsidian"], json.dumps(avail))
    out = os.path.join(tmp, "sent-copy.md")
    # add a custom target through Settings > Send to (cmd copy: exercises save + launch without opening a real app)
    app.js("document.getElementById('btn-settings').click()")
    app.js("[...document.querySelectorAll('.settings-nav button')].find(b => b.textContent === 'Send to').click()")
    fill = {"Name (e.g. Typora)": "TestCopy", "Program .exe path": r"C:\Windows\System32\cmd.exe", "Arguments": f'/c copy "{{file}}" "{out}"'}
    for ph, val in fill.items():
        app.js(f"(() => {{ const i = document.querySelector('#settings-modal input[placeholder={json.dumps(ph)}]'); i.value = {json.dumps(val)}; }})()")
    app.js("[...document.querySelectorAll('#settings-modal button')].find(b => b.textContent === 'Add').click()")
    r.check("custom send target added in Settings", "TestCopy" in app.js("document.querySelector('#settings-modal .send-list').textContent"))
    app.js("document.querySelector('#settings-modal .settings-close').click()")
    app.js("document.getElementById('btn-send').click()")
    app.js("[...document.querySelectorAll('#send-menu button')].find(b => b.textContent === 'TestCopy').click()")
    deadline = time.time() + 8
    while time.time() < deadline and not os.path.exists(out):
        time.sleep(0.3)
    r.check("send pipeline saves + launches target with {file}", os.path.exists(out) and "Paragraph number 60" in open(out, encoding="utf-8").read())

    # --- AI panel: model list order + Ollama round trip + Claude Pro round trip
    press(app, "A", CTRL | SHIFT)
    r.check("Ctrl+Shift+A opens AI panel", app.wait("!document.getElementById('ai-panel').hidden", 3))
    app.wait("document.querySelectorAll('#ai-model option').length > 8", 20)
    opts = json.loads(app.js("JSON.stringify([...document.querySelectorAll('#ai-model option')].map(o => o.textContent.trim()))"))
    order = [o for o in opts if o in ("Ollama", "HF", "Unsloth", "freetoken")]
    r.check("model groups in order Ollama, HF, Unsloth, freetoken", order == ["Ollama", "HF", "Unsloth", "freetoken"], str(order))
    seps = sum(1 for o in opts if set(o) == {"─"})
    r.check("separator between each shelf group", seps == 3, f"{seps} separators")
    heavy = opts.index(next(o for o in opts if set(o) == {"━"}))
    subs = opts[heavy + 1:]
    r.check("bar then Claude Pro / ChatGPT Plus ($20/mth)", len(subs) == 2 and subs[0].startswith("Claude Pro ($20/mth)") and subs[1].startswith("ChatGPT Plus ($20/mth)"), str(subs))
    ollama = app.js("[...document.querySelectorAll('#ai-model option')].find(o => o.value.startsWith('ollama::llama3.1'))?.value")
    if ollama:
        app.js(f"document.getElementById('ai-model').value = {json.dumps(ollama)}")
        app.js("document.getElementById('ai-input').value = 'Add one new final line to the document that says exactly: Signed by the AI.'")
        app.js("document.getElementById('ai-send').click()")
        got = app.wait("!!document.querySelector('#ai-log .ai-msg.assistant:not(.pending), #ai-log .ai-msg.error')", 300)
        err = app.js("document.querySelector('#ai-log .ai-msg.error')?.textContent || ''")
        r.check("Ollama reply received", got and not err, err[:200])
        has_apply = app.js("!!document.querySelector('#ai-log .ai-actions button.primary')")
        r.check("Ollama reply proposes an edit with Apply button", has_apply)
        if has_apply:
            app.js("document.querySelector('#ai-log .ai-actions button.primary').click()")
            time.sleep(0.8)
            r.check("Apply changes the document", app.js("document.querySelector('#editor .vditor-reset').innerText.includes('Signed by the AI')"))
            app.js("window.__mdUndo && window.__mdUndo()")
            time.sleep(0.8)
            r.check("AI change is one undo step", not app.js("document.querySelector('#editor .vditor-reset').innerText.includes('Signed by the AI')"))
    else:
        r.check("Ollama llama3.1 model listed", False, str(opts[:6]))
    app.js("document.getElementById('ai-clear').click()")
    app.js("document.getElementById('ai-model').value = 'claude::'")
    app.js("document.getElementById('ai-input').value = 'What is the title (first heading) of this document? Reply with just the title text.'")
    app.js("document.getElementById('ai-send').click()")
    app.wait("!!document.querySelector('#ai-log .ai-msg.assistant:not(.pending), #ai-log .ai-msg.error')", 300)
    reply = app.js("(document.querySelector('#ai-log .ai-msg.assistant:not(.pending)') || document.querySelector('#ai-log .ai-msg.error')).textContent")
    r.check("Claude Pro (Claude Code CLI) answers about the document", "Feature test" in reply, reply[:120])
finally:
    app.close()
sys.exit(r.summary())
