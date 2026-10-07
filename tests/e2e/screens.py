"""Capture screenshots of the main UI states for visual review."""
import base64, os, sys, tempfile, time
from cdp import App

out = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="mdaddy-shots-")
os.makedirs(out, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="mdaddy-shot-")
md = os.path.join(tmp, "Trip plan.md")
with open(md, "w", encoding="utf-8") as f:
    f.write("""# Weekend trip plan

A short plan for the weekend. **Bold**, *italic* and `inline code` all work.

## Packing list

- [x] Tent
- [ ] Sleeping bags
- [ ] Snacks

## Budget

| Item | Cost | Notes |
|:-----|-----:|-------|
| Gas | 60 | round trip |
| Camp site | 35 | one night |
| Food | 80 | groceries |

## Script

```python
total = 60 + 35 + 80
print(f"Total: {total}")
```

> Remember to check the weather on Friday.
""")


def shot(app, name):
    time.sleep(0.6)
    data = app.send("Page.captureScreenshot", {"format": "png"})["result"]["data"]
    p = os.path.join(out, name)
    open(p, "wb").write(base64.b64decode(data))
    print(p)


app = App([md])
try:
    app.wait("document.querySelector('#editor .vditor-reset')?.innerText.includes('Weekend trip plan')", 30)
    app.js("document.getElementById('shortcut-screen')")
    shot(app, "1-shortcuts.png")
    app.js("document.getElementById('shortcut-screen')?.remove()")
    app.js("[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('Trip plan'))?.click()")
    app.js("document.querySelector('#side-tab-outline').click()")
    shot(app, "2-main.png")
    b = app.js("JSON.stringify((() => { const r = document.querySelector('#toolbar .vditor-toolbar [data-type=\"bold\"]').getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })())")
    import json
    x, y = json.loads(b)
    app.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    time.sleep(0.8)
    shot(app, "3-tooltip.png")
    app.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 700, "y": 500})
    app.js("document.getElementById('btn-settings').click()")
    app.js("[...document.querySelectorAll('.settings-nav button')].find(b => b.textContent === 'Shortcuts').click()")
    shot(app, "4-settings-shortcuts.png")
    app.js("[...document.querySelectorAll('.settings-nav button')].find(b => b.textContent === 'Images').click()")
    shot(app, "5-settings-images.png")
    app.js("document.querySelector('#settings-modal .settings-close').click()")
    app.js("document.getElementById('btn-ai').click()")
    app.wait("document.querySelectorAll('#ai-model option').length > 8", 20)
    shot(app, "6-ai.png")
    app.js("document.getElementById('btn-send').click()")
    shot(app, "7-send.png")
finally:
    app.close()
