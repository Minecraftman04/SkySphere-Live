/*
 * SkySphere Live network reliability layer.
 *
 * The UI timer currently wakes once per second to update its counters. This
 * wrapper prevents that timer from contacting the ADS-B providers more often
 * than once every 15 seconds. It also supplies controlled CORS fallbacks and
 * keeps a recent valid response available through short provider outages.
 */
(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const MIN_REQUEST_INTERVAL_MS = 15_000;
  const MAX_STALE_CACHE_MS = 120_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const APPROVED_HOSTS = new Set([
    "api.airplanes.live",
    "api.adsb.fi",
    "api.adsb.lol"
  ]);

  let nextRequestAt = 0;
  let previousTarget = "";
  let lastGood = null;
  let puterLoadPromise = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function responseFromText(text, source, stale = false) {
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-SkySphere-Source": source,
        "X-SkySphere-Stale": stale ? "1" : "0"
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

  window.fetch = async function skySphereFetch(input, init) {
    if (!isAdsbRequest(input)) {
      return nativeFetch(input, init);
    }

    const url = targetUrl(input);
    const now = Date.now();

    // Changing location, radius or provider should not be held behind the old
    // area's timer. Repeated requests for the same endpoint are throttled.
    if (url !== previousTarget) {
      previousTarget = url;
      nextRequestAt = 0;
    }

    const waitMs = Math.max(0, nextRequestAt - now);
    if (waitMs > 0) await sleep(waitMs);
    nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;

    try {
      const result = await fetchAdsb(url);
      lastGood = {
        text: result.text,
        source: result.source,
        savedAt: Date.now(),
        target: url
      };
      return responseFromText(result.text, result.source, false);
    } catch (error) {
      console.warn("SkySphere ADS-B network attempts failed", error);

      if (lastGood && Date.now() - lastGood.savedAt <= MAX_STALE_CACHE_MS) {
        console.info("SkySphere is temporarily using its last valid aircraft response.");
        return responseFromText(lastGood.text, `${lastGood.source} cached`, true);
      }

      throw error;
    }
  };
})();
