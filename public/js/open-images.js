/**
 * Open food photography waterfall (Openverse -> Wikimedia Commons -> TheMealDB -> Wikipedia).
 * Zero dependencies and zero Node-only APIs: runs cleanly in Browser, Node, and Cloudflare Workers.
 */

const FILLER_ADJECTIVES = new Set([
  "easy", "quick", "weeknight", "simple", "crispy", "crisp", "crisp-edged",
  "homemade", "classic", "best", "ultimate", "spicy", "smoky", "warm", "cold",
  "fresh", "roasted", "seared", "charred", "pan", "pan-crisped", "glazed",
  "creamy", "bright", "velvety", "silky", "sticky", "golden", "light", "one-pan"
]);

function safeHeaders() {
  if (typeof window === "undefined") {
    return { "User-Agent": "MiseRecipeApp/1.0 (+https://github.com/Hootsworth/Mise)" };
  }
  return {};
}

function isSafeHttpsImage(url) {
  return typeof url === "string" && /^https:\/\/.+/i.test(url);
}

function isRasterFilename(name = "") {
  return !/\.(svg|pdf|ogv|webm|tiff?)$/i.test(String(name));
}

/**
 * Builds deduplicated search queries from a full dish title down to core culinary nouns.
 */
export function buildSearchQueries(title = "", cuisine = "") {
  const clean = String(title || "")
    .replace(/['"“”‘’()]/g, " ")
    .replace(/&/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];

  const out = [clean];
  const coreWords = clean
    .split(" ")
    .filter((w) => !FILLER_ADJECTIVES.has(w.toLowerCase()))
    .slice(0, 4);
  const core = coreWords.join(" ").trim();
  if (core && core.toLowerCase() !== clean.toLowerCase()) {
    out.push(core);
  }
  if (coreWords.length > 2) {
    const tail = coreWords.slice(-2).join(" ");
    if (!out.some((q) => q.toLowerCase() === tail.toLowerCase())) {
      out.push(tail);
    }
  }
  if (cuisine && !clean.toLowerCase().includes(String(cuisine).toLowerCase())) {
    out.push(`${core || clean} ${cuisine}`.trim());
  }
  return out;
}

export async function fetchOpenversePhoto(query, excludeSet = new Set(), fetchImpl = fetch, signal) {
  const q = String(query || "").trim();
  if (!q) return null;
  const url =
    "https://api.openverse.org/v1/images/" +
    `?q=${encodeURIComponent(`${q} food dish`)}&category=photograph&aspect_ratio=wide&page_size=8`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...safeHeaders() },
      signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results = Array.isArray(json?.results) ? json.results : [];
    for (const item of results) {
      const candidate = item?.thumbnail || item?.url;
      if (!isSafeHttpsImage(candidate) || excludeSet.has(candidate)) continue;
      if (item?.width != null && Number(item.width) > 0 && Number(item.width) < 400) continue;
      return {
        imageUrl: candidate,
        source: "openverse",
        credit: item?.creator ? `Openverse · ${item.creator}` : "Openverse",
        creditUrl: item?.foreign_landing_url || item?.detail_url || ""
      };
    }
  } catch {
    // Fall through cleanly
  }
  return null;
}

export async function fetchWikimediaCommonsPhoto(query, excludeSet = new Set(), fetchImpl = fetch, signal) {
  const q = String(query || "").trim();
  if (!q) return null;
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${q} food`,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|mime|dimensions",
    iiurlwidth: "960",
    format: "json",
    origin: "*"
  });
  try {
    const res = await fetchImpl(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
      method: "GET",
      headers: safeHeaders(),
      signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pages = Object.values(json?.query?.pages || {}).sort(
      (a, b) => (a.index ?? 99) - (b.index ?? 99)
    );
    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      if (!info) continue;
      const mime = String(info.mime || "").toLowerCase();
      if (!/^image\/(jpeg|jpg|png|webp)$/.test(mime)) continue;
      if (!isRasterFilename(page.title)) continue;
      const width = Number(info.thumbwidth || info.width || 0);
      if (width > 0 && width < 400) continue;
      const candidate = info.thumburl || info.url;
      if (!isSafeHttpsImage(candidate) || excludeSet.has(candidate)) continue;
      return {
        imageUrl: candidate,
        source: "wikimedia",
        credit: "Wikimedia Commons",
        creditUrl: info.descriptionurl || ""
      };
    }
  } catch {
    // Fall through cleanly
  }
  return null;
}

export async function fetchMealDbPhoto(query, excludeSet = new Set(), fetchImpl = fetch, signal) {
  const q = String(query || "").trim();
  if (!q) return null;
  try {
    const res = await fetchImpl(
      `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`,
      { method: "GET", signal }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const meals = Array.isArray(json?.meals) ? json.meals : [];
    for (const meal of meals) {
      const candidate = meal?.strMealThumb;
      if (!isSafeHttpsImage(candidate) || excludeSet.has(candidate)) continue;
      return {
        imageUrl: candidate,
        source: "themealdb",
        credit: "TheMealDB",
        creditUrl: meal?.strSource || ""
      };
    }
  } catch {
    // Fall through cleanly
  }
  return null;
}

export async function fetchWikipediaPhoto(query, excludeSet = new Set(), fetchImpl = fetch, signal) {
  const q = String(query || "").trim();
  if (!q) return null;
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${q} dish food`,
    gsrlimit: "5",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: "960",
    format: "json",
    origin: "*"
  });
  try {
    const res = await fetchImpl(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
      method: "GET",
      headers: safeHeaders(),
      signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pages = Object.values(json?.query?.pages || {}).sort(
      (a, b) => (a.index ?? 99) - (b.index ?? 99)
    );
    for (const page of pages) {
      const src = page?.thumbnail?.source;
      if (!isSafeHttpsImage(src) || excludeSet.has(src)) continue;
      if (!/^https:\/\/upload\.wikimedia\.org\//i.test(src)) continue;
      return {
        imageUrl: src,
        source: "wikipedia",
        credit: "Wikipedia · Wikimedia",
        creditUrl: ""
      };
    }
  } catch {
    // Fall through cleanly
  }
  return null;
}

/**
 * Resolves an open-license / open-API dish photo via:
 * Openverse -> Wikimedia Commons -> TheMealDB -> Wikipedia.
 */
export async function fetchOpenDishPhoto({
  title,
  cuisine = "",
  excludeUrls = [],
  fetchImpl = fetch,
  signal
}) {
  const queries = buildSearchQueries(title, cuisine);
  if (!queries.length) {
    return { imageUrl: null, source: "none", credit: "", creditUrl: "" };
  }
  const excludeSet = new Set(Array.isArray(excludeUrls) ? excludeUrls : []);

  // Try full query across primary visual search sources, then simplified fallback queries
  for (const q of queries) {
    const ov = await fetchOpenversePhoto(q, excludeSet, fetchImpl, signal);
    if (ov) return ov;

    const wm = await fetchWikimediaCommonsPhoto(q, excludeSet, fetchImpl, signal);
    if (wm) return wm;

    const mdb = await fetchMealDbPhoto(q, excludeSet, fetchImpl, signal);
    if (mdb) return mdb;

    const wp = await fetchWikipediaPhoto(q, excludeSet, fetchImpl, signal);
    if (wp) return wp;
  }

  return { imageUrl: null, source: "none", credit: "", creditUrl: "" };
}
