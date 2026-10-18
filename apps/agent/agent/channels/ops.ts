import { BoardKind, createStore, defaultPersistence, openStore, type BoardItem } from "@supply-agent/core";
import { defineChannel, GET, POST } from "eve/channels";
import { sentinelPrompt } from "../lib/alert.ts";
import { renderBoardHtml } from "../lib/board-html.ts";
import { boardInRedis, clearBoard, filterBoard, loadBoard } from "../lib/board-store.ts";
import telegram from "./telegram.ts";

const APP_AUTH = { authenticator: "app", principalId: "eve:app", principalType: "runtime" } as const;
const LAST_TELEGRAM_SESSION = "scos:telegram:last_session";

/** Tiny Upstash REST get/set for the last Telegram session id (no-op without Redis). */
async function kv(cmd: "get" | "set", value?: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const path = cmd === "get" ? `get/${LAST_TELEGRAM_SESSION}` : `set/${LAST_TELEGRAM_SESSION}/${encodeURIComponent(value ?? "")}`;
  const res = await fetch(`${url.replace(/\/$/, "")}/${path}`, { method: cmd === "get" ? "GET" : "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as { result?: string | null } | null) : null;
  return body?.result ?? null;
}

// Operator routes for the live demo. Protected by CRON_SECRET (or TELEGRAM_WEBHOOK_SECRET_TOKEN).
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

/** Board items filtered by ?mission_id=&material_id=&kind=&limit= (newest first). */
async function boardItems(request: Request): Promise<{ items: BoardItem[]; filter: string }> {
  const q = new URL(request.url).searchParams;
  const kind = BoardKind.safeParse(q.get("kind") ?? undefined);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 60));
  const f = {
    mission_id: q.get("mission_id") || undefined,
    material_id: q.get("material_id") || undefined,
    kind: kind.success ? kind.data : undefined,
  };
  // Redis: read only the board hash (cached a few seconds), never the whole supply state.
  const items = boardInRedis() ? filterBoard(await loadBoard(), { ...f, limit }) : (await openStore(defaultPersistence())).boardItems({ ...f, limit });
  return { items, filter: Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") };
}

export default defineChannel({
  routes: [
    // Evidence board as JSON (operator, same bearer auth as the other ops routes).
    GET("/ops/board", async (request) => {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      const { items, filter } = await boardItems(request);
      return Response.json({ ok: true, filter, count: items.length, items });
    }),
    // Evidence board as a read-only HTML page (public; synthetic data and public sources only, no secrets).
    GET("/board", async (request) => {
      const { items, filter } = await boardItems(request);
      const q = new URL(request.url).searchParams;
      const refresh = Number(q.get("refresh")) || 0;
      const maxRuns = q.get("all") || q.get("mission_id") ? undefined : 4;
      return new Response(renderBoardHtml(items, { filter, refreshSeconds: refresh, maxRuns }), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, s-maxage=5, stale-while-revalidate=30" },
      });
    }),
    // Clear the evidence board (operator only) so the next demo run starts from an empty board.
    POST("/ops/board/clear", async (request) => {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      return Response.json({ ok: true, removed: await clearBoard() });
    }),
    // Reseed the synthetic Corvane state (deterministic seed) before a demo run.
    POST("/ops/reset", async (request) => {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      const store = createStore();
      await defaultPersistence().save(store.snapshot());
      return Response.json({ ok: true, today: store.today(), missions: store.missions().length });
    }),
    // Fire the sentinel now instead of waiting for the cron: scan in code, then message the planner on Telegram.
    POST("/ops/sentinel", async (request, { to, waitUntil }) => {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { material_id?: string; site_id?: string };
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) return Response.json({ ok: false, reason: "TELEGRAM_CHAT_ID not set" }, { status: 500 });
      const prompt = await sentinelPrompt(body.material_id, body.site_id);
      if (!prompt) {
        return Response.json({
          ok: false,
          breaches: 0,
          reason: body.material_id ? `unknown material/site ${body.material_id} @ ${body.site_id}` : "no material is below its reorder point",
        });
      }
      // Retire the previous Telegram conversation so every alert starts a fresh session on the
      // current deployment (old sessions stay pinned to the build that created them).
      const previous = await kv("get");
      if (previous) {
        await fetch(new URL(`/eve/v1/session/${previous}/reset`, request.url), { method: "POST" }).catch(() => null);
      }
      const send = to(telegram, { chatId }).send(prompt, { auth: APP_AUTH as never });
      waitUntil(send);
      const session = await send;
      const sessionId = (session as { id?: string }).id ?? null;
      if (sessionId) await kv("set", sessionId);
      return Response.json({ ok: true, prompt, sessionId, previousSessionId: previous });
    }),
  ],
});
