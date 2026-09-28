import { connect, connectionStatus, DeepSeekError, disconnect, selectModel } from "../../../lib/deepseek.ts";
import { connectChannel, disconnectChannel, setAgentChoice, setDefaultChoice } from "../../../lib/model-connections.ts";
import { guard, jsonBody, number, PublicError, respondError, str } from "../../../lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  try { guard(request); return Response.json(connectionStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try {
    guard(request, true);
    const body = await jsonBody(request);
    const type = str(body.type, "操作", 20);
    if (type === "connect") {
      const key = str(body.key, "API Key", 512);
      return Response.json(await connect(key), { headers: { "Cache-Control": "no-store" } });
    }
    if (type === "select") return Response.json(selectModel(str(body.model, "模型", 80)), { headers: { "Cache-Control": "no-store" } });
    if (type === "disconnect") return Response.json(disconnect(), { headers: { "Cache-Control": "no-store" } });
    if (type === "channel.connect") {
      const before = connectionStatus();
      const added = await connectChannel({
        id: body.id === undefined ? undefined : str(body.id, "连接", 50),
        name: body.name === undefined ? undefined : str(body.name, "连接名称", 60),
        provider: body.provider as "openai" | "openrouter" | "custom" | undefined,
        baseUrl: body.baseUrl === undefined ? undefined : str(body.baseUrl, "接口地址", 300),
        key: str(body.key, "API Key", 512),
        manualModels: body.manualModels === undefined ? undefined : str(body.manualModels, "手动模型", 4000, true),
      });
      if (!before.defaultChoice && !before.channels[0].connected) {
        setDefaultChoice(added.id, added.models[0], 0);
      }
      return Response.json(connectionStatus(), { headers: { "Cache-Control": "no-store" } });
    }
    if (type === "channel.disconnect") { disconnectChannel(str(body.id, "连接", 50)); return Response.json(connectionStatus(), { headers: { "Cache-Control": "no-store" } }); }
    if (type === "default.select") {
      const id = str(body.connectionId, "连接", 50);
      const model = str(body.model, "模型", 160);
      if (id === "deepseek" && !connectionStatus().channels[0].models.includes(model)) throw new PublicError("模型不在 DeepSeek 当前可用列表中", 409);
      setDefaultChoice(id, model, number(body.expectedRevision, "选择修订", 0, Number.MAX_SAFE_INTEGER));
      return Response.json(connectionStatus(), { headers: { "Cache-Control": "no-store" } });
    }
    if (type === "agent.select") {
      const id = str(body.agentId, "Agent", 50);
      const connectionId = body.connectionId === null ? null : str(body.connectionId, "连接", 50);
      const model = body.model === null ? null : str(body.model, "模型", 160);
      if (connectionId === "deepseek" && model && !connectionStatus().channels[0].models.includes(model)) throw new PublicError("模型不在 DeepSeek 当前可用列表中", 409);
      setAgentChoice(id, connectionId, model, number(body.expectedRevision, "选择修订", 0, Number.MAX_SAFE_INTEGER));
      return Response.json(connectionStatus(), { headers: { "Cache-Control": "no-store" } });
    }
    throw new PublicError("未知操作");
  } catch (error) {
    if (error instanceof DeepSeekError) return Response.json({ error: error.message, code: error.code }, { status: error.code === "stale" ? 409 : 400, headers: { "Cache-Control": "no-store" } });
    return respondError(error);
  }
}
