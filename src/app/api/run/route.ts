import { beginGeneration, cancelGeneration, cancelRun, connectionStatus, DeepSeekError, registerRun, releaseRun } from "../../../lib/deepseek.ts";
import { produceFeedback } from "../../../lib/feedback.ts";
import { activePreferences, profile } from "../../../lib/agent-work.ts";
import { completeRun, createRun, getAgent, getAgentEpoch, getMemories, getPreferenceForGoal, getRun, getRunBySubmission, getTask, state } from "../../../lib/store.ts";
import { guard, jsonBody, PublicError, respondError, str } from "../../../lib/http.ts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    guard(request, true);
    const body = await jsonBody(request);
    const type = str(body.type, "操作", 20);
    if (type === "cancel") {
      const runId = str(body.runId, "运行", 50);
      const run = getRun(runId);
      if (!run || run.status !== "running") throw new PublicError("运行已结束", 409);
      if (!cancelRun(runId)) throw new PublicError("运行不在当前进程中", 409);
      completeRun(runId, run.task_id, "cancelled", null, "用户取消；已发出的请求可能仍被计费");
      return Response.json({ state: state() });
    }
    if (type !== "submit") throw new PublicError("未知操作");
    const taskId = str(body.taskId, "任务", 50);
    const answer = str(body.answer, "回答", 8000);
    if (Array.from(answer).length < 4) throw new PublicError("回答至少需要 4 个字符，才能生成可核对的反馈");
    const submissionId = str(body.submissionId, "提交标识", 50);
    const duplicate = getRunBySubmission(submissionId);
    if (duplicate) {
      if (duplicate.task_id !== taskId || duplicate.input !== answer) throw new PublicError("提交标识已用于其他输入", 409);
      return Response.json({ runId: duplicate.id, state: state() });
    }
    const task = getTask(taskId);
    if (!task || !["waiting", "failed", "interrupted", "cancelled"].includes(task.status)) throw new PublicError("任务不可提交", 409);
    const agent = getAgent(task.agent_id);
    if (!agent || !agent.enabled || !["english", "career"].includes(agent.id)) throw new PublicError("领域角色已暂停", 409);
    const configured = profile(agent.id);
    if (!configured?.enabled || !configured.allow_material) throw new PublicError("此旧版练习包含目标资料，当前 Agent 未授权读取；请在团队中调整资料范围后手动重试", 409);
    const profileRevision = configured.revision;
    const agentEpoch = getAgentEpoch(agent.id);
    const slot = beginGeneration(agent.id);
    let runId: string | null;
    const memories = getMemories(task.goal_id, agent.id);
    const preference = [getPreferenceForGoal(task.goal_id, agent.id), ...activePreferences(agent.id).map(entry => entry.text)].filter(Boolean).join("；");
    const context = { role: agent.id as "english" | "career", prompt: task.prompt, preference, memories: memories.map(m => ({ id: m.id, text: m.text, source: m.source_run_id })), answer, agentInstructions: configured.instructions };
    try {
      runId = createRun(task.id, agent.id, submissionId, answer, slot.modelRecord, memories.map(m => ({ id: m.id, text: m.text, source: m.source_run_id })), profileRevision, agentEpoch);
      if (!runId) throw new PublicError("任务已被另一运行占用，请刷新后重试", 409);
    } catch (error) {
      cancelGeneration(slot.controller);
      const existing = getRunBySubmission(submissionId);
      if (existing) {
        if (existing.task_id !== taskId || existing.input !== answer) throw new PublicError("提交标识已用于其他输入", 409);
        return Response.json({ runId: existing.id, state: state() });
      }
      throw error;
    }
    registerRun(runId, slot.controller);
    void (async () => {
      try {
        const parsed = await produceFeedback(slot, context);
        if (profile(agent.id)?.revision !== profileRevision || getAgentEpoch(agent.id) !== agentEpoch || !getAgent(agent.id)?.enabled) completeRun(runId, task.id, "cancelled", null, "Agent 配置已变化，迟到结果已丢弃");
        else completeRun(runId, task.id, "success", parsed.feedback, null, parsed.suggestion);
      } catch (error) {
        const message = error instanceof DeepSeekError || error instanceof Error ? error.message : "模型运行失败";
        completeRun(runId, task.id, "failed", null, message);
      } finally { releaseRun(runId); }
    })();
    return Response.json({ runId, state: state(), connection: connectionStatus() }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DeepSeekError) return Response.json({ error: error.message, code: error.code }, { status: error.code === "disconnected" ? 409 : 400 });
    return respondError(error);
  }
}
