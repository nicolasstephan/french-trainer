// Sets <html data-theme> and <html data-style> before the CSS loads, so the page never flashes the wrong look.
// Shared by Nicolas's apps (hub: templates/styles/theme-init.js). Load it as a plain, blocking script in <head>,
// before the stylesheets: <script src="js/theme-init.js"></script>. js/theme.js takes over afterwards.
try {
  var s = localStorage, d = document.documentElement, m = s.getItem("theme") || "system";
  d.dataset.theme = m === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : m;
  // an app's default look: <html data-default-style="hud"> (new apps since 2026-10-29), else "standard"
  d.dataset.style = new URLSearchParams(location.search).get("style") || s.getItem("style") || d.dataset.defaultStyle || "standard";
} catch (e) { /* storage blocked: system theme, the app's default style */ document.documentElement.dataset.style = document.documentElement.dataset.defaultStyle || "standard"; }
