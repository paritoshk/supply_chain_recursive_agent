import { defaultPersistence, openStore, type BoardItem, type Store } from "@supply-agent/core";

/**
 * Opens the shared supply state (one JSON blob: Upstash Redis on Vercel, a local file in dev),
 * runs `fn`, and saves when the tool mutated anything.
 */
export async function withStore<T>(fn: (store: Store) => Promise<T> | T, opts: { write?: boolean } = {}): Promise<T> {
  // Writers hold a short Redis lock so two missions (phone + web) never overwrite each other's state.
  const release = opts.write ? await acquireLock() : null;
  try {
    const persistence = defaultPersistence();
    const store = await openStore(persistence);
    const result = await fn(store);
    if (opts.write) await persistence.save(store.snapshot());
    return result;
  } finally {
    await release?.();
  }
}

const LOCK_KEY = "scos:lock";

function redisRest(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

/** SET NX PX lock over Upstash REST; no-op locally (file persistence, single process). */
async function acquireLock(): Promise<(() => Promise<void>) | null> {
  const r = redisRest();
  if (!r) return null;
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const headers = { Authorization: `Bearer ${r.token}` };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${r.url}/set/${LOCK_KEY}/${owner}/NX/PX/20000`, { method: "POST", headers }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { result?: string | null } | null) : null;
    if (body?.result === "OK") {
      return async () => {
        const cur = await fetch(`${r.url}/get/${LOCK_KEY}`, { headers }).then((x) => x.json()).catch(() => null) as { result?: string | null } | null;
        if (cur?.result === owner) await fetch(`${r.url}/del/${LOCK_KEY}`, { method: "POST", headers }).catch(() => null);
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250));
  }
  return null; // proceed without the lock rather than stall a mission
}

/** Upserts board items into freshly loaded state (short read-modify-write, no network in between). */
export async function mergeBoardItems(items: BoardItem[]): Promise<void> {
  if (!items.length) return;
  await withStore((store) => {
    for (const item of items) store.addBoardItem(item);
  }, { write: true });
}

/**
 * Runs `fn` on a store that is never saved, then persists only the evidence-board items `fn` added.
 * Use for work that does network I/O (PubChem, You.com) or runs alongside other writers: saving the
 * whole snapshot read before the I/O would overwrite RFQs, quotes or negotiations written meanwhile.
 */
export async function withStoreBoardOnly<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
  let added: BoardItem[] = [];
  const result = await withStore(async (store) => {
    const before = new Set(store.boardItems().map((b) => b.id));
    const out = await fn(store);
    added = store.boardItems().filter((b) => !before.has(b.id));
    return out;
  });
  await mergeBoardItems(added);
  return result;
}
