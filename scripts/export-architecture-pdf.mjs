#!/usr/bin/env node
/**
 * Renders docs/architecture/index.html to docs/architecture.pdf (A4 landscape, one sheet per page)
 * and one PNG per sheet in docs/architecture/png/.
 *
 *   node scripts/export-architecture-pdf.mjs
 *
 * The page is served over a local HTTP server (rooted at docs/) so sheet 9 can fetch
 * docs/sim-results.json, falling back to docs/architecture/data.json.
 * Needs network access for Google Fonts and the Mermaid CDN build.
 *
 * Playwright resolution order: `playwright` / `playwright-core` from node_modules, then
 * PLAYWRIGHT_MODULE (path to a playwright package dir), then any copy in the npx cache.
 * Browser: the bundled Chromium, falling back to the installed Google Chrome (channel "chrome").
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const OUT_PDF = join(DOCS, "architecture.pdf");
const PNG_DIR = join(DOCS, "architecture", "png");

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function serve(root) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** Yields importable Playwright modules, best candidate first. */
async function* playwrightCandidates() {
  const names = ["playwright", "playwright-core"];
  for (const name of names) {
    try { yield { mod: await import(name), from: name }; } catch { /* not installed locally */ }
  }
  const dirs = [];
  if (process.env.PLAYWRIGHT_MODULE) dirs.push(process.env.PLAYWRIGHT_MODULE);
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) {
    for (const d of await readdir(npx)) {
      for (const name of names) {
        const p = join(npx, d, "node_modules", name);
        if (existsSync(join(p, "package.json"))) dirs.push(p);
      }
    }
  }
  const withVersion = await Promise.all(dirs.map(async (d) => {
    try { return { d, v: JSON.parse(await readFile(join(d, "package.json"), "utf8")).version ?? "0" }; } catch { return { d, v: "0" }; }
  }));
  // stable releases first, newest first
  withVersion.sort((a, b) => (a.v.includes("-") - b.v.includes("-")) || b.v.localeCompare(a.v, undefined, { numeric: true }));
  for (const { d } of withVersion) {
    try { yield { mod: await import(pathToFileURL(join(d, "index.mjs")).href), from: d }; } catch { /* next */ }
  }
}

/** Launches headless Chromium from the first Playwright copy whose browser is installed; falls back to Google Chrome. */
async function launch() {
  const errors = [];
  let last = null;
  for await (const { mod, from } of playwrightCandidates()) {
    last = mod;
    try {
      const browser = await mod.chromium.launch({ headless: true });
      console.log(`playwright: ${from}`);
      return browser;
    } catch (e) { errors.push(`${from}: ${e.message.split("\n")[0]}`); }
  }
  if (last) {
    try { return await last.chromium.launch({ headless: true, channel: "chrome" }); } catch (e) { errors.push(`chrome channel: ${e.message.split("\n")[0]}`); }
  }
  throw new Error(
    "No usable Playwright + Chromium found. Install once with `pnpm add -D -w playwright && pnpm exec playwright install chromium` " +
      "(or `npx -y playwright install chromium`), then re-run.\n" + errors.join("\n"),
  );
}

const server = await serve(DOCS);
const { port } = server.address();
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 2 });
  page.on("console", (m) => { if (m.type() === "error") console.error(`[page] ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${port}/architecture/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90_000 });
  const errors = await page.evaluate(() => window.__errors);
  if (errors.length) throw new Error(`page reported errors:\n${errors.join("\n")}`);
  const fit = await page.evaluate(() => window.__fit);
  for (const f of fit) console.log(`mermaid ${f.target.padEnd(13)} natural ${f.natural.join("x")} in ${f.box.join("x")} -> scale ${f.scale}`);

  // PNG per sheet
  await mkdir(PNG_DIR, { recursive: true });
  for (const f of await readdir(PNG_DIR)) if (f.endsWith(".png")) await rm(join(PNG_DIR, f));
  const sheets = await page.$$(".sheet");
  for (const [i, el] of sheets.entries()) {
    const file = join(PNG_DIR, `sheet-${String(i + 1).padStart(2, "0")}.png`);
    await el.screenshot({ path: file });
  }

  // PDF
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ landscape: true, printBackground: true, preferCSSPageSize: true, format: "A4", margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await writeFile(OUT_PDF, pdf);
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`wrote ${OUT_PDF} (${pages} pages, ${(pdf.length / 1024).toFixed(0)} KB)`);
  console.log(`wrote ${sheets.length} PNGs to ${PNG_DIR}`);
  if (pages !== sheets.length) {
    console.error(`page count ${pages} does not match sheet count ${sheets.length}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
