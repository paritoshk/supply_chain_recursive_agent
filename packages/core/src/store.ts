/**
 * In-memory data store. All entities live in plain arrays, seeded deterministically from src/seed.
 * State round-trips through `snapshot()` / `load(json)` as a single JSON blob, so it can be persisted
 * anywhere (local file adapter below; a Redis adapter can implement the same `Persistence` interface).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { addDays } from "./logic/dates.ts";
import { generateSeed, type SeedData } from "./seed/generate.ts";
import type {
  AgentRun,
  Consumption,
  Finding,
  Lot,
  MaterialSupplier,
  Message,
  Mission,
  NegotiationThread,
  PurchaseOrder,
  Quote,
  RFQ,
} from "./types.ts";

export const STATE_VERSION = 1;

export interface StoreState extends SeedData {
  version: number;
  /** Supplier-persona negotiation threads, one per (rfq, supplier). Backfilled to [] for older snapshots. */
  negotiations: NegotiationThread[];
}

type Patch<T> = Partial<Omit<T, "external_id" | "id">>;
type WithOptionalId<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

const pad = (n: number, w = 4) => String(n).padStart(w, "0");
const maxSeq = (ids: string[], prefix: string) =>
  ids.reduce((m, id) => (id.startsWith(prefix) ? Math.max(m, Number(id.slice(prefix.length)) || 0) : m), 0);
