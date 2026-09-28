import type { AgentJob, AgentProfile, AgentRun, agentMetricsState } from "./agent-work.ts";
import { PublicError } from "./http.ts";

type AgentWorkState = ReturnType<typeof agentMetricsState>;

export type AgentMetricKind = "run_started" | "run_succeeded" | "run_failed" | "run_cancelled" | "run_interrupted" | "artifact_created" | "artifact_accepted";
export type AgentMetricSnapshot = {
  name: string;
  instructions: string | null;
  deliverable: string | null;
  allowMaterial: boolean | null;
  allowUpstream: boolean | null;
  revision: number | null;
};
export type AgentMetricEvent = {
  id: string;
  kind: AgentMetricKind;
  occurredAt: string;
  agentId: string;
  agentName: string;
  agentSnapshot: AgentMetricSnapshot;
  jobId: string;
  jobRequest: string;
  runId: string | null;
  artifactId: string | null;
  artifactVersion: number | null;
  acceptedAt: string | null;
  upstream: { id: string; version: number }[];
  errorSummary: string | null;
};
export type AgentMetricEventSummary = Omit<AgentMetricEvent, "agentSnapshot" | "upstream">;
export type AgentMetricCounts = { runs: number; successfulRuns: number; failedRuns: number; acceptedArtifacts: number };
export type AgentMetricEventIds = { runs: string[]; successfulRuns: string[]; failedRuns: string[]; acceptedArtifacts: string[] };
export type AgentMetricName = keyof AgentMetricEventIds;
export type MetricPage = { limit: number; total: number; hasMore: boolean; nextCursor: string | null; metric: AgentMetricName | null; asOf: string };
export type AgentMetricJob = {
  id: string;
  request: string;
  lifecycle: AgentJob["lifecycle"];
  status: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  artifactCount: number;
  recent: boolean;
};
export type AgentMetricsResponse = {
  scope: "agent-jobs";
  window: { from: string; to: string };
  team: AgentMetricCounts;
  events: AgentMetricEventSummary[];
  pagination: MetricPage | null;
  agents: {
    profile: Pick<AgentProfile, "id" | "name" | "enabled" | "template">;
    sevenDay: AgentMetricCounts & { participatingJobs: number };
    lastActivityAt: string | null;
  }[];
};
export type AgentMetricDetailResponse = {
  scope: "agent-jobs";
  window: { from: string; to: string };
  agent: {
    profile: AgentProfile;
    sevenDay: AgentMetricCounts & { participatingJobs: number };
    lastActivityAt: string | null;
    jobs: AgentMetricJob[];
    events: AgentMetricEvent[];
  };
  pagination: MetricPage;
  jobsPagination: Omit<MetricPage, "metric"> & { recentOnly: boolean };
};
export type AgentTrendDays = 7 | 30;
export type AgentTrendBucket = { index: number; from: string; to: string } & AgentMetricCounts;
export type AgentTrendResponse = {
  scope: "agent-jobs";
  days: AgentTrendDays;
  window: { from: string; to: string };
  asOf: string;
  buckets: AgentTrendBucket[];
  totals: AgentMetricCounts;
  selection: { bucket: number; metric: AgentMetricName } | null;
  events: AgentMetricEventSummary[];
  pagination: MetricPage | null;
};

