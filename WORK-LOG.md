# Mdaddy Work Log

This log records recovery and implementation work, design decisions, and verification. Git checkpoints will be created only after the user accepts the result.

## 2026-10-07 — Restore the approved UI and make controls functional

### User reference

- `Assets/mdaddyVECTORS2.pdf` is the design reference. All 9 pages were rendered and reviewed.
- Page 1: maximized app layout and placement.
- Page 3: menu items crossed out in red are removals; keep the compact menu and the remaining shortcuts entry.
- Page 4: clicking the logo mark collapses the sidebar; the adjacent chevron is the menu opener.
- Page 5: remove the General settings section; call the welcome screen the Shortcut Screen; place the startup checkbox in Shortcuts settings and show shortcuts in the lower area of that settings page.
- Page 7: shortcut settings list with filter search; remove the red-marked descriptive wording and add user save/export.
- Pages 2, 6, 8, and 9 cover code-block layout, appearance settings, image settings, and the recents submenu.

### Reproduced defects

- Launched the current release executable with the repository CDP harness.
- Sidebar Outline, Find, text-color palette, Reader Mode, logo collapse, and menu buttons showed no response when activated.
- The toolbar controls were visible, but the Outline pane stayed hidden and the shortcut screen was not restored.
- CDP probe showed no click-driven state changes. This is a functional failure, not a rendering-only issue.
- Logo sizing in the current CSS is 45×45 px for the mark and 140×39 px for the wordmark; user reports the combined logo is too large.

### Root cause and first correction

- Captured startup errors from the running release build. `bindFileViewMenus()` dereferenced the removed `btn-file-menu` element, throwing before later UI bindings and `showWelcome()` ran. This explains why the Outline, Find, text-color, Reader Mode, logo, and shortcut-screen controls all appeared dead despite their individual handlers existing in source.
- Added a guard so the legacy File/View menu binder exits when its intentionally removed menu markup is absent. This lets the rest of startup continue; it still needs a clean rebuild and live verification.
- After rebuilding, a second removed control (`btn-find`) caused `bindFindBar()` to throw. Made that legacy hook optional; the PDF toolbar's magnifier has its own `btn-toolbar-find` handler.
- Rebuilt and confirmed startup now completes with no unhandled errors. Added Find-button toggle behavior and a focused E2E regression test for Outline/table of contents, logo collapse, chevron menu, Find, text-color application, Reader Mode, and the Shortcut Screen/settings.
- User clarified the brand lockup must be left-aligned in both the main app and settings, with the mark collapsing the sidebar and the chevron opening the same menu. Reduced main brand sizing and added the same functional brand controls to the Settings header.
- Replaced the old centered Welcome modal (280 px logo plus promotional highlights) with a dedicated Shortcut Screen: small left-aligned vector brand, Shortcuts heading, four-column key list, Settings and Close controls. The existing startup preference stays in Shortcuts settings and retains its saved key for compatibility.

### Next

- Continue against remaining PDF annotations as requested; this pass addresses brand placement/actions and the Shortcut Screen.

### Verification

- `npm run build` passed (Vite emitted only its existing large-chunk advisory).
- `cargo build --release --bins --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml` passed.
- `python tests/e2e/ui_controls.py`: 26/26 passed.
- `python tests/e2e/smoke.py`: 7/7 passed.
- Launched the newly copied `release/Mdaddy.exe` in an isolated profile: Shortcut Screen, main toolbar/Outline, logo collapse, and four-entry chevron menu passed 4/4 checks.
- SHA-256 of `release/Mdaddy.exe` matches `src-tauri/target/release/mdaddy.exe` (`21D1F970B9E9216B4A4B1BDFDBDE6844A471533BDDD09EE6EB444B4E2C86D39D`).
- No Git commit/checkpoint created; waiting for the user to accept the state.
