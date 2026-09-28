import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { getDatabase } from "./store.ts";
import { PublicError } from "./http.ts";

export type Channel = {
  id: string;
  name: string;
  provider: "openai" | "openrouter" | "custom";
  baseUrl: string;
  models: string[];
  modelNames: Record<string, string>;
  verified: boolean;
};
export type ModelChoice = { connectionId: string; model: string; revision: number };
export type ItemModelChoice = Pick<ModelChoice, "connectionId" | "model">;
type Runtime = { key: string | null; version: number; attempt: number; validation: AbortController | null; active: Set<AbortController>; needsReconnect: boolean };
type Registry = { channels: Map<string, Runtime>; version: number };
const globalRegistry = globalThis as typeof globalThis & { __agentModelChannels?: Registry };
const registry = globalRegistry.__agentModelChannels ??= { channels: new Map(), version: 0 };
const CATALOG_KEY = "model.connections.v1";
const DEFAULT_KEY = "model.default.v1";
const ASSIGNMENT_PREFIX = "model.agent.v1.";
const presets = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;

function setting(key: string): string | null {
  return (getDatabase().prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
}
function saveSetting(key: string, value: string) {
  getDatabase().prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  registry.version++;
}
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
function catalog(): Channel[] { return parseJson<Channel[]>(setting(CATALOG_KEY), []); }
function runtime(id: string): Runtime {
  let value = registry.channels.get(id);
  if (!value) { value = { key: null, version: 0, attempt: 0, validation: null, active: new Set(), needsReconnect: false }; registry.channels.set(id, value); }
  return value;
}
function modelId(raw: string): string {
  const id = raw.trim();
  if (!id || id.length > 160 || !/^[\w./:-]+$/.test(id)) throw new PublicError("模型标识格式错误");
  return id;
}
function manualModels(raw: string): string[] {
  if (raw.length > 4000) throw new PublicError("手动模型列表过长");
  return [...new Set(raw.split(/[\s,，]+/u).filter(Boolean).map(modelId))].slice(0, 30);
}
function safeBaseUrl(raw: string, provider: Channel["provider"]): string {
  if (provider !== "custom") return presets[provider];
  if (raw.length > 300) throw new PublicError("接口地址过长");
  let url: URL;
  try { url = new URL(raw); } catch { throw new PublicError("请输入有效的 HTTPS 接口地址"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") || !host.includes(".") || /^(localhost|.*\.(?:localhost|local|internal|test|invalid|example))$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) throw new PublicError("自定义接口须为可信的公网 HTTPS 地址，且不可包含凭据、查询参数或本机地址");
  if (url.pathname.length > 120 || /\/(?:models|chat\/completions)\/?$/i.test(url.pathname)) throw new PublicError("请填写接口基础地址，不要填写模型或生成接口路径");
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}
function validateKey(key: string) {
  if (!key.trim() || key.length > 512 || /[\r\n]/.test(key)) throw new PublicError("请输入有效 API Key");
  return key.trim();
}
function failure(status: number) {
  if (status === 401 || status === 403) return new PublicError("API Key 无效或无权读取模型列表", 401);
  if (status === 429) return new PublicError("渠道请求过于频繁，请稍后重试", 429);
  return new PublicError(`模型列表请求失败（HTTP ${status}）`, 400);
}
function abortAll(value: Runtime) { for (const controller of value.active) controller.abort(); value.active.clear(); }
function privateAddress(address: string) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7));
    return normalized === "::" || normalized === "::1" || /^(?:fc|fd|fe[89ab]|ff)/.test(normalized) || normalized.startsWith("2001:db8:");
  }
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && c === 0 || b === 0 && c === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113;
}
export async function ensurePublicEndpoint(baseUrl: string) {
  const host = new URL(baseUrl).hostname;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PublicError("接口地址解析超时", 408)), 3000); }),
    ]);
    if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) throw new PublicError("接口地址解析到本机或内网，已拒绝发送 API Key", 400);
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError("无法解析模型渠道地址");
  } finally { if (timer) clearTimeout(timer); }
}

