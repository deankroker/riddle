// Streaming router for Tom's reply, in the spirit of src/oracle.rs's
// StreamParser: prose flows through as "ink" events; an illustrated
// plate (<figure>…</figure> of HTML) or a legacy sketch (<svg>…</svg>)
// is captured whole, sanitized, and emitted as a single "plate"/"draw"
// event — the raw markup never reaches the page as text. A "drawing"
// event announces the moment the quill begins one.

export type InkEvent =
  | { type: "ink"; text: string }
  | { type: "drawing" } // the hand has begun a drawing
  | { type: "sketch"; brief: string } // Tom's brief — the route realises it
  | { type: "stroke"; d: string; fill: string; o: number } // one live stroke (route-generated, never parsed)
  | { type: "draw"; svg: string }
  | { type: "redraw"; svg: string } // the critique's revision, replacing the draft
  | { type: "plate"; html: string };

interface Mark {
  open: string;
  close: string;
  kind: "plate" | "draw" | "sketch";
}

const MARKS: Mark[] = [
  { open: "<sketch", close: "</sketch>", kind: "sketch" },
  { open: "<figure", close: "</figure>", kind: "plate" },
  { open: "<svg", close: "</svg>", kind: "draw" },
];

// Tokens whose partially-streamed prefixes must be held back from prose.
const HOLD_TOKENS = ["<sketch", "<figure", "<svg", "```html", "```svg", "```xml"];

export class SvgStreamParser {
  private buf = ""; // pending prose not yet emitted
  private mark: Mark | null = null; // non-null while inside a plate/sketch
  private markBuf = "";
  private prev = ""; // last prose character emitted (for dash mending)

  /** Feed a fragment; `done` flushes. Returns events in order. */
  feed(chunk: string, done = false): InkEvent[] {
    const out: InkEvent[] = [];
    if (this.mark) this.markBuf += chunk;
    else this.buf += chunk;

    for (;;) {
      if (!this.mark) {
        const low = this.buf.toLowerCase();
        let at = -1;
        let hit: Mark | null = null;
        for (const m of MARKS) {
          const i = low.indexOf(m.open);
          if (i >= 0 && (at < 0 || i < at)) {
            at = i;
            hit = m;
          }
        }
        if (hit && at >= 0) {
          this.pushProse(out, this.buf.slice(0, at));
          this.mark = hit;
          this.markBuf = this.buf.slice(at);
          this.buf = "";
          out.push({ type: "drawing" });
          continue;
        }
        // Emit prose, holding back a tail that might begin a marker.
        const hold = done ? 0 : holdbackLen(this.buf);
        const emit = this.buf.slice(0, this.buf.length - hold);
        if (emit) {
          this.pushProse(out, emit);
          this.buf = this.buf.slice(emit.length);
        }
        break;
      }
      const end = this.markBuf.toLowerCase().indexOf(this.mark.close);
      if (end < 0) break; // still streaming in
      const raw = this.markBuf.slice(0, end + this.mark.close.length);
      this.buf = this.markBuf.slice(end + this.mark.close.length);
      const kind = this.mark.kind;
      this.mark = null;
      this.markBuf = "";
      if (kind === "sketch") {
        const brief = raw
          .replace(/^<sketch[^>]*>/i, "")
          .replace(/<\/sketch>$/i, "")
          .trim();
        if (brief) out.push({ type: "sketch", brief: brief.slice(0, 2000) });
      } else if (kind === "plate") {
        const html = sanitizePlate(raw);
        if (html) out.push({ type: "plate", html });
      } else {
        const svg = sanitizeSvg(raw);
        if (svg) out.push({ type: "draw", svg });
      }
    }

    if (done) {
      if (this.buf) {
        this.pushProse(out, this.buf);
        this.buf = "";
      }
      this.mark = null; // an unterminated plate dissolves
      this.markBuf = "";
    }
    return out;
  }

  private pushProse(out: InkEvent[], s: string) {
    // A misbehaving model may fence the plate; the fences never ink.
    let t = s.replace(/```(?:svg|xml|html)?/gi, "");
    // The quill does not make the long dash. Number ranges take a
    // hyphen; everywhere else the dash becomes a comma's pause.
    t = t.replace(/(\d)[ \t]*[—–][ \t]*(?=\d)/g, "$1-");
    t = t.replace(/[ \t]*[—–][ \t]*|[ \t]+--[ \t]+/g, ", ");
    // A dash that opened a line leaves a stray comma; mend it.
    if ((this.prev === "" || this.prev === "\n") && t.startsWith(", ")) {
      t = t.slice(2);
    }
    if (t) {
      out.push({ type: "ink", text: t });
      this.prev = t[t.length - 1];
    }
  }
}

/** Longest suffix of `s` that must wait for more stream: a proper
 *  prefix of a hold token, or trailing spaces/dashes whose scrubbing
 *  needs the character that follows them. */
function holdbackLen(s: string): number {
  let best = 0;
  const low = s.toLowerCase();
  for (const token of HOLD_TOKENS) {
    const max = Math.min(token.length - 1, low.length);
    for (let k = max; k > best; k--) {
      if (token.startsWith(low.slice(low.length - k))) {
        best = k;
        break;
      }
    }
  }
  const tail = s.match(/[ \t—–-]+$/);
  if (tail) best = Math.max(best, Math.min(tail[0].length, 8));
  return best;
}

/** Scrub an illustrated plate. Defense in depth: the client renders it
 *  inside a fully sandboxed iframe whose CSP forbids scripts and every
 *  external load — but nothing questionable gets stored either. */
export function sanitizePlate(raw: string): string | null {
  let html = raw.trim();
  const low = html.toLowerCase();
  if (!low.startsWith("<figure") || !low.endsWith("</figure>")) return null;
  if (html.length > 300_000) return null;
  if (/<\s*(script|iframe|object|embed|link|meta|base|form|input|button|img|audio|video)\b/i.test(html)) {
    return null;
  }
  if (/javascript:|data:text\/html|expression\s*\(|@import|url\s*\(/i.test(html)) {
    return null;
  }
  // Event handlers and external references.
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  if (/\b(?:href|src|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
    return null;
  }
  return html;
}

/** Scrub a bare sketch (legacy path — plates may also embed svg). The
 *  client renders these inside an <img>, where scripts never run. */
export function sanitizeSvg(raw: string): string | null {
  let svg = raw.trim();
  const low = svg.toLowerCase();
  if (!low.startsWith("<svg") || !low.endsWith("</svg>")) return null;
  if (svg.length > 200_000) return null;
  if (/<\s*(script|foreignobject|iframe|embed|object|animation|use)\b|javascript:|data:text\/html/i.test(svg)) {
    return null;
  }
  // Event handlers and external references.
  svg = svg.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  svg = svg.replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "");
  // <img> rendering requires the namespace; models sometimes omit it.
  if (!/<svg[^>]*\sxmlns\s*=/i.test(svg)) {
    svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg;
}
