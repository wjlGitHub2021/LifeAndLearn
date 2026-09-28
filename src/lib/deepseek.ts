import { channelCurrent, channelState, chosenRoute, ensurePublicEndpoint, invalidateChannelAuth, liveChannel, modelRouterVersion, releaseChannel, setDefaultChoice, trackChannel, type ItemModelChoice } from "./model-connections.ts";
import { PublicError } from "./http.ts";

const BASE = "https://api.deepseek.com";
const SUPPORTED = new Set(["deepseek-flash", "deepseek-v4-pro"]);
const DISPLAY_NAMES: Record<string, string> = { "deepseek-flash": "DeepSeek-V4.1-Flash", "deepseek-v4-pro": "DeepSeek-V4-Pro" };
type Registry = { key: string | null; model: string | null; models: string[]; modelNames: Record<string, string>; version: number; attempt: number; needsReconnect: boolean; validation: AbortController | null; active: Set<AbortController>; runs: Map<string, AbortController>; routes?: WeakMap<AbortController, string>; epoch?: string };
const globalRegistry = globalThis as typeof globalThis & { __agentDeepSeek?: Registry };
const registry: Registry = globalRegistry.__agentDeepSeek ??= { key: null, model: null, models: [], modelNames: {}, version: 0, attempt: 0, needsReconnect: false, validation: null, active: new Set(), runs: new Map() };
registry.modelNames ??= {};
registry.routes ??= new WeakMap();
registry.epoch ??= `${process.pid}-${Date.now()}`;

