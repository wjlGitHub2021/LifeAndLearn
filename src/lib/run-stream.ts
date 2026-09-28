export type RunStreamKind = "content" | "reasoning" | "progress" | "done" | "error" | "cancelled";
export type RunStreamEvent = {
  runId: string;
  seq: number;
  kind: RunStreamKind | "snapshot";
  at: number;
  text?: string;
  content?: string;
  reasoning?: string;
  status?: "done" | "error" | "cancelled";
};
type StreamRecord = {
  seq: number;
  events: RunStreamEvent[];
  content: string;
  reasoning: string;
  progress: string;
  status: RunStreamEvent["status"] | null;
  listeners: Set<(event: RunStreamEvent) => void>;
  cleanup: ReturnType<typeof setTimeout> | null;
};

const MAX_STREAMS = 128;
const MAX_EVENTS = 256;
const MAX_TEXT = 12000;
const MAX_SUBSCRIBERS = 8;
const FINISHED_TTL_MS = 5 * 60 * 1000;
const globalStreams = globalThis as typeof globalThis & { __agentRunStreams?: Map<string, StreamRecord> };
const streams = globalStreams.__agentRunStreams ??= new Map<string, StreamRecord>();

export class RunStreamUnavailable extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function append(record: StreamRecord, runId: string, kind: RunStreamKind, text?: string) {
  const event: RunStreamEvent = { runId, seq: ++record.seq, kind, at: Date.now(), ...(text ? { text } : {}) };
  record.events.push(event);
  if (record.events.length > MAX_EVENTS) record.events.shift();
  for (const listener of record.listeners) listener(event);
  return event;
}

export function beginRunStream(runId: string) {
  if (streams.has(runId)) return;
  if (streams.size >= MAX_STREAMS) {
    for (const [id, record] of streams) {
      if (record.status) { if (record.cleanup) clearTimeout(record.cleanup); streams.delete(id); }
      if (streams.size < MAX_STREAMS) break;
    }
  }
  if (streams.size >= MAX_STREAMS) throw new RunStreamUnavailable("同时运行的流过多", 429);
  streams.set(runId, { seq: 0, events: [], content: "", reasoning: "", progress: "", status: null, listeners: new Set(), cleanup: null });
}

export function publishRunEvent(runId: string, kind: "content" | "reasoning" | "progress", text: string) {
  const record = streams.get(runId);
  if (!record || record.status || !text) return false;
  if (kind === "progress") {
    record.progress = text.slice(0, 160);
    append(record, runId, kind, record.progress);
    return true;
  }
  const current = record[kind];
  if (current.length + text.length > MAX_TEXT) return false;
  record[kind] = current + text;
  append(record, runId, kind, text);
  return true;
}

export function finishRunStream(runId: string, status: "done" | "error" | "cancelled", message?: string) {
  const record = streams.get(runId);
  if (!record || record.status) return false;
  record.status = status;
  const safeText = status === "error" ? "运行失败，请查看事项状态" : status === "cancelled" ? "运行已取消" : message?.slice(0, 160);
  append(record, runId, status, safeText);
  record.cleanup = setTimeout(() => { if (streams.get(runId) === record) streams.delete(runId); }, FINISHED_TTL_MS);
  record.cleanup.unref?.();
  return true;
}

export function subscribeRunStream(runId: string, afterSeq = 0, signal?: AbortSignal): ReadableStream<RunStreamEvent> {
  const record = streams.get(runId);
  if (!record) throw new RunStreamUnavailable("运行流不存在或已过期", 404);
  if (record.listeners.size >= MAX_SUBSCRIBERS) throw new RunStreamUnavailable("运行流订阅数已达上限", 429);
  let listener: ((event: RunStreamEvent) => void) | null = null;
  let close = (_cancelled = false) => {};
  return new ReadableStream<RunStreamEvent>({
    start(controller) {
      let closed = false;
      const finish = (cancelled = false) => {
        if (closed) return;
        closed = true;
        if (listener) record.listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
        if (!cancelled) controller.close();
      };
      const onAbort = () => finish();
      close = finish;
      if (signal?.aborted) { finish(); return; }
      listener = event => { if (closed) return; controller.enqueue(event); if (event.kind === "done" || event.kind === "error" || event.kind === "cancelled") finish(); };
      record.listeners.add(listener);
      const replayable = afterSeq > 0 && afterSeq < record.seq && record.events.length > 0 && record.events[0].seq <= afterSeq + 1;
      if (replayable) {
        for (const event of record.events) if (event.seq > afterSeq) listener(event);
      } else {
        controller.enqueue({ runId, seq: record.seq, kind: "snapshot", at: Date.now(), content: record.content, reasoning: record.reasoning, text: record.progress, ...(record.status ? { status: record.status } : {}) });
        if (record.status) finish();
      }
      if (!closed) signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() { close(true); },
  });
}
