import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
rows = [r for r in rows if r["verdict"] in ("strong", "good", "maybe", "no")]
good = lambda r: r["fit"] >= 2
passed = [r for r in rows if r["verdict"] in ("strong", "good")]
strict = [r for r in rows if r["verdict"] == "strong"]
allgood = [r for r in rows if good(r)]
prec = sum(good(r) for r in passed) / max(1, len(passed))
rec = sum(1 for r in allgood if r["verdict"] in ("strong", "good")) / max(1, len(allgood))
rec_m = sum(1 for r in allgood if r["verdict"] in ("strong", "good", "maybe")) / max(1, len(allgood))
print(f"reviewed {len(rows)} (unparsed {sum(1 for l in open(sys.argv[1]) if json.loads(l)['verdict'] not in ('strong','good','maybe','no'))})")
print(f"PASS (strong+good): precision {prec:.0%} ({len(passed)} passed) | good people kept {rec:.0%} | kept incl. maybe {rec_m:.0%}")
print(f"STRONG only: precision {sum(good(r) for r in strict)/max(1,len(strict)):.0%} ({len(strict)})")
print("confusion (my label → verdict):")
c = collections.Counter((r["fit"], r["verdict"]) for r in rows)
for f in [3, 2, 1, 0]: print(f"  label {f}: " + "  ".join(f"{v} {c[(f, v)]}" for v in ["strong", "good", "maybe", "no"]))
per = collections.defaultdict(lambda: [0, 0, 0, 0])
for r in rows:
    p = per[r["job"]]
    if r["verdict"] in ("strong", "good"): p[0] += 1; p[1] += good(r)
    if good(r): p[2] += 1; p[3] += r["verdict"] in ("strong", "good")
print("per job: precision / good kept")
for j in sorted(per): p = per[j]; print(f"  job {j:2d}: {p[1]}/{p[0]} = {p[1]/max(1,p[0]):.0%} | kept {p[3]}/{p[2]}")
print("avg sec", round(sum(r.get("sec") or 0 for r in rows) / max(1, len(rows)), 1))
