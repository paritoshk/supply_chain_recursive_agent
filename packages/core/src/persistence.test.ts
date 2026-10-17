import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, defaultPersistence, defaultStatePath, openStore, redisConfigFromEnv, redisPersistence, REDIS_STATE_KEY } from "./store.ts";

afterEach(() => vi.unstubAllEnvs());

/** Minimal in-memory Upstash REST emulation (command-array POST). */
function fakeUpstash() {
  const kv = new Map<string, string>();
  const calls: unknown[][] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer tok") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const cmd = JSON.parse(String(init?.body)) as string[];
    calls.push(cmd);
    if (cmd[0] === "GET") return new Response(JSON.stringify({ result: kv.get(cmd[1]!) ?? null }));
    if (cmd[0] === "SET") {
      kv.set(cmd[1]!, cmd[2]!);
      return new Response(JSON.stringify({ result: "OK" }));
    }
    return new Response(JSON.stringify({ error: "bad command" }), { status: 400 });
  }) as typeof fetch;
  return { kv, calls, f };
}

describe("persistence", () => {
  it("redisPersistence round-trips the whole state under scos:state", async () => {
    const up = fakeUpstash();
    const p = redisPersistence({ url: "https://kv.example", token: "tok" }, REDIS_STATE_KEY, up.f);
    expect(await p.load()).toBeNull();
    const store = createStore();
    store.advanceDay(2);
    await p.save(store.snapshot());
    expect(up.kv.has("scos:state")).toBe(true);
    const reopened = await openStore(p);
    expect(reopened.today()).toBe(store.today());
    expect(reopened.negotiations()).toEqual([]);
    expect(up.calls.map((c) => c[0])).toEqual(["GET", "SET", "GET"]);
  });

  it("surfaces Upstash errors", async () => {
    const up = fakeUpstash();
    const p = redisPersistence({ url: "https://kv.example", token: "wrong" }, REDIS_STATE_KEY, up.f);
    await expect(p.load()).rejects.toThrow(/upstash GET 401/);
  });

  it("env selection: Upstash or Vercel KV names, else file; /tmp on Vercel", () => {
    expect(redisConfigFromEnv({})).toBeNull();
    expect(redisConfigFromEnv({ UPSTASH_REDIS_REST_URL: "https://u.example/", UPSTASH_REDIS_REST_TOKEN: "t" })).toEqual({ url: "https://u.example", token: "t" });
    expect(redisConfigFromEnv({ KV_REST_API_URL: "https://k.example", KV_REST_API_TOKEN: "t" })).toEqual({ url: "https://k.example", token: "t" });
    expect(defaultPersistence({ KV_REST_API_URL: "https://k.example", KV_REST_API_TOKEN: "t" })).toBeTruthy();
    vi.stubEnv("STATE_FILE", "");
    vi.stubEnv("VERCEL", "1");
    expect(defaultStatePath().startsWith("/tmp/")).toBe(true);
    vi.stubEnv("STATE_FILE", "/x/state.json");
    expect(defaultStatePath()).toBe("/x/state.json");
  });

  it("older snapshots without negotiations load", () => {
    const store = createStore();
    const snap = store.snapshot() as Partial<ReturnType<typeof store.snapshot>>;
    delete snap.negotiations;
    store.load(JSON.stringify(snap));
    expect(store.negotiations()).toEqual([]);
  });
});
