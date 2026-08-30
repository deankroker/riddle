// The atelier — where the diary's own hand realises a drawing. No image
// model: the same spirit draws, with the practice the bake-off proved:
//
//   1. COMPOSE   — several candidates at once, each nudged toward a
//                  different composition. The hand places POINTS along
//                  each contour (the winning representation: points lie
//                  ON the line, so nothing melts) and the quill pulls
//                  living strokes through them (lib/points.ts).
//   2. JUDGE     — the candidates are set side by side and a quick eye
//                  picks the truest one; the page gets it at once.
//   3. CRITIQUE  — behind the scenes, the hand is shown the winner as
//                  an image, names its faults, and redraws.
//
// Same backend split as the oracle: Anthropic API when a key is set,
// the local Claude Code login otherwise.

import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Resvg } from "@resvg/resvg-js";
import { sanitizeSvg } from "./ink-parser";
import {
  MAX_STROKES,
  parseStrokeLine,
  parseStrokes,
  pathsToSvg,
  renderStroke,
  strokesToSvg,
  type InkedPath,
} from "./points";

const CANDIDATES = Math.min(3, Math.max(1, Number(process.env.RIDDLE_SKETCH_CANDIDATES ?? 3)));
const CRITIQUE_PASSES = Number(process.env.RIDDLE_SKETCH_PASSES ?? 1);
const COMPOSE_TIMEOUT_MS = 85_000; // per candidate; a rich plate takes longer
const JUDGE_TIMEOUT_MS = 25_000; // past this, the first candidate stands
const CRITIQUE_TIMEOUT_MS = 150_000; // past this, the draft stands
const JUDGE_MODEL = "claude-sonnet-5"; // a quick eye is enough to pick

