import { defaultPersistence, openStore, type Store } from "@supply-agent/core";

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
