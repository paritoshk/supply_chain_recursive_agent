import { BOARD_MAX_ITEMS, type BoardItem } from "@supply-agent/core";

/**
 * Evidence board in its own Redis hash (`scos:board`, field = upsert key or id, value = item JSON).
 * Kept out of the state blob so whole-state saves can never drop board items, and so the /board
 * page reads one small hash instead of the whole supply state. A per-instance cache absorbs refreshes.
 * Without Redis (local dev) the board stays in the state file and these helpers are not used.
 */
const KEY = "scos:board";
const CACHE_MS = 5_000;

let cache: { at: number; items: BoardItem[] } | null = null;

function redis(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export const boardInRedis = () => redis() != null;

async function pipeline(commands: string[][]): Promise<unknown[]> {
  const r = redis();
  if (!r || !commands.length) return [];
  const res = await fetch(`${r.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as Array<{ result?: unknown; error?: string }> | null;
  if (!res.ok || !Array.isArray(body)) throw new Error(`upstash pipeline ${res.status}`);
  const err = body.find((x) => x.error);
  if (err) throw new Error(`upstash: ${err.error}`);
  return body.map((x) => x.result);
}

const field = (b: BoardItem) => b.key || b.id;
const newestFirst = (a: BoardItem, b: BoardItem) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

/** All board items, newest first. Cached per instance for a few seconds unless `fresh`. */
export async function loadBoard(fresh = false): Promise<BoardItem[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const [vals] = await pipeline([["HVALS", KEY]]);
  const items = (Array.isArray(vals) ? vals : [])
    .map((v) => {
      try {
        return JSON.parse(String(v)) as BoardItem;
      } catch {
        return null;
      }
    })
    .filter((b): b is BoardItem => b != null)
    .sort(newestFirst);
  cache = { at: Date.now(), items };
  return items;
}

/** Upserts items (same key replaces), then trims the oldest beyond BOARD_MAX_ITEMS. */
export async function putBoard(items: BoardItem[]): Promise<void> {
  if (!items.length || !boardInRedis()) return;
  await pipeline(items.map((b) => ["HSET", KEY, field(b), JSON.stringify(b)]));
  const all = await loadBoard(true);
  if (all.length > BOARD_MAX_ITEMS) await pipeline([["HDEL", KEY, ...all.slice(BOARD_MAX_ITEMS).map(field)]]);
  cache = null;
}

export function filterBoard(
  items: BoardItem[],
  f: { kind?: string; mission_id?: string; material_id?: string; key?: string; limit?: number },
): BoardItem[] {
  const out = items.filter(
    (b) =>
      (!f.kind || b.kind === f.kind) &&
      (!f.mission_id || b.mission_id === f.mission_id) &&
      (!f.material_id || b.material_id === f.material_id) &&
      (!f.key || b.key === f.key),
  );
  return f.limit ? out.slice(0, f.limit) : out;
}
