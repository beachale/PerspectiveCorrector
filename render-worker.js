const DEFAULT_SAMPLING = 'nearest';

let source = null;
let activeJobId = null;
const cancelledJobs = new Set();

self.onmessage = event => {
  const message = event.data || {};

  if (message.type === 'setSource') {
    try {
      source = {
        width: message.width,
        height: message.height,
        data: new Uint8ClampedArray(message.buffer),
      };
      self.postMessage({ type: 'sourceReady', sourceId: message.sourceId });
    } catch (error) {
      source = null;
      self.postMessage({ type: 'sourceError', sourceId: message.sourceId, message: error.message });
    }
    return;
  }

  if (message.type === 'cancel') {
    if (message.jobId != null) cancelledJobs.add(message.jobId);
    if (message.jobId == null && activeJobId != null) cancelledJobs.add(activeJobId);
    return;
  }

  if (message.type === 'render') {
    renderPerspective(message).catch(error => {
      if (message.jobId != null) {
        self.postMessage({ type: 'error', jobId: message.jobId, message: error.message || 'Perspective render failed.' });
      }
    });
  }
};

async function renderPerspective(job) {
  if (!source) {
    self.postMessage({ type: 'error', jobId: job.jobId, message: 'Source image is not ready.' });
    return;
  }

  if (activeJobId != null) cancelledJobs.add(activeJobId);
  activeJobId = job.jobId;

  const outW = job.width;
  const outH = job.height;
  const outData = new Uint8ClampedArray(outW * outH * 4);
  const mapOutputPoint = createOutputToImageMapper(outW, outH, job.quad, job.warps);
  const samplePixel = getSamplePixelFunction(job.sampling || DEFAULT_SAMPLING);
  const rowsPerYield = Math.max(4, Math.floor(130000 / outW));

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const mapped = mapOutputPoint(x + 0.5, y + 0.5);
      samplePixel(source.data, source.width, source.height, mapped.x, mapped.y, outData, (y * outW + x) * 4);
    }

    if (y % rowsPerYield === 0) {
      if (cancelledJobs.has(job.jobId)) {
        cancelledJobs.delete(job.jobId);
        if (activeJobId === job.jobId) activeJobId = null;
        self.postMessage({ type: 'cancelled', jobId: job.jobId });
        return;
      }
      self.postMessage({ type: 'progress', jobId: job.jobId, value: (y / outH) * 100 });
      await yieldToMessages();
    }
  }

  if (cancelledJobs.has(job.jobId)) {
    cancelledJobs.delete(job.jobId);
    if (activeJobId === job.jobId) activeJobId = null;
    self.postMessage({ type: 'cancelled', jobId: job.jobId });
    return;
  }

  if (activeJobId === job.jobId) activeJobId = null;
  self.postMessage({
    type: 'done',
    jobId: job.jobId,
    width: outW,
    height: outH,
    buffer: outData.buffer,
  }, [outData.buffer]);
}

function getSamplePixelFunction(sampling) {
  return sampling === 'nearest' ? sampleNearest : sampleBilinear;
}

function yieldToMessages() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function createOutputToImageMapper(outW, outH, quad, warps) {
  const dstRect = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = solveHomography(dstRect, quad);
  const useWarp = hasSideWarp(warps);

  return (x, y) => {
    const base = applyHomography(H, x, y);
    if (!useWarp) return base;

    const u = outW > 0 ? x / outW : 0;
    const v = outH > 0 ? y / outH : 0;
    const displacement = getWarpDisplacement(u, v, quad, warps);
    return {
      x: base.x + displacement.x,
      y: base.y + displacement.y,
    };
  };
}

function getWarpDisplacement(u, v, quad, warps) {
  const warped = coonsPatchPoint(u, v, quad, warps);
  const straight = bilinearPatchPoint(u, v, quad);
  return { x: warped.x - straight.x, y: warped.y - straight.y };
}

function coonsPatchPoint(u, v, quad, warps) {
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

function bilinearPatchPoint(u, v, quad) {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  return {
    x: (1 - u) * (1 - v) * topLeft.x + u * (1 - v) * topRight.x + u * v * bottomRight.x + (1 - u) * v * bottomLeft.x,
    y: (1 - u) * (1 - v) * topLeft.y + u * (1 - v) * topRight.y + u * v * bottomRight.y + (1 - u) * v * bottomLeft.y,
  };
}

function getEdgeCurvePoint(edgeIndex, t, quad, warps) {
  const a = quad[edgeIndex];
  const b = quad[(edgeIndex + 1) % 4];
  const normal = edgeInnerNormal(a, b);
  const offset = getEdgeWarpOffsetAtT(edgeIndex, t, warps);

  return {
    x: a.x + (b.x - a.x) * t + normal.x * offset,
    y: a.y + (b.y - a.y) * t + normal.y * offset,
  };
}

function getEdgeWarpOffsetAtT(edgeIndex, t, warps) {
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

function getSortedEdgeWarps(edgeIndex, warps) {
  const edgeWarps = warps?.[edgeIndex];
  return (edgeWarps && edgeWarps.length ? [...edgeWarps] : [{ t: 0.5, offset: 0 }]).sort((a, b) => a.t - b.t);
}

function edgeInnerNormal(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: 0, y: 0 };
  return { x: -dy / length, y: dx / length };
}

function hasSideWarp(warps) {
  return warps.some(edge => edge.some(warp => Math.abs(warp.offset) > 0.01));
}

function smoothStep(t) {
  const clamped = clamp(t, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
