import { round } from "./dates.ts";

export interface PriceBand {
  low: number | null;
  high: number | null;
}

export interface SisterDemand {
  site_id: string;
  qty: number;
}

export interface PriceInventoryInput {
  qty: number;
  /** Synthetic market band for the material, USD per unit. Null bounds -> no market price. */
  band: PriceBand | null;
  /** 1.0 = same grade as the band; <1 for downgraded/opened stock. */
  gradeFactor: number;
  daysToExpiry: number;
  shelfLife: number;
  /** Quantity other company sites need (below their reorder point). */
  sisterSiteDemand?: number | SisterDemand[];
}

export interface PriceInventoryResult {
  recommendation: "transfer" | "resell" | "hold";
  /** USD per unit for the recommended action (transfer at standard cost, resale at discounted market). */
  unit_price: number | null;
  total: number | null;
  rationale: string;
  expiry_discount: number;
  remaining_life_pct: number;
  transfer_qty: number;
  transfer_to: string[];
  /** External resale alternative, always reported when a market band exists. */
  resale_unit_price: number | null;
  resale_total: number | null;
}

/** Buyers discount short-dated stock. <=30 days remaining is treated as unsellable. */
export function expiryDiscount(daysToExpiry: number, shelfLife: number): number {
  if (daysToExpiry <= 30) return 1;
  const remaining = shelfLife > 0 ? daysToExpiry / shelfLife : 0;
  if (remaining >= 0.5) return 0;
  if (remaining >= 0.25) return 0.15;
  if (remaining >= 0.1) return 0.35;
  return 0.6;
}

/**
 * Values stock and recommends what to do with it. An internal transfer to a sister site that needs
 * the material is always considered before any external sale.
 */
export function priceInventory(input: PriceInventoryInput): PriceInventoryResult {
  const { qty, band, gradeFactor, daysToExpiry, shelfLife } = input;
  const demandList: SisterDemand[] = Array.isArray(input.sisterSiteDemand)
    ? input.sisterSiteDemand.filter((d) => d.qty > 0)
    : (input.sisterSiteDemand ?? 0) > 0
      ? [{ site_id: "sister_site", qty: input.sisterSiteDemand as number }]
      : [];
  const demand = demandList.reduce((s, d) => s + d.qty, 0);

  const mid = band && band.low != null && band.high != null ? (band.low + band.high) / 2 : null;
  const discount = expiryDiscount(daysToExpiry, shelfLife);
  const remainingPct = shelfLife > 0 ? round(Math.max(0, Math.min(1, daysToExpiry / shelfLife)) * 100, 1) : 0;
  const resaleUnit = mid != null && discount < 1 ? round(mid * gradeFactor * (1 - discount), 2) : null;
  const resaleTotal = resaleUnit != null ? round(resaleUnit * qty, 2) : null;

  const base = {
    expiry_discount: discount,
    remaining_life_pct: remainingPct,
    resale_unit_price: resaleUnit,
    resale_total: resaleTotal,
  };

  if (demand > 0 && daysToExpiry > 30) {
    const transferQty = Math.min(qty, demand);
    const unit = mid != null ? round(mid * gradeFactor, 2) : null;
    return {
      ...base,
      recommendation: "transfer",
      unit_price: unit,
      total: unit != null ? round(unit * transferQty, 2) : null,
      transfer_qty: transferQty,
      transfer_to: demandList.map((d) => d.site_id),
      rationale:
        `Sister site demand of ${round(demand, 1)} covers ${round(transferQty, 1)} of ${round(qty, 1)} units. ` +
        `Internal transfer at standard cost avoids an expiry write-off and an external purchase` +
        (resaleUnit != null
          ? `; external resale would net only ${resaleUnit}/unit after a ${Math.round(discount * 100)}% expiry discount.`
          : "."),
    };
  }

  if (resaleUnit != null) {
    return {
      ...base,
      recommendation: "resell",
      unit_price: resaleUnit,
      total: resaleTotal,
      transfer_qty: 0,
      transfer_to: [],
      rationale:
        `No sister site needs it. Market mid ${round(mid as number, 2)}/unit x grade factor ${gradeFactor} ` +
        `x (1 - ${Math.round(discount * 100)}% expiry discount, ${remainingPct}% shelf life left).`,
    };
  }

  return {
    ...base,
    recommendation: "hold",
    unit_price: null,
    total: null,
    transfer_qty: 0,
    transfer_to: [],
    rationale:
      mid == null
        ? "No market price band (quote-only material); value requires an RFQ. Hold."
        : `Only ${daysToExpiry} days to expiry: not resaleable. Hold for internal use or disposition review.`,
  };
}
