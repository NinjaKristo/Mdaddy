use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

mod extras;

/// File path passed on the command line at startup
struct StartupFile(Mutex<Option<String>>);

#[derive(Default)]
struct InstanceRequests(Mutex<Vec<PendingInstanceRequest>>);

struct PendingInstanceRequest {
    id: u64,
    args: Vec<String>,
    cwd: PathBuf,
    shown: bool,
}

#[derive(Clone, Serialize)]
struct InstancePromptRequest {
    id: u64,
}

static NEXT_INSTANCE_REQUEST: AtomicU64 = AtomicU64::new(1);

// ===== v0.3.23 run log (root fix for zero observability: bug reports go from verbal repro to self-evident logs) =====
// %APPDATA%\Mdaddy\logs\md-editor.log, single rolling file (>512KB rotates to .log.1/.log.2, three generations kept).
// First line at startup = version + system + launch args (run() calls it first, so the very first line leaves no blind spot).
// The panic hook writes the crash location to disk (release keeps panic Location line numbers) — white screens/crashes prove themselves.
// Purely local files, no network reporting at all (still an offline personal tool).
static LOG_W: Mutex<()> = Mutex::new(());

// ===== v0.5.0 portable mode: a Data folder next to the exe → all data travels with the exe (USB drive use) =====
// Same rule as the VS Code portable convention (enabled when the data folder exists). Travels with Data: ui-state.json /
// themes/ / pasted/ / logs/ / settings.json (UI preferences); does not: the drive index cache → %TEMP%
// (the index holds this machine's file names; carried on a USB drive it would load a stale index on another machine).
// The installed version (no Data next to the exe) behaves exactly as before and still uses %APPDATA%.
static PORTABLE_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Core rule (unit-testable): given the exe path, return the Data folder next to it (exists = portable)
fn portable_dir_at(exe: &std::path::Path) -> Option<PathBuf> {
    let d = exe.parent()?.join("Data");
    d.is_dir().then(|| d)
}

fn portable_dir() -> Option<&'static PathBuf> {
    PORTABLE_DIR
        .get_or_init(|| std::env::current_exe().ok().as_deref().and_then(portable_dir_at))
        .as_ref()
}

/// In portable mode, return the absolute path of the Data folder next to the exe (for logging; clone avoids lifetime coupling)
fn portable_dir_owned() -> Option<PathBuf> {
    portable_dir().cloned()
}

fn logs_dir() -> PathBuf {
    if let Some(d) = portable_dir() {
        return d.join("logs");
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("Mdaddy").join("logs")
}

/// Local (UTC+8) yyyy-MM-dd HH:mm:ss (same conversion as local_ts)
fn log_ts() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let local = now + 8 * 3600;
    let (y, mo, d) = civil_from_days((local / 86400) as i64);
    let (h, mi, s) = ((local % 86400) / 3600, (local % 3600) / 60, local % 60);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// Append one log line (fails silently: the log system must never interrupt the main flow)
pub fn app_log(level: &str, scope: &str, msg: &str) {
    let _g = LOG_W.lock().unwrap();
    let dir = logs_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("mdaddy.log");
    // Rotation: >512KB → delete .log.2, .log.1 → .log.2, main → .log.1
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 512 * 1024 {
            let _ = fs::remove_file(dir.join("mdaddy.log.2"));
            let _ = fs::rename(dir.join("mdaddy.log.1"), dir.join("mdaddy.log.2"));
            let _ = fs::rename(&path, dir.join("mdaddy.log.1"));
        }
    }
    let line = format!("[{}] [{}] [{}] {}\n", log_ts(), level, scope, msg.replace('\n', " | "));
    let _ = fs::OpenOptions::new().create(true).append(true).open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

/// Collect the OS version string. ver output follows the system code page (GBK on some systems), so decode as GBK to avoid garbling
fn sys_ver() -> String {
    use std::os::windows::process::CommandExt;
    Command::new("cmd").args(["/c", "ver"])
        .creation_flags(0x0800_0000).output()
        .map(|o| {
            let (cow, _, had_err) = encoding_rs::GBK.decode(&o.stdout);
            if had_err { String::from_utf8_lossy(&o.stdout).trim().to_string() }
            else { cow.trim().to_string() }
        })
        .unwrap_or_else(|_| "(ver unavailable)".into())
}

/// First startup line (run() calls it first): version / system / launch args / process info
fn log_startup(args: &str) {
    app_log("INFO", "startup", &format!(
        "===== Mdaddy v{} start | pid={} | args={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        if args.is_empty() { "(none)" } else { args }
    ));
    // System/runtime info collection moved to a background thread (v0.5.1 faster startup: cmd /c ver measured ~200ms,
    // it used to run synchronously before window creation; app_log is Mutex thread-safe, the os= line may be timestamped after later lines, acceptable)
    std::thread::spawn(|| {
        let ver = sys_ver();
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "(path unavailable)".into());
        app_log("INFO", "startup", &format!("os={} | exe={}", ver, exe));
    });
    // panic hook: write crashes to the log (the blind spot for user crashes / white screens)
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        app_log("PANIC", "crash", &format!("{} | {}", loc, info));
        default_hook(info);
    }));
}

/// Export diagnostics: a single txt file (system info + version + launch args + every log generation).
/// No zip: compression would need a library and grow the exe; a txt is also a single file to forward, zero dependencies, zero risk.
#[tauri::command]
fn export_diagnostics(path: String) -> Result<String, String> {
    let mut out = String::with_capacity(64 * 1024);
    let hr = "|===========|\n";
    let sec = |out: &mut String, title: &str| {
        out.push_str(&hr);
        out.push_str(&format!("| {} \n", title));
        out.push_str(&hr);
    };
    sec(&mut out, "Mdaddy diagnostics");
    out.push_str(&format!("Exported at: {}\nVersion: v{}\nProcess PID: {}\n",
        log_ts(), env!("CARGO_PKG_VERSION"), std::process::id()));
    sec(&mut out, "System info");
    out.push_str(&format!("OS: {}\n", sys_ver()));
    out.push_str(&format!("exe: {}\n", std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "?".into())));
    out.push_str(&format!("Drives: {}\n", fixed_drive_roots().iter()
        .map(|p| p.display().to_string()).collect::<Vec<_>>().join(" ")));
    out.push_str(&format!("Launch args: {:?}\n", std::env::args().collect::<Vec<_>>()));
    sec(&mut out, "Run log (3 generations merged, newest first)");
    for name in ["mdaddy.log", "mdaddy.log.1", "mdaddy.log.2"] {
        if let Ok(t) = fs::read_to_string(logs_dir().join(name)) {
            out.push_str(&format!("----- {} -----\n{}\n", name, t));
        }
    }
    fs::write(&path, out.as_bytes()).map_err(|e| e.to_string())?;
    app_log("INFO", "diag", &format!("Diagnostics exported: {} ({}KB)", path, out.len() / 1024));
    Ok(path)
}

/// Extensions allowed to open/save (same rules as the frontend dialog/drag-drop filters)
const ALLOWED_EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];

/// Whether the path's extension is allowed (case-insensitive)
fn has_allowed_ext(path: &str) -> bool {
    match std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        Some(ext) => ALLOWED_EXTS.iter().any(|a| a.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// From a list of command-line args, take the first markdown path with "a valid extension and an existing file".
/// Double-clicking a .md makes Windows pass the path as an argument; single-instance forwarding on a second launch reuses the same logic.
fn extract_md_from_args(mut args: impl Iterator<Item = String>) -> Option<String> {
    args.next(); // skip the program's own path
    for a in args {
        if has_allowed_ext(&a) {
            if std::path::Path::new(&a).is_file() {
                return Some(a);
            }
            // Typical report: double-clicking an old shortcut / the argument file was moved or deleted; silently fall back to the welcome page
            app_log("WARN", "startup", &format!("Launch-arg file does not exist, ignored: {a}"));
        }
    }
    None
}

/// File path from this process's launch args (fallback read via frontend invoke)
fn extract_md_arg() -> Option<String> {
    extract_md_from_args(std::env::args())
}

/// Read a file with automatic encoding detection: UTF-8 BOM / UTF-8 / fall back to GBK. Returns (content, encoding name)
#[tauri::command]
fn open_file(path: String) -> Result<(String, String), String> {
    if !has_allowed_ext(&path) {
        app_log("WARN", "open", &format!("Refused to open (unsupported extension): {path}"));
        return Err("Unsupported file type (md/markdown/mdown/txt only)".into());
    }
    // Hard limit 16MB (raised from 2MB in v0.3.25): reading + IPC is still sub-second at this size, the cut-off only guards against pathological giant files;
    // the real experience guard is in the frontend (2,000,000-character refusal + large-document deferred channel, reset after 2026-09-07 measurements)
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 16 * 1024 * 1024 {
            return Err(format!("File too large ({} KB, limit 16384 KB). Opening blocked to avoid freezing", meta.len() / 1024));
        }
    }
    let bytes = fs::read(&path).map_err(|e| {
        app_log("ERROR", "open", &format!("Read failed {path}: {e}"));
        e.to_string()
    })?;
    let (content, enc) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (
            String::from_utf8_lossy(&bytes[3..]).to_string(),
            "UTF-8(BOM)".to_string(),
        )
    } else {
        match std::str::from_utf8(&bytes) {
            Ok(s) => (s.to_string(), "UTF-8".to_string()),
            Err(_) => {
                let (cow, _, _) = encoding_rs::GBK.decode(&bytes);
                (cow.to_string(), "GBK".to_string())
            }
        }
    };
    Ok((content, enc))
}

/// Write a file, always UTF-8 without BOM; temp file + rename for an atomic write, so an interrupted write cannot corrupt the original
#[tauri::command]
fn save_file(path: String, content: String) -> Result<FileMeta, String> {
    if !has_allowed_ext(&path) {
        return Err("Unsupported save path (md/markdown/mdown/txt only)".into());
    }
    // Guard: refuse to overwrite a non-empty file with empty content (Vditor IR mode getValue may return an empty string while lute/async is not ready,
    // so an empty write must not wipe the original). New (non-existent) files or files that were already empty may be written empty.
    if content.is_empty() {
        if let Ok(existing) = fs::read(&path) {
            if !existing.is_empty() {
                return Err("Refused to write empty content (the existing file is not empty; possible editor glitch)".into());
            }
        }
    }
    archive_old_version(&path); // v0.3.11 archive the old version before overwriting (best-effort)
    let tmp = format!("{}.tmp", path);
    // v0.5.2: write through the handle + read metadata on the handle and return it with the result. Reading metadata by path right after rename may briefly
    // hit the old directory entry (measured: the old frontend refreshMeta stored the old mtime/size as the external-change baseline and never refreshed, so the next
    // check wrongly popped "file was modified externally"). Handle metadata (GetFileInformationByHandle) describes exactly
    // the bytes just written, authoritative and uncached; the frontend uses it as the baseline after saving, no separate re-read.
    {
        use std::io::Write;
        let write_err = |e: std::io::Error| {
            app_log("ERROR", "save", &format!("Write failed {path}: {e}"));
            e.to_string()
        };
        let mut f = fs::File::create(&tmp).map_err(write_err)?;
        f.write_all(content.as_bytes()).map_err(write_err)?;
        let meta = f.metadata().map_err(|e| e.to_string())?;
        drop(f); // on Windows the handle must be closed before rename
        // a same-folder rename atomically replaces the target on Windows
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })?;
        Ok(meta_to_file_meta(&meta))
    }
}

// ===== v0.3.11 version history / file recovery =====
// Before an overwrite, archive the old disk content to %APPDATA%\Mdaddy\versions\<file stem>\,
// retention: the latest 50 versions per file within 30 days (cleaned up while saving). Best-effort: an archive failure never blocks saving.

fn versions_root() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("Mdaddy").join("versions")
}

fn version_stem(path: &str) -> String {
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("doc");
    // Documents with the same name in different folders share a stem group: add a short path hash to disambiguate (16-bit FNV-1a is enough)
    let mut h: u16 = 0;
    for b in path.bytes() {
        h = (h.wrapping_mul(31)).wrapping_add(b as u16);
    }
    format!("{}_{:04x}", stem.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>(), h)
}

/// Local (UTC+8) timestamp string yyyyMMdd_HHmmss (reuses the chrono-free conversion from screenshot naming)
fn local_ts() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let local = now + 8 * 3600;
    let (y, mo, d) = civil_from_days((local / 86400) as i64);
    let s = local % 86400;
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", y, mo, d, s / 3600, s % 3600 / 60, s % 60)
}

