"use client";

import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MAX_DIAGRAM_LENGTH = 12000;
let mermaidLoader: Promise<typeof import("mermaid")["default"]> | null = null;

function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, maxTextSize: MAX_DIAGRAM_LENGTH, maxEdges: 100, flowchart: { htmlLabels: false } });
      return mermaid;
    }).catch(error => {
      mermaidLoader = null;
      throw error;
    });
  }
  return mermaidLoader;
}

function MermaidDiagram({ source }: { source: string }) {
  const container = useRef<HTMLElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setUrl(null);
    setError(false);
    if (!visible || source.length > MAX_DIAGRAM_LENGTH) return;
    let active = true;
    let objectUrl: string | null = null;
    const diagramId = `rich-diagram-${id}`;
    const removeStrays = () => {
      document.getElementById(`d${diagramId}`)?.remove();
      document.getElementById(`i${diagramId}`)?.remove();
    };
    loadMermaid().then(async mermaid => {
      if (!active) return null;
      const renderHost = document.createElement("div");
      renderHost.style.cssText = "position:absolute;left:-10000px;top:0;width:1000px;pointer-events:none";
      document.body.appendChild(renderHost);
      try { return await mermaid.render(diagramId, source, renderHost); }
      finally {
        renderHost.remove();
        removeStrays();
      }
    }).then(result => {
      if (!active || !result) return;
      objectUrl = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
      setUrl(objectUrl);
      setError(false);
    }).catch(() => { removeStrays(); requestAnimationFrame(removeStrays); if (active) setError(true); });
    return () => { active = false; removeStrays(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, source, visible]);

  const failed = error || source.length > MAX_DIAGRAM_LENGTH;
  return <figure ref={container} className="rich-diagram">
    {url && <img src={url} alt="流程图；下方可查看图表源码" />}
    {!url && !failed && <p role="status">正在绘制流程图…</p>}
    {failed && <p role="status">流程图未能绘制，请检查下方源码。</p>}
    <details open={failed}><summary>查看图表源码</summary><pre>{source}</pre></details>
  </figure>;
}

function codeBlock(children: ReactNode) {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child) || child.props.className !== "language-mermaid") return null;
  return String(child.props.children ?? "").replace(/\n$/, "");
}

function readableChoices(text: string) {
  let fenced = false;
  const lines = text.split("\n");
  const formatted: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; formatted.push(line); continue; }
    const choices = lines.slice(index, index + 4).map((entry, offset) => entry.match(new RegExp(`^${String.fromCharCode(65 + offset)}[.．、]\\s+(.+)$`)));
    if (!fenced && choices.length === 4 && choices.every(Boolean)) {
      formatted.push("", ...choices.map((match, offset) => `- **${String.fromCharCode(65 + offset)}.** ${match?.[1]}`), "");
      index += 3;
      continue;
    }
    if (fenced || !/(?:^|\s)A[.．、]\s+.+\s+B[.．、]\s+.+\s+C[.．、]\s+.+\s+D[.．、]\s+/.test(line)) { formatted.push(line); continue; }
    formatted.push(line.replace(/\s+([A-D])[.．、]\s+/g, (_match, label: string) => `${label === "A" ? "\n\n" : "\n"}- **${label}.** `).replace(/\s+(答案[：:]|解析[：:])/g, "\n\n$1"));
  }
  return formatted.join("\n");
}

export default function RichText({ text, className = "" }: { text: string | null | undefined; className?: string }) {
  return <div className={`rich-text ${className}`.trim()}>
    <Markdown remarkPlugins={[remarkGfm]} components={{
      pre({ children }) {
        const source = codeBlock(children);
        return source !== null ? <MermaidDiagram source={source} /> : <pre>{children}</pre>;
      },
      a({ href, children }) { return href ? <a href={href}>{children}</a> : <span>{children}</span>; },
      img({ alt }) { return <span className="rich-image-placeholder">[图片：{alt || "未命名"}]</span>; },
    }}>{readableChoices(text || "")}</Markdown>
  </div>;
}

export function MarkdownPreview({ text }: { text: string | null | undefined }) {
  if (!text?.trim()) return null;
  return <details className="rich-preview"><summary>预览 Markdown 与流程图</summary><RichText text={text} /></details>;
}
