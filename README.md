# SkySphere Live

A browser-only, live 3D aircraft tracker that places ADS-B targets at their reported altitude above a satellite-imagery globe. It runs directly from GitHub Pages with no build step and no dedicated server.

## Features

- 3D CesiumJS Earth with Esri World Imagery
- Live aircraft positions with automatic public-provider fallback
- Aircraft placed at reported barometric/geometric altitude
- Smooth dead-reckoned movement between API updates
- Callsign, registration, type, altitude, speed, track, vertical rate and squawk details
- Altitude stems, recent trails, labels and aircraft following
- Camera compass with live heading and a **Point north** button
- Worldwide large, medium and scheduled-service airport labels sourced from OurAirports
- Airport search by name, ICAO or IATA code
- Selectable airports with current raw METAR and TAF reports
- Airport traffic filters for **Both**, **Inbound** and **Outbound**
- Scan the centre of the current view, an airport, or the device location
- Responsive controls for desktop, mobile and in-car browsers
- No API key stored in the repository

## Airport traffic filtering

The public ADS-B feeds do not reliably include the filed origin and destination for every aircraft. SkySphere therefore estimates inbound and outbound traffic from an aircraft's current position and track relative to the selected airport, within 100 nautical miles. It should be treated as a directional traffic filter rather than confirmation of a filed destination.

## Important limitations

This is not a complete clone of FlightRadar24. Public volunteer ADS-B coverage is incomplete, positions can be delayed or inaccurate, and the public services have no guaranteed service level. The site scans a user-selected circle of up to 250 nautical miles rather than continuously downloading every aircraft worldwide.

The globe uses photorealistic satellite imagery, but it does not include Google Earth's proprietary global 3D photogrammetry. Plane altitude is shown accurately at `1×`; the optional altitude visual scale deliberately exaggerates separation for viewing from orbit.

METAR and TAF availability varies by airport. Some airports publish a METAR but no TAF, and some publish neither.

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

The site is available at `https://minecraftman04.github.io/SkySphere-Live/`.

## Data and imagery

- Aircraft data: Airplanes.live, adsb.fi and ADSB.lol public endpoints
- Airport data: [OurAirports](https://ourairports.com/data/), Public Domain
- METAR/TAF data: [Aviation Weather Center Data API](https://aviationweather.gov/data/api/)
- Imagery: Esri World Imagery, with attribution rendered by Cesium
- 3D globe engine: [CesiumJS](https://cesium.com/platform/cesiumjs/)

Use the services in accordance with their current terms and avoid excessive polling.
