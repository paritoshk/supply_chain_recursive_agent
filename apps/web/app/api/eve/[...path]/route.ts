export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const AGENT_URL = (process.env.AGENT_URL || "https://supplier-chief-of-staff.vercel.app").replace(/\/$/, "");

type Ctx = { params: Promise<{ path: string[] }> };

function target(req: Request, path: string[]) {
  const url = new URL(req.url);
  return `${AGENT_URL}/eve/v1/${path.map(encodeURIComponent).join("/")}${url.search}`;
}

export async function GET(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  const upstream = await fetch(target(req, path), {
    headers: { accept: req.headers.get("accept") || "application/x-ndjson" },
    cache: "no-store",
    signal: req.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/x-ndjson",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  const body = await req.text();
  const upstream = await fetch(target(req, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
}