function timestamp(value: string | null): number {
  if (!value) return NaN;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(normalized);
}
function iso(value: string): string { return new Date(timestamp(value)).toISOString(); }
function object(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
function snapshot(value: string, fallbackName = "历史 Agent"): AgentMetricSnapshot {
  const raw = object(value);
  return {
    name: typeof raw.agentName === "string" ? raw.agentName : typeof raw.name === "string" ? raw.name : fallbackName,
    instructions: typeof raw.instructions === "string" ? raw.instructions : null,
    deliverable: typeof raw.deliverable === "string" ? raw.deliverable : null,
    allowMaterial: typeof raw.allowMaterial === "boolean" ? raw.allowMaterial : null,
    allowUpstream: typeof raw.allowUpstream === "boolean" ? raw.allowUpstream : null,
    revision: typeof raw.agentRevision === "number" ? raw.agentRevision : typeof raw.revision === "number" ? raw.revision : null,
  };
}
function upstream(value: string): { id: string; version: number }[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is { id: string; version: number } => !!entry && typeof entry === "object" && typeof entry.id === "string" && Number.isInteger(entry.version)) : [];
  } catch { return []; }
}
function errorSummary(run: AgentRun): string | null {
  if (run.status === "interrupted") return "应用重启，运行已中断";
  if (run.status === "cancelled") return run.error?.startsWith("Agent 配置") || run.error?.startsWith("配置或事项") ? "配置或事项变化，运行已取消" : "运行已取消";
  if (run.status !== "failed") return null;
  const error = run.error || "";
  if (error.startsWith("[agent_correction.") || /格式无效|没有生成可用成果|没有返回可用成果/.test(error)) return "成果格式未通过校验";
  if (/超时/.test(error)) return "模型请求超时";
  if (/请求过于频繁/.test(error)) return "模型请求过于频繁";
  if (/余额不足/.test(error)) return "模型账户余额不足";
  if (/API Key 无效|请先连接/.test(error)) return "模型连接不可用";
  if (/无法连接|网络|服务暂不可用/.test(error)) return "模型服务或网络暂不可用";
  return "运行失败，请打开关联事项查看详情";
}
function valid(value: string | null): value is string { return Number.isFinite(timestamp(value)); }
function compareEvents(a: AgentMetricEvent, b: AgentMetricEvent) {
  return timestamp(b.occurredAt) - timestamp(a.occurredAt) || b.id.localeCompare(a.id);
}
function idsFor(events: AgentMetricEvent[]): AgentMetricEventIds {
  return {
    runs: events.filter(event => event.kind === "run_started").map(event => event.id),
    successfulRuns: events.filter(event => event.kind === "run_succeeded").map(event => event.id),
    failedRuns: events.filter(event => event.kind === "run_failed").map(event => event.id),
    acceptedArtifacts: events.filter(event => event.kind === "artifact_accepted").map(event => event.id),
  };
}
function counts(ids: AgentMetricEventIds): AgentMetricCounts {
  return { runs: ids.runs.length, successfulRuns: ids.successfulRuns.length, failedRuns: ids.failedRuns.length, acceptedArtifacts: ids.acceptedArtifacts.length };
}
type PageOptions = { limit?: number; cursor?: string; asOf?: string };
function pageCursor(at: string, id: string): string { return Buffer.from(JSON.stringify({ at, id })).toString("base64url"); }
function readCursor(value: string | undefined): { at: string; id: string } | null {
  if (!value) return null;
  if (value.length > 400 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new PublicError("历史游标无效");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("at" in parsed) || !("id" in parsed) ||
      typeof parsed.at !== "string" || !valid(parsed.at) || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 200 ||
      pageCursor(parsed.at, parsed.id) !== value) throw new Error("invalid cursor");
    return { at: parsed.at, id: parsed.id };
  } catch { throw new PublicError("历史游标无效"); }
}
function pageRows<T extends { id: string }>(rows: T[], at: (entry: T) => string, options: PageOptions, metric: AgentMetricName | null) {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PublicError("每页数量无效");
  const before = readCursor(options.cursor);
  const remaining = before ? rows.filter(entry => timestamp(at(entry)) < timestamp(before.at) ||
    (at(entry) === before.at && entry.id.localeCompare(before.id) < 0)) : rows;
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  return {
    selected,
    pagination: { limit, total: rows.length, hasMore: remaining.length > limit,
      nextCursor: remaining.length > limit && last ? pageCursor(at(last), last.id) : null,
      metric, asOf: options.asOf || "" },
  };
}
function projectionAnchor(now: Date, highWater: number, asOf?: string) {
  if (!Number.isFinite(now.getTime())) throw new PublicError("时间快照无效");
  if (!asOf) return { time: now, seq: highWater, token: `${now.toISOString()}~${highWater}` };
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~(0|[1-9]\d*)$/.exec(asOf);
  if (!match || !valid(match[1]) || new Date(match[1]).toISOString() !== match[1]) throw new PublicError("时间快照无效");
  const seq = Number(match[2]);
  const time = new Date(match[1]);
  if (!Number.isSafeInteger(seq) || seq > highWater || time.getTime() > now.getTime()) throw new PublicError("时间快照无效");
  return { time, seq, token: asOf };
}

