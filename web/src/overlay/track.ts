export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export type GrayFrame = { gray: Float32Array; width: number; height: number };

export type TrackState = {
  width: number;
  height: number;
  refGray: Float32Array;
  keyPoints: { x: number; y: number }[];
  refPoints: { x: number; y: number }[];
  keyToRef: Mat3;
};

export function applyHomography(h: Mat3, x: number, y: number) {
  const w = h[6] * x + h[7] * y + h[8];
  const denom = Math.abs(w) < 1e-8 ? 1e-8 : w;
  return { x: (h[0] * x + h[1] * y + h[2]) / denom, y: (h[3] * x + h[4] * y + h[5]) / denom };
}

export function composeHomography(a: Mat3, b: Mat3): Mat3 {
  const out = Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as Mat3;
}

function similarity(pts: [number, number][]) {
  const cx = pts.reduce((sum, point) => sum + point[0], 0) / pts.length;
  const cy = pts.reduce((sum, point) => sum + point[1], 0) / pts.length;
  const dist = pts.reduce((sum, point) => sum + Math.hypot(point[0] - cx, point[1] - cy), 0) / pts.length;
  const scale = dist < 1e-8 ? 1 : Math.SQRT2 / dist;
  const T: Mat3 = [scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1];
  const mapped = pts.map((point) => [scale * (point[0] - cx), scale * (point[1] - cy)] as [number, number]);
  return { T, mapped };
}

function invertSimilarity(T: Mat3): Mat3 {
  const scale = T[0] || 1;
  return [1 / scale, 0, -T[2] / scale, 0, 1 / scale, -T[5] / scale, 0, 0, 1];
}

function solve8(rows: number[][], values: number[]) {
  const n = 8;
  const m = rows.map((row, index) => [...row, values[index]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const div = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let c = col; c <= n; c++) m[row][c] -= factor * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

export function solveHomography(src: [number, number][], dst: [number, number][]): Mat3 | null {
  if (src.length < 4 || dst.length < 4) return null;
  const source = similarity(src.slice(0, 4));
  const target = similarity(dst.slice(0, 4));
  const rows: number[][] = [];
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = source.mapped[i];
    const [u, v] = target.mapped[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }
  const h = solve8(rows, values);
  if (!h) return null;
  const normalized: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  return composeHomography(composeHomography(invertSimilarity(target.T), normalized), source.T);
}

function sample4(count: number, seed: number) {
  const random = (() => {
    let state = seed || 1;
    return () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  })();
  const index = new Set<number>();
  while (index.size < 4) index.add(Math.floor(random() * count));
  return [...index];
}

export function estimateHomography(src: [number, number][], dst: [number, number][], threshold = 3) {
  const count = Math.min(src.length, dst.length);
  if (count < 4) return null;
  let best: { h: Mat3; inliers: number } | null = null;
  const trials = count === 4 ? 1 : 40;
  for (let trial = 0; trial < trials; trial++) {
    const picked = count === 4 ? [0, 1, 2, 3] : sample4(count, trial + 1);
    const h = solveHomography(
      picked.map((index) => src[index]),
      picked.map((index) => dst[index]),
    );
    if (!h) continue;
    let inliers = 0;
    for (let i = 0; i < count; i++) {
      const point = applyHomography(h, src[i][0], src[i][1]);
      if (Math.hypot(point.x - dst[i][0], point.y - dst[i][1]) <= threshold) inliers += 1;
    }
    if (!best || inliers > best.inliers) best = { h, inliers };
  }
  return best;
}

export function grayFromRGBA(data: Uint8ClampedArray, width: number, height: number) {
  const gray = new Float32Array(width * height);
  for (let pixel = 0, index = 0; pixel < gray.length; pixel += 1, index += 4) {
    gray[pixel] = (data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114) / 255;
  }
  return gray;
}

export function frameFromImageData(image: ImageData, maxWidth = 480): GrayFrame {
  const scale = Math.min(1, maxWidth / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) {
    return { gray: grayFromRGBA(image.data, width, height), width, height };
  }
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / scale));
      const sy = Math.min(image.height - 1, Math.floor(y / scale));
      const index = (sy * image.width + sx) * 4;
      gray[y * width + x] = (image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114) / 255;
    }
  }
  return { gray, width, height };
}

function at(img: Float32Array, w: number, h: number, x: number, y: number) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const dx = x - x0;
  const dy = y - y0;
  return (
    img[y0 * w + x0] * (1 - dx) * (1 - dy) +
    img[y0 * w + x1] * dx * (1 - dy) +
    img[y1 * w + x0] * (1 - dx) * dy +
    img[y1 * w + x1] * dx * dy
  );
}