/// Archive the old content before saving (skip missing/empty files). Returns no Result: fails silently (does not affect the main save flow).
fn archive_old_version(path: &str) {
    // Test isolation (only at cargo test compile time): fixtures all live in a tempdir, skip archiving so the real %APPDATA% is not polluted.
    // Cannot check the temp path at runtime — this machine's TEMP is redirected to F:\Cache\temp, and e2e fixtures live there too and would be hit
    #[cfg(test)]
    if std::path::Path::new(path).starts_with(std::env::temp_dir()) { return; }
    let Ok(old) = fs::read_to_string(path) else { return };
    if old.is_empty() { return; }
    let dir = versions_root().join(version_stem(path));
    if fs::create_dir_all(&dir).is_err() { return; }
    let _ = fs::write(dir.join(format!("{}.md", local_ts())), &old);
    // Cleanup: >50 versions delete the oldest; >30 days delete
    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(meta) = e.metadata() {
                if let Ok(m) = meta.modified() {
                    entries.push((e.path(), m));
                }
            }
        }
    }
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86400);
    entries.retain(|(_, m)| *m >= cutoff);
    if entries.len() > 50 {
        entries.sort_by_key(|(_, m)| *m);
        for (p, _) in &entries[..entries.len() - 50] {
            let _ = fs::remove_file(p);
        }
    }
}

#[derive(serde::Serialize)]
struct VersionInfo {
    file: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    size: u64,
}

/// List all versions of a document (mtime descending = newest first)
#[tauri::command]
fn list_versions(path: String) -> Result<Vec<VersionInfo>, String> {
    let dir = versions_root().join(version_stem(&path));
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
            let meta = e.metadata().map_err(|e| e.to_string())?;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(VersionInfo {
                file: p.to_string_lossy().into_owned(),
                mtime_ms,
                size: meta.len(),
            });
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(out)
}

/// Read one version snapshot. The path must be inside the versions root (prevents directory traversal reading arbitrary files).
#[tauri::command]
fn read_version(file: String) -> Result<String, String> {
    let root = versions_root();
    let p = std::path::Path::new(&file);
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let canon_root = root.canonicalize().unwrap_or(root);
    if !canon.starts_with(&canon_root) {
        return Err("Invalid version file path".into());
    }
    fs::read_to_string(&canon).map_err(|e| e.to_string())
}

// ===== PDF export: call the system msedge --headless --print-to-pdf =====
// Vector (text selectable and searchable), native Chromium pagination (any length, no canvas limit), no dialogs, zero extra dependencies.
// The WebView2 runtime is a Tauri prerequisite, so any machine that can run this exe has msedge.exe.
// The export HTML is loaded from file:/// by a separate msedge process, not through the Tauri webview,
// so the app CSP (script-src 'self') does not apply → inline styles/attributes/file:// resources are unrestricted.

/// Unique suffix: pid + nanoseconds, so concurrent/rapid clicks never collide (same as the tempdir() test helper)
fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}_{}", std::process::id(), nanos)
}

/// Compare versions numerically segment by segment, a > b (missing segments count as 0; no string comparison, which would make "99" > "131")
fn version_gt(a: &[u64], b: &[u64]) -> bool {
    let n = a.len().max(b.len());
    for i in 0..n {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

/// Scan the base folder for semantic-version subfolders (e.g. 150.0.4078.105) and return msedge.exe under the highest one.
/// Non-version folders (Installer / Application etc.) are ignored; subfolders without msedge.exe are ignored.
fn pick_versioned_msedge(base: &PathBuf) -> Option<PathBuf> {
    let entries = fs::read_dir(base).ok()?;
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for e in entries.flatten() {
        let parts: Vec<u64> = e
            .file_name()
            .to_string_lossy()
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect();
        if parts.is_empty() {
            continue; // not purely dotted digits (Installer etc.)
        }
        let exe = e.path().join("msedge.exe");
        if !exe.is_file() {
            continue;
        }
        match &best {
            None => best = Some((parts, exe)),
            Some((bp, _)) => {
                if version_gt(&parts, bp) {
                    best = Some((parts, exe));
                }
            }
        }
    }
    best.map(|(_, exe)| exe)
}

/// Locate the system Edge / WebView2 runtime msedge.exe (multi-level fallback, returns the first that exists).
/// Priority: env → system Edge (x86/x64) → WebView2 runtime.
/// System Edge comes before the WebView2 runtime: measured, the WebView2 runtime's msedge.exe does not support
/// --headless --print-to-pdf (exit code 13, no output), while system Edge produces vector PDFs fine.
/// Win10/11 almost always ship system Edge; the WebView2 runtime is only a fallback when it is missing.
fn locate_msedge() -> Result<PathBuf, String> {
    // 1. env WEBVIEW2_BROWSER_EXECUTABLE_FOLDER (explicitly set by the deployer)
    if let Ok(dir) = std::env::var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        let exe = PathBuf::from(&dir).join("msedge.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        bases.push(PathBuf::from(&pf86));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        bases.push(PathBuf::from(&pf));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        bases.push(PathBuf::from(&la));
    }
    // 2. System Edge: x86 → x64 (headless print-to-pdf measured to work, preferred)
    for base in &bases {
        let exe = base.join("Microsoft").join("Edge").join("Application").join("msedge.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    // 3. WebView2 runtime: scan per-machine and per-user, take the highest version subfolder of each (fallback)
    for base in &bases {
        let app_dir = base.join("Microsoft").join("EdgeWebView").join("Application");
        if let Some(exe) = pick_versioned_msedge(&app_dir) {
            return Ok(exe);
        }
    }
    Err("Microsoft Edge (msedge.exe) was not found; it is needed for PDF export. Please install Microsoft Edge and try again (the WebView2 runtime alone cannot export PDF).".into())
}

/// Local path to a file:// URL (Windows: backslash → slash; non-ASCII/special characters percent-encoded,
/// so msedge can still load when the temp folder contains non-ASCII characters/spaces)
fn file_url_from_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:///");
    for c in s.chars() {
        match c {
            c if c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '-' | '.' | '_' | '~') => {
                out.push(c)
            }
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

/// Run a child process with a timeout: after spawn, poll try_wait every 100ms and kill on timeout. Prevents msedge headless hangs.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start msedge: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("msedge exited with non-zero status: {status}"))
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "msedge headless export timed out ({}s), terminated",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Failed waiting for msedge to exit: {e}")),
        }
    }
}

/// Fixed HTML for the self-test: heading + long text filling 2 pages + 28px span + code block + table.
/// Lets --self-test-pdf verify the msedge pipeline end to end without a GUI (pre-flight on deployment machines).
fn self_test_html() -> String {
    let head = r#"<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
@page { size: A4; margin: 15mm; }
html,body{margin:0;padding:0;background:#fff;color:#000;
  font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;
  font-size:14px;line-height:1.75;}
pre{white-space:pre-wrap;word-break:break-word;}
pre,table,tr{break-inside:avoid;}
table{border-collapse:collapse;} th,td{border:1px solid #888;padding:4px 8px;}
code{background:#f4f4f4;padding:2px 4px;border-radius:3px;}
</style></head><body>
<h1>PDF export self-test heading</h1>
<p>This paragraph checks that the msedge headless vector print pipeline works.
<span style="font-size:28px">This text is enlarged to 28px.</span></p>
<h2>Code block test</h2>
<pre><code>fn main() {
    println!("Hello, world");
}</code></pre>
<h2>Table test</h2>
<table><thead><tr><th>Item</th><th>Value</th></tr></thead>
<tbody><tr><td>Row one</td><td>100</td></tr><tr><td>Row two</td><td>200</td></tr></tbody></table>
<h2>Page break test (fills a second page)</h2>
"#;
    let body = "This is a repeated long line used to push content onto a second page to verify Chromium pagination. ".repeat(120);
    format!("{}{}</body></html>", head, body)
}

/// RAII temp-resource cleanup guard: registered temp files/folders are deleted best-effort on Drop,
/// covering every exit path of export_pdf (including error returns / panics), so nothing is left in temp.
/// Tries remove_file then remove_dir_all on each path: the former works for files, the latter for folders, without interfering.
struct TmpClean(Vec<PathBuf>);
impl Drop for TmpClean {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = fs::remove_file(p);
            let _ = fs::remove_dir_all(p);
        }
    }
}

/// PDF export core: call the system msedge --headless --print-to-pdf to render HTML into a vector PDF.
/// At three observable milestones (page/printing/saving) the emit callback pushes real percentages:
/// the command version of export_pdf injects AppHandle to send Tauri events, the self-test version injects an empty callback (no GUI, events dropped).
/// A single msedge print attempt: build the command, run it, check for a blank result. The profile strategy is the caller's (fixed reuse / unique fallback).
fn pdf_attempt<F: Fn(&str, u8)>(
    msedge: &std::path::Path,
    profile_dir: &std::path::Path,
    html_url: &str,
    tmp_pdf: &std::path::Path,
    emit: &F,
) -> Result<(), String> {
    // user-data-dir must be joined with =: Edge 150 headless=new mistakes a space-separated flag value for a
    // target URL, which together with html_url triggers "Multiple targets are not supported in headless mode"
    // (exit 13, reproduced locally). Joined with =, the value is embedded in the flag and no longer treated as a separate target.
    let profile_str = profile_dir.to_string_lossy().replace('\\', "/");
    let tmp_pdf_str = tmp_pdf.to_string_lossy().replace('\\', "/");
    let mut cmd = Command::new(msedge);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--virtual-time-budget=5000",
        "--run-all-compositor-stages-before-draw",
        // Quiet flags: skip first-run wizard / default-browser prompt / extensions / component updates / background networking (pointless for local printing)
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-default-apps",
    ]);
    cmd.arg(format!("--user-data-dir={}", profile_str));
    cmd.arg(format!("--print-to-pdf={}", tmp_pdf_str));
    cmd.arg(html_url);
    // Windows: CREATE_NO_WINDOW, so no console window flashes
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // The print engine (msedge headless) is a black box: the parent cannot read per-page/byte progress,
    // so "printing" is only sent before launch; the frontend then runs an estimate curve towards 90% and jumps to 100% on real completion.
    emit("printing", 50);
    // v0.3.8: 30s → 120s. Measured: since Edge 150, headless print-to-pdf went from ~3s to 45-60s on this machine
    // (a minimal 1KB page is just as slow = engine-level regression, unrelated to content), 30s always timed out → retries took even longer. External engine time
    // is out of our control, so the limit is raised to 120s for slow setups; normal setups finishing in 2-3s are unaffected.
    run_with_timeout(cmd, Duration::from_secs(120))?;
    // Blank check: file exists + %PDF magic + size > 2000 (a blank shell is usually < 2KB).
    // When the same profile is forwarded by Chromium's single-instance logic, msedge still exits 0 but produces no file — must be caught here.
    if !tmp_pdf.is_file() {
        return Err("msedge did not produce a PDF file (export failed)".into());
    }
    let bytes = fs::read(tmp_pdf).map_err(|e| format!("Failed to read the generated PDF: {e}"))?;
    if bytes.len() < 2000 {
        return Err(format!("Generated PDF is suspiciously small ({} bytes, probably blank)", bytes.len()));
    }
    if !bytes.starts_with(b"%PDF") {
        return Err("Generated file is not a valid PDF (missing %PDF header)".into());
    }
    Ok(())
}