function projection(state: AgentWorkState, now: Date, cutoffSeq: number, days: AgentTrendDays = 7) {
  const to = now.getTime();
  if (!Number.isFinite(to)) throw new RangeError("Invalid metric window end");
  const from = to - days * 24 * 60 * 60 * 1000;
  const journal = new Map(state.metricJournal.map(entry => [`${entry.kind}:${entry.entity_id}`, entry.seq]));
  const profileCreatedAt = new Map(state.profiles.map(profile => [profile.id, profile.created_at]));
  const included = (kind: string, id: string) => {
    const seq = journal.get(`${kind}:${id}`);
    if (seq !== undefined) return seq <= cutoffSeq;
    // A retained profile can predate a cleared metric journal; keep it manageable without reconstructing event history.
    return kind === "profile_created" && timestamp(profileCreatedAt.get(id) ?? null) <= to;
  };
  const jobs = new Map(state.jobs.filter(entry => included("job_created", entry.id)).map(entry => [entry.id, entry]));
  const runs = new Map(state.runs.map(entry => [entry.id, entry]));
  const events: AgentMetricEvent[] = [];
  for (const run of state.runs) {
    const context = object(run.context_json);
    const agentSnapshot = snapshot(run.context_json);
    const jobRequest = typeof context.request === "string" ? context.request : jobs.get(run.job_id)?.request || "历史事项";
    const runUpstream = Array.isArray(context.upstream) ? context.upstream.filter((entry): entry is { id: string; version: number } => !!entry && typeof entry === "object" && typeof entry.id === "string" && Number.isInteger(entry.version)).map(entry => ({ id: entry.id, version: entry.version })) : [];
    const common = { agentId: run.agent_id, agentName: agentSnapshot.name, agentSnapshot, jobId: run.job_id, jobRequest, runId: run.id, artifactId: null, artifactVersion: null, acceptedAt: null, upstream: runUpstream, errorSummary: null };
    if (included("run_started", run.id) && valid(run.created_at)) events.push({ ...common, id: `run:${run.id}:started`, kind: "run_started", occurredAt: iso(run.created_at) });
    const kind = { success: "run_succeeded", failed: "run_failed", cancelled: "run_cancelled", interrupted: "run_interrupted" }[run.status] as AgentMetricKind | undefined;
    if (kind && included("run_finished", run.id) && valid(run.finished_at)) events.push({ ...common, id: `run:${run.id}:finished`, kind, occurredAt: iso(run.finished_at), errorSummary: errorSummary(run) });
  }
  for (const artifact of state.artifacts) {
    const run = runs.get(artifact.run_id);
    const context = run ? object(run.context_json) : {};
    const agentSnapshot = snapshot(artifact.config_json, run ? snapshot(run.context_json).name : "历史 Agent");
    const common = {
      agentId: artifact.agent_id, agentName: agentSnapshot.name, agentSnapshot,
      jobId: artifact.job_id, jobRequest: typeof context.request === "string" ? context.request : jobs.get(artifact.job_id)?.request || "历史事项",
      runId: artifact.run_id, artifactId: artifact.id, artifactVersion: artifact.version,
      acceptedAt: included("artifact_accepted", artifact.id) && valid(artifact.accepted_at) ? iso(artifact.accepted_at) : null,
      upstream: upstream(artifact.upstream_json), errorSummary: null,
    };
    if (included("artifact_created", artifact.id) && valid(artifact.created_at)) events.push({ ...common, id: `artifact:${artifact.id}:created`, kind: "artifact_created", occurredAt: iso(artifact.created_at) });
    if (included("artifact_accepted", artifact.id) && valid(artifact.accepted_at)) events.push({ ...common, id: `artifact:${artifact.id}:accepted`, kind: "artifact_accepted", occurredAt: iso(artifact.accepted_at) });
  }
  events.sort(compareEvents);
  const withinWindow = (event: AgentMetricEvent) => { const at = timestamp(event.occurredAt); return at >= from && at <= to; };
  const windowEvents = events.filter(withinWindow);
  const teamEventIds = idsFor(windowEvents);
  const agents = state.profiles.filter(profile => included("profile_created", profile.id)).map(profile => {
    const history = events.filter(event => event.agentId === profile.id && timestamp(event.occurredAt) <= to);
    const recent = history.filter(withinWindow);
    const eventIds = idsFor(recent);
    const participatingJobIds = [...new Set(state.runs.filter(run => run.agent_id === profile.id && included("run_started", run.id) && timestamp(run.created_at) <= to &&
      (run.finished_at === null || !included("run_finished", run.id) || timestamp(run.finished_at) >= from)).map(run => run.job_id))];
    const participated = new Set(history.filter(event => event.kind === "run_started").map(event => event.jobId));
    const recentJobs = new Set(participatingJobIds);
    const agentJobs = state.jobs.filter(entry => included("job_created", entry.id) && participated.has(entry.id) && timestamp(entry.created_at) <= to).map(entry => ({
      id: entry.id, request: entry.request, lifecycle: entry.lifecycle, status: entry.status,
      createdAt: valid(entry.created_at) ? iso(entry.created_at) : entry.created_at,
      updatedAt: valid(entry.updated_at) ? iso(entry.updated_at) : entry.updated_at,
      runCount: state.runs.filter(run => run.agent_id === profile.id && run.job_id === entry.id && included("run_started", run.id) && timestamp(run.created_at) <= to).length,
      artifactCount: state.artifacts.filter(artifact => artifact.agent_id === profile.id && artifact.job_id === entry.id && included("artifact_created", artifact.id) && timestamp(artifact.created_at) <= to).length,
      recent: recentJobs.has(entry.id),
    })).sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || b.id.localeCompare(a.id));
    return {
      profile,
      sevenDay: { ...counts(eventIds), participatingJobs: participatingJobIds.length, participatingJobIds, eventIds },
      lastActivityAt: history[0]?.occurredAt || null,
      jobs: agentJobs,
      events: history,
    };
  });
  return { window: { from: new Date(from).toISOString(), to: now.toISOString() }, team: { ...counts(teamEventIds), eventIds: teamEventIds }, events: windowEvents, agents };
}

