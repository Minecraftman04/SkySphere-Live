/*
 * Loads SkySphere's optional features without replacing Cesium.Viewer.
 * Cesium exposes Viewer as a read-only module export, so the earlier attempt
 * to overwrite it stopped features.js before any controls were created.
 */
(() => {
  "use strict";

  let captured = false;

  function publishViewer(viewer) {
    if (captured || !viewer) return;
    captured = true;
    window.skySphereViewer = viewer;
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("skysphere-viewer-ready", {
        detail: { viewer }
      }));
    }, 0);
  }

  function installViewerBridge() {
    if (!window.Cesium?.Viewer?.prototype) return;
    const prototype = window.Cesium.Viewer.prototype;

    // Viewer assigns _cesiumWidget during construction. A temporary inherited
    // setter lets us observe that one assignment without replacing Viewer.
    if (!Object.prototype.hasOwnProperty.call(prototype, "_cesiumWidget")) {
      try {
        Object.defineProperty(prototype, "_cesiumWidget", {
          configurable: true,
          get() {
            return this.__skySphereCesiumWidget;
          },
          set(value) {
            Object.defineProperty(this, "_cesiumWidget", {
              value,
              writable: true,
              configurable: true,
              enumerable: false
            });
            publishViewer(this);
          }
        });
      } catch (error) {
        console.warn("SkySphere could not install the primary Viewer bridge", error);
      }
    }

    // Secondary bridge for Cesium versions that construct Viewer differently.
    for (const name of ["resize", "forceResize", "render"]) {
      const original = prototype[name];
      if (typeof original !== "function" || original.__skySphereWrapped) continue;
      const wrapped = function (...args) {
        publishViewer(this);
        return original.apply(this, args);
      };
      wrapped.__skySphereWrapped = true;
      try {
        prototype[name] = wrapped;
      } catch (error) {
        console.warn(`SkySphere could not wrap Viewer.${name}`, error);
      }
    }
  }

  async function loadFeatures() {
    try {
      const response = await fetch(`features.js?v=20260707-6`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let source = await response.text();

      const replacement = `  function installViewerCapture() {
    const startFeatures = (viewer) => {
      if (!viewer || featureState.uiReady) return;
      featureState.viewer = viewer;
      window.skySphereViewer = viewer;
      setTimeout(() => initialiseFeatures(viewer), 0);
    };
    if (window.skySphereViewer) {
      startFeatures(window.skySphereViewer);
    } else {
      window.addEventListener("skysphere-viewer-ready", (event) => {
        startFeatures(event.detail && event.detail.viewer);
      }, { once: true });
    }
  }

  installViewerCapture();`;

      const pattern = /  function installViewerCapture\(\) \{[\s\S]*?\n  installViewerCapture\(\);/;
      if (!pattern.test(source)) {
        throw new Error("Feature bootstrap block was not found");
      }
      source = source.replace(pattern, replacement);
      source += "\n//# sourceURL=skysphere-features-runtime.js";

      const script = document.createElement("script");
      script.textContent = source;
      document.head.appendChild(script);
      script.remove();
    } catch (error) {
      console.error("SkySphere feature loader failed", error);
      const note = document.querySelector(".source-note");
      if (note) note.textContent = `Build 2026.07.07.6 · Feature loader error: ${error.message}`;
    }
  }

  installViewerBridge();
  loadFeatures();
})();