export class DeepSeekError extends Error {
  code: "auth" | "balance" | "rate" | "service" | "timeout" | "network" | "format" | "stale" | "disconnected";
  constructor(code: DeepSeekError["code"], message: string) { super(message); this.code = code; }
}
function mapped(status: number, name = "DeepSeek") {
  if (status === 401 || status === 403) return new DeepSeekError("auth", `${name} API Key 无效或权限不足，请重新连接`);
  if (status === 402) return new DeepSeekError("balance", `${name} 余额不足，请检查账户额度`);
  if (status === 429) return new DeepSeekError("rate", `${name} 请求过于频繁，请稍后重试`);
  return new DeepSeekError("service", `${name} 服务暂不可用（HTTP ${status}），请稍后重试`);
}
function networkError(error: unknown, name = "DeepSeek"): DeepSeekError {
  if (error instanceof DeepSeekError) return error;
  if (error instanceof PublicError) return new DeepSeekError("network", error.message);
  if (error instanceof Error && error.name === "TimeoutError") return new DeepSeekError("timeout", `${name} 请求超时，请重试`);
  if (error instanceof Error && error.name === "AbortError") return new DeepSeekError("stale", "连接已变化，本次结果已丢弃");
  return new DeepSeekError("network", `无法连接${name}，请检查网络`);
}
function abortRejection(controller: AbortController) {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DeepSeekError("stale", "连接已变化，本次结果已丢弃"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cleanup: () => controller.signal.removeEventListener("abort", onAbort) };
}
export function connectionStatus() {
  const extra = channelState();
  const defaultChoice = extra.defaultChoice ?? (registry.model ? { connectionId: "deepseek", model: registry.model, revision: 0 } : null);
  const selected = defaultChoice && defaultChoice.connectionId !== "deepseek" ? extra.channels.find(entry => entry.id === defaultChoice.connectionId) : null;
  const legacy = { id: "deepseek", name: "DeepSeek", provider: "deepseek" as const, baseUrl: BASE, models: [...registry.models], modelNames: { ...DISPLAY_NAMES, ...registry.modelNames }, verified: !!registry.key, connected: !!registry.key, needsReconnect: registry.needsReconnect };
  return {
    connected: defaultChoice?.connectionId !== "deepseek" && defaultChoice ? !!selected?.connected && selected.models.includes(defaultChoice.model) : !!registry.key,
    needsReconnect: defaultChoice?.connectionId !== "deepseek" && defaultChoice ? !selected?.connected || !selected.models.includes(defaultChoice.model) || !!selected.needsReconnect : registry.needsReconnect,
    model: selected ? defaultChoice?.model ?? null : defaultChoice?.connectionId === "deepseek" ? defaultChoice.model : registry.model,
    models: selected ? selected.models : [...registry.models],
    modelNames: selected ? selected.modelNames : legacy.modelNames,
    version: registry.version + modelRouterVersion(),
    serverEpoch: registry.epoch,
    persistence: "memory" as const,
    channels: [legacy, ...extra.channels],
    defaultChoice,
    assignments: extra.assignments,
  };
}
export async function connect(key: string, fetcher: typeof fetch = fetch) {
  if (!key.trim() || key.length > 512 || /[\r\n]/.test(key)) throw new DeepSeekError("auth", "请输入有效 API Key");
  const attempt = ++registry.attempt;
  registry.validation?.abort();
  const controller = new AbortController();
  registry.validation = controller;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout>;
  const cancelled = abortRejection(controller);
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new DeepSeekError("timeout", "DeepSeek 请求超时，请重试")); }, 10000);
  });
  try {
    const body: unknown = await Promise.race([(async () => {
      const response = await fetcher(`${BASE}/models`, { headers: { Authorization: `Bearer ${key.trim()}` }, signal: controller.signal, redirect: "error", cache: "no-store" });
      if (!response.ok) throw mapped(response.status);
      return response.json();
    })(), deadline, cancelled.promise]);
    if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) throw new DeepSeekError("format", "模型列表格式无效");
    const available = (body as { data: unknown[] }).data.flatMap(item => {
      if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !SUPPORTED.has(item.id)) return [];
      const name = "name" in item && typeof item.name === "string" && item.name.trim().length <= 80 && !/[\r\n]/.test(item.name) ? item.name.trim() : DISPLAY_NAMES[item.id];
      return [{ id: item.id, name }];
    });
    const models = [...new Set(available.map(item => item.id))];
    if (!models.length) throw new DeepSeekError("format", "当前账号没有应用支持的 DeepSeek 模型");
    if (attempt !== registry.attempt) throw new DeepSeekError("stale", "较旧连接请求已取消");
    if (timedOut || controller.signal.aborted) throw new DeepSeekError("timeout", "DeepSeek 请求超时，请重试");
    for (const active of registry.active) active.abort();
    registry.active.clear();
    registry.key = key.trim();
    registry.needsReconnect = false;
    registry.models = models;
    registry.modelNames = Object.fromEntries(available.map(item => [item.id, item.name]));
    registry.model = models.includes(registry.model || "") ? registry.model : models.includes("deepseek-flash") ? "deepseek-flash" : models[0];
    registry.version++;
    return connectionStatus();
  } catch (error) {
    if (attempt !== registry.attempt) throw new DeepSeekError("stale", "较旧连接请求已取消");
    if (timedOut) throw new DeepSeekError("timeout", "DeepSeek 请求超时，请重试");
    throw networkError(error);
  } finally {
    clearTimeout(timeout!);
    cancelled.cleanup();
    if (registry.validation === controller) registry.validation = null;
  }
}
export function selectModel(model: string) {
  if (!registry.key) throw new DeepSeekError("disconnected", "请先连接 DeepSeek");
  if (!registry.models.includes(model)) throw new DeepSeekError("format", "模型不在当前可用列表中");
  registry.model = model;
  const selected = channelState().defaultChoice;
  if (selected?.connectionId === "deepseek" && selected.model !== model) setDefaultChoice("deepseek", model, selected.revision);
  return connectionStatus();
}
export function disconnect() {
  registry.attempt++;
  registry.validation?.abort();
  registry.validation = null;
  for (const active of registry.active) active.abort();
  registry.active.clear();
  registry.key = null;
  registry.needsReconnect = false;
  registry.models = [];
  registry.modelNames = {};
  registry.model = null;
  registry.version++;
  return connectionStatus();
}
function invalidateConnectionFromAuth() {
  for (const active of registry.active) active.abort();
  registry.active.clear();
  registry.key = null;
  registry.model = null;
  registry.models = [];
  registry.modelNames = {};
  registry.needsReconnect = true;
  registry.version++;
}
export function readItemModelChoice(raw: string): ItemModelChoice | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new PublicError("事项模型选择无法读取，请核对本地数据", 409); }
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as ItemModelChoice).connectionId !== "string" || typeof (value as ItemModelChoice).model !== "string") throw new PublicError("事项模型选择无效，请重新选择", 409);
  return value as ItemModelChoice;
}
export function selectableItemModelChoice(input: unknown): ItemModelChoice | null {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublicError("事项模型选择无效");
  const choice = input as Partial<ItemModelChoice>;
  if (typeof choice.connectionId !== "string" || typeof choice.model !== "string" || choice.connectionId.length > 80 || choice.model.length > 160) throw new PublicError("事项模型选择无效");
  const channel = connectionStatus().channels.find(entry => entry.id === choice.connectionId);
  if (!channel || !channel.models.includes(choice.model) || !channel.connected) throw new PublicError("所选模型尚未连接或不可用，请在模型连接中核对", 409);
  return { connectionId: choice.connectionId, model: choice.model };
}
export function beginGeneration(agentId?: string, itemChoice: ItemModelChoice | null = null) {
  const choice = itemChoice ?? chosenRoute(agentId);
  if (choice && choice.connectionId !== "deepseek") {
    const selected = liveChannel(choice);
    const controller = new AbortController();
    trackChannel(selected.connectionId, controller);
    registry.routes!.set(controller, selected.connectionId);
    return { ...selected, controller, modelRecord: selected.recordModel };
  }
  const model = choice?.connectionId === "deepseek" ? choice.model : registry.model;
  if (!registry.key || !model || !registry.models.includes(model)) throw new DeepSeekError("disconnected", "请先连接所选模型渠道");
  const controller = new AbortController();
  registry.active.add(controller);
  return { key: registry.key, model, version: registry.version, controller, baseUrl: BASE, connectionId: "deepseek", modelRecord: model };
}
export function cancelGeneration(controller: AbortController) { controller.abort(); registry.active.delete(controller); const id = registry.routes!.get(controller); if (id) releaseChannel(id, controller); }
export function registerRun(id: string, controller: AbortController) { registry.runs.set(id, controller); }
export function cancelRun(id: string) { const controller = registry.runs.get(id); if (!controller) return false; cancelGeneration(controller); registry.runs.delete(id); return true; }
export function releaseRun(id: string) { registry.runs.delete(id); }
export function generationIsCurrent(version: number, controller: AbortController) { return version === registry.version && !controller.signal.aborted; }
function slotCurrent(slot: ReturnType<typeof beginGeneration>) {
  return slot.connectionId === "deepseek" ? generationIsCurrent(slot.version, slot.controller) : channelCurrent(slot.connectionId, slot.version, slot.controller);
}
export type GenerationDelta = { kind: "content" | "reasoning"; text: string };
const MAX_STREAM_FRAME = 65536;
const MAX_CONTENT = 12000;
const MAX_REASONING = 12000;