function summary(event: AgentMetricEvent): AgentMetricEventSummary {
  return {
    id: event.id, kind: event.kind, occurredAt: event.occurredAt,
    agentId: event.agentId, agentName: event.agentName, jobId: event.jobId,
    jobRequest: event.jobRequest.slice(0, 160), runId: event.runId,
    artifactId: event.artifactId, artifactVersion: event.artifactVersion,
    acceptedAt: event.acceptedAt, errorSummary: event.errorSummary,
  };
}

export function projectAgentMetrics(state: AgentWorkState, now = new Date(), options: PageOptions & { metric?: AgentMetricName } = {}): AgentMetricsResponse {
  const anchor = projectionAnchor(now, state.metricHighWater, options.asOf);
  const projected = projection(state, anchor.time, anchor.seq);
  const metric = options.metric || null;
  const selected = metric ? projected.events.filter(event => projected.team.eventIds[metric].includes(event.id)) : [];
  const page = metric ? pageRows(selected, event => event.occurredAt, options, metric) : null;
  return {
    scope: "agent-jobs", window: projected.window, team: counts(projected.team.eventIds),
    events: page ? page.selected.map(summary) : [],
    pagination: page ? { ...page.pagination, asOf: anchor.token } : null,
    agents: projected.agents.map(({ profile, sevenDay, lastActivityAt }) => ({
      profile: { id: profile.id, name: profile.name, enabled: profile.enabled, template: profile.template },
      sevenDay: { ...counts(sevenDay.eventIds), participatingJobs: sevenDay.participatingJobs }, lastActivityAt,
    })),
  };
}

