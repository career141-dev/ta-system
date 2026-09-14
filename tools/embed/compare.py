"""Blind comparison. step 'prep': top-K per model per job -> blind judging sheet. step 'score': judged fits -> metrics."""
import json, sys, random, numpy as np
D = sys.argv[2]; K = 15
MODELS = ["paid", "Qwen3-Embedding-0.6B", "bge-m3"]
pool = [json.loads(l) for l in open(f"{D}/pool.jsonl")]
jobs = json.load(open(f"{D}/testjobs.json"))
def load(m):
    if m == "paid":
        p = json.load(open(f"{D}/paid_pool.json")); return np.array(p["cv"], np.float32), np.array(p["job"], np.float32)
    return np.load(f"{D}/cv_{m}.npy"), np.load(f"{D}/job_{m}.npy")
def norm(a): return a / np.linalg.norm(a, axis=1, keepdims=True)
tops = {}
for m in MODELS:
    cv, jb = load(m); cv, jb = norm(cv), norm(jb)
    sims = jb @ cv.T
    tops[m] = [list(np.argsort(-sims[j])[:30]) for j in range(len(jobs))]
if sys.argv[1] == "prep":
    random.seed(7); sheet = []
    for j, job in enumerate(jobs):
        ids = sorted({int(i) for m in MODELS for i in tops[m][j][:K]}); random.shuffle(ids)
        sheet.append({"job": j, "title": job["title"], "cands": [{"k": int(i), "profile": pool[i]["text"][:700]} for i in ids]})
    json.dump(sheet, open(f"{D}/sheet.json", "w"))
    for m in MODELS:
        for o in MODELS:
            if m < o:
                ov = np.mean([len(set(tops[m][j][:30]) & set(tops[o][j][:30])) / 30 for j in range(len(jobs))])
                print(f"top-30 overlap {m} vs {o}: {ov:.0%}")
    print("to judge:", sum(len(s["cands"]) for s in sheet))
else:
    fits = json.load(open(f"{D}/fits.json"))  # {"job:k": 0-3}
    for m in MODELS:
        per = []
        for j in range(len(jobs)):
            f = [fits[f"{j}:{int(i)}"] for i in tops[m][j][:K]]
            per.append((np.mean(f), sum(x >= 2 for x in f) / K, sum(x == 3 for x in f) / K))
        a = np.array(per)
        print(f"{m:24s} avg fit {a[:,0].mean():.2f}/3   good-or-strong {a[:,1].mean():.0%}   strong {a[:,2].mean():.0%}   per job good%: {' '.join(f'{x:.0%}' for x in a[:,1])}")
