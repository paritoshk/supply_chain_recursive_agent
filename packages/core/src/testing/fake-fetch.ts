/** Test-only fetch router: canned You.com, openFDA and PubChem responses so tool tests run offline. */
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

/** PubChem fixtures (sucrose, CID 5988) shaped like the live PUG REST / PUG View responses. */
export const PUBCHEM_PROPERTY_FIXTURE = {
  PropertyTable: {
    Properties: [
      {
        CID: 5988,
        MolecularFormula: "C12H22O11",
        MolecularWeight: "342.30",
        ConnectivitySMILES: "C(C1C(C(C(C(O1)OC2(C(C(C(O2)CO)O)O)CO)O)O)O)O",
        IUPACName: "(2R,3R,4S,5S,6R)-2-[(2S,3S,4S,5R)-3,4-dihydroxy-2,5-bis(hydroxymethyl)oxolan-2-yl]oxy-6-(hydroxymethyl)oxane-3,4,5-triol",
        XLogP: -3.7,
      },
    ],
  },
};
export const PUBCHEM_SYNONYMS_FIXTURE = { InformationList: { Information: [{ CID: 5988, Synonym: ["sucrose", "57-50-1", "saccharose", "Table sugar", "8030-20-7"] }] } };
export const PUBCHEM_GHS_FIXTURE = {
  Record: {
    RecordType: "CID",
    RecordNumber: 5988,
    Section: [
      {
        TOCHeading: "Safety and Hazards",
        Section: [
          {
            TOCHeading: "Hazards Identification",
            Section: [
              {
                TOCHeading: "GHS Classification",
                Information: [
                  { Name: "GHS Hazard Statements", Value: { StringWithMarkup: [{ String: "Not Classified" }, { String: "Reported as not meeting GHS hazard criteria by 423 of 442 companies." }] } },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};
export const PUBCHEM_NOT_FOUND = { Fault: { Code: "PUGREST.NotFound", Message: "No CID found", Details: ["No CID found that matches the given name"] } };

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
    if (url.startsWith("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/")) {
      const name = decodeURIComponent(url.split("/compound/name/")[1]!.split("/")[0]!).toLowerCase();
      return name === "sucrose" ? json(PUBCHEM_PROPERTY_FIXTURE) : json(PUBCHEM_NOT_FOUND, 404);
    }
    if (url.startsWith("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/5988/synonyms/JSON")) return json(PUBCHEM_SYNONYMS_FIXTURE);
    if (url.startsWith("https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/5988/JSON")) return json(PUBCHEM_GHS_FIXTURE);
    return json({ error: `unexpected url ${url}` }, 500);
  }) as typeof fetch;
}
