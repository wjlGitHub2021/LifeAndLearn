import { state } from "../../../lib/store.ts";
import { guard, respondError } from "../../../lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  try { guard(request); return Response.json(state(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return respondError(error); }
}