function lkPoint(
  prev: Float32Array,
  next: Float32Array,
  w: number,
  h: number,
  originX: number,
  originY: number,
  guessX: number,
  guessY: number,
) {
  let x = guessX;
  let y = guessY;
  const win = 5;
  for (let iter = 0; iter < 6; iter++) {
    let ix2 = 0;
    let iy2 = 0;
    let ixy = 0;
    let ixt = 0;
    let iyt = 0;
    for (let yy = -win; yy <= win; yy++) {
      for (let xx = -win; xx <= win; xx++) {
        const gx = Math.round(originX + xx);
        const gy = Math.round(originY + yy);
        if (gx <= 0 || gy <= 0 || gx >= w - 1 || gy >= h - 1) continue;
        const ix = prev[gy * w + gx + 1] - prev[gy * w + gx - 1];
        const iy = prev[(gy + 1) * w + gx] - prev[(gy - 1) * w + gx];
        const template = at(prev, w, h, gx, gy);
        const current = at(next, w, h, x + xx, y + yy);
        if (template == null || current == null) continue;
        const it = current - template;
        ix2 += ix * ix;
        iy2 += iy * iy;
        ixy += ix * iy;
        ixt += ix * it;
        iyt += iy * it;
      }
    }
    const det = ix2 * iy2 - ixy * ixy;
    if (Math.abs(det) < 1e-6) return { x, y, ok: false };
    const dx = (-ixt * iy2 + iyt * ixy) / det;
    const dy = (-iyt * ix2 + ixt * ixy) / det;
    x += dx;
    y += dy;
    if (Math.hypot(dx, dy) < 0.03) break;
  }
  const ok = x >= 1 && y >= 1 && x < w - 1 && y < h - 1 && Math.hypot(x - originX, y - originY) < Math.max(w, h) * 0.25;
  return { x, y, ok };
}

function half(img: Float32Array, w: number, h: number) {
  const width = Math.max(1, w >> 1);
  const height = Math.max(1, h >> 1);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = img[y * 2 * w + x * 2];
  }
  return { img: out, w: width, h: height };
}

export function trackPoints(prev: Float32Array, next: Float32Array, w: number, h: number, points: { x: number; y: number }[]) {
  const prevHalf = half(prev, w, h);
  const nextHalf = half(next, w, h);
  return points.map((point) => {
    const coarse = lkPoint(prevHalf.img, nextHalf.img, prevHalf.w, prevHalf.h, point.x / 2, point.y / 2, point.x / 2, point.y / 2);
    const guessX = coarse.ok ? coarse.x * 2 : point.x;
    const guessY = coarse.ok ? coarse.y * 2 : point.y;
    return lkPoint(prev, next, w, h, point.x, point.y, guessX, guessY);
  });
}

function cornerScore(gray: Float32Array, w: number, x: number, y: number) {
  let ix2 = 0;
  let iy2 = 0;
  let ixy = 0;
  for (let yy = -1; yy <= 1; yy++) {
    for (let xx = -1; xx <= 1; xx++) {
      const index = (y + yy) * w + (x + xx);
      const ix = gray[index + 1] - gray[index - 1];
      const iy = gray[index + w] - gray[index - w];
      ix2 += ix * ix;
      iy2 += iy * iy;
      ixy += ix * iy;
    }
  }
  const trace = ix2 + iy2;
  const det = ix2 * iy2 - ixy * ixy;
  return (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2;
}

export function strongCorners(gray: Float32Array, w: number, h: number, limit = 80) {
  const cell = 16;
  const found: { x: number; y: number; score: number }[] = [];
  for (let cy = 2; cy < h - 2; cy += cell) {
    for (let cx = 2; cx < w - 2; cx += cell) {
      let top = 0;
      let px = cx;
      let py = cy;
      for (let y = cy; y < Math.min(h - 2, cy + cell); y++) {
        for (let x = cx; x < Math.min(w - 2, cx + cell); x++) {
          const score = cornerScore(gray, w, x, y);
          if (score > top) {
            top = score;
            px = x;
            py = y;
          }
        }
      }
      if (top > 0.002) found.push({ x: px, y: py, score: top });
    }
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ x, y }) => ({ x, y }));
}

export function beginTrack(frame: GrayFrame): TrackState | null {
  const keyPoints = strongCorners(frame.gray, frame.width, frame.height);
  if (keyPoints.length < 8) return null;
  return {
    width: frame.width,
    height: frame.height,
    refGray: frame.gray,
    keyPoints,
    refPoints: keyPoints,
    keyToRef: IDENTITY,
  };
}

export function stepTrack(state: TrackState, frame: GrayFrame) {
  if (frame.width !== state.width || frame.height !== state.height) return { state, homography: null as Mat3 | null, steady: false };
  const tracked = trackPoints(state.refGray, frame.gray, state.width, state.height, state.refPoints);
  const src: [number, number][] = [];
  const dst: [number, number][] = [];
  tracked.forEach((point, index) => {
    if (!point.ok) return;
    src.push([state.refPoints[index].x, state.refPoints[index].y]);
    dst.push([point.x, point.y]);
  });
  const fit = estimateHomography(src, dst, 2.5);
  const steady = !!fit && fit.inliers >= 8 && fit.inliers >= Math.max(4, src.length * 0.4);
  if (!steady || !fit) return { state, homography: null as Mat3 | null, steady: false };
  const keyToNew = composeHomography(fit.h, state.keyToRef);
  const refPoints = state.keyPoints.map((point) => {
    const next = applyHomography(keyToNew, point.x, point.y);
    return { x: next.x, y: next.y };
  });
  return {
    state: { ...state, refGray: frame.gray, refPoints, keyToRef: keyToNew },
    homography: keyToNew,
    steady: true,
  };
}

export function projectAnchor(h: Mat3, x: number, y: number, width: number, height: number) {
  const point = applyHomography(h, x * width, y * height);
  return { x: point.x / width, y: point.y / height };
}
