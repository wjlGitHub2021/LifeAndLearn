import { acceptProposal, correctMemory, createGoal, finishTask, getAgent, getGoal, getTask, propose, saveDraft, saveMemory, setGoalActive, state, updateAgent, updateGoal } from "../../../lib/store.ts";
import { guard, jsonBody, number, PublicError, respondError, str } from "../../../lib/http.ts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    guard(request, true);
    const body = await jsonBody(request);
    const type = str(body.type, "操作", 40);
    let extra: Record<string, unknown> = {};
    if (type === "goal.create" || type === "goal.update") {
      const domain = str(body.domain, "领域", 20);
      if (domain !== "english" && domain !== "career") throw new PublicError("领域无效");
      const title = str(body.title, "目标", 120);
      const detail = str(body.detail, "资料", 2000, true);
      const priority = number(body.priority, "优先级", 1, 5);
      if (type === "goal.create") extra.id = createGoal(domain, title, detail, priority);
      else {
        const id = str(body.id, "目标", 50);
        const old = getGoal(id);
        if (!old || old.domain !== domain) throw new PublicError("目标不存在", 404);
        updateGoal(id, title, detail, priority);
      }
    } else if (type === "goal.schedule") {
      const id = str(body.id, "目标", 50);
      if (!getGoal(id)) throw new PublicError("目标不存在", 404);
      if (typeof body.active !== "boolean") throw new PublicError("安排状态无效");
      setGoalActive(id, body.active);
    } else if (type === "agent.update") {
      const id = str(body.id, "角色", 30);
      if (!["english", "career", "coordinator"].includes(id)) throw new PublicError("角色无效");
      if (typeof body.enabled !== "boolean") throw new PublicError("状态无效");
      const preference = str(body.preference, "偏好", 500, true);
      if (id === "coordinator" && !["", "priority", "balanced"].includes(preference)) throw new PublicError("协调偏好无效");
      updateAgent(id, body.enabled, preference);
    } else if (type === "plan.preview" || type === "plan.accept") {
      if (!getAgent("coordinator")?.enabled) throw new PublicError("日程协调员已暂停", 409);
      const budget = number(body.budget, "分钟", 10, 480);
      const plan = propose(budget);
      if (type === "plan.accept") {
        if (str(body.token, "预览版本", 64) !== plan.token) throw new PublicError("安排已变化，请重新预览", 409);
        if (budget < plan.lockedMinutes) throw new PublicError(`已锁定 ${plan.lockedMinutes} 分钟任务，预算不能低于该时长`, 409);
        acceptProposal(plan);
      }
      extra.proposal = plan;
    } else if (type === "task.draft") {
      const id = str(body.id, "任务", 50);
      const draft = str(body.draft, "草稿", 8000, true);
      if (!saveDraft(id, draft)) throw new PublicError("任务已不能修改", 409);
    } else if (type === "task.finish") {
      const id = str(body.id, "任务", 50);
      if (!finishTask(id)) throw new PublicError("当前不能结束练习", 409);
    } else if (type === "memory.accept") {
      const task = getTask(str(body.taskId, "任务", 50));
      if (!task || !["feedback", "done"].includes(task.status)) throw new PublicError("反馈尚未就绪", 409);
      const run = state().runs.find(r => r.task_id === task.id && r.status === "success");
      if (!run) throw new PublicError("找不到成功的运行", 409);
      const text = str(body.text, "记忆", 500);
      if (!task.suggestion || text !== task.suggestion) throw new PublicError("建议内容已变化，请刷新后重试", 409);
      extra.id = saveMemory(task.goal_id, task.agent_id, run.id, task.suggestion, "accepted");
    } else if (type === "memory.correct") {
      const id = str(body.id, "记忆", 50);
      if (!correctMemory(id, str(body.text, "记忆", 500))) throw new PublicError("记忆不存在", 404);
    } else throw new PublicError("未知操作");
    return Response.json({ ...extra, state: state() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return respondError(error); }
}
