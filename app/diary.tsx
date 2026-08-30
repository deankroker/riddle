"use client";

// The book on the desk. It begins at its first leaf — page 1 alone, as
// in any book — and turning that page opens it into two-page spreads
// (2–3, 4–5, …). Write on any page; turn the corners to move through
// the leaves; let several pages think at once. The spirit is a single
// memory, the pages are only paper — and the paper remembers: every
// leaf is kept in the browser's storage, so the diary you return to is
// the diary you left.
//
// A page's life: write → rest your quill (2.8s, or Enter) → your ink
// waits on the page while the diary thinks → the moment Tom's reply
// begins, your words drink down to a faint ghost and his hand writes
// beneath them — prose, a sketch, or both — and it all stays on the leaf.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "@/lib/persona";
import Actions from "./actions";

const IDLE_MS = 2800; // rest your quill this long and the diary drinks
const FIRST_INK_MS = 350; // breath between the drink beginning and the quill
const SKETCH_MS = 2600; // how long a drawing takes to develop on the paper
const FIT_MIN = 0.5; // the smallest the hand will write to fit the page
const WHEEL_TURN = 140; // wheel travel that amounts to a page turn
const WHEEL_COOL_MS = 700; // one flick, one turn — then the paper rests
const TURN_RESET_MS = 680; // lift the 3D transform once the turn has played
const STORE_KEY = "riddle-notebook-v1";
const MAX_STORED_SHEETS = 80;

/** One live stroke of a drawing in progress — path data inked and
 *  validated server-side, never model markup. */
export interface LiveStroke {
  d: string;
  fill: string;
  o: number;
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "svg"; svg: string; quiet?: boolean } // a whole sketch; quiet = it replaced live ink already on the page
  | { kind: "html"; html: string } // an illustrated plate, shown sandboxed
  | { kind: "live"; strokes: LiveStroke[] }; // a drawing arriving stroke by stroke
type Phase = "writing" | "resting" | "replying" | "done";

export interface Sheet {
  id: number;
  phase: Phase;
  draft: string;
  committed: string; // the writer's ink once the quill has rested
  drank: boolean; // has the ink sunk to a ghost yet?
  segments: Segment[]; // Tom's reply as it streams in
  segIdx: number; // reveal pointer: which segment the quill is on
  charIdx: number; // …and how far into it (svg: 0 hidden, 1 revealed)
  nextAt: number; // when the quill may make its next stroke
  replyDone: boolean;
  sketching: boolean; // a drawing is streaming in but hasn't finished
  writtenOn?: string; // the day this page was written
}

const blank = (id: number): Sheet => ({
  id,
  phase: "writing",
  draft: "",
  committed: "",
  drank: false,
  segments: [],
  segIdx: 0,
  charIdx: 0,
  nextAt: 0,
  replyDone: false,
  sketching: false,
});

const touched = (s: Sheet) =>
  s.phase !== "writing" || !!s.draft.trim() || s.segments.length > 0;

const busy = (s: Sheet) => s.phase === "resting" || s.phase === "replying";

/** Live strokes wrapped as a whole drawing — the same shape the server
 *  ships, duplicated here so the client bundle stays free of the ink
 *  pipeline's dependencies. */
export const wrapLive = (strokes: LiveStroke[]) =>
  `<svg viewBox="0 0 800 560" xmlns="http://www.w3.org/2000/svg">` +
  strokes
    .map(
      (s) =>
        `<path d="${s.d}" fill="${s.fill}"${s.o < 1 ? ` fill-opacity="${s.o.toFixed(2)}"` : ""} stroke="none"/>`,
    )
    .join("") +
  `</svg>`;

/** A drawing caught mid-stroke keeps what the hand managed. */
const settleSegs = (segs: Segment[]): Segment[] =>
  segs.flatMap((g): Segment[] => {
    if (g.kind !== "live") return [g];
    return g.strokes.length ? [{ kind: "svg", svg: wrapLive(g.strokes), quiet: true }] : [];
  });

/** A sheet as it should sleep in storage: streams can't survive a
 *  refresh, so a page caught mid-reply keeps what was written, and a
 *  page whose reply never began returns the ink to the writer's hand. */
