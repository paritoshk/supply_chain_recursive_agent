import { defineChannel, GET, HEAD } from "eve/channels";

// Replaces eve's default home page with a landing page for the demo. Static; no data, no secrets.
const REPO = "https://github.com/paritoshk/supply_chain_recursive_agent";
const RAW = "https://raw.githubusercontent.com/paritoshk/supply_chain_recursive_agent/main";
const WEB = (process.env.WEB_URL || "https://supplier-chief-of-staff-web.vercel.app").replace(/\/$/, "");

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Supplier Chief of Staff · recursive supply agents</title>
<meta name="description" content="A recursive agent team that keeps a pharma plant from running out of materials. Built on Crusoe Managed Inference with NVIDIA Nemotron.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Inter+Tight:wght@300;400&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">
<style>
  :root { --bg:#FDFDFC; --card:#FFFFFF; --ink:#141311; --n80:#3D3B39; --n70:#5B5957; --n50:#908E87; --n30:#D4D2CF; --n20:#EAE8E5; --acc:#F25C05; --ok:#16A34A; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:400 16px/1.55 Inter, system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:inherit; }
  .wrap { max-width:1080px; margin:0 auto; padding:0 24px; }
  .mono { font:400 11px/1.3 "Geist Mono", ui-monospace, monospace; letter-spacing:.06em; text-transform:uppercase; color:var(--n50); }
  header { display:flex; justify-content:space-between; align-items:center; padding:20px 0; border-bottom:1px solid var(--n20); }
  header nav a { margin-left:20px; text-decoration:none; color:var(--n70); font-size:14px; }
  header nav a:hover { color:var(--ink); }
  .status { display:inline-flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 3px rgba(22,163,74,.15); }
  .hero { padding:72px 0 40px; }
  h1 { font:300 56px/1.05 "Inter Tight", Inter, sans-serif; letter-spacing:-.02em; margin:14px 0 18px; max-width:880px; }
  h1 span { color:var(--n50); }
  .lead { font-size:19px; color:var(--n80); max-width:720px; margin:0 0 30px; }
  .cta { display:flex; flex-wrap:wrap; gap:12px; }
  .btn { display:inline-flex; align-items:center; gap:8px; padding:13px 20px; border-radius:999px; text-decoration:none; font-weight:500; font-size:15px; border:1px solid var(--n30); background:var(--card); }
  .btn.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
  .btn:hover { border-color:var(--ink); }
  .btn.primary:hover { filter:brightness(1.05); border-color:var(--acc); }
  .note { margin-top:18px; font-size:13px; color:var(--n50); }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); border-top:1px solid var(--n20); border-bottom:1px solid var(--n20); margin:40px 0 56px; }
  .stat { padding:22px 18px 22px 0; }
  .stat + .stat { padding-left:18px; border-left:1px solid var(--n20); }
  .stat b { display:block; font:300 40px/1.05 "Inter Tight", sans-serif; margin:8px 0 6px; font-variant-numeric:tabular-nums; }
  .stat:first-child b { color:var(--acc); }
  .stat p { margin:0; font-size:13px; color:var(--n70); }
  h2 { font:300 32px/1.15 "Inter Tight", sans-serif; letter-spacing:-.01em; margin:0 0 20px; }
  .steps { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:56px; }
  .step { background:var(--card); border:1px solid var(--n20); border-radius:10px; padding:18px; }
  .step h3 { font:400 17px/1.25 "Inter Tight", sans-serif; margin:8px 0 8px; }
  .step p { margin:0; font-size:14px; color:var(--n70); }
  figure { margin:0 0 56px; border:1px solid var(--n20); border-radius:10px; overflow:hidden; background:var(--card); }
  figure img { width:100%; display:block; }
  figcaption { padding:12px 16px; font-size:13px; color:var(--n70); border-top:1px solid var(--n20); }
  .links { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:56px; }
  .link { display:block; text-decoration:none; background:var(--card); border:1px solid var(--n20); border-radius:10px; padding:18px; }
  .link:hover { border-color:var(--ink); }
  .link h3 { font:400 17px/1.25 "Inter Tight", sans-serif; margin:6px 0 6px; }
  .link p { margin:0; font-size:14px; color:var(--n70); }
  pre { background:var(--ink); color:#F5F5F4; border-radius:10px; padding:18px; overflow:auto; font:400 13px/1.55 "Geist Mono", ui-monospace, monospace; margin:0 0 56px; }
  footer { border-top:1px solid var(--n20); padding:24px 0 48px; font-size:13px; color:var(--n50); display:flex; justify-content:space-between; flex-wrap:wrap; gap:12px; }
  @media (max-width:820px) { h1 { font-size:40px; } .stats, .steps, .links { grid-template-columns:1fr 1fr; } .stat:nth-child(3) { border-left:0; padding-left:0; } }
  @media (max-width:520px) { .stats, .steps, .links { grid-template-columns:1fr; } .stat + .stat { border-left:0; padding-left:0; border-top:1px solid var(--n20); } header nav { display:none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="mono status"><span class="dot"></span>Agent online</span>
    <nav><a href="${WEB}">Live demo</a><a href="/board">Evidence board</a><a href="${REPO}">GitHub</a></nav>
  </header>

  <section class="hero">
    <div class="mono">Recursive Agents Hackathon · 2026-10-17 · Crusoe Managed Inference · NVIDIA Nemotron</div>
    <h1>Supplier Chief of Staff. <span>Agents that keep a pharma plant from running out.</span></h1>
    <p class="lead">A sentinel watches every material at every site. When stock runs low, the agent writes its own definition of done, spawns sub-agents to find a transfer, negotiate with approved suppliers and scout the web, has an independent judge check the result, and texts the planner only when a decision is above its authority. It learns supplier reliability from every delivery.</p>
    <div class="cta">
      <a class="btn primary" href="${WEB}">Watch a mission live →</a>
      <a class="btn" href="https://t.me/supplychief_bot">Message @supplychief_bot</a>
      <a class="btn" href="/board">Evidence board</a>
    </div>
    <p class="note">Corvane Biologics is a fictional company; its inventory, suppliers and prices are synthetic. The models, orchestration, checks and approvals are real.</p>
  </section>

  <div class="stats">
    <div class="stat"><span class="mono">Stockout events</span><b>−79%</b><p>vs a manual planner, 90-day simulation, mean of 10 seeds</p></div>
    <div class="stat"><span class="mono">Planner minutes</span><b>−99%</b><p>21,450 → 228 over 90 days; mostly one-tap approvals</p></div>
    <div class="stat"><span class="mono">Learning</span><b>−22%</b><p>stockout days vs the rule-based agent when suppliers overstate reliability</p></div>
    <div class="stat"><span class="mono">Production mission</span><b>6/6</b><p>checks passed, about 3.5 minutes end to end on Vercel</p></div>
  </div>

  <h2>How a mission runs</h2>
  <div class="steps">
    <div class="step"><span class="mono">01 · code</span><h3>Sentinel</h3><p>Scans every position daily with no model call. A breach opens a mission.</p></div>
    <div class="step"><span class="mono">02 · definition of done</span><h3>Six checks first</h3><p>Covers the need, lands in time, qualified suppliers only, comparable quotes, batches stay feasible, every claim grounded.</p></div>
    <div class="step"><span class="mono">03 · recursion</span><h3>Sub-agents fan out</h3><p>Transfer, sourcing and scout in parallel. Sourcing spawns one negotiator per approved supplier.</p></div>
    <div class="step"><span class="mono">04 · judge</span><h3>Verify, re-plan or ask</h3><p>Code recomputes every number; a different model checks the claims. Up to 3 attempts, then a human above $25k.</p></div>
  </div>

  <figure>
    <img src="${RAW}/docs/architecture/png/sheet-03.png" alt="Recursive agent tree: planner, run_mission workflow, transfer, sourcing with negotiators, scout, and an independent verifier" loading="lazy">
    <figcaption>The agent tree. The judge never shares a model with the doers. Full drawing set: <a href="${REPO}/blob/main/docs/architecture.pdf">architecture.pdf</a>.</figcaption>
  </figure>

  <h2>Go deeper</h2>
  <div class="links">
    <a class="link" href="${WEB}"><span class="mono">Live</span><h3>Mission theater</h3><p>A simulated phone wired to this agent, next to the pipeline driven by its real event stream.</p></a>
    <a class="link" href="/board"><span class="mono">Live</span><h3>Evidence board</h3><p>Structure images, line-feasibility tables, QA packets and supplier evidence from missions.</p></a>
    <a class="link" href="${REPO}"><span class="mono">Code</span><h3>GitHub</h3><p>Agent app, shared core, simulator, evals. Everything built during the hackathon.</p></a>
    <a class="link" href="${REPO}/blob/main/docs/learning-results.md"><span class="mono">Results</span><h3>Self-improvement</h3><p>Supplier reliability learned from deliveries, ranked by risk-adjusted cost per client.</p></a>
    <a class="link" href="${REPO}/blob/main/docs/sim-results.md"><span class="mono">Results</span><h3>Simulation</h3><p>Manual planner vs agent on the same demand and supplier delays.</p></a>
    <a class="link" href="${REPO}/blob/main/docs/evals/RESULTS.md"><span class="mono">Results</span><h3>Model evals</h3><p>Tool selection, guardrails, spec matching and negotiation across four Nemotron models.</p></a>
  </div>

  <h2>Talk to it over HTTP</h2>
<pre>curl -s -X POST https://supplier-chief-of-staff.vercel.app/eve/v1/session \\
  -H 'content-type: application/json' \\
  -d '{"message":"What is running low at Ghent?"}'

curl -N https://supplier-chief-of-staff.vercel.app/eve/v1/session/&lt;sessionId&gt;/stream</pre>

  <footer>
    <span>Planner and sub-agents: Nemotron 3.5 Super VL · Judge: Nemotron 3 Super 120B · Suppliers: Nemotron 3 Nano · all on Crusoe</span>
    <span>Runs on eve on Vercel · <a href="/eve/v1/health">health</a></span>
  </footer>
</div>
</body>
</html>`;

const respond = async () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });

export default defineChannel({
  routes: [GET("/", respond), HEAD("/", respond)],
});
