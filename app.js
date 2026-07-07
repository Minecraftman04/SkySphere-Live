/* Loads the compressed SkySphere Live application bundle. */
(async () => {
  "use strict";
  try {
    if (!("DecompressionStream" in window)) {
      throw new Error("This browser does not support gzip decompression streams.");
    }
    const response = await fetch("app.bundle.gz", { cache: "no-store" });
    if (!response.ok || !response.body) {
      throw new Error(`Could not load application bundle (HTTP ${response.status}).`);
    }
    const source = await new Response(
      response.body.pipeThrough(new DecompressionStream("gzip"))
    ).text();
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const script = document.createElement("script");
    script.src = blobUrl;
    script.onload = () => URL.revokeObjectURL(blobUrl);
    script.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      throw new Error("The SkySphere Live application could not start.");
    };
    document.head.appendChild(script);
  } catch (error) {
    console.error(error);
    const message = document.getElementById("loadingMessage");
    if (message) message.textContent = `Application failed to load: ${error.message}`;
    const status = document.getElementById("statusText");
    if (status) status.textContent = "Load error";
    const liveStatus = document.getElementById("liveStatus");
    if (liveStatus) liveStatus.classList.add("error");
  }
})();
