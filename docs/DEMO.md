> Use the mission theater for the screen half of the video: https://supplier-chief-of-staff-web.vercel.app (click a mission chip; "Also alert my phone" fires the real Telegram alert for the phone half). Run `POST /ops/reset` (or the Reset demo link) before recording.

# Demo: Supplier Chief of Staff

Everything shown was built during the hackathon on 2026-10-17. Corvane Biologics is fictional. Its inventory, suppliers and prices are synthetic, and supplier replies in negotiation are simulated. The model calls, orchestration, checks, Telegram messages and approvals are real.

- Live app: https://supplier-chief-of-staff.vercel.app
- Telegram: @supplychief_bot

## Pre-flight (10 minutes before)

1. **Reset state** so the hero position has no open mission. In the Upstash console, delete the key `scos:state`. The next request reseeds the deterministic synthetic company (seed 1729).
2. **Export the secret** in the demo terminal: `export CRON_SECRET='...'` (single quotes).
3. **Open these windows:**
   - Telegram (desktop or phone mirrored), on the @supplychief_bot chat
   - Terminal with the commands below pasted and ready
   - Vercel dashboard on the project's run/log view
   - `docs/architecture.pdf`, open to sheet 3 ("Agents that spawn agents") and sheet 9 ("Does it prevent stockouts?")
4. **Know the timing.** A full hero mission takes about 5 minutes on Vercel, which is longer than the 3-minute slot. Fire it in the first 10 seconds and talk over it. Keep a recording of today's production run as a fallback.

Commands:

```bash
# A. Hero: injectable sucrose at Ghent
curl -s -X POST https://supplier-chief-of-staff.vercel.app/ops/sentinel \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"material_id":"MAT-SUC-INJ","site_id":"SITE-GHE"}'
# -> {"ok":true,"prompt":"Sentinel alert: ...","sessionId":"wrun_..."}

# B. Stream the session (paste the sessionId from A)
curl -N https://supplier-chief-of-staff.vercel.app/eve/v1/session/<sessionId>/stream

# C. Guardrail: licensed saponin adjuvant at Ghent
curl -s -X POST https://supplier-chief-of-staff.vercel.app/ops/sentinel \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"material_id":"MAT-SAP-QS","site_id":"SITE-GHE"}'
```

## 3-minute live demo

| Time | Say | Do |
|---|---|---|
| 0:00-0:15 | "Supply planners spend their days chasing shortages. This agent watches every material at every site and only texts you when there's a decision to make. The company is fictional and the data is synthetic. The agents, the models and the approvals are real." | Run command A. |
| 0:15-0:35 | "That was the sentinel. It's a daily cron, and this route fires it on demand. The scan is plain code with no model call. It found injectable sucrose at Ghent at 24 days of cover against a 280 kg reorder point." | Show the JSON response, then the Telegram alert. |
| 0:35-1:05 | "The planner model calls one tool, run_mission. It writes a definition of done first: covers the need, lands in time, qualified suppliers only, at least two comparable quotes, and every claim grounded. Then it fans out three sub-agents in parallel: transfer, sourcing and scout." | Run command B. Point at the `planned` event and the five check IDs. Show sheet 3 next to it. |
| 1:05-1:35 | "Sourcing drafts an RFQ and spawns one negotiator per approved supplier. Each negotiator has a multi-turn conversation with a simulated supplier. A small Nemotron model plays the supplier, but every offer is clamped in code to a hidden profile, so the model can't invent a better deal. When the negotiator accepts, we store the supplier's last offer, not a number the negotiator typed." | Show negotiator turns in the stream or the Vercel log. |
| 1:35-2:05 | "Now the judge, in two parts. Part one recomputes every number in code from the store. Part two is a different model, Nemotron Super 120B, which checks the doers' claims against those facts. In the latest production run all six checks passed: cover, lands in time counting QC release, qualified suppliers only, comparable quotes, every scheduled batch still feasible, and grounding. Earlier runs showed the judge catching misstated details in the doers' prose. We act on the numbers from code, and the judge's flags get reported. That's why the judge is a different model." | Point at the `verified` event: six checks pass, including `batches_feasible` (18/18 batches) and `grounded`. |
| 2:05-2:25 | "Result: transfer 160 kg from King of Prussia, buy 210 kg from an approved supplier on RFQ-102 at about $29 a kilo landed, about $6.1k. That's under the $25k limit with an approved supplier, so it auto-approved. Above $25k, the planner would get Approve and Reject buttons here." | Show the Telegram outcome message. If the live run isn't done, switch to the recording. |
| 2:25-2:45 | "Last, the guardrail. Licensed saponin adjuvant at Ghent: 30 days of cover against a 210-day lead time, and it's quote-only. No re-plan can fix that. The agent refuses to substitute the synthetic analogue and offers to open a qualification task instead." | Run command C. Show the Telegram message with the "Open qualification task" button. |
| 2:45-3:00 | "In a 90-day synthetic simulation over 107 positions, stockout events go from 7 to 2 and planner minutes from 21,450 to 228. Expedite spend goes up, and we report that. Everything here was built today." | Show sheet 9 of the PDF. |

If something fails on stage, say so. Faults are part of the design: sheet 5 covers persona timeouts and Crusoe 429s.

## 60-second video

Record at 1080p. Crop the terminal to a large font. Keep the "Synthetic data" labels visible.

