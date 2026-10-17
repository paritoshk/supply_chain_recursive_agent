# Architecture drawing set

Nine A4-landscape sheets (DWG SCOS-001 to SCOS-009, Rev A) for Supplier Chief of Staff, styled with design system v1. All company data is synthetic; Corvane Biologics is fictional.

| File | What it is |
|---|---|
| `index.html` | Source of every sheet. Static: hand-drawn SVG for sheets 1-3, 7 and 8, Mermaid (CDN) for sheets 4-6, inline SVG charts for sheet 9. Fonts from Google Fonts. |
| `data.json` | Placeholder results for sheet 9, used only when `docs/sim-results.json` is missing. |
| `png/sheet-NN.png` | One PNG per sheet at 2x, written by the export. |
| `../architecture.pdf` | The drawing set, one sheet per page. |

## Export

```bash
node scripts/export-architecture-pdf.mjs
```

To run it as `pnpm export:pdf`, add this to the root `package.json` scripts:

```json
"export:pdf": "node scripts/export-architecture-pdf.mjs"
```

The script serves `docs/` on a local port, waits for `window.__ready` (fonts loaded, Mermaid rendered, results drawn), then writes the PDF (`@page` A4 landscape, `printBackground`) and the PNGs. It fails if the page reports an error or the page count differs from the sheet count. It needs network access for the fonts and Mermaid.

Playwright is looked up in `node_modules`, then `PLAYWRIGHT_MODULE`, then the npx cache. If none is found, install it once with `pnpm add -D -w playwright && pnpm exec playwright install chromium`.

## Sheet 9 data

Sheet 9 reads `docs/sim-results.json` if it exists, which is the simulator output with `days`, `seeds`, `assumptions`, `primary.{baseline,agent}.{metrics,hero}` and `mean.{baseline,agent}`. Bars show the mean over all seeds, and the hero row shows the primary seed. If the file is missing, sheet 9 falls back to `data.json` and labels itself as a placeholder. Check pass rates read `checks[].pass_rate` (0..1) from either file and show "eval pending" until a run provides them. Re-run the export after changing either file.
