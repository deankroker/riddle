// The inking of the line. The hand composes centerline Bézier paths —
// the syntax it is most fluent in — and this pass makes the ink real:
// each stroked path is sampled by arc length, given synthesized pressure
// (curves press harder, straights glide, ends taper, a slow drift of the
// wrist throughout), outlined as a variable-width stroke, thinned, and
// emitted as a filled path. Uniform plotter lines in; loaded nib out.
//
// Constants tuned in the research prototype (scratchpad inklab).

import { svgPathProperties } from "svg-path-properties";
import { getStroke } from "perfect-freehand";
import simplify from "simplify-js";

const PATH_RE = /<path\b[^>]*\/?>/g;

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** Outline points → smooth closed path (quadratic midpoints — the
 *  canonical perfect-freehand serialization). */
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

function inkifyPath(d: string, color: string, width: number, opacity: number): string | null {
  const props = new svgPathProperties(d);
  const len = props.getTotalLength();
  if (!isFinite(len) || len < 4) return null;
  const step = Math.max(2.5, len / 450); // cap sample count
  const pts: { x: number; y: number }[] = [];
  for (let s = 0; s <= len; s += step) pts.push(props.getPointAtLength(s));
  // pressure per sample: turning angle presses, straights glide,
  // plus a slow sinusoidal drift of the wrist
  const input = pts.map((p, i) => {
    let pressure = 0.5;
    if (i > 0 && i < pts.length - 1) {
      const a = pts[i - 1];
      const c = pts[i + 1];
      const v1 = Math.atan2(p.y - a.y, p.x - a.x);
      const v2 = Math.atan2(c.y - p.y, c.x - p.x);
      let turn = Math.abs(v2 - v1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const curve = Math.min(1, turn * 5);
      const drift = 0.12 * Math.sin(i * 0.09) + 0.08 * Math.sin(i * 0.023 + 2);
      pressure = 0.45 + 0.35 * curve + drift;
    }
    return [p.x, p.y, Math.max(0.15, Math.min(1, pressure))];
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
  const path = outlineToPath(slim);
  if (!path) return null;
  const o = opacity < 1 ? ` fill-opacity="${opacity.toFixed(2)}"` : "";
  return `<path d="${path}" fill="${color}"${o} stroke="none"/>`;
}

/** Re-ink every stroked path in an SVG; washes and everything else pass
 *  through untouched. Throws nothing: a path that resists keeps its
 *  centerline. */
export function inkify(svg: string): string {
  return svg.replace(PATH_RE, (tag) => {
    const d = attr(tag, "d");
    const stroke = attr(tag, "stroke");
    if (!d || !stroke || stroke === "none") return tag; // washes pass through
    const width = parseFloat(attr(tag, "stroke-width") || "3");
    // a light line stays light: stroke-opacity rides into the fill
    const opacity = Math.min(1, Math.max(0.2, parseFloat(attr(tag, "stroke-opacity") || "1")));
    try {
      return inkifyPath(d, stroke, width, opacity) ?? tag;
    } catch {
      return tag;
    }
  });
}