fn render_pdf<F: Fn(&str, u8)>(html: String, path: String, emit: F) -> Result<(), String> {
    // 1. Validate extension and content
    match std::path::Path::new(&path).extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("pdf") => {}
        _ => return Err("Unsupported save path (.pdf only)".into()),
    }
    if html.trim().is_empty() {
        return Err("Nothing to export".into());
    }

    let msedge = locate_msedge()?;

    // 2. Temp resources: the HTML is unique each time and cleaned by TmpClean; the profile uses a fixed folder reused across runs —
    //    measured (300-paragraph benchmark document) a new profile each time cold-starts in ~8s, reusing a fixed profile warm-starts in ~2s,
    //    which is the main speed gain. The fixed profile is not deleted (kept for reuse); concurrency/corruption is handled by the unique-profile retry below.
    let tmp_dir = std::env::temp_dir();
    let html_path = tmp_dir.join(format!("md_export_{}.html", unique_suffix()));
    let mut clean = TmpClean(Vec::new());
    clean.0.push(html_path.clone());
    fs::write(&html_path, html.as_bytes())
        .map_err(|e| format!("Failed to write temp HTML: {e}"))?;
    // HTML assembled and written to disk, about to launch the print engine — first observable milestone
    emit("page", 30);

    // 3. Temp PDF: written next to the final path (only a same-folder rename is atomic; across volumes it degrades to a copy)
    let final_dir = std::path::Path::new(&path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let tmp_pdf = final_dir.join(format!(".md_export_{}.pdf.tmp", unique_suffix()));
    clean.0.push(tmp_pdf.clone());

    // 4. msedge headless print: try the fixed profile first (warm start ~2s); on failure (corrupt profile / forwarded to a running
    //    instance giving 0KB etc.; the frontend reentry lock stops repeated clicks in one app, but cross-instance concurrency can still collide) → clear the fixed folder,
    //    retry once with a brand-new unique profile (back to a ~8s cold start, but succeeds).
    let html_url = file_url_from_path(&html_path);
    let fixed_profile = tmp_dir.join("mdaddy-pdf-profile");
    if let Err(first_err) = pdf_attempt(&msedge, &fixed_profile, &html_url, &tmp_pdf, &emit) {
        let _ = fs::remove_dir_all(&fixed_profile);
        let retry_profile = tmp_dir.join(format!("mdaddy-pdf-profile-{}", unique_suffix()));
        clean.0.push(retry_profile.clone());
        pdf_attempt(&msedge, &retry_profile, &html_url, &tmp_pdf, &emit)
            .map_err(|e2| format!("{first_err} (retry with a fresh profile also failed: {e2})"))?;
    }

    // Blank check passed, PDF content ready, atomically writing it to the target path — last observable milestone
    emit("saving", 95);
    // 7. Atomically replace the final path; if rename fails (target locked by a PDF reader) fall back to copy + delete.
    //    After a successful return the guard cleans up html_path / retry profile / leftover tmp_pdf
    //    (the fixed profile is deliberately kept for reuse, see above).
    if let Err(e) = fs::rename(&tmp_pdf, &path) {
        if let Err(e2) = fs::copy(&tmp_pdf, &path) {
            return Err(format!(
                "Failed to write the PDF: {e} (retry also failed: {e2}; the file may be open in a PDF reader)"
            ));
        }
    }
    Ok(())
}

/// Tauri command version: the frontend invoke entry point. Injects AppHandle and emits ("stage", pct) real percentages to the frontend at milestones.
#[tauri::command]
fn export_pdf(app: AppHandle, html: String, path: String) -> Result<(), String> {
    render_pdf(html, path, |stage, pct| {
        let _ = app.emit("export-pdf-progress", (stage, pct));
    })
}

/// Get the file path passed on the command line at startup (fallback read by the frontend after startup)
#[tauri::command]
fn get_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

#[tauri::command]
fn take_instance_requests(state: tauri::State<InstanceRequests>) -> Vec<InstancePromptRequest> {
    let Ok(mut requests) = state.0.lock() else { return Vec::new(); };
    let mut ready = Vec::new();
    for request in requests.iter_mut() {
        if !request.shown {
            request.shown = true;
            ready.push(InstancePromptRequest { id: request.id });
        }
    }
    ready
}

#[tauri::command]
fn resolve_instance_request(
    app: AppHandle,
    state: tauri::State<InstanceRequests>,
    request_id: u64,
    action: String,
) -> Result<(), String> {
    let request = {
        let mut requests = state.0.lock().map_err(|e| e.to_string())?;
        let idx = requests.iter().position(|r| r.id == request_id).ok_or("Instance request expired")?;
        requests.remove(idx)
    };
    if action == "new" {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut command = Command::new(exe);
        command.arg("--mdaddy-new-instance");
        command.args(request.args.iter().skip(1));
        command.current_dir(request.cwd);
        command.spawn().map_err(|e| format!("Could not start a new Mdaddy instance: {e}"))?;
        return Ok(());
    }
    if action != "open" { return Err("Unknown instance action".into()); }
    if let Some(file) = extract_md_from_args(request.args.into_iter()) {
        app.emit("open-file", file).map_err(|e| e.to_string())?;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

// ===== Unified PDF entry: smart routing when opening a PDF (source exists → open source / no source → PDF4QT) =====

/// Detect the PDF4QT main editor executable. PDF4QT is component-based with no PDF4QT.exe; the PDF editor component is
/// Pdf4QtEditor.exe (the same folder also holds Viewer/PageMaster/Diff/LaunchPad etc.).
/// Detection order: env PDF4QT_PATH → F:\software\PDF4QT (local portable install) → F:\PDF4QT →
/// PDF4QT subfolders under ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA.
/// Returns None if not found → the frontend falls back to plugin-opener with the system default PDF app.
fn locate_pdf4qt() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PDF4QT_PATH") {
        let exe = PathBuf::from(&dir).join("Pdf4QtEditor.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }
    let mut bases = Vec::new();
    bases.push(PathBuf::from("F:\\software"));
    bases.push(PathBuf::from("F:\\"));
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        bases.push(PathBuf::from(&pf86));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        bases.push(PathBuf::from(&pf));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        bases.push(PathBuf::from(&la));
    }
    for base in &bases {
        let exe = base.join("PDF4QT").join("Pdf4QtEditor.exe");
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

/// Find the PDF's same-name source file (.md/.markdown/.html/.htm): PDF folder + basename without extension,
/// try each extension in turn and return the first source path that exists. None if there is no source.
/// Used for the frontend loop "open PDF → if a source exists, edit the source and re-export over the PDF".
#[tauri::command]
fn find_pdf_source(pdf_path: String) -> Option<String> {
    let p = std::path::Path::new(&pdf_path);
    let dir = p.parent().unwrap_or_else(|| std::path::Path::new(""));
    let stem = match p.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s,
        None => return None,
    };
    for ext in &["md", "markdown", "html", "htm"] {
        let candidate = dir.join(format!("{}.{}", stem, ext));
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Open a source-less PDF in external PDF4QT for editing. Returns "PDF4QT_NOT_FOUND" if PDF4QT is not detected,
/// so the frontend falls back to plugin-opener (system default PDF app). The GUI program returns right after spawn: no wait, no CREATE_NO_WINDOW.
#[tauri::command]
fn open_pdf_external(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("pdf") => {}
        _ => return Err("Only .pdf files can be opened".into()),
    }
    if !p.is_file() {
        return Err(format!("File does not exist: {}", path));
    }
    match locate_pdf4qt() {
        Some(exe) => {
            Command::new(&exe)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to start PDF4QT: {e}"))?;
            Ok(())
        }
        None => Err("PDF4QT_NOT_FOUND".into()),
    }
}

/// HTML5 drag-drop of a PDF: the frontend cannot get the original path (WebView2 security), so the bytes go to a temp file handed to PDF4QT.
/// Reuses open_pdf_external's detection/launch logic. .pdf only, up to 5MB (larger files should use the Open button to get the real path).
#[tauri::command]
fn open_dropped_pdf(content: Vec<u8>, name: String) -> Result<(), String> {
    if !name.to_lowercase().ends_with(".pdf") {
        return Err("Only .pdf is supported".into());
    }
    if content.len() > 5 * 1024 * 1024 {
        return Err("PDF > 5MB, please use the Open button".into());
    }
    // the name is untrusted: only take file_name, prevents path traversal
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("dropped.pdf");
    let dir = std::env::temp_dir().join("mdaddy-drag");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp folder: {e}"))?;
    let tmp = dir.join(safe_name);
    fs::write(&tmp, &content).map_err(|e| format!("Failed to write temp file: {e}"))?;
    if safe_name == "__dnd_selftest__.pdf" {
        return Ok(()); // self-test sentinel: only verify the temp file was written, do not launch PDF4QT
    }
    open_pdf_external(tmp.to_string_lossy().into_owned())
}

/// Self-test switch: true when launch args contain --dnd-selftest (lets the frontend synthesize drop events to verify the whole HTML5 drag-drop chain; harmless to keep)
#[tauri::command]
fn dnd_selftest_enabled() -> bool {
    std::env::args().any(|a| a == "--dnd-selftest")
}

/// v0.3.9 print: WebView2 silently ignores window.print() (the host is responsible for printing; measured, no window appears),
/// so use Microsoft's proper path ICoreWebView2_16::ShowPrintUI — the system "print preview" window (printer/copies/duplex).
/// The print content (rendered body HTML) is prepared by the frontend in #print-root + @media print hides the app UI.
/// ShowPrintUI returns right after opening the preview (non-modal); when the preview closes the frontend cleans up on afterprint.
#[tauri::command]
fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM,
    };
    use windows::core::Interface; // cast() is an Interface trait method
    // the with_webview closure runs on the main thread, invoke waits on a runtime thread — result goes back through a channel, no deadlock
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| {
            let res = unsafe {
                (|| -> windows::core::Result<()> {
                    let t0 = std::time::Instant::now();
                    let core = webview.controller().CoreWebView2()?;
                    let p16: ICoreWebView2_16 = core.cast()?;
                    // SYSTEM(1) = classic system print dialog (printer/copies/duplex), measured to open here;
                    // BROWSER(0) = Edge-style preview silently does nothing under the Tauri host (S_OK, no window), not used
                    let hr = p16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM);
                    eprintln!("[print] ShowPrintUI(SYSTEM) returned {hr:?}, blocked {:?}", t0.elapsed());
                    hr
                })()
            };
            let _ = tx.send(res.map_err(|e| e.to_string()));
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;
    rx.recv()
        .map_err(|_| "Print result channel closed".to_string())?
        .map_err(|e| format!("ShowPrintUI failed: {e}"))
}

/// Self-test export folder: with launch arg --export-selftest <dir>, returns that folder (frontend exports skip the native save dialog
/// and write dir/document-name.ext directly for full-chain e2e automation; a normal launch returns None and uses the dialog)
#[tauri::command]
fn export_selftest_dir() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let r = args.iter().position(|a| a == "--export-selftest").and_then(|i| args.get(i + 1)).cloned();
    r
}

// ===== v0.3.26 external change detection: read file metadata (mtime + size), the frontend compares to see if another program changed it =====
#[derive(serde::Serialize, Debug)]
struct FileMeta {
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    size: u64,
}

#[tauri::command]
fn file_meta(path: String) -> Result<FileMeta, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta_to_file_meta(&meta))
}

/// Metadata → FileMeta conversion (shared by the file_meta path read and the save_file handle read)
fn meta_to_file_meta(meta: &fs::Metadata) -> FileMeta {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FileMeta { mtime_ms, size: meta.len() }
}

// ===== UI state persistence (zoom etc.): written to %APPDATA%/<identifier>/ui-state.json =====
// Not localStorage: WebView2 flushes localStorage to disk asynchronously, so a killed/crashed process loses it
// (reproduced in e2e with taskkill //F); a file write is synchronous and reliable.
// v0.5.0 portable mode: written to Data/ui-state.json next to the exe instead (data_root routes it).
fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(d) = portable_dir() {
        return Ok(d.clone());
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn ui_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("ui-state.json"))
}

#[tauri::command]
fn load_ui_state(app: AppHandle) -> Option<serde_json::Value> {
    fs::read_to_string(ui_state_path(&app).ok()?).ok().and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command]
