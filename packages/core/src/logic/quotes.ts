import type { Currency, Incoterm, Quote } from "../types.ts";
import { round } from "./dates.ts";

/** Synthetic FX table (units of USD per 1 unit of currency). Not live rates. */
export const DEFAULT_FX_TO_USD: Record<Currency, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CHF: 1.12,
  JPY: 0.0067,
  INR: 0.012,
  SGD: 0.74,
};

/**
 * Buyer-borne cost adder as a fraction of goods value, approximating the freight, insurance,
 * export/import clearance and duty the buyer still carries under each Incoterm (2020).
 * Explicit freight on the quote is added on top.
 */
export const DEFAULT_INCOTERM_ADDERS: Record<Incoterm, number> = {
  EXW: 0.1,
  FCA: 0.08,
  FOB: 0.07,
  CIF: 0.03,
  CIP: 0.03,
  DAP: 0.015,
  DDP: 0,
};

export interface NormalizeOptions {
  fxRates?: Partial<Record<Currency, number>>;
  incotermAdders?: Partial<Record<Incoterm, number>>;
}

export type QuoteLike = Pick<
  Quote,
  "unit_price" | "currency" | "incoterm" | "freight" | "testing_cost" | "qty"
> & { external_id?: string; supplier_id?: string; rfq_reason?: string | null | undefined };

export interface NormalizedQuote {
  quote_id: string | null;
  supplier_id: string | null;
  /** Landed cost in USD per unit (goods + incoterm adder + freight + testing). Null when unpriced. */
  landed_usd_per_unit: number | null;
  total_landed_usd: number | null;
  comparable: boolean;
  fx_rate: number | null;
  breakdown: {
    goods_usd: number;
    incoterm_adder_usd: number;
    freight_usd: number;
    testing_usd: number;
  } | null;
  /** Why the quote cannot be compared (e.g. no price, unknown currency). */
  reason: string | null;
}

/** Normalizes a supplier quote to landed USD per unit. Null-safe: a missing price stays null. */
export function normalizeQuote(quote: QuoteLike, opts: NormalizeOptions = {}): NormalizedQuote {
  const fx = { ...DEFAULT_FX_TO_USD, ...opts.fxRates }[quote.currency];
  const adder = { ...DEFAULT_INCOTERM_ADDERS, ...opts.incotermAdders }[quote.incoterm];
  const base = {
    quote_id: quote.external_id ?? null,
    supplier_id: quote.supplier_id ?? null,
  };
  if (quote.unit_price == null) {
    return {
      ...base,
      landed_usd_per_unit: null,
      total_landed_usd: null,
      comparable: false,
      fx_rate: fx ?? null,
      breakdown: null,
      reason: quote.rfq_reason ?? "no unit price quoted; RFQ follow-up required",
    };
  }
  if (fx == null || !(quote.qty > 0)) {
    return {
      ...base,
      landed_usd_per_unit: null,
      total_landed_usd: null,
      comparable: false,
      fx_rate: fx ?? null,
      breakdown: null,
      reason: fx == null ? `no FX rate for ${quote.currency}` : "quoted quantity must be positive",
    };
  }
  const goods = quote.unit_price * fx;
  const incotermAdder = goods * (adder ?? 0);
  const freight = ((quote.freight ?? 0) * fx) / quote.qty;
  const testing = ((quote.testing_cost ?? 0) * fx) / quote.qty;
  const landed = goods + incotermAdder + freight + testing;
  return {
    ...base,
    landed_usd_per_unit: round(landed, 4),
    total_landed_usd: round(landed * quote.qty, 2),
    comparable: true,
    fx_rate: fx,
    breakdown: {
      goods_usd: round(goods, 4),
      incoterm_adder_usd: round(incotermAdder, 4),
      freight_usd: round(freight, 4),
      testing_usd: round(testing, 4),
    },
    reason: null,
  };
}
