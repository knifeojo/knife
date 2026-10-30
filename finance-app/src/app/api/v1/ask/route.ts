import { chunkAnswer, listAsk, replyToAsk } from "@/core/ask/mobile";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson({ messages: await listAsk(auth.user.id) });
}

/** POST { question, stream?: boolean }. Affordability never reaches the model. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const question = parsed.body.question;
  if (typeof question !== "string" || !question.trim()) return apiError(400, "Type a question first.");
  if (question.length > 400) return apiError(400, "Ask a shorter question.");
  try {
    const message = await replyToAsk(auth.user.id, question);
    if (parsed.body.stream === true) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const text of chunkAnswer(message.text)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chunk", text })}\n\n`));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", message })}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    return apiJson({ message });
  } catch (e) {
    return apiError(400, e instanceof Error ? e.message : "Could not answer that.");
  }
}