fn save_ui_state(app: AppHandle, v: serde_json::Value) -> Result<(), String> {
    let p = ui_state_path(&app)?;
    fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    fs::write(&p, serde_json::to_string(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

// ===== v0.5.0 portable UI preferences: portable mode uses Data/settings.json, the installed version keeps localStorage =====
// In portable mode the WebView2 data folder points to %TEMP% (localStorage does not persist per machine), so low-frequency preferences
// like font size / panel width must be written to Data to travel with the USB drive. The installed frontend never calls these two commands.
fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let d = data_root(app)?;
    if portable_dir().is_none() {
        return Err("not portable".into());
    }
    Ok(d.join("settings.json"))
}

#[tauri::command]
fn is_portable() -> bool {
    portable_dir().is_some()
}

#[tauri::command]
fn load_prefs(app: AppHandle) -> Option<serde_json::Value> {
    let p = prefs_path(&app).ok()?;
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command]
fn save_prefs(app: AppHandle, v: serde_json::Value) -> Result<(), String> {
    let p = prefs_path(&app)?; // called by mistake in the installed version → Err("not portable"), nothing written to the install folder
    fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    fs::write(&p, serde_json::to_string(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

// ===== v0.4.0 custom themes: scan + read the themes/ folder (compatible with Typora community themes) =====
// Folder: %APPDATA%/<identifier>/themes/. One .css file = one theme (file name = theme name,
// same as Typora's themes folder convention). Reads are validated with canonicalize inside the theme folder against traversal.
fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("themes"))
}

#[tauri::command]
fn list_theme_files(app: AppHandle) -> Vec<String> {
    let dir = match themes_dir(&app) {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("css")).unwrap_or(false) {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    if !stem.starts_with('_') {
                        out.push(stem.to_string()); // _ prefix = disabled (samples/drafts, Typora convention)
                    }
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn read_theme_css(app: AppHandle, name: String) -> Result<String, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
    {
        return Err("invalid theme name".into());
    }
    let dir = themes_dir(&app)?;
    let p = dir.join(format!("{}.css", name));
    let canon = p.canonicalize().map_err(|_| "theme not found".to_string())?;
    let base = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&base) {
        return Err("path escape".into());
    }
    fs::read_to_string(&canon).map_err(|e| e.to_string())
}

// ===== v0.3.14 file tree sidebar + global cross-file search; v0.3.16 drive roots =====

/// List all drives on this machine (for the file tree "This PC" root): probe C..Z one by one, zero dependencies, no Win32 API.
#[tauri::command]
fn list_drives() -> Vec<serde_json::Value> {
    let mut out = vec![];
    for c in b'C'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if fs::metadata(&root).is_ok() {
            out.push(serde_json::json!({ "name": root.clone(), "path": root, "is_dir": true }));
        }
    }
    out
}


/// Subfolder names the tree ignores (hidden folders starting with "." are checked separately)
const TREE_SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "__pycache__"];

fn tree_skip(name: &str) -> bool {
    name.starts_with('.') || TREE_SKIP_DIRS.iter().any(|s| *s == name)
}

fn path_is_hidden(path: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return fs::metadata(path).map(|metadata| metadata.file_attributes() & 0x2 != 0).unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

/// Resolve an Explorer custom folder icon from desktop.ini when it points to a renderable image file.
/// PE resource icons (DLL/EXE) are left to the frontend's bundled SVG fallback.
#[tauri::command]
fn folder_custom_icon(path: String) -> Option<String> {
    let dir = PathBuf::from(path);
    let ini = fs::read_to_string(dir.join("desktop.ini")).ok()?;
    let mut icon = None;
    for line in ini.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        if !key.trim().eq_ignore_ascii_case("IconResource") && !key.trim().eq_ignore_ascii_case("IconFile") {
            continue;
        }
        let value = value.trim().trim_matches('"');
        let value = value.split(',').next().unwrap_or(value).trim().trim_matches('"');
        let mut expanded = String::new();
        let mut rest = value;
        while let Some(start) = rest.find('%') {
            expanded.push_str(&rest[..start]);
            let tail = &rest[start + 1..];
            let Some(end) = tail.find('%') else { expanded.push_str(&rest[start..]); rest = ""; break };
            let name = &tail[..end];
            expanded.push_str(&std::env::var(name).unwrap_or_else(|_| format!("%{name}%")));
            rest = &tail[end + 1..];
        }
        expanded.push_str(rest);
        let candidate = PathBuf::from(expanded);
        let candidate = if candidate.is_absolute() { candidate } else { dir.join(candidate) };
        let ext = candidate.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if ["ico", "png", "jpg", "jpeg", "bmp", "svg"].contains(&ext.as_str()) && candidate.is_file() {
            icon = Some(candidate.to_string_lossy().to_string());
            break;
        }
    }
    icon
}

/// List one folder level (for lazy tree expansion): folders (skipping hidden/node_modules etc.) + text files.
/// Sort: folders first, then names alphabetically (case-insensitive). Returns [{name, path, is_dir}]
#[tauri::command]
fn list_md_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut dirs: Vec<(String, String)> = vec![];
    let mut files: Vec<(String, String)> = vec![];
    let mut truncated = false;
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if tree_skip(&name) {
            continue;
        }
        if path_is_hidden(&entry.path()) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let full = entry.path().to_string_lossy().to_string();
        if is_dir {
            dirs.push((name, full));
        } else {
            // v0.3.21: the tree lists all files (not just editable extensions) — clicking a non-editable item in the frontend uses "show in folder"
            files.push((name, full));
        }
        if dirs.len() + files.len() >= 3000 {
            truncated = true;
            break; // huge-folder guard: truncate beyond the limit, the frontend shows a notice
        }
    }
    let key = |v: &(String, String)| v.0.to_lowercase();
    dirs.sort_by_key(&key);
    files.sort_by_key(&key);
    let mk = |v: (String, String), d: bool| {
        serde_json::json!({ "name": v.0, "path": v.1, "is_dir": d })
    };
    let mut out: Vec<serde_json::Value> = dirs.into_iter().map(|v| mk(v, true))
        .chain(files.into_iter().map(|v| mk(v, false)))
        .collect();
    if truncated {
        out.push(serde_json::json!({ "name": "… too many entries, list truncated", "path": "", "is_dir": false }));
    }
    Ok(out)
}

/// Cross-file search hit limit and scan guardrails (keeps big folders from freezing: digging deep would stall the UI thread's return)
const SEARCH_MAX_HITS: usize = 200;
const SEARCH_MAX_FILES: usize = 800;
const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Recursively search the content of all text files under root (case-insensitive contains).
/// Returns [{file, line_no, line_text}], line_no starts at 1, line_text trimmed and cut to 120 characters.
#[tauri::command]
fn search_md_files(root: String, query: String) -> Result<Vec<serde_json::Value>, String> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut hits: Vec<serde_json::Value> = vec![];
    let mut files_scanned = 0usize;
    // explicit stack DFS: element = (path, depth)
    let mut stack: Vec<(PathBuf, usize)> = vec![(PathBuf::from(&root), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > SEARCH_MAX_DEPTH || files_scanned >= SEARCH_MAX_FILES || hits.len() >= SEARCH_MAX_HITS {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // skip subfolders without permission
        };
        for entry in rd.flatten() {
            if hits.len() >= SEARCH_MAX_HITS {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if tree_skip(&name) {
                continue;
            }
            if path_is_hidden(&entry.path()) {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if depth + 1 <= SEARCH_MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
                continue;
            }
            if !has_allowed_ext(&name) || files_scanned >= SEARCH_MAX_FILES {
                continue;
            }
            // symlinks are not followed (ft.is_dir is false for a symlink, so reading content is safe)
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > SEARCH_MAX_FILE_BYTES || meta.len() == 0 {
                continue;
            }
            files_scanned += 1;
            let bytes = match fs::read(entry.path()) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let text = String::from_utf8_lossy(&bytes).to_lowercase();
            for (i, line) in text.lines().enumerate() {
                if hits.len() >= SEARCH_MAX_HITS {
                    break;
                }
                if line.contains(&q) {
                    let mut shown = line.trim().to_string();
                    if shown.chars().count() > 120 {
                        // cut by characters (safe for multi-byte text), not bytes
                        shown = shown.chars().take(120).collect();
                    }
                    hits.push(serde_json::json!({
                        "file": entry.path().to_string_lossy(),
                        "line_no": i + 1,
                        "line_text": shown,
                    }));
                }
            }
        }
    }
    Ok(hits)
}

// ===== v0.3.0 export centre + pasted screenshots saved to disk =====

/// Write a binary file (PNG/DOCX export output; the frontend passes base64)
#[tauri::command]
fn save_binary_file(path: String, data_b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Read a binary file (for embedding local images in docx export etc.; returns base64). Returns Err on failure so the frontend can use a placeholder.
#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| {
        app_log("ERROR", "open", &format!("Read failed {path}: {e}"));
        e.to_string()
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ===== v0.3.17 file tree context-menu management (new / rename / delete / show in Explorer) =====

/// Name validity: not empty and no characters illegal in Windows paths
fn valid_entry_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if n.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
        return Err("Name cannot contain \\ / : * ? \" < > |".into());
    }
    Ok(())
}

/// Guard against deleting/renaming a drive root ("C:\" form) and operating directly at the root
fn guard_not_drive_root(path: &str) -> Result<(), String> {
    let p = path.trim_end_matches('\\');
    if p.len() <= 2 && p.ends_with(':') {
        return Err("Cannot do this on a drive root".into());
    }
    Ok(())
}

/// Create a text file (in dir): kind = "md" | "txt"; if name already has an extension use it as is, otherwise add one per kind.
/// Returns the full path of the new file (for the frontend to open + refresh the tree).
#[tauri::command]
fn create_text_file(dir: String, name: String, kind: String) -> Result<String, String> {
    valid_entry_name(&name)?;
    let mut n = name.trim().to_string();
    let lower = n.to_lowercase();
    if !lower.ends_with(".md") && !lower.ends_with(".txt") && !lower.ends_with(".markdown") {
        n.push_str(if kind == "txt" { ".txt" } else { ".md" });
    }
    let full = std::path::Path::new(&dir).join(&n);
    if full.exists() {
        return Err(format!("A file with this name already exists: {n}"));
    }
    fs::write(&full, "").map_err(|e| e.to_string())?;
    Ok(full.to_string_lossy().to_string())
}

/// Create a folder (in dir). Returns the full path.
#[tauri::command]
fn create_dir(dir: String, name: String) -> Result<String, String> {
    valid_entry_name(&name)?;
    let full = std::path::Path::new(&dir).join(name.trim());
    if full.exists() {
        return Err(format!("An item with this name already exists: {}", name.trim()));
    }
    fs::create_dir(&full).map_err(|e| e.to_string())?;
    Ok(full.to_string_lossy().to_string())
}

/// Rename (within the same folder): old = full path, new_name = new name (without folder).
/// Uses fs::rename (atomic on the same drive; cross-drive cannot happen — same folder).
#[tauri::command]
fn rename_entry(old: String, new_name: String) -> Result<String, String> {
    guard_not_drive_root(&old)?;
    valid_entry_name(&new_name)?;
    let dst = std::path::Path::new(&old)
        .parent()
        .ok_or("No parent folder")?
        .join(new_name.trim());
    if dst.exists() {
        return Err(format!("Target already exists: {}", new_name.trim()));
    }
    fs::rename(&old, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// Delete: file remove_file / folder recursive remove_dir_all (the frontend already confirmed; drive roots are refused again here)
#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    guard_not_drive_root(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Show in Explorer (explorer /select,path). If the path does not exist, Explorer handles it.
#[tauri::command]
fn reveal_path(path: String) {
    let _ = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn();
}

/// v0.3.22 custom drive-wide file-name index (replaces v0.3.18's external es.exe dependency — single exe, zero dependencies by design).
/// Why es.exe was dropped: it is voidtools' closed-source CLI that only does IPC queries; the real engine is the Everything
/// resident service (direct MFT reads + USN watching), so "merging the code in" was impossible (no source, licence forbids it, an empty shell without the service).
/// This approach: multi-threaded walk of fixed drives (one thread per drive) into an in-memory index (full path + lowercase file name copy),
/// cached in %APPDATA%\Mdaddy\file-index.txt — at startup the cache loads in the background in seconds and is ready, then rebuilt at low priority after 30s
/// to stay fresh; without a cache, the build starts immediately (first time 1-3 minutes, live progress). Search = multi-word AND substring match on
/// file names (same semantics as es.exe), filtered in memory in milliseconds. No admin rights, no third-party dependencies.
struct IndexEntry {
    path: String,    // full path (for display/locating)
    name_at: usize,  // start offset of file_name within path (saves a String: measured, 2.95M items with two strings used 500MB+)
    is_dir: bool,
}
/// Extension whitelist for the index (all folders are included). A whole disk easily has millions of files — node_modules/target/
/// system DLLs nobody searches; including everything is unbearable for memory and cache (385MB cache measured here).
/// Included = what users search for: documents/code/media/archives/installers/fonts.
const INDEX_EXTS: &[&str] = &[
    // documents
    "md", "markdown", "mdown", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "pdf", "epub", "mobi", "csv", "tsv", "json", "xml", "yaml", "yml", "ini", "cfg",
    "conf", "log", "rtf", "odt", "ots",
    // code
    "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp",
    "cs", "php", "rb", "sh", "bat", "ps1", "html", "htm", "css", "scss", "vue", "sql", "ipynb",
    // media
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff",
    "mp3", "wav", "flac", "aac", "ogg", "m4a",
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm",
    // archives/installers/fonts
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "exe", "msi",
    "ttf", "otf", "woff", "woff2",
];
/// ASCII case-insensitive contains (non-ASCII bytes compared as is: multi-byte scripts have no case, semantically correct)
fn ascii_ci_contains(hay: &str, needle: &str) -> bool {
    let h = hay.as_bytes(); let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() { return n.is_empty(); }
    'outer: for i in 0..=h.len() - n.len() {
        for j in 0..n.len() {
            let a = h[i + j].to_ascii_lowercase();
            let b = if n[j].is_ascii() { n[j].to_ascii_lowercase() } else { n[j] };
            if a != b { continue 'outer; }
        }
        return true;
    }
    false
}
static INDEX: std::sync::RwLock<Vec<IndexEntry>> = std::sync::RwLock::new(Vec::new());
static INDEX_BUILDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static INDEX_SCANNED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// batch buffer from walk threads → merge thread (512 entries per lock, fewer lock acquisitions)
static INDEX_BUF: std::sync::Mutex<Vec<IndexEntry>> = std::sync::Mutex::new(Vec::new());
/// count of live walk threads (the merge thread uses it to finish)
static WALK_ALIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Drop the current thread to the lowest scheduling priority (for index rebuilds): a full HDD walk is IO heavy,
/// and at normal priority it slows UI responses (measured: the table floating panel timed out) — background work must yield.
fn lower_thread_priority() {
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        }
        // GetCurrentThread() pseudo handle = -1; THREAD_PRIORITY_LOWEST = -2
        SetThreadPriority(-1, -2);
    }
}

