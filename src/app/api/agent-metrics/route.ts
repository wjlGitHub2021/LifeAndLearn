import { agentMetricsState } from "../../../lib/agent-work.ts";
import { projectAgentMetricDetail, projectAgentMetrics, projectAgentTrend, type AgentMetricName, type AgentTrendDays } from "../../../lib/agent-metrics.ts";
import { guard, PublicError, respondError, str } from "../../../lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function integer(value: string | null, fallback: number, maximum: number, label: string) {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PublicError(`${label}无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new PublicError(`${label}无效`);
  return parsed;
}
function optional(value: string | null, label: string, maximum: number): string | undefined {
  if (value === null) return undefined;
  if (!value || value.length > maximum) throw new PublicError(`${label}无效`);
  return value;
}
export function GET(request: Request) {
  try {
    guard(request);
    const params = new URL(request.url).searchParams;
    const rawAgentId = params.get("agentId");
    const state = agentMetricsState();
    const rawMetric = params.get("metric");
    const metrics = ["runs", "successfulRuns", "failedRuns", "acceptedArtifacts"];
    if (rawMetric !== null && !metrics.includes(rawMetric)) throw new PublicError("指标无效");
    const limit = integer(params.get("limit"), 30, 100, "每页数量");
    if (limit < 1) throw new PublicError("每页数量无效");
    const cursor = optional(params.get("cursor"), "历史游标", 400);
    const asOf = optional(params.get("asOf"), "时间快照", 80);
    const rawTrendDays = params.get("trendDays");
    if (rawTrendDays !== null) {
      if (rawTrendDays !== "7" && rawTrendDays !== "30") throw new PublicError("趋势天数无效");
      if (rawAgentId !== null || params.has("offset") || params.has("jobsCursor") || params.has("jobsLimit") || params.has("jobsRecentOnly")) throw new PublicError("趋势参数无效");
      const days = Number(rawTrendDays) as AgentTrendDays;
      const rawBucket = params.get("bucket");
      if ((rawBucket === null) !== (rawMetric === null)) throw new PublicError("请同时指定趋势区间和指标");
      if (rawBucket === null && (cursor || params.has("limit"))) throw new PublicError("请先指定趋势区间");
      const bucket = rawBucket === null ? undefined : integer(rawBucket, 0, days - 1, "趋势区间");
      return Response.json(projectAgentTrend(state, days, { bucket, metric: rawMetric === null ? undefined : rawMetric as AgentMetricName,
        limit: bucket === undefined ? undefined : limit, cursor, asOf }), { headers: { "Cache-Control": "no-store" } });
    }
    if (params.has("bucket")) throw new PublicError("需要指定趋势天数");
    if (rawAgentId === null) {
      if (params.has("offset") || params.has("jobsCursor") || params.has("jobsLimit") || params.has("jobsRecentOnly")) throw new PublicError("团队参数无效");
      if (!rawMetric && (cursor || asOf || params.has("limit"))) throw new PublicError("需要指定指标");
      return Response.json(projectAgentMetrics(state, new Date(), { metric: rawMetric as AgentMetricName | undefined, limit, cursor, asOf }), { headers: { "Cache-Control": "no-store" } });
    }
    const agentId = str(rawAgentId, "Agent", 50);
    if (params.has("offset")) throw new PublicError("历史偏移已弃用");
    const jobsLimit = integer(params.get("jobsLimit"), 30, 100, "事项每页数量");
    if (jobsLimit < 1) throw new PublicError("事项每页数量无效");
    const jobsCursor = optional(params.get("jobsCursor"), "事项游标", 400);
    const jobsRecentOnly = params.get("jobsRecentOnly");
    if (jobsRecentOnly !== null && jobsRecentOnly !== "true" && jobsRecentOnly !== "false") throw new PublicError("近期事项参数无效");
    const detail = projectAgentMetricDetail(state, agentId, { limit, cursor, asOf, metric: rawMetric as AgentMetricName | undefined,
      jobsLimit, jobsCursor, jobsRecentOnly: jobsRecentOnly === "true" });
    if (!detail) throw new PublicError("Agent 不存在", 404);
    return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return respondError(error); }
}
