import type { ChatContext } from "@/lib/chat/context";
import { fallbackAnswer } from "@/lib/chat/fallback";
import { systemPrompt, ungroundedPins } from "@/lib/chat/grounding";
// The server's own copy, so a request cannot rewrite the ground truth.
import { PINOUTS } from "@/lib/pinouts";
import type { Pinout } from "@/lib/types";

const ENDPOINT = "https://api.featherless.ai/v1/chat/completions";
const DEFAULT_MODEL = "Qwen/Qwen2.5-7B-Instruct";
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_TURNS = 6;
// A sketch needs more room than a short answer.
const MAX_ANSWER_TOKENS = 700;

interface ChatRequest {
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
  context: ChatContext;
}

function fallback(question: string, context: ChatContext, pinout: Pinout | null, notice: string) {
  return Response.json({ answer: fallbackAnswer(question, context, pinout), source: "rules", notice });
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const question = String(body.question ?? "").slice(0, MAX_QUESTION_CHARS).trim();
  const context = body.context;
  if (!question || !context) return Response.json({ error: "question and context are required" }, { status: 400 });
  const pinout = context.boardId ? (PINOUTS[context.boardId] ?? null) : null;

  const apiKey = process.env.FEATHERLESS_API_KEY;
  if (!apiKey) return fallback(question, context, pinout, "AI is not configured, so this comes from the rule engine.");

  const timeout = Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const history = (body.history ?? [])
    .slice(-MAX_HISTORY_TURNS)
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({ role: turn.role, content: String(turn.content).slice(0, MAX_QUESTION_CHARS) }));

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-Title": "VisionGuard" },
      body: JSON.stringify({
        model: process.env.FEATHERLESS_MODEL || DEFAULT_MODEL,
        messages: [{ role: "system", content: systemPrompt(context, pinout) }, ...history, { role: "user", content: question }],
        max_tokens: MAX_ANSWER_TOKENS,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      console.error("Featherless returned", response.status, await response.text().catch(() => ""));
      return fallback(question, context, pinout, "The AI service returned an error, so this comes from the rule engine.");
    }
    const data = await response.json();
    const answer: string = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!answer) return fallback(question, context, pinout, "The AI service sent an empty reply, so this comes from the rule engine.");

    const invented = ungroundedPins(answer, pinout, question);
    if (invented.length) {
      console.warn("Blocked an answer naming pins not on the board:", invented);
      return fallback(question, context, pinout, `The AI named pins that are not on this board (${invented.join(", ")}), so its answer was discarded.`);
    }
    return Response.json({ answer, source: "llm" });
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    if (!timedOut) console.error("Featherless request failed", error);
    return fallback(question, context, pinout, timedOut ? "The AI took too long, so this comes from the rule engine." : "The AI service could not be reached, so this comes from the rule engine.");
  }
}
