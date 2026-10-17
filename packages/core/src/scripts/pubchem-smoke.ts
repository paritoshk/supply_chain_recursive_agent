/**
 * Live PubChem smoke test (network, keyless): pnpm --filter @supply-agent/core smoke:pubchem [MAT-ID ...]
 * Defaults to the hero excipient plus a polymer and a licensed adjuvant to show the no-CID paths.
 */
import { pubchemLookup } from "../pubchem.ts";
import { createStore } from "../store.ts";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["MAT-SUC-INJ", "MAT-MAN-PAR", "MAT-NAOH", "MAT-PS80-SR", "MAT-SAP-QS"];
const store = createStore();
let failed = 0;
for (const id of ids) {
  const m = store.material(id);
  if (!m) {
    console.log(`${id}: unknown material`);
    failed++;
    continue;
  }
  const t0 = Date.now();
  const r = await pubchemLookup(m);
  const ms = Date.now() - t0;
  if (r.status === "found") {
    const c = r.compound;
    console.log(`${id} (${m.substance}): CID ${c.cid}, ${c.molecular_formula}, MW ${c.molecular_weight}, CAS ${c.cas.join("/") || "-"}, XLogP ${c.xlogp ?? "-"}, GHS ${c.ghs ? c.ghs.classification_note ?? `${c.ghs.signal_word ?? ""} ${c.ghs.hazard_statements.join("; ")}` : "-"} [${ms} ms]`);
    console.log(`  image: ${c.image_url}`);
  } else {
    console.log(`${id} (${m.substance}): ${r.status}: ${r.explanation} [${ms} ms]`);
    if (r.status === "error") failed++;
  }
}
if (failed) process.exit(1);
