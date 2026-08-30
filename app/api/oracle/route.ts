// POST /api/oracle — the diary drinks a page and streams Tom's reply.
// Body: { message: string, history: [{ writer, tom }] }
// Response: NDJSON stream of
//   { type: "ink",    text: string }  — a fragment of the reply, in order
//   { type: "drawing" }               — the hand has begun a drawing
//   { type: "stroke", d, fill, o }    — one live stroke, inked server-side
//   { type: "draw",   svg: string }   — the whole sanitized drawing
//   { type: "redraw", svg: string }   — the critique's revision
//   { type: "done" }                  — the reply is complete
//   { type: "error",  message: string }
import { askOracle } from "@/lib/oracle";
import { SvgStreamParser, type InkEvent } from "@/lib/ink-parser";
import { drawSketch } from "@/lib/atelier";
import type { Page } from "@/lib/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // a drawing composes, is seen, and is redrawn

export async function POST(req: Request) {
  let message = "";
  let history: Page[] = [];
  try {
    const body = await req.json();
    message = typeof body.message === "string" ? body.message.trim() : "";
    if (Array.isArray(body.history)) {
      history = body.history
        .filter(
          (p: unknown): p is Page =>
            !!p &&
            typeof (p as Page).writer === "string" &&
            typeof (p as Page).tom === "string",
        )
        .map((p: Page) => ({ writer: p.writer.slice(0, 4000), tom: p.tom.slice(0, 4000) }));
    }
  } catch {
    return Response.json({ error: "malformed page" }, { status: 400 });
  }
  if (!message) {
    return Response.json({ error: "the page is blank" }, { status: 400 });
  }
  if (message.length > 8000) {
    return Response.json({ error: "the page overflows" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const parser = new SvgStreamParser();
        // A sketch brief becomes an atelier job: composed, rendered,
        // critiqued by the hand that drew it — while prose streams on.
        const jobs: Promise<void>[] = [];
        const refusal = "\n(the hand tried; the ink refused the picture…)";
        const handle = (ev: InkEvent) => {
          if (ev.type === "sketch") {
            jobs.push(
              (async () => {
                const t0 = Date.now();
                let firstStrokeAt = 0;
                let drafted = false;
                try {
                  // Strokes flow to the page as the hand sets them down;
                  // the whole draft follows once the judge has picked;
                  // the critique's revision comes last, as a replacement.
                  const revision = await drawSketch(
                    ev.brief,
                    (svg) => {
                      drafted = true;
                      console.log(`atelier: draw +${Date.now() - t0}ms`);
                      send({ type: "draw", svg });
                    },
                    (p) => {
                      if (!firstStrokeAt) {
                        firstStrokeAt = Date.now();
                        console.log(`atelier: first stroke +${firstStrokeAt - t0}ms`);
                      }
                      send({ type: "stroke", d: p.d, fill: p.fill, o: p.o });
                    },
                  );
                  if (revision) send({ type: "redraw", svg: revision });
                  else if (!drafted && !firstStrokeAt) send({ type: "ink", text: refusal });
                } catch (e) {
                  console.error("atelier:", e instanceof Error ? e.message : e);
                  if (!drafted && !firstStrokeAt) send({ type: "ink", text: refusal });
                }
              })(),
            );
          } else {
            send(ev);
          }
        };
        for await (const text of askOracle(message, history)) {
          for (const ev of parser.feed(text)) handle(ev);
        }
        for (const ev of parser.feed("", true)) handle(ev);
        await Promise.allSettled(jobs);
        send({ type: "done" });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error("oracle:", reason);
        send({ type: "error", message: reason });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
