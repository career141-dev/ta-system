"""Local AI reviewer test: reads each labelled person's CV against the job, returns a verdict. Nothing leaves the laptop.
usage: python review_local.py MODEL REVIEWSET.json OUT.jsonl [--limit N] [--jobs 1,2]"""
import json, sys, time, re, os, random
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

model_id, set_path, out_path = sys.argv[1:4]
args = sys.argv[4:]
limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
only = set(map(int, args[args.index("--jobs") + 1].split(","))) if "--jobs" in args else None
data = json.load(open(set_path)); jobs = {j["n"]: j for j in data["jobs"]}
items = [i for i in data["items"] if not only or i["job"] in only]
random.Random(7).shuffle(items)
if limit: items = items[:limit]
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        try: done.add((json.loads(l)["job"], json.loads(l)["id"]))
        except Exception: pass

SYSTEM = """You are a senior recruiter at an executive search firm in Sri Lanka, screening a candidate for a specific job. Judge like a careful recruiter, not a keyword matcher. Be strict: a TA will contact everyone you pass.

Decide:
1. SAME WORK: does this person actually do the work this job needs, in their recent roles (last 5 years)? Similar-sounding titles in a different function do not count (e.g. software "engineering" is not plant engineering; commercial finance is not pricing unless they set prices).
2. LEVEL: compared with the job's level — well below, a step below, right level, a step above, well above.
3. MUST-HAVES: which of the job's must-haves are clearly missing from the CV.
4. VERDICT:
   strong = does this work at the right level, meets the must-haves — contact first
   good   = does this work, level within one step, at most minor gaps — worth contacting
   maybe  = related work or a real gap (level two steps off, key must-have unclear) — only if few others
   no     = different work, far off level, or clearly missing core must-haves

Reply with ONLY one line of JSON: {"verdict":"strong|good|maybe|no","same_work":true|false,"level":"well_below|below|match|above|well_above","missing":["..."],"reason":"one short sentence"}"""

def prompt_for(job, p):
    return f"""JOB
Title: {job['title']}
Location: {job['location']}
Level: {job['level']}  | Minimum experience: {job['minYears']} years | Industry: {job['industry']}
Must-haves: {'; '.join(job['mustHaves'])}
Nice to have: {'; '.join(job['niceToHave'])}
Description (excerpt): {job['jd'][:1800]}

CANDIDATE
Current: {p['currentTitle']} at {p['employer']} | Total years: {p['years']} | Location: {p['location']}
Career: {' | '.join(p['history'])}
Skills: {', '.join(p['skills'])}
Education: {p['education']}
CV text (excerpt): {p['cv'][:2200]}"""

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
        raw = generate(model, tok, prompt=text, max_tokens=220, sampler=sampler, verbose=False)
        m = re.search(r"\{.*\}", raw, re.S)
        try: v = json.loads(m.group(0)) if m else {}
        except Exception: v = {}
        out.write(json.dumps({"job": it["job"], "id": it["id"], "fit": it["fit"], "verdict": v.get("verdict"), "same_work": v.get("same_work"), "level": v.get("level"), "reason": v.get("reason"), "raw": None if v else raw[:300], "sec": round(time.time() - s, 1)}) + "\n"); out.flush()
        n += 1
        if n % 25 == 0: print(f"{n} reviewed · {round((time.time()-t0)/n,1)} s each", flush=True)
print(f"done {n} in {round(time.time()-t0)} s")