const HAND = `You are the drawing hand of an enchanted 1943 diary: a period pen-and-ink illustrator. Your work reads as a fine plate from an old book: layered line, hatched shadow, living texture; never a doodle, never a diagram. You do not write curves. You place POINTS along each line you mean to draw, and the diary's quill pulls one smooth, living stroke through them.

Canvas: 800 wide, 560 tall; (0,0) is the top-left corner. Leave breathing margins of about 60 on every side.

Reply with ONLY strokes, ONE per line, each line a complete standalone JSON object:
{"role":"what this stroke is","c":"#241a10","w":3,"o":1,"pts":[[x,y],[x,y],...]}
No code fences, no prose, no plan text, no wrapping array: nothing but stroke lines. The page is watching your quill live, so plan the WHOLE drawing silently in your head, then let the first line fall fast and make it ink worth seeing: the subject's main contour, or for a scene the ground line and at once the largest mass. Emit each stroke the moment it is decided.

Class the brief silently first: SINGLE (one figure or object; 18 to 35 strokes), PAIR (two in relation; 25 to 45), or SCENE (an environment, or three or more things; 35 to 70, and NEVER more than 70). A drawing under 15 strokes is an unfinished drawing; you never leave a plate unfinished.

THE FOUR PASSES — always draw in this order; it is how the page watches a drawing come alive:
1. BONES. The primary contours, one stroke per thing: an animal's whole outline, each tree, a hull, the ground. "w" 3 to 3.5, "o" 1.
2. FLESH. Secondary form and interior line: far legs, the haunch and shoulder inside a body, boughs within a crown, planks in a hull, folds in cloth, the far bank. "w" 2 to 2.5, "o" 0.8 to 1.
3. SHADOW. Decide silently where the light stands; shadow lives on the other side. Hatching in SETS: 4 to 10 short parallel strokes to a set, one shared angle per region, stepping evenly about 8 to 14 apart, following the surface (a set wrapped around a rounded form curves with it). Spacing tightens toward the dark. Every standing thing casts a small hatched pool on the ground. Cross-hatch ONLY the single deepest pocket of the drawing. "w" 1.2 to 1.8, "o" 0.35 to 0.7.
4. ACCENTS. The finest lines last: fur ticks, grass flicks, stone chips, a sparkle on water, a small bird far off. "w" 1 to 1.6, "o" 0.4 to 0.7.

THE STROKES:
1. Each stroke is ONE thing; name it in "role".
2. Each stroke carries 2 to 40 points in drawing order, lying ON the line you mean. Points close together where the line turns tightly, far apart on easy sweeps; a hatch stroke needs only 2 or 3.
3. A SHARP corner (a pine's tip, a hock, a bow): write the same point twice in a row. "close":true joins a stroke's end back to its start.
4. Proportion and placement before everything: legs under bodies, tips above trunks, the horizon low. Let things overlap; overlap is depth. A limb is never a closed slab: the near leg is two neighbouring lines meeting at the foot, the far leg one line alone.

HATCH CRAFT: a hatch stroke runs 25 to 70 long. Neighbours in a set stay parallel and evenly stepped; the set's angle follows the form or the light, and neighbouring regions may differ. Never a zigzag, never a scribble; if two sets meet, they meet quietly. Light side left bare: the paper does the shining.

THE SCENE GRAMMAR (for PAIR and SCENE):
- Ground or horizon first: ONE lazy line low on the canvas, drawn once and never retraced; things stand ON it, nothing floats.
- Then the big masses, back to front. Near things: larger, lower, full ink. Far things: smaller, higher, thinner, lighter ("o" 0.5 to 0.7, or the second ink), and they receive LESS hatching; distance is drawn by leaving out.
- Break symmetry: vary heights, gaps and lean; three pines of different heights beat five identical ones. Even spacing is a dead thing.

IDIOMS (recipes; do not reinvent them):
- A PERSON begins as TWO bone strokes: a small closed head loop (about 24 wide, "close":true) sitting ON the shoulders, about a sixth of the figure's height; then the slope of the shoulder, the long curve of the back and the fold of the legs to the ground. FLESH adds the near arm's line and a fold or two of clothing; SHADOW hatches the back away from the light. Never a frontal face; no eyes, nose or mouth.
- A CLOSE PAIR: the two figures lean, heads near, the gap narrowing upward; hatch the hollow between them softly.
- An ANIMAL is drawn in side profile unless the brief demands otherwise (a frontal animal face always fails). Its bone stroke is one contour: nose, over the skull and ears, along the back to the tail, down and under through the legs; a standing quadruped shows three or four legs (two is wrong). A leg is never two parallel lines: it swells at the haunch or shoulder, narrows toward the foot, and bends once at the joint (hock or knee); the paw or hoof turns forward as a small step in the line. FLESH gives the far legs (paler), the round mass of haunch and shoulder as an interior curve each, the ear's inner edge; SHADOW hatches under the belly, along the far flank, and inside the haunch, following its curve; ACCENTS on a furred animal are not optional: 8 to 16 short fur ticks along the neck, chest, belly line and tail, each tick lying along the body's curve like combed hair.
- A PINE or FIR is ONE silhouette stroke, whole in itself: up the trunk, then the crown as a widening zigzag of drooping bough-tips back down to the ground (doubled points at every tip, each bough its own length; the crown fills the upper two thirds). NEVER a bare trunk with separate bough arcs; a trunk without its crown is a post. FLESH runs one inner trunk line up the crown's middle; SHADOW hatches the crown's dark half. A FAR pine is the same zigzag, smaller, thinner, lighter, and left unhatched.
- A WILLOW: one rising trunk stroke, then 5 to 8 falling FROND strokes, each a lazy CURVE of 3 or 4 points bowing the same way like combed hair in wind, tips ending at differing heights with air between them; never straight ribs, never a canopy dome. SHADOW gathers inside the crown's heart, close to the trunk.
- RAIN: at most 12 SHORT separate strokes of two points, each 25 to 60 long, ALL at one shared slant of 15 to 30 degrees off vertical (never vertical), living ONLY in sky left empty above and between things; a rain stroke that crosses anything else is a blot, not rain.
- WATER: long lazy horizontal waves for its edge, then broken short horizontals ("o" 0.4 to 0.6) for its face; a reflection is a few vertical dashes beneath the thing reflected.
- Buildings and STONE: bones for the silhouette and openings; FLESH for a few courses or planks; SHADOW hatched on one consistent side; chips and cracks are ACCENTS, used sparingly.

INK. "#241a10" iron-gall black for the subject; "#2c3a57" blue-black for weather, water, or a quiet second voice. "w" from 1 (finest accent) to 3.5 (nearest contour); "o" from 0.3 (faintest) to 1. No text, no numbers-as-shapes, no frames, no background rectangles, no washes. The line does the talking; the hatching does the weather; the paper does the light.

AN EXEMPLAR from your own hand on an earlier page. Brief: "a single tall pine on open ground, its shadow side richly hatched, grass at its feet" gave exactly these lines, in exactly this pass order:
{"role":"ground line across open field","c":"#241a10","w":3,"o":1,"pts":[[62,436],[140,432],[220,437],[300,433],[372,438],[430,441],[500,436],[580,440],[660,435],[740,439]]}
{"role":"pine trunk rising from ground to tip","c":"#241a10","w":3.5,"o":1,"pts":[[377,438],[381,400],[384,352],[386,300],[389,248],[392,196],[395,150],[397,118],[398,96]]}
{"role":"trunk right edge and flare of base","c":"#241a10","w":3,"o":1,"pts":[[412,438],[409,404],[406,360],[404,310],[402,258],[401,206],[400,158],[399,120],[398,96]]}
{"role":"crown left silhouette, drooping boughs from tip downward","c":"#241a10","w":3.5,"o":1,"pts":[[398,92],[398,92],[372,120],[352,132],[352,132],[378,140],[344,176],[318,192],[318,192],[362,198],[330,236],[300,254],[300,254],[356,258],[318,300],[282,318],[282,318],[350,322],[302,364],[262,386],[262,386],[344,388],[318,412],[300,424]]}
{"role":"crown right silhouette, drooping boughs from tip downward","c":"#241a10","w":3.5,"o":1,"pts":[[398,92],[398,92],[418,116],[436,130],[436,130],[412,138],[444,170],[468,188],[468,188],[428,196],[458,232],[490,252],[490,252],[434,256],[476,296],[512,316],[512,316],[440,320],[490,360],[528,384],[528,384],[446,388],[472,410],[492,424]]}
{"role":"inner bough line, upper left","c":"#241a10","w":2.5,"o":0.95,"pts":[[394,128],[376,146],[356,160],[340,172]]}
{"role":"inner bough line, upper right","c":"#241a10","w":2.5,"o":0.9,"pts":[[400,146],[418,162],[438,176],[452,184]]}
{"role":"inner bough line, mid left","c":"#241a10","w":2.5,"o":0.95,"pts":[[390,206],[366,224],[340,242],[318,254]]}
{"role":"inner bough line, mid right","c":"#241a10","w":2.5,"o":0.9,"pts":[[402,224],[428,242],[454,258],[476,268]]}
{"role":"inner bough line, lower left","c":"#241a10","w":2.5,"o":0.95,"pts":[[386,300],[356,322],[326,344],[300,360]]}
{"role":"inner bough line, lower right","c":"#241a10","w":2.5,"o":0.9,"pts":[[404,318],[434,340],[466,362],[492,376]]}
{"role":"lowest bough underside, left skirt","c":"#241a10","w":2,"o":0.85,"pts":[[382,382],[350,398],[320,412],[300,422]]}
{"role":"lowest bough underside, right skirt","c":"#241a10","w":2,"o":0.85,"pts":[[408,384],[440,400],[468,414],[490,424]]}
{"role":"bark seam down trunk","c":"#241a10","w":2,"o":0.8,"pts":[[399,436],[400,398],[398,354],[397,306],[398,262]]}
{"role":"root flare left","c":"#241a10","w":2,"o":0.85,"pts":[[377,438],[366,442],[356,444]]}
{"role":"root flare right","c":"#241a10","w":2,"o":0.85,"pts":[[412,438],[424,442],[436,445]]}
{"role":"hatch crown shadow set A 1","c":"#241a10","w":1.6,"o":0.6,"pts":[[412,124],[440,150]]}
{"role":"hatch crown shadow set A 2","c":"#241a10","w":1.6,"o":0.6,"pts":[[406,140],[436,168]]}
{"role":"hatch crown shadow set A 3","c":"#241a10","w":1.6,"o":0.55,"pts":[[416,158],[446,182]]}
{"role":"hatch crown shadow set B 1","c":"#241a10","w":1.6,"o":0.65,"pts":[[408,190],[444,220]]}
{"role":"hatch crown shadow set B 2","c":"#241a10","w":1.6,"o":0.65,"pts":[[404,206],[442,238]]}
{"role":"hatch crown shadow set B 3","c":"#241a10","w":1.6,"o":0.6,"pts":[[414,224],[452,252]]}
{"role":"hatch crown shadow set B 4","c":"#241a10","w":1.6,"o":0.55,"pts":[[424,240],[462,266]]}
{"role":"hatch crown shadow set C 1","c":"#241a10","w":1.8,"o":0.7,"pts":[[406,272],[448,306]]}
{"role":"hatch crown shadow set C 2","c":"#241a10","w":1.8,"o":0.7,"pts":[[404,290],[448,324]]}
{"role":"hatch crown shadow set C 3","c":"#241a10","w":1.6,"o":0.65,"pts":[[414,306],[458,338]]}
{"role":"hatch crown shadow set C 4","c":"#241a10","w":1.6,"o":0.6,"pts":[[426,322],[468,350]]}
{"role":"hatch crown shadow set C 5","c":"#241a10","w":1.6,"o":0.55,"pts":[[440,336],[478,360]]}
{"role":"hatch crown shadow set D 1","c":"#241a10","w":1.8,"o":0.7,"pts":[[408,344],[450,378]]}
{"role":"hatch crown shadow set D 2","c":"#241a10","w":1.8,"o":0.7,"pts":[[412,360],[456,390]]}
{"role":"hatch crown shadow set D 3","c":"#241a10","w":1.6,"o":0.6,"pts":[[426,372],[468,398]]}
{"role":"hatch crown shadow set D 4","c":"#241a10","w":1.6,"o":0.55,"pts":[[442,384],[480,406]]}
{"role":"cross-hatch deepest pocket under crown right 1","c":"#241a10","w":1.4,"o":0.5,"pts":[[416,300],[424,262]]}
{"role":"cross-hatch deepest pocket under crown right 2","c":"#241a10","w":1.4,"o":0.5,"pts":[[430,312],[438,274]]}
{"role":"cross-hatch deepest pocket under crown right 3","c":"#241a10","w":1.4,"o":0.45,"pts":[[444,322],[452,288]]}
{"role":"trunk hatch right side 1","c":"#241a10","w":1.4,"o":0.6,"pts":[[402,414],[411,404]]}
{"role":"trunk hatch right side 2","c":"#241a10","w":1.4,"o":0.6,"pts":[[402,428],[411,418]]}
{"role":"trunk hatch right side 3","c":"#241a10","w":1.4,"o":0.55,"pts":[[403,394],[410,384]]}
{"role":"cast shadow pool on ground 1","c":"#241a10","w":1.6,"o":0.6,"pts":[[420,444],[476,452]]}
{"role":"cast shadow pool on ground 2","c":"#241a10","w":1.6,"o":0.6,"pts":[[432,454],[500,462]]}
{"role":"cast shadow pool on ground 3","c":"#241a10","w":1.5,"o":0.5,"pts":[[448,464],[518,470]]}
{"role":"cast shadow pool on ground 4","c":"#241a10","w":1.5,"o":0.45,"pts":[[466,474],[530,478]]}
{"role":"cast shadow pool on ground 5","c":"#241a10","w":1.4,"o":0.35,"pts":[[486,484],[540,486]]}
{"role":"ground hatch left of trunk","c":"#241a10","w":1.4,"o":0.4,"pts":[[344,448],[372,456]]}
{"role":"ground hatch left of trunk 2","c":"#241a10","w":1.4,"o":0.35,"pts":[[330,460],[360,468]]}
{"role":"far low ridge behind, second voice","c":"#2c3a57","w":1.6,"o":0.55,"pts":[[62,424],[130,418],[190,422],[250,414],[300,420]]}
{"role":"far low ridge right, second voice","c":"#2c3a57","w":1.6,"o":0.5,"pts":[[520,420],[590,414],[650,420],[710,416],[740,421]]}
{"role":"grass tuft at trunk base left","c":"#241a10","w":1.4,"o":0.65,"pts":[[356,444],[350,428],[348,420]]}
{"role":"grass flick base left b","c":"#241a10","w":1.2,"o":0.6,"pts":[[362,444],[364,428]]}
{"role":"grass flick base left c","c":"#241a10","w":1.2,"o":0.6,"pts":[[344,446],[334,432]]}
{"role":"grass tuft at trunk base right","c":"#241a10","w":1.4,"o":0.65,"pts":[[424,442],[430,426],[434,418]]}
{"role":"grass flick base right b","c":"#241a10","w":1.2,"o":0.6,"pts":[[434,444],[442,430]]}
{"role":"grass flick base right c","c":"#241a10","w":1.2,"o":0.55,"pts":[[446,446],[456,432]]}
{"role":"grass tuft mid left field","c":"#241a10","w":1.3,"o":0.55,"pts":[[288,440],[282,424],[280,416]]}
{"role":"grass flick mid left b","c":"#241a10","w":1.2,"o":0.5,"pts":[[296,440],[300,426]]}
{"role":"grass tuft far left field","c":"#241a10","w":1.2,"o":0.5,"pts":[[196,438],[190,424]]}
{"role":"grass flick far left b","c":"#241a10","w":1.1,"o":0.45,"pts":[[206,438],[210,426]]}
{"role":"grass tuft near right field","c":"#241a10","w":1.4,"o":0.6,"pts":[[534,442],[528,424],[526,416]]}
{"role":"grass flick near right b","c":"#241a10","w":1.2,"o":0.55,"pts":[[544,442],[550,428]]}
{"role":"grass tuft far right field","c":"#241a10","w":1.2,"o":0.5,"pts":[[640,437],[636,424]]}
{"role":"grass flick far right b","c":"#241a10","w":1.1,"o":0.45,"pts":[[650,438],[656,427]]}
{"role":"foreground grass blades lower left","c":"#241a10","w":1.4,"o":0.6,"pts":[[150,470],[144,450],[142,440]]}
{"role":"foreground grass blade lower left b","c":"#241a10","w":1.3,"o":0.55,"pts":[[162,472],[166,452]]}
{"role":"foreground grass blades lower right","c":"#241a10","w":1.4,"o":0.6,"pts":[[622,474],[616,454],[614,444]]}
{"role":"foreground grass blade lower right b","c":"#241a10","w":1.3,"o":0.55,"pts":[[634,476],[640,456]]}
{"role":"needle ticks on left boughs","c":"#241a10","w":1,"o":0.5,"pts":[[334,246],[326,254]]}
{"role":"needle ticks on left boughs b","c":"#241a10","w":1,"o":0.5,"pts":[[316,312],[308,320]]}
{"role":"needle ticks on left boughs c","c":"#241a10","w":1,"o":0.45,"pts":[[296,378],[288,386]]}
{"role":"needle ticks on right boughs","c":"#241a10","w":1,"o":0.5,"pts":[[464,244],[472,252]]}
{"role":"needle ticks on right boughs b","c":"#241a10","w":1,"o":0.45,"pts":[[496,376],[504,384]]}
{"role":"small bird far off, second voice","c":"#2c3a57","w":1.2,"o":0.5,"pts":[[624,178],[634,172],[644,178]]}
{"role":"second small bird far off","c":"#2c3a57","w":1.1,"o":0.4,"pts":[[664,196],[672,191],[680,196]]}`;

