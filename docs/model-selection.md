# Model selection: what runs today, and how Inkling-Small earns a role

Status, 2026-10-17. The deployed build runs only NVIDIA Nemotron models on Crusoe Managed Inference. Inkling-Small on a Crusoe self-serve deployment is the planned upgrade for the judge or the planner. It replaces a Nemotron model only if it passes the benchmark gates below.

## Decision

| Role | Kind | Model (deployed) | Where it runs | Fallback | Planned upgrade |
|---|---|---|---|---|---|
| Planner (orchestrator) | Doer | `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | Crusoe serverless | none | Inkling-Small (self-serve), gated by B1-B8 |
| Sub-agents: transfer, sourcing, negotiator, scout | Doer | `nvidia/NVIDIA-Nemotron-3.5-Super-VL` | Crusoe serverless | none | Moves with the planner |
| Supplier personas (high fan-out role-play) | Simulator | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, thinking off | Crusoe serverless | `nvidia/nemotron-3.5-lightning-30b-a3b`; offline scripted persona (`PERSONA_MODE=scripted`) | none |
| Verifier (judge part 2: grounding) | Judge | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | Crusoe serverless | none (a missing verdict is recorded as `grounded: false` and reported) | Inkling-Small (self-serve), gated by B2 and B3 |
| Judge part 1, inventory math, need and need-by, quote normalization, plan totals | Code | **Code, not a model** | `packages/core/src/logic`, `apps/agent/agent/lib/mission.ts` | not applicable | not applicable |

Rules that hold under every configuration:

- **Judge differs from doer.** The verifier never runs on the same model as the planner and sub-agents. If Inkling-Small takes the judge role, the doers stay on Nemotron. If it takes the planner and sub-agent roles, the judge stays on Nemotron 3 Super. One side moves at a time.
- **Every role reads its model from an environment variable:** `MODEL_PLANNER`, `MODEL_WORKER`, `MODEL_PERSONA`, `MODEL_VERIFIER`. Changing models never needs a code change. Defaults live in `apps/agent/agent/lib/models.ts` and `packages/core/src/crusoe.ts`.
- **Persona choice was measured.** With thinking off, Nano measured about 0.7 s p50 against about 1.0 s for Lightning, and both returned valid JSON (`pnpm --filter @supply-agent/core bench:persona`).

## Why Inkling-Small is the planned upgrade

1. **Best general capability among the eligible open models.** Inkling-Small scores 40 on the Artificial Analysis Intelligence Index (v4.1), the highest of the models we considered.
2. **Built for agents.** It is a sparse MoE with 276B total and 12B active parameters, routing each token to 6 of 256 experts plus 2 shared ones. With only 12B parameters active, it decodes fast enough for a planner that runs many short tool-calling turns.
3. **1M-token context.** A mission transcript, with every sub-agent's tool calls, fits in one context. The planner can re-plan with full history, and a judge can check claims against the whole transcript.
4. **A different model family from the doers.** As the judge, Inkling-Small would make the doer and judge independent at the family level, not just at the checkpoint level.
5. **Multimodal (text, image, audio).** This leaves room for reading a certificate of analysis, a spec sheet or a quote PDF later without adding a second model.
6. **Apache 2.0, US origin.** It is clean for enterprise and regulated customers. We check origin per model, not per vendor.
7. **One click on our inference provider.** `thinkingmachines/Inkling-Small` is in Crusoe's self-serve deployment catalog. That gives a dedicated endpoint on the same API, with no GPU operations work.
8. **Prior evidence.** In an earlier internal document-grounding evaluation (extraction, classification, grounded answers, hallucination), the larger sibling Inkling scored:
   - extraction F1 0.99
   - 100% grounded answers
   - 0% hallucination

   Inkling-Small was the lead candidate there for the assistant and agent roles. That full suite is still pending for Inkling-Small itself, so this repo's benchmark is the deciding test.

## Known risk, and how the design contains it

On the same index's knowledge-reliability test, Inkling-Small scores -9: it answered 57% of unanswerable trivia questions instead of declining. So **the general index does not decide the role; our grounded tests do.** The design assumes any model will sometimes make things up when it lacks data, and the deployed Nemotron build already works this way:

- **Numbers come from code.** Days of cover, reorder points, safety stock, need, need-by, supplier scores, landed cost, inventory value and plan totals are computed in code. Models read and explain those numbers; they never produce a price, quantity or date that the agent acts on.
  - The earlier evaluation points the same way. Every model extracted, classified and answered from sources correctly, yet none could reliably do a domain calculation from raw readings (F1 between 0.27 and 0.53). That calculation was moved into code.
- **Quotes come from stored offers.** Supplier-persona offers are clamped in code to a hidden profile, and `accept_offer` creates a quote only from the supplier's last stored offer.
- **Missing data stays missing.** A missing price is `null` plus an RFQ reason, never an estimate.
- **A two-part judge.** Part 1 recomputes the plan and the four numeric checks in code. Part 2 is a different model that checks the doers' claims against those facts. A failed numeric check triggers a re-plan with concrete feedback, and a grounding miss is reported and fed back.
- **The guardrail cases must all pass** (B3 below) before any model keeps a role.

## Models considered

| Model | Origin, license | Size | Prior evidence | Role here |
|---|---|---|---|---|
| Nemotron 3.5 Super VL | NVIDIA (US), NVIDIA open license | Vision-language; 262K context as configured | Deployed today; hero mission passed all numeric checks in production | **Planner and sub-agents (deployed)** |
| Nemotron 3 Super 120B-A12B | NVIDIA (US), NVIDIA open license | 120B / 12B active | Partial screen: extraction, classification and grounded answers correct | **Judge (deployed)** |
| Nemotron 3 Nano 30B-A3B | NVIDIA (US), NVIDIA open license | 30B / about 3.5B active; reasoning toggle | About 0.7 s p50 with thinking off, valid JSON | **Supplier personas (deployed)** |
| Nemotron 3.5 Lightning 30B-A3B | NVIDIA (US), NVIDIA open license | 30B / 3B active; 1M context | About 1.0 s p50, valid JSON; positioned by the provider as a sub-agent workhorse | Persona fallback |
| **Inkling-Small** | Thinking Machines Lab (US), Apache 2.0 | 276B / 12B active; text, image, audio; 1M context | Sibling Inkling: extraction F1 0.99, 100% grounded, 0% hallucination | **Planned upgrade: judge or planner** |
| Gemma 4 31B | Google (US), Gemma terms | 31B dense; text, image; 256K context | Full suite: extraction F1 1.00, grounded 100%, 0% hallucination | Compact benchmark comparator |
| Nemotron 3 Ultra | NVIDIA (US), OpenMDW | 550B / 55B active | Full suite: extraction F1 0.98, grounded 100% | Not needed for this workload |
| DeepSeek-V4-Pro / Flash | DeepSeek (CN), open weights | 1M context | Not tested | Not used; excluded for customers who need a non-Chinese base model |

## How we benchmark a candidate for this task

The benchmark harness is planned and is not yet in the repo. The same golden set runs against every candidate behind the same tools and seeded data. The planner is held fixed while worker models are compared, and the reverse. For the judge role, the doers are held fixed on Nemotron.

| # | Test | Metric | Gate |
|---|---|---|---|
| B1 | Tool selection: about 20 text prompts, each with an expected tool sequence | Exact tool match, valid arguments (Zod) | at least 90% |
| B2 | Grounded answers: answers must cite tool outputs | Share of claims supported by the transcript (judged by the verifier plus deterministic checks) | at least 95% |
| B3 | **Guardrails** (refuse to overclaim):<br>restricted adjuvant marked "approved"<br>development-stage API promoted to commercial<br>invented price<br>"I placed the PO" | Violations | **0** |
| B4 | Spec/ingredient matching: 30 labeled pairs (same material with a different grade, salt or hydrate, endotoxin class, compendia) | Accuracy, false-equivalence rate | at least 90% accuracy, false-equivalence 0 |
| B5 | Quote extraction: 20 free-text persona replies into the `Quote` schema | Field F1, schema validity | F1 at least 0.95 |
| B6 | Recursive mission: the hero scenario run end to end 10 times | Completion rate, re-plans per mission, sub-agent count | at least 9 of 10 complete |
| B7 | Fault recovery: persona timeout, 429, malformed tool JSON (`FAULTS=persona_timeout,crusoe_429,bad_tool_json`) | Missions that end `completed` or `degraded` (none hung) | 10 of 10 |
| B8 | Cost and latency | p50/p95 time to the text alert; tokens and $ per mission | p95 under 90 s |

The output is a results table and a chart on sheet 9 of the architecture PDF. Inkling-Small takes a role only if it passes every gate for that role. Otherwise the deployed Nemotron model keeps it, with no code change.

## Infrastructure

- **Today:** every role calls Crusoe serverless at `https://api.inference.crusoecloud.com/v1/chat/completions` (OpenAI-compatible Chat Completions API) with the Intelligence API key as a Bearer token. The persona sets `chat_template_kwargs: { enable_thinking: false }`.
- **For the upgrade, a self-serve deployment** of `thinkingmachines/Inkling-Small`:
  - Location: Intelligence Foundry, then Inference, then Self-Serve Deployments.
  - Configuration: "Throughput", because the planner fans out to several sub-agents at once. Start with 1 replica.
  - Billing is per GPU-hour, and provisioning can take up to 40 minutes. Delete the deployment after the event.
  - It uses the same endpoint and key as the serverless models. Set `MODEL_VERIFIER` (or `MODEL_PLANNER` and `MODEL_WORKER`) to the deployment alias.
- **No self-managed GPU.** Self-hosting is possible: the NVFP4 checkpoint serves with vLLM or SGLang, and at 4-bit it needs about 1x B300 or 2x H200. But it adds weight download, engine tuning and endpoint security work to a one-day build for no benefit.

## References
- Inkling-Small (NVFP4) on Hugging Face: https://huggingface.co/thinkingmachines/Inkling-Small-NVFP4
- Crusoe self-serve deployments: https://docs.crusoecloud.com/quickstart/self-serve-deployments
- Crusoe self-serve available models: https://docs.crusoecloud.com/self-serve-deployments/available-models
- Crusoe serverless available models: https://docs.crusoecloud.com/serverless-inference/available-models
- Gemma 4 31B: https://huggingface.co/google/gemma-4-31b-it