const nowIso = () => new Date().toISOString();

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} not found`);
  return v;
}

export class Store {
  private s: StoreState;

  constructor(state: StoreState) {
    this.s = state;
  }

  // ---- time ----
  today(): string {
    return this.s.today;
  }
  setToday(day: string): void {
    this.s.today = day;
  }
  /** "Simulate day": advances the clock and burns released stock FEFO at each site's daily rate. */
  advanceDay(days = 1): string {
    for (let d = 0; d < days; d++) {
      this.s.today = addDays(this.s.today, 1);
      for (const c of this.s.consumption) {
        let need = c.daily_rate;
        const lots = this.lots({ material_id: c.material_id, site_id: c.site_id, status: "released" })
          .filter((l) => l.qty > 0 && l.expiry_date > this.s.today)
          .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
        for (const lot of lots) {
          if (need <= 0) break;
          const take = Math.min(lot.qty, need);
          lot.qty = Math.round((lot.qty - take) * 10_000) / 10_000;
          need -= take;
        }
      }
    }
    return this.s.today;
  }

  // ---- reference data ----
  sites() { return this.s.sites; }
  site(id: string) { return this.s.sites.find((x) => x.external_id === id); }
  materials() { return this.s.materials; }
  material(id: string) { return this.s.materials.find((x) => x.external_id === id); }
  products() { return this.s.products; }
  product(id: string) { return this.s.products.find((x) => x.external_id === id); }
  boms() { return this.s.boms; }
  suppliers() { return this.s.suppliers; }
  supplier(id: string) { return this.s.suppliers.find((x) => x.external_id === id); }

  materialSuppliers(f: Partial<Pick<MaterialSupplier, "material_id" | "supplier_id" | "qualification_state">> = {}) {
    return this.s.material_suppliers.filter(
      (x) =>
        (!f.material_id || x.material_id === f.material_id) &&
        (!f.supplier_id || x.supplier_id === f.supplier_id) &&
        (!f.qualification_state || x.qualification_state === f.qualification_state),
    );
  }
  lots(f: Partial<Pick<Lot, "material_id" | "site_id" | "status">> = {}) {
    return this.s.lots.filter(
      (x) =>
        (!f.material_id || x.material_id === f.material_id) &&
        (!f.site_id || x.site_id === f.site_id) &&
        (!f.status || x.status === f.status),
    );
  }
  lot(id: string) { return this.s.lots.find((x) => x.external_id === id); }
  consumption(f: Partial<Pick<Consumption, "material_id" | "site_id">> = {}) {
    return this.s.consumption.filter(
      (x) => (!f.material_id || x.material_id === f.material_id) && (!f.site_id || x.site_id === f.site_id),
    );
  }
  consumptionFor(materialId: string, siteId: string) {
    return this.s.consumption.find((x) => x.material_id === materialId && x.site_id === siteId);
  }
  rfqs(f: Partial<Pick<RFQ, "material_id" | "site_id" | "status" | "mission_id">> = {}) {
    return this.s.rfqs.filter(
      (x) =>
        (!f.material_id || x.material_id === f.material_id) &&
        (!f.site_id || x.site_id === f.site_id) &&
        (!f.status || x.status === f.status) &&
        (!f.mission_id || x.mission_id === f.mission_id),
    );
  }
  rfq(id: string) { return this.s.rfqs.find((x) => x.external_id === id); }
  quotes(rfqId?: string) { return rfqId ? this.s.quotes.filter((q) => q.rfq_id === rfqId) : this.s.quotes; }
  purchaseOrders() { return this.s.purchase_orders; }
  missions() { return this.s.missions; }
  mission(id: string) { return this.s.missions.find((x) => x.id === id); }
  agentRuns(missionId?: string) {
    return missionId ? this.s.agent_runs.filter((r) => r.mission_id === missionId) : this.s.agent_runs;
  }
  agentRun(id: string) { return this.s.agent_runs.find((x) => x.id === id); }
  messages(missionId?: string) {
    return missionId ? this.s.messages.filter((m) => m.mission_id === missionId) : this.s.messages;
  }
  findings(missionId?: string) {
    return missionId ? this.s.findings.filter((f) => f.mission_id === missionId) : this.s.findings;
  }
  negotiations(f: Partial<Pick<NegotiationThread, "rfq_id" | "supplier_id">> = {}) {
    return this.s.negotiations.filter(
      (n) => (!f.rfq_id || n.rfq_id === f.rfq_id) && (!f.supplier_id || n.supplier_id === f.supplier_id),
    );
  }
  negotiation(rfqId: string, supplierId: string) {
    return this.s.negotiations.find((n) => n.rfq_id === rfqId && n.supplier_id === supplierId);
  }

  // ---- ids ----
  nextRfqId(): string {
    return `RFQ-${pad(maxSeq(this.s.rfqs.map((r) => r.external_id), "RFQ-") + 1, 3)}`;
  }

  // ---- mutators ----
  addRFQ(input: WithOptionalId<RFQ, "external_id">): RFQ {
    const rfq: RFQ = { created_at: nowIso(), ...input, external_id: input.external_id ?? this.nextRfqId() };
    if (this.rfq(rfq.external_id)) throw new Error(`${rfq.external_id} already exists`);
    this.s.rfqs.push(rfq);
    return rfq;
  }
  updateRFQ(id: string, patch: Patch<RFQ>): RFQ {
    return Object.assign(must(this.rfq(id), id), patch);
  }
  addQuote(input: WithOptionalId<Quote, "external_id">): Quote {
    const id = input.external_id ?? `Q-${pad(maxSeq(this.s.quotes.map((q) => q.external_id), "Q-") + 1)}`;
    const quote: Quote = { received_at: nowIso(), ...input, external_id: id };
    this.s.quotes.push(quote);
    return quote;
  }
  addLot(lot: Lot): Lot {
    this.s.lots.push(lot);
    return lot;
  }
  updateLot(id: string, patch: Patch<Lot>): Lot {
    return Object.assign(must(this.lot(id), id), patch);
  }
  addMaterialSupplier(input: WithOptionalId<MaterialSupplier, "external_id">): MaterialSupplier {
    const id = input.external_id ?? `MS-${pad(maxSeq(this.s.material_suppliers.map((m) => m.external_id), "MS-") + 1)}`;
    const ms: MaterialSupplier = { ...input, external_id: id };
    this.s.material_suppliers.push(ms);
    return ms;
  }
  updateMaterialSupplier(id: string, patch: Patch<MaterialSupplier>): MaterialSupplier {
    return Object.assign(must(this.s.material_suppliers.find((m) => m.external_id === id), id), patch);
  }
  /** Draft only. Nothing is ever placed automatically. */
  addPurchaseOrder(input: WithOptionalId<PurchaseOrder, "external_id">): PurchaseOrder {
    const id = input.external_id ?? `PO-DRAFT-${pad(this.s.purchase_orders.length + 1, 3)}`;
    const po: PurchaseOrder = { created_at: nowIso(), ...input, status: "draft", external_id: id };
    this.s.purchase_orders.push(po);
    return po;
  }
  addMission(input: WithOptionalId<Mission, "id" | "created_at">): Mission {
    const id = input.id ?? `MSN-${pad(maxSeq(this.s.missions.map((m) => m.id), "MSN-") + 1)}`;
    const mission: Mission = { ...input, id, created_at: input.created_at ?? nowIso() };
    this.s.missions.push(mission);
    return mission;
  }
  updateMission(id: string, patch: Partial<Omit<Mission, "id">>): Mission {
    return Object.assign(must(this.mission(id), id), patch);
  }
  addAgentRun(input: WithOptionalId<AgentRun, "id" | "started_at">): AgentRun {
    const id = input.id ?? `RUN-${pad(maxSeq(this.s.agent_runs.map((r) => r.id), "RUN-") + 1, 5)}`;
    const run: AgentRun = { ...input, id, started_at: input.started_at ?? nowIso() };
    this.s.agent_runs.push(run);
    return run;
  }
  updateAgentRun(id: string, patch: Partial<Omit<AgentRun, "id">>): AgentRun {
    return Object.assign(must(this.agentRun(id), id), patch);
  }
  addMessage(input: Message): Message {
    const msg: Message = {
      created_at: nowIso(),
      ...input,
      id: input.id ?? `MSG-${pad(maxSeq(this.s.messages.map((m) => m.id ?? ""), "MSG-") + 1, 5)}`,
    };
    this.s.messages.push(msg);
    return msg;
  }
  addFinding(input: Finding): Finding {
    const f: Finding = {
      created_at: nowIso(),
      ...input,
      id: input.id ?? `FND-${pad(maxSeq(this.s.findings.map((x) => x.id ?? ""), "FND-") + 1)}`,
    };
    this.s.findings.push(f);
    return f;
  }

  addNegotiation(thread: NegotiationThread): NegotiationThread {
    if (this.negotiation(thread.rfq_id, thread.supplier_id)) throw new Error(`${thread.id} already exists`);
    this.s.negotiations.push(thread);
    return thread;
  }
  updateNegotiation(id: string, patch: Partial<Omit<NegotiationThread, "id">>): NegotiationThread {
    return Object.assign(must(this.s.negotiations.find((n) => n.id === id), id), patch);
  }

  // ---- persistence ----
  snapshot(): StoreState {
    return structuredClone(this.s);
  }
  load(json: StoreState | string): void {
    const state = typeof json === "string" ? (JSON.parse(json) as StoreState) : structuredClone(json);
    if (state.version !== STATE_VERSION) throw new Error(`unsupported state version ${state.version}`);
    state.negotiations ??= [];
    this.s = state;
  }
}

/** Creates a store from seed data (defaults to the deterministic Corvane seed) or a saved snapshot. */
export function createStore(seed: SeedData | StoreState = generateSeed()): Store {
  const state = structuredClone(seed) as Partial<StoreState> & SeedData;
  return new Store({ ...state, negotiations: state.negotiations ?? [], version: STATE_VERSION });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface Persistence {
  load(): Promise<StoreState | null>;
  save(state: StoreState): Promise<void>;
}

function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** STATE_FILE, else /tmp on Vercel (the deploy bundle is read-only), else <repo>/.data/state.json. */
export function defaultStatePath(): string {
  if (process.env.STATE_FILE) return process.env.STATE_FILE;
  if (process.env.VERCEL) return join("/tmp", "supplier-chief-of-staff", "state.json");
  return join(findRepoRoot(), ".data", "state.json");
}

/** Local JSON file adapter (atomic write via rename). */
export function filePersistence(path = defaultStatePath()): Persistence {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as StoreState;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, path);
    },
  };
}

export const REDIS_STATE_KEY = "scos:state";

export interface RedisConfig {
  url: string;
  token: string;
}

/** Upstash REST credentials: UPSTASH_REDIS_REST_URL/TOKEN, or the Vercel KV aliases KV_REST_API_URL/TOKEN. */
export function redisConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConfig | null {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

/**
 * Upstash Redis REST adapter: the whole state is one JSON string under `scos:state`.
 * Uses plain fetch with the command-array form (POST <url> ["GET", key] / ["SET", key, value]).
 */
export function redisPersistence(
  cfg: RedisConfig | null = redisConfigFromEnv(),
  key = REDIS_STATE_KEY,
  fetchImpl: typeof fetch = fetch,
): Persistence {
  if (!cfg) throw new Error("redisPersistence: set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN");
  const command = async (args: string[]): Promise<unknown> => {
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`upstash ${args[0]} ${res.status}: ${body.error ?? "request failed"}`);
    return body.result;
  };
  return {
    async load() {
      const raw = await command(["GET", key]);
      return typeof raw === "string" && raw.length ? (JSON.parse(raw) as StoreState) : null;
    },
    async save(state) {
      await command(["SET", key, JSON.stringify(state)]);
    },
  };
}

/** Redis when Upstash / Vercel KV credentials are present, otherwise the local (or /tmp on Vercel) file. */
export function defaultPersistence(env: NodeJS.ProcessEnv = process.env): Persistence {
  const cfg = redisConfigFromEnv(env);
  return cfg ? redisPersistence(cfg) : filePersistence();
}

/** Loads persisted state if present, otherwise seeds a fresh store. */
export async function openStore(persistence: Persistence = defaultPersistence()): Promise<Store> {
  const saved = await persistence.load();
  const store = createStore();
  if (saved) store.load(saved);
  return store;
}
