"""Minimal CDP harness for the built Mdaddy exe.

Launches the real exe with WebView2 remote debugging, attaches over a raw CDP websocket
(suppress_origin=True; never playwright connect_over_cdp, see CLAUDE.md) and evaluates JS in the page.
"""
import json, os, shutil, subprocess, tempfile, time, urllib.request
import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXE = os.path.join(ROOT, "release", "Mdaddy.exe")


def ensure_no_running_instance():
    """The single-instance plugin forwards launches to an open window, which has no test CDP port."""
    if os.name != "nt":
        return
    result = subprocess.run(["tasklist", "/FI", "IMAGENAME eq mdaddy.exe", "/NH"], capture_output=True, text=True)
    if "mdaddy.exe" in result.stdout.lower():
        raise RuntimeError("Close the running Mdaddy window before release E2E tests; the tests must launch the newly built executable.")


class App:
    def __init__(self, args=(), port=9333, exe=EXE, env_extra=None):
        ensure_no_running_instance()
        env = dict(os.environ)
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={port}"
        if env_extra:
            env.update(env_extra)
        # run an isolated portable copy (Data/ next to the exe) so tests never touch the real profile/session
        self.sandbox = tempfile.mkdtemp(prefix="mdaddy-run-")
        os.makedirs(os.path.join(self.sandbox, "Data"))
        run_exe = os.path.join(self.sandbox, "mdaddy.exe")
        shutil.copy2(exe, run_exe)
        self.proc = subprocess.Popen([run_exe, *args], env=env)
        self.port = port
        self.ws = None
        self._id = 0
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2))
                page = next(p for p in pages if p.get("type") == "page")
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True, timeout=60)
                break
            except Exception:
                time.sleep(0.5)
        if not self.ws:
            self.close()
            raise RuntimeError("could not attach to the Mdaddy WebView (did the process exit?)")

    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                return msg

    def js(self, expr, await_promise=True):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": await_promise})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            raise RuntimeError(res["exceptionDetails"].get("exception", {}).get("description") or str(res["exceptionDetails"]))
        return res.get("result", {}).get("value")

    def wait(self, expr, timeout=20, interval=0.25):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = self.js(expr)
                if last:
                    return last
            except Exception as e:  # page still loading
                last = e
            time.sleep(interval)
        raise TimeoutError(f"timed out waiting for: {expr} (last={last!r})")

    def key(self, key, code=None, modifiers=0, vk=0):
        for t in ("rawKeyDown", "keyUp"):
            self.send("Input.dispatchKeyEvent", {"type": t, "key": key, "code": code or key,
                                                 "modifiers": modifiers, "windowsVirtualKeyCode": vk})

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        finally:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)], capture_output=True)
            self.proc.wait(10)
            time.sleep(0.5)
            shutil.rmtree(self.sandbox, ignore_errors=True)


class Results:
    def __init__(self):
        self.rows = []

    def check(self, name, ok, detail=""):
        self.rows.append((name, bool(ok), detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")

    def summary(self):
        fails = [r for r in self.rows if not r[1]]
        print(f"\n{len(self.rows) - len(fails)}/{len(self.rows)} passed")
        return 0 if not fails else 1
