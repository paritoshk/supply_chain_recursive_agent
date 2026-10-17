# Supplier Chief of Staff

Supplier Chief of Staff is a recursive agent that keeps a specialty-pharma manufacturer from running out of materials. A code-only sentinel scans every material at every site each day. When a position falls below its reorder point, the agent writes a definition of done and fans out to sub-agents that look for an internal transfer, negotiate with approved suppliers and scout the web for new sources. A separate judge then checks the result: numbers are recomputed in code, and a different model checks the doers' claims against those numbers. If the checks fail, the agent re-plans. The planner hears from it on Telegram only when a decision is above its authority. Everything runs on open NVIDIA Nemotron models on Crusoe Managed Inference.

- Live: https://supplier-chief-of-staff.vercel.app
- Telegram: [@supplychief_bot](https://t.me/supplychief_bot)
- Built during the Crusoe Recursive Agents Hackathon on 2026-10-17. See [Built during the hackathon](#built-during-the-hackathon).

The customer, **Corvane Biologics**, is fictional. Its sites, inventory, demand, suppliers and prices are synthetic (deterministic seed 1729).

## Watch it run

Mission theater (simulated Telegram phone wired to the live agent, next to a 3D view of the agent pipeline driven by the real event stream): https://supplier-chief-of-staff-web.vercel.app

Evidence board (PubChem structure images, feasibility tables, QA packets, supplier evidence): https://supplier-chief-of-staff.vercel.app/board

## What it does

Two outcomes matter to a supply planner: less time spent chasing shortages, and fewer stockouts. We measured both in a 90-day simulation over 107 material/site positions. The baseline policy is a manual planner: weekly review against a static reorder point, primary supplier only. Both policies see the same demand and the same injected supplier delays. Full results are in [docs/sim-results.md](docs/sim-results.md).

**The simulation is synthetic.** The company, demand, prices and delays are made up, and the per-task human minutes are assumed constants (30 min per shortage review, 120 per RFQ, 20 per transfer, 3 per approval ping). It is not a forecast of real-world performance.

| Metric | Baseline (manual) | Agent | Change |
|---|---:|---:|---:|
| Stockout events (seed 1729) | 7 | 2 | -71% |
| Stockout events (mean, seeds 1-10) | 7.5 | 1.6 | -79% |
| Stockout pair-days (seed 1729) | 138 | 68 | -51% |
| Fill rate, % (seed 1729) | 98.61 | 99.30 | +1% |
| Human minutes over 90 days (seed 1729) | 21,450 | 228 | -99% |
| Human touches (seed 1729) | 289 | 76 | -74% |
| Orders from non-qualified suppliers | 0 | 0 | 0 |

**The trade-off is expedite spend.** On seed 1729, expedite spend rises 24%, from $4,432 to $5,474. Over the 10-seed mean it rises from $1,947.6 to $380,520.8, and expedites go from 4.2 to 11.1. The agent buys speed whenever an expedited approved supplier can land before a stockout, and the current policy does not weigh expedite cost against stockout cost. Over the same 10 seeds, purchase spend at list price fell 2%, from $30,136,333 to $29,388,358.

On the hero position (injectable sucrose at Ghent, with the incumbent's lead time slipped from 42 to 70 days), the baseline has 46 stockout days. The agent has none: it transfers from King of Prussia and splits the order across two approved suppliers on day 0.

## Try it

### Telegram

Message [@supplychief_bot](https://t.me/supplychief_bot). Try "what's low at Ghent?" or "price our expiring mannitol at Cork". Purchase approvals above $25,000 arrive as inline Approve/Reject buttons.

### HTTP (eve session API)

The deployment exposes eve's standard session API. Start a session with a message, then stream its events as newline-delimited JSON:

```bash
curl -s -X POST https://supplier-chief-of-staff.vercel.app/eve/v1/session \
  -H "Content-Type: application/json" \
  -d '{"message":"Injectable sucrose at Ghent is low. Run a mission for MAT-SUC-INJ at SITE-GHE."}'
# {"ok":true,"sessionId":"wrun_...","status":"accepted"}

curl -N https://supplier-chief-of-staff.vercel.app/eve/v1/session/<sessionId>/stream
```

Operators can fire the sentinel immediately instead of waiting for the daily cron. The route is protected by `CRON_SECRET`:

```bash
curl -s -X POST https://supplier-chief-of-staff.vercel.app/ops/sentinel \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"material_id":"MAT-SUC-INJ","site_id":"SITE-GHE"}'
```

### Local

Requires Node 24 or later and pnpm.

```bash
pnpm install
cp .env.example .env          # set CRUSOE_API_KEY; YOU_DOT_COM_API_KEY for live discovery
pnpm --filter supplier-chief-of-staff dev
# eve dev serves http://127.0.0.1:2000 (session API at /eve/v1/session)
```

Without Upstash credentials, state is stored in a local JSON file (`.data/state.json`). Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to use Redis. Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET_TOKEN`, plus `TELEGRAM_CHAT_ID` for proactive alerts. `CRON_SECRET` protects `/ops/sentinel`.

## Architecture

The full drawing set is [docs/architecture.pdf](docs/architecture.pdf) (twelve sheets), with one PNG per sheet in [docs/architecture/png/](docs/architecture/png/):

| Sheet | Title |
|---|---|
| [1](docs/architecture/png/sheet-01.png) | Supplier Chief of Staff, in context |
| [2](docs/architecture/png/sheet-02.png) | One Vercel project, one shared core |
| [3](docs/architecture/png/sheet-03.png) | Agents that spawn agents |
| [4](docs/architecture/png/sheet-04.png) | From a code-only scan to a draft PO |
| [5](docs/architecture/png/sheet-05.png) | Faults are expected |
| [6](docs/architecture/png/sheet-06.png) | Three lifecycles, enforced in code |
| [7](docs/architecture/png/sheet-07.png) | The data model |
| [8](docs/architecture/png/sheet-08.png) | Deployed on Vercel |
| [9](docs/architecture/png/sheet-09.png) | Does it prevent stockouts? |
| [10](docs/architecture/png/sheet-10.png) | Which model earns which role (evals B1, B3, B4) |
| [11](docs/architecture/png/sheet-11.png) | Does the web scout find real suppliers? (evals B5, B5b, B6/B8) |
| [12](docs/architecture/png/sheet-12.png) | Better with every delivery |

In short:

- **Runtime.** [eve](https://eve.dev), Vercel's open-source agent framework, deployed as one Vercel project. Agents, sub-agents, tools, channels and schedules are files under `apps/agent/agent/`. Missions run as durable workflows.
- **Models.** Crusoe Managed Inference only, through its OpenAI-compatible Chat Completions endpoint. Each role reads its model from an environment variable.
- **State.** One JSON document in Upstash Redis (key `scos:state`), or a local file in development.
- **Channels.** Telegram (`@supplychief_bot`) with inline-button approvals, plus eve's HTTP session API.
- **Triggers.** A daily sentinel cron that scans positions in code with no model call, plus an authenticated `POST /ops/sentinel` route that fires it on demand.
- **External data.** You.com search (REST, plus the You.com MCP connections and the `you-web` and `you-research` skills on the scout) for supplier discovery, and openFDA for shortage and enforcement signals.
- **Shared core.** `packages/core` holds the types, inventory math, quote normalization, the supplier-persona negotiation, the simulator and every tool. The agent app calls into it.

### The recursion

`run_mission` is an eve workflow tool. In pseudocode:

```
run_mission(material, site):
  brief = prepare_mission()                 # need_qty, need_by, from the inventory position (code)
  done  = [covers_need, lands_in_time (lead + QC release), qualified_only, comparable_quotes, batches_feasible, grounded]

  for attempt in 1..3:
    if feedback was already tried: break    # loop guard
    in parallel:
      transfer = agent("transfer")          # sister-site surplus, FEFO lots
      sourcing = agent("sourcing")          # drafts RFQ, then for each approved supplier, in parallel:
                                            #   agent("negotiator") <-> simulated supplier persona
                                            #   (multi-turn; offers clamped in code to a hidden profile;
                                            #    accept_offer stores only the supplier's last offer)
      scout    = agent("scout")             # You.com + openFDA; discovery candidates only

    facts   = recompute_in_code(store)      # judge part 1: transfer, quotes, plan, 5 numeric checks incl. line feasibility
    verdict = agent("verifier", claims, facts)  # judge part 2: different model, grounding check

    if numeric checks pass:         decision = accept;   break
    if plan.unfixable or attempt 3: decision = escalate; break
    feedback = concrete instructions from failed checks + judge notes   # re-plan

  if purchase and accepted and value <= $25k: auto-approve
  elif purchase:                              Telegram Approve / Reject
  else (no qualified source can close it):    refuse substitution; offer "Open qualification task"
```

The plan the agent acts on is always the one recomputed in code. A grounding miss from the judge does not block a numerically sound plan. It is reported, and on a re-plan it is fed back to the doers.

### Live production run

This run happened on the Vercel deployment during the hackathon. Inventory and suppliers are synthetic, and supplier replies are simulated. The model calls, orchestration, checks and approval are real.

- Trigger: Ghent injectable sucrose at 24 days of cover against a 280 kg reorder point.
- Plan: transfer 160 kg from King of Prussia, and buy 210 kg from an approved supplier on RFQ-102 at about $29/kg landed (about $6.1k).
- Latest production run (after adding QC release time and production-line feasibility): 6 of 6 checks passed, including `grounded`; all 18 scheduled sucrose batches at Ghent stay feasible (11 of 18 at risk with no action); change control flagged because the supplier is new to Ghent. Purchase 210 kg at $29.18/kg landed (lead 23 d + QC 7 d, $6,128), under $25k from a released_for_use supplier, so it was auto-approved. About 3.5 minutes end to end.
- Time: about 5 minutes on Vercel (about 2 minutes locally).
- The judge flagged two misstated details in the doers' prose. The numbers the agent acted on came from code, so the plan stood, and the flags were reported. This is why the judge exists.

### Self-improvement

Within a mission the agent self-corrects: failed checks turn into concrete instructions for the next attempt. Across missions it learns in four places, all persisted in the store:

| What learns | From | Changes |
|---|---|---|
| Supplier reliability | Every recorded delivery (`record_delivery`): promised vs received date, incoming QC result | Beta beliefs per supplier for on-time rate, lateness and QC pass rate. Supplier-stated metrics are only a weak prior, and recent deliveries weigh more. |
| Supplier choice and reorder timing | Those beliefs plus a client profile (stockout cost per day, risk aversion, minimum P(in time)) | `supplier_reliability` ranks approved suppliers by risk-adjusted expected cost from a seeded Monte Carlo, with no fixed weights. The same suppliers rank differently for a tight vs loose deadline and for different clients. |
| Negotiation | Each accepted offer: opening vs settled price, expedite, turns | The next negotiator with that supplier gets the history on its first reply. |
| Mission lessons | Failed numeric checks and the judge's grounding flags | Added to every doer's context on the next mission for the same material. |

Learning moves rankings, reorder points, prompts and negotiation tactics only. Qualification state, the no-substitution rule, BIOSECURE blocks and the $25,000 limit stay fixed in code. When a supplier's observed on-time rate falls well below what it states, the agent recommends a QA supplier review. It does not disqualify the supplier itself.

In a 360-day synthetic simulation where a quarter of suppliers overstate their reliability (mean of 10 seeds, [docs/learning-results.md](docs/learning-results.md)):

| | Rule-based agent | Risk-scored, no learning | Risk-scored + learning |
|---|---|---|---|
| Stockout pair-days | 386 | 316 | 300 |
| Stockout cost (Corvane profile) | $78.6M | $73.9M | $67.4M |
| Belief error vs hidden truth | 11.7 pp | 11.7 pp | 7.9 pp |
| Expedite spend | $1.8M | $2.1M | $2.1M |

When suppliers perform as stated, the learning policy matches the non-learning one (164 vs 164 stockout pair-days). Under a lean-generics profile with cheap stockouts, the same agent buys fewer expedites than the rule-based one (60 vs 80). Reproduce with `pnpm --filter @supply-agent/core sim:learning`.

## Real vs simulated

| Component | Status | Notes |
|---|---|---|
| Agent recursion (planner, sub-agents, negotiators, judge) | Real | Real Crusoe model calls and tool use, orchestrated by eve on Vercel |
| Telegram channel and approvals | Real | `@supplychief_bot`, inline Approve/Reject and qualification buttons |
| Sentinel cron and `/ops/sentinel` | Real | The scan is code; the data it scans is synthetic |
| State persistence | Real | Upstash Redis |
| Inventory math (cover, reorder point, safety stock, need, need-by) | Real code | Applied to synthetic data |
| Quote normalization to landed USD | Real code | Fixed FX table, Incoterms, freight and testing adders |
| Supplier discovery | Real | Live You.com search. Results are labeled discovery candidates and never bought from |
| Regulatory signals | Real | Live openFDA shortage and enforcement data |
| Company, sites, lots, demand, suppliers, prices | Simulated | Corvane Biologics is fictional; seed 1729 |
| Supplier replies in negotiation | Simulated | A real model plays the supplier, but every offer is clamped in code to a hidden synthetic profile |
| Purchase orders | Simulated | Approval writes to the synthetic store; nothing is sent to any supplier or ERP |
| Outcome numbers (stockouts avoided, minutes saved) | Simulated | [docs/sim-results.md](docs/sim-results.md) |

## Models

All models run on Crusoe Managed Inference. The judge is a different model from the doers, so it never grades its own work. Rationale and benchmark gates are in [docs/model-selection.md](docs/model-selection.md).

| Role | Kind | Model | Env var |
|---|---|---|---|
| Planner | Doer | `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | `MODEL_PLANNER` |
| Transfer, sourcing, negotiator, scout sub-agents | Doer | `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | `MODEL_WORKER` |
| Supplier personas | Simulator | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, thinking off (about 0.7 s p50) | `MODEL_PERSONA` |
| Verifier (judge part 2) | Judge | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | `MODEL_VERIFIER` |
| Judge part 1, inventory math, quote comparison | Code | none | none |

Planned upgrade: Inkling-Small on a Crusoe self-serve deployment for the judge or the planner. It is gated by the benchmark in [docs/model-selection.md](docs/model-selection.md).

## Safety rules

These are enforced in code and restated in the agent instructions.

- **Never qualifies.** Only suppliers in `quality_approved` or `released_for_use` state are quoted or bought from. Web discoveries stay discovery candidates.
- **Never substitutes.** It will not swap in a different grade, salt, hydrate or analogue for a licensed material. For an unfixable shortage of a restricted material (for example the saponin adjuvant), it says so and offers to open a qualification task.
- **Only released stock counts.** Quarantined lots are not cover.
- **Numbers come from code.** Cover, need, landed cost, plan totals and check results are computed from the store. Quotes are created only from the supplier's last stored offer, never from numbers a model types in. A missing price stays `null` with a reason.
- **Bounded authority.** It auto-approves only purchases of $25,000 or less from approved suppliers whose plan passed every numeric check. Everything else goes to a human. It never changes formulations or releases batches.
- **Bounded loops.** At most 3 attempts, a loop guard on repeated feedback, early escalation when no re-plan can fix the gap, and a $2 token-cost cap per session.

## Repo layout

```
apps/agent/                 eve app, deployed to Vercel (package: supplier-chief-of-staff)
  agent/agent.ts            planner
  agent/instructions.md     planner instructions and hard rules
  agent/tools/              run_mission (workflow tool) and quick-question tools
  agent/subagents/          transfer, sourcing (with negotiator), scout, verifier
  agent/channels/           telegram, ops (/ops/sentinel), eve (HTTP session API)
  agent/schedules/          daily sentinel cron
  agent/lib/                mission logic, judge part 1, models, store, sentinel scan
packages/core/              @supply-agent/core: shared domain and logic
  src/types.ts              Zod contracts
  src/logic/                inventory, pricing, quotes, spec matching, qualification
  src/tools/                tool definitions and contract
  src/negotiation.ts        supplier personas with hidden profiles and offer clamping
  src/sim/                  90-day baseline vs agent simulator
  src/seed/                 deterministic synthetic company (seed 1729)
  src/crusoe.ts             Crusoe client: retries with jitter, concurrency limit, per-role models
  src/scripts/              seed, sim, live smoke, Crusoe smoke, persona benchmark
docs/                       architecture PDF and PNGs, sim results, model selection, demo script
scripts/                    architecture PDF export
```

## Tests

```bash
pnpm --filter @supply-agent/core test          # 109 tests: logic, seed, tools, negotiation, persistence, sim
pnpm --filter @supply-agent/core sim           # rewrites docs/sim-results.{md,json} (synthetic)
pnpm --filter @supply-agent/core smoke:live    # live You.com, openFDA and a 2-turn Crusoe persona exchange
pnpm --filter @supply-agent/core smoke:crusoe  # lists Crusoe models for your key
pnpm --filter @supply-agent/core bench:persona # persona latency and JSON validity per model
```

Core tests run offline. The persona falls back to a deterministic scripted mode, and network calls use a fake fetch.

## Host-platform-compatible contracts

The core types are designed so this agent can later become a feature inside a larger manufacturing platform without a translation layer. Field names for these entities mirror that platform's schema exactly (`packages/core/src/types.ts`):

| Contract | Purpose |
|---|---|
| `InventoryItem` | Stock position: `sku`, `quantity_on_hand`, `reorder_point`, `lead_time_days`, `unit_cost`, `warehouse_location` |
| `Supplier` | Supplier identity: `country`, `manufacturing_country`, `type` (manufacturer, distributor or broker) |
| `Part` | `mpn`, `manufacturer`, `category` |
| `Offer` | Append-only price observation: `price` (nullable), `currency`, `moq`, `stock_qty`, `lead_days`, `seen_at` |
| `ToolOutput` + `Citation` | Every tool returns `ingestion_status`, `source` and citations to `external_id`s or URLs |
| `Finding` | Alert payload: `headline`, `severity` (info, watch, action), `detail`, `cited_tool_calls` |

`BillOfMaterials`, `BomLineItem` and `WorkOrder` follow the same rule. Everything else (missions, RFQs, quotes, negotiation threads, agent runs) is new to this project.

## Built during the hackathon

Everything in this repository was built during the Crusoe Recursive Agents Hackathon on 2026-10-17. The initial commit was empty. Third-party pieces are used as dependencies: eve, the AI SDK, Zod and the You.com skills (with their license file).

## License

MIT.
