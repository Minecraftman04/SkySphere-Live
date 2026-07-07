# SkySphere Live

A browser-only, live 3D aircraft tracker that places ADS-B targets at their reported altitude above a satellite-imagery globe. It is designed to run directly from GitHub Pages with no build step and no server.

## Features

- 3D CesiumJS Earth with Esri World Imagery
- Live aircraft positions from the open ADSB.lol API
- Aircraft placed at reported barometric/geometric altitude
- Smooth dead-reckoned movement between API updates
- Callsign, registration, type, altitude, speed, track, vertical rate and squawk details
- Altitude stems, recent trails, labels and aircraft following
- Scan the centre of the current view or use device location
- Responsive controls for desktop, mobile and in-car browsers
- No API key stored in the repository

## Important limitations

This is not a complete clone of FlightRadar24. Public volunteer ADS-B coverage is incomplete, positions can be delayed or inaccurate, and the public API has no guaranteed service level. The site scans a user-selected circle of up to 250 nautical miles rather than continuously downloading every aircraft worldwide.

The globe uses photorealistic satellite imagery, but it does not include Google Earth's proprietary global 3D photogrammetry. Plane altitude is shown accurately at `1×`; the optional altitude visual scale deliberately exaggerates separation for viewing from orbit.

## Run locally

Because browsers restrict some requests from `file://` pages, serve the folder locally:

```powershell
py -m http.server 8000
```

Then open `http://localhost:8000`.

## Publish with GitHub Pages

1. Open **Settings → Pages**.
2. Set **Source** to **Deploy from a branch**.
3. Select the `main` branch and `/ (root)`, then save.

The site will be available at `https://minecraftman04.github.io/SkySphere-Live/`.

## Data and imagery

- Aircraft data: [ADSB.lol](https://www.adsb.lol/docs/open-data/api/), licensed ODbL 1.0
- Imagery: Esri World Imagery, with attribution rendered by Cesium
- 3D globe engine: [CesiumJS](https://cesium.com/platform/cesiumjs/)

Use the services in accordance with their current terms and avoid excessive polling.
