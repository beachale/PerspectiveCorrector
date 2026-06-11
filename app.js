(() => {
  const editorCanvas = document.getElementById('editorCanvas');
  const editorCtx = editorCanvas.getContext('2d');
  const outputCanvas = document.getElementById('outputCanvas');
  const outputCtx = outputCanvas.getContext('2d');

  const fileInput = document.getElementById('fileInput');
  const loadSampleBtn = document.getElementById('loadSampleBtn');
  const resetWarpsBtn = document.getElementById('resetWarpsBtn');
  const rectifyBtn = document.getElementById('rectifyBtn');
  const livePreviewToggle = document.getElementById('livePreviewToggle');
  const smoothPixelsToggle = document.getElementById('smoothPixelsToggle');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyBtn = document.getElementById('copyBtn');

  const outputMode = document.getElementById('outputMode');
  const exportSampling = document.getElementById('exportSampling');
  const resolutionFields = document.getElementById('resolutionFields');
  const outWidthInput = document.getElementById('outWidth');
  const outHeightInput = document.getElementById('outHeight');
  const outputSummary = document.getElementById('outputSummary');

  const emptyState = document.getElementById('emptyState');
  const statusText = document.getElementById('statusText');
  const progressShell = document.getElementById('progressShell');
  const progressBar = document.getElementById('progressBar');
  const previewMeta = document.getElementById('previewMeta');
  const previewPlaceholder = document.getElementById('previewPlaceholder');
  const previewStage = document.querySelector('.preview-stage');

  const state = {
    image: null,
    imageName: 'image',
    imageCanvas: document.createElement('canvas'),
    imageCtx: null,
    imageData: null,
    quad: null,
    edgeWarps: createDefaultEdgeWarps(),
    selectedCorner: -1,
    selectedEdge: -1,
    selectedWarp: -1,
    zoom: 1,
    pan: { x: 0, y: 0 },
    dragging: null,
    spaceDown: false,
    dimAmount: 0,
    lastOutputBlob: null,
    lastOutputSize: null,
    livePreviewEnabled: false,
    livePreviewRendering: false,
    finalRendering: false,
    livePreviewPending: false,
    livePreviewTimer: null,
    livePreviewRequestId: 0,
    editorDrawRequested: false,
    renderWorker: null,
    renderWorkerSourceReady: false,
    renderWorkerUnavailable: false,
    smoothEditorPixels: false,
    renderJobSeq: 0,
    renderJobs: new Map(),
    activeWorkerJobId: null,
    pendingWorkerSource: null,
    usingDemoDefaults: false,
  };
  state.imageCtx = state.imageCanvas.getContext('2d', { willReadFrequently: true });

  const ASSET_VERSION = '20260611-21';
  const DEFAULT_OUTPUT_WIDTH = 1920;
  const DEFAULT_OUTPUT_HEIGHT = 1080;
  const DEMO_IMAGE_NAME = 'demo-photo';
  const DEMO_OUTPUT_WIDTH = 1686;
  const DEMO_OUTPUT_HEIGHT = 1024;
  const DEMO_QUAD = [
    { x: 350.41, y: 76.4 },
    { x: 1768.05, y: 195.59 },
    { x: 1958.34, y: 1003.32 },
    { x: 343.07, y: 1208.57 },
  ];
  const DEMO_EDGE_WARPS = [
    [{ t: 0.5, offset: 4.04 }],
    [{ t: 0.5, offset: 0 }],
    [{ t: 0.4997, offset: 1.69 }],
    [{ t: 0.5005, offset: -1.05 }],
  ];
  const HANDLE_RADIUS = 9;
  const EDGE_HIT_RADIUS = 12;
  const EDGE_WARP_HANDLE_HIT_RADIUS = 18;
  const EDGE_WARP_HANDLE_MIN_T = 0.08;
  const EDGE_WARP_HANDLE_MAX_T = 0.92;
  const MAX_EDGE_WARPS = 6;
  const VIEW_PADDING = 38;
  const MAX_PIXELS = 50_000_000;
  const DIM_SLIDER_MAX = 0.6;
  const DIM_SLIDER_HIT_RADIUS = 18;
  const GRID_DIVISIONS = 4;
  const EDGE_CURVE_DRAW_STEPS = 24;
  const GRID_LINE_DRAW_STEPS = 14;
  const EDGE_HIT_TEST_STEPS = 18;
  const EDGE_WARP_ADD_STEPS = 48;
  const LIVE_PREVIEW_MAX_LONG_EDGE = 900;
  const LIVE_PREVIEW_MAX_PIXELS = 360_000;
  const LIVE_PREVIEW_DEBOUNCE_MS = 140;



  function ensureRenderWorker() {
    if (state.renderWorkerUnavailable || typeof Worker === 'undefined') return null;
    if (state.renderWorker) return state.renderWorker;

    try {
      const worker = new Worker(`render-worker.js?v=${ASSET_VERSION}`);
      worker.addEventListener('message', handleRenderWorkerMessage);
      worker.addEventListener('error', error => {
        console.error('Render worker failed:', error);
        disableRenderWorker(error.message || 'Render worker failed.');
      });
      state.renderWorker = worker;
      return worker;
    } catch (error) {
      console.warn('Render worker is unavailable; falling back to main-thread rendering.', error);
      state.renderWorkerUnavailable = true;
      return null;
    }
  }

  function disableRenderWorker(reason = 'Render worker unavailable.') {
    if (state.pendingWorkerSource) {
      state.pendingWorkerSource.resolve(false);
      state.pendingWorkerSource = null;
    }

    for (const job of state.renderJobs.values()) {
      if (job.cancelTimer) clearInterval(job.cancelTimer);
      job.reject(new Error(reason));
    }

    state.renderJobs.clear();
    state.activeWorkerJobId = null;
    state.renderWorkerSourceReady = false;
    state.renderWorkerUnavailable = true;

    if (state.renderWorker) {
      state.renderWorker.terminate();
      state.renderWorker = null;
    }
  }

  function handleRenderWorkerMessage(event) {
    const message = event.data || {};

    if (message.type === 'sourceReady') {
      state.renderWorkerSourceReady = true;
      if (state.pendingWorkerSource?.sourceId === message.sourceId) {
        state.pendingWorkerSource.resolve(true);
        state.pendingWorkerSource = null;
      }
      return;
    }

    if (message.type === 'sourceError') {
      state.renderWorkerSourceReady = false;
      if (state.pendingWorkerSource?.sourceId === message.sourceId) {
        state.pendingWorkerSource.resolve(false);
        state.pendingWorkerSource = null;
      }
      return;
    }

    const job = state.renderJobs.get(message.jobId);
    if (!job) return;

    if (message.type === 'progress') {
      if (job.isCancelled?.()) cancelWorkerJob(message.jobId);
      else job.onProgress?.(message.value);
      return;
    }

    if (job.cancelTimer) clearInterval(job.cancelTimer);
    state.renderJobs.delete(message.jobId);
    if (state.activeWorkerJobId === message.jobId) state.activeWorkerJobId = null;

    if (message.type === 'done') {
      const data = new Uint8ClampedArray(message.buffer);
      job.resolve(new ImageData(data, message.width, message.height));
      return;
    }

    if (message.type === 'cancelled') {
      job.resolve(null);
      return;
    }

    if (message.type === 'error') {
      job.reject(new Error(message.message || 'Perspective render failed.'));
    }
  }

  async function setRenderWorkerSource() {
    const worker = ensureRenderWorker();
    if (!worker || !state.imageData) return false;

    const sourceId = ++state.renderJobSeq;
    state.renderWorkerSourceReady = false;

    return new Promise(resolve => {
      state.pendingWorkerSource = { sourceId, resolve };
      const buffer = state.imageData.data.slice().buffer;
      worker.postMessage({
        type: 'setSource',
        sourceId,
        width: state.imageData.width,
        height: state.imageData.height,
        buffer,
      }, [buffer]);
    });
  }

  function cancelWorkerJob(jobId = state.activeWorkerJobId) {
    if (!state.renderWorker || jobId == null) return;
    state.renderWorker.postMessage({ type: 'cancel', jobId });
  }

  async function buildPerspectiveImage(outW, outH, onProgress = null, isCancelled = null, sampling = 'bilinear') {
    if (state.renderWorkerSourceReady && state.renderWorker && !state.renderWorkerUnavailable) {
      try {
        return await buildPerspectiveImageInWorker(outW, outH, onProgress, isCancelled, sampling);
      } catch (error) {
        console.warn('Worker render failed; falling back to main-thread rendering.', error);
        disableRenderWorker(error.message || 'Worker render failed.');
        if (isCancelled?.()) return null;
      }
    }

    return buildPerspectiveImageOnMain(outW, outH, onProgress, isCancelled, sampling);
  }

  function buildPerspectiveImageInWorker(outW, outH, onProgress = null, isCancelled = null, sampling = 'bilinear') {
    if (isCancelled?.()) return Promise.resolve(null);
    if (state.activeWorkerJobId != null) cancelWorkerJob(state.activeWorkerJobId);

    const worker = ensureRenderWorker();
    if (!worker || !state.renderWorkerSourceReady) return buildPerspectiveImageOnMain(outW, outH, onProgress, isCancelled, sampling);

    const jobId = ++state.renderJobSeq;
    state.activeWorkerJobId = jobId;

    return new Promise((resolve, reject) => {
      const cancelTimer = setInterval(() => {
        if (isCancelled?.()) cancelWorkerJob(jobId);
      }, 50);

      state.renderJobs.set(jobId, { resolve, reject, onProgress, isCancelled, cancelTimer });
      worker.postMessage({
        type: 'render',
        jobId,
        width: outW,
        height: outH,
        quad: copyQuad(state.quad),
        warps: copyEdgeWarps(),
        sampling,
      });
    });
  }

  function setStatus(message, tone = 'muted') {
    statusText.textContent = message;
    statusText.style.color = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--muted)';
  }

  function setProgress(value) {
    if (value == null) {
      progressShell.classList.add('hidden');
      progressBar.style.width = '0%';
      return;
    }
    progressShell.classList.remove('hidden');
    progressBar.style.width = `${clamp(value, 0, 100)}%`;
  }

  function setExportButtonsEnabled(enabled) {
    downloadBtn.disabled = !enabled;
    copyBtn.disabled = !enabled;
  }

  function resizeEditorCanvas() {
    const rect = editorCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    editorCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    editorCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    editorCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawEditor();
  }

  function getEditorSize() {
    const rect = editorCanvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  function requestEditorDraw() {
    if (state.editorDrawRequested) return;
    state.editorDrawRequested = true;
    requestAnimationFrame(() => {
      state.editorDrawRequested = false;
      drawEditor();
    });
  }

  function getViewTransform() {
    if (!state.image) return { scale: 1, x: 0, y: 0 };
    const { width, height } = getEditorSize();
    const base = Math.min(
      (width - VIEW_PADDING * 2) / state.image.width,
      (height - VIEW_PADDING * 2) / state.image.height,
    );
    const scale = Math.max(0.02, base * state.zoom);
    const x = (width - state.image.width * scale) / 2 + state.pan.x;
    const y = (height - state.image.height * scale) / 2 + state.pan.y;
    return { scale, x, y };
  }

  function imageToScreen(point, t = getViewTransform()) {
    return { x: t.x + point.x * t.scale, y: t.y + point.y * t.scale };
  }

  function screenToImage(point) {
    const t = getViewTransform();
    return { x: (point.x - t.x) / t.scale, y: (point.y - t.y) / t.scale };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function copyPoint(point) {
    return { x: point.x, y: point.y };
  }

  function copyQuad(quad) {
    return quad.map(copyPoint);
  }


  function resetQuad() {
    if (!state.image) {
        return;
    }

    if (state.usingDemoDefaults) {
      state.quad = copyQuad(DEMO_QUAD);
    } else {
      const w = state.image.width;
      const h = state.image.height;
      const mx = w * 0.09;
      const my = h * 0.09;
      state.quad = [
        { x: mx, y: my },
        { x: w - mx, y: my },
        { x: w - mx, y: h - my },
        { x: mx, y: h - my },
      ];
    }

    resetEdgeWarps();
    clearSelection();
    refreshGeometry();
  }

  function fitView() {
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    drawEditor();
  }

  function drawEditor() {
    const { width, height } = getEditorSize();
    editorCtx.clearRect(0, 0, width, height);

    if (!state.image) return;

    const t = getViewTransform();
    // Disabled = nearest-neighbor/pixel-exact; enabled = bilinear-smoothed editor display.
    editorCtx.imageSmoothingEnabled = state.smoothEditorPixels;
    if (state.smoothEditorPixels) editorCtx.imageSmoothingQuality = 'medium';
    editorCtx.drawImage(state.image, t.x, t.y, state.image.width * t.scale, state.image.height * t.scale);

    if (!state.quad) return;

    const points = state.quad.map(point => imageToScreen(point, t));

    if (state.dimAmount > 0.005) {
      // Draw the dimmer only outside the selected quadrilateral.
      // Do not use destination-out here: it erases the already-drawn photo
      // inside the selection and makes the frame appear as a white/blank fill.
      editorCtx.save();
      editorCtx.fillStyle = `rgba(0, 0, 0, ${state.dimAmount.toFixed(3)})`;
      editorCtx.beginPath();
      editorCtx.rect(0, 0, width, height);
      traceSelectionPath(editorCtx, t);
      editorCtx.fill('evenodd');
      editorCtx.restore();
    }

    editorCtx.save();
    editorCtx.globalCompositeOperation = 'source-over';
    editorCtx.lineWidth = 2;
    editorCtx.strokeStyle = 'rgba(244, 244, 244, 0.96)';
    editorCtx.beginPath();
    traceSelectionPath(editorCtx, t);
    editorCtx.stroke();
    editorCtx.beginPath();
    editorCtx.restore();

    drawPerspectiveGrid(points, t);
    drawEdgeHandles(points, t);
    drawCornerHandles(points);
    drawDimSlider(width, height);
  }

  function drawPerspectiveGrid(points, viewTransform) {
    if (points.length !== 4) return;

    let H;
    try {
      H = getUnitToQuadHomography();
    } catch (_) {
      return;
    }

    const useWarp = hasSideWarp();

    editorCtx.save();
    editorCtx.strokeStyle = 'rgba(244, 244, 244, 0.34)';
    editorCtx.lineWidth = 1;

    for (let i = 1; i < GRID_DIVISIONS; i += 1) {
      const t = i / GRID_DIVISIONS;
      drawMappedGridLine({ u: t, v: 0 }, { u: t, v: 1 }, H, viewTransform, useWarp);
      drawMappedGridLine({ u: 0, v: t }, { u: 1, v: t }, H, viewTransform, useWarp);
    }

    editorCtx.restore();
  }

  function drawMappedGridLine(from, to, H, viewTransform, useWarp) {
    editorCtx.beginPath();
    for (let i = 0; i <= GRID_LINE_DRAW_STEPS; i += 1) {
      const t = i / GRID_LINE_DRAW_STEPS;
      const imagePoint = mapUnitToImage(
        from.u + (to.u - from.u) * t,
        from.v + (to.v - from.v) * t,
        H,
        useWarp,
      );
      const screenPoint = imageToScreen(imagePoint, viewTransform);
      if (i === 0) editorCtx.moveTo(screenPoint.x, screenPoint.y);
      else editorCtx.lineTo(screenPoint.x, screenPoint.y);
    }
    editorCtx.stroke();
  }

  function traceSelectionPath(ctx, viewTransform = getViewTransform()) {
    if (!state.quad) return;

    let hasStarted = false;
    for (let edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
      for (let step = 0; step <= EDGE_CURVE_DRAW_STEPS; step += 1) {
        if (edgeIndex > 0 && step === 0) continue;
        const point = imageToScreen(getEdgeCurvePoint(edgeIndex, step / EDGE_CURVE_DRAW_STEPS), viewTransform);
        if (!hasStarted) {
          ctx.moveTo(point.x, point.y);
          hasStarted = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }
    }

    ctx.closePath();
  }

  function getEdgeCurvePoint(edgeIndex, t, quad = state.quad, warps = state.edgeWarps) {
    const a = quad[edgeIndex];
    const b = quad[(edgeIndex + 1) % 4];
    const normal = edgeInnerNormal(a, b);
    const offset = getEdgeWarpOffsetAtT(edgeIndex, t, warps);

    return {
      x: a.x + (b.x - a.x) * t + normal.x * offset,
      y: a.y + (b.y - a.y) * t + normal.y * offset,
    };
  }

  function getEdgeWarpOffsetAtT(edgeIndex, t, warps = state.edgeWarps) {
    const handles = getSortedEdgeWarps(edgeIndex, warps);
    const stops = [
      { t: 0, offset: 0 },
      ...handles,
      { t: 1, offset: 0 },
    ];
    const clampedT = clamp(t, 0, 1);

    for (let i = 0; i < stops.length - 1; i += 1) {
      const left = stops[i];
      const right = stops[i + 1];
      if (clampedT <= right.t || i === stops.length - 2) {
        const span = Math.max(1e-6, right.t - left.t);
        const localT = clamp((clampedT - left.t) / span, 0, 1);
        return left.offset + (right.offset - left.offset) * smoothStep(localT);
      }
    }

    return 0;
  }

  function smoothStep(t) {
    const clamped = clamp(t, 0, 1);
    return clamped * clamped * (3 - 2 * clamped);
  }

  function createDefaultEdgeWarps() {
    return Array.from({ length: 4 }, () => [{ t: 0.5, offset: 0 }]);
  }

  function copyEdgeWarps(warps = state.edgeWarps) {
    return warps.map(edge => edge.map(warp => ({ t: warp.t, offset: warp.offset })));
  }

  function resetEdgeWarps() {
    state.edgeWarps = state.usingDemoDefaults ? copyEdgeWarps(DEMO_EDGE_WARPS) : createDefaultEdgeWarps();
  }

  function clearSelection() {
    state.selectedCorner = -1;
    state.selectedEdge = -1;
    state.selectedWarp = -1;
  }

  function selectCorner(index) {
    state.selectedCorner = index;
    state.selectedEdge = -1;
    state.selectedWarp = -1;
  }

  function selectWarp(edgeIndex, warpIndex) {
    state.selectedCorner = -1;
    state.selectedEdge = edgeIndex;
    state.selectedWarp = warpIndex;
  }

  function refreshGeometry() {
    invalidateRenderedOutput();
    drawEditor();
    updateOutputSummary();
    scheduleLivePreview();
  }

  function invalidateRenderedOutput() {
    if (!state.lastOutputBlob) return;
    state.lastOutputBlob = null;
    setExportButtonsEnabled(false);
    if (!state.livePreviewEnabled && state.lastOutputSize) {
      previewMeta.textContent = 'Needs re-render';
    }
  }

  function resetWarps() {
    if (!state.image || !state.quad) return;
    resetEdgeWarps();
    clearSelection();
    refreshGeometry();
    setStatus('Warp handles reset. Each side has one centered warp handle.');
  }

  function getEdgeWarps(edgeIndex, warps = state.edgeWarps) {
    const edgeWarps = warps?.[edgeIndex];
    return edgeWarps && edgeWarps.length ? edgeWarps : [{ t: 0.5, offset: 0 }];
  }

  function getSortedEdgeWarps(edgeIndex, warps = state.edgeWarps) {
    return [...getEdgeWarps(edgeIndex, warps)].sort((a, b) => a.t - b.t);
  }

  function getEdgeWarpHandlePoint(edgeIndex, warpIndex = 0, quad = state.quad, warps = state.edgeWarps) {
    const a = quad[edgeIndex];
    const b = quad[(edgeIndex + 1) % 4];
    const normal = edgeInnerNormal(a, b);
    const warp = getEdgeWarps(edgeIndex, warps)[warpIndex] || { t: 0.5, offset: 0 };
    return {
      x: a.x + (b.x - a.x) * warp.t + normal.x * warp.offset,
      y: a.y + (b.y - a.y) * warp.t + normal.y * warp.offset,
    };
  }

  function setEdgeWarpHandleFromPoint(edgeIndex, warpIndex, point, quad = state.quad) {
    const a = quad[edgeIndex];
    const b = quad[(edgeIndex + 1) % 4];
    const edge = { x: b.x - a.x, y: b.y - a.y };
    const edgeLengthSquared = edge.x * edge.x + edge.y * edge.y;
    if (edgeLengthSquared < 1e-6) return;

    const rawT = ((point.x - a.x) * edge.x + (point.y - a.y) * edge.y) / edgeLengthSquared;
    const t = clamp(rawT, EDGE_WARP_HANDLE_MIN_T, EDGE_WARP_HANDLE_MAX_T);
    const base = { x: a.x + edge.x * t, y: a.y + edge.y * t };
    const normal = edgeInnerNormal(a, b);
    const edgeWarps = getEdgeWarps(edgeIndex);
    const warp = edgeWarps[warpIndex];
    if (!warp) return;

    warp.t = t;
    warp.offset = (point.x - base.x) * normal.x + (point.y - base.y) * normal.y;
  }

  function addEdgeWarpAtPoint(edgeIndex, point) {
    const edgeWarps = getEdgeWarps(edgeIndex);
    if (edgeWarps.length >= MAX_EDGE_WARPS) {
      setStatus(`That side already has ${MAX_EDGE_WARPS} warp handles. Delete one before adding another.`, 'danger');
      return;
    }

    const t = getClosestTOnCurvedEdgeToPoint(point, edgeIndex);
    const a = state.quad[edgeIndex];
    const b = state.quad[(edgeIndex + 1) % 4];
    const normal = edgeInnerNormal(a, b);
    const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const offset = (point.x - base.x) * normal.x + (point.y - base.y) * normal.y;
    edgeWarps.push({ t, offset });
    state.edgeWarps[edgeIndex] = edgeWarps;
    selectWarp(edgeIndex, edgeWarps.length - 1);
    refreshGeometry();
    setStatus('Added warp handle. Drag it along the side to move the warp center or away from the side to bend it.');
  }

  function removeEdgeWarp(edgeIndex, warpIndex) {
    const edgeWarps = getEdgeWarps(edgeIndex);
    if (edgeWarps.length <= 1) {
      edgeWarps[0] = { t: 0.5, offset: 0 };
      state.edgeWarps[edgeIndex] = edgeWarps;
      selectWarp(edgeIndex, 0);
      setStatus('Each side must keep at least one warp handle, so this one was reset instead.');
    } else {
      edgeWarps.splice(warpIndex, 1);
      state.edgeWarps[edgeIndex] = edgeWarps;
      clearSelection();
      setStatus('Deleted warp handle.');
    }

    refreshGeometry();
  }

  function getClosestTOnCurvedEdgeToPoint(point, edgeIndex) {
    let bestT = 0.5;
    let bestDistance = Number.POSITIVE_INFINITY;
    let previous = getEdgeCurvePoint(edgeIndex, 0);
    const steps = EDGE_WARP_ADD_STEPS;

    for (let i = 1; i <= steps; i += 1) {
      const currentT = i / steps;
      const current = getEdgeCurvePoint(edgeIndex, currentT);
      const segment = closestPointOnSegment(point, previous, current);
      const d = distance(point, segment.point);
      if (d < bestDistance) {
        bestDistance = d;
        bestT = (i - 1 + segment.t) / steps;
      }
      previous = current;
    }

    return clamp(bestT, EDGE_WARP_HANDLE_MIN_T, EDGE_WARP_HANDLE_MAX_T);
  }

  function edgeInnerNormal(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return { x: 0, y: 0 };
    return { x: -dy / length, y: dx / length };
  }

  function hasSideWarp(warps = state.edgeWarps) {
    return warps.some(edge => edge.some(warp => Math.abs(warp.offset) > 0.01));
  }

  function mapUnitToImage(u, v, H = getUnitToQuadHomography(), useWarp = hasSideWarp()) {
    const base = applyHomography(H, u, v);
    if (!useWarp) return base;
    const displacement = getWarpDisplacement(u, v);
    return { x: base.x + displacement.x, y: base.y + displacement.y };
  }

  function getUnitToQuadHomography() {
    return solveHomography([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ], state.quad);
  }

  function getWarpDisplacement(u, v, quad = state.quad, warps = state.edgeWarps) {
    const warped = coonsPatchPoint(u, v, quad, warps);
    const straight = bilinearPatchPoint(u, v, quad);
    return { x: warped.x - straight.x, y: warped.y - straight.y };
  }

  function coonsPatchPoint(u, v, quad = state.quad, warps = state.edgeWarps) {
    const top = getEdgeCurvePoint(0, u, quad, warps);
    const right = getEdgeCurvePoint(1, v, quad, warps);
    const bottom = getEdgeCurvePoint(2, 1 - u, quad, warps);
    const left = getEdgeCurvePoint(3, 1 - v, quad, warps);
    const bilinear = bilinearPatchPoint(u, v, quad);

    return {
      x: (1 - v) * top.x + v * bottom.x + (1 - u) * left.x + u * right.x - bilinear.x,
      y: (1 - v) * top.y + v * bottom.y + (1 - u) * left.y + u * right.y - bilinear.y,
    };
  }

  function bilinearPatchPoint(u, v, quad = state.quad) {
    const [topLeft, topRight, bottomRight, bottomLeft] = quad;
    return {
      x: (1 - u) * (1 - v) * topLeft.x + u * (1 - v) * topRight.x + u * v * bottomRight.x + (1 - u) * v * bottomLeft.x,
      y: (1 - u) * (1 - v) * topLeft.y + u * (1 - v) * topRight.y + u * v * bottomRight.y + (1 - u) * v * bottomLeft.y,
    };
  }

  function drawCornerHandles(points) {
    points.forEach((p, i) => {
      const selected = i === state.selectedCorner;
      editorCtx.save();
      editorCtx.beginPath();
      editorCtx.arc(p.x, p.y, selected ? HANDLE_RADIUS + 2 : HANDLE_RADIUS, 0, Math.PI * 2);
      editorCtx.fillStyle = selected ? '#f4f4f4' : '#cfcfcf';
      editorCtx.strokeStyle = 'rgba(7, 10, 16, 0.86)';
      editorCtx.lineWidth = 3;
      editorCtx.fill();
      editorCtx.stroke();
      editorCtx.fillStyle = 'rgba(7, 10, 16, 0.86)';
      editorCtx.font = '700 11px Inter, sans-serif';
      editorCtx.textAlign = 'center';
      editorCtx.textBaseline = 'middle';
      editorCtx.fillText(String(i + 1), p.x, p.y + 0.5);
      editorCtx.restore();
    });
  }

  function drawEdgeHandles(points, viewTransform) {
    for (let edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
      const a = points[edgeIndex];
      const b = points[(edgeIndex + 1) % 4];
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const warps = getEdgeWarps(edgeIndex);

      for (let warpIndex = 0; warpIndex < warps.length; warpIndex += 1) {
        const handle = imageToScreen(getEdgeWarpHandlePoint(edgeIndex, warpIndex), viewTransform);
        const selected = edgeIndex === state.selectedEdge && warpIndex === state.selectedWarp;

        editorCtx.save();
        editorCtx.translate(handle.x, handle.y);
        editorCtx.rotate(angle);
        editorCtx.fillStyle = selected ? '#ffffff' : 'rgba(245, 247, 251, 0.92)';
        editorCtx.strokeStyle = 'rgba(7, 10, 16, 0.7)';
        editorCtx.lineWidth = selected ? 3 : 2;
        editorCtx.beginPath();
        editorCtx.rect(-18, -4, 36, 8);
        editorCtx.fill();
        editorCtx.stroke();
        editorCtx.restore();
      }
    }
  }

  function drawDimSlider(width, height) {
    const slider = getDimSliderMetrics(width, height);
    const value = state.dimAmount / DIM_SLIDER_MAX;
    const knobY = slider.y + (1 - value) * slider.height;

    editorCtx.save();
    editorCtx.globalAlpha = 0.94;
    editorCtx.fillStyle = 'rgba(7, 10, 16, 0.7)';
    editorCtx.fillRect(slider.x - 12, slider.y - 28, 24, slider.height + 56);
    editorCtx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    editorCtx.lineWidth = 1;
    editorCtx.strokeRect(slider.x - 12.5, slider.y - 28.5, 25, slider.height + 57);

    editorCtx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    editorCtx.fillRect(slider.x - 2, slider.y, 4, slider.height);
    editorCtx.fillStyle = '#d8d8d8';
    editorCtx.fillRect(slider.x - 4, knobY, 8, slider.y + slider.height - knobY);

    editorCtx.fillStyle = '#f5f7fb';
    editorCtx.strokeStyle = 'rgba(7, 10, 16, 0.86)';
    editorCtx.lineWidth = 2;
    editorCtx.fillRect(slider.x - 9, knobY - 7, 18, 14);
    editorCtx.strokeRect(slider.x - 9, knobY - 7, 18, 14);

    editorCtx.fillStyle = 'rgba(245, 247, 251, 0.82)';
    editorCtx.font = '800 10px Inter, sans-serif';
    editorCtx.textAlign = 'center';
    editorCtx.textBaseline = 'middle';
    editorCtx.save();
    editorCtx.translate(slider.x, slider.y - 15);
    editorCtx.fillText('DIM', 0, 0);
    editorCtx.restore();
    editorCtx.restore();
  }

  function getDimSliderMetrics(width, height) {
    const trackHeight = Math.max(120, Math.min(260, height - 120));
    return {
      x: Math.max(28, width - 28),
      y: (height - trackHeight) / 2,
      height: trackHeight,
    };
  }

  function hitTestDimSlider(screenPoint) {
    const { width, height } = getEditorSize();
    const slider = getDimSliderMetrics(width, height);
    return Math.abs(screenPoint.x - slider.x) <= DIM_SLIDER_HIT_RADIUS &&
      screenPoint.y >= slider.y - 34 &&
      screenPoint.y <= slider.y + slider.height + 34;
  }

  function setDimFromScreenY(screenY) {
    const { width, height } = getEditorSize();
    const slider = getDimSliderMetrics(width, height);
    const t = clamp((screenY - slider.y) / slider.height, 0, 1);
    state.dimAmount = (1 - t) * DIM_SLIDER_MAX;
  }

  function pointerPosition(event) {
    const rect = editorCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTest(screenPoint) {
    if (!state.quad) return null;
    const viewTransform = getViewTransform();
    const points = state.quad.map(point => imageToScreen(point, viewTransform));

    for (let i = 0; i < points.length; i += 1) {
      if (distance(screenPoint, points[i]) <= HANDLE_RADIUS + 8) {
        return { type: 'corner', index: i };
      }
    }

    for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
      const warps = getEdgeWarps(edgeIndex);
      for (let warpIndex = 0; warpIndex < warps.length; warpIndex += 1) {
        const handle = imageToScreen(getEdgeWarpHandlePoint(edgeIndex, warpIndex), viewTransform);
        if (distance(screenPoint, handle) <= EDGE_WARP_HANDLE_HIT_RADIUS) {
          return { type: 'sideWarp', edgeIndex, warpIndex };
        }
      }
    }

    for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
      if (distanceToCurvedEdge(screenPoint, edgeIndex, viewTransform) <= EDGE_HIT_RADIUS) {
        return { type: 'edge', edgeIndex };
      }
    }

    return null;
  }

  function distanceToCurvedEdge(screenPoint, edgeIndex, viewTransform = getViewTransform()) {
    let closest = Number.POSITIVE_INFINITY;
    let previous = imageToScreen(getEdgeCurvePoint(edgeIndex, 0), viewTransform);

    for (let i = 1; i <= EDGE_HIT_TEST_STEPS; i += 1) {
      const current = imageToScreen(getEdgeCurvePoint(edgeIndex, i / EDGE_HIT_TEST_STEPS), viewTransform);
      closest = Math.min(closest, distanceToSegment(screenPoint, previous, current));
      previous = current;
    }

    return closest;
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function distanceToSegment(p, a, b) {
    return distance(p, closestPointOnSegment(p, a, b).point);
  }

  function closestPointOnSegment(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const lengthSquared = vx * vx + vy * vy;
    if (lengthSquared < 1e-9) return { point: copyPoint(a), t: 0 };
    const t = clamp((vx * wx + vy * wy) / lengthSquared, 0, 1);
    return {
      point: { x: a.x + t * vx, y: a.y + t * vy },
      t,
    };
  }


  function constrainCornerToAdjacentEdge(index, targetPoint, dragState, lockEnabled) {
    if (!lockEnabled) {
      dragState.cornerConstraint = null;
      return targetPoint;
    }

    const start = dragState.originalQuad[index];
    const delta = {
      x: targetPoint.x - start.x,
      y: targetPoint.y - start.y,
    };

    const previousIndex = (index + 3) % 4;
    const nextIndex = (index + 1) % 4;
    const axes = [
      axisFromPoints(start, dragState.originalQuad[previousIndex], 'previous'),
      axisFromPoints(start, dragState.originalQuad[nextIndex], 'next'),
    ].filter(Boolean);

    if (!axes.length) {
      const horizontal = Math.abs(delta.x) >= Math.abs(delta.y);
      return horizontal ? { x: start.x + delta.x, y: start.y } : { x: start.x, y: start.y + delta.y };
    }

    if (!dragState.cornerConstraint || !axes.some(axis => axis.id === dragState.cornerConstraint.id)) {
      let best = axes[0];
      let bestProjection = Math.abs(delta.x * best.x + delta.y * best.y);
      for (const axis of axes.slice(1)) {
        const projection = Math.abs(delta.x * axis.x + delta.y * axis.y);
        if (projection > bestProjection) {
          best = axis;
          bestProjection = projection;
        }
      }
      dragState.cornerConstraint = best;
    }

    const axis = dragState.cornerConstraint;
    const amount = delta.x * axis.x + delta.y * axis.y;
    return {
      x: start.x + axis.x * amount,
      y: start.y + axis.y * amount,
    };
  }

  function axisFromPoints(from, to, id) {
    const x = to.x - from.x;
    const y = to.y - from.y;
    const length = Math.hypot(x, y);
    if (length < 1e-6) return null;
    return { id, x: x / length, y: y / length };
  }

  function getKeyboardNudge(event) {
    const step = event.shiftKey ? 10 : 1;
    const moves = {
      ArrowLeft: { dx: -step, dy: 0 },
      ArrowRight: { dx: step, dy: 0 },
      ArrowUp: { dx: 0, dy: -step },
      ArrowDown: { dx: 0, dy: step },
    };
    return moves[event.key] || null;
  }

  editorCanvas.addEventListener('pointerdown', (event) => {
    if (!state.image) return;
    editorCanvas.setPointerCapture(event.pointerId);
    const screen = pointerPosition(event);
    const image = screenToImage(screen);

    if (event.button === 0 && hitTestDimSlider(screen)) {
      setDimFromScreenY(screen.y);
      state.dragging = { type: 'dimSlider' };
      editorCanvas.style.cursor = 'ns-resize';
      drawEditor();
      return;
    }

    const hit = hitTest(screen);

    if (state.spaceDown || event.button === 1) {
      state.dragging = { type: 'pan', startScreen: screen, startPan: { ...state.pan } };
      editorCanvas.style.cursor = 'grabbing';
      return;
    }

    if (hit && event.button === 0) {
      const handle = hit.type === 'sideWarp'
        ? getEdgeWarpHandlePoint(hit.edgeIndex, hit.warpIndex)
        : image;
      state.dragging = {
        ...hit,
        startImage: image,
        pointerToHandle: { x: handle.x - image.x, y: handle.y - image.y },
        originalQuad: copyQuad(state.quad),
        cornerConstraint: null,
      };
      if (hit.type === 'corner') selectCorner(hit.index);
      else if (hit.type === 'sideWarp') selectWarp(hit.edgeIndex, hit.warpIndex);
      else clearSelection();
      editorCanvas.style.cursor = hit.type === 'corner' || hit.type === 'sideWarp' ? 'grabbing' : 'move';
      drawEditor();
      return;
    }

    if (event.button === 0) {
      state.dragging = { type: 'pan', startScreen: screen, startPan: { ...state.pan } };
      clearSelection();
      editorCanvas.style.cursor = 'grabbing';
      drawEditor();
    }
  });

  editorCanvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!state.image || !state.quad) return;

    const screen = pointerPosition(event);
    const image = screenToImage(screen);
    const hit = hitTest(screen);

    if (hit?.type === 'sideWarp') {
      removeEdgeWarp(hit.edgeIndex, hit.warpIndex);
      return;
    }

    if (hit?.type === 'edge') {
      addEdgeWarpAtPoint(hit.edgeIndex, image);
    }
  });

  editorCanvas.addEventListener('pointermove', (event) => {
    if (!state.image) return;
    const screen = pointerPosition(event);

    if (!state.dragging) {
      if (hitTestDimSlider(screen)) {
        editorCanvas.style.cursor = 'ns-resize';
        return;
      }
      const hit = hitTest(screen);
      if (!hit) editorCanvas.style.cursor = 'grab';
      else if (hit.type === 'corner' || hit.type === 'sideWarp') editorCanvas.style.cursor = 'grab';
      else editorCanvas.style.cursor = 'move';
      return;
    }

    if (state.dragging.type === 'dimSlider') {
      setDimFromScreenY(screen.y);
      requestEditorDraw();
      return;
    }

    if (state.dragging.type === 'pan') {
      state.pan.x = state.dragging.startPan.x + (screen.x - state.dragging.startScreen.x);
      state.pan.y = state.dragging.startPan.y + (screen.y - state.dragging.startScreen.y);
      requestEditorDraw();
      return;
    }

    const image = screenToImage(screen);
    const dx = image.x - state.dragging.startImage.x;
    const dy = image.y - state.dragging.startImage.y;

    if (state.dragging.type === 'corner') {
      const constrainedImage = constrainCornerToAdjacentEdge(
        state.dragging.index,
        image,
        state.dragging,
        event.shiftKey,
      );
      state.quad[state.dragging.index] = copyPoint(constrainedImage);
    } else if (state.dragging.type === 'sideWarp') {
      const { edgeIndex, warpIndex } = state.dragging;
      const desiredHandle = {
        x: image.x + state.dragging.pointerToHandle.x,
        y: image.y + state.dragging.pointerToHandle.y,
      };
      setEdgeWarpHandleFromPoint(edgeIndex, warpIndex, desiredHandle, state.dragging.originalQuad);
    } else if (state.dragging.type === 'edge') {
      const i = state.dragging.edgeIndex;
      const j = (i + 1) % 4;
      state.quad[i] = copyPoint({
        x: state.dragging.originalQuad[i].x + dx,
        y: state.dragging.originalQuad[i].y + dy,
      });
      state.quad[j] = copyPoint({
        x: state.dragging.originalQuad[j].x + dx,
        y: state.dragging.originalQuad[j].y + dy,
      });
    }

    requestEditorDraw();
    updateOutputSummary();
    scheduleLivePreview();
  });

  editorCanvas.addEventListener('pointerup', (event) => {
    if (state.dragging) {
      editorCanvas.releasePointerCapture(event.pointerId);
      state.dragging = null;
      editorCanvas.style.cursor = 'grab';
    }
  });

  editorCanvas.addEventListener('pointercancel', () => {
    state.dragging = null;
    editorCanvas.style.cursor = 'grab';
  });

  editorCanvas.addEventListener('wheel', (event) => {
    if (!state.image) return;
    event.preventDefault();
    const screen = pointerPosition(event);
    const before = screenToImage(screen);
    const factor = Math.exp(-event.deltaY * 0.0011);
    state.zoom = clamp(state.zoom * factor, 0.1, 12);
    const after = imageToScreen(before);
    state.pan.x += screen.x - after.x;
    state.pan.y += screen.y - after.y;
    requestEditorDraw();
  }, { passive: false });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      state.spaceDown = true;
      if (!state.dragging) editorCanvas.style.cursor = 'grab';
      event.preventDefault();
    }

    if (!state.quad) return;
    const move = getKeyboardNudge(event);
    if (!move) return;
    const { dx, dy } = move;

    if (state.selectedCorner >= 0) {
      const p = state.quad[state.selectedCorner];
      state.quad[state.selectedCorner] = copyPoint({ x: p.x + dx, y: p.y + dy });
    } else if (state.selectedEdge >= 0 && state.selectedWarp >= 0) {
      const i = state.selectedEdge;
      const j = state.selectedWarp;
      const handle = getEdgeWarpHandlePoint(i, j);
      setEdgeWarpHandleFromPoint(i, j, { x: handle.x + dx, y: handle.y + dy });
    } else {
      return;
    }

    refreshGeometry();
    event.preventDefault();
  });

  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      state.spaceDown = false;
      if (!state.dragging) editorCanvas.style.cursor = 'grab';
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await loadImageFromUrl(URL.createObjectURL(file), file.name, true);
  });

  loadSampleBtn.addEventListener('click', async () => {
    await loadImageFromUrl('sample.jpg', DEMO_IMAGE_NAME, false, { useDemoDefaults: true });
  });

  resetWarpsBtn.addEventListener('click', resetWarps);

  [outWidthInput, outHeightInput].forEach(el => {
    el.addEventListener('input', refreshOutputSettings);
    el.addEventListener('change', refreshOutputSettings);
  });

  outputMode.addEventListener('change', syncOutputModeVisibility);
  if (exportSampling) exportSampling.addEventListener('change', refreshOutputSettings);

  rectifyBtn.addEventListener('click', () => renderPerspective().catch(error => {
    console.error(error);
    setProgress(null);
    setStatus(error.message || 'Perspective correction failed.', 'danger');
    rectifyBtn.disabled = false;
    setExportButtonsEnabled(Boolean(state.lastOutputBlob));
  }));


  smoothPixelsToggle.addEventListener('change', () => {
    state.smoothEditorPixels = smoothPixelsToggle.checked;
    drawEditor();
  });

  livePreviewToggle.addEventListener('change', () => {
    state.livePreviewEnabled = livePreviewToggle.checked;

    if (state.livePreviewEnabled) {
      setStatus('Live preview is on. Move the frame to update the corrected preview. Click Correct perspective for the full-resolution export.');
      scheduleLivePreview(true);
      return;
    }

    state.livePreviewRequestId += 1;
    if (!state.lastOutputBlob) {
      resetOutputPreview();
      setStatus(state.image ? 'Live preview is off. Click Correct perspective to render the output.' : 'Open an image to begin.');
    } else if (state.lastOutputSize) {
      previewMeta.textContent = `${state.lastOutputSize.width} × ${state.lastOutputSize.height}`;
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!state.lastOutputBlob) return;
    const a = document.createElement('a');
    const basename = safeFileBaseName(state.imageName);
    a.href = URL.createObjectURL(state.lastOutputBlob);
    a.download = `${basename}-adjusted.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 800);
  });

  copyBtn.addEventListener('click', async () => {
    if (!state.lastOutputBlob || !navigator.clipboard || !window.ClipboardItem) {
      setStatus('Clipboard image copy is not supported in this browser. Use Download PNG instead.', 'danger');
      return;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': state.lastOutputBlob })]);
    setStatus('Copied corrected image to clipboard.', 'success');
  });

  function refreshOutputSettings() {
    invalidateRenderedOutput();
    updateOutputSummary();
    scheduleLivePreview();
  }

  function syncOutputModeVisibility() {
    resolutionFields.classList.toggle('hidden', outputMode.value !== 'resolution');
    refreshOutputSettings();
  }

  function applyOutputDefaults(useDemoDefaults) {
    outputMode.value = 'resolution';
    outWidthInput.value = useDemoDefaults ? DEMO_OUTPUT_WIDTH : DEFAULT_OUTPUT_WIDTH;
    outHeightInput.value = useDemoDefaults ? DEMO_OUTPUT_HEIGHT : DEFAULT_OUTPUT_HEIGHT;
    syncOutputModeVisibility();
  }

  async function loadImageFromUrl(url, name, revokeAfterLoad = false, options = {}) {
    const img = new Image();
    img.decoding = 'async';

    const loaded = await new Promise(resolve => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });

    if (revokeAfterLoad) URL.revokeObjectURL(url);

    if (!loaded) {
      setStatus('Could not load that image.', 'danger');
      return;
    }

    state.image = img;
    state.imageName = name || 'image';
    state.imageCanvas.width = img.naturalWidth || img.width;
    state.imageCanvas.height = img.naturalHeight || img.height;
    state.imageCtx.clearRect(0, 0, state.imageCanvas.width, state.imageCanvas.height);
    state.imageCtx.imageSmoothingEnabled = false;
    state.imageCtx.drawImage(img, 0, 0, state.imageCanvas.width, state.imageCanvas.height);
    state.imageData = state.imageCtx.getImageData(0, 0, state.imageCanvas.width, state.imageCanvas.height);
    await setRenderWorkerSource();
    state.lastOutputBlob = null;
    state.dimAmount = 0;
    state.usingDemoDefaults = Boolean(options.useDemoDefaults);

    applyOutputDefaults(state.usingDemoDefaults);
    resetOutputPreview();
    emptyState.classList.add('hidden');
    rectifyBtn.disabled = false;
    setExportButtonsEnabled(false);
    fitView();
    resetQuad();
    refreshOutputSettings();
    scheduleLivePreview(true);
    setProgress(null);
    setStatus(`Loaded ${state.imageName} at ${state.image.width} × ${state.image.height}. Align the frame, then correct perspective.`);
  }

  function getOutputSize() {
    const mode = outputMode.value;
    if (mode === 'resolution') {
      return {
        width: sanePositiveInt(outWidthInput.value, DEFAULT_OUTPUT_WIDTH),
        height: sanePositiveInt(outHeightInput.value, DEFAULT_OUTPUT_HEIGHT),
      };
    }

    if (!state.quad) return { width: DEFAULT_OUTPUT_WIDTH, height: DEFAULT_OUTPUT_HEIGHT };
    const top = distance(state.quad[0], state.quad[1]);
    const right = distance(state.quad[1], state.quad[2]);
    const bottom = distance(state.quad[2], state.quad[3]);
    const left = distance(state.quad[3], state.quad[0]);
    return {
      width: Math.max(1, Math.round((top + bottom) / 2)),
      height: Math.max(1, Math.round((right + left) / 2)),
    };
  }

  function sanePositiveInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function updateOutputSummary() {
    const { width, height } = getOutputSize();
    outputSummary.textContent = `${width} × ${height}`;
  }

  async function renderPerspective() {
    if (!state.image || !state.quad) return;
    const { width: outW, height: outH } = getOutputSize();
    const pixels = outW * outH;
    if (pixels > MAX_PIXELS) {
      throw new Error(`Output is ${(pixels / 1_000_000).toFixed(1)} MP. Keep it under ${(MAX_PIXELS / 1_000_000).toFixed(0)} MP for browser rendering.`);
    }

    state.finalRendering = true;
    state.livePreviewRequestId += 1;
    rectifyBtn.disabled = true;
    setExportButtonsEnabled(false);
    setProgress(0);
    setStatus('Correcting perspective…');

    try {
      await nextFrame();
      const sampling = exportSampling?.value || 'bilinear';
      const out = await buildPerspectiveImage(outW, outH, value => setProgress(value), () => false, sampling);
      if (!out) {
        rectifyBtn.disabled = false;
        setExportButtonsEnabled(Boolean(state.lastOutputBlob));
        setProgress(null);
        return;
      }

      displayOutput(out, outW, outH, `${outW} × ${outH}`);

      state.lastOutputBlob = await canvasToBlob(outputCanvas);
      setExportButtonsEnabled(true);
      rectifyBtn.disabled = false;
      setProgress(100);
      const samplingLabel = sampling === 'nearest' ? 'sharp nearest-neighbor' : 'smooth bilinear';
      setStatus(`Done. Export is ${outW} × ${outH} (${samplingLabel}).`, 'success');
      setTimeout(() => setProgress(null), 650);
    } finally {
      state.finalRendering = false;
    }
  }

  async function buildPerspectiveImageOnMain(outW, outH, onProgress = null, isCancelled = null, sampling = 'bilinear') {
    const mapOutputPoint = createOutputToImageMapper(outW, outH);
    const src = state.imageData.data;
    const srcW = state.imageData.width;
    const srcH = state.imageData.height;
    const out = new ImageData(outW, outH);
    const dst = out.data;
    const samplePixel = sampling === 'nearest' ? sampleNearest : sampleBilinear;

    const rowsPerYield = Math.max(4, Math.floor(110000 / outW));
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const mapped = mapOutputPoint(x, y);
        samplePixel(src, srcW, srcH, mapped.x, mapped.y, dst, (y * outW + x) * 4);
      }

      if (y % rowsPerYield === 0) {
        if (isCancelled && isCancelled()) return null;
        if (onProgress) onProgress((y / outH) * 100);
        await nextFrame();
      }
    }

    if (isCancelled && isCancelled()) return null;
    return out;
  }

  function createOutputToImageMapper(outW, outH) {
    const quad = copyQuad(state.quad);
    const warps = copyEdgeWarps();
    const dstRect = [
      { x: 0, y: 0 },
      { x: outW - 1, y: 0 },
      { x: outW - 1, y: outH - 1 },
      { x: 0, y: outH - 1 },
    ];
    const H = solveHomography(dstRect, quad);
    const useWarp = hasSideWarp(warps);

    return (x, y) => {
      const base = applyHomography(H, x, y);
      if (!useWarp) return base;

      const u = outW > 1 ? x / (outW - 1) : 0;
      const v = outH > 1 ? y / (outH - 1) : 0;
      const displacement = getWarpDisplacement(u, v, quad, warps);
      return {
        x: base.x + displacement.x,
        y: base.y + displacement.y,
      };
    };
  }

  function getLivePreviewSize() {
    const { width, height } = getOutputSize();
    const scale = Math.min(
      1,
      LIVE_PREVIEW_MAX_LONG_EDGE / Math.max(width, height),
      Math.sqrt(LIVE_PREVIEW_MAX_PIXELS / Math.max(1, width * height)),
    );

    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function scheduleLivePreview(immediate = false) {
    if (!state.livePreviewEnabled || !state.image || !state.quad || state.finalRendering) return;

    state.livePreviewRequestId += 1;
    state.livePreviewPending = true;

    if (state.livePreviewTimer) {
      clearTimeout(state.livePreviewTimer);
      state.livePreviewTimer = null;
    }

    if (state.livePreviewRendering) return;

    state.livePreviewTimer = setTimeout(() => {
      state.livePreviewTimer = null;
      renderQueuedLivePreview().catch(error => {
        console.error(error);
        setStatus(error.message || 'Live preview failed.', 'danger');
      });
    }, immediate ? 0 : LIVE_PREVIEW_DEBOUNCE_MS);
  }

  async function renderQueuedLivePreview() {
    if (!state.livePreviewEnabled || !state.image || !state.quad || state.finalRendering) return;
    if (state.livePreviewRendering) return;

    state.livePreviewPending = false;
    state.livePreviewRendering = true;
    const requestId = state.livePreviewRequestId;

    try {
      const { width: previewW, height: previewH } = getLivePreviewSize();
      const out = await buildPerspectiveImage(
        previewW,
        previewH,
        null,
        () => requestId !== state.livePreviewRequestId || !state.livePreviewEnabled,
        'nearest',
      );

      if (!out || requestId !== state.livePreviewRequestId || !state.livePreviewEnabled) return;

      displayOutput(out, previewW, previewH, `Live preview · ${previewW} × ${previewH}`);

      state.lastOutputBlob = null;
      setExportButtonsEnabled(false);
    } finally {
      state.livePreviewRendering = false;
      if (!state.finalRendering && (state.livePreviewPending || state.livePreviewRequestId !== requestId)) {
        state.livePreviewPending = false;
        scheduleLivePreview(true);
      }
    }
  }

  function resetOutputPreview() {
    outputCanvas.width = 1;
    outputCanvas.height = 1;
    outputCtx.clearRect(0, 0, 1, 1);
    outputCanvas.style.width = '0px';
    outputCanvas.style.height = '0px';
    state.lastOutputSize = null;
    previewMeta.textContent = 'No output yet';
    previewPlaceholder.classList.remove('hidden');
  }

  function displayOutput(imageData, width, height, metaText) {
    outputCanvas.width = width;
    outputCanvas.height = height;
    outputCtx.putImageData(imageData, 0, 0);
    state.lastOutputSize = { width, height };
    previewMeta.textContent = metaText;
    previewPlaceholder.classList.add('hidden');
    fitOutputPreviewCanvas();
  }

  function fitOutputPreviewCanvas() {
    if (!state.lastOutputSize || !previewStage) {
      outputCanvas.style.width = '0px';
      outputCanvas.style.height = '0px';
      return;
    }

    const stageRect = previewStage.getBoundingClientRect();
    const availableW = Math.max(1, stageRect.width - 2);
    const availableH = Math.max(1, stageRect.height - 2);
    const outputAspect = state.lastOutputSize.width / state.lastOutputSize.height;
    const stageAspect = availableW / availableH;

    let cssW;
    let cssH;
    if (stageAspect > outputAspect) {
      cssH = availableH;
      cssW = cssH * outputAspect;
    } else {
      cssW = availableW;
      cssH = cssW / outputAspect;
    }

    outputCanvas.style.width = `${Math.floor(cssW)}px`;
    outputCanvas.style.height = `${Math.floor(cssH)}px`;
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  function safeFileBaseName(name) {
    return name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'adjusted';
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create PNG blob.')), 'image/png');
    });
  }

  function solveHomography(fromPoints, toPoints) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i += 1) {
      const x = fromPoints[i].x;
      const y = fromPoints[i].y;
      const u = toPoints[i].x;
      const v = toPoints[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = gaussianSolve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function gaussianSolve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col += 1) {
      let pivot = col;
      for (let row = col + 1; row < n; row += 1) {
        if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) {
        throw new Error('The selected frame is degenerate. Move the four corners so they form a clear quadrilateral.');
      }
      [M[col], M[pivot]] = [M[pivot], M[col]];

      const divisor = M[col][col];
      for (let c = col; c <= n; c += 1) M[col][c] /= divisor;

      for (let row = 0; row < n; row += 1) {
        if (row === col) continue;
        const factor = M[row][col];
        for (let c = col; c <= n; c += 1) {
          M[row][c] -= factor * M[col][c];
        }
      }
    }
    return M.map(row => row[n]);
  }

  function applyHomography(H, x, y) {
    const denom = H[6] * x + H[7] * y + H[8];
    return {
      x: (H[0] * x + H[1] * y + H[2]) / denom,
      y: (H[3] * x + H[4] * y + H[5]) / denom,
    };
  }

  function sampleNearest(src, width, height, x, y, dst, di) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      dst[di] = 0; dst[di + 1] = 0; dst[di + 2] = 0; dst[di + 3] = 0;
      return;
    }

    const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
    const si = (yi * width + xi) * 4;
    dst[di] = src[si];
    dst[di + 1] = src[si + 1];
    dst[di + 2] = src[si + 2];
    dst[di + 3] = src[si + 3];
  }

  function sampleBilinear(src, width, height, x, y, dst, di) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      dst[di] = 0; dst[di + 1] = 0; dst[di + 2] = 0; dst[di + 3] = 0;
      return;
    }

    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const dx = x - x0;
    const dy = y - y0;

    const i00 = (y0 * width + x0) * 4;
    const i10 = (y0 * width + x1) * 4;
    const i01 = (y1 * width + x0) * 4;
    const i11 = (y1 * width + x1) * 4;

    const w00 = (1 - dx) * (1 - dy);
    const w10 = dx * (1 - dy);
    const w01 = (1 - dx) * dy;
    const w11 = dx * dy;

    dst[di] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    dst[di + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    dst[di + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
    dst[di + 3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
  }

  new ResizeObserver(resizeEditorCanvas).observe(editorCanvas.parentElement);
  if (previewStage) new ResizeObserver(fitOutputPreviewCanvas).observe(previewStage);
  updateOutputSummary();
})();