async function readCompletionStream(response: Response, slot: ReturnType<typeof beginGeneration>, onDelta: (delta: GenerationDelta) => void): Promise<string> {
  if (!response.body) throw new DeepSeekError("format", "模型没有返回可读取的流");
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  slot.controller.signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let line = "";
  let frame = "";
  let content = "";
  let reasoningLength = 0;
  let finishReason: unknown;
  let done = false;
  let previousWasCR = false;
  const processFrame = () => {
    if (!frame) return;
    const data = frame;
    frame = "";
    if (data === "[DONE]") { done = true; return; }
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { throw new DeepSeekError("format", "模型流式响应格式无效"); }
    if (!chunk || typeof chunk !== "object") throw new DeepSeekError("format", "模型流式响应格式无效");
    if ("error" in chunk && chunk.error) throw new DeepSeekError("service", "模型流式生成中断，请重试");
    const choices = (chunk as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) throw new DeepSeekError("format", "模型流式响应格式无效");
    const choice = choices.find(entry => entry && typeof entry === "object" && "index" in entry && entry.index === 0) as { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown } | undefined;
    if (!choice) return;
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta || typeof delta !== "object") return;
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoning && reasoningLength < MAX_REASONING) {
      const visible = reasoning.slice(0, MAX_REASONING - reasoningLength);
      reasoningLength += visible.length;
      if (!slotCurrent(slot)) throw new DeepSeekError("stale", "连接已变化，本次结果已丢弃");
      if (visible) onDelta({ kind: "reasoning", text: visible });
    }
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      if (content.length > MAX_CONTENT) throw new DeepSeekError("format", "模型输出超过长度上限，成果未保存");
      if (!slotCurrent(slot)) throw new DeepSeekError("stale", "连接已变化，本次结果已丢弃");
      onDelta({ kind: "content", text: delta.content });
    }
  };
  const processLine = () => {
    if (!line) { processFrame(); return; }
    if (line.startsWith("data:")) {
      frame += `${frame ? "\n" : ""}${line.slice(5).replace(/^ /, "")}`;
      if (frame.length > MAX_STREAM_FRAME) throw new DeepSeekError("format", "模型流式响应片段过长");
    }
    line = "";
  };
  const consume = (text: string) => {
    for (const character of text) {
      if (previousWasCR) { previousWasCR = false; if (character === "\n") continue; }
      if (character === "\r" || character === "\n") { processLine(); previousWasCR = character === "\r"; }
      else { line += character; if (line.length > MAX_STREAM_FRAME) throw new DeepSeekError("format", "模型流式响应片段过长"); }
      if (done) return;
    }
  };
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      consume(decoder.decode(part.value, { stream: true }));
    }
    if (!done) { consume(decoder.decode()); if (line) processLine(); processFrame(); }
    if (!done) throw new DeepSeekError("format", "模型流式响应提前中断，成果未保存");
    if (finishReason === "length") throw new DeepSeekError("format", "模型输出达到长度上限，成果未保存；请缩小本次需求后手动重试");
    if (finishReason !== "stop" || !content.trim()) throw new DeepSeekError("format", "模型流式响应未完整结束，成果未保存");
    return content.trim();
  } finally {
    slot.controller.signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function generate(slot: ReturnType<typeof beginGeneration>, messages: { role: "system" | "user"; content: string }[], fetcher: typeof fetch = fetch, maxTokens = 700, onDelta?: (delta: GenerationDelta) => void) {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const thinkingStream = !!onDelta && slot.connectionId === "deepseek";
  const cancelled = abortRejection(slot.controller);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; slot.controller.abort(); reject(new DeepSeekError("timeout", "模型请求超时，请重试")); }, onDelta ? 120000 : 60000);
  });
  try {
    const body: unknown = await Promise.race([(async () => {
      if ("provider" in slot && slot.provider === "custom" && fetcher === fetch) await ensurePublicEndpoint(slot.baseUrl);
      const payload = {
        model: slot.model, messages, stream: !!onDelta,
        ...(slot.connectionId === "deepseek" ? { thinking: { type: thinkingStream ? "enabled" : "disabled" }, ...(thinkingStream ? { reasoning_effort: "low" } : {}) } : {}),
        response_format: { type: "json_object" },
        max_tokens: thinkingStream ? Math.min(16384, Math.max(4096, maxTokens + 2048, maxTokens * 2)) : maxTokens,
      };
      const response = await fetcher(`${slot.baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${slot.key}` }, body: JSON.stringify(payload), signal: slot.controller.signal, redirect: "error", cache: "no-store" });
      if (response.status === 400 && slot.connectionId !== "deepseek") throw new DeepSeekError("format", "该渠道拒绝 JSON 格式请求；请选择支持 Chat Completions JSON 输出的模型");
      if (!response.ok) throw mapped(response.status, slot.connectionId === "deepseek" ? "DeepSeek" : "模型渠道");
      return onDelta ? readCompletionStream(response, slot, onDelta) : response.json();
    })(), deadline, cancelled.promise]);
    if (onDelta) {
      if (typeof body !== "string") throw new DeepSeekError("format", "模型流式响应格式无效");
      if (!slotCurrent(slot)) throw new DeepSeekError("stale", "连接已变化，本次结果已丢弃");
      return body;
    }
    const choice = (body as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })?.choices?.[0];
    if (choice?.finish_reason === "length") throw new DeepSeekError("format", "模型输出达到长度上限，成果未保存；请缩小本次需求后手动重试");
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim() || content.length > 12000) throw new DeepSeekError("format", "模型返回内容格式无效");
    if (!slotCurrent(slot)) throw new DeepSeekError("stale", "连接已变化，本次结果已丢弃");
    return content.trim();
  } catch (error) {
    if (error instanceof DeepSeekError && error.code === "auth" && slotCurrent(slot)) {
      if (slot.connectionId === "deepseek") invalidateConnectionFromAuth();
      else invalidateChannelAuth(slot.connectionId);
      throw error;
    }
    if (timedOut && (slot.connectionId === "deepseek" ? slot.version === registry.version : channelCurrent(slot.connectionId, slot.version))) throw new DeepSeekError("timeout", "模型请求超时，请重试");
    if (!slotCurrent(slot)) throw new DeepSeekError("stale", "连接已变化，本次结果已丢弃");
    throw networkError(error, slot.connectionId === "deepseek" ? "DeepSeek" : "模型渠道");
  } finally {
    clearTimeout(timer!);
    cancelled.cleanup();
    registry.active.delete(slot.controller);
    if (slot.connectionId !== "deepseek") releaseChannel(slot.connectionId, slot.controller);
  }
}
