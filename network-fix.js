/*
 * SkySphere Live network reliability layer.
 *
 * ADS-B providers do not all expose identical browser CORS behaviour. This
 * wrapper keeps direct requests first, tries controlled relay fallbacks, and
 * can reuse a recent response for the exact same provider/location request.
 * The application labels cached data and accounts for its real age.
 */
(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const MAX_STALE_CACHE_MS = 90_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const APPROVED_HOSTS = new Set([
    "api.airplanes.live",
    "api.adsb.fi",
    "api.adsb.lol"
  ]);

  const lastGoodByTarget = new Map();
  let puterLoadPromise = null;

  function isAdsbRequest(input) {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw, location.href);
      return APPROVED_HOSTS.has(url.hostname) && url.pathname.startsWith("/v2/");
    } catch {
      return false;
    }
  }

  function targetUrl(input) {
    return input instanceof Request ? input.url : String(input);
  }

  function responseFromText(text, source, { stale = false, cacheAgeMs = 0 } = {}) {
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-SkySphere-Source": source,
        "X-SkySphere-Stale": stale ? "1" : "0",
        "X-SkySphere-Cache-Age-Ms": String(Math.max(0, Math.round(cacheAgeMs)))
      }
    });
  }

  async function validateResponse(response, source) {
    if (!response || !response.ok) {
      throw new Error(`${source} returned HTTP ${response?.status ?? "unknown"}`);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${source} returned invalid JSON`);
    }
    if (!parsed || !Array.isArray(parsed.ac)) {
      throw new Error(`${source} returned an unexpected payload`);
    }
    return { text, source };
  }

  async function nativeFetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await nativeFetch(url, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensurePuter() {
    if (window.puter?.net?.fetch) return window.puter;
    if (puterLoadPromise) return puterLoadPromise;

    puterLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://js.puter.com/v2/";
      script.async = true;
      script.onload = () => {
        if (window.puter?.net?.fetch) resolve(window.puter);
        else reject(new Error("Puter networking did not initialise"));
      };
      script.onerror = () => reject(new Error("Puter networking could not be loaded"));
      document.head.appendChild(script);
    });

    return puterLoadPromise;
  }

  async function puterFetchWithTimeout(url) {
    const puter = await ensurePuter();
    return await Promise.race([
      puter.net.fetch(url, { method: "GET", cache: "no-store" }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Puter networking timed out")),
        REQUEST_TIMEOUT_MS + 4_000
      ))
    ]);
  }

  async function fetchAdsb(url) {
    const attempts = [
      {
        name: "direct provider",
        run: () => nativeFetchWithTimeout(url)
      },
      {
        name: "AllOrigins relay",
        run: () => nativeFetchWithTimeout(
          `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
        )
      },
      {
        name: "CORSProxy relay",
        run: () => nativeFetchWithTimeout(
          `https://corsproxy.io/?url=${encodeURIComponent(url)}`
        )
      },
      {
        name: "Puter secure networking",
        run: () => puterFetchWithTimeout(url)
      }
    ];

    const errors = [];
    for (const attempt of attempts) {
      try {
        const response = await attempt.run();
        return await validateResponse(response, attempt.name);
      } catch (error) {
        errors.push(`${attempt.name}: ${error?.message || error}`);
      }
    }
    throw new Error(errors.join("; "));
  }

  function removeExpiredCache(now) {
    for (const [url, cached] of lastGoodByTarget) {
      if (now - cached.savedAt > MAX_STALE_CACHE_MS) lastGoodByTarget.delete(url);
    }
  }

  window.fetch = async function skySphereFetch(input, init) {
    if (!isAdsbRequest(input)) return nativeFetch(input, init);

    const url = targetUrl(input);
    try {
      const result = await fetchAdsb(url);
      lastGoodByTarget.set(url, {
        text: result.text,
        source: result.source,
        savedAt: Date.now()
      });
      removeExpiredCache(Date.now());
      return responseFromText(result.text, result.source);
    } catch (error) {
      console.warn("SkySphere ADS-B network attempts failed", error);
      const cached = lastGoodByTarget.get(url);
      const cacheAgeMs = cached ? Date.now() - cached.savedAt : Number.POSITIVE_INFINITY;
      if (cached && cacheAgeMs <= MAX_STALE_CACHE_MS) {
        console.info("SkySphere is temporarily using a recent response for this scan area.");
        return responseFromText(cached.text, `${cached.source} cache`, {
          stale: true,
          cacheAgeMs
        });
      }
      throw error;
    }
  };
})();
