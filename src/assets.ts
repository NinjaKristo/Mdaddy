// App artwork lives in Assets/ as authored SVGs. Import as URLs so Vite rewrites
// every reference into a bundled, production-safe asset path (including Tauri).
export const APP_ASSETS = {
  logoMark: new URL("../Assets/MdaddyIcon.svg", import.meta.url).href,
  logoWordmark: new URL("../Assets/MdaddyTEXT.svg", import.meta.url).href,
  chevron: new URL("../Assets/ChevronIcon.svg", import.meta.url).href,
  settings: new URL("../Assets/settingsIcon.svg", import.meta.url).href,
  ai: new URL("../Assets/AI-sparkle.svg", import.meta.url).href,
  send: new URL("../Assets/send.svg", import.meta.url).href,
  recents: new URL("../Assets/recentsIcon.svg", import.meta.url).href,
  readerMode: new URL("../Assets/ReaderModeIcon.svg", import.meta.url).href,
  editMode: new URL("../Assets/editModeIcon.svg", import.meta.url).href,
  copy: new URL("../Assets/copy.svg", import.meta.url).href,
  collapseTools: new URL("../Assets/collaseTools.svg", import.meta.url).href,
  assetsFolder: new URL("../Assets/Mockup/assets.svg", import.meta.url).href,
  shareX: new URL("../Assets/Mockup/sharex.svg", import.meta.url).href,
  picturesFolder: new URL("../Assets/Mockup/picsfolder.svg", import.meta.url).href,
  fileClose: new URL("../Assets/Mockup/file-close.svg", import.meta.url).href,
} as const;
