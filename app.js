/* SkySphere Live — browser-only 3D ADS-B tracker for GitHub Pages. */
(() => {
  "use strict";

  const DEFAULT_LOCATION = { lat: 51.885, lon: 0.235, name: "Bishop's Stortford / Stansted" };
  const REFRESH_MS = 15_000;
  const STALE_MS = 70_000;
  const MAX_AIRCRAFT = 900;
  const FEET_TO_METRES = 0.3048;
  const KNOTS_TO_MPS = 0.514444;
  const EARTH_RADIUS_M = 6_371_008.8;

  const ADSB_PROVIDERS = [
    { id: "airplanes-live", name: "Airplanes.live", baseUrl: "https://api.airplanes.live/v2" },
    { id: "adsb-fi", name: "adsb.fi", baseUrl: "https://api.adsb.fi/v2" },
    { id: "adsb-lol", name: "ADSB.lol", baseUrl: "https://api.adsb.lol/v2" }
  ];

  const els = Object.fromEntries([
    "liveStatus", "statusText", "aircraftCount", "lastUpdate", "scanRadiusLabel", "radiusSelect",
    "scanViewBtn", "locateBtn", "refreshBtn", "homeBtn", "labelsToggle", "stemsToggle",
    "trailsToggle", "autoRefreshToggle", "altitudeScale", "altitudeScaleLabel", "iconScale",
    "iconScaleLabel", "scanLocation", "aircraftPanel", "closePanelBtn", "detailCallsign", "detailRoute",
    "detailReg", "detailType", "detailAltitude", "detailSpeed", "detailTrack", "detailVertical",
    "detailSquawk", "detailAge", "detailHex", "followBtn", "groundViewBtn", "loadingOverlay",
    "loadingMessage", "toast"
  ].map((id) => [id, document.getElementById(id)]));

  const state = {
    viewer: null,
    scan: { ...DEFAULT_LOCATION },
    radiusNm: Number(els.radiusSelect.value),
    altitudeScale: 1,
    iconScale: 1,
    records: new Map(),
    entities: new Map(),
    trailEntities: new Map(),
    selectedHex: null,
    followedHex: null,
    timer: null,
    loading: false,
    lastSuccessfulUpdate: 0,
    providerId: null,
    providerName: null,
    toastTimer: null
  };

  const planeSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <path fill="#f7fbff" stroke="#07111f" stroke-width="2.4" stroke-linejoin="round"
        d="M32 3c3 0 5 3 5 7v14l18 11v6L37 35v13l7 5v5l-12-3-12 3v-5l7-5V35L9 41v-6l18-11V10c0-4 2-7 5-7z"/>
      <circle cx="32" cy="19" r="2" fill="#53d8ff"/>
    </svg>`);
  const planeIcon = `data:image/svg+xml;charset=utf-8,${planeSvg}`;

  function setStatus(kind, text) {
    els.liveStatus.classList.remove("warning", "error");
    if (kind) els.liveStatus.classList.add(kind);
    els.statusText.textContent = text;
  }

  function showToast(message, duration = 4000) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    state.toastTimer = setTimeout(() => els.toast.classList.remove("show"), duration);
  }

  function setLoading(show, message = "Loading…") {
    els.loadingMessage.textContent = message;
    els.loadingOverlay.classList.toggle("hidden", !show);
  }

  function safeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function altitudeFeet(ac) {
    const candidates = [ac.alt_geom, ac.geom_alt, ac.alt_baro, ac.baro_alt];
    for (const value of candidates) {
      if (typeof value === "string" && value.toLowerCase() === "ground") return 0;
      const num = safeNumber(value);
      if (num !== null) return Math.max(0, num);
    }
    return 0;
  }

  function destinationPoint(latDeg, lonDeg, bearingDeg, distanceM) {
    if (!Number.isFinite(distanceM) || distanceM === 0) return { lat: latDeg, lon: lonDeg };
    const lat1 = Cesium.Math.toRadians(latDeg);
    const lon1 = Cesium.Math.toRadians(lonDeg);
    const brng = Cesium.Math.toRadians(bearingDeg || 0);
    const angular = distanceM / EARTH_RADIUS_M;
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const sinAngular = Math.sin(angular);
    const cosAngular = Math.cos(angular);
    const lat2 = Math.asin(sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * sinAngular * cosLat1,
      cosAngular - sinLat1 * Math.sin(lat2)
    );
    return {
      lat: Cesium.Math.toDegrees(lat2),
      lon: ((Cesium.Math.toDegrees(lon2) + 540) % 360) - 180
    };
  }

  function predictedPosition(record, now = Date.now()) {
    const elapsedSeconds = Math.min(35, Math.max(0, (now - record.receivedAt) / 1000));
    const speedMps = (record.gs || 0) * KNOTS_TO_MPS;
    const next = destinationPoint(record.lat, record.lon, record.track || 0, speedMps * elapsedSeconds);
    const verticalMetres = ((record.verticalRate || 0) * FEET_TO_METRES / 60) * elapsedSeconds;
    const trueAltitudeM = Math.max(0, record.altitudeFt * FEET_TO_METRES + verticalMetres);
    return Cesium.Cartesian3.fromDegrees(next.lon, next.lat, trueAltitudeM * state.altitudeScale);
  }

  function normaliseAircraft(ac) {
    const lat = safeNumber(ac.lat);
    const lon = safeNumber(ac.lon);
    if (lat === null || lon === null) return null;
    const hex = String(ac.hex || ac.icao || ac.icao24 || "").trim().toLowerCase();
    if (!hex) return null;
    return {
      hex,
      lat,
      lon,
      altitudeFt: altitudeFeet(ac),
      gs: safeNumber(ac.gs ?? ac.ground_speed ?? ac.speed) || 0,
      track: safeNumber(ac.track ?? ac.true_heading ?? ac.mag_heading) || 0,
      verticalRate: safeNumber(ac.geom_rate ?? ac.baro_rate ?? ac.vertical_rate) || 0,
      flight: String(ac.flight || ac.callsign || "").trim(),
      reg: String(ac.r || ac.reg || ac.registration || "").trim(),
      type: String(ac.t || ac.type || ac.aircraft_type || "").trim(),
      typeDescription: String(ac.desc || ac.type_desc || "").trim(),
      squawk: String(ac.squawk || "").trim(),
      category: String(ac.category || "").trim(),
      seen: safeNumber(ac.seen_pos ?? ac.seen) || 0,
      source: String(ac.type || ac.nav_modes || "ADS-B").trim(),
      receivedAt: Date.now(),
      raw: ac
    };
  }

  async function fetchJson(url, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.ac)) throw new Error("Unexpected API response");
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function orderedProviders() {
    if (!state.providerId) return ADSB_PROVIDERS;
    const preferred = ADSB_PROVIDERS.find((provider) => provider.id === state.providerId);
    return preferred
      ? [preferred, ...ADSB_PROVIDERS.filter((provider) => provider.id !== preferred.id)]
      : ADSB_PROVIDERS;
  }

  async function fetchAircraft(lat, lon, radius) {
    const errors = [];
    for (const provider of orderedProviders()) {
      const url = `${provider.baseUrl}/point/${lat.toFixed(5)}/${lon.toFixed(5)}/${radius}`;
      try {
        const data = await fetchJson(url);
        state.providerId = provider.id;
        state.providerName = provider.name;
        return data;
      } catch (error) {
        errors.push(`${provider.name}: ${error?.message || error}`);
        if (state.providerId === provider.id) state.providerId = null;
      }
    }
    throw new Error(`No browser-accessible ADS-B provider responded (${errors.join("; ")})`);
  }

  function makeLabel(record) {
    const callsign = record.flight || record.reg || record.hex.toUpperCase();
    return `${callsign}\n${Math.round(record.altitudeFt).toLocaleString()} ft · ${Math.round(record.gs)} kt`;
  }

  function aircraftColor(record) {
    if (record.altitudeFt < 1000) return Cesium.Color.fromCssColorString("#ffd36a");
    if (record.altitudeFt < 10000) return Cesium.Color.fromCssColorString("#78ffbf");
    if (record.altitudeFt < 25000) return Cesium.Color.fromCssColorString("#53d8ff");
    return Cesium.Color.fromCssColorString("#c9a7ff");
  }

  function createAircraftEntity(record) {
    const position = new Cesium.CallbackPositionProperty(() => predictedPosition(record), false);
    const entity = state.viewer.entities.add({
      id: `aircraft-${record.hex}`,
      name: record.flight || record.reg || record.hex.toUpperCase(),
      position,
      billboard: {
        image: planeIcon,
        width: 30 * state.iconScale,
        height: 30 * state.iconScale,
        rotation: Cesium.Math.toRadians(-record.track),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: 2_500_000,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5_000_000),
        scaleByDistance: new Cesium.NearFarScalar(2_000, 1.25, 2_500_000, 0.55)
      },
      point: {
        pixelSize: 7,
        color: aircraftColor(record),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 2,
        disableDepthTestDistance: 2_500_000,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(1_200_000, Number.MAX_VALUE)
      },
      label: {
        text: makeLabel(record),
        font: "600 12px system-ui",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.95),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -25),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#07111f").withAlpha(0.72),
        backgroundPadding: new Cesium.Cartesian2(7, 5),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 450_000),
        scaleByDistance: new Cesium.NearFarScalar(2_000, 1, 450_000, 0.68),
        disableDepthTestDistance: 500_000,
        show: els.labelsToggle.checked
      },
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const top = predictedPosition(record);
          const bottom = Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 0);
          return [bottom, top];
        }, false),
        width: 1,
        material: aircraftColor(record).withAlpha(0.38),
        show: els.stemsToggle.checked
      },
      properties: { aircraftHex: record.hex }
    });
    state.entities.set(record.hex, entity);
    return entity;
  }

  function updateTrail(record) {
    let trail = state.trailEntities.get(record.hex);
    if (!trail) {
      trail = state.viewer.entities.add({
        id: `trail-${record.hex}`,
        polyline: {
          positions: [],
          width: 2,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.12,
            color: aircraftColor(record).withAlpha(0.65)
          }),
          show: els.trailsToggle.checked
        }
      });
      trail._history = [];
      state.trailEntities.set(record.hex, trail);
    }
    const p = Cesium.Cartesian3.fromDegrees(
      record.lon,
      record.lat,
      record.altitudeFt * FEET_TO_METRES * state.altitudeScale
    );
    const last = trail._history[trail._history.length - 1];
    if (!last || Cesium.Cartesian3.distance(last, p) > 80) trail._history.push(p);
    if (trail._history.length > 18) trail._history.shift();
    trail.polyline.positions = trail._history.slice();
    trail.polyline.show = els.trailsToggle.checked;
  }

  function updateAircraftEntity(record) {
    let entity = state.entities.get(record.hex);
    if (!entity) entity = createAircraftEntity(record);
    entity.name = record.flight || record.reg || record.hex.toUpperCase();
    entity.billboard.rotation = Cesium.Math.toRadians(-record.track);
    entity.billboard.width = 30 * state.iconScale;
    entity.billboard.height = 30 * state.iconScale;
    entity.label.text = makeLabel(record);
    entity.label.show = els.labelsToggle.checked;
    entity.polyline.show = els.stemsToggle.checked;
    entity.point.color = aircraftColor(record);
    updateTrail(record);
  }

  function removeAircraft(hex) {
    const entity = state.entities.get(hex);
    const trail = state.trailEntities.get(hex);
    if (entity) state.viewer.entities.remove(entity);
    if (trail) state.viewer.entities.remove(trail);
    state.entities.delete(hex);
    state.trailEntities.delete(hex);
    state.records.delete(hex);
    if (state.selectedHex === hex) closeAircraftPanel();
  }

  function cleanupStale() {
    const now = Date.now();
    for (const [hex, record] of state.records) {
      if (now - record.receivedAt > STALE_MS) removeAircraft(hex);
    }
  }

  async function refreshAircraft({ quiet = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!quiet) setStatus("warning", "Updating live traffic…");
    try {
      const data = await fetchAircraft(state.scan.lat, state.scan.lon, state.radiusNm);
      const records = data.ac
        .map(normaliseAircraft)
        .filter(Boolean)
        .sort((a, b) => (a.seen || 0) - (b.seen || 0))
        .slice(0, MAX_AIRCRAFT);

      for (const incoming of records) {
        const existing = state.records.get(incoming.hex);
        if (existing) {
          Object.assign(existing, incoming);
          existing.receivedAt = Date.now() - Math.max(0, incoming.seen * 1000);
          updateAircraftEntity(existing);
        } else {
          incoming.receivedAt = Date.now() - Math.max(0, incoming.seen * 1000);
          state.records.set(incoming.hex, incoming);
          updateAircraftEntity(incoming);
        }
      }

      cleanupStale();
      state.lastSuccessfulUpdate = Date.now();
      els.aircraftCount.textContent = state.records.size.toLocaleString();
      els.lastUpdate.textContent = "now";
      setStatus("", `${state.records.size} live aircraft · ${state.providerName || "live feed"}`);
      if (state.selectedHex) updateAircraftPanel(state.selectedHex);
    } catch (error) {
      console.error("ADS-B update failed", error);
      setStatus("error", "Live data unavailable");
      showToast("All public ADS-B feeds failed in this browser. SkySphere will retry automatically; a hard refresh may also help.", 7500);
    } finally {
      state.loading = false;
      setLoading(false);
    }
  }

  function startTimer() {
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (els.autoRefreshToggle.checked && !document.hidden) refreshAircraft({ quiet: true });
      if (state.lastSuccessfulUpdate) {
        const seconds = Math.floor((Date.now() - state.lastSuccessfulUpdate) / 1000);
        els.lastUpdate.textContent = seconds < 2 ? "now" : `${seconds}s`;
      }
      if (state.selectedHex) updateAircraftPanel(state.selectedHex);
    }, 1000);
  }

  function getViewCentre() {
    const viewer = state.viewer;
    const canvas = viewer.scene.canvas;
    const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    let cartesian = viewer.camera.pickEllipsoid(centre, viewer.scene.globe.ellipsoid);
    if (!cartesian) {
      const ray = viewer.camera.getPickRay(centre);
      cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    }
    if (!cartesian) return null;
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude)
    };
  }

  function setScanLocation(lat, lon, name = null) {
    state.scan = { lat, lon, name: name || `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` };
    els.scanLocation.textContent = `Scan centre: ${state.scan.name}`;
    refreshAircraft();
  }

  function scanViewCentre() {
    const centre = getViewCentre();
    if (!centre) {
      showToast("Zoom closer to Earth, then try setting the scan centre again.");
      return;
    }
    setScanLocation(centre.lat, centre.lon);
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      showToast("Location is not available in this browser.");
      return;
    }
    setStatus("warning", "Getting your location…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const lat = coords.latitude;
        const lon = coords.longitude;
        state.viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, 650_000),
          duration: 1.8
        });
        setScanLocation(lat, lon, "Your location");
      },
      (error) => {
        setStatus("error", "Location permission denied");
        showToast(`Could not use your location: ${error.message}`);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }

  function flyHome() {
    state.viewer.trackedEntity = undefined;
    state.followedHex = null;
    state.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat, 550_000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
      duration: 1.8
    });
    setScanLocation(DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon, DEFAULT_LOCATION.name);
  }

  function selectAircraft(hex) {
    if (!state.records.has(hex)) return;
    state.selectedHex = hex;
    updateAircraftPanel(hex);
    els.aircraftPanel.classList.remove("hidden");
  }

  function closeAircraftPanel() {
    state.selectedHex = null;
    els.aircraftPanel.classList.add("hidden");
    state.viewer.selectedEntity = undefined;
  }

  function updateAircraftPanel(hex) {
    const record = state.records.get(hex);
    if (!record) return;
    const age = Math.max(0, (Date.now() - record.receivedAt) / 1000);
    els.detailCallsign.textContent = record.flight || record.reg || record.hex.toUpperCase();
    els.detailRoute.textContent = record.typeDescription || "Live ADS-B target";
    els.detailReg.textContent = record.reg || "—";
    els.detailType.textContent = record.type || "—";
    els.detailAltitude.textContent = `${Math.round(record.altitudeFt).toLocaleString()} ft`;
    els.detailSpeed.textContent = `${Math.round(record.gs).toLocaleString()} kt`;
    els.detailTrack.textContent = `${Math.round(record.track)}°`;
    els.detailVertical.textContent = `${record.verticalRate >= 0 ? "+" : ""}${Math.round(record.verticalRate).toLocaleString()} ft/min`;
    els.detailSquawk.textContent = record.squawk || "—";
    els.detailAge.textContent = `${age.toFixed(age < 10 ? 1 : 0)} s`;
    els.detailHex.textContent = `ICAO: ${record.hex.toUpperCase()} · Position shown at ${state.altitudeScale}× altitude scale`;
    els.followBtn.textContent = state.followedHex === hex ? "Stop following" : "Follow aircraft";
  }

  function toggleFollow() {
    const hex = state.selectedHex;
    if (!hex) return;
    if (state.followedHex === hex) {
      state.viewer.trackedEntity = undefined;
      state.followedHex = null;
    } else {
      state.viewer.trackedEntity = state.entities.get(hex);
      state.followedHex = hex;
    }
    updateAircraftPanel(hex);
  }

  function viewFromBelow() {
    const record = state.records.get(state.selectedHex);
    if (!record) return;
    state.viewer.trackedEntity = undefined;
    state.followedHex = null;
    const altitudeM = Math.max(500, record.altitudeFt * FEET_TO_METRES * state.altitudeScale);
    state.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, Math.max(2_500, altitudeM * 0.18)),
      orientation: {
        heading: Cesium.Math.toRadians(record.track + 180),
        pitch: Cesium.Math.toRadians(35),
        roll: 0
      },
      duration: 1.5
    });
  }

  function rebuildAltitudeGeometry() {
    for (const [hex, record] of state.records) {
      const trail = state.trailEntities.get(hex);
      if (trail) {
        trail._history = [Cesium.Cartesian3.fromDegrees(
          record.lon,
          record.lat,
          record.altitudeFt * FEET_TO_METRES * state.altitudeScale
        )];
        trail.polyline.positions = trail._history.slice();
      }
    }
    if (state.selectedHex) updateAircraftPanel(state.selectedHex);
  }

  function wireEvents() {
    els.radiusSelect.addEventListener("change", () => {
      state.radiusNm = Number(els.radiusSelect.value);
      els.scanRadiusLabel.textContent = `${state.radiusNm} NM`;
      refreshAircraft();
    });
    els.scanViewBtn.addEventListener("click", scanViewCentre);
    els.locateBtn.addEventListener("click", useMyLocation);
    els.refreshBtn.addEventListener("click", () => refreshAircraft());
    els.homeBtn.addEventListener("click", flyHome);
    els.closePanelBtn.addEventListener("click", closeAircraftPanel);
    els.followBtn.addEventListener("click", toggleFollow);
    els.groundViewBtn.addEventListener("click", viewFromBelow);

    els.labelsToggle.addEventListener("change", () => {
      for (const entity of state.entities.values()) entity.label.show = els.labelsToggle.checked;
    });
    els.stemsToggle.addEventListener("change", () => {
      for (const entity of state.entities.values()) entity.polyline.show = els.stemsToggle.checked;
    });
    els.trailsToggle.addEventListener("change", () => {
      for (const entity of state.trailEntities.values()) entity.polyline.show = els.trailsToggle.checked;
    });
    els.autoRefreshToggle.addEventListener("change", () => {
      showToast(els.autoRefreshToggle.checked ? "Automatic live updates enabled." : "Automatic updates paused.");
    });
    els.altitudeScale.addEventListener("input", () => {
      state.altitudeScale = Number(els.altitudeScale.value);
      els.altitudeScaleLabel.value = `${state.altitudeScale}×`;
      rebuildAltitudeGeometry();
    });
    els.iconScale.addEventListener("input", () => {
      state.iconScale = Number(els.iconScale.value);
      els.iconScaleLabel.value = `${state.iconScale.toFixed(1)}×`;
      for (const entity of state.entities.values()) {
        entity.billboard.width = 30 * state.iconScale;
        entity.billboard.height = 30 * state.iconScale;
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && els.autoRefreshToggle.checked) refreshAircraft({ quiet: true });
    });
  }

  async function configureImagery(viewer) {
    try {
      const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
        { enablePickFeatures: false }
      );
      viewer.imageryLayers.addImageryProvider(provider);
    } catch (error) {
      console.warn("Satellite imagery failed; using Natural Earth fallback", error);
      const fallback = await Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
      );
      viewer.imageryLayers.addImageryProvider(fallback);
      showToast("Satellite tiles are unavailable, so a lower-resolution Earth layer is being used.", 6000);
    }
  }

  async function initialise() {
    if (!window.Cesium) {
      setStatus("error", "3D library failed to load");
      setLoading(true, "Cesium could not be downloaded. Check your connection and reload.");
      return;
    }

    setLoading(true, "Preparing the satellite globe…");
    const viewer = new Cesium.Viewer("cesiumContainer", {
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: true,
      fullscreenButton: true,
      vrButton: false,
      shouldAnimate: true,
      requestRenderMode: false
    });
    state.viewer = viewer;

    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.dynamicAtmosphereLighting = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.fog.enabled = true;
    viewer.scene.highDynamicRange = true;
    viewer.scene.skyAtmosphere.hueShift = -0.02;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 80;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 80_000_000;

    await configureImagery(viewer);

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat, 550_000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 }
    });

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      if (Cesium.defined(picked) && picked.id?.properties?.aircraftHex) {
        const hex = picked.id.properties.aircraftHex.getValue();
        selectAircraft(hex);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    wireEvents();
    startTimer();
    setLoading(true, "Requesting live aircraft near Stansted…");
    await refreshAircraft();
  }

  window.addEventListener("error", (event) => {
    console.error(event.error || event.message);
  });

  initialise();
})();
