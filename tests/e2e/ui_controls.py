"""Regression test for controls whose boot bindings can silently disappear."""
import sys
sys.path.insert(0, __import__("os").path.dirname(__file__))
from cdp import App, Results

r = Results()
app = App(port=9452)
try:
    r.check("editor mounted", app.wait("!!document.querySelector('#editor .vditor-reset')"))
    r.check("shortcut screen restored", app.wait("!!document.getElementById('shortcut-screen')", 8))
    r.check("Shortcut Screen uses a compact left brand and the keyboard list", app.js("(() => { const m=document.getElementById('shortcut-screen'); return m.querySelector('.shortcut-screen-head h2').textContent === 'Shortcuts' && m.querySelectorAll('.wk-row').length > 50 && !m.querySelector('.welcome-highlights') && m.querySelector('.settings-brand-wordmark').getBoundingClientRect().width < 100; })()"))
    app.js("document.querySelector('#shortcut-screen .settings-brand-mark').click()")
    r.check("Shortcut Screen mark collapses sidebar", app.js("document.getElementById('outline-panel').classList.contains('collapsed')"))
    app.js("document.querySelector('#shortcut-screen .settings-brand-mark').click()")
    app.js("document.querySelector('#shortcut-screen .settings-brand-menu').click()")
    r.check("Shortcut Screen chevron opens the brand menu", app.js("!document.getElementById('brand-menu').hidden"))
    app.js("document.getElementById('btn-brand-menu').click()")
    app.js("document.querySelector('#shortcut-screen .shortcut-screen-close').click()")

    app.js("document.getElementById('side-tab-outline').click()")
    r.check("Outline tab opens", app.js("!document.getElementById('side-pane-outline').hidden && document.getElementById('side-tab-outline').classList.contains('active')"))
    r.check("Outline contains the current heading", app.js("document.querySelectorAll('#outline .outline-item').length > 0"))

    app.js("document.getElementById('btn-brand-logo').click()")
    r.check("logo mark collapses sidebar", app.js("document.getElementById('outline-panel').classList.contains('collapsed')"))
    app.js("document.getElementById('btn-brand-logo').click()")
    r.check("logo mark expands sidebar", app.js("!document.getElementById('outline-panel').classList.contains('collapsed')"))
    app.js("document.getElementById('btn-brand-menu').click()")
    r.check("chevron opens the brand menu", app.js("!document.getElementById('brand-menu').hidden"))
    r.check("brand menu contains only the four specified icon entries", app.js("(() => { const b=[...document.querySelectorAll('#brand-menu > button')]; return b.length === 4 && b.every(x => !!x.querySelector('img')); })()"))
    app.js("document.getElementById('btn-brand-menu').click()")
    r.check("main-app brand is compact and left-aligned", app.js("(() => { const mark=document.getElementById('btn-brand-logo').getBoundingClientRect(), word=document.getElementById('brand-wordmark').getBoundingClientRect(), menu=document.getElementById('btn-brand-menu').getBoundingClientRect(); return mark.left <= 6 && menu.right < 180; })()"))
    r.check("format toolbar is centered over the editor", app.js("(() => { const r=document.querySelector('#editor .vditor-toolbar').getBoundingClientRect(), e=document.getElementById('editor').getBoundingClientRect(); return Math.abs((r.left+r.right)/2-(e.left+e.right)/2) < 20; })()"))

    app.js("document.getElementById('btn-toolbar-find').click()")
    r.check("magnifier opens Find", app.js("!document.getElementById('find-bar').hidden"))
    app.js("document.getElementById('btn-toolbar-find').click()")
    r.check("magnifier closes Find", app.js("document.getElementById('find-bar').hidden"))

    app.js("document.getElementById('text-color-button').click()")
    r.check("text-color button opens palette", app.js("!document.getElementById('text-color-menu').hidden"))
    app.js("""(() => { const root=document.querySelector('#editor .vditor-reset'); const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let n; while(n=w.nextNode()) if(n.nodeValue.includes('Double-click')) { const range=document.createRange(); range.setStart(n,0); range.setEnd(n,6); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(range); return true; } return false; })()""")
    app.js("document.getElementById('text-color-button').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse'})); document.getElementById('text-color-button').click(); document.querySelector('#text-color-menu [data-color=\"#b42318\"]').click()")
    r.check("text-color applies the selected color", app.js("[...document.querySelectorAll('#editor .vditor-reset span[style]')].some(s => s.textContent === 'Double' && s.style.color === 'rgb(180, 35, 24)')"))

    app.js("document.getElementById('btn-reader-toggle').click()")
    r.check("Reader Mode enters full editor", app.wait("!!document.querySelector('.vditor--fullscreen')", 4))
    app.js("document.getElementById('btn-reader-toggle').click()")
    r.check("Reader Mode returns to editing", app.wait("!document.querySelector('.vditor--fullscreen')", 4))

    app.js("document.getElementById('btn-brand-menu').click(); document.getElementById('brand-settings').click()")
    r.check("Settings opens the shortcut screen section", app.wait("!!document.querySelector('#settings-modal .shortcuts-filter')", 4))
    r.check("Settings header keeps the brand at the left", app.js("!!document.querySelector('#settings-modal .settings-brand-mark') && !!document.querySelector('#settings-modal .settings-brand-wordmark')"))
    app.js("document.querySelector('#settings-modal .settings-brand-mark').click()")
    r.check("settings logo mark collapses sidebar", app.js("document.getElementById('outline-panel').classList.contains('collapsed')"))
    app.js("document.querySelector('#settings-modal .settings-brand-mark').click()")
    r.check("settings logo mark expands sidebar", app.js("!document.getElementById('outline-panel').classList.contains('collapsed')"))
    app.js("document.querySelector('#settings-modal .settings-brand-menu').click()")
    r.check("settings chevron opens the same menu", app.js("!document.getElementById('brand-menu').hidden"))
    app.js("document.getElementById('btn-brand-menu').click()")
    r.check("shortcut startup option is in Shortcuts settings", app.js("document.querySelector('#settings-modal').innerText.includes('Show shortcut screen when Mdaddy starts')"))
    r.check("General settings section is absent", app.js("![...document.querySelectorAll('#settings-modal .settings-nav button')].some(b => b.textContent.trim() === 'General')"))
finally:
    app.close()

sys.exit(r.summary())