function settle(s: Sheet): Sheet {
  if (s.phase === "resting" || s.phase === "replying") {
    if (s.segments.length > 0) {
      const segments = settleSegs(s.segments);
      return {
        ...s,
        phase: "done",
        replyDone: true,
        segments,
        segIdx: segments.length,
        charIdx: 0,
        nextAt: 0,
        drank: true,
        sketching: false,
      };
    }
    return { ...blank(s.id), draft: s.committed || s.draft, writtenOn: s.writtenOn };
  }
  if (s.phase === "done") {
    const segments = settleSegs(s.segments);
    return { ...s, segments, segIdx: segments.length, charIdx: 0, nextAt: 0, sketching: false };
  }
  return { ...s, nextAt: 0, sketching: false };
}

/** Pause after a character, so the quill breathes like a hand would. */
function strokeDelay(prev: string): number {
  if (".!?…".includes(prev)) return 380;
  if (",;:".includes(prev)) return 170;
  if (prev === "\n") return 300;
  if (prev === " ") return 18;
  return 34;
}

function ordinalDate(d: Date): string {
  const day = d.getDate();
  const suffix =
    day % 10 === 1 && day !== 11 ? "st"
    : day % 10 === 2 && day !== 12 ? "nd"
    : day % 10 === 3 && day !== 13 ? "rd"
    : "th";
  const month = d.toLocaleString("en-GB", { month: "long" });
  return `the ${day}${suffix} of ${month}`;
}

const svgUri = (svg: string) => "data:image/svg+xml;utf8," + encodeURIComponent(svg);

/** The plate's little world: no scripts, no outside loads — only inline
 *  ink. The iframe is fully sandboxed on top of this CSP. */
const plateDoc = (html: string) =>
  `<!doctype html><html><head>` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
  `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;color-scheme:light}` +
  `body{color:#241a10;font-family:Georgia,'Iowan Old Style','Times New Roman',serif}` +
  `*{box-sizing:border-box}figure{margin:0}</style>` +
  `</head><body>${html}</body></html>`;

/** A sketch that may be revised under your eye: when the critique's
 *  redraw lands — or a whole drawing settles over live strokes already
 *  on the page (`quiet`) — the new ink settles briefly over the old,
 *  not the full first-reveal development. */
function SketchInk({ svg, settled, quiet }: { svg: string; settled: boolean; quiet?: boolean }) {
  const [firstSvg] = useState(svg); // the draft this frame was born with
  const resettle = svg !== firstSvg || (!!quiet && !settled);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- model-drawn data-URI art; next/image cannot optimize it
    <img
      key={`${resettle ? "r" : "d"}:${svg.length}`}
      className={`sketch${settled ? " settled" : ""}${resettle ? " resettle" : ""}`}
      alt="a drawing inked into the diary"
      src={svgUri(svg)}
      draggable={false}
    />
  );
}

/** A plate stays invisible until its little document has painted, so a
 *  remounting iframe never flashes white mid-turn. */
function PlateFrame({ html, settled }: { html: string; settled: boolean }) {
  const [inked, setInked] = useState(false);
  return (
    <iframe
      className={`plate${settled ? " settled" : ""}${inked ? " inked" : ""}`}
      sandbox=""
      srcDoc={plateDoc(html)}
      title="an illustrated plate in the diary"
      tabIndex={-1}
      scrolling="no"
      onLoad={() => setInked(true)}
    />
  );
}

