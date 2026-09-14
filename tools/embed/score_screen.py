"""Compares a screen run with the recruiter's own decisions, per job and overall.
Reports Shortlist-only and Shortlist+Maybe separately, false rejects, and invalid or missing answers
(which are shown, never dropped or counted as a pass).
usage: python score_screen.py SCREENSET.json RUN.jsonl [reviewerId] [--v3]\n--v3 applies the full v3 answer schema (as the hosted runner does); older runs used a simpler answer."""
import json, sys
from collections import Counter, defaultdict

args = [a for a in sys.argv[1:] if not a.startswith("--")]
data = json.load(open(args[0])); reviewer = args[2] if len(args) > 2 else "u_lead"
truth = {(i["job"], i["id"]): i["decisions"].get(reviewer) for i in data["items"]}
titles = {(i["job"], i["id"]): f'{i["profile"]["currentTitle"]} · {i["profile"]["employer"]}' for i in data["items"]}
nos = {(i["job"], i["id"]): i["no"] for i in data["items"]}
rows = {}
for l in open(args[1]):
    r = json.loads(l)
    rows[(r["job"], r["id"])] = r

DECISIONS = {"shortlist", "maybe", "reject"}

def problems(v):
    """Same structural rules as src/lib/screenAnswer.ts answerProblems (v3 answers)."""
    if not isinstance(v, dict): return ["not an object"]
    p = []
    def gate(name, results, extra=()):
        g = v.get(name)
        if not isinstance(g, dict): p.append(f"{name} missing"); return
        if g.get("result") not in results: p.append(f"{name}.result not allowed")
        if not isinstance(g.get("quote"), str): p.append(f"{name}.quote missing")
        for f in extra:
            if not isinstance(g.get(f), str) or not g.get(f).strip(): p.append(f"{name}.{f} missing")
    gate("industry", {"pass", "fail", "unclear", "not_stated"})
    gate("level", {"pass", "fail", "unclear"}, ("current", "job"))
    gate("work", {"pass", "related", "fail", "unclear"}, ("type",))
    ec = v.get("essentials_contradicted")
    if not isinstance(ec, list) or not all(isinstance(e, dict) and isinstance(e.get("item"), str) and isinstance(e.get("quote"), str) for e in ec): p.append("essentials_contradicted malformed")
    em = v.get("essentials_missing")
    if not isinstance(em, list) or not all(isinstance(e, str) for e in em): p.append("essentials_missing malformed")
    if v.get("move") not in {"step_up", "lateral", "step_down", "unclear"}: p.append("move not allowed")
    if v.get("decision") not in DECISIONS: p.append("decision not allowed")
    if not isinstance(v.get("reason"), str) or not v.get("reason").strip(): p.append("reason missing")
    return p

V3 = "--v3" in sys.argv
def verdict(r):
    if r is None: return "missing"
    if r.get("status") and r["status"] != "ok": return r["status"]
    s = r.get("screen") if "screen" in r else r.get("parsed")
    if V3: return s["decision"] if not problems(s) else "invalid"
    d = (s or {}).get("decision") if isinstance(s, dict) else None
    return d if d in DECISIONS else "invalid"

by_job = defaultdict(list)
for key, t in truth.items():
    if t: by_job[key[0]].append((key, t, verdict(rows.get(key)), rows.get(key)))

def pct(a, b): return f"{a}/{b}" + (f" ({round(100*a/b)}%)" if b else "")
tot = Counter()
for job, rs in sorted(by_job.items()):
    c = Counter()
    for key, t, p, _ in rs:
        c["n"] += 1
        valid = p in DECISIONS
        c["invalid"] += not valid
        if not valid: continue
        c["valid"] += 1
        c["agree_yes_no"] += (p != "reject") == (t != "reject")
        c["m_short"] += p == "shortlist"; c["m_short_ok_short"] += p == "shortlist" and t == "shortlist"; c["m_short_ok_any"] += p == "shortlist" and t != "reject"
        c["m_yes"] += p != "reject"; c["m_yes_ok"] += p != "reject" and t != "reject"
        c["t_short"] += t == "shortlist"; c["t_short_kept"] += t == "shortlist" and p != "reject"
        c["t_yes"] += t != "reject"; c["t_yes_kept"] += t != "reject" and p != "reject"
        c["false_reject"] += t != "reject" and p == "reject"
    tot.update(c)
    print(f"\njob {job}: {c['n']} people, {c['invalid']} invalid/missing")
    print(f"  model Shortlist: {c['m_short']} — recruiter Shortlist {c['m_short_ok_short']}, Shortlist or Maybe {c['m_short_ok_any']}")
    print(f"  model Shortlist+Maybe: {pct(c['m_yes_ok'], c['m_yes'])} acceptable")
    print(f"  recruiter Shortlists kept: {pct(c['t_short_kept'], c['t_short'])} · Shortlist+Maybe kept: {pct(c['t_yes_kept'], c['t_yes'])} · false rejects {c['false_reject']}")
    print(f"  yes/no agreement: {pct(c['agree_yes_no'], c['valid'])}")
    for key, t, p, r in sorted(rs, key=lambda x: nos[x[0]]):
        if p not in DECISIONS or (p != "reject") != (t != "reject"):
            reason = ((r or {}).get("screen") or (r or {}).get("parsed") or {}) if isinstance(((r or {}).get("screen") or (r or {}).get("parsed")), dict) else {}
            print(f"   #{nos[key]} you {t:9} model {p:14} {titles[key][:60]} — {str(reason.get('reason', ''))[:110]}")
print(f"\nALL: {tot['n']} people, {tot['invalid']} invalid/missing · model Shortlist {tot['m_short']} ({tot['m_short_ok_any']} acceptable) · "
      f"Shortlist+Maybe {pct(tot['m_yes_ok'], tot['m_yes'])} acceptable · recruiter Shortlists kept {pct(tot['t_short_kept'], tot['t_short'])} · "
      f"Shortlist+Maybe kept {pct(tot['t_yes_kept'], tot['t_yes'])} · false rejects {tot['false_reject']}")
