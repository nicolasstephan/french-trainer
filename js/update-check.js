// Stale-cache guard. GitHub Pages lets browsers cache files for 10 minutes, so right after a deploy
// a browser can mix a new page with old scripts. On start we compare the cached copy of every loaded
// file with the server's (ETag); if any differ, we refresh those cache entries and reload once.

const RELOAD_KEY = "ft.updateReloaded";

function loadedFiles() {
  const own = (url) => new URL(url, location.href).origin === location.origin;
  const files = performance.getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => own(u) && /\.(js|css)(\?|$)/.test(u));
  return [...new Set([location.href.split("#")[0], ...files])];
}

async function isStale(url) {
  try {
    // force-cache returns the cached copy even when expired (only-if-cached is unsupported in Safari)
    const [cached, fresh] = await Promise.all([
      fetch(url, { cache: "force-cache" }),
      fetch(url, { method: "HEAD", cache: "no-store" }),
    ]);
    const a = cached.headers.get("etag"), b = fresh.headers.get("etag");
    return cached.ok && fresh.ok && a && b && a !== b;
  } catch {
    return false; // not cached / offline: nothing to compare
  }
}

export async function checkForUpdate() {
  if (location.protocol !== "https:") return; // local development server: no long caching
  const files = loadedFiles();
  const stale = (await Promise.all(files.map(isStale))).some(Boolean);
  if (!stale) {
    sessionStorage.removeItem(RELOAD_KEY);
    return;
  }
  if (sessionStorage.getItem(RELOAD_KEY)) return; // reloaded once already: don't loop
  await Promise.all(files.map((u) => fetch(u, { cache: "reload" }).catch(() => {})));
  sessionStorage.setItem(RELOAD_KEY, "1");
  location.reload();
}
