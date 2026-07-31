// Shared helpers for the popup, the sites page and the tests. Loaded as a
// plain script before each page's own script; there is no bundler.
(() => {
  // Pages the extension can never run on. These are not user-manageable
  // sites and must never reach the allow-list.
  const INTERNAL_SCHEMES =
    /^(chrome|chrome-extension|moz-extension|edge|about|brave|opera|vivaldi|view-source|devtools|file|data|blob|javascript):/i;

  // Hostnames that only ever appear because a non-http URL was coerced into
  // one. `new URL("http://" + "chrome://extensions")` yields hostname
  // "chrome" — that is how "chrome" ended up stored as an active site.
  const INTERNAL_HOSTS = new Set([
    "chrome",
    "chrome-extension",
    "moz-extension",
    "about",
    "edge",
    "brave",
    "opera",
    "vivaldi",
    "file",
    "data",
    "blob",
    "localhost",
    "view-source",
    "devtools",
    "newtab",
  ]);

  function isInternalUrl(url) {
    return typeof url === "string" && INTERNAL_SCHEMES.test(url.trim());
  }

  // Returns a bare registrable hostname, or null when the input is not a
  // usable web domain. Rejects internal schemes outright rather than letting
  // them be coerced into a hostname.
  function normalizeDomain(raw) {
    if (typeof raw !== "string") return null;
    let s = raw.trim().toLowerCase();
    if (!s) return null;
    if (isInternalUrl(s)) return null;

    // A bare "example.com/path" has no scheme; give it one so URL can parse
    // it. Anything with a scheme we don't accept was rejected above.
    if (!/^https?:\/\//.test(s)) {
      if (/^[a-z][a-z0-9+.-]*:/.test(s)) return null; // some other scheme
      s = "http://" + s;
    }

    let host;
    try {
      host = new URL(s).hostname;
    } catch {
      return null;
    }
    if (!host) return null;
    if (host.startsWith("www.")) host = host.slice(4);
    return isValidDomain(host) ? host : null;
  }

  // A real domain has at least two dot-separated labels and a plausible TLD.
  // This is what keeps "chrome", "about" and stray words out of the list.
  function isValidDomain(host) {
    if (!host || INTERNAL_HOSTS.has(host)) return false;
    if (host.length > 253) return false;
    if (!host.includes(".")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true; // bare IPv4 is fine
    return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host);
  }

  // Drops entries that were never valid sites while leaving real domains
  // untouched. Runs on load so lists saved by earlier versions self-heal.
  function migrateSites(sites) {
    const kept = [];
    const removed = [];
    for (const raw of Array.isArray(sites) ? sites : []) {
      const normalized = normalizeDomain(raw);
      if (!normalized) {
        removed.push(raw);
      } else if (!kept.includes(normalized)) {
        kept.push(normalized);
      }
    }
    return { kept, removed, changed: removed.length > 0 || kept.length !== (sites || []).length };
  }

  const api = { normalizeDomain, isValidDomain, isInternalUrl, migrateSites };
  if (typeof window !== "undefined") window.WordpoolShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
