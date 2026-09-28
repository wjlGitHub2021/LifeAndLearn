"use client";

import { useEffect, useState } from "react";
import RichText from "./RichText";
import { streamedTextField } from "../lib/stream-preview";

type StreamEvent = {
  runId: string;
  seq: number;
  kind: "snapshot" | "content" | "reasoning" | "progress" | "done" | "error" | "cancelled";
  text?: string;
  content?: string;
  reasoning?: string;
  status?: "done" | "error" | "cancelled";
};

export default function RunLivePreview({ runId, field = "content" }: { runId: string; field?: "content" | "question" | "feedback" }) {
  const [stream, setStream] = useState({ content: "", reasoning: "", progress: "正在连接模型…", status: "running" });
  const [reasoningOpen, setReasoningOpen] = useState(true);
  useEffect(() => {
    setStream({ content: "", reasoning: "", progress: "正在连接模型…", status: "running" });
    setReasoningOpen(true);
    const source = new EventSource(`/api/run-stream?runId=${encodeURIComponent(runId)}`);
    let lastSeq = -1;
    source.onmessage = message => {
      let event: StreamEvent;
      try { event = JSON.parse(message.data) as StreamEvent; }
      catch { return; }
      if (event.runId !== runId || event.seq < lastSeq || (event.seq === lastSeq && event.kind !== "snapshot")) return;
      lastSeq = event.seq;
      setStream(current => {
        if (event.kind === "snapshot") return { content: event.content || "", reasoning: event.reasoning || "", progress: event.text || "模型正在生成…", status: event.status || "running" };
        if (event.kind === "content") return { ...current, content: current.content + (event.text || "") };
        if (event.kind === "reasoning") return { ...current, reasoning: current.reasoning + (event.text || "") };
        if (event.kind === "progress") return { ...current, progress: event.text || current.progress };
        return { ...current, status: event.kind, progress: event.text || current.progress };
      });
      if (["done", "error", "cancelled"].includes(event.kind) || event.status) source.close();
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setStream(current => current.status === "running" ? { ...current, progress: "实时连接已中断，事项状态仍会更新" } : current);
    };
    return () => source.close();
  }, [runId]);

  const preview = streamedTextField(stream.content, field);
  const title = field === "question" ? "正在准备题目" : field === "feedback" ? "正在生成反馈" : "正在生成成果";
  return <section className="wb2-live-preview" aria-label={title}>
    <div className="row spread"><strong>{title}</strong><span className="muted" role="status">{stream.status === "running" ? stream.progress : stream.status === "done" ? "已生成，等待成果校验与刷新" : stream.progress}</span></div>
    {preview ? <div className="wb2-live-draft"><p className="muted">实时草稿 · 完成校验后才会保存为正式内容</p><RichText text={preview} /></div> : <p className="muted">模型正文到达后会显示在这里。</p>}
    {stream.reasoning && <details className="wb2-live-reasoning" open={reasoningOpen} onToggle={event => setReasoningOpen(event.currentTarget.open)}><summary>模型返回的思考内容</summary><RichText text={stream.reasoning} /></details>}
    {!stream.reasoning && stream.status !== "running" && <p className="muted">本次模型没有返回可展示的思考内容。</p>}
  </section>;
}
