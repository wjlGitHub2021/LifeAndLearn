"use client";

import { modelReadyForAgent, type ItemModelSelection, type ModelConnectionStatus } from "./ModelConnectionsPanel";

export function parseItemModelSelection(raw: string): ItemModelSelection | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null) return null;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as ItemModelSelection).connectionId === "string" && typeof (value as ItemModelSelection).model === "string") return value as ItemModelSelection;
  } catch { return { connectionId: "", model: "" }; }
  return { connectionId: "", model: "" };
}

export default function ItemModelPicker({ connection, value, onChange, agents, onOpenConnections, disabled = false }: {
  connection: ModelConnectionStatus | null;
  value: ItemModelSelection | null;
  onChange: (value: ItemModelSelection | null) => void;
  agents: { id: string; name: string }[];
  onOpenConnections: () => void;
  disabled?: boolean;
}) {
  const channels = connection?.channels ?? [];
  const options = channels.filter(channel => channel.connected && channel.models.length);
  const currentValue = value ? JSON.stringify([value.connectionId, value.model]) : "";
  const selectedChannel = value && channels.find(channel => channel.id === value.connectionId);
  const unavailable = !!value && !modelReadyForAgent(connection, null, value);
  const label = (choice: ItemModelSelection) => {
    const channel = channels.find(entry => entry.id === choice.connectionId);
    return channel ? `${channel.name} · ${channel.modelNames[choice.model] || choice.model}` : `${choice.connectionId || "未知渠道"} · ${choice.model || "未知模型"}`;
  };
  return <div className="item-model-picker">
    <label>本事项模型
      <select disabled={disabled} value={currentValue} onChange={event => { const [connectionId, model] = event.target.value ? JSON.parse(event.target.value) as [string, string] : ["", ""]; onChange(connectionId ? { connectionId, model } : null); }}>
        <option value="">跟随参与 Agent 的设置</option>
        {unavailable && <option value={currentValue} disabled>原选择不可用 · {label(value!)}</option>}
        {options.map(channel => <optgroup key={channel.id} label={channel.name}>{channel.models.map(model => <option key={model} value={JSON.stringify([channel.id, model])}>{channel.modelNames[model] || model} ({model}){channel.verified ? "" : " · 生成未验证"}</option>)}</optgroup>)}
      </select>
    </label>
    {value ? <p className="muted" role={unavailable ? "alert" : undefined}>{unavailable ? `「${label(value)}」当前不可用，请重新连接或改选；不会自动换模型。` : `已选 ${label(value)}${selectedChannel?.verified ? "" : " · 生成未验证"}；本事项所有后续模型调用都使用它。`}</p>
      : <p className="muted">{agents.length ? agents.map(agent => { const choice = connection?.assignments[agent.id] ?? connection?.defaultChoice; return `${agent.name}：${choice ? label(choice) : "尚未设置"}`; }).join("；") : `工作区默认：${connection?.defaultChoice ? label(connection.defaultChoice) : "尚未设置"}；选择参与 Agent 后优先使用该 Agent 的设置。`} 后续运行会跟随这些设置。</p>}
    {!options.length && <button type="button" onClick={onOpenConnections}>前往模型连接 →</button>}
  </div>;
}
