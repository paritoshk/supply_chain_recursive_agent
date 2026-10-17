/** Test-only fetch router: canned You.com and openFDA responses so tool tests run offline. */
export const YOU_FIXTURE = {
  results: {
    web: [
      { url: "https://excipient-maker.example.com/sucrose-lowendo", title: "Low Endotoxin Sucrose | ExcipientMaker GmbH", description: "GMP sucrose for parenteral use with DMF and CEP.", snippets: ["Ph. Eur., USP-NF, JP; low endotoxin"] },
      { url: "https://excipient-maker-example-com.translate.goog/sucrose", title: "proxy", description: "translated proxy copy" },
      { url: "https://www.pharmacompass.com/manufacturers-suppliers-exporters/sucrose-excipient", title: "Sucrose Excipient Manufacturers | Suppliers | PharmaCompass", description: "List of manufacturers with DMF/CEP filings" },
      { url: "https://en.wikipedia.org/wiki/Sucrose", title: "Sucrose - Wikipedia", description: "reference" },
      { url: "https://excipient-maker.example.com/other-page", title: "dup host", description: "same host again" },
    ],
  },
  metadata: { query: "fixture" },
};

export const SHORTAGE_FIXTURE = {
  meta: { results: { total: 3 } },
  results: [
    { generic_name: "Polysorbate 80 Injection", status: "Current", company_name: "Fixture Co" },
    { generic_name: "Polysorbate 80", status: "Resolved", company_name: "Fixture Co" },
    { generic_name: "Polysorbate 80", status: "Current", company_name: "Other Co" },
  ],
};

export const ENFORCEMENT_FIXTURE = {
  meta: { results: { total: 2 } },
  results: [
    { recall_number: "D-0001-2026", classification: "Class II", status: "Ongoing", recalling_firm: "Fixture Labs", product_description: "Eye drops (polysorbate 80 0.2%)" },
    { recall_number: "D-0002-2026", classification: "Class III", status: "Terminated", recalling_firm: "Fixture Labs", product_description: "Cream with polysorbate 80" },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface FakeFetchLog {
  calls: Array<{ url: string; method: string; body?: string }>;
}

export function fakeFetch(log: FakeFetchLog = { calls: [] }, opts: { noMatches?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.startsWith("https://ydc-index.io/v1/search")) return json(YOU_FIXTURE);
    if (url.startsWith("https://ydc-index.io/v1/contents")) {
      const { urls } = JSON.parse(String(init?.body)) as { urls: string[] };
      return json(urls.map((u) => ({ url: u, markdown: "# Sucrose\nIPEC-GMP certified. US DMF on file. CEP available. Ph. Eur. / USP-NF / JP. Low endotoxin, parenteral grade." })));
    }
    if (url.startsWith("https://api.fda.gov/drug/shortages.json"))
      return opts.noMatches ? json({ error: { code: "NOT_FOUND", message: "No matches found!" } }, 404) : json(SHORTAGE_FIXTURE);
    if (url.startsWith("https://api.fda.gov/drug/enforcement.json"))
      return opts.noMatches ? json({ error: { code: "NOT_FOUND", message: "No matches found!" } }, 404) : json(ENFORCEMENT_FIXTURE);
    return json({ error: `unexpected url ${url}` }, 500);
  }) as typeof fetch;
}