export default function Diary() {
  const [sheets, setSheets] = useState<Sheet[]>(() => [blank(1), blank(2)]);
  const [first, setFirst] = useState(0); // leftmost visible leaf
  const [perView, setPerView] = useState(2); // 2 = spread, 1 = narrow screens
  const [turn, setTurn] = useState<0 | 1 | -1>(0);
  const [everWrote, setEverWrote] = useState(false);
  const [today, setToday] = useState("");

  const nextId = useRef(3);
  const historyRef = useRef<Page[]>([]);
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const firstRef = useRef(first);
  firstRef.current = first;
  const perViewRef = useRef(perView);
  perViewRef.current = perView;
  const restoredRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const turnTimer = useRef<number | undefined>(undefined);

  // A held transform isolates the leaf's blending and softens its text;
  // once the turn has played, the leaf must lie flat again.
  const beginTurn = useCallback((dir: 1 | -1) => {
    setTurn(dir);
    window.clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => setTurn(0), TURN_RESET_MS);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe: the date must differ from the server render
    setToday(ordinalDate(new Date()));
  }, []);

  // ——— the paper remembers: restore, then keep saving ———

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        if (stored && Array.isArray(stored.sheets) && stored.sheets.length > 0) {
          const restored: Sheet[] = stored.sheets
            .filter((s: unknown) => !!s && typeof (s as Sheet).id === "number")
            .map((s: Partial<Sheet>) => settle({ ...blank(s.id as number), ...s }));
          if (restored.length > 0) {
            nextId.current = Math.max(...restored.map((s) => s.id)) + 1;
            // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe restore: localStorage exists only on the client
            setSheets(restored);
            if (Array.isArray(stored.history)) historyRef.current = stored.history.slice(-8);
            if (stored.everWrote) setEverWrote(true);
            if (typeof stored.first === "number") {
              const f = Math.max(0, Math.min(stored.first, restored.length - 1));
              // valid view starts in two-page mode: 0, then odd indices
              setFirst(f === 0 ? 0 : f % 2 === 1 ? f : f - 1);
            }
          }
        }
      }
    } catch {
      // a torn page in storage — begin a fresh diary
    }
    restoredRef.current = true;
  }, []);

  useEffect(() => {
    if (!restoredRef.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        const dropped = Math.max(0, sheets.length - MAX_STORED_SHEETS);
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            v: 1,
            sheets: sheets.slice(-MAX_STORED_SHEETS).map(settle),
            history: historyRef.current,
            everWrote,
            first: Math.max(0, firstRef.current - dropped),
          }),
        );
      } catch {
        // storage full or forbidden — the diary simply won't remember
      }
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [sheets, everWrote, first]);

  // ——— one page or two, depending on the desk ———

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 980px)");
    const apply = () => setPerView(mq.matches ? 2 : 1);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Page 1 stands alone, as in any book; after it, spreads pair pages
  // 2–3, 4–5, … — so in two-page mode `first` is 0 or an odd index.
  // Adjusted during render (the React pattern for state that follows
  // state), so the book never paints an invalid spread for a frame.
  const [snappedPerView, setSnappedPerView] = useState(perView);
  if (snappedPerView !== perView) {
    setSnappedPerView(perView);
    if (perView === 2) setFirst((f) => (f === 0 ? 0 : f % 2 === 1 ? f : f - 1));
  }

  // A book always has enough leaves to show.
  useEffect(() => {
    setSheets((prev) => {
      const count = perView === 1 || first === 0 ? 1 : 2;
      const need = first + count;
      if (prev.length >= need) return prev;
      const grown = [...prev];
      while (grown.length < need) grown.push(blank(nextId.current++));
      return grown;
    });
  }, [first, perView]);

  const patch = useCallback((id: number, fn: (s: Sheet) => Sheet) => {
    setSheets((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  /** Ask the oracle for one page; events stream into that sheet only. */
  const streamReply = useCallback(
    async (id: number, text: string) => {
      const wake = (s: Sheet): Sheet =>
        s.phase === "resting"
          ? { ...s, phase: "replying", drank: true, nextAt: Date.now() + FIRST_INK_MS }
          : s;
      let prose = "";
      let drew = false;
      try {
        const res = await fetch("/api/oracle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history: historyRef.current }),
        });
        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => null);
          throw new Error(detail?.error || `the diary is silent (${res.status})`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === "ink") {
              prose += ev.text;
              patch(id, (s) => {
                const segs = [...s.segments];
                const last = segs[segs.length - 1];
                let t: string = ev.text;
                if (segs.length === 0) t = t.replace(/^\s+/, "");
                if (!t) return s;
                if (last?.kind === "text") {
                  segs[segs.length - 1] = { kind: "text", text: last.text + t };
                } else {
                  segs.push({ kind: "text", text: t });
                }
                return wake({ ...s, segments: segs });
              });
            } else if (ev.type === "drawing") {
              patch(id, (s) => wake({ ...s, sketching: true }));
            } else if (ev.type === "stroke") {
              // The hand is drawing under your eye: one stroke at a time.
              drew = true;
              patch(id, (s) => {
                const segs = [...s.segments];
                const last = segs[segs.length - 1];
                const stroke: LiveStroke = { d: ev.d, fill: ev.fill, o: ev.o };
                if (last?.kind === "live") {
                  segs[segs.length - 1] = { kind: "live", strokes: [...last.strokes, stroke] };
                } else {
                  segs.push({ kind: "live", strokes: [stroke] });
                }
                return wake({ ...s, sketching: false, segments: segs });
              });
            } else if (ev.type === "draw" || ev.type === "redraw") {
              // The whole drawing (or the critique's revision) settles
              // over whatever ink is already on the page, in place.
              drew = true;
              patch(id, (s) => {
                const segs = [...s.segments];
                let at = -1;
                for (let i = segs.length - 1; i >= 0; i--) {
                  if (segs[i].kind === "svg" || segs[i].kind === "live") {
                    at = i;
                    break;
                  }
                }
                const quiet = at >= 0; // replacing visible ink: settle, don't re-develop
                const seg: Segment = { kind: "svg", svg: ev.svg, quiet };
                if (at < 0) segs.push(seg);
                else segs[at] = seg;
                return wake({ ...s, sketching: false, segments: segs });
              });
            } else if (ev.type === "plate") {
              drew = true;
              patch(id, (s) =>
                wake({
                  ...s,
                  sketching: false,
                  segments: [...s.segments, { kind: "html", html: ev.html }],
                }),
              );
            } else if (ev.type === "error") {
              throw new Error(ev.message || "the ink refuses");
            }
          }
        }
        // Remember the page, diary-wide.
        prose = prose.trim();
        if (prose || drew) {
          historyRef.current = [
            ...historyRef.current,
            { writer: text, tom: prose + (drew ? "\n(I also set an illustration into the page.)" : "") },
          ].slice(-8);
        }
        patch(id, (s) =>
          s.segments.length === 0
            ? {
                ...wake(s),
                segments: [{ kind: "text", text: "The ink will not settle… (an empty reply)" }],
                replyDone: true,
                sketching: false,
              }
            : { ...s, replyDone: true, sketching: false },
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        patch(id, (s) => {
          const segs = [...s.segments];
          const note = (segs.length ? "\n\n" : "") + `The ink will not settle… (${reason})`;
          const last = segs[segs.length - 1];
          if (last?.kind === "text") {
            segs[segs.length - 1] = { kind: "text", text: last.text + note };
          } else {
            segs.push({ kind: "text", text: note.trimStart() });
          }
          return wake({ ...s, segments: segs, replyDone: true, sketching: false });
        });
      }
    },
    [patch],
  );

  /** The quill has rested: the diary takes the page. */
  const commit = useCallback(
    (id: number) => {
      const sheet = sheetsRef.current.find((s) => s.id === id);
      if (!sheet || sheet.phase !== "writing") return;
      const text = sheet.draft.trim();
      if (!text) return;
      setEverWrote(true);
      const writtenOn = ordinalDate(new Date());
      patch(id, (s) => ({ ...s, phase: "resting", committed: s.draft, writtenOn }));
      void streamReply(id, text);
    },
    [patch, streamReply],
  );

  // The quill: one loop moves every replying page forward, whether or
  // not its leaf is the one facing you.
  useEffect(() => {
    const iv = window.setInterval(() => {
      setSheets((prev) => {
        const now = Date.now();
        let changed = false;
        const next = prev.map((s) => {
          if (s.phase !== "replying" || now < s.nextAt) return s;
          const seg = s.segments[s.segIdx];
          if (!seg) {
            if (s.replyDone) {
              changed = true;
              return { ...s, phase: "done" as const };
            }
            return s; // the page is still thinking
          }
          if (seg.kind === "live") {
            // The strokes ARE the reveal — the quill steps past at once.
            changed = true;
            return { ...s, segIdx: s.segIdx + 1, charIdx: 0 };
          }
          if (seg.kind !== "text") {
            changed = true;
            return s.charIdx === 0
              ? { ...s, charIdx: 1, nextAt: now + SKETCH_MS }
              : { ...s, segIdx: s.segIdx + 1, charIdx: 0 };
          }
          const chars = Array.from(seg.text);
          if (s.charIdx < chars.length) {
            const prevCh = s.charIdx > 0 ? chars[s.charIdx - 1] : "";
            changed = true;
            return { ...s, charIdx: s.charIdx + 1, nextAt: now + strokeDelay(prevCh) };
          }
          if (s.segIdx < s.segments.length - 1) {
            changed = true;
            return { ...s, segIdx: s.segIdx + 1, charIdx: 0 };
          }
          if (s.replyDone) {
            changed = true;
            return { ...s, phase: "done" as const, segIdx: s.segments.length };
          }
          return s; // the last line may yet grow
        });
        return changed ? next : prev;
      });
    }, 24);
    return () => window.clearInterval(iv);
  }, []);

  // ——— turning the leaves ———

  const forward = useCallback(() => {
    const all = sheetsRef.current;
    const f = firstRef.current;
    const pv = perViewRef.current;
    const count = pv === 1 || f === 0 ? 1 : 2;
    const atEnd = f + count >= all.length;
    if (atEnd && !all.slice(f, f + count).some(touched)) return; // blank leaves await already
    setFirst(pv === 1 ? f + 1 : f === 0 ? 1 : f + 2);
    beginTurn(1);
  }, [beginTurn]);

  const back = useCallback(() => {
    const f = firstRef.current;
    if (f === 0) return;
    const pv = perViewRef.current;
    setFirst(pv === 1 ? f - 1 : f <= 1 ? 0 : f - 2);
    beginTurn(-1);
  }, [beginTurn]);

  // Arrows turn the pages — plain arrows anywhere the caret isn't
  // writing, and ⌘/Ctrl+arrows even from inside the ink.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (!(e.metaKey || e.ctrlKey)) {
        if (e.altKey || e.shiftKey) return; // browser and selection chords stay theirs
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) {
          return; // the arrows belong to the caret while a hand is on the page
        }
      }
      e.preventDefault();
      if (e.key === "ArrowRight") forward();
      else back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forward, back]);

  // A sideways flick turns the page — one flick, one turn. Vertical
  // scrolling is left alone; pages turn like pages, not like feeds.
  useEffect(() => {
    let acc = 0;
    let lastAt = 0;
    let coolUntil = 0;
    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now < coolUntil) {
        lastAt = now;
        return; // the paper is still settling from the last turn
      }
      if (now - lastAt > 260) acc = 0; // a fresh gesture starts a fresh count
      lastAt = now;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical: not ours
      const step = e.deltaX;
      acc += e.deltaMode === 1 ? step * 16 : step; // line-mode wheels count small
      if (Math.abs(acc) < WHEEL_TURN) return;
      const dir = acc > 0 ? 1 : -1;
      acc = 0;
      coolUntil = now + WHEEL_COOL_MS;
      if (dir === 1) forward();
      else back();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [forward, back]);

  // ——— the desk ———

  const count = perView === 1 || first === 0 ? 1 : 2;
  const visible = sheets.slice(first, first + count);
  const busyBehind = sheets.some((s, i) => i < first && busy(s));
  const busyAhead = sheets.some((s, i) => i >= first + count && busy(s));
  const firstWritingId = visible.find((s) => s.phase === "writing")?.id;

  return (
    <main className="scene">
      <div className={`book${count === 1 ? " single" : ""} revealing`}>
        {visible.map((sheet, pos) => (
          <Leaf
            key={sheet.id}
            sheet={sheet}
            num={first + pos + 1}
            side={count === 1 ? "single" : pos === 0 ? "L" : "R"}
            turn={turn}
            today={today}
            canFocus={sheet.id === firstWritingId}
            showIntro={first + pos === 0 && !everWrote}
            isLeftmost={pos === 0}
            isRightmost={pos === visible.length - 1}
            atStart={first === 0}
            busyBehind={busyBehind}
            busyAhead={busyAhead}
            patch={patch}
            commit={commit}
            forward={forward}
            back={back}
          />
        ))}
      </div>

      <Actions sheets={sheets} first={first} perView={perView} />

      <div className="candlelight" aria-hidden />
      <div className="vignette" aria-hidden />
    </main>
  );
}

