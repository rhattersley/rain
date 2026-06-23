(() => {
  const PATH_LATEST_RUNS = "https://maps.consumer-digital.api.metoffice.gov.uk/v1/config/get-capabilities";
  const WMS_FC_BASE = "https://maps.consumer-digital.api.metoffice.gov.uk/wms_fc/single/high-res";
  const WMS_OB_BASE = "https://maps.consumer-digital.api.metoffice.gov.uk/wms_ob/single/high-res";
  const RAINFALL_LAYER = "total_precipitation_rate";
  const RAINFALL_OB_LAYER = "rainfall_radar";
  const MAP_BOUNDS = L.latLngBounds([40, -25], [64, 16]);
  const HOUR_MS = 60 * 60 * 1000;
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const PLAYBACK_HOURS_PER_SECOND = 3;
  const TICK_COLOR_MAJOR = "#22354f";
  const TICK_COLOR_MINOR = "rgba(34,53,79,0.35)";
  const TICK_COLOR_OB_MAJOR = "#a7adb4";
  const TICK_COLOR_OB_MINOR = "rgba(175, 183, 194, 0.45)";
  const LABEL_COLOR = "#10233a";
  const LABEL_COLOR_OB = "#b6bcc4";

  const map = L.map("map", {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: false,
    keyboard: false,
    zoomSnap: 0.25
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    subdomains: "abc",
    maxZoom: 9,
    minZoom: 4,
    opacity: 0.85
  }).addTo(map);

  map.fitBounds(L.latLngBounds([48, -12], [60, 1.5]));

  const slider = document.getElementById("slider");
  const ruler = document.getElementById("ruler");
  const timeLabel = document.getElementById("timeLabel");
  const resetNowButton = document.getElementById("resetNow");
  const playPauseButton = document.getElementById("playPause");

  const state = {
    availability: new Map(),
    availableTimes: [],
    selectedTimeMs: 0,
    viewStartMs: 0,
    pxPerHour: 1,
    dragging: false,
    velocityPxPerMs: 0,
    pointerId: null,
    lastX: 0,
    lastT: 0,
    overlay: null,
    frameHandle: 0,
    pendingUpdate: 0,
    renderToken: 0,
    prefetchHandle: 0,
    prefetchToken: 0,
    imageCache: new Map(),
    isPlaying: false,
    playbackHandle: 0,
    playbackLastFrameMs: 0,
    playbackCursorMs: 0
  };

  function updatePlayPauseButton() {
    playPauseButton.textContent = state.isPlaying ? "\u275A\u275A" : "\u25B6";
    playPauseButton.setAttribute("aria-label", state.isPlaying ? "Pause playback" : "Play playback");
    playPauseButton.setAttribute("aria-pressed", String(state.isPlaying));
  }

  function parseIsoDurationToMs(value) {
    if (!value || value === "PT0S") {
      return 0;
    }
    const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) {
      return 0;
    }
    const days = Number(m[1] || 0);
    const hours = Number(m[2] || 0);
    const minutes = Number(m[3] || 0);
    const seconds = Number(m[4] || 0);
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }

  function parseXml(text) {
    return new DOMParser().parseFromString(text, "text/xml");
  }

  function readTextList(parent, selector) {
    return Array.from(parent.querySelectorAll(selector))
      .map((node) => node.textContent.trim())
      .filter(Boolean);
  }

  function addForecastEntries(store, layerNode, horizon) {
    const runs = readTextList(layerNode, `${horizon} > model_runs > model_run`);
    const timesteps = readTextList(layerNode, `${horizon} > timesteps > timestep`);

    for (const runIso of runs) {
      const runMs = Date.parse(runIso);
      if (!Number.isFinite(runMs)) {
        continue;
      }

      for (const stepIso of timesteps) {
        const leadMs = parseIsoDurationToMs(stepIso);
        const validMs = runMs + leadMs;
        const url = `${WMS_FC_BASE}/${horizon}/${RAINFALL_LAYER}/${runIso}/${stepIso}.png`;

        // Later writes override earlier ones, matching Met Office behavior
        // where newer runs replace older values at overlapping valid times.
        store.set(validMs, {
          url,
          validMs,
          runIso,
          stepIso,
          source: `fc-${horizon}`
        });
      }
    }
  }

  function addObservationEntries(store, obXml) {
    const runs = readTextList(obXml, `layers > ${RAINFALL_OB_LAYER} > model_runs > model_run`);
    for (const runIso of runs) {
      const validMs = Date.parse(runIso);
      if (!Number.isFinite(validMs)) {
        continue;
      }
      const url = `${WMS_OB_BASE}/${RAINFALL_OB_LAYER}/${runIso}.png`;
      store.set(validMs, {
        url,
        validMs,
        runIso,
        stepIso: "PT0S",
        source: "ob"
      });
    }
  }

  async function loadAvailability() {
    const [fcText, obText] = await Promise.all([
      fetch(`${PATH_LATEST_RUNS}/fc.xml`).then((r) => r.text()),
      fetch(`${PATH_LATEST_RUNS}/ob.xml`).then((r) => r.text())
    ]);

    const fcXml = parseXml(fcText);
    const obXml = parseXml(obText);
    const rainfallNode = fcXml.querySelector(`layers > ${RAINFALL_LAYER}`);

    if (!rainfallNode) {
      throw new Error("Rainfall availability node not found in fc.xml");
    }

    const store = new Map();
    addForecastEntries(store, rainfallNode, "long");
    addForecastEntries(store, rainfallNode, "short");
    addObservationEntries(store, obXml);

    return store;
  }

  function clampViewStart(ms) {
    if (!state.availableTimes.length) {
      return ms;
    }
    const min = state.availableTimes[0];
    const max = Math.max(min, state.availableTimes[state.availableTimes.length - 1] - 12 * HOUR_MS);
    return Math.min(max, Math.max(min, ms));
  }

  function updatePxPerHour() {
    state.pxPerHour = slider.clientWidth / 12;
  }

  function nearestAvailableTime(targetMs) {
    const list = state.availableTimes;
    if (!list.length) {
      return 0;
    }

    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (list[mid] < targetMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const right = list[lo];
    const left = lo > 0 ? list[lo - 1] : right;
    return Math.abs(targetMs - left) <= Math.abs(right - targetMs) ? left : right;
  }

  function setSelectedTime(timeMs) {
    const chosen = nearestAvailableTime(timeMs);
    state.selectedTimeMs = chosen;
    if (!state.isPlaying) {
      state.playbackCursorMs = chosen;
    }
    state.viewStartMs = clampViewStart(chosen - 6 * HOUR_MS);
    queueOverlayUpdate();
    queueBackgroundPrefetch();
    drawRuler();
  }

  function updateFromDrag(deltaPx) {
    const deltaMs = (deltaPx / state.pxPerHour) * HOUR_MS;
    state.viewStartMs = clampViewStart(state.viewStartMs - deltaMs);
    const centerMs = state.viewStartMs + 6 * HOUR_MS;
    state.selectedTimeMs = nearestAvailableTime(centerMs);
    queueOverlayUpdate();
    queueBackgroundPrefetch();
    drawRuler();
  }

  function queueOverlayUpdate() {
    if (state.pendingUpdate) {
      cancelAnimationFrame(state.pendingUpdate);
    }
    state.pendingUpdate = requestAnimationFrame(renderRainfall);
  }

  function ensureImageDownloaded(url) {
    const cached = state.imageCache.get(url);
    if (cached) {
      return cached.promise;
    }

    const image = new Image();
    image.decoding = "async";

    const promise = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load ${url}`));
    });

    state.imageCache.set(url, { image, promise });
    image.src = url;
    return promise;
  }

  function queueBackgroundPrefetch() {
    if (state.prefetchHandle) {
      cancelAnimationFrame(state.prefetchHandle);
    }
    state.prefetchHandle = requestAnimationFrame(startBackgroundPrefetch);
  }

  async function startBackgroundPrefetch() {
    state.prefetchHandle = 0;
    const startIndex = state.availableTimes.indexOf(state.selectedTimeMs);
    if (startIndex < 0) {
      return;
    }

    const token = ++state.prefetchToken;

    for (let index = startIndex; index < state.availableTimes.length; index += 1) {
      if (token !== state.prefetchToken) {
        return;
      }

      const entry = state.availability.get(state.availableTimes[index]);
      if (!entry) {
        continue;
      }

      try {
        await ensureImageDownloaded(entry.url);
      } catch {
        // Ignore individual image failures and keep advancing through the queue.
      }
    }
  }

  function drawRuler() {
    const dpr = window.devicePixelRatio || 1;
    const width = slider.clientWidth;
    const height = slider.clientHeight;
    ruler.width = Math.floor(width * dpr);
    ruler.height = Math.floor(height * dpr);
    const ctx = ruler.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const startMs = state.viewStartMs;
    const endMs = startMs + 12 * HOUR_MS;
    const firstTickMs = Math.floor(startMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
    const minAvailableMs = state.availableTimes[0];
    const maxAvailableMs = state.availableTimes[state.availableTimes.length - 1];
    const minScrollableMs = minAvailableMs + 6 * HOUR_MS;
    const maxScrollableMs = maxAvailableMs - 6 * HOUR_MS;
    const hasScrollableSpan = minScrollableMs <= maxScrollableMs;

    for (let t = firstTickMs; t <= endMs + QUARTER_HOUR_MS; t += QUARTER_HOUR_MS) {
      const x = ((t - startMs) / HOUR_MS) * state.pxPerHour;
      const outOfDataRange = t < minAvailableMs || t > maxAvailableMs;
      const outOfScrollableRange = hasScrollableSpan && (t < minScrollableMs || t > maxScrollableMs);

      if (x < 0 || x > width || outOfDataRange || outOfScrollableRange) {
        continue;
      }

      const isObservation = state.availability.get(t)?.source === "ob";
      const quarter = Math.floor((t / QUARTER_HOUR_MS) % 4 + 4) % 4;
      const major = quarter === 0;
      const half = quarter === 2;
      const yTop = major ? 10 : half ? 18 : 25;
      ctx.strokeStyle = major
        ? (isObservation ? TICK_COLOR_OB_MAJOR : TICK_COLOR_MAJOR)
        : (isObservation ? TICK_COLOR_OB_MINOR : TICK_COLOR_MINOR);
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, height - 10);
      ctx.stroke();

      if (major) {
        const dt = new Date(t);
        const hh = String(dt.getUTCHours()).padStart(2, "0");
        ctx.fillStyle = isObservation ? LABEL_COLOR_OB : LABEL_COLOR;
        ctx.font = "600 12px IBM Plex Sans, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(hh, x, height - 16);
      }
    }

    const dt = new Date(state.selectedTimeMs);
    timeLabel.dateTime = dt.toISOString();
    timeLabel.textContent = dt.toLocaleString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
      timeZoneName: "short"
    });

    const idx = state.availableTimes.indexOf(state.selectedTimeMs);
    slider.setAttribute("aria-valuenow", String(idx < 0 ? 0 : idx));
    slider.setAttribute("aria-valuemax", String(Math.max(0, state.availableTimes.length - 1)));

  }

  async function renderRainfall() {
    state.pendingUpdate = 0;
    const token = ++state.renderToken;
    const selected = state.availability.get(state.selectedTimeMs);
    if (!selected) {
      return;
    }

    try {
      await ensureImageDownloaded(selected.url);
    } catch {
      return;
    }

    if (token !== state.renderToken || state.selectedTimeMs !== selected.validMs) {
      return;
    }

    const url = selected.url;

    if (!state.overlay) {
      state.overlay = L.imageOverlay(url, MAP_BOUNDS);
      state.overlay.addTo(map);
    } else {
      state.overlay.setUrl(url);
    }

    queueBackgroundPrefetch();
  }

  function stopMomentum() {
    if (state.frameHandle) {
      cancelAnimationFrame(state.frameHandle);
      state.frameHandle = 0;
    }
  }

  function stopPlayback() {
    if (state.playbackHandle) {
      cancelAnimationFrame(state.playbackHandle);
      state.playbackHandle = 0;
    }
    state.isPlaying = false;
    updatePlayPauseButton();
  }

  function startPlayback() {
    if (!state.availableTimes.length) {
      return;
    }

    stopMomentum();
    state.velocityPxPerMs = 0;
    state.isPlaying = true;
    state.playbackCursorMs = state.selectedTimeMs;
    state.playbackLastFrameMs = performance.now();
    updatePlayPauseButton();

    const maxAvailable = state.availableTimes[state.availableTimes.length - 1];

    function step(now) {
      if (!state.isPlaying) {
        state.playbackHandle = 0;
        return;
      }

      const dtMs = now - state.playbackLastFrameMs;
      state.playbackLastFrameMs = now;
      state.playbackCursorMs += (dtMs * PLAYBACK_HOURS_PER_SECOND * HOUR_MS) / 1000;

      if (state.playbackCursorMs >= maxAvailable) {
        state.playbackCursorMs = maxAvailable;
        setSelectedTime(state.playbackCursorMs);
        stopPlayback();
        return;
      }

      setSelectedTime(state.playbackCursorMs);
      state.playbackHandle = requestAnimationFrame(step);
    }

    state.playbackHandle = requestAnimationFrame(step);
  }

  function togglePlayback() {
    if (state.isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function startMomentum() {
    stopMomentum();
    const friction = 0.0032;
    let prev = performance.now();

    function step(now) {
      const dt = now - prev;
      prev = now;
      const v = state.velocityPxPerMs;
      if (Math.abs(v) < 0.004) {
        state.frameHandle = 0;
        state.velocityPxPerMs = 0;
        return;
      }
      updateFromDrag(v * dt);
      const decay = Math.exp(-friction * dt);
      state.velocityPxPerMs *= decay;
      state.frameHandle = requestAnimationFrame(step);
    }

    state.frameHandle = requestAnimationFrame(step);
  }

  slider.addEventListener("pointerdown", (ev) => {
    stopPlayback();
    state.dragging = true;
    state.pointerId = ev.pointerId;
    state.lastX = ev.clientX;
    state.lastT = ev.timeStamp;
    state.velocityPxPerMs = 0;
    slider.setPointerCapture(ev.pointerId);
    stopMomentum();
  });

  slider.addEventListener("pointermove", (ev) => {
    if (!state.dragging || ev.pointerId !== state.pointerId) {
      return;
    }
    const dx = ev.clientX - state.lastX;
    const dt = Math.max(1, ev.timeStamp - state.lastT);
    state.velocityPxPerMs = dx / dt;
    state.lastX = ev.clientX;
    state.lastT = ev.timeStamp;
    updateFromDrag(dx);
  });

  function releasePointer(ev) {
    if (!state.dragging || ev.pointerId !== state.pointerId) {
      return;
    }
    state.dragging = false;
    state.pointerId = null;
    slider.releasePointerCapture(ev.pointerId);
    startMomentum();
  }

  slider.addEventListener("pointerup", releasePointer);
  slider.addEventListener("pointercancel", releasePointer);

  slider.addEventListener("keydown", (ev) => {
    stopPlayback();
    if (ev.key === "ArrowRight") {
      const idx = state.availableTimes.indexOf(state.selectedTimeMs);
      const nextIdx = Math.min(state.availableTimes.length - 1, idx + 1);
      setSelectedTime(state.availableTimes[nextIdx]);
      ev.preventDefault();
    }
    if (ev.key === "ArrowLeft") {
      const idx = state.availableTimes.indexOf(state.selectedTimeMs);
      const prevIdx = Math.max(0, idx - 1);
      setSelectedTime(state.availableTimes[prevIdx]);
      ev.preventDefault();
    }
    if (ev.key === "PageUp") {
      setSelectedTime(state.selectedTimeMs + 6 * HOUR_MS);
      ev.preventDefault();
    }
    if (ev.key === "PageDown") {
      setSelectedTime(state.selectedTimeMs - 6 * HOUR_MS);
      ev.preventDefault();
    }
    if (ev.key === "Home") {
      setSelectedTime(state.availableTimes[0]);
      ev.preventDefault();
    }
    if (ev.key === "End") {
      setSelectedTime(state.availableTimes[state.availableTimes.length - 1]);
      ev.preventDefault();
    }
  });

  resetNowButton.addEventListener("click", () => {
    stopPlayback();
    stopMomentum();
    state.velocityPxPerMs = 0;
    setSelectedTime(Date.now());
  });

  playPauseButton.addEventListener("click", () => {
    togglePlayback();
  });

  window.addEventListener("resize", () => {
    updatePxPerHour();
    state.viewStartMs = clampViewStart(state.selectedTimeMs - 6 * HOUR_MS);
    drawRuler();
  });

  async function init() {
    updatePxPerHour();
    resetNowButton.disabled = true;
    playPauseButton.disabled = true;
    updatePlayPauseButton();
    state.availability = await loadAvailability();
    state.availableTimes = Array.from(state.availability.keys()).sort((a, b) => a - b);

    if (!state.availableTimes.length) {
      throw new Error("No rainfall times available");
    }

    setSelectedTime(Date.now());
    resetNowButton.disabled = false;
    playPauseButton.disabled = false;
  }

  init().catch(() => {
    resetNowButton.disabled = true;
    playPauseButton.disabled = true;
    timeLabel.textContent = "Rainfall source unavailable";
  });
})();
