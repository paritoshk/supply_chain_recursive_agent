export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const AGENT_URL = (process.env.AGENT_URL || "https://supplier-chief-of-staff.vercel.app").replace(/\/$/, "");
const ALLOWED = new Set(["reset", "sentinel"]);

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!ALLOWED.has(action)) return Response.json({ ok: false, error: "unknown action" }, { status: 404 });
  const secret = process.env.OPS_SECRET;
  if (!secret) return Response.json({ ok: false, error: "OPS_SECRET not configured" }, { status: 500 });
  const body = await req.text();
  const upstream = await fetch(`${AGENT_URL}/ops/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: body || "{}",
    cache: "no-store",
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
}