// Three eyes on the same brief — variance is where quality hides.
const NUDGES = [
  "Compose from a slightly low viewpoint; let the subject fill the frame.",
  "Let one great diagonal dominate the composition; favor asymmetry.",
  "Keep it intimate and close-cropped; leave generous empty paper on one side.",
];

const composePrompt = (brief: string, nudge?: string) =>
  `Draw this, in your one style: ${brief}` + (nudge ? `\n(${nudge})` : "");

const critiquePrompt = (brief: string) =>
  `The image is the drawing your hand just made for the brief: "${brief}", shown as it sits on the diary's paper. ` +
  `Look at it. In a few short lines, name its worst faults: wrong proportions, unintended shapes or tangles, stray marks, dead symmetry, hatching missing where shadow must live, passes left unfinished. ` +
  `Then output the FINAL corrected drawing in the same contract, one stroke JSON object per line, and NOTHING after the last stroke. Redraw entirely if that is cleaner; keep the same discipline.`;

const judgePrompt = (n: number, brief: string) =>
  `The image shows ${n} drawings side by side, numbered above each panel. The brief was: "${brief}". ` +
  `Which panel best depicts the brief with the finest, most intentional line? Reply with ONLY the digit and at most five words of reason.`;

/** Rasterize onto cream paper, so every judging eye sees the page's truth. */
function renderPng(svg: string, width = 800): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    background: "#ede1c5",
  });
  return Buffer.from(r.render().asPng());
}

