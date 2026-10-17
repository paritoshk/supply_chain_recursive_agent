"""
Plots for the benchmark harness. Reads docs/evals/results/*.json, writes docs/evals/png/*.png (2x).

    python3 -I evals/plot/plot.py

Design tokens: background #FDFDFC, ink #141311, grid #EAE8E5, muted #908E87, one accent #F25C05 for the
highlighted series, neutrals #3D3B39 / #B5B3B0 for the rest, status colors only for pass/fail.
Inter if installed, else DejaVu Sans. No chart junk: no top/right spines, light horizontal grid only.
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RES = ROOT / "docs" / "evals" / "results"
OUT = ROOT / "docs" / "evals" / "png"
OUT.mkdir(parents=True, exist_ok=True)

BG, INK, GRID, MUTED = "#FDFDFC", "#141311", "#EAE8E5", "#908E87"
ACC, N80, N30 = "#F25C05", "#3D3B39", "#B5B3B0"
OK, CRIT = "#16A34A", "#DC2626"
DPI = 200  # figures are sized in inches at 100 dpi-equivalent; 200 dpi = 2x

DOER = "nvidia/NVIDIA-Nemotron-3.5-Super-VL"
JUDGE = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"

families = {f.name for f in font_manager.fontManager.ttflist}
FONT = "Inter" if "Inter" in families else "DejaVu Sans"
plt.rcParams.update({
    "font.family": FONT,
    "font.size": 9,
    "text.color": INK,
    "axes.labelcolor": INK,
    "axes.edgecolor": MUTED,
    "axes.linewidth": 0.6,
    "axes.facecolor": BG,
    "figure.facecolor": BG,
    "savefig.facecolor": BG,
    "xtick.color": MUTED,
    "ytick.color": INK,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8.5,
    "axes.titlesize": 10.5,
    "axes.titleweight": "regular",
    "axes.titlelocation": "left",
    "axes.titlepad": 10,
    "legend.frameon": False,
    "legend.fontsize": 8,
})


def load(name):
    p = RES / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None


def clean(ax, grid_axis="x"):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color(MUTED)
    ax.spines["bottom"].set_color(MUTED)
    ax.tick_params(length=0)
    ax.grid(axis=grid_axis, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def footer(fig, text):
    fig.text(0.01, 0.01, text, fontsize=7, color=MUTED, ha="left", va="bottom")


def save(fig, name):
    path = OUT / f"{name}.png"
    fig.savefig(path, dpi=DPI)
    plt.close(fig)
    print(f"wrote {path.relative_to(ROOT)}")


def color_for(model):
    return ACC if model == DOER else N30


def short_label(p):
    return p.get("label") or p["model"].split("/")[-1]


# ---------------------------------------------------------------- B1
def plot_b1():
    d = load("b1-tool-selection")
    if not d:
        return
    pm = [p for p in d["per_model"] if p["tool_accuracy"]["n"] > 0]
    labels = [short_label(p) for p in pm]
    y = list(range(len(pm)))[::-1]
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(9.2, 3.3), gridspec_kw={"width_ratios": [1.1, 1]})
    for yi, p in zip(y, pm):
        acc = p["tool_accuracy"]
        c = color_for(p["model"])
        a1.barh(yi, acc["p"] * 100, height=0.56, color=c)
        a1.plot([acc["lo"] * 100, acc["hi"] * 100], [yi, yi], color=INK, linewidth=0.9)
        err = f" · {p['errors']} capacity errors" if p.get("errors") else ""
        a1.text(101.5, yi, f"{acc['k']}/{acc['n']} ({acc['p']*100:.0f}%){err}", va="center", fontsize=8, color=INK)
    a1.axvline(90, color=MUTED, linestyle=(0, (3, 3)), linewidth=0.8)
    a1.text(90, len(pm) - 0.45, "gate 90%", fontsize=7, color=MUTED, ha="center")
    a1.set_yticks(y, labels)
    a1.set_xlim(0, 140)
    a1.set_xticks([0, 25, 50, 75, 100])
    a1.set_title("Exact first-tool accuracy (95% Wilson CI)")
    clean(a1)
    for yi, p in zip(y, pm):
        lat = p["latency_ms"]
        c = color_for(p["model"])
        a2.barh(yi, lat["p50"] / 1000, height=0.56, color=c)
        a2.plot([lat["p95"] / 1000], [yi], marker="|", markersize=11, color=INK, markeredgewidth=1.4)
        a2.text(lat["p95"] / 1000 + 0.35, yi, f"p50 {lat['p50']/1000:.1f}s · p95 {lat['p95']/1000:.1f}s", va="center", fontsize=8)
    a2.set_yticks(y, [""] * len(y))
    xmax = max(p["latency_ms"]["p95"] for p in pm) / 1000
    a2.set_xlim(0, xmax * 1.75)
    a2.set_title("Latency per call, seconds (bar p50, tick p95)")
    clean(a2)
    fig.suptitle(f"B1 · Tool selection · {d['method']['prompts']} golden prompts, {len(d['method']['tools_exposed'])} tools", x=0.01, ha="left", fontsize=12, color=INK)
    footer(fig, "Accent = deployed doer (Nemotron 3.5 Super VL). Single step, temperature 0, same Zod-derived tool schemas as the agent. Synthetic data.")
    fig.tight_layout(rect=(0, 0.04, 1, 0.95))
    save(fig, "b1-tool-selection")


# ---------------------------------------------------------------- B3
def plot_b3():
    d = load("b3-guardrails")
    if not d:
        return
    pm = d["per_model"]
    y = list(range(len(pm)))[::-1]
    fig, ax = plt.subplots(figsize=(8.6, 2.9))
    for yi, p in zip(y, pm):
        v = p["violation_rate"]
        c = color_for(p["model"])
        ax.plot([v["lo"] * 100, v["hi"] * 100], [yi, yi], color=c if c == ACC else N80, linewidth=2.2, solid_capstyle="round")
        ax.plot([v["p"] * 100], [yi], marker="o", markersize=8, color=c if c == ACC else N80, markeredgecolor=BG, markeredgewidth=2)
        passed = p.get("gate_b3_zero")
        status = "PASS" if passed else ("FAIL" if passed is False else "n/a")
        sc = OK if passed else (CRIT if passed is False else MUTED)
        mark = "✓" if passed else ("✗" if passed is False else "·")
        ax.text(v["hi"] * 100 + 2, yi, f"{v['k']}/{v['n']} violations · CI up to {v['hi']*100:.0f}%", va="center", fontsize=8)
        ax.text(1.0, yi, f"{mark} {status}", va="center", ha="right", fontsize=8.5, color=sc, transform=ax.get_yaxis_transform())
    ax.set_yticks(y, [short_label(p) for p in pm])
    ax.set_xlim(-1.5, 60)
    ax.set_xlabel("violation rate, % of cases (dot = observed, line = 95% Wilson CI)", color=MUTED, fontsize=8)
    clean(ax)
    ax.set_title(f"B3 · Guardrails · {d['method']['cases']} adversarial requests with real tool outputs · gate = 0 violations")
    footer(fig, "Violation = deterministic regex OR independent judge OR rule-breaking tool call. Small n: 0/12 still allows a true rate up to ~24%.")
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    save(fig, "b3-guardrails")


# ---------------------------------------------------------------- B4
def plot_b4():
    d = load("b4-spec-matching")
    if not d:
        return
    methods = [("Deterministic prefilter", d["deterministic"])] + [(short_label(p), p) for p in d["per_model"] if p["n"] - p["errors"] > 0]
    metrics = [("precision", "Precision", N30), ("recall", "Recall", N80), ("f1", "F1", ACC)]
    fig, ax = plt.subplots(figsize=(9.2, 3.4))
    w = 0.24
    for i, (name, m) in enumerate(methods):
        for j, (key, lab, col) in enumerate(metrics):
            v = m.get(key)
            if v is None:
                continue
            x = i + (j - 1) * (w + 0.02)
            ax.bar(x, v, width=w, color=col, label=lab if i == 0 else None)
            if key == "f1":
                ax.text(x, v + 0.02, f"{v:.2f}", ha="center", fontsize=7.5)
        fe = m.get("false_equivalence_rate")
        acc = m.get("accuracy")
        gate = acc is not None and acc >= 0.9 and fe == 0
        ax.text(i, -0.2, f"{'✓' if gate else '✗'} acc {acc:.2f} · false-eq {fe:.2f}", ha="center", fontsize=7.2, color=OK if gate else CRIT)
    ax.set_xticks(range(len(methods)), [n for n, _ in methods], color=INK)
    ax.set_ylim(0, 1.12)
    ax.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
    clean(ax, "y")
    ax.legend(loc="lower right", ncols=3, bbox_to_anchor=(1, 1.0))
    ax.set_title(f"B4 · Spec matching · {d['method']['pairs']} labeled pairs ({d['method']['gold_equivalent']} equivalent / {d['method']['gold_not_equivalent']} not) · positive = equivalent", pad=22)
    footer(fig, "Gate: accuracy >= 0.90 and false-equivalence = 0 (red = a not-equivalent pair was called equivalent). Synthetic catalog + spec variants.")
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    save(fig, "b4-spec-prf")

    # confusion matrices
    cmap = LinearSegmentedColormap.from_list("acc", [BG, ACC])
    n = len(methods)
    fig, axes = plt.subplots(1, n, figsize=(2.05 * n, 2.6))
    if n == 1:
        axes = [axes]
    for ax, (name, m) in zip(axes, methods):
        c = m["confusion"]
        grid = [[c["tp"], c["fn"]], [c["fp"], c["tn"]]]
        vmax = max(max(r) for r in grid) or 1
        ax.imshow(grid, cmap=cmap, vmin=0, vmax=vmax)
        for r in range(2):
            for k in range(2):
                v = grid[r][k]
                bad = (r == 1 and k == 0 and v > 0)
                ax.text(k, r, str(v), ha="center", va="center", fontsize=12, color=CRIT if bad else (BG if v > vmax * 0.6 else INK))
        ax.set_xticks([0, 1], ["pred eq", "pred not"], fontsize=7, color=INK)
        ax.set_yticks([0, 1], ["gold eq", "gold not"], fontsize=7)
        ax.tick_params(length=0)
        for s in ax.spines.values():
            s.set_visible(False)
        ax.set_title(name, fontsize=8.5)
    fig.suptitle("B4 · Confusion matrices (red = false equivalence)", x=0.01, ha="left", fontsize=10.5)
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    save(fig, "b4-spec-confusion")


# ---------------------------------------------------------------- B5
def plot_b5():
    d = load("b5-discovery")
    if not d:
        return
    pm = d["per_material"]
    labels = [r["label"] for r in pm]
    y = list(range(len(pm)))[::-1]
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(9.6, 4.4), sharey=True)
    for ax, key, title in ((a1, "recall", "Recall vs named real suppliers"), (a2, "precision_judged", "Precision (judged manufacturer/distributor)")):
        for yi, r in zip(y, pm):
            v5, v8 = r["at5"][key], r["at8"][key]
            if v5 is None or v8 is None:
                continue
            ax.plot([v5, v8], [yi, yi], color=GRID, linewidth=2.5, zorder=1)
            ax.plot(v5, yi, "o", color=N30, markersize=7, markeredgecolor=BG, markeredgewidth=1.5, zorder=2, label="@5" if yi == y[0] else None)
            ax.plot(v8, yi, "o", color=ACC, markersize=7, markeredgecolor=BG, markeredgewidth=1.5, zorder=3, label="@8" if yi == y[0] else None)
        ax.set_xlim(-0.05, 1.05)
        ax.set_xticks([0, 0.25, 0.5, 0.75, 1])
        ax.set_title(title, fontsize=9.5)
        clean(ax)
    a1.set_yticks(y, labels)
    a1.legend(loc="lower right")
    s = d["summary"]
    fig.suptitle(
        f"B5 · Live supplier discovery (You.com) · recall@5 {s['recall_at_5_micro']:.2f} · recall@8 {s['recall_at_8_micro']:.2f} · precision@8 {s['precision_at_8_judged']:.2f}",
        x=0.01, ha="left", fontsize=11.5,
    )
    footer(fig, f"{s['materials']} materials, {s['truth_suppliers']} named suppliers from the research table. GMP/DMF/CEP evidence on {s['gmp_dmf_cep_share']*100:.0f}% of hits; directory listings {s['directory_share_judged']*100:.0f}% (judged). Live web, single run.")
    fig.tight_layout(rect=(0, 0.04, 1, 0.96))
    save(fig, "b5-discovery")


# ---------------------------------------------------------------- B5b
def plot_b5b():
    d = load("b5b-negotiation")
    if not d:
        return
    threads = d["threads"]
    cfg = [c for c in d["by_config"] if c["with_offer"] > 0]
    for c in cfg:
        ts = [t for t in threads if t["persona"] == c["persona"] and t["policy"] == c["policy"] and t.get("has_offer")]
        c["_target"] = (sum(1 for t in ts if t["within_target"]), len(ts))
    labels = [f"{c['persona'].replace('_', ' ')} · {c['policy'].replace('_', ' ')}" for c in cfg]
    y = list(range(len(cfg)))[::-1]
    hi = lambda c: c["persona"] == "live_nano" and c["policy"] == "llm_negotiator"  # noqa: E731
    fig, (a1, a2, a3) = plt.subplots(1, 3, figsize=(10.4, 0.36 * len(cfg) + 1.7), sharey=True, gridspec_kw={"width_ratios": [1, 1, 1.15]})
    for yi, c in zip(y, cfg):
        col = ACC if hi(c) else N30
        k, n = c["_target"]
        a1.barh(yi, 100 * k / n if n else 0, height=0.62, color=col)
        a1.text((100 * k / n if n else 0) + 2, yi, f"{k}/{n}", va="center", fontsize=7.5)
        sv = c["savings_vs_list_pct_mean"] or 0
        a2.barh(yi, sv, height=0.62, color=col)
        a2.text(max(sv, 0) + 0.3, yi, f"{sv:+.1f}%", va="center", fontsize=7.5)
        m = c["meets_need_by_rate"]
        a3.barh(yi, m["p"] * 100, height=0.62, color=col)
        v = c["policy_violations"]
        a3.text(m["p"] * 100 + 2, yi, f"{m['k']}/{m['n']}  " + ("✓ 0 violations" if v == 0 else f"✗ {v} violations"), va="center", fontsize=7.5, color=INK)
    a1.set_yticks(y, labels)
    a1.set_xlim(0, 115)
    a1.set_title("At or below price target, % threads", fontsize=9.5)
    lo = min(0, min((c["savings_vs_list_pct_mean"] or 0) for c in cfg)) - 1
    a2.set_xlim(lo, max((c["savings_vs_list_pct_mean"] or 0) for c in cfg) * 1.5 + 1.5)
    a2.axvline(0, color=MUTED, linewidth=0.6)
    a2.set_title("Landed vs list, mean % saved", fontsize=9.5)
    a3.set_xlim(0, 165)
    a3.set_xticks([0, 50, 100])
    a3.set_title("Arrives by need-by, % threads", fontsize=9.5)
    for a in (a1, a2, a3):
        clean(a)
    wins = sum(c["win_rate"]["k"] for c in cfg)
    tot = sum(c["win_rate"]["n"] for c in cfg)
    fig.suptitle(f"B5b · Negotiation vs simulated supplier personas · full wins (price AND on time AND 0 violations): {wins}/{tot} threads", x=0.01, ha="left", fontsize=11)
    footer(fig, "Accent = deployed path (LLM negotiator on Super VL vs live Nano persona). Target = midpoint of list and floor (landed). Need-by = projected stockout date. 3 demo materials x every approved supplier.")
    fig.tight_layout(rect=(0, 0.05, 1, 0.94))
    save(fig, "b5b-negotiation")


# ---------------------------------------------------------------- B6 timeline
def plot_timeline():
    d = load("b6-missions")
    if not d:
        return
    missions = [s for s in d.get("streams", []) if s.get("available")] + d.get("local_missions", [])
    if not missions:
        return
    rows = []
    for m in missions:
        prev = 0.0
        attempt_stages = [s for s in m["stages"] if s["stage"] != "planned" and s.get("t_s") is not None]
        for s in attempt_stages:
            rows.append((m["id"], s, prev))
            prev = s["t_s"]
    fig, ax = plt.subplots(figsize=(9.2, 0.5 * max(3, len(rows)) + 1.4))
    y = list(range(len(rows)))[::-1]
    for yi, (mid, s, start) in zip(y, rows):
        dur = s["t_s"] - start
        ok = s.get("pass") is not None and s.get("of") and s["pass"] == s["of"]
        ax.barh(yi, dur, left=start, height=0.5, color=N30)
        ax.plot([s["t_s"]], [yi], marker="D", markersize=7, color=OK if ok else CRIT, markeredgecolor=BG)
        lab = f"{dur:.0f}s"
        if s.get("of"):
            lab += f" · {'✓' if ok else '✗'} {s['pass']}/{s['of']} checks"
        ax.text(s["t_s"] + 6, yi, lab, va="center", fontsize=8)
    ax.set_yticks(y, [f"{mid} · attempt {s.get('attempt') or '?'}" for mid, s, _ in rows])
    ax.set_xlim(0, max(r[1]["t_s"] for r in rows) * 1.3)
    ax.set_xlabel("seconds since mission planned", color=MUTED, fontsize=8)
    clean(ax)
    m0 = missions[0]
    src = m0.get("source", "")
    summ = d["summary"]
    note = "\nEscalated to a human after 3 attempts, as intended: licensed adjuvant, quote-only, no analogue offered." if m0.get("material_id") == "MAT-SAP-QS" else ""
    ax.set_title(f"Mission timeline · {m0.get('material_id') or ''} @ {m0.get('site_id') or ''} · {src}{note}", fontsize=9.5)
    footer(fig, f"Deployed session streams: {summ['streams_available']}/{summ['streams_requested']} readable (others expired or empty). Bar = plan + sub-agents + verify per attempt; diamond = verifier verdict.")
    fig.tight_layout(rect=(0, 0.06, 1, 1))
    save(fig, "mission-timeline")


if __name__ == "__main__":
    which = sys.argv[1:] or ["b1", "b3", "b4", "b5", "b5b", "timeline"]
    fns = {"b1": plot_b1, "b3": plot_b3, "b4": plot_b4, "b5": plot_b5, "b5b": plot_b5b, "timeline": plot_timeline}
    for w in which:
        fns[w]()
