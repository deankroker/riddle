"use client";

// A small pale mark on the desk's corner: the press. Always there,
// never loud; rest your hand on it and it says what it does — press the
// whole book to paper (a PDF, by way of print). Nothing else.

import { useCallback, useEffect, useRef, useState } from "react";
import { wrapLive, type Segment, type Sheet } from "./diary";

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const svgUri = (svg: string) => "data:image/svg+xml;utf8," + encodeURIComponent(svg);

function segmentHtml(seg: Segment): string {
  if (seg.kind === "text") return `<div class="tom">${escapeHtml(seg.text)}</div>`;
  if (seg.kind === "svg") return `<img class="sk" src="${svgUri(seg.svg)}" alt="">`;
  if (seg.kind === "live") {
    return seg.strokes.length
      ? `<img class="sk" src="${svgUri(wrapLive(seg.strokes))}" alt="">`
      : "";
  }
  // Plates are sanitized server-side before they ever reach a sheet; the
  // print document's CSP below forbids scripts and external loads anyway.
  return `<div class="pl">${seg.html}</div>`;
}

function sheetHtml(s: Sheet, num: number): string {
  return (
    `<section class="sheet">` +
    `<div class="date">${escapeHtml(s.writtenOn ?? "")}</div>` +
    (s.committed ? `<div class="ghost">${escapeHtml(s.committed)}</div>` : "") +
    s.segments.map(segmentHtml).join("") +
    `<div class="pageno">— ${num} —</div>` +
    `</section>`
  );
}

/** The whole diary as one printable document: cream paper, one leaf per
 *  printed page, the diary's faces falling back to serif and cursive. */
function diaryDoc(pages: { s: Sheet; n: number }[]): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<title>The Diary of T. M. Riddle</title>` +
    `<style>` +
    `@page{margin:0}` +
    `*{box-sizing:border-box}` +
    `html,body{margin:0;padding:0}` +
    `body{background:#ede1c5;-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `.sheet{position:relative;min-height:100vh;padding:60px 68px 76px;background:#ede1c5;color:#241a10;page-break-after:always;break-after:page}` +
    `.sheet:last-child{page-break-after:auto;break-after:auto}` +
    `.date{position:absolute;top:26px;right:44px;font:italic 13px Georgia,'Times New Roman',serif;color:rgba(87,65,37,.7)}` +
    `.ghost{font:500 19px/1.65 'Caveat','Bradley Hand','Segoe Script',cursive;color:#2c3a57;opacity:.38;white-space:pre-wrap;margin-bottom:14px}` +
    `.tom{font:500 22px/1.7 'Dancing Script','Apple Chancery','Snell Roundhand',cursive;color:#241a10;white-space:pre-wrap}` +
    `.sk{display:block;width:min(70%,420px);margin:14px auto}` +
    `.pl{width:min(100%,520px);margin:14px auto;font-family:Georgia,'Iowan Old Style','Times New Roman',serif}` +
    `.pageno{position:absolute;left:0;right:0;bottom:22px;text-align:center;font:12px Georgia,serif;letter-spacing:.14em;color:rgba(87,65,37,.6)}` +
    `</style></head><body>` +
    pages.map((p) => sheetHtml(p.s, p.n)).join("") +
    `</body></html>`
  );
}

export default function Actions({
  sheets,
  first,
  perView,
}: {
  sheets: Sheet[];
  first: number;
  perView: number;
}) {
  const [note, setNote] = useState("");
  const [onPaper, setOnPaper] = useState(false);
  const [seat, setSeat] = useState<{ top: number; right: number } | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  // The mark lives in the viewport's top-right. When the paper reaches
  // up under it (most screens), pale gray on cream would wash out — so
  // it becomes page furniture instead: ink, printed on the leaf, seated
  // on the same line as the page's date, just to its right, out in the
  // margin. On the dark desk it stays pale gray. Re-measured on resize
  // and whenever the leaves change shape.
  useEffect(() => {
    const measure = () => {
      const papers = document.querySelectorAll(".paper");
      const last = papers[papers.length - 1];
      if (!last) {
        setOnPaper(false);
        setSeat(null);
        return;
      }
      const p = last.getBoundingClientRect();
      const over = p.right > window.innerWidth - 90 && p.top < 76;
      setOnPaper(over);
      const date = over ? last.querySelector(".pageDate") : null;
      if (date) {
        const d = date.getBoundingClientRect();
        // control box is 35px wide (19px glyph + 8px padding each side);
        // its left edge lands a breath past the date's last character
        setSeat({
          top: d.top + d.height / 2,
          right: window.innerWidth - d.right - 37,
        });
      } else {
        setSeat(null);
      }
    };
    measure();
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [first, perView]);

  const whisper = useCallback((text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(""), 2600);
  }, []);

  /** Press the book to paper: every written leaf, one per printed page. */
  const download = useCallback(() => {
    const pages = sheets
      .map((s, i) => ({ s, n: i + 1 }))
      .filter(({ s }) => s.committed || s.segments.length > 0);
    if (pages.length === 0) {
      whisper("the diary is empty…");
      return;
    }
    const w = window.open("", "_blank", "width=880,height=1100");
    if (!w) {
      whisper("the window would not open…");
      return;
    }
    w.document.open();
    w.document.write(diaryDoc(pages));
    w.document.close();
    w.onafterprint = () => {
      try {
        w.close();
      } catch {
        // some browsers keep the window; no matter
      }
    };
    // A breath for the data-uri sketches to settle before the press.
    window.setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch {
        // the window was closed before printing; nothing to do
      }
    }, 400);
  }, [sheets, whisper]);

  return (
    <div
      className={`actions${onPaper ? " onPaper" : ""}`}
      style={onPaper && seat ? { top: seat.top, right: seat.right } : undefined}
    >
      <button
        type="button"
        className="dl"
        onClick={download}
        aria-label="download the diary as a PDF"
        title="download as pdf"
      >
        <svg
          viewBox="0 0 24 24"
          width="19"
          height="19"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 4.5v9.5M8 10.5l4 4 4-4M5 19.5h14" />
        </svg>
      </button>
      {note && <div className="actionsNote">{note}</div>}
    </div>
  );
}
