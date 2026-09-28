import { guard, PublicError, respondError, str } from "../../../lib/http.ts";
import { RunStreamUnavailable, subscribeRunStream, type RunStreamEvent } from "../../../lib/run-stream.ts";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    guard(request);
    const url = new URL(request.url);
    const runId = str(url.searchParams.get("runId"), "运行标识", 80);
    if (!/^[\w-]+$/.test(runId)) throw new PublicError("运行标识格式错误");
    const rawAfter = request.headers.get("last-event-id") || url.searchParams.get("after") || "0";
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) throw new PublicError("事件序号无效");
    let events: ReadableStream<RunStreamEvent>;
    try { events = subscribeRunStream(runId, after, request.signal); }
    catch (error) { if (error instanceof RunStreamUnavailable) throw new PublicError(error.message, error.status); throw error; }
    const reader = events.getReader();
    const encoder = new TextEncoder();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, 15000);
        heartbeat.unref?.();
        void (async () => {
          try {
            while (!closed) {
              const next = await reader.read();
              if (next.done) break;
              controller.enqueue(encoder.encode(`id: ${next.value.seq}\ndata: ${JSON.stringify(next.value)}\n\n`));
            }
          } catch (error) {
            if (!closed) { closed = true; controller.error(error); }
          } finally {
            clearInterval(heartbeat);
            if (!closed) { closed = true; controller.close(); }
            reader.releaseLock();
          }
        })();
      },
      cancel() { closed = true; clearInterval(heartbeat); void reader.cancel().catch(() => {}); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return respondError(error); }
}