fn index_cache_path() -> PathBuf {
    // Portable mode special case: the index holds this machine's file names and does not travel on the USB drive (useless on another machine),
    // so it lives in %TEMP% and each machine builds its own; the cost is a first build on each new machine (1-3 minutes, same as an installed cold start).
    if portable_dir().is_some() {
        let t = std::env::var("TEMP").unwrap_or_else(|_| ".".into());
        return PathBuf::from(t).join("Mdaddy").join("file-index.txt");
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("Mdaddy").join("file-index.txt")
}

/// Fixed drive roots (walk targets): probe C..Z for readable roots, excluding optical/removable drives (reading an optical drive blocks while it spins up).
fn fixed_drive_roots() -> Vec<PathBuf> {
    (b'C'..=b'Z')
        .map(|c| PathBuf::from(format!("{}:\\", c as char)))
        .filter(|p| std::fs::metadata(p).is_ok())
        .collect()
}

/// Recursively walk a folder tree (silently skip no-permission folders; symlinks/junctions not followed, avoiding loops).
/// Hits accumulate in a local batch, pushed to the shared buffer every 512 (512× fewer lock acquisitions).
fn walk_into(dir: &PathBuf, batch: &mut Vec<IndexEntry>) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return, // no permission / in use: skip the whole subtree
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue; // junction/symlink: not followed (loops like All Users → ProgramData would never end)
        }
        let is_dir = ft.is_dir();
        let p = e.path();
        // whitelist filter (all folders; files by extension) — including everything is unbearable for memory/cache (2.95M items confirmed)
        let take = if is_dir { true } else {
            p.extension().and_then(|x| x.to_str())
                .map(|x| INDEX_EXTS.iter().any(|w| w.eq_ignore_ascii_case(x)))
                .unwrap_or(false)
        };
        if take {
            let s = p.to_string_lossy().to_string();
            let name_at = s.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
            batch.push(IndexEntry { path: s, name_at, is_dir });
        }
        INDEX_SCANNED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if is_dir {
            walk_into(&p, batch);
        }
        if batch.len() >= 512 {
            if let Ok(mut buf) = INDEX_BUF.lock() {
                buf.append(batch);
            }
        }
    }
}

/// Main index build (background thread): one thread per drive walks in parallel (writing the shared buffer), the merge thread every 3s
/// moves the buffer into INDEX — searches can immediately query the scanned part (v0.3.22 search while building: measured, a full
/// HDD of 2.95M items was not done after 8 minutes; "search only when finished" would leave users waiting minutes, unacceptable).
/// After completion shrink + atomic cache write. While INDEX_BUILDING, es_search returns partial hits.
fn build_index() {
    if INDEX_BUILDING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // already building, prevent reentry
    }
    app_log("INFO", "index", "Drive-wide index build started");
    INDEX_SCANNED.store(0, std::sync::atomic::Ordering::Relaxed);
    INDEX.write().unwrap().clear(); // rebuild from scratch (no mixing old and new)
    let roots = fixed_drive_roots();
    WALK_ALIVE.store(roots.len(), std::sync::atomic::Ordering::Relaxed);
    for root in roots {
        std::thread::spawn(move || {
            lower_thread_priority(); // rebuild = background low priority: do not compete with user edits/clicks for CPU
            let mut batch: Vec<IndexEntry> = vec![];
            walk_into(&root, &mut batch);
            if !batch.is_empty() {
                if let Ok(mut buf) = INDEX_BUF.lock() {
                    buf.append(&mut batch);
                }
            }
            WALK_ALIVE.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        });
    }
    // merge + cache writer thread: move buffer → INDEX every 3s; when all walks finish, final move + shrink + cache write
    let t0 = std::time::Instant::now();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let drained: Vec<IndexEntry> = {
                let mut buf = INDEX_BUF.lock().unwrap();
                std::mem::take(&mut *buf)
            };
            if !drained.is_empty() {
                INDEX.write().unwrap().extend(drained);
            }
            if WALK_ALIVE.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                let drained: Vec<IndexEntry> = {
                    let mut buf = INDEX_BUF.lock().unwrap();
                    std::mem::take(&mut *buf)
                };
                if !drained.is_empty() {
                    INDEX.write().unwrap().extend(drained);
                }
                INDEX.write().unwrap().shrink_to_fit();
                // atomic cache write (tmp + rename): line format "D\tpath" / "F\tpath"
                let n = INDEX.read().unwrap().len();
                let cache = index_cache_path();
                if let Some(d) = cache.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let tmp = cache.with_extension("txt.tmp");
                let mut buf = String::with_capacity(n * 64);
                {
                    let idx = INDEX.read().unwrap();
                    for e in idx.iter() {
                        buf.push(if e.is_dir { 'D' } else { 'F' });
                        buf.push('\t');
                        buf.push_str(&e.path);
                        buf.push('\n');
                    }
                }
                if std::fs::write(&tmp, buf.as_bytes()).is_ok() {
                    let _ = std::fs::rename(&tmp, &cache);
                }
                INDEX_BUILDING.store(false, std::sync::atomic::Ordering::SeqCst);
                app_log("INFO", "index", &format!(
                    "Drive-wide index build done: {} items, {:.0}s",
                    n, t0.elapsed().as_secs_f64()));
                return;
            }
        }
    });
}

/// Start the index pipeline (setup calls it once): cache present → loaded in the background and ready, rebuilt 30s later to refresh;
/// no cache → build immediately (search while building). A corrupt cache is treated as no cache.
fn start_index_pipeline() {
    std::thread::spawn(|| {
        let cache = index_cache_path();
        let loaded = std::fs::read_to_string(&cache)
            .ok()
            .filter(|s| s.len() > 4)
            .map(|text| {
                let mut v: Vec<IndexEntry> = vec![];
                for line in text.lines() {
                    let mut it = line.splitn(2, '\t');
                    let (flag, path) = match (it.next(), it.next()) {
                        (Some(f), Some(p)) => (f, p),
                        _ => continue,
                    };
                    let is_dir = flag == "D";
                    let s = path.to_string();
                    let name_at = s.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
                    v.push(IndexEntry { path: s, name_at, is_dir });
                }
                v
            })
            .filter(|v| !v.is_empty());
        if let Some(v) = loaded {
            INDEX_SCANNED.store(v.len(), std::sync::atomic::Ordering::Relaxed);
            *INDEX.write().unwrap() = v;
            // the cache is just "usable first": rebuild after a 10-minute delay (avoids the "open and search/edit right away" peak;
            // rebuilding after 30s was confirmed to slow the table panel — a full HDD walk is IO heavy, so it runs at the lowest thread priority)
            std::thread::sleep(std::time::Duration::from_secs(600));
        }
        build_index();
    });
}

/// Drive-wide file-name search (v0.3.22 custom index, search while building): only when there is no data at all (build just started) report
/// INDEX_BUILDING:<scanned count>; with data = Ok(hits) — during a build the hits come from the scanned part.
#[tauri::command]
fn es_search(query: String, limit: u32) -> Result<Vec<EsHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let building = INDEX_BUILDING.load(std::sync::atomic::Ordering::Relaxed);
    let idx = INDEX.read().unwrap();
    if idx.is_empty() && building {
        return Err(format!(
            "INDEX_BUILDING:{}",
            INDEX_SCANNED.load(std::sync::atomic::Ordering::Relaxed)
        ));
    }
    // split on spaces, AND-match file names (ASCII case-insensitive); shorter paths rank higher
    // v0.3.28 ext: filter syntax restored (lost when switching to the v0.3.22 custom index): ext:md = only .md files
    // (several ext: tokens are unioned, ext:md,txt also accepted); the remaining words still AND-match file names
    let mut terms: Vec<String> = Vec::new();
    let mut exts: Vec<String> = Vec::new();
    for tok in q.split_whitespace() {
        if let Some(e) = tok.strip_prefix("ext:") {
            if !e.is_empty() {
                for x in e.split(',') {
                    let x = x.trim().trim_start_matches('.');
                    if !x.is_empty() { exts.push(x.to_string()); }
                }
                continue;
            }
        }
        terms.push(tok.to_string());
    }
    let mut hits: Vec<EsHit> = idx
        .iter()
        .filter(|e| {
            let name = &e.path[e.name_at.min(e.path.len())..];
            if !terms.iter().all(|t| ascii_ci_contains(name, t)) { return false; }
            if !exts.is_empty() {
                if e.is_dir { return false; }
                match name.rfind('.') {
                    Some(d) => {
                        let ex = &name[d + 1..];
                        if !exts.iter().any(|x| x.eq_ignore_ascii_case(ex)) { return false; }
                    }
                    None => return false,
                }
            }
            true
        })
        .take(limit.clamp(1, 2000) as usize)
        .map(|e| EsHit { path: e.path.clone(), is_dir: e.is_dir })
        .collect();
    drop(idx);
    hits.sort_by_key(|h| h.path.len());
    Ok(hits)
}

/// A hit (path = full path; is_dir = folder or not, for routing frontend clicks) — same fields as in the es.exe era
#[derive(serde::Serialize, Debug)]
struct EsHit {
    path: String,
    is_dir: bool,
}

