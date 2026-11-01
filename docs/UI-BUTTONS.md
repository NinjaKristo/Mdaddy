# UI button and feature map

Use this map to trace a control from its visible label to its behavior and artwork. Most authored artwork lives in `Assets/`; Tauri's generated application icons come from `public/mdaddy-icon.svg` through `scripts/build-release.sh`.

## Main window

| Area | Control | Feature / behavior | Artwork or styling source | Behavior source |
| --- | --- | --- | --- | --- |
| Brand | `btn-brand-logo` | Show or hide sidebar | `Assets/MdaddyIcon.svg` via `src/assets.ts`; sizing and placement in `src/styles.css` | `src/main.ts` |
| Brand menu | `btn-brand-menu` | Open menu | Brand markup and CSS in `index.html`, `src/styles.css` | `src/main.ts` |
| Brand menu | `brand-settings`, `brand-ai`, `brand-send`, `brand-recents-toggle` | Settings, AI, send/share submenu, recent documents | `settings`, `ai`, `send`, `recents` entries in `src/assets.ts` | `src/main.ts`; send feature in `src/send.ts`; settings in `src/settings.ts` |
| Top bar | `btn-open`, `btn-save` | Open and save Markdown document | Text buttons, labels localized in `src/main.ts` | `src/main.ts` |
| Top bar | `btn-history`, `btn-diag` | Version history and diagnostics | Text buttons, `index.html` / `src/styles.css` | `src/main.ts` |
| Top bar | `btn-export`, `[data-export]` | Export PDF, styled/plain HTML, PNG, or DOCX | Text menu in `index.html` | `src/main.ts` |
| Top bar | `btn-print`, `btn-mode` | Print, switch edit mode | Text buttons | `src/main.ts` |
| Editor toolbar | `btn-reader-toggle` | Toggle reader mode | `Assets/ReaderModeIcon.svg` (`src/assets.ts`) | `src/main.ts` |
| Editor toolbar | `btn-toolbar-find`, `find-*`, `replace-*` | Find, regex, next/previous, replace | Find control styles in `src/styles.css`; text/glyph controls in `index.html` | `src/main.ts` |
| Editor toolbar | `text-color-button`, `[data-color]` | Choose text color | CSS swatches and glyph in `index.html`, `src/styles.css` | `src/main.ts` |
| Editor toolbar | Vditor `[data-type]` controls | Markdown formatting, lists, links, tables, undo/redo, etc. | Vditor toolbar configuration in `src/main.ts`; Vditor CSS in `node_modules/vditor`; overrides in `src/styles.css` | `src/main.ts`; editor supplied by Vditor |
| Sidebar | `side-tab-outline`, `side-tab-files`, `side-collapse` | Switch outline/files pane; collapse sidebar | Text/glyph controls in `index.html`, `src/styles.css` | `src/main.ts` |
| File tree | `ftree-mode-toggle`, `ftree-favs`, `ftree-refresh`, context `[data-act]` | Switch tree, manage favorites, refresh, open/create/rename/delete/reveal/copy paths | Text and Unicode glyphs in `index.html`; folder art in `Assets/Mockup/` | `src/main.ts`; favorites UI in `src/settings.ts` |
| Recents | `recent-clear` | Clear recent documents | Text button in `index.html` | `src/main.ts` |
| Status/zoom | `sb-side`, `sb-theme`, `sb-zoom`, `zoom-out`, `zoom-in`, `zoom-slider` | Sidebar, theme, document zoom | Theme/sidebar glyphs and CSS in `index.html`, `src/styles.css` | `src/main.ts` |
| Notifications | `ext-reload`, `ext-dismiss`, `big-doc-close` | Reload externally changed file, dismiss notice, close large-document notice | Text/glyph generated or styled in `index.html` / `src/styles.css` | `src/main.ts` |
| AI panel | `ai-refresh`, `ai-clear`, `ai-close`, `ai-send` | Refresh models, start chat, close panel, send prompt | Markup in `src/ai.ts`; `Assets/AI-sparkle.svg` and `Assets/send.svg` | `src/ai.ts`, `src/main.ts` |
| Other dialogs | `cc-*`, `hist-*`, `ftree-modal-*` | Close-with-changes choice, restore history, file-tree prompts | Markup in `index.html` | `src/main.ts` |

## Artwork catalog

`src/assets.ts` is the central import list for authored SVG/PNG artwork. Update the SVG/PNG in `Assets/` to tune an existing logo or icon; update the corresponding entry there only when changing the source file. Asset imports use Vite URL rewriting, so references remain valid in the packaged app.

| Asset key | Source | Current use |
| --- | --- | --- |
| `logoMark` | `Assets/MdaddyIcon.svg` | Brand mark |
| `logoWordmark` | `Assets/MdaddyTEXT.svg` | Wordmark where used |
| `chevron` | `Assets/ChevronIcon.svg` | Chevron affordances |
| `settings` | `Assets/settingsIcon.svg` | Brand menu/settings |
| `ai` | `Assets/AI-sparkle.svg` | AI menu |
| `send` | `Assets/send.svg` | Send menu/action |
| `recents` | `Assets/recentsIcon.svg` | Recents menu |
| `readerMode` | `Assets/ReaderModeIcon.svg` | Reader mode |
| `editMode` | `Assets/editModeIcon.svg` | Edit mode |
| `copy` | `Assets/copy.svg` | Copy actions |
| `collapseTools` | `Assets/collaseTools.svg` | Collapse tools |
| `assetsFolder`, `shareX`, `picturesFolder`, `fileClose` | `Assets/Mockup/*.svg` | Image and folder actions |

## App icon and release

`public/mdaddy-icon.svg` is the source for generated platform icons, including `src-tauri/icons/icon.ico`. `scripts/build-release.sh` regenerates them, builds frontend and executable, copies `release/Mdaddy.exe`, then runs the release smoke and UI-controls checks. Keep `release/Mdaddy.exe` in sync by running `bash scripts/build-release.sh` after UI or app-icon changes.

## Fine-tuning workflow

1. Find a control ID or label in `index.html` or `src/ai.ts`.
2. Follow its behavior source from this map. Dynamic wiring and feature logic usually live in `src/main.ts`, `src/settings.ts`, or `src/send.ts`.
3. Find image imports in `src/assets.ts`; find sizing, hover, color, and placement rules in `src/styles.css`.
4. For Vditor toolbar controls, inspect the toolbar list in `src/main.ts` and overrides in `src/styles.css`.
5. Rebuild the release after changes so the packaged EXE contains the current frontend and icons.