export function projectAgentMetricDetail(state: AgentWorkState, agentId: string, options: PageOptions & { metric?: AgentMetricName; jobsCursor?: string; jobsLimit?: number; jobsRecentOnly?: boolean } = {}, now = new Date()): AgentMetricDetailResponse | null {
  const anchor = projectionAnchor(now, state.metricHighWater, options.asOf);
  const projected = projection(state, anchor.time, anchor.seq);
  const agent = projected.agents.find(entry => entry.profile.id === agentId);
  if (!agent) return null;
  const metric = options.metric ?? null;
  const selectedIds = metric ? new Set(agent.sevenDay.eventIds[metric]) : null;
  const selectedEvents = selectedIds ? agent.events.filter(event => selectedIds.has(event.id)) : agent.events;
  const eventPage = pageRows(selectedEvents, event => event.occurredAt, options, metric);
  const selectedJobs = options.jobsRecentOnly ? agent.jobs.filter(job => job.recent) : agent.jobs;
  const jobPage = pageRows(selectedJobs, job => job.createdAt,
    { limit: options.jobsLimit, cursor: options.jobsCursor, asOf: options.asOf }, null);
  return {
    scope: "agent-jobs", window: projected.window,
    agent: { ...agent, sevenDay: { ...counts(agent.sevenDay.eventIds), participatingJobs: agent.sevenDay.participatingJobs },
      events: eventPage.selected, jobs: jobPage.selected },
    pagination: { ...eventPage.pagination, asOf: anchor.token },
    jobsPagination: { limit: jobPage.pagination.limit, total: jobPage.pagination.total, hasMore: jobPage.pagination.hasMore,
      nextCursor: jobPage.pagination.nextCursor, asOf: anchor.token, recentOnly: !!options.jobsRecentOnly },
  };
}

export function projectAgentTrend(state: AgentWorkState, days: AgentTrendDays, options: PageOptions & { bucket?: number; metric?: AgentMetricName } = {}, now = new Date()): AgentTrendResponse {
  if (days !== 7 && days !== 30) throw new PublicError("趋势天数无效");
  const selectedBucket = options.bucket;
  const selectedMetric = options.metric;
  if ((selectedBucket === undefined) !== (selectedMetric === undefined)) throw new PublicError("请同时指定趋势区间和指标");
  if (selectedBucket !== undefined && (!Number.isInteger(selectedBucket) || selectedBucket < 0 || selectedBucket >= days)) throw new PublicError("趋势区间无效");
  if (selectedMetric !== undefined && !(["runs", "successfulRuns", "failedRuns", "acceptedArtifacts"] as string[]).includes(selectedMetric)) throw new PublicError("指标无效");
  if (selectedBucket === undefined && (options.cursor !== undefined || options.limit !== undefined)) throw new PublicError("请先指定趋势区间");
  if (selectedBucket !== undefined && !options.asOf) throw new PublicError("需要趋势快照");
  const anchor = projectionAnchor(now, state.metricHighWater, options.asOf);
  const projected = projection(state, anchor.time, anchor.seq, days);
  const start = timestamp(projected.window.from);
  const span = 24 * 60 * 60 * 1000;
  const grouped: AgentMetricEvent[][] = Array.from({ length: days }, () => []);
  for (const event of projected.events) {
    const index = Math.min(days - 1, Math.floor((timestamp(event.occurredAt) - start) / span));
    grouped[index].push(event);
  }
  const buckets = grouped.map((events, index) => ({
    index, from: new Date(start + index * span).toISOString(), to: new Date(start + (index + 1) * span).toISOString(),
    ...counts(idsFor(events)),
  }));
  const selection = selectedBucket === undefined || selectedMetric === undefined ? null : { bucket: selectedBucket, metric: selectedMetric };
  const selectedIds = selection ? new Set(idsFor(grouped[selection.bucket])[selection.metric]) : null;
  const selectedEvents = selectedIds ? grouped[selection!.bucket].filter(event => selectedIds.has(event.id)) : [];
  const page = selection ? pageRows(selectedEvents, event => event.occurredAt, options, selection.metric) : null;
  return {
    scope: "agent-jobs", days, window: projected.window, asOf: anchor.token,
    buckets, totals: counts(idsFor(projected.events)), selection,
    events: page ? page.selected.map(summary) : [],
    pagination: page ? { ...page.pagination, asOf: anchor.token } : null,
  };
}
