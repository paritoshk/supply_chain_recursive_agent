import { defaultPersistence, openStore, type BoardItem, type Store } from "@supply-agent/core";

/**
 * Opens the shared supply state (one JSON blob: Upstash Redis on Vercel, a local file in dev),
 * runs `fn`, and saves when the tool mutated anything.
 */
export async function withStore<T>(fn: (store: Store) => Promise<T> | T, opts: { write?: boolean } = {}): Promise<T> {
  const persistence = defaultPersistence();
  const store = await openStore(persistence);
  const result = await fn(store);
  if (opts.write) await persistence.save(store.snapshot());
  return result;
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
