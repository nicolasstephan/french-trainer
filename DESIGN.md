# Design baseline for new projects (GUI)

Starting point for every new project with an interface. Copy into the project as `DESIGN.md` and adapt.
Source: the Landscape Prototype viewer (`landscape-prototype`, `app/viewer/index.html`); its
settings are copied here. The one deliberate difference: the page background is **white** in light mode
and **dark gray** in dark mode (the viewer uses `#e7e8ea` and `#0d0d0f`).
Applied to: digital-library website, fitness-assistant (2026-10-17).
Existing apps keep their short color names (e.g. `--muted`, `--border`, `--panel`) as aliases onto these tokens.

## Style
- **HUD is the default style of every new app** (Nicolas, 2026-10-29): put `data-default-style="hud"` on `<html>`,
  load the shared layer (`templates/styles`, see its README) and map the app's own parts in `css/hud.css`.
  Standard (the look described below) stays selectable in the app's Style setting. Existing apps keep Standard
  as default unless Nicolas says otherwise.

## Theme
- **Follows the system setting** (`prefers-color-scheme`) and switches live when it changes.
- Settings offer an override, **System / Light / Dark**, default System, remembered per device.
- **Color is for data only** (Nicolas, 2026-10-22). Each data type gets its own color (e.g. fitness-assistant:
  muscles red / orange, volume blues, planned-workout muscles green, chart series, good / bad verdicts).
  Everything general stays grayscale: selection, tabs, pressed toggles, main buttons, links, status, errors.
  The accent is therefore neutral: `--accent` `#1b1c1f` with white text in light mode, `#e4e4e7` with
  `#1b1c1f` text in dark mode; links are text-colored and underlined.
  (Until 2026-10-22 this was one blue accent `#2f6bf0` / `#3a6df0`; older apps may still use it.)
- Everything drawn follows the theme too: 3D scene background (`--bg`), map basemap (light/dark style),
  canvas and chart colors (read from the CSS variables on every theme change).
- Font: `system-ui, sans-serif`.

## Tokens (Landscape Prototype)
Set on `<html data-theme="light|dark">`. Components use only these variables, never hard-coded colors.
```css
:root, [data-theme="light"] {
  --bg:#ffffff; --text:#1b1c1f; --text-mid:#33353a; --text-dim:#5f636a;
  --panel-bg:rgba(247,248,250,.94); --panel-border:#cfd2d8; --sec-border:#dde0e5;
  --btn-bg:#e8eaee; --btn-border:#c2c5cc; --btn-text:#23252a; --btn-hover:#d6d9df;
  --accent:#1b1c1f; --accent-text:#fff; --link:#1b1c1f;
  --popup-bg:rgba(250,250,252,.97); --popup-border:#cfd2d8; --input-bg:#fff; --input-border:#c2c5cc;
  color-scheme: light;
}
[data-theme="dark"] {
  --bg:#1e1f22; --text:#eee; --text-mid:#bbb; --text-dim:#888;
  --panel-bg:rgba(20,20,24,.92); --panel-border:#333; --sec-border:#2a2a30;
  --btn-bg:#26262e; --btn-border:#3a3a44; --btn-text:#ddd; --btn-hover:#33333d;
  --accent:#e4e4e7; --accent-text:#1b1c1f; --link:#eee;
  --popup-bg:rgba(20,20,24,.96); --popup-border:#444; --input-bg:#26262e; --input-border:#3a3a44;
  color-scheme: dark;
}
```

## Components (Landscape Prototype)
```css
html, body { background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; }
/* floating panel over a canvas/map */
.panel { background:var(--panel-bg); border:1px solid var(--panel-border); border-radius:10px;
  padding:12px 14px; backdrop-filter:blur(6px); }
.panel h2 { margin:0 0 8px; font-size:.85rem; letter-spacing:.5px; color:var(--text-mid); }
.sec { margin:10px 0; border-top:1px solid var(--sec-border); padding-top:8px; }   /* panel sections */
.lbl { font-size:.68rem; color:var(--text-dim); text-transform:uppercase; letter-spacing:.6px; margin-bottom:5px; }
button { background:var(--btn-bg); color:var(--btn-text); border:1px solid var(--btn-border); border-radius:6px;
  padding:5px 9px; cursor:pointer; }
button:hover { background:var(--btn-hover); }
button.on, button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-text); }  /* toggled / main action */
select, input { background:var(--input-bg); color:var(--btn-text); border:1px solid var(--input-border); }
/* icon buttons in a corner: 36 x 34, panel background, blurred */
.corner-btn { background:var(--panel-bg); border:1px solid var(--btn-border); color:var(--text); border-radius:8px;
  width:36px; height:34px; backdrop-filter:blur(6px); }
/* modal (options, tables): dimmed backdrop, panel-styled window */
.modal { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; }
.modal-win { background:var(--panel-bg); border:1px solid var(--panel-border); border-radius:12px; padding:16px 18px;
  backdrop-filter:blur(10px); max-height:82vh; overflow:auto; }
```
Layout pattern: full-screen canvas or map, floating panels on top (controls top left, details top right,
mode switch top center, icon buttons bottom right, options in a modal).

