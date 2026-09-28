import { acceptArtifact, agentState, archiveCorrection, cancelActiveRun, correctJob, createContinuationJob, createJob, job, profile, savePreference, saveProfile, setJobLifecycle, setJobModelChoice, setJobSchedule, setProfileEnabled, updateContinuation, updateJob, updatePreference, validateJobSteps, validateSteps } from "../../../lib/agent-work.ts";
import { startAgentJob } from "../../../lib/agent-workflow.ts";
import { cancelRun, connectionStatus, DeepSeekError, selectableItemModelChoice } from "../../../lib/deepseek.ts";
import { cancelPracticeRun } from "../../../lib/practice.ts";
import { completeWorkRun, workState } from "../../../lib/work-items.ts";
import { guard, jsonBody, number, PublicError, respondError, str } from "../../../lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  try { guard(request); return Response.json(agentState(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return respondError(error); }
}
function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new PublicError(`${label}无效`);
  return value;
}
function stopAgentRuns(agentId: string) {
  for (const run of agentState().runs.filter(entry => entry.agent_id === agentId && entry.status === "running")) {
    cancelRun(run.id);
    cancelActiveRun(run.id, "profile");
  }
  if (agentId !== "career" && agentId !== "english") return;
  const state = workState();
  for (const run of state.runs.filter(entry => entry.role === agentId && entry.status === "running")) {
    cancelRun(run.id);
    completeWorkRun(run.id, "cancelled", null, "Agent 配置已变化，运行已取消；请手动继续");
  }
  const rounds = new Set(state.practices.filter(entry => entry.role === agentId).map(entry => entry.id));
  for (const run of state.practiceRuns.filter(entry => entry.status === "running" && rounds.has(entry.practice_id))) {
    cancelRun(run.id);
    cancelPracticeRun(run.id, "profile");
  }
}
export async function POST(request: Request) {
  try {
    guard(request, true);
    const body = await jsonBody(request);
    const type = str(body.type, "操作", 40);
    let id: string | undefined;
    if (type === "profile.create" || type === "profile.update") {
      const input = {
        name: str(body.name, "Agent 名称", 60), instructions: str(body.instructions, "职责指令", 4000),
        deliverable: str(body.deliverable, "交付物", 500),
        allow_material: Number(boolean(body.allowMaterial, "事项资料范围")), allow_upstream: Number(boolean(body.allowUpstream, "上游成果范围")),
      };
      if (type === "profile.update") {
        id = str(body.id, "Agent", 50);
        const old = profile(id);
        if (!old) throw new PublicError("Agent 不存在", 404);
        saveProfile(input, id, number(body.revision, "配置修订", 1, Number.MAX_SAFE_INTEGER));
        if (old.name !== input.name || old.instructions !== input.instructions || old.deliverable !== input.deliverable || old.allow_material !== input.allow_material || old.allow_upstream !== input.allow_upstream) stopAgentRuns(id);
      } else id = saveProfile(input);
    } else if (type === "profile.enabled") {
      id = str(body.id, "Agent", 50);
      if (setProfileEnabled(id, boolean(body.enabled, "启停状态"), number(body.revision, "配置修订", 1, Number.MAX_SAFE_INTEGER))) stopAgentRuns(id);
    } else if (type === "job.create") {
      id = createJob(str(body.request, "事项需求", 4000), str(body.material, "事项资料", 8000, true), validateSteps(body.steps), { plannedDate: body.plannedDate, dueDate: body.dueDate }, selectableItemModelChoice(body.modelChoice));
    } else if (type === "model.update") {
      id = str(body.id, "事项", 50);
      if (!Object.hasOwn(body, "modelChoice")) throw new PublicError("请提供本事项的模型选择，可用 null 跟随 Agent");
      setJobModelChoice(id, selectableItemModelChoice(body.modelChoice), number(body.modelRevision, "模型选择修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "schedule.update") {
      id = str(body.id, "事项", 50);
      if (!Object.hasOwn(body, "plannedDate") || !Object.hasOwn(body, "dueDate")) throw new PublicError("请同时提供计划日和截止日，可用 null 清空");
      setJobSchedule(id, body.plannedDate, body.dueDate, number(body.scheduleRevision, "排期修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "job.continue") {
      id = createContinuationJob(
        str(body.request, "事项需求", 4000), str(body.material, "事项资料", 8000, true), validateJobSteps(body.steps, true),
        str(body.targetLabel ?? "", "目标标签", 120, true), str(body.sourceJobId, "来源事项", 50), str(body.sourceArtifactId, "来源成果", 50),
        number(body.sourceVersion, "来源版本", 1, Number.MAX_SAFE_INTEGER), number(body.sourceRevision, "来源事项修订", 1, Number.MAX_SAFE_INTEGER),
        { plannedDate: body.plannedDate, dueDate: body.dueDate }, selectableItemModelChoice(body.modelChoice),
      );
    } else if (type === "job.update") {
      id = str(body.id, "事项", 50);
      updateJob(id, str(body.request, "事项需求", 4000), str(body.material, "事项资料", 8000, true), validateJobSteps(body.steps, !!job(id)?.source_artifact_id), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "job.continuation.update") {
      id = str(body.id, "事项", 50);
      const source = body.sourceArtifactId === null ? null : {
        jobId: str(body.sourceJobId, "来源事项", 50), artifactId: str(body.sourceArtifactId, "来源成果", 50),
        version: number(body.sourceVersion, "来源版本", 1, Number.MAX_SAFE_INTEGER), revision: number(body.sourceRevision, "来源事项修订", 1, Number.MAX_SAFE_INTEGER),
      };
      updateContinuation(id, number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER), str(body.targetLabel ?? "", "目标标签", 120, true), validateJobSteps(body.steps, !!source), source);
    } else if (type === "job.correct") {
      id = str(body.id, "事项", 50);
      correctJob(id, str(body.text, "纠正", 2000), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "job.correction.archive") {
      id = str(body.id, "事项", 50);
      archiveCorrection(id, str(body.correctionId, "纠正", 50), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "job.accept") {
      id = str(body.id, "事项", 50);
      acceptArtifact(id, str(body.artifactId, "成果", 50), number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "job.complete" || type === "job.archive" || type === "job.reopen") {
      id = str(body.id, "事项", 50);
      setJobLifecycle(id, type.slice(4) as "complete" | "archive" | "reopen", number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
    } else if (type === "job.start") {
      id = str(body.id, "事项", 50);
      if (!job(id)) throw new PublicError("事项不存在", 404);
      const { runId } = startAgentJob(id, str(body.requestId, "请求标识", 80), fetch, number(body.revision, "事项修订", 1, Number.MAX_SAFE_INTEGER));
      return Response.json({ id, runId, state: agentState(), connection: connectionStatus() }, { status: 202, headers: { "Cache-Control": "no-store" } });
    } else if (type === "job.cancel") {
      const runId = str(body.runId, "运行", 50);
      cancelRun(runId);
      id = cancelActiveRun(runId);
    } else if (type === "preference.save") {
      id = str(body.agentId, "Agent", 50);
      savePreference(id, str(body.text, "偏好", 500));
    } else if (type === "preference.update") {
      id = str(body.id, "偏好", 50);
      updatePreference(id, str(body.text, "偏好", 500), boolean(body.active, "偏好状态"), str(body.expectedText, "原偏好", 500), boolean(body.expectedActive, "原偏好状态"));
    } else throw new PublicError("未知操作");
    return Response.json({ id, state: agentState() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DeepSeekError) return Response.json({ error: error.message, code: error.code }, { status: error.code === "disconnected" ? 409 : 400 });
    return respondError(error);
  }
}