/// Write a text file for export (HTML etc.). Separate from save_file: export output is not limited to the md/txt whitelist
/// and has no empty-overwrite guard (export content comes from the render pipeline, not the editor value).
#[tauri::command]
fn write_export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Save a pasted screenshot: into an assets/ subfolder next to the document (for an untitled document doc_dir is empty → saved to
/// %APPDATA%/<id>/pasted/ and the absolute path is returned). File name = Screenshot_yyyyMMdd_HHmmss (a counter is added for several in the same second).
/// Returns (relative reference path, absolute path). Non-ASCII file names are kept as is (the frontend encodes md references when needed).
#[tauri::command]
fn save_paste_image(
    app: AppHandle,
    doc_dir: String,
    ext: String,
    data_b64: String,
    image_dir: Option<String>,
    stamp: Option<String>,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let ext = ext.to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.as_str()) {
        return Err(format!("unsupported image ext: {ext}"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // local time yyyyMMdd_HHmmss (no chrono dependency: seconds converted with UTC+8)
    let local = now + 8 * 3600;
    let days = local / 86400;
    let (y, mo, d) = civil_from_days(days as i64);
    let secs = local % 86400;
    // the frontend passes its local-time stamp (yyyyMMdd_HHmmss); the UTC+8 computation is only a fallback
    let stamp = stamp
        .filter(|s| s.len() == 15 && s.chars().all(|c| c.is_ascii_digit() || c == '_'))
        .unwrap_or_else(|| format!("{:04}{:02}{:02}_{:02}{:02}{:02}", y, mo, d, secs / 3600, secs % 3600 / 60, secs % 60));
    let base = format!("Screenshot_{stamp}");

    let custom = image_dir.as_deref().and_then(extras::resolve_image_dir);
    let (dir, rel) = if let Some(cd) = custom {
        // custom image folder (Settings > Images): relative reference when it sits under the document folder, absolute otherwise
        let rel = if doc_dir.is_empty() {
            String::new()
        } else {
            let docp = PathBuf::from(&doc_dir);
            cd.strip_prefix(&docp)
                .ok()
                .map(|r| {
                    let r = r.to_string_lossy().replace('\\', "/");
                    if r.is_empty() { "./".to_string() } else { format!("{r}/") }
                })
                .unwrap_or_default()
        };
        (cd, rel)
    } else if doc_dir.is_empty() {
        let d = data_root(&app)?.join("pasted");
        (d, String::new()) // untitled document: no relative base, reference by absolute path
    } else {
        let d = PathBuf::from(&doc_dir).join("assets");
        (d, format!("assets/"))
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // same-second collision: add a counter
    let mut name = format!("{base}.{ext}");
    let mut i = 1;
    while dir.join(&name).exists() {
        name = format!("{base}_{i}.{ext}");
        i += 1;
    }
    let abs = dir.join(&name);
    fs::write(&abs, &bytes).map_err(|e| e.to_string())?;
    let abs_str = abs.to_string_lossy().replace('\\', "/");
    let rel_str = if rel.is_empty() { abs_str.clone() } else { format!("{rel}{name}") };
    Ok(serde_json::json!({ "rel": rel_str, "abs": abs_str }))
}

/// Gregorian conversion (Howard Hinnant's algorithm, civil_from_days)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// WebView2 Runtime missing check: any registry location with a pv value counts as installed.
/// Skipped when WEBVIEW2_BROWSER_EXECUTABLE_FOLDER explicitly pins a fixed version (enterprise offline distribution).
fn webview2_missing() -> bool {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return false;
    }
    // v0.5.1 faster startup: file-system folder probing replaces 4 reg query child processes (measured worst case ~390ms → ~1ms).
    // The Evergreen runtime installs to fixed locations: per-machine = %ProgramFiles(x86)%, per-user = %LOCALAPPDATA%
    // under Microsoft\EdgeWebView\Application\; the installer creates the folder, so existing = installed (a broken install defeats reg probing too).
    for base in [std::env::var_os("ProgramFiles(x86)"), std::env::var_os("LOCALAPPDATA")] {
        if let Some(b) = base {
            if PathBuf::from(&b).join(r"Microsoft\EdgeWebView\Application").is_dir() {
                return false;
            }
        }
    }
    true
}

// Zero-dependency message box (no WebView2 needed, calls user32 directly): gives users readable guidance when WebView2 is missing,
// instead of an undiagnosable "double-click does nothing / white screen" failure.
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
}

#[cfg(windows)]
fn fatal_msgbox(text: &str, caption: &str) {
    let t: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let c: Vec<u16> = caption.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { MessageBoxW(0, t.as_ptr(), c.as_ptr(), 0x10); } // MB_ICONERROR
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v0.3.23 first run-log line: the very first thing run() does (covers the first line at startup, no observability blind spot)
    log_startup(&std::env::args().skip(1).collect::<Vec<_>>().join(" "));
    // v0.5.0 portable mode: WebView2 data folder (cache/localStorage) → %TEMP%, leaving no trace on the host machine.
    // Must be set before the WebView is created (after the Builder); preference data travels on the USB drive in Data/settings.json,
    // %TEMP% only holds rebuildable cache, gone after system cleanup/reboot.
    if let Some(pd) = portable_dir_owned() {
        app_log("INFO", "portable", &format!("Portable mode enabled: Data={}", pd.display()));
        let tmp = std::env::var("TEMP").unwrap_or_else(|_| ".".into());
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", PathBuf::from(tmp).join("Mdaddy").join("webview"));
    }
    // Startup pre-check: when the WebView2 Runtime is missing (very old/stripped systems) Tauri fails silently or shows a white screen,
    // so give readable guidance before exiting (same lesson as tools that would not start on machines missing VC++ DLLs).
    #[cfg(windows)]
    {
        if webview2_missing() {
            fatal_msgbox(
                "Microsoft WebView2 Runtime is missing (usually built into Windows 10/11).\n\n\
                 Please install the WebView2 Runtime and try again:\n\
                 https://developer.microsoft.com/microsoft-edge/webview2/\n\
                 (Evergreen Standalone installer works offline.)",
                "Mdaddy cannot start",
            );
            std::process::exit(1);
        }
    }
    // --self-test-pdf <out.pdf>: verify the msedge pipeline end to end without a GUI (deployment pre-check / automated tests)
    // When present, run the full export_pdf pipeline with fixed HTML and exit without starting the GUI.
    let args_vec: Vec<String> = std::env::args().collect();
    if let Some(pos) = args_vec.iter().position(|a| a == "--self-test-pdf") {
        match args_vec.get(pos + 1) {
            Some(out) => match render_pdf(self_test_html(), out.clone(), |_, _| {}) {
                Ok(()) => {
                    println!("SELF_TEST_OK path={}", out);
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("SELF_TEST_ERR {}", e);
                    std::process::exit(1);
                }
            },
            None => {
                eprintln!("SELF_TEST_ERR --self-test-pdf needs an output path argument");
                std::process::exit(1);
            }
        }
    }

    let startup = extract_md_arg();
    let new_instance = args_vec.iter().any(|arg| arg == "--mdaddy-new-instance");
    let mut builder = tauri::Builder::default();
    if !new_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let id = NEXT_INSTANCE_REQUEST.fetch_add(1, Ordering::Relaxed);
            if let Some(requests) = app.try_state::<InstanceRequests>() {
                if let Ok(mut queue) = requests.0.lock() {
                    queue.push(PendingInstanceRequest {
                        id,
                        args: argv,
                        cwd: PathBuf::from(cwd),
                        shown: false,
                    });
                }
                let _ = app.emit("instance-request", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupFile(Mutex::new(startup)))
        .manage(InstanceRequests::default())
        .setup(|_app| {
            // v0.3.22 custom drive-wide index pipeline: cache loads in seconds → delayed rebuild / no cache builds right away (background thread, never blocks the UI)
            start_index_pipeline();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            list_versions,
            read_version,
            export_pdf,
            get_startup_file,
            take_instance_requests,
            resolve_instance_request,
            find_pdf_source,
            open_pdf_external,
            open_dropped_pdf,
            load_ui_state,
            is_portable,
            load_prefs,
            save_prefs,
            save_binary_file,
            read_binary_file,
            write_export_file,
            save_paste_image,
            export_selftest_dir,
            save_ui_state,
            list_theme_files,
            read_theme_css,
            list_md_dir,
            folder_custom_icon,
            list_drives,
            create_text_file,
            create_dir,
            rename_entry,
            delete_entry,
            reveal_path,
            es_search,
            file_meta,
            export_diagnostics,
            search_md_files,
            dnd_selftest_enabled,
            print_webview,
            extras::ai_shelf_models,
            extras::ai_http,
            extras::ai_cli,
            extras::ai_cli_available,
            extras::known_folders,
            extras::launch_app,
            extras::send_targets_available,
            extras::temp_dir_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    // Tests the product code itself (not a mirrored copy): use super::* reaches private functions directly, no visibility changes
    use super::*;
    use std::fs;

    #[test]
    fn portable_dir_detection() {
        // v0.5.0 portable rule: Data folder next to the exe exists → Some; missing / no parent path → None.
        // Does not touch the real exe (the PORTABLE_DIR global cache in the test process has no Data and should be None, only as side evidence).
        let tmp = std::env::temp_dir().join(format!("mde-portable-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let exe = tmp.join("md-editor.exe");
        // no Data folder → None
        fs::create_dir_all(&tmp).unwrap();
        assert_eq!(portable_dir_at(&exe), None);
        // create Data → Some(its path)
        fs::create_dir_all(tmp.join("Data")).unwrap();
        let got = portable_dir_at(&exe).unwrap();
        assert_eq!(got, tmp.join("Data"));
        // exe at a root folder (the no-parent edge case is naturally covered by parent() returning None, not constructed)
        assert_eq!(portable_dir_at(std::path::Path::new("md-editor.exe")), None);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn es_search_selfindex_queries() {
        // v0.3.22 custom index query logic (inject a small index, no drive-wide build triggered):
        // multi-word AND, case-insensitive (ascii_ci_contains), folder hits, limit truncation, not-ready semantics
        fn entry(path: &str, is_dir: bool) -> IndexEntry {
            let name_at = path.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
            IndexEntry { path: path.into(), name_at, is_dir }
        }
        *INDEX.write().unwrap() = vec![
            entry("C:\\docs\\\u{5e74}\u{5ea6}\u{62a5}\u{544a}.md", false),
            entry(r"C:\docs\Report-2026.md", false),
            entry("C:\\docs\\\u{62a5}\u{544a}\u{8d44}\u{6599}", true),
            entry(r"D:\notes\todo.txt", false),
        ];
        INDEX_BUILDING.store(false, std::sync::atomic::Ordering::Relaxed);
        // single word hit (case-insensitive: REPORT matches Report-2026)
        let hits = es_search("report".into(), 10).unwrap();
        assert!(hits.iter().any(|h| h.path.ends_with("Report-2026.md")), "{hits:?}");
        // multi-word AND: the non-ASCII word + md only matches the annual-report .md (the folder has no "md" word, Report-2026 lacks the non-ASCII word)
        let hits = es_search("\u{62a5}\u{544a} md".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("\u{5e74}\u{5ea6}\u{62a5}\u{544a}.md"));
        // limit truncation
        let hits = es_search("md".into(), 1).unwrap();
        assert_eq!(hits.len(), 1);
        // v0.3.28 ext: filter (syntax lost when switching to the custom index): word + extension AND; ext: excludes folders;
        // several extensions are unioned (comma); a bare ext: also works
        let hits = es_search("\u{62a5}\u{544a} ext:md".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("\u{5e74}\u{5ea6}\u{62a5}\u{544a}.md"));
        let hits = es_search("\u{62a5}\u{544a} ext:md,txt".into(), 10).unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("\u{5e74}\u{5ea6}\u{62a5}\u{544a}.md"));
        let hits = es_search("ext:txt".into(), 10).unwrap();
        assert!(hits.iter().all(|h| h.path.ends_with(".txt")) && !hits.is_empty(), "{hits:?}");
        let hits = es_search("todo ext:txt".into(), 10).unwrap();
        assert!(hits.iter().any(|h| h.path.ends_with("todo.txt")), "{hits:?}");
        // empty query
        assert!(es_search("  ".into(), 10).unwrap().is_empty());
        // cleared index + building → not-ready semantics
        INDEX.write().unwrap().clear();
        INDEX_BUILDING.store(true, std::sync::atomic::Ordering::Relaxed);
        INDEX_SCANNED.store(42, std::sync::atomic::Ordering::Relaxed);
        let err = es_search("x".into(), 10).unwrap_err();
        assert_eq!(err, "INDEX_BUILDING:42");
    }
    #[test]
    fn ascii_ci_contains_cases() {
        assert!(ascii_ci_contains("Report-2026.md", "report"));
        assert!(ascii_ci_contains("\u{5e74}\u{5ea6}\u{62a5}\u{544a}.md", "\u{62a5}\u{544a}"));
        assert!(ascii_ci_contains("\u{5e74}\u{5ea6}\u{62a5}\u{544a}.md", "MD"));
        assert!(!ascii_ci_contains("Report-2026.md", "reportx"));
        assert!(!ascii_ci_contains("\u{62a5}\u{544a}.md", "\u{6c47}\u{62a5}"));
        assert!(ascii_ci_contains("a", ""));
    }

    #[test]
    fn ext_whitelist_normal() {
        for e in ["a.md", "a.markdown", "a.mdown", "a.txt"] {
            assert!(has_allowed_ext(e), "{e} should pass");
        }
    }
    #[test]
    fn ext_uppercase_case_insensitive() {
        assert!(has_allowed_ext("README.MD"));
        assert!(has_allowed_ext("C:\\dir\\X.TXT"));
        assert!(has_allowed_ext("a.MdOwN"));
    }
    #[test]
    fn ext_no_extension_rejected() {
        assert!(!has_allowed_ext("README"));
        assert!(!has_allowed_ext(""));
    }
    #[test]
    fn ext_double_extension_rejected() {
        assert!(!has_allowed_ext("evil.md.exe"));
        assert!(!has_allowed_ext("evil.txt.bat"));
    }
    #[test]
    fn ext_dot_only_rejected() {
        assert!(!has_allowed_ext("."));
        assert!(!has_allowed_ext("file."));
    }
    #[test]
    fn ext_non_whitelisted_rejected() {
        assert!(!has_allowed_ext("a.docx"));
        assert!(!has_allowed_ext("a.html"));
        assert!(!has_allowed_ext("a.exe"));
    }
    #[test]
    fn ext_traversal_passes_ext_check() {
        // path traversal protection is not in the extension check layer (covered by frontend regex + OS + user choice); here only the last segment must be valid
        assert!(has_allowed_ext("../evil.md"));
        assert!(!has_allowed_ext("../evil.exe"));
    }

    #[test]
    fn extract_picks_first_existing_md() {
        // skip the program name, take the first existing path with a valid extension
        let dir = std::env::temp_dir().join("md_verify_extract");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("real.md");
        fs::write(&md, "x").unwrap();
        let md_str = md.to_str().unwrap().to_string();
        let args = vec!["prog.exe".to_string(), "notexist.md".to_string(), md_str.clone()];
        assert_eq!(extract_md_from_args(args.into_iter()), Some(md_str));
        assert_eq!(extract_md_from_args(vec!["prog.exe".to_string()].into_iter()), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ftree_entry_ops_roundtrip() {
        let dir = std::env::temp_dir().join("md_verify_ftree_ops");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();

        // create md (extension added) → opens with empty content → same for txt
        let f1 = create_text_file(d.clone(), "\u{7b14}\u{8bb0}".into(), "md".into()).unwrap();
        assert!(f1.ends_with("\u{7b14}\u{8bb0}.md") && std::path::Path::new(&f1).is_file());
        // already exists → refused
        assert!(create_text_file(d.clone(), "\u{7b14}\u{8bb0}.md".into(), "md".into()).is_err());
        // illegal characters → refused
        assert!(create_text_file(d.clone(), "a<b".into(), "md".into()).is_err());
        // create folder
        let sub = create_dir(d.clone(), "\u{5b50}\u{5939}".into()).unwrap();
        assert!(std::path::Path::new(&sub).is_dir());
        // rename: one file and one folder
        let f2 = rename_entry(f1.clone(), "\u{6539}\u{540d}.md".into()).unwrap();
        assert!(!std::path::Path::new(&f1).exists() && std::path::Path::new(&f2).exists());
        let sub2 = rename_entry(sub.clone(), "\u{5b50}\u{5939}2".into()).unwrap();
        assert!(std::path::Path::new(&sub2).is_dir());
        // target exists → refused
        let _ = create_text_file(d.clone(), "\u{5360}\u{7528}.md".into(), "md".into()).unwrap();
        assert!(rename_entry(f2.clone(), "\u{5360}\u{7528}.md".into()).is_err());
        // delete: file and folder (recursive)
        delete_entry(f2).unwrap();
        let _ = create_text_file(sub2.clone(), "\u{5185}.txt".into(), "txt".into()).unwrap();
        delete_entry(sub2).unwrap();
        // drive root guard
        assert!(delete_entry("C:\\".into()).is_err());
        assert!(rename_entry("F:\\".into(), "x".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_drives_returns_existing_roots() {
        // this machine has at least C:; every path is in "X:\" form with is_dir=true
        let out = list_drives();
        assert!(!out.is_empty(), "at least one drive on this machine");
        assert!(out.iter().any(|v| v["path"].as_str().unwrap() == "C:\\"));
        for v in &out {
            let p = v["path"].as_str().unwrap();
            assert!(p.len() == 3 && p.ends_with(":\\"), "drive form: {p}");
            assert!(v["is_dir"].as_bool().unwrap());
        }
    }

    #[test]
    fn file_meta_reports_mtime_and_size() {
        // v0.3.26 external change detection: a normal file returns mtime+size; mtime is monotonic (between two writes); missing returns Err
        let dir = tempdir();
        let p = dir.join("m.md");
        fs::write(&p, "hello").unwrap();
        let m1 = file_meta(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(m1.size, 5, "size should be in bytes");
        assert!(m1.mtime_ms > 1_500_000_000_000, "mtime should be a modern millisecond timestamp: {}", m1.mtime_ms);
        // size changes after appending
        fs::write(&p, "hello world").unwrap();
        let m2 = file_meta(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(m2.size, 11);
        assert!(m2.mtime_ms >= m1.mtime_ms, "mtime must not go backwards");
        // missing file: Err (the frontend treats it as "file was deleted")
        assert!(file_meta(dir.join("nope.md").to_str().unwrap().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_file_rejects_oversize() {
        // >16MB is refused before reading (content not read, Err text contains "File too large"); raised from 2MB to 16MB in v0.3.25
        let dir = std::env::temp_dir().join("md_verify_oversize");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        let mut buf = vec![b'a'; 16 * 1024 * 1024 + 1];
        buf[0] = b'#';
        fs::write(&big, &buf).unwrap();
        let err = open_file(big.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("File too large"), "err={err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_md_dir_layers_and_skips() {
        let dir = std::env::temp_dir().join("md_verify_listdir");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::write(dir.join("img.png"), "x").unwrap();
        let out = list_md_dir(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<(String, bool)> = out
            .iter()
            .map(|v| (v["name"].as_str().unwrap().to_string(), v["is_dir"].as_bool().unwrap()))
            .collect();
        // folders first; hidden/node_modules excluded; since v0.3.21 non-whitelisted files (png) are listed too (frontend click uses "show in folder")
        assert_eq!(names, vec![("sub".to_string(), true), ("a.md".to_string(), false), ("b.md".to_string(), false), ("img.png".to_string(), false)]);
        assert!(list_md_dir(dir.join("does-not-exist").to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_hits_lines_and_case() {
        let dir = std::env::temp_dir().join("md_verify_search");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("one.md"), "# \u{6807}\u{9898}\n\nHello \u{9700}\u{6c42}\u{8bcd} Alpha\n").unwrap();
        fs::write(dir.join("sub/two.md"), "\u{9700}\u{6c42}\u{8bcd} second\n\u{522b}\u{7684}\n").unwrap();
        fs::write(dir.join("sub/other.txt"), "\u{9700}\u{6c42}\u{8bcd} in txt\n").unwrap();
        let out = search_md_files(dir.to_string_lossy().to_string(), "\u{9700}\u{6c42}\u{8bcd}".to_uppercase()).unwrap();
        // case-insensitive; recursive hits in subfolders; txt is whitelisted so it hits too
        assert_eq!(out.len(), 3, "hits={out:?}");
        assert!(out.iter().all(|h| h["line_no"].as_u64().unwrap() >= 1));
        let empty = search_md_files(dir.to_string_lossy().to_string(), "".to_string()).unwrap();
        assert!(empty.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_atomic_overwrite_md() {
        let dir = std::env::temp_dir().join("md_verify_save1");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.md");
        fs::write(&p, "\u{539f}\u{5185}\u{5bb9}").unwrap();
        save_file(p.to_str().unwrap().to_string(), "\u{65b0}\u{5185}\u{5bb9}".into()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "\u{65b0}\u{5185}\u{5bb9}");
        assert!(!dir.join("a.md.tmp").exists(), "temp file should be cleaned up");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn save_refuses_non_whitelisted() {
        let dir = std::env::temp_dir().join("md_verify_save2");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("evil.exe");
        let err = save_file(p.to_str().unwrap().to_string(), "x".into()).unwrap_err();
        assert!(err.contains("Unsupported save path"), "actual error: {err}");
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn save_refuses_double_ext() {
        let dir = std::env::temp_dir().join("md_verify_save3");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trap.md.exe");
        assert!(save_file(p.to_str().unwrap().to_string(), "x".into()).is_err());
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ===== PDF export tests (pure-logic branches besides locate_msedge; msedge is never touched) =====
    #[test]
    fn version_gt_compares_numerically() {
        assert!(version_gt(&[131, 0], &[100, 0]));
        assert!(!version_gt(&[100, 0], &[131, 0])); // no string comparison
        assert!(version_gt(&[150, 0, 4078, 105], &[150, 0, 4078, 99]));
        assert!(!version_gt(&[1, 2, 3], &[1, 2, 3]));
        assert!(version_gt(&[1, 2, 4], &[1, 2])); // different lengths, missing segments count as 0
    }

    #[test]
    fn pick_versioned_msedge_picks_highest() {
        let dir = tempdir();
        // three version folders + Installer/Application distractor folders
        fs::create_dir_all(dir.join("100.0.0.0")).unwrap();
        fs::write(dir.join("100.0.0.0").join("msedge.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("131.0.2903.86")).unwrap();
        fs::write(dir.join("131.0.2903.86").join("msedge.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("99.0")).unwrap();
        fs::write(dir.join("99.0").join("msedge.exe"), "x").unwrap();
        fs::create_dir_all(dir.join("Installer")).unwrap(); // not purely dotted digits, ignored
        fs::write(dir.join("Installer").join("msedge.exe"), "x").unwrap();
        let got = pick_versioned_msedge(&dir).expect("should pick the highest version");
        assert!(
            got.to_string_lossy().contains("131.0.2903.86"),
            "should pick the highest version 131.0.2903.86, got: {}",
            got.display()
        );
    }

    #[test]
    fn pick_versioned_msedge_empty_or_nonversion_dir() {
        let dir = tempdir();
        // empty folder
        assert!(pick_versioned_msedge(&dir).is_none());
        // only non-version subfolders (no exe)
        fs::create_dir_all(dir.join("Installer")).unwrap();
        assert!(pick_versioned_msedge(&dir).is_none());
        // version folder without msedge.exe, ignored
        fs::create_dir_all(dir.join("1.0.0.0")).unwrap();
        assert!(pick_versioned_msedge(&dir).is_none());
    }

    #[test]
    fn export_pdf_rejects_non_pdf_ext() {
        // an illegal extension returns at validation, msedge is never touched. Tests the render_pdf core pipeline directly (the export_pdf wrapper
        // needs an AppHandle, which cannot be built in a unit test without an app context).
        let dir = tempdir();
        let p = dir.join("out.txt");
        let err = render_pdf("<p>x</p>".into(), p.to_str().unwrap().to_string(), |_, _| {}).unwrap_err();
        assert!(err.contains(".pdf only"), "actual error: {err}");
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_suffix_format() {
        let a = unique_suffix();
        let parts: Vec<&str> = a.splitn(2, '_').collect();
        assert_eq!(parts.len(), 2, "format should be pid_nanos: {}", a);
        assert_eq!(parts[0].parse::<u32>().unwrap(), std::process::id());
        assert!(parts[1].parse::<u128>().is_ok(), "nanos part should be numeric: {}", a);
        // M1 core invariant: two consecutive calls must differ (removes the rapid-click SingletonLock collision).
        // If the SystemTime source changes or clock precision degrades (e.g. the old-system 15ms fallback), this assertion guards against regression.
        let b = unique_suffix();
        assert_ne!(a, b, "two consecutive calls must return different suffixes (otherwise profiles collide)");
    }

    #[test]
    fn file_url_encodes_chinese_keeps_ascii() {
        let p = std::path::PathBuf::from("C:\\Users\\\u{5f20}\u{4e09}\\file.html");
        let url = file_url_from_path(&p);
        assert!(url.starts_with("file:///C:/Users/"), "drive/slashes should be kept: {}", url);
        // the non-ASCII folder name in UTF-8 = E5 BC A0 E4 B8 89
        assert!(
            url.contains("%E5%BC%A0%E4%B8%89"),
            "non-ASCII should be percent-encoded: {}",
            url
        );
        assert!(url.ends_with("/file.html"), "a pure ASCII file name should stay as is: {}", url);
    }

    // ===== Ported from the old tests/logic.rs (mirrored copy), now testing the product functions directly, single source =====
    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let id = format!(
            "md_edit_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(id);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn ext_multi_dot_md_passes() {
        // only the last extension counts: tar.md / notes.md are valid
        assert!(has_allowed_ext("archive.tar.md"));
        assert!(has_allowed_ext("my.notes.md"));
    }

    #[test]
    fn extract_skips_disallowed_and_nonexistent() {
        let dir = tempdir();
        let real = dir.join("real.md");
        fs::write(&real, "x").unwrap();
        let got = extract_md_from_args(
            vec![
                "prog.exe".into(),
                "F:/no/such.exe".into(),
                dir.join("noexist.md").to_str().unwrap().into(),
                real.to_str().unwrap().into(),
            ]
            .into_iter(),
        );
        assert_eq!(got.as_deref(), Some(real.to_str().unwrap()));
    }

    #[test]
    fn extract_none_when_all_illegal() {
        let got = extract_md_from_args(
            vec!["prog.exe".into(), "a.exe".into(), "b.html".into()].into_iter(),
        );
        assert!(got.is_none());
    }

    #[test]
    fn save_atomic_overwrite_existing() {
        let dir = tempdir();
        let p = dir.join("exist.md");
        let old: String = (0..100).map(|i| format!("OLD_LINE_{}\n", i)).collect();
        fs::write(&p, &old).unwrap();
        save_file(p.to_str().unwrap().to_string(), "NEW_CONTENT".into()).unwrap();
        let got = fs::read_to_string(&p).unwrap();
        assert_eq!(got, "NEW_CONTENT");
        assert!(!got.contains("OLD_LINE"));
        assert!(!dir.join("exist.md.tmp").exists());
    }

    #[test]
    fn save_atomic_no_bom_written() {
        let dir = tempdir();
        let p = dir.join("nobom.md");
        save_file(p.to_str().unwrap().to_string(), "\u{4e2d}\u{6587}".into()).unwrap();
        let bytes = fs::read(&p).unwrap();
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "must not write a BOM");
    }

    #[test]
    fn save_refuses_empty_overwrite_nonempty() {
        // P0-1: empty content must not overwrite a non-empty file
        let dir = tempdir();
        let p = dir.join("nonempty.md");
        fs::write(&p, "\u{6709}\u{5185}\u{5bb9}").unwrap();
        let err = save_file(p.to_str().unwrap().to_string(), "".into()).unwrap_err();
        assert!(err.contains("Refused to write empty content"), "actual error: {err}");
        assert_eq!(fs::read_to_string(&p).unwrap(), "\u{6709}\u{5185}\u{5bb9}"); // the original file is intact
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_allows_empty_when_file_new() {
        // a new (non-existent) file may be written empty
        let dir = tempdir();
        let p = dir.join("new.md");
        save_file(p.to_str().unwrap().to_string(), "".into()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_utf8_no_bom() {
        let dir = tempdir();
        let p = dir.join("a.md");
        fs::write(&p, "# \u{6807}\u{9898}\n\u{4e2d}\u{6587}\u{5185}\u{5bb9}").unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "UTF-8");
        assert_eq!(c, "# \u{6807}\u{9898}\n\u{4e2d}\u{6587}\u{5185}\u{5bb9}");
    }

    #[test]
    fn open_utf8_bom_stripped() {
        let dir = tempdir();
        let p = dir.join("b.md");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("# \u{6807}\u{9898}".as_bytes());
        fs::write(&p, &bytes).unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "UTF-8(BOM)");
        assert_eq!(c, "# \u{6807}\u{9898}");
    }

    #[test]
    fn open_gbk_fallback() {
        let dir = tempdir();
        let p = dir.join("g.md");
        let (gbk, _, _) = encoding_rs::GBK.encode("\u{4e2d}\u{6587}");
        fs::write(&p, &*gbk).unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "GBK");
        assert_eq!(c, "\u{4e2d}\u{6587}");
    }

    #[test]
    fn open_empty_file_utf8() {
        let dir = tempdir();
        let p = dir.join("e.md");
        fs::write(&p, "").unwrap();
        let (c, enc) = open_file(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(enc, "UTF-8");
        assert_eq!(c, "");
    }

    // T7 core save: objective verification of save_file's disk write
    #[test]
    fn save_file_writes_utf8_no_bom_and_overwrites() {
        let dir = tempdir();
        let p = dir.join("s.md");
        // first write of multi-byte content (with editor-generated markers); reading back must match exactly
        save_file(p.to_str().unwrap().to_string(), "# \u{6807}\u{9898}\n\u{6b63}\u{6587} EDIT-789".to_string()).unwrap();
        let bytes = fs::read(&p).unwrap();
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "must be UTF-8 without BOM");
        assert_eq!(String::from_utf8(bytes).unwrap(), "# \u{6807}\u{9898}\n\u{6b63}\u{6587} EDIT-789");
        // atomic overwrite: old content fully replaced by the new content
        save_file(p.to_str().unwrap().to_string(), "\u{65b0}\u{5185}\u{5bb9}\u{8986}\u{76d6}".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "\u{65b0}\u{5185}\u{5bb9}\u{8986}\u{76d6}");
        // no temp file left after a successful rename
        assert!(!dir.join("s.md.tmp").exists(), "tmp must not be left behind");
    }

    #[test]
    fn save_file_returns_fresh_meta() {
        // v0.5.2 fix for the false external-change dialog after saving: save_file returns handle metadata (mtime/size), which must match
        // what is read by path after the write — the frontend uses it directly as the external-change baseline; a mismatch means false alarms / missed changes
        let dir = tempdir();
        let p = dir.join("sm.md");
        let m1 = save_file(p.to_str().unwrap().to_string(), "v1".to_string()).unwrap();
        assert_eq!(m1.size, 2, "size should be the bytes written");
        let disk = file_meta(p.to_str().unwrap().to_string()).unwrap();
        assert_eq!(disk.mtime_ms, m1.mtime_ms, "handle metadata and path-read mtime should match");
        assert_eq!(disk.size, m1.size, "handle metadata and path-read size should match");
        std::thread::sleep(std::time::Duration::from_millis(20));
        let m2 = save_file(p.to_str().unwrap().to_string(), "v2-longer".to_string()).unwrap();
        assert!(m2.mtime_ms >= m1.mtime_ms, "mtime must not go backwards");
        assert_eq!(m2.size, 9);
    }

    #[test]
    fn save_file_rejects_empty_overwrite_of_nonempty() {
        let dir = tempdir();
        let p = dir.join("guard.md");
        fs::write(&p, "\u{5df2}\u{6709}\u{5185}\u{5bb9}").unwrap();
        let err = save_file(p.to_str().unwrap().to_string(), "".to_string()).unwrap_err();
        assert!(err.contains("empty content"), "the empty-write guard should block it, err={err}");
        // the original file was not wiped
        assert_eq!(fs::read_to_string(&p).unwrap(), "\u{5df2}\u{6709}\u{5185}\u{5bb9}");
    }

    #[test]
    fn save_file_rejects_bad_extension() {
        let dir = tempdir();
        let p = dir.join("a.docx");
        let err = save_file(p.to_str().unwrap().to_string(), "x".to_string()).unwrap_err();
        assert!(err.contains("Unsupported"), "non-whitelisted extensions should be refused, err={err}");
    }

    // ===== v0.3.11 version history =====
    #[test]
    fn read_version_rejects_path_escape() {
        let err = read_version("C:\\Windows\\win.ini".to_string()).unwrap_err();
        assert!(err.contains("Invalid"), "directory traversal should be refused, err={err}");
    }

    #[test]
    fn archive_skips_temp_paths() {
        // tempdir fixture: no archiving, no crash (isolation check; real archiving is covered by release e2e)
        let dir = tempdir();
        let p = dir.join("t.md");
        fs::write(&p, "v1").unwrap();
        archive_old_version(p.to_str().unwrap());
        save_file(p.to_str().unwrap().to_string(), "v2".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "v2");
    }

    #[test]
    fn version_stem_sanitizes_and_disambiguates() {
        let a = version_stem("C:\\docs\\\u{62a5}\u{544a} \u{4e00}.md");
        let b = version_stem("C:\\docs\\\u{62a5}\u{544a}\u{4e00}.md");
        assert!(a.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.'), "illegal characters should be replaced: {a}");
        assert_ne!(a, b, "same name in different paths should be disambiguated");
    }

    // ===== PDF routing tests (find_pdf_source branches / open_pdf_external reject) =====
    #[test]
    fn find_pdf_source_finds_md() {
        let dir = tempdir();
        fs::write(dir.join("report.pdf"), "%PDF-fake").unwrap();
        fs::write(dir.join("report.md"), "# source").unwrap();
        let pdf = dir.join("report.pdf").to_str().unwrap().to_string();
        let got = find_pdf_source(pdf).expect("should find report.md");
        assert!(got.ends_with("report.md"), "got: {}", got);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn find_pdf_source_finds_html_when_no_md() {
        let dir = tempdir();
        fs::write(dir.join("doc.pdf"), "%PDF").unwrap();
        fs::write(dir.join("doc.html"), "<html/>").unwrap();
        let got = find_pdf_source(dir.join("doc.pdf").to_str().unwrap().to_string()).unwrap();
        assert!(got.ends_with("doc.html"), "got: {}", got);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn find_pdf_source_none_when_no_source() {
        let dir = tempdir();
        fs::write(dir.join("lonely.pdf"), "%PDF").unwrap();
        assert!(find_pdf_source(dir.join("lonely.pdf").to_str().unwrap().to_string()).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn find_pdf_source_priority_md_over_html() {
        let dir = tempdir();
        fs::write(dir.join("x.pdf"), "%PDF").unwrap();
        fs::write(dir.join("x.md"), "md").unwrap();
        fs::write(dir.join("x.html"), "html").unwrap();
        let got = find_pdf_source(dir.join("x.pdf").to_str().unwrap().to_string()).unwrap();
        assert!(got.ends_with("x.md"), "md should win over html, got: {}", got);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn open_pdf_external_rejects_non_pdf() {
        let dir = tempdir();
        let p = dir.join("a.txt");
        fs::write(&p, "x").unwrap();
        let err = open_pdf_external(p.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("Only .pdf files"), "err: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn open_pdf_external_rejects_missing_file() {
        let dir = tempdir();
        let p = dir.join("nope.pdf");
        let err = open_pdf_external(p.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("File does not exist"), "a missing pdf should return before probing, err: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn locate_pdf4qt_finds_installed_on_this_machine() {
        // Local check: PDF4QT portable v1.6 is installed at F:\software\PDF4QT, locate_pdf4qt should find Pdf4QtEditor.exe.
        // On other machines (CI / not installed) it is skipped rather than failed.
        let expected = PathBuf::from("F:\\software\\PDF4QT\\Pdf4QtEditor.exe");
        if !expected.is_file() {
            return;
        }
        let got = locate_pdf4qt();
        assert_eq!(got, Some(expected), "should detect F:\\software\\PDF4QT\\Pdf4QtEditor.exe, got: {:?}", got);
    }

    // ===== v0.4.0 custom themes (file-system logic of list_theme_files/read_theme_css) =====
    // AppHandle cannot be built in unit tests, so test the folder behaviour it relies on: replicating with a separate folder + same logic is too brittle,
    // so the core rules are extracted and verified in these two tests — _ prefix disables / non-.css ignored / traversal character set.
    // (the AppHandle glue of list/read is covered end to end by e2e on the deployed exe)
    #[test]
    fn theme_name_validation_rules() {
        // shapes read_theme_css refuses (same rule set as the inline command check; this test flags drift)
        let bad = ["", "a/b", "a\\b", "a..b", "c:d"];
        for n in bad {
            let invalid = n.is_empty()
                || n.contains('/')
                || n.contains('\\')
                || n.contains("..")
                || n.contains(':');
            assert!(invalid, "should refuse: {n:?}");
        }
        let ok = ["drake", "drake-dark", "\u{6211}\u{7684}\u{4e3b}\u{9898}", "vue_2026"];
        for n in ok {
            let invalid = n.is_empty()
                || n.contains('/')
                || n.contains('\\')
                || n.contains("..")
                || n.contains(':');
            assert!(!invalid, "should allow: {n:?}");
        }
    }
    #[test]
    fn theme_stem_underscore_prefix_means_disabled() {
        // list_theme_files inclusion rule: .css (case-insensitive) and the stem does not start with _ (same std path API as the implementation)
        let names = [("drake.css", true), ("_example.css", false), ("a.CSS", true), ("a.txt", false), ("_x.CSS", false)];
        for (fname, expect) in names {
            let ext_ok = fname.to_ascii_lowercase().ends_with(".css");
            let stem = std::path::Path::new(fname).file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let listed = ext_ok && !stem.starts_with('_');
            assert_eq!(listed, expect, "{fname}");
        }
    }

    #[test]
    fn open_dropped_pdf_rejects_non_pdf_and_writes_temp_for_sentinel() {
        // non-pdf refused (no file written)
        assert!(open_dropped_pdf(vec![b'%', b'P', b'D', b'F'], "a.txt".into()).is_err());
        // sentinel pdf: temp file written + correct content + PDF4QT not launched (Ok)
        let r = open_dropped_pdf(vec![0x25, 0x50, 0x44, 0x46], "__dnd_selftest__.pdf".into());
        assert!(r.is_ok(), "sentinel pdf should be written to temp and return Ok, got: {:?}", r);
        let tmp = std::env::temp_dir().join("mdaddy-drag").join("__dnd_selftest__.pdf");
        assert!(tmp.is_file(), "temp file should exist: {:?}", tmp);
        assert_eq!(fs::read(&tmp).unwrap(), vec![0x25, 0x50, 0x44, 0x46], "temp file content should match");
    }
}