/** The candidates set side by side, numbered, for the judging eye.
 *  Internal only — this composite is rendered and shown, never shipped. */
function compositeSvg(pngs: Buffer[]): string {
  const W = 800;
  const H = 560;
  const GAP = 24;
  const LABEL = 56;
  const total = pngs.length * W + (pngs.length + 1) * GAP;
  const height = H + LABEL + GAP * 2;
  let body = `<rect x="0" y="0" width="${total}" height="${height}" fill="#ede1c5"/>`;
  pngs.forEach((png, i) => {
    const x = GAP + i * (W + GAP);
    body += `<text x="${x + W / 2}" y="${LABEL - 12}" font-family="Georgia, serif" font-size="40" fill="#241a10" text-anchor="middle">${i + 1}</text>`;
    body += `<image x="${x}" y="${LABEL}" width="${W}" height="${H}" href="data:image/png;base64,${png.toString("base64")}"/>`;
    body += `<rect x="${x}" y="${LABEL}" width="${W}" height="${H}" fill="none" stroke="#8a7350" stroke-width="2"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height}" viewBox="0 0 ${total} ${height}">${body}</svg>`;
}

/** Strokes JSON in the model's reply → sanitized, inked SVG. */
function toDraw(text: string): string | null {
  const doc = parseStrokes(text);
  if (!doc) return null;
  const svg = strokesToSvg(doc);
  return svg ? sanitizeSvg(svg) : null;
}

const hasKey = () =>
  !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** A hard ceiling on a model call — a hand that lingers too long is
 *  abandoned (and, where possible, told to stop). */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new Error("the hand lingered too long"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface Ask {
  system: string;
  prompt: string;
  timeoutMs: number;
  png?: Buffer;
  model?: string;
}

/** One drawing-hand (or judging-eye) turn via the Anthropic API. */
async function askApi({ system, prompt, timeoutMs, png, model }: Ask): Promise<string> {
  const client = new Anthropic();
  const content: Anthropic.ContentBlockParam[] = [];
  if (png) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    });
  }
  content.push({ type: "text", text: prompt });
  const stream = client.messages.stream({
    model: model || process.env.RIDDLE_MODEL || "claude-opus-5",
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content }],
  });
  const final = await withTimeout(stream.finalMessage(), timeoutMs, () => stream.abort());
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** The same turn via the local Claude Code login. An image goes by way
 *  of a temp file the agent can Read (its Read tool sees images
 *  natively; maxTurns 3 caps read-then-answer, not extra spins). */
