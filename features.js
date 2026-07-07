/* SkySphere Live: compass, airport labels, weather and airport traffic filters. */
(() => {
  "use strict";

  const OA_CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
  const AWC_BASE = "https://aviationweather.gov/api/data";
  const FILTER_RADIUS_NM = 100;
  const MAX_VISIBLE_AIRPORTS = 220;
  const METAR_CACHE_MS = 5 * 60 * 1000;
  const NM_TO_M = 1852;
  const EARTH_RADIUS_M = 6371008.8;

  const FALLBACK_AIRPORTS = [
    ["EGSS","London Stansted",51.885,0.235,"STN","large_airport"],
    ["EGLL","London Heathrow",51.470,-0.454,"LHR","large_airport"],
    ["EGKK","London Gatwick",51.148,-0.190,"LGW","large_airport"],
    ["EGLC","London City",51.505,0.055,"LCY","medium_airport"],
    ["EGGW","London Luton",51.875,-0.368,"LTN","large_airport"],
    ["EGSC","Cambridge",52.205,0.175,"CBG","medium_airport"],
    ["EGKB","London Biggin Hill",51.331,0.033,"BQH","medium_airport"],
    ["EGTK","Oxford Kidlington",51.837,-1.320,"OXF","medium_airport"],
    ["EGMC","London Southend",51.571,0.696,"SEN","medium_airport"],
    ["EGNX","East Midlands",52.831,-1.328,"EMA","large_airport"],
    ["EGBB","Birmingham",52.454,-1.748,"BHX","large_airport"],
    ["EGCC","Manchester",53.354,-2.275,"MAN","large_airport"],
    ["EGGP","Liverpool",53.333,-2.850,"LPL","large_airport"],
    ["EGPH","Edinburgh",55.950,-3.373,"EDI","large_airport"],
    ["EGPF","Glasgow",55.872,-4.433,"GLA","large_airport"],
    ["EGPK","Glasgow Prestwick",55.509,-4.587,"PIK","medium_airport"],
    ["EGNT","Newcastle",55.038,-1.692,"NCL","large_airport"],
    ["EGAA","Belfast International",54.658,-6.216,"BFS","large_airport"],
    ["EGAC","Belfast City",54.618,-5.872,"BHD","medium_airport"],
    ["EIDW","Dublin",53.421,-6.270,"DUB","large_airport"],
    ["EINN","Shannon",52.702,-8.925,"SNN","large_airport"],
    ["EICK","Cork",51.841,-8.491,"ORK","large_airport"],
    ["EGFF","Cardiff",51.397,-3.343,"CWL","large_airport"],
    ["EGGD","Bristol",51.383,-2.719,"BRS","large_airport"],
    ["EGHI","Southampton",50.950,-1.357,"SOU","medium_airport"],
    ["EGTE","Exeter",50.734,-3.414,"EXT","medium_airport"],
    ["EGHH","Bournemouth",50.780,-1.843,"BOH","medium_airport"],
    ["EGJB","Guernsey",49.435,-2.602,"GCI","medium_airport"],
    ["EGJJ","Jersey",49.208,-2.195,"JER","medium_airport"],
    ["LFPG","Paris Charles de Gaulle",49.010,2.548,"CDG","large_airport"],
    ["LFPO","Paris Orly",48.724,2.379,"ORY","large_airport"],
    ["EHAM","Amsterdam Schiphol",52.309,4.764,"AMS","large_airport"],
    ["EBBR","Brussels",50.901,4.484,"BRU","large_airport"]
  ].map(([icao,name,lat,lon,iata,type]) => ({icao,name,lat,lon,iata,type,country:""}));

  const featureState = {
    viewer: null,
    airports: FALLBACK_AIRPORTS.slice(),
    airportByIcao: new Map(),
    airportDataSource: null,
    selectedAirport: null,
    filterMode: "off",
    weatherCache: new Map(),
    airportLoadStatus: "fallback",
    uiReady: false,
    compassRaf: 0,
    updateAirportsTimer: 0,
    puterLoadPromise: null
  };

  function installViewerCapture() {
    if (!window.Cesium?.Viewer || window.Cesium.Viewer.__skySphereWrapped) return;
    const OriginalViewer = window.Cesium.Viewer;
    function WrappedViewer(...args) {
      const viewer = new OriginalViewer(...args);
      featureState.viewer = viewer;
      window.skySphereViewer = viewer;
      setTimeout(() => initialiseFeatures(viewer), 0);
      return viewer;
    }
    Object.setPrototypeOf(WrappedViewer, OriginalViewer);
    WrappedViewer.prototype = OriginalViewer.prototype;
    WrappedViewer.__skySphereWrapped = true;
    window.Cesium.Viewer = WrappedViewer;
  }

  installViewerCapture();

  function createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "html") el.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined) el.setAttribute(key, value);
    }
    for (const child of children) el.append(child);
    return el;
  }

  function injectStyles() {
    if (document.getElementById("skySphereFeatureStyles")) return;
    const style = createElement("style", { id: "skySphereFeatureStyles" });
    style.textContent = `
      .sky-compass{position:absolute;z-index:12;top:92px;right:14px;display:grid;gap:7px;justify-items:center;pointer-events:auto}
      .sky-compass-dial{width:92px;height:92px;border-radius:50%;position:relative;display:grid;place-items:center;background:rgba(4,14,27,.84);border:1px solid rgba(168,207,255,.25);box-shadow:0 12px 35px rgba(0,0,0,.35);backdrop-filter:blur(14px)}
      .sky-compass-rose{position:absolute;inset:8px;border-radius:50%;transition:transform .08s linear}
      .sky-compass-rose span{position:absolute;font-size:11px;font-weight:800;color:#dceaff}
      .sky-compass-rose .n{top:0;left:50%;transform:translateX(-50%);color:#ff7f8a}.sky-compass-rose .e{right:2px;top:50%;transform:translateY(-50%)}
      .sky-compass-rose .s{bottom:0;left:50%;transform:translateX(-50%)}.sky-compass-rose .w{left:2px;top:50%;transform:translateY(-50%)}
      .sky-compass-pointer{position:absolute;top:7px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:14px solid #53d8ff;filter:drop-shadow(0 0 5px rgba(83,216,255,.8))}
      .sky-compass-heading{font-size:15px;font-weight:800;color:white;margin-top:2px}.sky-north-button{min-height:34px!important;padding:6px 10px!important;background:rgba(4,14,27,.86)!important}
      .airport-tools{margin-top:12px;padding-top:12px;border-top:1px solid rgba(168,207,255,.18);display:grid;gap:9px}
      .airport-tools h3{margin:0;color:#dceaff;font-size:13px}.airport-search-row{display:grid;grid-template-columns:1fr auto;gap:7px}
      .airport-search-row input{width:100%;border:1px solid rgba(168,207,255,.18);border-radius:11px;background:rgba(5,17,31,.9);color:#f4f8ff;padding:10px 11px;min-width:0}
      .airport-search-results{display:none;max-height:180px;overflow:auto;border:1px solid rgba(168,207,255,.18);border-radius:11px;background:rgba(4,14,27,.96)}
      .airport-search-results.show{display:block}.airport-result{display:block;width:100%;text-align:left;border:0!important;border-radius:0!important;background:transparent!important;padding:9px 10px!important;min-height:0!important}
      .airport-result:hover{background:rgba(83,216,255,.12)!important}.airport-result strong,.airport-result span{display:block}.airport-result span{font-size:10px;color:#a8b8ca;margin-top:2px}
      .airport-layer-toggle{display:flex;align-items:center;gap:7px;color:#a8b8ca;font-size:11px}.airport-layer-toggle input{accent-color:#53d8ff}
      .airport-panel{position:absolute;z-index:13;right:14px;bottom:28px;width:min(410px,calc(100vw - 28px));max-height:70vh;overflow:auto;border-radius:20px;padding:17px;background:rgba(4,14,27,.91);border:1px solid rgba(168,207,255,.2);box-shadow:0 18px 48px rgba(0,0,0,.4);backdrop-filter:blur(18px)}
      .airport-panel.hidden{display:none}.airport-panel-close{position:absolute;right:10px;top:9px;width:32px;min-height:32px!important;border-radius:50%!important;padding:0!important}
      .airport-title{padding-right:35px}.airport-title h2{margin:0;font-size:21px}.airport-title p{margin:4px 0 0;color:#a8b8ca;font-size:11px}
      .airport-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:13px 0}.airport-weather{display:grid;gap:9px}.weather-card{padding:10px;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.06)}
      .weather-card h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 6px;color:#78ffbf}.weather-card pre{white-space:pre-wrap;word-break:break-word;margin:0;color:#f4f8ff;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
      .airport-filter-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:12px}.airport-filter-grid button{padding:8px 4px!important;font-size:10px!important}.airport-filter-grid button.active{background:rgba(83,216,255,.28)!important;border-color:#53d8ff!important}
      .airport-filter-note{font-size:9px;line-height:1.4;color:#a8b8ca;margin:7px 0 0}
      @media(max-width:720px){.sky-compass{top:84px;right:10px}.sky-compass-dial{width:74px;height:74px}.sky-compass-heading{font-size:12px}.airport-panel{right:12px;bottom:12px;max-height:58vh}.airport-actions{grid-template-columns:1fr}.airport-filter-grid{grid-template-columns:1fr 1fr}}
    `;
    document.head.append(style);
  }

  function createCompass(viewer) {
    if (document.getElementById("skyCompass")) return;
    const rose = createElement("div", { class: "sky-compass-rose" }, [
      createElement("span", { class: "n", text: "N" }),
      createElement("span", { class: "e", text: "E" }),
      createElement("span", { class: "s", text: "S" }),
      createElement("span", { class: "w", text: "W" })
    ]);
    const heading = createElement("div", { class: "sky-compass-heading", text: "000°" });
    const dial = createElement("div", { class: "sky-compass-dial", title: "Camera heading" }, [rose, createElement("div", { class: "sky-compass-pointer" }), heading]);
    const northButton = createElement("button", { class: "sky-north-button", type: "button", text: "Point north" });
    const box = createElement("div", { class: "sky-compass", id: "skyCompass" }, [dial, northButton]);
    document.getElementById("app")?.append(box);

    const update = () => {
      featureState.compassRaf = 0;
      const degrees = ((Cesium.Math.toDegrees(viewer.camera.heading) % 360) + 360) % 360;
      rose.style.transform = `rotate(${-degrees}deg)`;
      heading.textContent = `${String(Math.round(degrees) % 360).padStart(3, "0")}°`;
    };
    viewer.camera.changed.addEventListener(() => {
      if (!featureState.compassRaf) featureState.compassRaf = requestAnimationFrame(update);
    });
    northButton.addEventListener("click", () => {
      const destination = Cesium.Cartesian3.clone(viewer.camera.positionWC);
      viewer.camera.flyTo({ destination, orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 }, duration: 0.8 });
    });
    update();
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  async function loadAirports() {
    try {
      const response = await fetch(OA_CSV_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = parseCsv(await response.text());
      const headers = rows.shift();
      const index = Object.fromEntries(headers.map((h, i) => [h, i]));
      const airports = [];
      for (const row of rows) {
        const type = row[index.type];
        const scheduled = row[index.scheduled_service] === "yes";
        const icao = (row[index.gps_code] || row[index.ident] || "").trim().toUpperCase();
        if (!icao || !/^[A-Z0-9]{3,4}$/.test(icao)) continue;
        if (!(type === "large_airport" || type === "medium_airport" || scheduled)) continue;
        const lat = Number(row[index.latitude_deg]);
        const lon = Number(row[index.longitude_deg]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        airports.push({ icao, name: row[index.name] || icao, lat, lon, iata: (row[index.iata_code] || "").trim().toUpperCase(), type, country: row[index.iso_country] || "", municipality: row[index.municipality] || "" });
      }
      featureState.airports = airports.length ? airports : FALLBACK_AIRPORTS.slice();
      featureState.airportLoadStatus = airports.length ? "global" : "fallback";
    } catch (error) {
      console.warn("Global airport data could not be loaded; using built-in UK/near-Europe list", error);
      featureState.airports = FALLBACK_AIRPORTS.slice();
      featureState.airportLoadStatus = "fallback";
    }
    featureState.airportByIcao = new Map(featureState.airports.map((airport) => [airport.icao, airport]));
    updateAirportLabels(true);
  }

  function haversineNm(lat1, lon1, lat2, lon2) {
    const p1 = Cesium.Math.toRadians(lat1), p2 = Cesium.Math.toRadians(lat2);
    const dLat = p2 - p1, dLon = Cesium.Math.toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))) / NM_TO_M;
  }

  function cameraSurfacePosition(viewer) {
    const canvas = viewer.scene.canvas;
    const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const cartesian = viewer.camera.pickEllipsoid(centre, viewer.scene.globe.ellipsoid);
    if (cartesian) {
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    }
    const c = viewer.camera.positionCartographic;
    return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
  }

  function airportDisplayRadiusNm(viewer) {
    const heightKm = Math.max(1, viewer.camera.positionCartographic.height / 1000);
    return Math.min(1800, Math.max(120, heightKm * 1.7));
  }

  function updateAirportLabels(force = false) {
    const viewer = featureState.viewer;
    if (!viewer || !featureState.airportDataSource) return;
    clearTimeout(featureState.updateAirportsTimer);
    featureState.updateAirportsTimer = setTimeout(() => {
      const enabled = document.getElementById("airportLabelsToggle")?.checked !== false;
      featureState.airportDataSource.show = enabled;
      if (!enabled) return;
      const centre = cameraSurfacePosition(viewer);
      const radiusNm = airportDisplayRadiusNm(viewer);
      const nearest = featureState.airports.map((airport) => ({ airport, distance: haversineNm(centre.lat, centre.lon, airport.lat, airport.lon) })).filter((item) => item.distance <= radiusNm).sort((a, b) => a.distance - b.distance).slice(0, MAX_VISIBLE_AIRPORTS);
      featureState.airportDataSource.entities.removeAll();
      for (const { airport } of nearest) {
        featureState.airportDataSource.entities.add({
          id: `airport-${airport.icao}`,
          position: Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, 80),
          point: { pixelSize: airport.type === "large_airport" ? 9 : 7, color: airport.type === "large_airport" ? Cesium.Color.fromCssColorString("#ffd36a") : Cesium.Color.fromCssColorString("#78ffbf"), outlineColor: Cesium.Color.BLACK.withAlpha(0.85), outlineWidth: 2, disableDepthTestDistance: 2_000_000, scaleByDistance: new Cesium.NearFarScalar(2_000, 1.1, 1_800_000, 0.55) },
          label: { text: `${airport.icao}${airport.iata ? ` / ${airport.iata}` : ""}\n${airport.name}`, font: "600 11px system-ui", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -18), showBackground: true, backgroundColor: Cesium.Color.fromCssColorString("#07111f").withAlpha(0.72), backgroundPadding: new Cesium.Cartesian2(5, 3), disableDepthTestDistance: 2_000_000, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_200_000), scaleByDistance: new Cesium.NearFarScalar(2_000, 1, 1_200_000, 0.58) },
          properties: { airportIdent: airport.icao }
        });
      }
    }, force ? 0 : 180);
  }

  function insertAirportTools() {
    const panel = document.querySelector(".control-panel");
    if (!panel || document.getElementById("airportTools")) return;
    const searchInput = createElement("input", { id: "airportSearch", type: "search", placeholder: "Search airport name, ICAO or IATA", autocomplete: "off" });
    const results = createElement("div", { class: "airport-search-results", id: "airportSearchResults" });
    const searchButton = createElement("button", { type: "button", text: "Find" });
    const labelsToggle = createElement("input", { id: "airportLabelsToggle", type: "checkbox" });
    labelsToggle.checked = true;
    const tools = createElement("section", { class: "airport-tools", id: "airportTools" }, [createElement("h3", { text: "Airports & weather" }), createElement("div", { class: "airport-search-row" }, [searchInput, searchButton]), results, createElement("label", { class: "airport-layer-toggle" }, [labelsToggle, document.createTextNode("Airport labels")])]);
    const sourceNote = panel.querySelector(".source-note");
    panel.insertBefore(tools, sourceNote || null);

    function runSearch() {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) { results.classList.remove("show"); results.replaceChildren(); return; }
      const matches = featureState.airports.filter((a) => a.icao.toLowerCase().includes(q) || a.iata.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || (a.municipality || "").toLowerCase().includes(q)).slice(0, 12);
      results.replaceChildren(...matches.map((airport) => {
        const button = createElement("button", { class: "airport-result", type: "button" });
        button.append(createElement("strong", { text: `${airport.icao}${airport.iata ? ` / ${airport.iata}` : ""} — ${airport.name}` }), createElement("span", { text: [airport.municipality, airport.country].filter(Boolean).join(", ") || airport.type.replace("_", " ") }));
        button.addEventListener("click", () => { searchInput.value = airport.icao; results.classList.remove("show"); selectAirport(airport); });
        return button;
      }));
      results.classList.toggle("show", matches.length > 0);
    }
    searchInput.addEventListener("input", runSearch);
    searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runSearch(); } });
    searchButton.addEventListener("click", runSearch);
    labelsToggle.addEventListener("change", () => updateAirportLabels(true));
  }

  function createAirportPanel() {
    if (document.getElementById("airportPanel")) return;
    const panel = createElement("aside", { class: "airport-panel hidden", id: "airportPanel" });
    panel.innerHTML = `<button type="button" class="airport-panel-close" id="airportPanelClose" aria-label="Close airport panel">×</button><div class="airport-title"><h2 id="airportPanelName">Airport</h2><p id="airportPanelCode">—</p></div><div class="airport-actions"><button type="button" id="airportFlyButton">Fly to airport</button><button type="button" id="airportScanButton">Centre aircraft scan here</button></div><div class="airport-weather"><div class="weather-card"><h3>METAR</h3><pre id="airportMetar">Select an airport to load weather.</pre></div><div class="weather-card"><h3>TAF</h3><pre id="airportTaf">Select an airport to load weather.</pre></div></div><div class="airport-filter-grid" aria-label="Airport aircraft filters"><button type="button" data-filter="off" class="active">Off</button><button type="button" data-filter="both">Both</button><button type="button" data-filter="in">Inbound</button><button type="button" data-filter="out">Outbound</button></div><p class="airport-filter-note">Inbound/outbound is estimated from each aircraft’s live heading relative to this airport; public ADS-B does not provide a reliable filed destination for every aircraft.</p>`;
    document.getElementById("app")?.append(panel);
    panel.querySelector("#airportPanelClose").addEventListener("click", () => panel.classList.add("hidden"));
    panel.querySelector("#airportFlyButton").addEventListener("click", () => flyToSelectedAirport(false));
    panel.querySelector("#airportScanButton").addEventListener("click", () => flyToSelectedAirport(true));
    for (const button of panel.querySelectorAll("[data-filter]")) button.addEventListener("click", () => setTrafficFilter(button.dataset.filter));
  }

  function selectAirport(airport) {
    featureState.selectedAirport = airport;
    const panel = document.getElementById("airportPanel");
    panel?.classList.remove("hidden");
    document.getElementById("airportPanelName").textContent = airport.name;
    document.getElementById("airportPanelCode").textContent = `${airport.icao}${airport.iata ? ` / ${airport.iata}` : ""}${airport.municipality ? ` · ${airport.municipality}` : ""}`;
    loadAirportWeather(airport);
  }

  function flyToSelectedAirport(centreScan) {
    const airport = featureState.selectedAirport;
    const viewer = featureState.viewer;
    if (!airport || !viewer) return;
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(airport.lon, airport.lat, 180_000), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-72), roll: 0 }, duration: 1.35, complete: () => { if (centreScan) document.getElementById("scanViewBtn")?.click(); } });
  }

  async function ensurePuter() {
    if (window.puter?.net?.fetch) return window.puter;
    if (featureState.puterLoadPromise) return featureState.puterLoadPromise;
    featureState.puterLoadPromise = new Promise((resolve, reject) => {
      const script = createElement("script", { src: "https://js.puter.com/v2/", async: "" });
      script.onload = () => window.puter?.net?.fetch ? resolve(window.puter) : reject(new Error("Puter did not initialise"));
      script.onerror = () => reject(new Error("Puter could not be loaded"));
      document.head.append(script);
    });
    return featureState.puterLoadPromise;
  }

  async function fetchExternalText(url) {
    const attempts = [async () => fetch(url, { cache: "no-store" }), async () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { cache: "no-store" }), async () => fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, { cache: "no-store" }), async () => (await ensurePuter()).net.fetch(url, { method: "GET", cache: "no-store" })];
    const errors = [];
    for (const attempt of attempts) {
      try {
        const response = await Promise.race([attempt(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 16000))]);
        if (response.status === 204) return "No report available.";
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.text()).trim() || "No report available.";
      } catch (error) { errors.push(error?.message || String(error)); }
    }
    throw new Error(errors.join("; "));
  }

  async function loadAirportWeather(airport) {
    const metarEl = document.getElementById("airportMetar");
    const tafEl = document.getElementById("airportTaf");
    metarEl.textContent = "Loading latest METAR…";
    tafEl.textContent = "Loading latest TAF…";
    const cached = featureState.weatherCache.get(airport.icao);
    if (cached && Date.now() - cached.time < METAR_CACHE_MS) { metarEl.textContent = cached.metar; tafEl.textContent = cached.taf; return; }
    const metarUrl = `${AWC_BASE}/metar?ids=${encodeURIComponent(airport.icao)}&format=raw&hours=3`;
    const tafUrl = `${AWC_BASE}/taf?ids=${encodeURIComponent(airport.icao)}&format=raw`;
    const [metar, taf] = await Promise.all([fetchExternalText(metarUrl).catch((error) => `METAR unavailable: ${error.message}`), fetchExternalText(tafUrl).catch((error) => `TAF unavailable: ${error.message}`)]);
    featureState.weatherCache.set(airport.icao, { time: Date.now(), metar, taf });
    if (featureState.selectedAirport?.icao === airport.icao) { metarEl.textContent = metar; tafEl.textContent = taf; }
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    const p1 = Cesium.Math.toRadians(lat1), p2 = Cesium.Math.toRadians(lat2), dl = Cesium.Math.toRadians(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
  }

  function angularDifference(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }

  function aircraftClassification(entity, airport, time) {
    const position = entity.position?.getValue(time);
    if (!position) return { near: false, inbound: false, outbound: false };
    const carto = Cesium.Cartographic.fromCartesian(position), lat = Cesium.Math.toDegrees(carto.latitude), lon = Cesium.Math.toDegrees(carto.longitude);
    const distanceNm = haversineNm(lat, lon, airport.lat, airport.lon);
    if (distanceNm > FILTER_RADIUS_NM) return { near: false, inbound: false, outbound: false };
    const rotationProperty = entity.billboard?.rotation;
    const trackRadians = Number(rotationProperty?.getValue ? rotationProperty.getValue(time) : rotationProperty || 0);
    const track = ((-Cesium.Math.toDegrees(trackRadians) % 360) + 360) % 360;
    const difference = angularDifference(track, bearingDegrees(lat, lon, airport.lat, airport.lon));
    return { near: true, inbound: difference <= 65, outbound: difference >= 115 };
  }

  function applyTrafficFilter() {
    const viewer = featureState.viewer, airport = featureState.selectedAirport;
    if (!viewer) return;
    const time = Cesium.JulianDate.now();
    for (const entity of viewer.entities.values) {
      const hex = entity.properties?.aircraftHex?.getValue?.(time);
      if (!hex) continue;
      let show = true;
      if (featureState.filterMode !== "off" && airport) {
        const c = aircraftClassification(entity, airport, time);
        show = featureState.filterMode === "both" ? c.near : featureState.filterMode === "in" ? c.inbound : c.outbound;
      }
      entity.show = show;
      const trail = viewer.entities.getById(`trail-${hex}`);
      if (trail) trail.show = show;
    }
  }

  function setTrafficFilter(mode) {
    if (mode !== "off" && !featureState.selectedAirport) return;
    featureState.filterMode = mode;
    for (const button of document.querySelectorAll("#airportPanel [data-filter]")) button.classList.toggle("active", button.dataset.filter === mode);
    applyTrafficFilter();
  }

  function addAirportClickHandler(viewer) {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      const ident = picked?.id?.properties?.airportIdent?.getValue?.();
      if (ident) { const airport = featureState.airportByIcao.get(ident); if (airport) selectAirport(airport); }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  async function initialiseFeatures(viewer) {
    if (featureState.uiReady) return;
    featureState.uiReady = true;
    injectStyles();
    createCompass(viewer);
    insertAirportTools();
    createAirportPanel();
    featureState.airportDataSource = new Cesium.CustomDataSource("airports");
    viewer.dataSources.add(featureState.airportDataSource);
    viewer.camera.moveEnd.addEventListener(() => updateAirportLabels());
    viewer.scene.preRender.addEventListener(() => { if (featureState.filterMode !== "off") applyTrafficFilter(); });
    addAirportClickHandler(viewer);
    featureState.airportByIcao = new Map(featureState.airports.map((airport) => [airport.icao, airport]));
    updateAirportLabels(true);
    loadAirports();
  }
})();