export function channelState() {
  const assignments = (getDatabase().prepare("SELECT key,value FROM settings WHERE key LIKE ?").all(`${ASSIGNMENT_PREFIX}%`) as { key: string; value: string }[])
    .map(entry => [entry.key.slice(ASSIGNMENT_PREFIX.length), parseJson<ModelChoice | null>(entry.value, null)] as const);
  return {
    channels: catalog().map(entry => ({ ...entry, connected: !!registry.channels.get(entry.id)?.key, needsReconnect: !!registry.channels.get(entry.id)?.needsReconnect })),
    defaultChoice: parseJson<ModelChoice | null>(setting(DEFAULT_KEY), null),
    assignments: Object.fromEntries(assignments.map(([id, choice]) => [id, choice?.connectionId ? choice : null])),
    assignmentRevisions: Object.fromEntries(assignments.map(([id, choice]) => [id, choice?.revision ?? 0])),
    channelVersion: registry.version,
  };
}

export async function connectChannel(input: { id?: string; name?: string; provider?: Channel["provider"]; baseUrl?: string; key: string; manualModels?: string }, fetcher: typeof fetch = fetch) {
  const previous = input.id ? catalog().find(entry => entry.id === input.id) : undefined;
  if (input.id && !previous) throw new PublicError("连接配置不存在", 404);
  const provider = previous?.provider ?? input.provider;
  if (provider !== "openai" && provider !== "openrouter" && provider !== "custom") throw new PublicError("不支持此渠道类型");
  const name = previous?.name ?? input.name?.trim();
  if (!name || name.length > 60 || /[\r\n]/.test(name)) throw new PublicError("请输入连接名称");
  const baseUrl = safeBaseUrl(previous?.baseUrl ?? input.baseUrl ?? "", provider);
  const key = validateKey(input.key);
  const manual = manualModels(input.manualModels ?? "");
  const id = previous?.id ?? randomUUID();
  const current = runtime(id);
  const attempt = ++current.attempt;
  current.validation?.abort();
  const controller = new AbortController();
  current.validation = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new PublicError("较旧连接请求已取消", 409));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new PublicError("模型列表请求超时", 408)); }, 10000); });
    const found = await Promise.race([(async () => {
      if (provider === "custom" && fetcher === fetch) await ensurePublicEndpoint(baseUrl);
      const response = await fetcher(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal, redirect: "error", cache: "no-store" });
      if ((response.status === 404 || response.status === 405) && manual.length) return { models: manual, modelNames: {} as Record<string, string>, verified: false };
      if (!response.ok) throw failure(response.status);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) throw new PublicError("模型列表格式无效");
      const entries = (body as { data: unknown[] }).data.flatMap(value => {
        if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") return [];
        try {
          const id = modelId((value as { id: string }).id);
          const rawName = (value as { name?: unknown }).name;
          const display = typeof rawName === "string" && rawName.trim().length <= 80 && !/[\r\n]/.test(rawName) ? rawName.trim() : id;
          return [{ id, display }];
        } catch { return []; }
      }).slice(0, 500);
      const models = [...new Set([...entries.map(entry => entry.id), ...manual])];
      if (!models.length) throw new PublicError("该渠道未返回可用模型，可填写手动模型标识再验证");
      return { models, modelNames: Object.fromEntries(entries.map(entry => [entry.id, entry.display])), verified: manual.every(id => entries.some(entry => entry.id === id)) };
    })(), deadline, aborted]);
    if (attempt !== current.attempt || controller.signal.aborted) throw new PublicError("较旧连接请求已取消", 409);
    const entry: Channel = { id, name, provider, baseUrl, ...found };
    const saved = catalog();
    const index = saved.findIndex(item => item.id === id);
    if (index < 0) saved.push(entry); else saved[index] = entry;
    saveSetting(CATALOG_KEY, JSON.stringify(saved));
    abortAll(current);
    current.key = key;
    current.needsReconnect = false;
    current.version++;
    return entry;
  } catch (error) {
    if (attempt !== current.attempt) throw new PublicError("较旧连接请求已取消", 409);
    if (timedOut) throw new PublicError("模型列表请求超时", 408);
    if (error instanceof PublicError) throw error;
    if (controller.signal.aborted) throw new PublicError("模型列表请求超时或已取消", 408);
    throw new PublicError("无法连接模型渠道，请检查地址和网络");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    if (current.validation === controller) current.validation = null;
  }
}

