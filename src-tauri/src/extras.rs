//! Mdaddy extras: AI assistant backends, model-shelf discovery, known folders (Pictures / ShareX),
//! and launching external apps for the Send menu. Network access here is only ever user-initiated
//! (the AI panel), and plain-HTTP calls are restricted to the local machine.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ===== model shelf =====

#[derive(serde::Serialize)]
pub struct ShelfModel {
    name: String,
    path: String,
}

#[derive(serde::Serialize)]
pub struct ShelfModels {
    root: String,
    hf: Vec<ShelfModel>,
    unsloth: Vec<ShelfModel>,
    freetoken: Vec<ShelfModel>,
}

fn shelf_root(root: &str) -> PathBuf {
    if !root.trim().is_empty() {
        return PathBuf::from(root.trim());
    }
    std::env::var("MODEL_SHELF_ROOT").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(r"C:\Models"))
}

fn is_model_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("gguf") | Some("safetensors") | Some("ftw") | Some("bin")
    )
}

/// A folder counts as a model if it (or its direct children) holds weights or a config.json.
fn looks_like_model(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_file() && (is_model_file(&p) || p.file_name().map(|n| n == "config.json").unwrap_or(false)) {
            return true;
        }
    }
    false
}

/// Collect model folders under `dir`, up to two levels deep (publisher/repo layout), skipping HF cache internals.
fn collect_models(dir: &Path, out: &mut Vec<ShelfModel>, prefix: &str, depth: u32) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with("models--") || name == "cli" {
            continue;
        }
        let label = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if p.is_dir() {
            if looks_like_model(&p) {
                out.push(ShelfModel { name: label, path: p.to_string_lossy().to_string() });
            } else if depth > 0 {
                collect_models(&p, out, &label, depth - 1);
            }
        } else if p.is_file() && p.extension().map(|x| x == "gguf").unwrap_or(false) && !name.starts_with("mmproj") {
            out.push(ShelfModel { name: label, path: p.to_string_lossy().to_string() });
        }
    }
}

#[tauri::command]
pub fn ai_shelf_models(root: String) -> ShelfModels {
    let r = shelf_root(&root);
    let mut hf = Vec::new();
    collect_models(&r.join("safetensors").join("hf").join("models"), &mut hf, "", 1);
    collect_models(&r.join("gguf").join("misc"), &mut hf, "", 1);
    let mut unsloth = Vec::new();
    collect_models(&r.join("gguf").join("unsloth"), &mut unsloth, "", 1);
    collect_models(&r.join("safetensors").join("unsloth"), &mut unsloth, "", 1);
    let mut freetoken = Vec::new();
    collect_models(&r.join("freetoken"), &mut freetoken, "", 0);
    ShelfModels { root: r.to_string_lossy().to_string(), hf, unsloth, freetoken }
}

// ===== local HTTP (Ollama / OpenAI-compatible servers such as LM Studio, llama-server) =====

fn parse_local_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url.strip_prefix("http://").ok_or("only http:// endpoints on this machine are supported")?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|_| "bad port")?),
        None => (hostport.to_string(), 80),
    };
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") {
        return Err(format!("refusing non-local endpoint: {host} (only localhost is allowed)"));
    }
    Ok((host, port, path.to_string()))
}

fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        let Some(nl) = body[i..].windows(2).position(|w| w == b"\r\n") else { break };
        let size_str = String::from_utf8_lossy(&body[i..i + nl]);
        let size = usize::from_str_radix(size_str.split(';').next().unwrap_or("0").trim(), 16).unwrap_or(0);
        i += nl + 2;
        if size == 0 || i + size > body.len() {
            break;
        }
        out.extend_from_slice(&body[i..i + size]);
        i += size + 2;
    }
    out
}

fn http_request(method: &str, url: &str, body: Option<&str>, timeout_s: u64) -> Result<String, String> {
    let (host, port, path) = parse_local_url(url)?;
    let addr = format!("{}:{}", if host == "localhost" { "127.0.0.1" } else { host.trim_matches(['[', ']']) }, port);
    let mut s = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("{e}"))?,
        Duration::from_secs(3),
    )
    .map_err(|e| format!("cannot reach {url} ({e}). Is the server running?"))?;
    s.set_read_timeout(Some(Duration::from_secs(timeout_s))).ok();
    let body = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| format!("reading response: {e}"))?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed HTTP response")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let payload = &raw[split + 4..];
    let status: u16 = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let bytes = if chunked { decode_chunked(payload) } else { payload.to_vec() };
    let text = String::from_utf8_lossy(&bytes).to_string();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {}", text.chars().take(400).collect::<String>()));
    }
    Ok(text)
}

