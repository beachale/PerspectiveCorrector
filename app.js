(() => {
  const editorCanvas = document.getElementById('editorCanvas');
  const editorCtx = editorCanvas.getContext('2d');
  const outputCanvas = document.getElementById('outputCanvas');
  const outputCtx = outputCanvas.getContext('2d');

  const fileInput = document.getElementById('fileInput');
  const loadSampleBtn = document.getElementById('loadSampleBtn');
  const resetWarpsBtn = document.getElementById('resetWarpsBtn');
  const resetViewBtn = document.getElementById('resetViewBtn');
  const rectifyBtn = document.getElementById('rectifyBtn');
  const livePreviewToggle = document.getElementById('livePreviewToggle');
  const smoothPixelsToggle = document.getElementById('smoothPixelsToggle');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyBtn = document.getElementById('copyBtn');
  const gridDivisionsSelect = document.getElementById('gridDivisions');
  const selectionColorInput = document.getElementById('selectionColor');

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
    editorZoom: 1,
    editorPan: createPan(),
    outputZoom: 1,
    outputPan: createPan(),
    outputDragging: null,
    dragging: null,
    spaceDown: false,
    dimAmount: 0,
    lastOutputBlob: null,
    lastOutputSize: null,
    livePreviewEnabled: false,
    livePreviewRendering: false,
    finalRendering: false,
    livePreviewPending: false,
    livePreviewPendingQuality: null,
    livePreviewTimer: null,
    livePreviewRequestId: 0,
    renderGeneration: 0,
    finalRenderId: 0,
    imageLoadSeq: 0,
    dragImageDepth: 0,
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
    gridDivisions: 4,
    selectionColor: '#7dd3fc',
    selectionLineStroke: 'rgba(125, 211, 252, 0.96)',
    selectionGridStroke: 'rgba(125, 211, 252, 0.34)',
  };
  state.imageCtx = state.imageCanvas.getContext('2d', { willReadFrequently: true });

  const ASSET_VERSION = '20260611-45';
  const DEFAULT_SAMPLING = 'nearest';
  const DEFAULT_SELECTION_COLOR = '#7dd3fc';
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
  const LEFT_CANVAS_MIN_ZOOM = 0.1;
  const LEFT_CANVAS_MAX_ZOOM = 32;
  const MAX_PIXELS = 50_000_000;
  const DIM_SLIDER_MAX = 0.6;
  const DIM_SLIDER_HIT_RADIUS = 18;
  const DEFAULT_GRID_DIVISIONS = 4;
  const MIN_GRID_DIVISIONS = 2;
  const MAX_GRID_DIVISIONS = 32;
  const MIN_EDGE_CURVE_DRAW_STEPS = 24;
  const MAX_EDGE_CURVE_DRAW_STEPS = 96;
  const MIN_GRID_LINE_DRAW_STEPS = 14;
  const MAX_GRID_LINE_DRAW_STEPS = 72;
  const EDGE_HIT_TEST_STEPS = 18;
  const EDGE_WARP_ADD_STEPS = 48;
  const LIVE_PREVIEW_FAST_MAX_LONG_EDGE = 900;
  const LIVE_PREVIEW_FAST_MAX_PIXELS = 360_000;
  const LIVE_PREVIEW_SHARP_MAX_LONG_EDGE = 1800;
  const LIVE_PREVIEW_SHARP_MAX_PIXELS = 1_600_000;
  const LIVE_PREVIEW_FAST_DEBOUNCE_MS = 100;
  const LIVE_PREVIEW_SHARP_DEBOUNCE_MS = 450;
  const OUTPUT_CANVAS_MIN_ZOOM = LEFT_CANVAS_MIN_ZOOM;
  const OUTPUT_CANVAS_MAX_ZOOM = LEFT_CANVAS_MAX_ZOOM;
  const VIEW_ZOOM_SENSITIVITY = 0.0011;

  function createPan(x = 0, y = 0) {
    return { x, y };
  }

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

  async function buildPerspectiveImage(outW, outH, onProgress = null, isCancelled = null, sampling = DEFAULT_SAMPLING) {
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

  function buildPerspectiveImageInWorker(outW, outH, onProgress = null, isCancelled = null, sampling = DEFAULT_SAMPLING) {
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

  function clearLivePreviewTimer() {
    if (!state.livePreviewTimer) return;
    clearTimeout(state.livePreviewTimer);
    state.livePreviewTimer = null;
  }

  function cancelActiveRenderJobs() {
    clearLivePreviewTimer();
    state.livePreviewRequestId += 1;
    state.livePreviewPending = false;
    state.livePreviewPendingQuality = null;

    if (state.pendingWorkerSource) {
      state.pendingWorkerSource.resolve(false);
      state.pendingWorkerSource = null;
    }

    if (state.activeWorkerJobId != null) {
      cancelWorkerJob(state.activeWorkerJobId);
    }
  }

  function invalidateRenderGeneration() {
    state.renderGeneration += 1;
    cancelActiveRenderJobs();
  }

  function resizeEditorCanvas() {
    const rect = editorCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (editorCanvas.width === width && editorCanvas.height === height) return;

    editorCanvas.width = width;
    editorCanvas.height = height;
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
    const scale = Math.max(0.02, base * state.editorZoom);
    const x = (width - state.image.width * scale) / 2 + state.editorPan.x;
    const y = (height - state.image.height * scale) / 2 + state.editorPan.y;
    return { scale, x, y };
  }

  function clearCanvasPixels(ctx, canvas) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function clearEditorCanvas() {
    clearCanvasPixels(editorCtx, editorCanvas);
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
    if (!state.image) return;

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
    state.editorZoom = 1;
    state.editorPan = createPan();
    drawEditor();
  }

  function drawEditor() {
    const { width, height } = getEditorSize();
    clearEditorCanvas();

    if (!state.image) return;

    const t = getViewTransform();
    // Disabled = nearest-neighbor/pixel-exact; enabled = bilinear-smoothed editor display.
    editorCtx.imageSmoothingEnabled = state.smoothEditorPixels;
    if (state.smoothEditorPixels) editorCtx.imageSmoothingQuality = 'medium';
    editorCtx.drawImage(state.image, t.x, t.y, state.image.width * t.scale, state.image.height * t.scale);

    if (!state.quad) return;

    const points = state.quad.map(point => imageToScreen(point, t));
    const edgeCache = createEdgeCurveCache();

    if (state.dimAmount > 0.005) {
      // Draw the dimmer only outside the selected quadrilateral.
      // Do not use destination-out here: it erases the already-drawn photo
      // inside the selection and makes the frame appear as a white/blank fill.
      editorCtx.save();
      editorCtx.fillStyle = `rgba(0, 0, 0, ${state.dimAmount.toFixed(3)})`;
      editorCtx.beginPath();
      editorCtx.rect(0, 0, width, height);
      traceSelectionPath(editorCtx, t, edgeCache);
      editorCtx.fill('evenodd');
      editorCtx.restore();
    }

    editorCtx.save();
    editorCtx.globalCompositeOperation = 'source-over';
    editorCtx.lineWidth = 2;
    editorCtx.lineJoin = 'round';
    editorCtx.lineCap = 'round';
    editorCtx.strokeStyle = state.selectionLineStroke;
    editorCtx.beginPath();
    traceSelectionPath(editorCtx, t, edgeCache);
    editorCtx.stroke();
    editorCtx.beginPath();
    editorCtx.restore();

    drawPerspectiveGrid(points, t, edgeCache);
    drawEdgeHandles(points, t);
    drawCornerHandles(points);
    drawDimSlider(width, height);
  }

  function drawPerspectiveGrid(points, viewTransform, edgeCache) {
    if (points.length !== 4) return;

    let H;
    try {
      H = getUnitToQuadHomography();
    } catch (_) {
      return;
    }

    const useWarp = hasSideWarp();

    editorCtx.save();
    editorCtx.strokeStyle = state.selectionGridStroke;
    editorCtx.lineWidth = 1;
    editorCtx.lineJoin = 'round';
    editorCtx.lineCap = 'round';
    editorCtx.beginPath();

    const divisions = state.gridDivisions;
    const gridLineSteps = getAdaptiveGridLineDrawSteps(viewTransform, edgeCache);
    for (let i = 1; i < divisions; i += 1) {
      const t = i / divisions;
      traceMappedGridLine({ u: t, v: 0 }, { u: t, v: 1 }, H, viewTransform, useWarp, edgeCache, gridLineSteps);
      traceMappedGridLine({ u: 0, v: t }, { u: 1, v: t }, H, viewTransform, useWarp, edgeCache, gridLineSteps);
    }

    editorCtx.stroke();
    editorCtx.restore();
  }

  function traceMappedGridLine(from, to, H, viewTransform, useWarp, edgeCache, steps = MIN_GRID_LINE_DRAW_STEPS) {
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const imagePoint = mapUnitToImage(
        from.u + (to.u - from.u) * t,
        from.v + (to.v - from.v) * t,
        H,
        useWarp,
        edgeCache,
      );
      const screenPoint = imageToScreen(imagePoint, viewTransform);
      if (i === 0) editorCtx.moveTo(screenPoint.x, screenPoint.y);
      else editorCtx.lineTo(screenPoint.x, screenPoint.y);
    }
  }

  function traceSelectionPath(ctx, viewTransform = getViewTransform(), edgeCache = null) {
    if (!state.quad) return;

    let hasStarted = false;
    for (let edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
      const steps = getAdaptiveEdgeCurveDrawSteps(edgeIndex, viewTransform, edgeCache);
      for (let step = 0; step <= steps; step += 1) {
        if (edgeIndex > 0 && step === 0) continue;
        const point = imageToScreen(getEdgeCurvePoint(edgeIndex, step / steps, state.quad, state.edgeWarps, edgeCache), viewTransform);
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


  function getAdaptiveEdgeCurveDrawSteps(edgeIndex, viewTransform = getViewTransform(), edgeCache = null) {
    const a = imageToScreen(state.quad[edgeIndex], viewTransform);
    const b = imageToScreen(state.quad[(edgeIndex + 1) % 4], viewTransform);
    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
    const warpCount = getEdgeWarps(edgeIndex).length;
    const suggested = Math.ceil(edgeLength / 14) + Math.max(0, warpCount - 1) * 8;
    return clamp(Math.max(MIN_EDGE_CURVE_DRAW_STEPS, suggested), MIN_EDGE_CURVE_DRAW_STEPS, MAX_EDGE_CURVE_DRAW_STEPS);
  }

  function getAdaptiveGridLineDrawSteps(viewTransform = getViewTransform(), edgeCache = null) {
    let longestEdgeLength = 0;
    for (let edgeIndex = 0; edgeIndex < 4; edgeIndex += 1) {
      const a = imageToScreen(state.quad[edgeIndex], viewTransform);
      const b = imageToScreen(state.quad[(edgeIndex + 1) % 4], viewTransform);
      longestEdgeLength = Math.max(longestEdgeLength, Math.hypot(b.x - a.x, b.y - a.y));
    }
    const suggested = Math.ceil(longestEdgeLength / 18) + Math.max(0, state.gridDivisions - DEFAULT_GRID_DIVISIONS);
    return clamp(Math.max(MIN_GRID_LINE_DRAW_STEPS, suggested), MIN_GRID_LINE_DRAW_STEPS, MAX_GRID_LINE_DRAW_STEPS);
  }

  function getEdgeCurvePoint(edgeIndex, t, quad = state.quad, warps = state.edgeWarps, edgeCache = null) {
    if (edgeCache) return getCachedEdgeCurvePoint(edgeCache[edgeIndex], t);

    const a = quad[edgeIndex];
    const b = quad[(edgeIndex + 1) % 4];
    const normal = edgeInnerNormal(a, b);
    const offset = getEdgeWarpOffsetAtT(edgeIndex, t, warps);

    return {
      x: a.x + (b.x - a.x) * t + normal.x * offset,
      y: a.y + (b.y - a.y) * t + normal.y * offset,
    };
  }

  function createEdgeCurveCache(quad = state.quad, warps = state.edgeWarps) {
    return quad.map((a, edgeIndex) => {
      const b = quad[(edgeIndex + 1) % 4];
      return {
        a,
        b,
        normal: edgeInnerNormal(a, b),
        stops: createWarpStops(getEdgeWarps(edgeIndex, warps)),
      };
    });
  }

  function getCachedEdgeCurvePoint(edge, t) {
    const offset = getEdgeWarpOffsetFromStops(edge.stops, t);
    return {
      x: edge.a.x + (edge.b.x - edge.a.x) * t + edge.normal.x * offset,
      y: edge.a.y + (edge.b.y - edge.a.y) * t + edge.normal.y * offset,
    };
  }

  function getEdgeWarpOffsetAtT(edgeIndex, t, warps = state.edgeWarps) {
    return getEdgeWarpOffsetFromStops(createWarpStops(getEdgeWarps(edgeIndex, warps)), t);
  }

  function getEdgeWarpOffsetFromStops(stops, t) {
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
    invalidateRenderGeneration();
    invalidateRenderedOutput();
    drawEditor();
    updateOutputSummary();
    scheduleLivePreview({ quality: 'sharp' });
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

  function resetView() {
    let didReset = false;

    if (state.image) {
      fitView();
      didReset = true;
    }

    if (state.lastOutputSize) {
      resetOutputViewState();
      applyOutputView();
      didReset = true;
    }

    if (didReset) setStatus('Views reset.');
  }

  function getEdgeWarps(edgeIndex, warps = state.edgeWarps) {
    const edgeWarps = warps?.[edgeIndex];
    return edgeWarps && edgeWarps.length ? edgeWarps : [{ t: 0.5, offset: 0 }];
  }

  function createWarpStops(edgeWarps) {
    const handles = (edgeWarps && edgeWarps.length ? [...edgeWarps] : [{ t: 0.5, offset: 0 }])
      .sort((a, b) => a.t - b.t);
    return [
      { t: 0, offset: 0 },
      ...handles,
      { t: 1, offset: 0 },
    ];
  }

  function getSortedEdgeWarps(edgeIndex, warps = state.edgeWarps) {
    return createWarpStops(getEdgeWarps(edgeIndex, warps)).slice(1, -1);
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

  function mapUnitToImage(u, v, H = getUnitToQuadHomography(), useWarp = hasSideWarp(), edgeCache = null) {
    const base = applyHomography(H, u, v);
    if (!useWarp) return base;
    const displacement = getWarpDisplacement(u, v, state.quad, state.edgeWarps, edgeCache);
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

  function getWarpDisplacement(u, v, quad = state.quad, warps = state.edgeWarps, edgeCache = null) {
    const warped = coonsPatchPoint(u, v, quad, warps, edgeCache);
    const straight = bilinearPatchPoint(u, v, quad);
    return { x: warped.x - straight.x, y: warped.y - straight.y };
  }

  function coonsPatchPoint(u, v, quad = state.quad, warps = state.edgeWarps, edgeCache = null) {
    const top = getEdgeCurvePoint(0, u, quad, warps, edgeCache);
    const right = getEdgeCurvePoint(1, v, quad, warps, edgeCache);
    const bottom = getEdgeCurvePoint(2, 1 - u, quad, warps, edgeCache);
    const left = getEdgeCurvePoint(3, 1 - v, quad, warps, edgeCache);
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

  function relativePointerPosition(event, element) {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pointerPosition(event) {
    return relativePointerPosition(event, editorCanvas);
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

  function isEditableElement(element) {
    return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"]'));
  }

  function getImageFileFromFileList(files) {
    return Array.from(files || []).find(file => file.type?.startsWith('image/')) || null;
  }

  function getImageFileFromItems(items) {
    for (const item of Array.from(items || [])) {
      if (item.kind === 'file' && item.type?.startsWith('image/')) {
        return item.getAsFile();
      }
    }
    return null;
  }

  function getImageFileFromDataTransfer(dataTransfer) {
    return getImageFileFromFileList(dataTransfer?.files) || getImageFileFromItems(dataTransfer?.items);
  }

  function dataTransferHasImage(dataTransfer) {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.items || []).some(item => item.kind === 'file' && item.type?.startsWith('image/'))) return true;
    return Array.from(dataTransfer.types || []).includes('Files');
  }

  function setImageDragActive(active) {
    document.body.classList.toggle('is-dragging-image', active);
  }

  function resetImageDragState() {
    state.dragImageDepth = 0;
    setImageDragActive(false);
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
      state.dragging = { type: 'pan', startScreen: screen, startPan: { ...state.editorPan } };
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
      state.dragging = { type: 'pan', startScreen: screen, startPan: { ...state.editorPan } };
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
      state.editorPan.x = state.dragging.startPan.x + (screen.x - state.dragging.startScreen.x);
      state.editorPan.y = state.dragging.startPan.y + (screen.y - state.dragging.startScreen.y);
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
    invalidateRenderGeneration();
    invalidateRenderedOutput();
    updateOutputSummary();
    scheduleLivePreview({ quality: 'fast' });
  });

  editorCanvas.addEventListener('pointerup', (event) => {
    const completedDrag = state.dragging;
    if (completedDrag) {
      editorCanvas.releasePointerCapture(event.pointerId);
      state.dragging = null;
      editorCanvas.style.cursor = 'grab';
      if (isGeometryDrag(completedDrag)) scheduleLivePreview({ quality: 'sharp' });
    }
  });

  editorCanvas.addEventListener('pointercancel', () => {
    const cancelledDrag = state.dragging;
    state.dragging = null;
    editorCanvas.style.cursor = 'grab';
    if (isGeometryDrag(cancelledDrag)) scheduleLivePreview({ quality: 'sharp' });
  });

  editorCanvas.addEventListener('wheel', (event) => {
    if (!state.image) return;
    event.preventDefault();
    const screen = pointerPosition(event);
    const before = screenToImage(screen);
    const factor = Math.exp(-event.deltaY * VIEW_ZOOM_SENSITIVITY);
    state.editorZoom = clamp(state.editorZoom * factor, LEFT_CANVAS_MIN_ZOOM, LEFT_CANVAS_MAX_ZOOM);
    const after = imageToScreen(before);
    state.editorPan.x += screen.x - after.x;
    state.editorPan.y += screen.y - after.y;
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
    await loadImageFile(file);
    fileInput.value = '';
  });

  loadSampleBtn.addEventListener('click', async () => {
    await loadImageFromUrl('sample.jpg', DEMO_IMAGE_NAME, false, { useDemoDefaults: true });
  });

  window.addEventListener('paste', async (event) => {
    if (isEditableElement(document.activeElement)) return;
    const file = getImageFileFromItems(event.clipboardData?.items) || getImageFileFromFileList(event.clipboardData?.files);
    if (!file) return;

    event.preventDefault();
    setStatus('Loading pasted image…');
    await loadImageFile(file);
  });

  window.addEventListener('dragenter', (event) => {
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    state.dragImageDepth += 1;
    setImageDragActive(true);
  });

  window.addEventListener('dragover', (event) => {
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setImageDragActive(true);
  });

  window.addEventListener('dragleave', (event) => {
    if (!dataTransferHasImage(event.dataTransfer)) return;
    state.dragImageDepth = Math.max(0, state.dragImageDepth - 1);
    if (state.dragImageDepth === 0) setImageDragActive(false);
  });

  window.addEventListener('drop', async (event) => {
    const file = getImageFileFromDataTransfer(event.dataTransfer);
    if (!file) return;

    event.preventDefault();
    resetImageDragState();
    setStatus('Loading dropped image…');
    await loadImageFile(file);
  });

  window.addEventListener('dragend', resetImageDragState);

  resetWarpsBtn.addEventListener('click', resetWarps);
  resetViewBtn.addEventListener('click', resetView);

  previewStage.addEventListener('pointerdown', handleOutputPointerDown);
  previewStage.addEventListener('pointermove', handleOutputPointerMove);
  previewStage.addEventListener('pointerup', handleOutputPointerUp);
  previewStage.addEventListener('pointercancel', handleOutputPointerCancel);
  previewStage.addEventListener('wheel', handleOutputWheel, { passive: false });
  previewStage.addEventListener('dblclick', resetOutputView);

  [outWidthInput, outHeightInput].forEach(el => {
    el.addEventListener('input', refreshOutputSettings);
    el.addEventListener('change', refreshOutputSettings);
  });

  outputMode.addEventListener('change', syncOutputModeVisibility);
  if (exportSampling) exportSampling.addEventListener('change', refreshOutputSettings);
  if (gridDivisionsSelect) gridDivisionsSelect.addEventListener('change', updateGridDivisions);
  if (selectionColorInput) {
    selectionColorInput.addEventListener('input', updateSelectionColor);
    selectionColorInput.addEventListener('change', updateSelectionColor);
  }

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
      setStatus('Live preview is on. It renders quickly while dragging, then sharpens after you stop. Click Correct perspective for the full-resolution export.');
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

    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': state.lastOutputBlob })]);
      setStatus('Copied corrected image to clipboard.', 'success');
    } catch (error) {
      console.error('Clipboard copy failed:', error);
      setStatus('Could not copy to the clipboard. Your browser may require permission or HTTPS; use Download PNG instead.', 'danger');
    }
  });

  function normalizeGridDivisions(value) {
    const divisions = Number.parseInt(value, 10);
    if (!Number.isFinite(divisions)) return DEFAULT_GRID_DIVISIONS;
    return clamp(divisions, MIN_GRID_DIVISIONS, MAX_GRID_DIVISIONS);
  }

  function updateGridDivisions() {
    state.gridDivisions = normalizeGridDivisions(gridDivisionsSelect?.value);
    drawEditor();
  }

  function normalizeSelectionColor(value) {
    return /^#[0-9a-f]{6}$/i.test(value || '') ? value : DEFAULT_SELECTION_COLOR;
  }

  function updateSelectionColor() {
    state.selectionColor = normalizeSelectionColor(selectionColorInput?.value);
    state.selectionLineStroke = selectionColorWithAlpha(0.96);
    state.selectionGridStroke = selectionColorWithAlpha(0.34);
    drawEditor();
  }

  function selectionColorWithAlpha(alpha) {
    const hex = normalizeSelectionColor(state.selectionColor).slice(1);
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function getSamplePixelFunction(sampling) {
    return sampling === 'nearest' ? sampleNearest : sampleBilinear;
  }

  function getSamplingMode() {
    return exportSampling?.value || DEFAULT_SAMPLING;
  }

  function refreshOutputSettings() {
    invalidateRenderGeneration();
    invalidateRenderedOutput();
    updateOutputSummary();
    scheduleLivePreview();
  }

  function syncOutputModeVisibility() {
    resolutionFields.classList.toggle('hidden', outputMode.value !== 'resolution');
    refreshOutputSettings();
  }

  function getDefaultOutputDimensions(useDemoDefaults = false) {
    if (useDemoDefaults) {
      return { width: DEMO_OUTPUT_WIDTH, height: DEMO_OUTPUT_HEIGHT };
    }

    if (state.imageCanvas.width > 0 && state.imageCanvas.height > 0) {
      return { width: state.imageCanvas.width, height: state.imageCanvas.height };
    }

    if (state.image) {
      return {
        width: state.image.naturalWidth || state.image.width || DEFAULT_OUTPUT_WIDTH,
        height: state.image.naturalHeight || state.image.height || DEFAULT_OUTPUT_HEIGHT,
      };
    }

    return { width: DEFAULT_OUTPUT_WIDTH, height: DEFAULT_OUTPUT_HEIGHT };
  }

  function applyOutputDefaults(useDemoDefaults) {
    const { width, height } = getDefaultOutputDimensions(useDemoDefaults);
    outputMode.value = 'resolution';
    outWidthInput.value = width;
    outHeightInput.value = height;
    syncOutputModeVisibility();
  }

  async function loadImageFile(file) {
    if (!file || !file.type?.startsWith('image/')) {
      setStatus('That file is not an image.', 'danger');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    await loadImageFromUrl(objectUrl, file.name, true);
  }

  async function loadImageFromUrl(url, name, revokeAfterLoad = false, options = {}) {
    const loadId = ++state.imageLoadSeq;
    invalidateRenderGeneration();
    state.finalRenderId += 1;
    state.finalRendering = false;
    rectifyBtn.disabled = true;
    setExportButtonsEnabled(false);

    const img = new Image();
    img.decoding = 'async';

    const loaded = await new Promise(resolve => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });

    if (revokeAfterLoad) URL.revokeObjectURL(url);

    if (loadId !== state.imageLoadSeq) return;

    if (!loaded) {
      setStatus('Could not load that image.', 'danger');
      return;
    }

    invalidateRenderGeneration();
    state.image = img;
    state.imageName = name || 'image';
    state.imageCanvas.width = img.naturalWidth || img.width;
    state.imageCanvas.height = img.naturalHeight || img.height;
    state.imageCtx.clearRect(0, 0, state.imageCanvas.width, state.imageCanvas.height);
    state.imageCtx.imageSmoothingEnabled = false;
    state.imageCtx.drawImage(img, 0, 0, state.imageCanvas.width, state.imageCanvas.height);
    state.imageData = state.imageCtx.getImageData(0, 0, state.imageCanvas.width, state.imageCanvas.height);

    const sourceReady = await setRenderWorkerSource();
    if (loadId !== state.imageLoadSeq) return;
    if (!sourceReady && state.renderWorker && !state.renderWorkerUnavailable) {
      setStatus('Image loaded, but the render worker source was replaced. Try again if rendering does not start.', 'danger');
    }

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
    setStatus(`Loaded ${state.imageName} at ${state.image.width} × ${state.image.height}. Output defaults to source resolution; align the frame, then correct perspective.`);
  }

  function getOutputSize() {
    const mode = outputMode.value;
    if (mode === 'resolution') {
      const defaults = getDefaultOutputDimensions(state.usingDemoDefaults);
      return {
        width: sanePositiveInt(outWidthInput.value, defaults.width),
        height: sanePositiveInt(outHeightInput.value, defaults.height),
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

    const renderGeneration = ++state.renderGeneration;
    const finalRenderId = ++state.finalRenderId;
    cancelActiveRenderJobs();

    const { width: outW, height: outH } = getOutputSize();
    const pixels = outW * outH;
    if (pixels > MAX_PIXELS) {
      throw new Error(`Output is ${(pixels / 1_000_000).toFixed(1)} MP. Keep it under ${(MAX_PIXELS / 1_000_000).toFixed(0)} MP for browser rendering.`);
    }

    const isCurrentRender = () => state.renderGeneration === renderGeneration && state.finalRenderId === finalRenderId;
    const isCancelled = () => !isCurrentRender() || !state.image || !state.quad;

    state.finalRendering = true;
    state.livePreviewPending = false;
    state.livePreviewPendingQuality = null;
    clearLivePreviewTimer();
    rectifyBtn.disabled = true;
    setExportButtonsEnabled(false);
    setProgress(0);
    setStatus('Correcting perspective…');

    try {
      await nextFrame();
      if (isCancelled()) return;

      const sampling = getSamplingMode();
      const out = await buildPerspectiveImage(
        outW,
        outH,
        value => {
          if (isCurrentRender()) setProgress(value);
        },
        isCancelled,
        sampling,
      );

      if (!out || isCancelled()) return;

      const blob = await imageDataToBlob(out, outW, outH);
      if (isCancelled()) return;

      state.lastOutputBlob = blob;
      displayOutput(out, outW, outH, `${outW} × ${outH}`, { preserveView: true });
      setExportButtonsEnabled(true);
      rectifyBtn.disabled = false;
      setProgress(100);
      const samplingLabel = sampling === 'nearest' ? 'sharp nearest-neighbor' : 'smooth bilinear';
      setStatus(`Done. Export is ${outW} × ${outH} (${samplingLabel}).`, 'success');
      setTimeout(() => {
        if (isCurrentRender()) setProgress(null);
      }, 650);
    } finally {
      if (state.finalRenderId === finalRenderId) {
        state.finalRendering = false;
        rectifyBtn.disabled = !state.image;
        setExportButtonsEnabled(Boolean(state.lastOutputBlob));
        if (state.renderGeneration !== renderGeneration) {
          setProgress(null);
          if (state.livePreviewEnabled && state.image && state.quad) scheduleLivePreview(true);
        }
      }
    }
  }

  async function buildPerspectiveImageOnMain(outW, outH, onProgress = null, isCancelled = null, sampling = DEFAULT_SAMPLING) {
    const mapOutputPoint = createOutputToImageMapper(outW, outH);
    const src = state.imageData.data;
    const srcW = state.imageData.width;
    const srcH = state.imageData.height;
    const out = new ImageData(outW, outH);
    const dst = out.data;
    const samplePixel = getSamplePixelFunction(sampling);

    const rowsPerYield = Math.max(4, Math.floor(110000 / outW));
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        const mapped = mapOutputPoint(x + 0.5, y + 0.5);
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
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ];
    const H = solveHomography(dstRect, quad);
    const useWarp = hasSideWarp(warps);
    const edgeCache = useWarp ? createEdgeCurveCache(quad, warps) : null;

    return (x, y) => {
      const base = applyHomography(H, x, y);
      if (!useWarp) return base;

      const u = outW > 0 ? x / outW : 0;
      const v = outH > 0 ? y / outH : 0;
      const displacement = getWarpDisplacement(u, v, quad, warps, edgeCache);
      return {
        x: base.x + displacement.x,
        y: base.y + displacement.y,
      };
    };
  }

  function isGeometryDrag(drag) {
    return drag?.type === 'corner' || drag?.type === 'sideWarp' || drag?.type === 'edge';
  }

  function normalizeLivePreviewQuality(quality) {
    return quality === 'fast' ? 'fast' : 'sharp';
  }

  function getLivePreviewConfig(quality) {
    return normalizeLivePreviewQuality(quality) === 'fast'
      ? {
        maxLongEdge: LIVE_PREVIEW_FAST_MAX_LONG_EDGE,
        maxPixels: LIVE_PREVIEW_FAST_MAX_PIXELS,
        debounceMs: LIVE_PREVIEW_FAST_DEBOUNCE_MS,
      }
      : {
        maxLongEdge: LIVE_PREVIEW_SHARP_MAX_LONG_EDGE,
        maxPixels: LIVE_PREVIEW_SHARP_MAX_PIXELS,
        debounceMs: LIVE_PREVIEW_SHARP_DEBOUNCE_MS,
      };
  }

  function getLivePreviewSize(quality = 'sharp') {
    const { width, height } = getOutputSize();
    const { maxLongEdge, maxPixels } = getLivePreviewConfig(quality);
    const scale = Math.min(
      1,
      maxLongEdge / Math.max(width, height),
      Math.sqrt(maxPixels / Math.max(1, width * height)),
    );

    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function scheduleLivePreview(options = {}) {
    if (!state.livePreviewEnabled || !state.image || !state.quad || state.finalRendering) return;

    const normalizedOptions = typeof options === 'boolean' ? { immediate: options } : options;
    const quality = normalizeLivePreviewQuality(normalizedOptions.quality);
    const { debounceMs } = getLivePreviewConfig(quality);

    state.livePreviewRequestId += 1;
    state.livePreviewPending = true;
    state.livePreviewPendingQuality = quality;

    clearLivePreviewTimer();

    if (state.livePreviewRendering) return;

    state.livePreviewTimer = setTimeout(() => {
      state.livePreviewTimer = null;
      renderQueuedLivePreview().catch(error => {
        console.error(error);
        setStatus(error.message || 'Live preview failed.', 'danger');
      });
    }, normalizedOptions.immediate ? 0 : debounceMs);
  }

  async function renderQueuedLivePreview() {
    if (!state.livePreviewEnabled || !state.image || !state.quad || state.finalRendering) return;
    if (state.livePreviewRendering) return;

    const quality = normalizeLivePreviewQuality(state.livePreviewPendingQuality);
    state.livePreviewPending = false;
    state.livePreviewPendingQuality = null;
    state.livePreviewRendering = true;
    const requestId = state.livePreviewRequestId;

    try {
      const { width: previewW, height: previewH } = getLivePreviewSize(quality);
      const sampling = getSamplingMode();
      const out = await buildPerspectiveImage(
        previewW,
        previewH,
        null,
        () => requestId !== state.livePreviewRequestId || !state.livePreviewEnabled,
        sampling,
      );

      if (!out || requestId !== state.livePreviewRequestId || !state.livePreviewEnabled) return;

      const preserveOutputView = Boolean(state.lastOutputSize);
      const qualityLabel = quality === 'fast' ? 'fast' : 'sharp';
      displayOutput(out, previewW, previewH, `Live preview ${qualityLabel} · ${previewW} × ${previewH}`, {
        preserveView: preserveOutputView,
      });

      state.lastOutputBlob = null;
      setExportButtonsEnabled(false);
    } finally {
      state.livePreviewRendering = false;
      if (!state.finalRendering && !state.lastOutputBlob && (state.livePreviewPending || state.livePreviewRequestId !== requestId)) {
        const pendingQuality = state.livePreviewPendingQuality || 'sharp';
        state.livePreviewPending = false;
        state.livePreviewPendingQuality = null;
        scheduleLivePreview({ immediate: true, quality: pendingQuality });
      }
    }
  }

  function setOutputCanvasFrame({ left = 0, top = 0, width = 0, height = 0 } = {}) {
    outputCanvas.style.width = `${width}px`;
    outputCanvas.style.height = `${height}px`;
    outputCanvas.style.left = `${left}px`;
    outputCanvas.style.top = `${top}px`;
  }

  function resetOutputPreview() {
    outputCanvas.width = 1;
    outputCanvas.height = 1;
    clearCanvasPixels(outputCtx, outputCanvas);
    setOutputCanvasFrame();
    resetOutputViewState();
    state.outputDragging = null;
    state.lastOutputSize = null;
    previewMeta.textContent = 'No output yet';
    previewPlaceholder.classList.remove('hidden');
    previewStage?.classList.remove('has-output', 'is-panning');
  }

  function displayOutput(imageData, width, height, metaText, options = {}) {
    const previousSize = state.lastOutputSize;
    const shouldResetOutputView = !options.preserveView && (
      !previousSize || previousSize.width !== width || previousSize.height !== height
    );

    outputCanvas.width = width;
    outputCanvas.height = height;
    outputCtx.putImageData(imageData, 0, 0);
    state.lastOutputSize = { width, height };

    if (shouldResetOutputView) resetOutputViewState();

    previewMeta.textContent = metaText;
    previewPlaceholder.classList.add('hidden');
    previewStage?.classList.add('has-output');
    applyOutputView();
  }

  function resetOutputViewState() {
    state.outputZoom = 1;
    state.outputPan = createPan();
  }

  function resetOutputView(event) {
    if (!state.lastOutputSize) return;
    event?.preventDefault?.();
    resetOutputViewState();
    applyOutputView();
    setStatus('Preview view reset.');
  }

  function getOutputViewLayout() {
    if (!state.lastOutputSize || !previewStage) return null;

    const stageRect = previewStage.getBoundingClientRect();
    const stageW = Math.max(1, stageRect.width);
    const stageH = Math.max(1, stageRect.height);
    const availableW = Math.max(1, stageW - 2);
    const availableH = Math.max(1, stageH - 2);
    const outputAspect = state.lastOutputSize.width / state.lastOutputSize.height;
    const stageAspect = availableW / availableH;

    let baseW;
    let baseH;
    if (stageAspect > outputAspect) {
      baseH = availableH;
      baseW = baseH * outputAspect;
    } else {
      baseW = availableW;
      baseH = baseW / outputAspect;
    }

    const cssW = Math.max(1, baseW * state.outputZoom);
    const cssH = Math.max(1, baseH * state.outputZoom);

    return {
      stageW,
      stageH,
      baseW,
      baseH,
      cssW,
      cssH,
      left: (stageW - cssW) / 2 + state.outputPan.x,
      top: (stageH - cssH) / 2 + state.outputPan.y,
    };
  }

  function applyOutputView() {
    const layout = getOutputViewLayout();
    if (!layout) {
      setOutputCanvasFrame();
      return;
    }

    setOutputCanvasFrame({
      left: layout.left,
      top: layout.top,
      width: layout.cssW,
      height: layout.cssH,
    });
  }

  function outputPointerPosition(event) {
    return relativePointerPosition(event, previewStage);
  }

  function handleOutputPointerDown(event) {
    if (!state.lastOutputSize || event.button > 1) return;
    event.preventDefault();
    previewStage.setPointerCapture(event.pointerId);
    const screen = outputPointerPosition(event);
    state.outputDragging = {
      pointerId: event.pointerId,
      startScreen: screen,
      startPan: { ...state.outputPan },
    };
    previewStage.classList.add('is-panning');
  }

  function handleOutputPointerMove(event) {
    if (!state.outputDragging) return;
    event.preventDefault();
    const screen = outputPointerPosition(event);
    state.outputPan.x = state.outputDragging.startPan.x + (screen.x - state.outputDragging.startScreen.x);
    state.outputPan.y = state.outputDragging.startPan.y + (screen.y - state.outputDragging.startScreen.y);
    applyOutputView();
  }

  function endOutputDrag(event) {
    if (event && previewStage.hasPointerCapture(event.pointerId)) {
      previewStage.releasePointerCapture(event.pointerId);
    }
    state.outputDragging = null;
    previewStage.classList.remove('is-panning');
  }

  function handleOutputPointerUp(event) {
    if (!state.outputDragging) return;
    endOutputDrag(event);
  }

  function handleOutputPointerCancel(event) {
    endOutputDrag(event);
  }

  function handleOutputWheel(event) {
    if (!state.lastOutputSize) return;
    event.preventDefault();

    const layout = getOutputViewLayout();
    if (!layout) return;

    const screen = outputPointerPosition(event);
    const contentX = (screen.x - layout.left) / layout.cssW;
    const contentY = (screen.y - layout.top) / layout.cssH;
    const factor = Math.exp(-event.deltaY * VIEW_ZOOM_SENSITIVITY);
    const nextZoom = clamp(state.outputZoom * factor, OUTPUT_CANVAS_MIN_ZOOM, OUTPUT_CANVAS_MAX_ZOOM);
    if (nextZoom === state.outputZoom) return;

    const nextCssW = Math.max(1, layout.baseW * nextZoom);
    const nextCssH = Math.max(1, layout.baseH * nextZoom);
    state.outputZoom = nextZoom;
    state.outputPan.x = screen.x - (layout.stageW - nextCssW) / 2 - contentX * nextCssW;
    state.outputPan.y = screen.y - (layout.stageH - nextCssH) / 2 - contentY * nextCssH;
    applyOutputView();
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

  function imageDataToBlob(imageData, width, height) {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.putImageData(imageData, 0, 0);
    return canvasToBlob(exportCanvas);
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

  function writeTransparentPixel(dst, di) {
    dst[di] = 0;
    dst[di + 1] = 0;
    dst[di + 2] = 0;
    dst[di + 3] = 0;
  }

  function copySampledPixel(src, si, dst, di) {
    dst[di] = src[si];
    dst[di + 1] = src[si + 1];
    dst[di + 2] = src[si + 2];
    dst[di + 3] = src[si + 3];
  }

  function clampSampleCenter(value, size) {
    return Math.max(0.5, Math.min(size - 0.5, value));
  }

  function sampleNearest(src, width, height, x, y, dst, di) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      writeTransparentPixel(dst, di);
      return;
    }

    x = clampSampleCenter(x, width);
    y = clampSampleCenter(y, height);

    const xi = Math.floor(x);
    const yi = Math.floor(y);
    copySampledPixel(src, (yi * width + xi) * 4, dst, di);
  }

  function sampleBilinear(src, width, height, x, y, dst, di) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      writeTransparentPixel(dst, di);
      return;
    }

    x = clampSampleCenter(x, width);
    y = clampSampleCenter(y, height);

    const sampleX = x - 0.5;
    const sampleY = y - 0.5;
    const x0 = Math.floor(sampleX);
    const y0 = Math.floor(sampleY);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const dx = sampleX - x0;
    const dy = sampleY - y0;

    const i00 = (y0 * width + x0) * 4;
    const i10 = (y0 * width + x1) * 4;
    const i01 = (y1 * width + x0) * 4;
    const i11 = (y1 * width + x1) * 4;

    const w00 = (1 - dx) * (1 - dy);
    const w10 = dx * (1 - dy);
    const w01 = (1 - dx) * dy;
    const w11 = dx * dy;

    for (let channel = 0; channel < 4; channel += 1) {
      dst[di + channel] =
        src[i00 + channel] * w00 +
        src[i10 + channel] * w10 +
        src[i01 + channel] * w01 +
        src[i11 + channel] * w11;
    }
  }

  new ResizeObserver(resizeEditorCanvas).observe(editorCanvas.parentElement);
  if (previewStage) new ResizeObserver(applyOutputView).observe(previewStage);
  updateGridDivisions();
  updateSelectionColor();
  updateOutputSummary();
})();
