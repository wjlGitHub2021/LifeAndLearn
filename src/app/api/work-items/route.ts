import { acceptWorkArtifact, addWorkCorrection, completeWorkRun, createWorkItem, getWorkItem, getWorkRun, reviseWorkItem, rolesOf, saveWorkPreference, setWorkItemModelChoice, setWorkLifecycle, setWorkSchedule, setWorkSource, updateWorkPreference, workState, type WorkRole } from "../../../lib/work-items.ts";
import { cancelRun, connectionStatus, DeepSeekError, selectableItemModelChoice } from "../../../lib/deepseek.ts";
import { startWork } from "../../../lib/workflow.ts";
import { cancelPracticeRun, getPracticeRun, startPractice } from "../../../lib/practice.ts";
import { guard, jsonBody, number, PublicError, respondError, str } from "../../../lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  try { guard(request); return Response.json(workState(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return respondError(error); }
}
export async function POST(request: Request) {
  try {
    guard(request, true);
    const body = await jsonBody(request);
    const type = str(body.type, "操作", 30);
    let id: string | undefined;
    if (type === "create") {
      const requestText = str(body.request, "需求", 4000);
      const material = str(body.material, "资料", 8000, true);
      const roles = body.roles;
      if (!Array.isArray(roles) || roles.length > 2 || new Set(roles).size !== roles.length || roles.some(role => role !== "career" && role !== "english")) throw new PublicError("参与角色无效");
      id = createWorkItem(requestText, material, roles as WorkRole[], number(body.priority, "优先级", 1, 5), number(body.minutes, "参与时间", 10, 480), { plannedDate: body.plannedDate, dueDate: body.dueDate }, selectableItemModelChoice(body.modelChoice));
    } else if (type === "model.update") {
      id = str(body.id, "事项", 50);
      if (!Object.hasOwn(body, "modelChoice")) throw new PublicError("请提供本事项的模型选择，可用 null 跟随 Agent");
      setWorkItemModelChoice(id, selectableItemModelChoice(body.modelChoice), number(body.modelRevision, "模型选择修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "schedule.update") {
      id = str(body.id, "事项", 50);
      if (!Object.hasOwn(body, "plannedDate") || !Object.hasOwn(body, "dueDate")) throw new PublicError("请同时提供计划日和截止日，可用 null 清空");
      setWorkSchedule(id, body.plannedDate, body.dueDate, number(body.scheduleRevision, "排期修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "source.update") {
      id = str(body.id, "事项", 50);
      const source = body.source === null ? null : body.source;
      if (source !== null && (!source || typeof source !== "object" || Array.isArray(source))) throw new PublicError("来源无效");
      const chosen = source as { kind?: unknown; id?: unknown; artifactId?: unknown } | null;
      if (chosen && chosen.kind !== "quick" && chosen.kind !== "agent") throw new PublicError("来源类型无效");
      setWorkSource(id, number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER),
        chosen ? { kind: chosen.kind as "quick" | "agent", id: str(chosen.id, "来源事项", 50), artifactId: str(chosen.artifactId, "来源成果", 50) } : null);
    } else if (type === "update") {
      id = str(body.id, "事项", 50);
      const old = getWorkItem(id);
      if (!old) throw new PublicError("事项不存在", 404);
      const roles = body.roles === undefined ? rolesOf(old) : body.roles;
      if (!Array.isArray(roles) || roles.length > 2 || new Set(roles).size !== roles.length || roles.some(role => role !== "career" && role !== "english")) throw new PublicError("参与角色无效");
      if (!reviseWorkItem(id, body.request === undefined ? old.request : str(body.request, "需求", 4000), str(body.material, "资料", 8000, true), body.englishRequirement === undefined ? old.english_requirement : str(body.englishRequirement, "英文要求", 2000, true), roles as WorkRole[], number(body.minutes, "参与时间", 10, 480), number(body.priority, "优先级", 1, 5), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER))) throw new PublicError("事项已变化或正在运行，请刷新后核对再保存", 409);
    } else if (type === "correct") {
      id = str(body.id, "事项", 50);
      const text = str(body.text, "纠正", 2000);
      if (!addWorkCorrection(id, text, number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER))) throw new PublicError("事项已变化或正在运行，请刷新后核对再纠正", 409);
    } else if (type === "artifact.accept") {
      id = str(body.id, "事项", 50);
      if (!acceptWorkArtifact(id, str(body.artifactId, "成果", 50), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER))) throw new PublicError("成果已变化或事项正在运行，请刷新后核对", 409);
    } else if (type === "complete" || type === "archive" || type === "reopen") {
      id = str(body.id, "事项", 50);
      const unfinishedIds = body.unfinishedPracticeIds === undefined ? [] : body.unfinishedPracticeIds;
      if (!Array.isArray(unfinishedIds) || unfinishedIds.length > 2 || new Set(unfinishedIds).size !== unfinishedIds.length || unfinishedIds.some(value => typeof value !== "string" || value.length < 1 || value.length > 50)) throw new PublicError("未完成练习标识无效", 400);
      if (body.confirmUnfinished !== undefined && typeof body.confirmUnfinished !== "boolean") throw new PublicError("完成确认无效", 400);
      if (!setWorkLifecycle(id, type, number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER), unfinishedIds as string[], body.confirmUnfinished === true)) throw new PublicError("事项或未完成练习已变化，请刷新后核对", 409);
    } else if (type === "practice.start" || type === "practice.submit" || type === "practice.retry") {
      id = str(body.id, "事项", 50);
      const role = str(body.role, "角色", 20);
      if (role !== "career" && role !== "english") throw new PublicError("角色无效");
      const roundId = type === "practice.start" ? undefined : str(body.roundId, "练习轮次", 50);
      const answer = type === "practice.submit" ? str(body.answer, "作答", 8000) : undefined;
      if (answer !== undefined && Array.from(answer).length < 4) throw new PublicError("回答至少需要 4 个字符", 400);
      const { runId } = startPractice(id, role, str(body.requestId, "请求标识", 80), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER), roundId, answer);
      return Response.json({ id, runId, state: workState(), connection: connectionStatus() }, { status: 202, headers: { "Cache-Control": "no-store" } });
    } else if (type === "practice.cancel") {
      const runId = str(body.runId, "练习运行", 50);
      const run = getPracticeRun(runId);
      if (!run || run.status !== "running") throw new PublicError("练习运行已结束", 409);
      cancelRun(runId);
      if (!cancelPracticeRun(runId)) throw new PublicError("练习运行状态已变化", 409);
    } else if (type === "preference.save") {
      const role = str(body.role, "角色", 20);
      if (role !== "career" && role !== "english") throw new PublicError("角色无效");
      const saved = saveWorkPreference(role, str(body.text, "偏好", 500));
      if (!saved) throw new PublicError("每个角色最多保存 5 条有效偏好；请先编辑或撤销", 409);
      id = saved;
    } else if (type === "preference.update") {
      id = str(body.id, "偏好", 50);
      if (typeof body.active !== "boolean") throw new PublicError("偏好状态无效");
      if (typeof body.expectedActive !== "boolean") throw new PublicError("原偏好状态无效");
      if (!updateWorkPreference(id, str(body.text, "偏好", 500), body.active, str(body.expectedText, "原偏好", 500), body.expectedActive)) throw new PublicError("偏好已变化或有效偏好已达 5 条上限，请刷新后核对", 409);
    } else if (type === "start") {
      id = str(body.id, "事项", 50);
      const requestId = str(body.requestId, "请求标识", 80);
      const { runId } = startWork(id, requestId, fetch, number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
      return Response.json({ id, runId, state: workState(), connection: connectionStatus() }, { status: 202, headers: { "Cache-Control": "no-store" } });
    } else if (type === "cancel") {
      const runId = str(body.runId, "运行", 50);
      const run = getWorkRun(runId);
      if (!run || run.status !== "running") throw new PublicError("运行已结束", 409);
      cancelRun(runId);
      if (!completeWorkRun(runId, "cancelled", null, "用户取消；已发出的请求可能仍被计费")) throw new PublicError("运行状态已变化", 409);
      id = run.item_id;
    } else throw new PublicError("未知操作");
    return Response.json({ id, state: workState() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DeepSeekError) return Response.json({ error: error.message, code: error.code }, { status: error.code === "disconnected" ? 409 : 400 });
    return respondError(error);
  }
}
