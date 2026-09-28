"use client";

import { useState } from "react";
import styles from "./ModelConnectionsPanel.module.css";

export type ModelConnection = {
  id: string;
  name: string;
  provider: "deepseek" | "openai" | "openrouter" | "custom";
  baseUrl: string;
  models: string[];
  modelNames: Record<string, string>;
  verified: boolean;
  connected: boolean;
  needsReconnect: boolean;
};
export type ModelChoice = { connectionId: string; model: string; revision: number };
export type ItemModelSelection = Pick<ModelChoice, "connectionId" | "model">;
export type ModelConnectionStatus = {
  connected: boolean;
  needsReconnect: boolean;
  model: string | null;
  models: string[];
  modelNames: Record<string, string>;
  version: number;
  serverEpoch: string;
  channels: ModelConnection[];
  defaultChoice: ModelChoice | null;
  assignments: Record<string, ModelChoice | null>;
  assignmentRevisions: Record<string, number>;
};
export function modelReadyForAgent(status: ModelConnectionStatus | null, agentId: string | null | undefined, itemChoice: ItemModelSelection | null = null): boolean {
  if (!status) return false;
  const choice = itemChoice ?? (agentId ? status.assignments[agentId] : null) ?? status.defaultChoice;
  if (!choice) return false;
  return status.channels.some(channel => channel.id === choice.connectionId && channel.connected && channel.models.includes(choice.model));
}
type Props = {
  connection: ModelConnectionStatus | null;
  keyInput: string;
  onKeyInputChange: (value: string) => void;
  onAction: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  notice: string;
  headingLevel?: 1 | 3;
};
const presets = {
  openai: { name: "OpenAI", url: "https://api.openai.com/v1" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  custom: { name: "自定义渠道", url: "" },
} as const;

export default function ModelConnectionsPanel({ connection, keyInput, onKeyInputChange, onAction, busy, notice, headingLevel = 3 }: Props) {
  const [provider, setProvider] = useState<keyof typeof presets>("openai");
  const [name, setName] = useState<string>(presets.openai.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [manualModels, setManualModels] = useState("");
  const [reconnectId, setReconnectId] = useState("");
  const [reconnectKey, setReconnectKey] = useState("");
  const channels = connection?.channels ?? [];
  const deepseek = channels.find(entry => entry.id === "deepseek");
  const configured = channels.filter(entry => entry.id !== "deepseek");
  const online = channels.filter(entry => entry.connected).length;
  const defaultValue = connection?.defaultChoice ? JSON.stringify([connection.defaultChoice.connectionId, connection.defaultChoice.model]) : "";
  const defaultMissing = !!connection?.defaultChoice && !channels.some(entry => entry.id === connection.defaultChoice?.connectionId && entry.models.includes(connection.defaultChoice.model));
  const Heading = headingLevel === 1 ? "h1" : "h3";

  return <section aria-labelledby="settings-connection-title">
    <div className={styles.heading}>
      <span className={styles.eyebrow}>MODEL CONNECTIONS</span>
      <Heading id="settings-connection-title">模型连接</Heading>
      <p>先连接渠道并取得该凭据可见的模型，再为工作区和各 Agent 选择模型。只有手动启动运行时才会发送事项输入。</p>
    </div>
    <div className={styles.summary}><strong>{online} 个渠道已连接</strong><span>API Key 只保存在本地后端进程内存中；重启后需逐个重新连接。渠道名称、地址、模型清单和 Agent 选择保存在本地数据库。</span></div>
    {notice && <p className={styles.notice} role="status">{notice}</p>}

    <div className={styles.block}>
      <h4>DeepSeek</h4>
      <p>现有连接继续可用，官方地址固定。旧事项和未单独指定模型的 Agent 可沿用这个默认渠道。</p>
      <p className={styles.state}>{deepseek?.connected ? `已连接 · ${deepseek.models.length} 个模型` : deepseek?.needsReconnect ? "需重新连接" : "未连接"}</p>
      <label htmlFor="model-deepseek-key">{deepseek?.connected ? "替换 DeepSeek API Key" : "DeepSeek API Key"}</label>
      <input id="model-deepseek-key" type="password" autoComplete="off" value={keyInput} onChange={event => onKeyInputChange(event.target.value)} placeholder="仅在本地页面输入" />
      <div className={styles.actions}><button type="button" disabled={busy || !keyInput.trim()} onClick={() => void onAction({ type: "connect", key: keyInput }).then(ok => { if (ok) onKeyInputChange(""); })}>验证并连接</button>{deepseek?.connected && <button type="button" disabled={busy} onClick={() => void onAction({ type: "disconnect" })}>断开</button>}</div>
      {!!deepseek?.models.length && <p className={styles.models}>可选模型：{deepseek.models.map(model => deepseek.modelNames[model] || model).join("、")}</p>}
    </div>

    {configured.map(channel => <div className={styles.block} key={channel.id}>
      <div className={styles.cardTitle}><h4>{channel.name}</h4><span className={styles.state}>{channel.connected ? "已连接" : channel.needsReconnect ? "需重新连接" : "未连接"}</span></div>
      <p className={styles.url}>{channel.baseUrl}</p>
      <p>{channel.models.length} 个模型{channel.verified ? " · 已从渠道取得模型列表" : " · 手动模型，尚未验证生成"}</p>
      <div className={styles.actions}>{channel.connected ? <button type="button" disabled={busy} onClick={() => void onAction({ type: "channel.disconnect", id: channel.id })}>断开并保留配置</button> : <button type="button" onClick={() => { setReconnectId(channel.id); setReconnectKey(""); }}>重新连接</button>}</div>
      {reconnectId === channel.id && !channel.connected && <div className={styles.reconnect}><label htmlFor={`reconnect-${channel.id}`}>输入 {channel.name} 的 API Key</label><input id={`reconnect-${channel.id}`} type="password" autoComplete="off" value={reconnectKey} onChange={event => setReconnectKey(event.target.value)} /><div className={styles.actions}><button type="button" disabled={busy || !reconnectKey.trim()} onClick={() => void onAction({ type: "channel.connect", id: channel.id, key: reconnectKey }).then(ok => { if (ok) { setReconnectKey(""); setReconnectId(""); } })}>验证并连接</button><button type="button" onClick={() => { setReconnectId(""); setReconnectKey(""); }}>取消</button></div></div>}
    </div>)}

    <div className={styles.block}>
      <h4>添加渠道</h4>
      <label htmlFor="model-provider">渠道类型</label>
      <select id="model-provider" value={provider} onChange={event => { const next = event.target.value as keyof typeof presets; setProvider(next); setName(presets[next].name); setBaseUrl(""); }}><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option><option value="custom">自定义 OpenAI 兼容接口</option></select>
      <label htmlFor="model-channel-name">连接名称</label><input id="model-channel-name" maxLength={60} value={name} onChange={event => setName(event.target.value)} />
      <label htmlFor="model-base-url">API 基础地址</label><input id="model-base-url" value={provider === "custom" ? baseUrl : presets[provider].url} onChange={event => setBaseUrl(event.target.value)} readOnly={provider !== "custom"} placeholder="https://可信渠道.example/v1" />
      <p>自定义渠道仅接受可信的公网 HTTPS 地址，并使用 OpenAI Chat Completions 协议。API Key 会发给上方地址；请确认地址属于你信任的服务商。</p>
      <label htmlFor="model-channel-key">API Key</label><input id="model-channel-key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="不会写入数据库或浏览器存储" />
      <label htmlFor="model-manual-ids">手动模型标识（可留空）</label><input id="model-manual-ids" value={manualModels} onChange={event => setManualModels(event.target.value)} placeholder="仅在渠道没有 /models 接口时填写，逗号分隔" />
      <p>先读取此 Key 下的 /models 列表；若接口返回 404/405，可使用手动标识，实际能否生成需运行验证。模型须支持 JSON 格式输出。</p>
      <button type="button" disabled={busy || !key.trim() || !name.trim() || provider === "custom" && !baseUrl.trim()} onClick={() => void onAction({ type: "channel.connect", name, provider, baseUrl: provider === "custom" ? baseUrl : presets[provider].url, key, manualModels }).then(ok => { if (ok) { setKey(""); setManualModels(""); } })}>验证并添加渠道</button>
    </div>

    <div className={styles.block}>
      <h4>工作区默认模型</h4>
      <p>未单独指定模型的 Agent 使用这里的选择；修改只影响后续运行，不改历史成果，也不会自动回退到其他渠道。</p>
      <label htmlFor="model-default">默认渠道与模型</label>
      <select id="model-default" value={defaultValue} disabled={busy || !channels.some(entry => entry.models.length)} onChange={event => { const [connectionId, model] = JSON.parse(event.target.value) as [string, string]; void onAction({ type: "default.select", connectionId, model, expectedRevision: connection?.defaultChoice?.revision ?? 0 }); }}>
        <option value="">{channels.some(entry => entry.models.length) ? "选择默认模型" : "请先连接渠道"}</option>
        {defaultMissing && <option value={defaultValue} disabled>原默认模型已不可用，请重新选择</option>}
        {channels.flatMap(channel => channel.models.map(model => <option key={`${channel.id}:${model}`} value={JSON.stringify([channel.id, model])}>{channel.name} · {channel.modelNames[model] || model} ({model}){channel.connected ? "" : " · 需重连"}</option>))}
      </select>
      <p>每位 Agent 可在「Agent 团队」概览中覆盖默认模型。</p>
    </div>

    <p className={styles.boundary}>账号登录是各渠道独立的授权和计费流程。本地应用当前没有可通用复用的厂商登录授权；ChatGPT 等产品订阅也不等于 API 额度，因此这里仅提供 API Key 连接，不显示无法完成的登录按钮。</p>
  </section>;
}
