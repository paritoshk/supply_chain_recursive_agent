/** Seeds a fresh store and writes it to the persistence file (.data/state.json or STATE_FILE). */
import { coverProjection } from "../tools/data.ts";
import { HERO } from "../seed/index.ts";
import { createStore, defaultStatePath, filePersistence } from "../store.ts";

const store = createStore();
await filePersistence().save(store.snapshot());
const s = store.snapshot();
console.log(
  `seeded ${defaultStatePath()}: ${s.sites.length} sites, ${s.materials.length} materials, ${s.suppliers.length} suppliers, ` +
    `${s.material_suppliers.length} material-supplier links, ${s.lots.length} lots, ${s.consumption.length} consumption rows, ` +
    `${s.rfqs.length} RFQs, ${s.quotes.length} quotes; next RFQ ${store.nextRfqId()}`,
);
const hero = await coverProjection.run({ organizationId: "org_corvane", role: "sentinel", filters: {}, store }, { ...HERO, horizon_days: 60 });
const p = hero.position as { released_qty: number; quarantined_qty: number; cover_days: number; reorder_point: number; safety_stock: number; severity: string };
console.log(
  `hero ${HERO.material_id} @ ${HERO.site_id}: released ${p.released_qty} kg, quarantined ${p.quarantined_qty} kg, ` +
    `cover ${p.cover_days} d, ROP ${p.reorder_point} kg, safety stock ${p.safety_stock} kg, severity ${p.severity}`,
);
