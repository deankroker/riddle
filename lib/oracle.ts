// The oracle — the thing that answers when the page has drunk your ink.
// Two interchangeable backends, picked per request (mirrors src/oracle.rs):
//
//  1. **Anthropic API** (`askAnthropic`) — used when ANTHROPIC_API_KEY (or
//     ANTHROPIC_AUTH_TOKEN) is set. This is the path for a deployed diary,
//     and later the place to meter/charge for tokens: every reply flows
//     through this one server-side entry point.
//  2. **Claude Code** (`askClaudeCode`) — the local-dev path. Uses the
//     Claude Agent SDK, which runs on the machine's Claude Code login
//     (e.g. a Max subscription) — no API key required on localhost.
//
// Both expose the same shape: an async generator of reply-text fragments.

import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PERSONA, type Page } from "./persona";

const MAX_HISTORY = 8;

export function askOracle(message: string, history: Page[]): AsyncGenerator<string> {
  const recent = history.slice(-MAX_HISTORY);
  const backend = process.env.RIDDLE_ORACLE; // "api" | "claude-code" | unset
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (backend === "api" || (backend !== "claude-code" && hasKey)) {
    return askAnthropic(message, recent);
  }
  return askClaudeCode(message, recent);
}

/** Anthropic Messages API, streaming. History rides as prior chat turns. */
async function* askAnthropic(message: string, history: Page[]): AsyncGenerator<string> {
  const client = new Anthropic();
  const model = process.env.RIDDLE_MODEL || "claude-opus-5";

  const messages: Anthropic.MessageParam[] = [];
  for (const page of history) {
    messages.push({ role: "user", content: `(an earlier page) ${page.writer}` });
    messages.push({ role: "assistant", content: page.tom });
  }
  messages.push({ role: "user", content: message });

  const stream = client.messages.stream({
    model,
    max_tokens: 4000, // runaway guard; prose stays short, but sketches take room
    system: PERSONA,
    output_config: { effort: "low" },
    messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    throw new Error("the spirit declines to answer this page");
  }
}

/** Claude Agent SDK — rides the local Claude Code login. One-shot query
 *  with the persona as system prompt and no tools; earlier pages are
 *  inlined into the prompt (the query itself is stateless). */
async function* askClaudeCode(message: string, history: Page[]): AsyncGenerator<string> {
  const prompt =
    history.length === 0
      ? message
      : history
          .map((p) => `(an earlier page)\nThe writer wrote: ${p.writer}\nYou replied: ${p.tom}`)
          .join("\n\n") + `\n\n(today's page — reply to this)\n${message}`;

  const q = query({
    prompt,
    options: {
      systemPrompt: PERSONA,
      allowedTools: [],
      maxTurns: 1,
      includePartialMessages: true,
      settingSources: [],
      model: process.env.RIDDLE_MODEL || "claude-opus-5",
    },
  });

  let streamed = false;
  for await (const m of q) {
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        streamed = true;
        yield ev.delta.text;
      }
    } else if (m.type === "result") {
      if (m.subtype !== "success") {
        throw new Error(`the spirit faltered (${m.subtype})`);
      }
      if (m.is_error) {
        throw new Error(m.result || "the spirit faltered");
      }
      // Fallback if the CLI produced no partial events.
      if (!streamed && m.result) {
        yield m.result;
      }
    }
  }
}
