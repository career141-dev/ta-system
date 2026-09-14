import json, sys, numpy as np
D = sys.argv[1]
labels = json.load(open(f"{D}/apps_labels.json")); jobs = json.load(open(f"{D}/testjobs.json"))
POS = {"ta_shortlist", "second_shortlist", "director_shortlist", "client_review", "interview", "offer", "placed", "follow_up", "ai_call"}
def norm(a): return a / np.linalg.norm(a, axis=1, keepdims=True)
def vecs(m):
    if m == "paid":
        p = json.load(open(f"{D}/paid_apps_pool.json")); return np.array(p["cv"], np.float32), np.array(p["job"], np.float32)
    return np.load(f"{D}/cv_apps_{m}.npy"), np.load(f"{D}/job_{m}.npy")
def auc(pos, neg):
    pos, neg = np.array(pos), np.array(neg)
    return float(((pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()) / (len(pos) * len(neg)))
res = {}
for m in ["paid", "Qwen3-Embedding-0.6B", "bge-m3"]:
    cv, jb = vecs(m); cv, jb = norm(cv), norm(jb)
    rows = []
    for j, job in enumerate(jobs):
        idx = [i for i, l in enumerate(labels) if l["job"] == j]
        s = cv[idx] @ jb[j]
        pos = [s[k] for k, i in enumerate(idx) if labels[i]["stage"] in POS]
        neg = [s[k] for k, i in enumerate(idx) if labels[i]["stage"] == "new_cvs"]
        if len(pos) >= 3 and len(neg) >= 10: rows.append((job["title"][:34], len(pos), len(neg), auc(pos, neg)))
    res[m] = rows
titles = [r[0] for r in res["paid"]]
print(f"{'job':36s} pos  neg   paid   qwen   bge")
for k, t in enumerate(titles):
    print(f"{t:36s} {res['paid'][k][1]:3d} {res['paid'][k][2]:4d}  " + "  ".join(f"{res[m][k][3]:.2f}" for m in res))
w = lambda m: sum(r[3] * r[1] for r in res[m]) / sum(r[1] for r in res[m])
print("mean  " + "  ".join(f"{m}: {np.mean([r[3] for r in res[m]]):.3f} (weighted {w(m):.3f})" for m in res))