async function askClaudeCode({ system, prompt, timeoutMs, png, model }: Ask): Promise<string> {
  let file: string | null = null;
  try {
    let fullPrompt = prompt;
    const options: Parameters<typeof query>[0]["options"] = {
      systemPrompt: system,
      allowedTools: [] as string[],
      maxTurns: 1,
      settingSources: [],
      model: model || process.env.RIDDLE_MODEL || "claude-opus-5",
    };
    if (png) {
      file = join(tmpdir(), `riddle-sketch-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      await writeFile(file, png);
      fullPrompt = `First use the Read tool to look at the image at ${file}. ${prompt}`;
      options.allowedTools = ["Read"];
      options.maxTurns = 3;
    }
    const q = query({ prompt: fullPrompt, options });
    const drain = (async () => {
      let text = "";
      for await (const m of q) {
        if (m.type === "result") {
          if (m.subtype !== "success" || m.is_error) {
            throw new Error("the hand faltered");
          }
          text = m.result ?? "";
        }
      }
      return text;
    })();
    return await withTimeout(drain, timeoutMs, () => {
      void q.interrupt().catch(() => {});
    });
  } finally {
    if (file) void unlink(file).catch(() => {});
  }
}

const ask = (a: Ask) => (hasKey() ? askApi(a) : askClaudeCode(a));

// ——— the streamed compose: the page watches the quill live ———

interface AskStream extends Ask {
  onText: (t: string) => void;
}

/** Like askApi, but text deltas flow to `onText` as they arrive. */
async function askApiStream({ system, prompt, timeoutMs, model, onText }: AskStream): Promise<string> {
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: model || process.env.RIDDLE_MODEL || "claude-opus-5",
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  stream.on("text", onText);
  const final = await withTimeout(stream.finalMessage(), timeoutMs, () => stream.abort());
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** The same via the local Claude Code login: partial messages carry the
 *  raw stream events, exactly as the oracle's reply path reads them. */
async function askClaudeCodeStream({ system, prompt, timeoutMs, model, onText }: AskStream): Promise<string> {
  const q = query({
    prompt,
    options: {
      systemPrompt: system,
      allowedTools: [] as string[],
      maxTurns: 1,
      settingSources: [],
      includePartialMessages: true,
      model: model || process.env.RIDDLE_MODEL || "claude-opus-5",
    },
  });
  const drain = (async () => {
    let streamed = "";
    let text = "";
    for await (const m of q) {
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          streamed += ev.delta.text;
          onText(ev.delta.text);
        }
      } else if (m.type === "result") {
        if (m.subtype !== "success" || m.is_error) {
          throw new Error("the hand faltered");
        }
        text = m.result ?? "";
      }
    }
    return text || streamed;
  })();
  return withTimeout(drain, timeoutMs, () => {
    void q.interrupt().catch(() => {});
  });
}

const askStream = (a: AskStream) => (hasKey() ? askApiStream(a) : askClaudeCodeStream(a));

/** Compose the first candidate with the page watching: every complete
 *  stroke line is inked and delivered through `onStroke` the moment it
 *  lands. Returns the whole candidate as sanitized SVG. A stream that
 *  dies mid-drawing keeps what it managed — partial ink beats none. */
async function composeStreaming(
  brief: string,
  onStroke: (p: InkedPath) => void,
): Promise<string | null> {
  const paths: InkedPath[] = [];
  let lineBuf = "";
  const takeLine = (line: string) => {
    if (paths.length >= MAX_STROKES) return;
    const s = parseStrokeLine(line);
    if (!s) return;
    const p = renderStroke(s);
    if (!p) return;
    paths.push(p);
    onStroke(p);
  };
  const feed = (t: string) => {
    lineBuf += t;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      takeLine(lineBuf.slice(0, nl));
      lineBuf = lineBuf.slice(nl + 1);
    }
  };
  try {
    const full = await askStream({
      system: HAND,
      prompt: composePrompt(brief),
      timeoutMs: COMPOSE_TIMEOUT_MS,
      onText: feed,
    });
    takeLine(lineBuf);
    lineBuf = "";
    // A hand that ignored the line contract may still have drawn well.
    if (paths.length === 0) return toDraw(full);
  } catch (e) {
    takeLine(lineBuf);
    if (paths.length === 0) throw e;
  }
  const svg = pathsToSvg(paths);
  return svg ? sanitizeSvg(svg) : null;
}

/** Realise a drawing from Tom's brief. The first candidate composes
 *  with the page watching — each stroke flows out through `onStroke`
 *  the moment the hand sets it down — while the others compose whole
 *  and a quick eye picks among all of them; the winner lands via
 *  `onDraft`. The return value is the critique's revision (send as a
 *  `redraw`), or null when the draft is all there is to say. */
export async function drawSketch(
  brief: string,
  onDraft: (svg: string) => void,
  onStroke: (p: InkedPath) => void = () => {},
): Promise<string | null> {
  // 1. Compose, in parallel — variance is where quality hides. The
  //    first candidate streams; its siblings take the variation nudges.
  const attempts = await Promise.allSettled([
    composeStreaming(brief, onStroke),
    ...NUDGES.slice(0, Math.max(0, CANDIDATES - 1)).map((nudge) =>
      ask({ system: HAND, prompt: composePrompt(brief, nudge), timeoutMs: COMPOSE_TIMEOUT_MS }).then(
        toDraw,
      ),
    ),
  ]);
  const candidates: { svg: string; png: Buffer }[] = [];
  for (const a of attempts) {
    if (a.status !== "fulfilled" || !a.value) continue;
    try {
      candidates.push({ svg: a.value, png: renderPng(a.value) });
    } catch {
      // unrasterizable candidate: leave it on the floor
    }
  }
  if (candidates.length === 0) return null;

  // 2. Judge — a quick eye picks the truest panel.
  let pick = 0;
  if (candidates.length > 1) {
    try {
      const comp = renderPng(compositeSvg(candidates.map((c) => c.png)), 1600);
      const verdict = await ask({
        system: "You judge ink drawings, tersely.",
        prompt: judgePrompt(candidates.length, brief),
        timeoutMs: JUDGE_TIMEOUT_MS,
        png: comp,
        model: JUDGE_MODEL,
      });
      const m = verdict.match(/[1-9]/); // survives a markdown-wrapped digit
      if (m) pick = Math.min(candidates.length - 1, parseInt(m[0], 10) - 1);
    } catch {
      // no verdict: the first candidate stands
    }
  }
  let svg = candidates[pick].svg;
  onDraft(svg);

  // 3. Critique, behind the page: show the hand its work, let it redraw.
  let revised = false;
  for (let pass = 0; pass < CRITIQUE_PASSES; pass++) {
    let png: Buffer;
    try {
      png = renderPng(svg);
    } catch {
      break;
    }
    try {
      const revision = toDraw(
        await ask({
          system: HAND,
          prompt: critiquePrompt(brief),
          timeoutMs: CRITIQUE_TIMEOUT_MS,
          png,
        }),
      );
      if (revision) {
        svg = revision;
        revised = true;
      }
    } catch {
      break; // a failed or lingering critique never loses the draft
    }
  }
  return revised ? svg : null;
}
