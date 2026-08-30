// The points contract — the winning representation from the drawing
// bake-off. The hand does not write curves: it places POINTS along each
// contour it means, and the quill pulls one smooth, living stroke
// through them (centripetal Catmull-Rom; a duplicated point makes a
// sharp corner). Points lie ON the line, so the model's spatial
// reasoning holds — no melted control-point errors — and the renderer
// feeds perfect-freehand directly for pressure-varied ink.

import { getStroke } from "perfect-freehand";
import simplify from "simplify-js";

export interface Stroke {
  role?: string;
  c?: string; // ink colour
  w?: number; // nib width
  o?: number; // lightness: far things fade toward 0.5
  close?: boolean; // join end back to start
  pts: [number, number][];
}

export interface StrokesDoc {
  plan?: string;
  strokes: Stroke[];
}

const INKS = new Set(["#241a10", "#2c3a57"]);
export const MAX_STROKES = 90; // a rich plate: contours, then hatching
const MAX_PTS = 80;

/** One inked stroke, realised: outline path data plus its ink. These
 *  are OUR numbers pulled through OUR renderer — trusted by
 *  construction, safe to hand straight to the page. */
export interface InkedPath {
  d: string;
  fill: string;
  o: number;
}

/** One NDJSON line from the streaming hand → a stroke, or null.
 *  Fences, trailing commas and prose are shed; nothing is fatal. */
export function parseStrokeLine(line: string): Stroke | null {
  let t = line.trim();
  if (!t || t.startsWith("```")) return null;
  t = t.replace(/,\s*$/, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const s = JSON.parse(t.slice(a, b + 1)) as Stroke;
    if (s && Array.isArray(s.pts)) return s;
  } catch {
    // a partial or non-stroke line; the stream will bring more
  }
  return null;
}

/** Tolerant parse of a whole reply: the stroke-per-line contract first,
 *  falling back to the older {"plan","strokes"} envelope. */
export function parseStrokes(text: string): StrokesDoc | null {
  const lines = text
    .split("\n")
    .map(parseStrokeLine)
    .filter((s): s is Stroke => !!s);
  if (lines.length > 0) return { strokes: lines };
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  const strokes = (doc as StrokesDoc)?.strokes;
  if (!Array.isArray(strokes) || strokes.length === 0) return null;
  return doc as StrokesDoc;
}

// ——— centripetal Catmull-Rom sampling ———

type Pt = [number, number];

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerpP = (a: Pt, b: Pt, t: number): Pt => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

function crSegment(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number, out: Pt[]) {
  const alpha = 0.5;
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-6), alpha);
  const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-6), alpha);
  const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-6), alpha);
  for (let i = 0; i < n; i++) {
    const t = t1 + ((t2 - t1) * i) / n;
    const a1 = lerpP(p0, p1, (t - t0) / (t1 - t0 || 1));
    const a2 = lerpP(p1, p2, (t - t1) / (t2 - t1 || 1));
    const a3 = lerpP(p2, p3, (t - t2) / (t3 - t2 || 1));
    const b1 = lerpP(a1, a2, (t - t0) / (t2 - t0 || 1));
    const b2 = lerpP(a2, a3, (t - t1) / (t3 - t1 || 1));
    out.push(lerpP(b1, b2, (t - t1) / (t2 - t1 || 1)));
  }
}

/** Split at duplicated points (sharp corners), CR-sample each run. */
function smoothPolyline(pts: Pt[], close: boolean): Pt[] {
  const runs: Pt[][] = [[]];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (run.length && dist(run[run.length - 1], p) < 0.75) {
      if (run.length > 1) runs.push([p]); // corner: break the spline here
      continue;
    }
    run.push(p);
  }
  const dense: Pt[] = [];
  for (const run of runs.filter((r) => r.length >= 2)) {
    const ext =
      close && runs.length === 1
        ? [run[run.length - 1], ...run, run[0], run[1]]
        : [run[0], ...run, run[run.length - 1]];
    for (let i = 1; i + 2 < ext.length; i++) {
      const n = Math.max(3, Math.ceil(dist(ext[i], ext[i + 1]) / 2.5));
      crSegment(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], n, dense);
    }
    dense.push(run[run.length - 1]);
  }
  if (close && dense.length) dense.push(dense[0]);
  return dense;
}

