"""
Split a Convex export into imports staging can take without running out of memory.

Two tables carry heavy search indexes: `candidates` (four text indexes) and
`candidateResumes` (a text index on the CV and a 1,024-dimension vector index).
Imported whole, Convex builds those indexes in memory at once. So:

  00-base.zip    every other table, plus the first rows of each heavy table
                 (imported with --replace-all, which gives every table its own
                 number from the export; appending into a table that does not
                 exist yet fails because its number clashes)
  cand-NN.zip    the rest of `candidates`, in chunks        (--append)
  cr-NN.zip      the rest of `candidateResumes`, in chunks  (--append)

Document ids and creation times are kept, so every reference still resolves.

    python3 split-export.py /path/to/export.zip /path/to/outdir
"""
import os
import sys
import zipfile

HEAVY = {"candidates": 10000, "candidateResumes": 5000}
SEED = 500

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.endswith(".zip") and (f.startswith("00-base") or f.startswith("cand-") or f.startswith("cr-")):
        os.remove(os.path.join(out, f))


def copy(z, name, dst):
    with z.open(name) as a, dst.open(name, "w") as b:
        while True:
            chunk = a.read(1 << 20)
            if not chunk:
                break
            b.write(chunk)


with zipfile.ZipFile(src) as z:
    names = z.namelist()
    docs = [n for n in names if n.endswith("/documents.jsonl")]
    schemas = {n.split("/")[0]: n for n in names if n.endswith("/generated_schema.jsonl")}
    plan = []
    with zipfile.ZipFile(os.path.join(out, "00-base.zip"), "w", zipfile.ZIP_DEFLATED) as base:
        for n in docs:
            table = n.split("/")[0]
            if table in schemas:
                copy(z, schemas[table], base)
            if table not in HEAVY:
                copy(z, n, base)
                continue
            prefix = "cand" if table == "candidates" else "cr"
            size = HEAVY[table]
            seed, buf, part, total = [], [], 1, 0
            with z.open(n) as f:
                for line in f:
                    if not line.strip():
                        continue
                    if not line.endswith(b"\n"):
                        line += b"\n"
                    total += 1
                    if len(seed) < SEED:
                        seed.append(line)
                        continue
                    buf.append(line)
                    if len(buf) >= size:
                        fn = f"{prefix}-{part:02d}.zip"
                        with zipfile.ZipFile(os.path.join(out, fn), "w", zipfile.ZIP_DEFLATED) as c:
                            c.writestr(n, b"".join(buf))
                        plan.append((fn, len(buf)))
                        buf, part = [], part + 1
            if buf:
                fn = f"{prefix}-{part:02d}.zip"
                with zipfile.ZipFile(os.path.join(out, fn), "w", zipfile.ZIP_DEFLATED) as c:
                    c.writestr(n, b"".join(buf))
                plan.append((fn, len(buf)))
            base.writestr(n, b"".join(seed))
            print(f"{table}: {total} rows, {len(seed)} in base")

print("base tables:", len(docs))
for fn, n in plan:
    print(fn, n)