## Theme switch (JS)
In `<head>`, before the stylesheet loads, so there is no flash of the wrong theme:
```html
<meta name="theme-color" content="#ffffff">
<script>try{var m=localStorage.getItem("theme")||"system";document.documentElement.dataset.theme=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m}catch(e){}</script>
```
And as a module (`theme.js`), imported by the app:
```js
const KEY = "theme";
const mq = matchMedia("(prefers-color-scheme: dark)");
export const getThemeMode = () => { try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; } };
export function setThemeMode(mode) { try { localStorage.setItem(KEY, mode); } catch {} applyTheme(); }
export function applyTheme() {
  const mode = getThemeMode();
  const theme = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  dispatchEvent(new CustomEvent("themechange", { detail: theme }));   // canvases, maps, charts redraw on this
}
mq.addEventListener("change", () => { if (getThemeMode() === "system") applyTheme(); });
applyTheme();
```
Settings: `<select>` with System / Light / Dark calling `setThemeMode()`.

## Phone (learned on fitness-assistant)
- Form fields at least 16px (iOS zooms otherwise); tap targets at least 40px.
- A panel under a 3D view or map gets at least 60% of the height and can expand to full screen.
- No horizontal page scroll; wide tables scroll inside their card.

## App icon
Every app gets an icon from the shared set in the hub, `$env:HUB\templates\icons` (generator `make_icons.py`, preview `preview.html`).
Style: minimal sci-fi, monochrome, transparent background, drawn in `currentColor`.
- **Shared frame:** square marker top left, vertical code label bottom left (2 letters + number, e.g. `DL-522`,
  reading bottom to top in the squared stroke font), micro bars beside it. No scale/ruler line.
- **Glyph:** one bold geometric shape on the right that says what the app does, plus exactly one hatched element.
  No outlines-only sets, no color, no gradients. At 16-48 px only the glyph is used.
- **New app or project logo:** add a `g_<name>()` glyph and an `APPS` entry, run `python make_icons.py <key>`, check `preview.html`.
  Always: the icon folder name is the project's INDEX key (`templates/icons/<key>/icon.svg`), so the Cockpit
  project grid and detail pick it up automatically. Also always put a desktop shortcut on the Desktop (`<Name>.lnk`,
  icon `icon-outline.ico` from the hub set): it launches the app, or opens the project folder if there is no app yet.
  An app also gets a `- **Start:** `<command>`` line in its hub note (below `Path`): the Cockpit project detail then
  shows **▶ Start**. The command is relative to the project folder (`.ps1` / `.bat` / `.py` / `.pyw`, a `.venv` is used
  if present) or a URL (Chrome; on the phone it opens there).
- **Which file where:**
  - Desktop / Start menu shortcut: `icon-outline.ico` (black mark, thin white outline: readable on any wallpaper)
  - Browser tab: `icon.svg` (follows light/dark); Streamlit or other PNG-only tabs: `icon-outline-small-64.png`
  - iOS home screen / web manifest: `icon-tile-180.png`, `icon-tile-512.png` (white mark on a dark tile)
- Applied to (2026-10-17): Hub, Digital Library, Fitness Assistant, Residency Assistant, Landscape Prototype,
  PointCloudPrinter, Gaussian Splat Prototype; Cockpit (`CP-01`, artificial horizon) 2026-10-23;
  TurtleBot (`TB-03`, Burger with lidar) 2026-10-27; Personal Server (`PS-01`, rack + power) 2026-10-27.
- Inside an app, draw set icons as a CSS mask filled with `currentColor` (Cockpit `.glyph`), not as `<img>`:
  the SVG's own light/dark switch follows the system, not a theme override in Settings.

## Style references (HUD)
`templates/references/` holds Nicolas's GUI mood images (game HUDs, Animus UI, the icon reference) and a
`README.md` that turns them into usable concepts: `+` grids, corner brackets, hairlines, number + micro-label,
one signal color, crosshair focus. Since 2026-10-22 a **shared style** for all apps: `templates/styles/`
(`hud.css` shared layer, `theme.js` theme + style switch, README), copied into the apps with
`scripts/sync-styles.ps1`; Settings → Style → Standard / HUD (or an app's own custom style). In use: Digital
Library, Fitness Assistant, Landscape Prototype viewer, Gaussian Splat Prototype, Residency Assistant (Streamlit
version `templates/styles/streamlit/hud.toml`). Fonts self-hosted. Grayscale base; color only for data and categories.

## Palettes (Cockpit theme builder)
Since 2026-10-23 the colors of the shared styles (and the data colors `--data-1..`) are edited in Cockpit > Themes
and reach every app through `templates/styles/palette.css` (see `templates/styles/README.md`).

## Before shipping
- Check System, Light and Dark, and switch the system setting while the app is open.
- Desktop and 390px phone width.
- The app has its icon from the set (see App icon).