#[tauri::command]
pub async fn ai_http(method: String, url: String, body: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || http_request(&method, &url, body.as_deref(), 600))
        .await
        .map_err(|e| e.to_string())?
}

// ===== Claude Pro (Claude Code CLI) / ChatGPT Plus (Codex CLI) =====

fn find_cli(name: &str, configured: &str) -> Option<PathBuf> {
    if !configured.trim().is_empty() {
        let p = PathBuf::from(configured.trim());
        return if p.exists() { Some(p) } else { None };
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let candidates: Vec<PathBuf> = match name {
        "claude" => vec![
            PathBuf::from(&home).join(".local").join("bin").join("claude.exe"),
            PathBuf::from(&appdata).join("npm").join("claude.cmd"),
        ],
        _ => vec![
            PathBuf::from(&appdata).join("npm").join("codex.cmd"),
            PathBuf::from(&home).join(".local").join("bin").join("codex.exe"),
        ],
    };
    if let Some(p) = candidates.into_iter().find(|p| p.exists()) {
        return Some(p);
    }
    // fall back to PATH
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(';') {
        for ext in ["exe", "cmd"] {
            let p = PathBuf::from(dir).join(format!("{name}.{ext}"));
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

fn run_cli(exe: &Path, args: &[String], stdin_text: &str, cwd: &Path) -> Result<(String, String), String> {
    let is_cmd = exe.extension().map(|e| e.eq_ignore_ascii_case("cmd")).unwrap_or(false);
    let mut cmd = if is_cmd {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(stdin_text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        return Err(format!("{} exited with {}: {}", exe.display(), out.status, stderr.chars().take(600).collect::<String>()));
    }
    Ok((stdout, stderr))
}

#[tauri::command]
pub async fn ai_cli(provider: String, prompt: String, model: String, exe_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = if provider == "codex" { "codex" } else { "claude" };
        let exe = find_cli(name, &exe_path).ok_or_else(|| {
            format!("{name} CLI not found. Install it (and sign in once with your subscription) or set its path in Settings > AI.")
        })?;
        // empty scratch folder as working dir, so the CLI has nothing on disk to touch
        let cwd = std::env::temp_dir().join("mdaddy-ai");
        std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
        if name == "claude" {
            let mut args = vec!["-p".to_string(), "--output-format".into(), "text".into(), "--tools".into(), "".into()];
            if !model.trim().is_empty() {
                args.push("--model".into());
                args.push(model.trim().into());
            }
            let (out, _) = run_cli(&exe, &args, &prompt, &cwd)?;
            Ok(out.trim().to_string())
        } else {
            let last = cwd.join(format!("codex-last-{}.txt", std::process::id()));
            let _ = std::fs::remove_file(&last);
            let mut args = vec![
                "exec".to_string(),
                "--skip-git-repo-check".into(),
                "--sandbox".into(),
                "read-only".into(),
                "--ephemeral".into(),
                "--color".into(),
                "never".into(),
                "-o".into(),
                last.to_string_lossy().to_string(),
            ];
            if !model.trim().is_empty() {
                args.push("-m".into());
                args.push(model.trim().into());
            }
            args.push("-".into());
            let (out, _) = run_cli(&exe, &args, &prompt, &cwd)?;
            let msg = std::fs::read_to_string(&last).unwrap_or(out);
            let _ = std::fs::remove_file(&last);
            Ok(msg.trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn ai_cli_available(exe_claude: String, exe_codex: String) -> (bool, bool) {
    (find_cli("claude", &exe_claude).is_some(), find_cli("codex", &exe_codex).is_some())
}

// ===== known folders: Pictures / ShareX =====

fn sharex_screens_root() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok()?;
    let docs = PathBuf::from(&home).join("Documents").join("ShareX");
    let cfg = std::fs::read_to_string(docs.join("ApplicationConfig.json")).ok();
    if let Some(v) = cfg.and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok()) {
        if v.get("UseCustomScreenshotsPath").and_then(|x| x.as_bool()) == Some(true) {
            if let Some(p) = v.get("CustomScreenshotsPath").and_then(|x| x.as_str()) {
                if !p.is_empty() {
                    return Some(PathBuf::from(p));
                }
            }
        }
    }
    let d = docs.join("Screenshots");
    if d.exists() { Some(d) } else { None }
}

/// The most recently modified sub-folder of ShareX's screenshot folder (ShareX makes one per day/month).
pub fn sharex_recent_dir() -> Option<PathBuf> {
    let root = sharex_screens_root()?;
    let newest = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    Some(newest.map(|e| e.path()).unwrap_or(root))
}

#[tauri::command]
pub fn known_folders() -> serde_json::Value {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let pictures = PathBuf::from(&home).join("Pictures");
    serde_json::json!({
        "pictures": pictures.to_string_lossy(),
        "sharexRoot": sharex_screens_root().map(|p| p.to_string_lossy().to_string()),
        "sharexRecent": sharex_recent_dir().map(|p| p.to_string_lossy().to_string()),
    })
}

/// Resolve the image folder setting: "" = next to the document, "sharex:recent" = newest ShareX folder, else a path.
pub fn resolve_image_dir(setting: &str) -> Option<PathBuf> {
    let s = setting.trim();
    if s.is_empty() {
        None
    } else if s == "sharex:recent" {
        sharex_recent_dir()
    } else {
        Some(PathBuf::from(s))
    }
}

/// Scratch folder for previews / temp copies sent to other apps.
#[tauri::command]
pub fn temp_dir_path() -> Result<String, String> {
    let d = std::env::temp_dir().join("Mdaddy");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().to_string())
}

// ===== Send to app =====

fn find_vscode() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    [
        PathBuf::from(&pf).join("Microsoft VS Code").join("Code.exe"),
        PathBuf::from(&local).join("Programs").join("Microsoft VS Code").join("Code.exe"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

fn find_firefox() -> Option<PathBuf> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
    [
        PathBuf::from(&pf).join("Mozilla Firefox").join("firefox.exe"),
        PathBuf::from(&pf86).join("Mozilla Firefox").join("firefox.exe"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

/// Launch an app with arguments. `program` may be "vscode" / "firefox" (auto-detected) or a full exe path.
#[tauri::command]
pub fn launch_app(program: String, args: Vec<String>) -> Result<(), String> {
    let exe = match program.as_str() {
        "vscode" => find_vscode().ok_or("VS Code not found (looked in Program Files and LocalAppData\\Programs)")?,
        "firefox" => find_firefox().ok_or("Firefox not found in Program Files")?,
        p => {
            let pb = PathBuf::from(p);
            if !pb.exists() {
                return Err(format!("Program not found: {p}"));
            }
            pb
        }
    };
    Command::new(&exe).args(&args).spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    Ok(())
}

#[tauri::command]
pub fn send_targets_available() -> serde_json::Value {
    let obsidian = {
        #[cfg(windows)]
        {
            Command::new("reg")
                .args(["query", r"HKCR\obsidian"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    };
    serde_json::json!({
        "obsidian": obsidian,
        "vscode": find_vscode().is_some(),
        "firefox": find_firefox().is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_url_parsing() {
        assert_eq!(parse_local_url("http://localhost:11434/api/tags").unwrap(), ("localhost".into(), 11434, "/api/tags".into()));
        assert_eq!(parse_local_url("http://127.0.0.1:1234").unwrap().2, "/");
        assert!(parse_local_url("http://example.com:80/x").is_err(), "remote hosts must be refused");
        assert!(parse_local_url("https://localhost/x").is_err(), "only plain http to localhost");
    }

    #[test]
    fn chunked_decoding() {
        let body = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body), b"Wikipedia");
    }

    #[test]
    fn image_dir_setting() {
        assert_eq!(resolve_image_dir(""), None);
        assert_eq!(resolve_image_dir("  "), None);
        assert_eq!(resolve_image_dir(r"D:\pics"), Some(PathBuf::from(r"D:\pics")));
    }

    #[test]
    fn shelf_scan_finds_models() {
        let root = std::env::temp_dir().join(format!("mdaddy-shelf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("gguf/unsloth/Qwen3-32B")).unwrap();
        std::fs::write(root.join("gguf/unsloth/Qwen3-32B/q.gguf"), b"x").unwrap();
        std::fs::create_dir_all(root.join("freetoken/gemma")).unwrap();
        std::fs::write(root.join("freetoken/gemma/config.json"), b"{}").unwrap();
        std::fs::create_dir_all(root.join("safetensors/hf/models/pub/repo")).unwrap();
        std::fs::write(root.join("safetensors/hf/models/pub/repo/model.safetensors"), b"x").unwrap();
        let m = ai_shelf_models(root.to_string_lossy().to_string());
        assert_eq!(m.unsloth.len(), 1);
        assert_eq!(m.freetoken[0].name, "gemma");
        assert_eq!(m.hf[0].name, "pub/repo");
        let _ = std::fs::remove_dir_all(&root);
    }
}
