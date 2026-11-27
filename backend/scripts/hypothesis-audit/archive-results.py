"""Store synthetic audit inputs, timings and raw outputs with hashes."""
import gzip
import hashlib
import json
import subprocess
import sys
from pathlib import Path

runs, original, report = map(Path, sys.argv[1:4])
baseline_ref = "715fc40ac8a5b166c14141327c4615ae55ba6282"
sources = ["data/export/navigator.json", "data/catalog.index.json", "data/mock_students_data.json",
           "data/bilet_questions_master.json", "data/agent_clarification.json",
           "config/rag.config.json", "config/age_policy.json", "config/llm.config.json",
           "config/validation_patterns.json", "prompts/manifest.json"]


def digest(body):
    return hashlib.sha256(body).hexdigest()


def variant_metadata(directory):
    return {"sha256": {source:digest((directory/source).read_bytes()) for source in sources},
            "prompts":json.loads((directory/"prompts/manifest.json").read_text(encoding="utf-8")),
            "configuration":{name:json.loads((directory/f"config/{name}.json").read_text(encoding="utf-8"))
                             for name in ("rag.config","age_policy","llm.config")}}


records = {}
files = sorted(runs.glob("*.jsonl")) + sorted((original.parent/".audit").glob("baseline-*.jsonl"))
for path in files:
    items = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    if not items:
        continue
    records[path.stem] = items

faults = [json.loads(p.read_text(encoding="utf-8").splitlines()[-1]) for p in sorted(runs.glob("fault-*.log"))]
records["fault-injection"] = faults
archive = {name:rows for name,rows in records.items()}
content = (json.dumps(archive, ensure_ascii=False, separators=(",", ":"))+"\n").encode()
(report/"experiment-records.json.gz").write_bytes(gzip.compress(content,mtime=0))
manifest = {
    "baseline_commit":baseline_ref, "embedding_model":"EmbeddingsGigaR", "embedding_query_mode":"plain",
    "chat_model":"GigaChat-2-Pro",
    "baseline":variant_metadata(original),
    "current":variant_metadata(Path.cwd()),
    "legacy":{"source_commit":"adf61e93da399a830461d0ef0956f4f01614b152",
              "version":"sha256:0eb9dbee78b76f60f593d82332a3220f99966a0c0b7799348a4454bc8a1287a3",
              "sha256_records":"9bd9fc4a293aa6c95dc2582e0ee376baeb391d524f188fe418a2d1bbcc972f36",
              "sha256_index":"3a82500915c2692882f173df27befad041ce75a72236ab95af62187731eee7d5"},
    "no_skills_index_sha256": digest((runs.parent/"no-skills-02/data/catalog.index.json").read_bytes()),
    "node":subprocess.check_output(["node","--version"],text=True).strip(),
    "records_per_run":{name:len(rows) for name,rows in records.items()},
    "records_sha256_uncompressed":digest(content),
    "limits":{"samples":"15 existing demo profiles, 16 existing probes, synthetic controls and perturbations",
              "embedding_cache":"Shared real provider results for identical query batches. Replay latency is local.",
              "full_run":"Six paired synthetic profiles per retrieval mode and stage plus separately marked retries.",
              "assessor":"Predeclared synthetic professions and industries and manual audit of examples, no independent expert labels."},
}
assert manifest["baseline"]["sha256"]["data/export/navigator.json"] == manifest["current"]["sha256"]["data/export/navigator.json"]
assert manifest["baseline"]["sha256"]["data/catalog.index.json"] == manifest["current"]["sha256"]["data/catalog.index.json"]
(report/"experiment-manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