// ——— one leaf of the book ———

interface LeafProps {
  sheet: Sheet;
  num: number;
  side: "L" | "R" | "single";
  turn: 0 | 1 | -1;
  today: string;
  canFocus: boolean;
  showIntro: boolean;
  isLeftmost: boolean;
  isRightmost: boolean;
  atStart: boolean;
  busyBehind: boolean;
  busyAhead: boolean;
  patch: (id: number, fn: (s: Sheet) => Sheet) => void;
  commit: (id: number) => void;
  forward: () => void;
  back: () => void;
}

function Leaf({
  sheet,
  num,
  side,
  turn,
  today,
  canFocus,
  showIntro,
  isLeftmost,
  isRightmost,
  atStart,
  busyBehind,
  busyAhead,
  patch,
  commit,
  forward,
  back,
}: LeafProps) {
  const inkRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(1); // 1 → FIT_MIN: the hand writes smaller
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A page never scrolls: when the ink outgrows the leaf, the hand
  // simply writes smaller — and relaxes again when room returns.
  // Measured after paint (rAF), one gentle step per frame until it fits.
  useEffect(() => {
    void tick;
    const raf = requestAnimationFrame(() => {
      if (sheet.phase === "writing") {
        if (!sheet.draft) {
          if (fit !== 1) setFit(1);
          return;
        }
        const box = inkRef.current;
        if (box && box.scrollHeight > box.clientHeight + 1 && fit > FIT_MIN) {
          setFit((f) => Math.max(FIT_MIN, f - 0.05));
        }
        return;
      }
      const room = bodyRef.current?.clientHeight ?? 0;
      const content = wrapRef.current?.offsetHeight ?? 0;
      if (!room || !content) return;
      if (content > room && fit > FIT_MIN) {
        setFit((f) => Math.max(FIT_MIN, f - 0.05));
      } else if (fit < 1 && content < room * 0.84) {
        setFit((f) => Math.min(1, f + 0.04));
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [sheet.phase, sheet.draft, sheet.charIdx, sheet.segIdx, sheet.segments.length, sheet.sketching, fit, tick]);

  // Rest-your-quill timer — this leaf's alone.
  useEffect(() => {
    if (sheet.phase !== "writing" || !sheet.draft.trim()) return;
    const t = window.setTimeout(() => commit(sheet.id), IDLE_MS);
    return () => window.clearTimeout(t);
  }, [sheet.draft, sheet.phase, sheet.id, commit]);

  useEffect(() => {
    if (canFocus && sheet.phase === "writing") inkRef.current?.focus();
  }, [canFocus, sheet.phase, sheet.id]);

  const caughtUp = sheet.segIdx >= sheet.segments.length;
  const thinking =
    sheet.phase === "resting" ||
    (sheet.phase === "replying" && caughtUp && !sheet.replyDone);
  const settled = sheet.phase === "done";
  // An illustration is on its way (streaming in, or not yet revealed).
  // Live strokes never count: they are already ink on the page.
  const pendingSketch =
    sheet.sketching ||
    sheet.segments.some(
      (g, i) =>
        g.kind !== "text" &&
        g.kind !== "live" &&
        !(g.kind === "svg" && g.quiet) &&
        (i > sheet.segIdx || (i === sheet.segIdx && sheet.charIdx === 0)),
    );

  const paperClass =
    side === "single" ? "paper pageSingle" : side === "L" ? "paper pageL" : "paper pageR";

  return (
    <section className={paperClass}>
      <div className="pageDate" aria-hidden>
        {sheet.writtenOn ?? today}
      </div>

      <div className={`leaf${turn === 1 ? " turnFwd" : turn === -1 ? " turnBack" : ""}`}>
        <div
          className="pageBody"
          ref={bodyRef}
          style={{ "--fit": String(fit) } as React.CSSProperties}
        >
          {sheet.phase === "writing" ? (
            <textarea
              ref={inkRef}
              className="writerInk"
              value={sheet.draft}
              onChange={(e) => {
                const v = e.target.value;
                patch(sheet.id, (s) => ({ ...s, draft: v }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commit(sheet.id);
                }
              }}
              spellCheck={false}
              autoComplete="off"
              aria-label={`Write on page ${num}`}
            />
          ) : (
            <div className="fitWrap" ref={wrapRef}>
              <div
                className={`writerInk committed${settled ? " ghost" : sheet.drank ? " drink" : ""}`}
                aria-hidden
              >
                {sheet.committed}
                {sheet.phase === "resting" && <span className="blot" />}
              </div>
              <div className="tomInk" aria-live="polite">
                {sheet.segments.map((seg, i) => {
                  if (i > sheet.segIdx) return null;
                  if (seg.kind === "live") {
                    // The hand at work: each stroke is our own inked
                    // path from validated numbers, drawn in as it lands.
                    return seg.strokes.length ? (
                      <svg
                        key={i}
                        className="sketch liveInk"
                        viewBox="0 0 800 560"
                        role="img"
                        aria-label="a drawing being inked"
                      >
                        {seg.strokes.map((st, j) => (
                          <path
                            key={j}
                            className="liveStroke"
                            d={st.d}
                            fill={st.fill}
                            fillOpacity={st.o < 1 ? st.o : undefined}
                          />
                        ))}
                      </svg>
                    ) : null;
                  }
                  if (seg.kind === "svg") {
                    const shown = i < sheet.segIdx || sheet.charIdx > 0;
                    return shown ? (
                      <SketchInk key={i} svg={seg.svg} settled={settled} quiet={seg.quiet} />
                    ) : null;
                  }
                  if (seg.kind === "html") {
                    const shown = i < sheet.segIdx || sheet.charIdx > 0;
                    return shown ? (
                      <PlateFrame key={i} html={seg.html} settled={settled} />
                    ) : null;
                  }
                  const chars = Array.from(seg.text);
                  const upto = i < sheet.segIdx ? chars.length : sheet.charIdx;
                  return (
                    <span key={i}>
                      {chars.slice(0, upto).map((ch, j) =>
                        ch === "\n" ? (
                          <br key={j} />
                        ) : (
                          <span key={j} className="q">
                            {ch}
                          </span>
                        ),
                      )}
                    </span>
                  );
                })}
                {sheet.phase === "replying" && pendingSketch && (
                  <span className="sketching" role="status">
                    {/* our own trusted ink, not model output: a practice
                        stroke the quill draws and re-draws while it works */}
                    <svg className="flourish" viewBox="0 0 120 40" aria-hidden>
                      <path
                        pathLength={1}
                        d="M6 30 C 26 6, 44 8, 58 22 C 68 33, 82 34, 94 26 C 102 20, 109 17, 114 19"
                      />
                      <circle className="fDrop" cx="22" cy="34" r="2.2" />
                      <circle className="fDrop fDrop2" cx="102" cy="31" r="1.5" />
                    </svg>
                    <span className="sketchWhisper">the quill sketches&hellip;</span>
                  </span>
                )}
                {sheet.phase === "replying" && thinking && !pendingSketch && (
                  <span className="blot" />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showIntro && sheet.phase === "writing" && !sheet.draft && (
        <div className="hint">
          write to the diary, then rest your quill&hellip;
          <span className="hintSub">(or press Enter — Shift+Enter for a new line)</span>
        </div>
      )}
      {isRightmost && settled && (
        <div className="hint faint">turn the corner for a fresh leaf</div>
      )}

      {(isLeftmost || side === "single") && (
        <button
          type="button"
          className="corner cornerL"
          onClick={back}
          disabled={atStart}
          aria-label="previous pages"
        >
          {busyBehind && <span className="cornerBlot" aria-label="ink moving on an earlier page" />}
        </button>
      )}
      {(isRightmost || side === "single") && (
        <button type="button" className="corner cornerR" onClick={forward} aria-label="next pages">
          {busyAhead && <span className="cornerBlot" aria-label="ink moving on a later page" />}
        </button>
      )}
      <div className="pageNo" aria-label={`page ${num}`}>
        — {num} —
      </div>
    </section>
  );
}
