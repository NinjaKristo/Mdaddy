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

## 2026-10-07 — Toolbar and brand sizing pass

### Requested visual changes

- Halve the main and Settings brand lockup, put the formatting toolbar on the same top row, align it to the right with a right inset, and let the row wrap when the window narrows.
- Remove the duplicate native Reader Mode control while retaining the book button at the same icon scale as its neighbors; remove button outlines around Reader, Find, and text color.
- Make the A control a single small box, visually matching the edit-mode icon scale.
- Replace the H/B/I toolbar glyphs with equal-size H, bold B, and italic i; visually reverse heading-menu sample sizes so H1 is smallest and H6 largest.
- Replace the quote glyph and task-list icon with the annotated teal quote and teal check inside a black square.

### Implementation

- Move Vditor's live toolbar into the app header after each mount. Remove any prior moved toolbar before attaching the rebuilt one so Preview/Raw remounts cannot duplicate it.
- Make the header row wrap and keep the formatter right aligned; the existing native fullscreen button remains as an invisible programmatic target for the single visible book control.
- Scale the main and Settings logo mark/wordmark to half their previous dimensions, and normalize the final three toolbar controls to icon-size hit areas without outer borders.
- Apply custom H/B/i, quotation-mark, and checkbox artwork, plus ascending visual font sizes for H1–H6 menu choices.

### Verification

- `npm run build` passed on final source (Vite emitted its existing large-chunk advisory).
- `cargo build --release --bins --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml` passed on final frontend output.
- Python E2E test modules passed `py_compile`.
- Live UI automation was not run: process 17632 is currently running `release/Mdaddy.exe`; the singleton forwarded the harness launch to that already-running window, so no CDP endpoint became available. I left that process untouched to protect the user's session.
- The compiled target executable is current and has been atomically copied to `release/Mdaddy.exe`; SHA-256 matches `src-tauri/target/release/mdaddy.exe` (`7D636CF87AEB893CF2951D90D792EABF9F830F28D2B76B36EEE11B52E23E3C8D`). The replaced executable was preserved as `release/Mdaddy.previous.exe`.
- Process 43864 was already running the prior image from the release path when the replacement happened, so that open window still needs a normal close/reopen before it can display the new toolbar.
- No Git commit/checkpoint created for this pass; the prior checkpoint remains `a3782fb`.

## 2026-10-07 — Make release executable the UI acceptance test

### Permanent rule

- Added the repository-level rule to `AGENTS.md` and `CLAUDE.md`: update `release/Mdaddy.exe` for UI deliveries, compare it byte-for-byte with the current release build, and test that release artifact rather than treating compilation as acceptance.
- `scripts/build-release.sh` now runs frontend build, Rust release build, copies and byte-compares the executable, then runs release smoke and UI-controls E2E tests.
- `tests/e2e/cdp.py` now defaults to `release/Mdaddy.exe` and checks for an already-running single instance before launching, with an explicit close-and-retry message.

### This release test

- `release/Mdaddy.exe` was updated from `src-tauri/target/release/mdaddy.exe`; the hashes match at `7D636CF87AEB893CF2951D90D792EABF9F830F28D2B76B36EEE11B52E23E3C8D`. `release/Mdaddy.previous.exe` preserves the previous build.
- `python tests/e2e/smoke.py` was attempted and correctly failed fast with “Close the running Mdaddy window…” because process 43864 still holds the single-instance lock. No test was counted as passing against that old in-memory UI.
- I left process 43864 untouched; run the release smoke and UI-controls checks after that window closes normally.

## 2026-10-07 — Toolbar counter and Windows icon refresh

### Fixes

- Hid Vditor's toolbar counter so the status bar retains its word/count display without an unrelated `4532` appearing between toolbar buttons.
- Rebuilt the Windows and app icon set from `Assets/MdaddyIcon-App.svg`, a square-padded vector derived from the supplied `Assets/MdaddyIcon.svg`. The generated ICO now contains sharp 16, 24, 32, 48, 64, and 256 pixel images.
- Made the release-copy script compatible with the installed PowerShell by calculating SHA-256 through .NET instead of `Get-FileHash`.

### Verification

- `npm run build` passed (existing Vite large-chunk advisory only).
- `cargo build --release --bins --features tauri/custom-protocol` passed.
- `release/Mdaddy.exe` was atomically replaced and its SHA-256 matches the build output: `BBC19FE46C7350277969D43651B3CD20741A40A01642CD98707F7B7E9B5B6B75`.
- Release smoke test was attempted and correctly stopped because the existing Mdaddy process holds the single-instance lock. The running window was left untouched; close and reopen it to load the new icon and toolbar fix, then rerun the release E2E tests.
