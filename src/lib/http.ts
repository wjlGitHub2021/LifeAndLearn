export class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function guard(request: Request, mutation = false) {
  const host = request.headers.get("host") || "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new PublicError("仅允许本机访问", 403);
  if (mutation) {
    const origin = request.headers.get("origin");
    if (origin !== `http://${host}`) throw new PublicError("请求来源不匹配", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new PublicError("需要 JSON 请求", 415);
  }
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 20000) throw new PublicError("输入过长", 413);
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new PublicError("JSON 格式错误"); }
}
export function str(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) throw new PublicError(`${label}格式错误`);
  return value.trim();
}
export function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new PublicError(`${label}超出范围`);
  return value;
}
export function respondError(error: unknown) {
  if (error instanceof PublicError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: "操作失败，请重试" }, { status: 500 });
}