| # | Time | Shot | Exact action | Voice-over |
|---|---|---|---|---|
| 1 | 0:00-0:05 | Title card | "Supplier Chief of Staff. Recursive agents on Crusoe. Built 2026-10-17." | "An agent that keeps a pharma plant from running out of materials." |
| 2 | 0:05-0:10 | Terminal | Run command A (fire sentinel). The JSON with `sessionId` appears. | "A code-only sentinel finds a shortage." |
| 3 | 0:10-0:15 | Telegram | The sentinel alert arrives in @supplychief_bot: Ghent sucrose, 24 days vs 280 kg reorder point. | "It texts the planner and starts a mission." |
| 4 | 0:15-0:27 | Split: eve stream and Vercel run trace | Run command B. Scroll past `planned` (five done-checks), then the transfer, sourcing, negotiator and scout sub-agent activity. | "It writes a definition of done, then spawns sub-agents. Sourcing spawns a negotiator per supplier. Each one haggles with a simulated supplier whose offers are clamped in code." |
| 5 | 0:27-0:37 | Stream, zoomed | Highlight the `verified` event: covers_need, lands_in_time, qualified_only and comparable_quotes pass, and the judge's grounding notes appear. | "A judge recomputes the numbers in code, and a different model checks the claims. Here it caught two misstated details." |
| 6 | 0:37-0:44 | Telegram | Outcome message: transfer 160 kg from King of Prussia, buy 210 kg on RFQ-102 at about $29/kg, about $6.1k, auto-approved. | "Under 25k from an approved supplier, so it auto-approves." |
| 7 | 0:44-0:52 | Terminal, then Telegram | Run command C. The saponin message appears with the "Open qualification task" button. Tap it. | "For a licensed adjuvant it won't substitute an analogue. It offers to start qualification." |
| 8 | 0:52-0:60 | PDF sheet 9 | Show the stockout and human-minutes bars, with the "synthetic simulation" label in frame. | "In a synthetic 90-day sim: 71% fewer stockouts and 99% less planner time, at higher expedite spend." |

## Judge Q&A cheat sheet

**Why eve?**
A mission has to survive minutes of model calls, parallel sub-agents and a human approval that might come hours later. eve runs `run_mission` as a durable workflow and gives us sub-agents, Telegram, schedules, MCP connections, human-in-the-loop buttons and an HTTP session API as plain files under `apps/agent/agent/`. It deploys to Vercel as one project. We wrote mission logic, not plumbing.

**Why is the judge a different model from the doers?**
A model checking its own output tends to agree with itself. The doers run on Nemotron 3.5 Super VL, and the judge runs on Nemotron 3 Super 120B with no tools. It only compares claims to facts. The facts themselves come from code (judge part one), so the judge never does arithmetic. In today's production run it flagged two misstated details that the doers had written in prose. The plan stood because the numbers came from code. The planned Inkling-Small upgrade moves one side at a time, so the judge and the doers stay on different models.

**What's simulated?**
The company (Corvane Biologics, fictional), its inventory, demand, suppliers and prices (seed 1729), the supplier side of each negotiation, and the purchase orders, which are written only to the synthetic store. The 90-day outcome numbers are a simulation with assumed human-minute costs. Real: every Crusoe model call, the eve orchestration on Vercel, the Upstash state, Telegram messages and buttons, live You.com search and live openFDA data.

**Can the supplier persona be talked into a bad number?**
No. The persona model writes the reply, but its offer is clamped in code to a hidden profile (list price, floor, lead time, expedite option, MOQ). `accept_offer` creates the quote from the last stored offer. The negotiator can't pass numbers in.

**What does a mission cost?**
Each session has a hard cap of $2 in token cost (`maxTokenCostUsdPerSession` in `agent.ts`). Personas run on Nemotron 3 Nano ($0.05 in / $0.20 out per 1M tokens on Crusoe's price list as of 2026-10-13), and the judge on Nemotron 3 Super 120B ($0.30 / $2.40). We have not yet aggregated per-mission token totals (agent-run records don't capture token counts yet), so we don't quote a measured figure. Crusoe's usage console is the source of truth. Benchmark B8 in `docs/model-selection.md` will report dollars per mission.

**What happens when something breaks?**
Branches run under `Promise.allSettled`, so one failed sub-agent doesn't sink the mission. Crusoe 429 and 503 responses are retried with backoff. A negotiator that times out is skipped. Missions are capped at 3 attempts with a loop guard, and they escalate early when no re-plan can fix the gap. Fault injection (`FAULTS=persona_timeout,crusoe_429,bad_tool_json`) exercises these paths.

**How does it port to a real manufacturer?**
The core contracts (`InventoryItem`, `Supplier`, `Part`, `Offer`, `ToolOutput` with `Citation`, and `Finding`) use the same field names as an existing manufacturing platform's schema, so the agent can become a feature there without a translation layer. To port it, replace the seeded store with the ERP read model, point discovery at the same You.com and openFDA tools, and replace the simulated supplier persona with real RFQ email or a supplier portal. Inventory math, checks, authority limits and guardrails stay as they are.

**Why not let the model do the math?**
In earlier evaluations, models extracted and classified from sources well but could not reliably do domain calculations. Cover, need, need-by date, landed cost and plan totals are code. Models explain those numbers and never produce them.

**Why Telegram?**
Planners live on their phones. Telegram gives inline buttons for Approve/Reject and "Open qualification task" with no app to install, and eve supports it as a first-class channel.
