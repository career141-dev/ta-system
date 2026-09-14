"""Recruiter-screen test (14 September): screens each person on the review lists the way Career141 recruiters do,
gates in order, and writes one JSON line per person. Runs on the laptop; nothing leaves it.
usage: python screen_local.py MODEL SCREENSET.json OUT.jsonl [--limit N] [--jobs 4,9] [--prompt screen_prompt_v3.txt] [--max-tokens 600]"""
import json, sys, time, re, os
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

model_id, set_path, out_path = sys.argv[1:4]
args = sys.argv[4:]
limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
only = set(map(int, args[args.index("--jobs") + 1].split(","))) if "--jobs" in args else None
prompt_file = args[args.index("--prompt") + 1] if "--prompt" in args else "screen_prompt.txt"
max_tokens = int(args[args.index("--max-tokens") + 1]) if "--max-tokens" in args else 500
data = json.load(open(set_path)); jobs = {j["n"]: j for j in data["jobs"]}
items = [i for i in data["items"] if not only or i["job"] in only]
if limit: items = items[:limit]
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        try: r = json.loads(l); done.add((r["job"], r["id"]))
        except Exception: pass

SYSTEM = open(os.path.join(os.path.dirname(__file__), prompt_file)).read()

def prompt_for(job, p):
    return f"""JOB DESCRIPTION
{job['jd']}

CANDIDATE
Current designation: {p['currentTitle']}
Current employer: {p['employer']}
Total years of experience: {p['years']}
Location: {p['location']}
Career (most recent first): {' | '.join(p['history'])}
Education: {p['education']}

CV TEXT
{p['cv']}"""

model, tok = load(model_id)
sampler = make_sampler(temp=0.0)
t0 = time.time(); n = 0
with open(out_path, "a") as out:
    for it in items:
        if (it["job"], it["id"]) in done: continue
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt_for(jobs[it["job"]], it["profile"])}]
        try:
            text = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False, enable_thinking=False)
        except TypeError:
            text = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)
        s = time.time()
        raw = generate(model, tok, prompt=text, max_tokens=max_tokens, sampler=sampler, verbose=False)
        m = re.search(r"\{.*\}", raw, re.S)
        try: v = json.loads(m.group(0)) if m else None
        except Exception: v = None
        out.write(json.dumps({"job": it["job"], "no": it["no"], "id": it["id"], "screen": v, "raw": None if v else raw[:600], "sec": round(time.time() - s, 1)}) + "\n"); out.flush()
        n += 1
        if n % 10 == 0: print(f"{n} screened · {round((time.time()-t0)/n,1)} s each", flush=True)
print(f"done {n} in {round(time.time()-t0)} s")
