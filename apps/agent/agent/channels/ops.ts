import { BoardKind, createStore, defaultPersistence, openStore, type BoardItem } from "@supply-agent/core";
import { defineChannel, GET, POST } from "eve/channels";
import { sentinelPrompt } from "../lib/alert.ts";
import { renderBoardHtml } from "../lib/board-html.ts";
import telegram from "./telegram.ts";

const APP_AUTH = { authenticator: "app", principalId: "eve:app", principalType: "runtime" } as const;

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
  const store = await openStore(defaultPersistence());
  const f = {
    mission_id: q.get("mission_id") || undefined,
    material_id: q.get("material_id") || undefined,
    kind: kind.success ? kind.data : undefined,
  };
  const items = store.boardItems({ ...f, limit });
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
      const refresh = Number(new URL(request.url).searchParams.get("refresh")) || 0;
      return new Response(renderBoardHtml(items, { filter, refreshSeconds: refresh }), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
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
      if (!prompt) return Response.json({ ok: true, breaches: 0 });
      const send = to(telegram, { chatId }).send(prompt, { auth: APP_AUTH as never });
      waitUntil(send);
      const session = await send;
      return Response.json({ ok: true, prompt, sessionId: (session as { id?: string }).id ?? null });
    }),
  ],
});
