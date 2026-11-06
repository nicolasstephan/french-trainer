// Theme + style, shared by Nicolas's apps (hub: templates/styles/theme.js; copy into an app as js/theme.js with
// scripts/sync-styles.ps1, don't edit the copies).
// - Theme: light / dark. Follows the system setting unless Settings overrides it  -> <html data-theme>.
// - Style: the look on top of the theme. "standard" = the app's own CSS, "hud" = css/styles/hud.css (+ the app's
//   own hud mapping), or a custom style the app registers  -> <html data-style>. Default: the app's
//   <html data-default-style="..."> (new apps: "hud", Nicolas 2026-10-29), else "standard".
// Fires "themechange" so canvases and charts redraw (again once a style's fonts have arrived).
// In <head>, before the stylesheets (no flash of the wrong look; works under a strict CSP):
//   <script src="js/theme-init.js"></script>
// The HUD fonts are self-hosted (css/styles/fonts, @font-face in hud.css); `fonts` on a style is only for an
// app's custom style that needs a stylesheet URL.

const THEME_KEY = "theme";
const STYLE_KEY = "style";
const mq = matchMedia("(prefers-color-scheme: dark)");

/** Styles offered in Settings. An app adds its own with registerStyle({ id, label, fonts? }). */
export const STYLES = [
  { id: "standard", label: "Standard" },
  { id: "hud", label: "HUD" },
];
export function registerStyle(style) {
  if (!STYLES.some((s) => s.id === style.id)) STYLES.push(style);
}
const known = (id) => STYLES.some((s) => s.id === id);

// ?style=hud in the URL switches and remembers the style (for previews and links)
const fromUrl = new URLSearchParams(location.search).get("style");
if (known(fromUrl)) try { localStorage.setItem(STYLE_KEY, fromUrl); } catch { /* private mode */ }

export const getThemeMode = () => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } };
export function setThemeMode(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode: session only */ }
  applyTheme();
}

export function getStyle() {
  let id = null;
  try { id = localStorage.getItem(STYLE_KEY); } catch { /* private mode */ }
  id ??= fromUrl;
  const def = document.documentElement.dataset.defaultStyle;   // <html data-default-style="hud">: the app's default look
  return known(id) ? id : known(def) ? def : "standard";
}
export function setStyle(id) {
  try { localStorage.setItem(STYLE_KEY, id); } catch { /* private mode: session only */ }
  applyTheme();
}

export function applyTheme() {
  const mode = getThemeMode();
  const theme = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  const style = STYLES.find((s) => s.id === getStyle());
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.style = style.id;
  // a custom style's font stylesheet is only fetched while it is on
  if (style.fonts && !document.getElementById(`fonts-${style.id}`)) {
    document.head.insertAdjacentHTML("beforeend", `<link id="fonts-${style.id}" rel="stylesheet" href="${style.fonts}">`);
  }
  // canvases and charts measure text: redraw once the style's fonts are in
  document.fonts?.ready.then(() => dispatchEvent(new CustomEvent("themechange", { detail: theme })));
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  dispatchEvent(new CustomEvent("themechange", { detail: theme }));
  syncFavicon(theme);
}

// Favicon: the icon set's icon.svg picks its color with prefers-color-scheme, which Chrome evaluates against the OS
// (not the app's theme) and caches in the tab. Repaint each SVG icon link in the app's theme as a data: URL instead.
const favicons = new Map();   // file URL -> Promise<svg text>
async function syncFavicon(theme) {
  for (const link of document.querySelectorAll('link[rel~="icon"]')) {
    const src = link.dataset.src || link.getAttribute("href");
    if (!src || !/\.svg([?#]|$)/i.test(src)) continue;
    link.dataset.src = src;
    try {
      if (!favicons.has(src)) favicons.set(src, fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(r.status))));
      const text = await favicons.get(src);
      if (document.documentElement.dataset.theme !== theme) return;   // switched again meanwhile
      const color = theme === "dark" ? "#fff" : "#111";
      const fixed = text.replace(/<style>[^<]*prefers-color-scheme[^<]*<\/style>/, `<style>svg{color:${color}}</style>`);
      link.href = "data:image/svg+xml," + encodeURIComponent(fixed);
    } catch { favicons.delete(src); /* keep the file icon */ }
  }
}

mq.addEventListener("change", () => { if (getThemeMode() === "system") applyTheme(); });
applyTheme();