export function disconnectChannel(id: string) {
  if (!catalog().some(entry => entry.id === id)) throw new PublicError("连接配置不存在", 404);
  const current = runtime(id);
  current.attempt++;
  current.validation?.abort();
  current.validation = null;
  abortAll(current);
  current.key = null;
  current.needsReconnect = false;
  current.version++;
  registry.version++;
}
export function invalidateChannelAuth(id: string) {
  const current = runtime(id);
  abortAll(current);
  current.key = null;
  current.needsReconnect = true;
  current.version++;
  registry.version++;
}
function assertChoice(connectionId: string, model: string) {
  if (connectionId === "deepseek") return;
  const channel = catalog().find(entry => entry.id === connectionId);
  if (!channel || !channel.models.includes(model)) throw new PublicError("所选模型不在该连接的可用列表中", 409);
}
export function setDefaultChoice(connectionId: string, model: string, expectedRevision: number) {
  assertChoice(connectionId, model);
  const previous = parseJson<ModelChoice | null>(setting(DEFAULT_KEY), null);
  if ((previous?.revision ?? 0) !== expectedRevision) throw new PublicError("默认模型已变化，请刷新后核对", 409);
  const value: ModelChoice = { connectionId, model, revision: expectedRevision + 1 };
  saveSetting(DEFAULT_KEY, JSON.stringify(value));
  return value;
}
export function setAgentChoice(agentId: string, connectionId: string | null, model: string | null, expectedRevision: number) {
  const agent = getDatabase().prepare("SELECT 1 FROM agent_profiles WHERE id=?").get(agentId);
  if (!agent) throw new PublicError("Agent 不存在", 404);
  const key = `${ASSIGNMENT_PREFIX}${agentId}`;
  const previous = parseJson<ModelChoice | null>(setting(key), null);
  if ((previous?.revision ?? 0) !== expectedRevision) throw new PublicError("Agent 模型选择已变化，请刷新后核对", 409);
  if (!connectionId || !model) {
    saveSetting(key, JSON.stringify({ connectionId: "", model: "", revision: expectedRevision + 1 }));
    return null;
  }
  assertChoice(connectionId, model);
  const value: ModelChoice = { connectionId, model, revision: expectedRevision + 1 };
  saveSetting(key, JSON.stringify(value));
  return value;
}
export function chosenRoute(agentId?: string) {
  const choice = agentId ? parseJson<ModelChoice | null>(setting(`${ASSIGNMENT_PREFIX}${agentId}`), null) : null;
  return choice?.connectionId ? choice : parseJson<ModelChoice | null>(setting(DEFAULT_KEY), null);
}
export function liveChannel(choice: ItemModelChoice) {
  const entry = catalog().find(item => item.id === choice.connectionId);
  const current = registry.channels.get(choice.connectionId);
  if (!entry || !entry.models.includes(choice.model)) throw new PublicError("所选渠道或模型已不可用，请重新选择", 409);
  if (!current?.key) throw new PublicError(`模型渠道「${entry.name}」需重新连接`, 409);
  return { key: current.key, model: choice.model, baseUrl: entry.baseUrl, provider: entry.provider, connectionId: entry.id, version: current.version, recordModel: `${entry.name} · ${choice.model}` };
}
export function trackChannel(id: string, controller: AbortController) { runtime(id).active.add(controller); }
export function releaseChannel(id: string, controller: AbortController) { registry.channels.get(id)?.active.delete(controller); }
export function channelCurrent(id: string, version: number, controller?: AbortController) { return registry.channels.get(id)?.version === version && !controller?.signal.aborted; }
export function modelRouterVersion() { return registry.version; }
