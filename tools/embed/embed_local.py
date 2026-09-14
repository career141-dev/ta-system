"""Embed CVs and jobs with a local open model on Apple silicon (MPS). Prints timing.
usage: python embed_local.py MODEL POOL.jsonl JOBS.json OUTDIR"""
import json, sys, time, numpy as np, torch
from sentence_transformers import SentenceTransformer

model_id, pool_path, jobs_path, out = sys.argv[1:5]
tag = sys.argv[5] if len(sys.argv) > 5 else ""
pool = [json.loads(l) for l in open(pool_path)]
jobs = json.load(open(jobs_path))
job_texts = ["\n".join(x for x in [j["title"], j.get("industry") or "", (j.get("jd") or "")[:6000]] if x) for j in jobs]

dev = "mps" if torch.backends.mps.is_available() else "cpu"
m = SentenceTransformer(model_id, device=dev, model_kwargs={"torch_dtype": torch.float16})
m.max_seq_length = 2048
is_qwen = "qwen" in model_id.lower()
t = time.time()
# Longest first keeps batches of similar length, which is much faster.
order = sorted(range(len(pool)), key=lambda i: -len(pool[i]["text"]))
vecs = m.encode([pool[i]["text"] for i in order], batch_size=8, normalize_embeddings=True, show_progress_bar=False, convert_to_numpy=True)
cv = np.zeros_like(vecs); cv[order] = vecs
secs = time.time() - t
q = m.encode(job_texts, batch_size=4, normalize_embeddings=True, convert_to_numpy=True,
             prompt=("Instruct: Given a job description, retrieve CVs of candidates who fit the role\nQuery: " if is_qwen else None))
name = model_id.split("/")[-1]
np.save(f"{out}/cv{tag}_{name}.npy", cv.astype(np.float32)); np.save(f"{out}/job_{name}.npy", q.astype(np.float32))
chars = sum(len(p["text"]) for p in pool)
print(json.dumps({"model": name, "dims": int(cv.shape[1]), "cvs": len(pool), "seconds": round(secs, 1), "cvs_per_sec": round(len(pool) / secs, 1), "avg_chars": chars // len(pool)}))
