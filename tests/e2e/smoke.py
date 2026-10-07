"""Smoke test: the exe starts next to a running md-editor, opens a .md, shows the editor and toolbar."""
import os, subprocess, sys, tempfile, time
from cdp import App, Results

r = Results()
tmp = tempfile.mkdtemp(prefix="mdaddy-smoke-")
md = os.path.join(tmp, "hello.md")
with open(md, "w", encoding="utf-8") as f:
    f.write("# Hello Mdaddy\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")

app = App([md])
try:
    r.check("window title is Mdaddy", app.wait("document.title === 'Mdaddy'"), app.js("document.title"))
    r.check("editor initialised (lute loaded)", app.wait("!!document.querySelector('#editor .vditor-reset')"))
    r.check("format toolbar present", app.wait("document.querySelectorAll('#toolbar .vditor-toolbar [data-type]').length > 10"),
            str(app.js("document.querySelectorAll('#toolbar .vditor-toolbar [data-type]').length")))
    r.check(".md content loaded", app.wait("document.querySelector('#editor .vditor-reset').innerText.includes('Hello Mdaddy')"))
    r.check("table rendered", app.wait("!!document.querySelector('#editor .vditor-reset table')"))
    r.check("tab shows file name", app.wait("[...document.querySelectorAll('.tab')].some(t => t.textContent.includes('hello.md'))"))
    tl = subprocess.run(["tasklist"], capture_output=True, text=True).stdout.lower()
    r.check("process is mdaddy.exe", "mdaddy.exe" in tl)
finally:
    app.close()
sys.exit(r.summary())