// ——— the ink pass (constants shared with lib/inkify.ts) ———

function outlineToPath(points: number[][]): string {
  if (points.length < 4) return "";
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)} Q`;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    d += ` ${a[0].toFixed(1)} ${a[1].toFixed(1)} ${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)}`;
  }
  return d + " Z";
}

function inkStroke(dense: Pt[], width: number): string {
  if (dense.length < 3) return "";
  let len = 0;
  for (let i = 1; i < dense.length; i++) len += dist(dense[i - 1], dense[i]);
  const input = dense.map((p, i) => {
    let pressure = 0.5;
    if (i > 0 && i < dense.length - 1) {
      const a = dense[i - 1];
      const c = dense[i + 1];
      const v1 = Math.atan2(p[1] - a[1], p[0] - a[0]);
      const v2 = Math.atan2(c[1] - p[1], c[0] - p[0]);
      let turn = Math.abs(v2 - v1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const curve = Math.min(1, turn * 5);
      const drift = 0.12 * Math.sin(i * 0.09) + 0.08 * Math.sin(i * 0.023 + 2);
      pressure = 0.45 + 0.35 * curve + drift;
    }
    return [p[0], p[1], Math.max(0.15, Math.min(1, pressure))];
  });
  const outline = getStroke(input, {
    size: width * 2.1,
    thinning: 0.65,
    smoothing: 0.55,
    streamline: 0.35,
    simulatePressure: false,
    easing: (t) => t,
    start: { taper: Math.min(40, len * 0.08), cap: true },
    end: { taper: Math.min(60, len * 0.12), cap: true },
    last: true,
  });
  const slim = simplify(
    outline.map(([x, y]) => ({ x, y })),
    0.45,
    true,
  ).map((p) => [p.x, p.y]);
  return outlineToPath(slim);
}

/** Realise ONE stroke: validate, tame wild values, smooth, ink. Null
 *  when there is nothing drawable in it. */
export function renderStroke(s: Stroke): InkedPath | null {
  const pts = (Array.isArray(s.pts) ? s.pts : [])
    .filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
    .slice(0, MAX_PTS)
    .map((p): Pt => [
      Math.max(-80, Math.min(880, p[0])),
      Math.max(-80, Math.min(640, p[1])),
    ]);
  if (pts.length < 2) return null;
  const fill = INKS.has((s.c || "").toLowerCase()) ? (s.c as string) : "#241a10";
  const w = Math.min(3.5, Math.max(1, Number(s.w) || 3)); // hatching runs thin
  const o = Math.min(1, Math.max(0.3, Number(s.o) || 1));
  const d = inkStroke(smoothPolyline(pts, !!s.close), w);
  return d ? { d, fill, o } : null;
}

const pathTag = (p: InkedPath) =>
  `<path d="${p.d}" fill="${p.fill}"${p.o < 1 ? ` fill-opacity="${p.o.toFixed(2)}"` : ""} stroke="none"/>`;

/** Wrap inked paths as a complete drawing. */
export function pathsToSvg(paths: InkedPath[]): string | null {
  if (!paths.length) return null;
  return `<svg viewBox="0 0 800 560" xmlns="http://www.w3.org/2000/svg">${paths.map(pathTag).join("")}</svg>`;
}

/** Realise a strokes document as inked SVG, or null when nothing in it
 *  can be drawn. Wild values are tamed, never fatal. */
export function strokesToSvg(doc: StrokesDoc): string | null {
  const paths: InkedPath[] = [];
  for (const s of doc.strokes.slice(0, MAX_STROKES)) {
    const p = renderStroke(s);
    if (p) paths.push(p);
  }
  return pathsToSvg(paths);
}
