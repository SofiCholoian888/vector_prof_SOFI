"""Write AI-02 deliverables from paired experimental JSONL and catalog snapshots."""
import csv
import json
import math
import statistics
import sys
from collections import Counter
from pathlib import Path

from pairs import load_records, verify_pairs

runs, dest, data = map(Path, sys.argv[1:4])
dest.mkdir(parents=True, exist_ok=True)
current = json.loads((data / "export/navigator.json").read_text(encoding="utf-8"))
legacy = json.loads((data / "catalog.normalized.json").read_text(encoding="utf-8"))
new_names = {p["name"]:p["profession_id"] for p in current["professions"]}
renamed = {"prof_008":["prof_008"], "prof_009":["prof_009"], "prof_016":["prof_065"],
           "prof_028":["prof_150","prof_151"], "prof_029":["prof_152"]}
mapping = {p["profession_id"]: renamed.get(p["profession_id"], [new_names.get(p["name"])])
           for p in legacy["professions"]}
assert all(all(ids) for ids in mapping.values())


def write(name, rows):
    with (dest / f"{name}.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, lineterminator="\n", fieldnames=list(dict.fromkeys(key for row in rows for key in row)))
        writer.writeheader()
        writer.writerows(rows)


def final(row):
    return [h["id"] for h in row["hypotheses"]]


def retrieved(row):
    return row["retrieval"].get("professionIds", [])[:20]


def selected(row):
    for event in reversed(row.get("generationEvents", [])):
        if event["status"] == "validated":
            return event["data"].get("hypotheses", [])
    for event in reversed(row.get("httpEvents", [])):
        raw = event.get("raw")
        if isinstance(raw,str):
            try:
                return json.loads(raw.strip().removeprefix("```json").removesuffix("```").strip()).get("hypotheses", [])
            except (ValueError, AttributeError):
                continue
    return []


def avg(values):
    return round(statistics.mean(values), 4) if values else ""


def fraction(a,b):
    return round(a / b, 4) if b else ""


def overlap(a,b):
    return fraction(len(set(a) & set(b)),len(set(a) | set(b))) if a or b else 1


def top(row):
    return final(row)[:1]


def hit(row,k):
    return any(h["industry_id"] == row.get("expected") for h in row["hypotheses"][:k])


def rs(row, old):
    expected = set(row.get("relevant", []))
    return {p for p,targets in mapping.items() if expected & set(targets)} if old else expected


def relevance_metrics(rows, old):
    labelled = [(r,rs(r,old)) for r in rows if rs(r,old)]
    values = []
    for row, allowed in labelled:
        hits = [int(p in allowed) for p in final(row)[:5]]
        discounts = [1/math.log2(i+2) for i in range(5)]
        values.append((sum(hits)/5, sum(hits)/len(allowed),
                       len(set(retrieved(row)) & allowed)/len(allowed),
                       next((1/(i+1) for i,x in enumerate(hits) if x),0),
                       sum(x*y for x,y in zip(hits,discounts))/sum(discounts[:len(allowed)])))
    keys = ["precision_at_5","recall_at_5","recall_at_20","mrr_at_5","ndcg_at_5"]
    return {"profession_labels":len(labelled), **{k:avg([v[i] for v in values]) for i,k in enumerate(keys)}}


matrix = {(stage,mode):load_records(runs / f"{stage}-{mode}.jsonl")
          for stage in ("E1","E2","E3","E4") for mode in ("semantic","lexical")}
for (stage,mode), group in matrix.items():
    verify_pairs(matrix["E2",mode], group, stage in ("E2","E4"))
    assert len(group) == 76

ranking, ages, profs, industries, sensitivity, catalogs, ablations, explanations = ([] for _ in range(8))
groups = [(stage,mode,"retrieval_only",list(data.values())) for (stage,mode),data in matrix.items()]
for stage in ("E2","E4"):
    for mode in ("semantic","lexical"):
        rows = load_records(runs / f"{stage}-full-{mode}.jsonl")
        verify_pairs({k:matrix[stage,mode][k] for k in rows}, rows, True)
        groups.append((stage,mode,"full",list(rows.values())))
for file in sorted(runs.glob("live-*.jsonl")):
    if not file.stat().st_size:
        continue
    rows = list(load_records(file).values())
    groups.append(("E4",rows[0]["requestedMode"],file.stem,rows))

for stage, mode, pipeline, rows in groups:
    is_old = stage in ("E1","E3")
    catalog = legacy if is_old else current
    for actual in ("semantic","lexical"):
        for generation in ("llm","retrieval_only"):
            subset = [r for r in rows if not r.get("technicalFailure") and r["retrieval"].get("mode")==actual
                      and (r.get("generation") or {}).get("mode") == generation]
            key = dict(stage=stage,requested=mode,pipeline=pipeline,retrieval=actual,generation=generation)
            for tier in ("1-4","5-8","9-11","all"):
                batch = [r for r in subset if tier=="all" or r.get("tier")==tier]
                base = [r for r in batch if r["variant"]=="base"]
                mocks = [r for r in base if r["profile"].startswith("mock-")]
                distribution = mocks if pipeline=="retrieval_only" else base
                firsts = Counter(p for row in distribution for p in top(row))
                slots = Counter(p for row in distribution for p in final(row))
                labelled = [r for r in batch if r.get("expected")]
                offered = {x.get("industry_id",x.get("id")) for x in catalog["industries"]}
                metrics = dict(**key,tier=tier,cases=len(batch),distribution_profiles=len(distribution),
                               slots=sum(slots.values()), top1_leader=firsts.most_common(1)[0][0] if firsts else "",
                               leader_share=fraction(max(firsts.values(),default=0),sum(firsts.values())),
                               unique_professions=len(slots),catalog_coverage=fraction(len(slots),len(catalog["professions"])),
                               industry_coverage=fraction(len({h["industry_id"] for r in distribution for h in r["hypotheses"]}),len(offered)),
                               hhi=round(sum((n/sum(slots.values()))**2 for n in slots.values()),4),
                               low_signal_rate=fraction(sum(r["status"]=="low_signal" for r in batch),len(batch)),
                               no_match_rate=fraction(sum(r["status"]=="no_match" for r in batch),len(batch)),
                               p50_latency_ms=avg([statistics.median(r["latencyMs"] for r in batch)]) if batch else "",
                               p95_latency_ms=sorted(r["latencyMs"] for r in batch)[math.ceil(len(batch)*0.95)-1] if batch else "",
                               expected_industries=len(labelled), expected_available=sum(r["expected"] in offered for r in labelled),
                               industry_hit_at_1=fraction(sum(hit(r,1) for r in labelled),len(labelled)),
                               industry_hit_at_5=fraction(sum(hit(r,5) for r in labelled),len(labelled)),
                               **relevance_metrics(batch,is_old))
                ages.append(metrics)
                if tier=="all":
                    ranking.append(metrics | {"total_requested":len(rows),"technical_failures":sum(bool(r.get("technicalFailure")) for r in rows),
                                              "actual_semantic_rate":fraction(sum(r["retrieval"].get("mode")=="semantic" for r in rows),len(rows)),
                                              "lexical_fallback_rate":fraction(sum(r["retrieval"].get("mode")=="lexical" and r.get("technicalFailure",False) for r in rows),len(rows)),
                                              "llm_success_rate":fraction(sum((r.get("generation") or {}).get("mode")=="llm" for r in rows),len(rows)) if pipeline!="retrieval_only" else "",
                                              "validation_rejection_rate":fraction(sum(any(e.get("errors") for e in r.get("generationEvents",[])) for r in rows),len(rows)) if stage=="E4" and pipeline!="retrieval_only" else ""})
                if not is_old and pipeline in ("retrieval_only", "full"):
                    for p in catalog["professions"]:
                        pid = p["profession_id"]
                        positions = [i+1 for r in batch for i,h in enumerate(final(r)) if h==pid]
                        profile_count = sum(pid in final(r) for r in batch)
                        relevant = [r for r in batch if pid in r.get("relevant", [])]
                        # Controlled, explicitly different sector only. Unlabelled demos are excluded.
                        negative = [r for r in batch if r.get("expected") and r["expected"] != p["industry_id"]]
                        profs.append(dict(**key,tier=tier,id=pid,name=p["name"],industry=p["industry_id"],profiles=len(batch),
                                          retrieval_top1_count=sum(pid in retrieved(r)[:1] for r in batch),
                                          retrieval_top5_count=sum(pid in retrieved(r)[:5] for r in batch),
                                          retrieval_top20_count=sum(pid in retrieved(r) for r in batch),
                                          llm_selected_count=sum(pid in [h.get("profession_id") for h in selected(r)] for r in batch),
                                          final_top1_count=positions.count(1), final_topK_count=len(positions),
                                          profile_share=fraction(profile_count,len(batch)),slot_share=fraction(len(positions),sum(len(final(r)) for r in batch)),
                                          mean_position=avg(positions),median_position=statistics.median(positions) if positions else "",
                                          positive_hits=sum(pid in final(r) for r in relevant),positive_cases=len(relevant),
                                          other_sector_hits=sum(pid in final(r) for r in negative),other_sector_cases=len(negative)))
                for sector in catalog["industries"]:
                    sid = sector.get("industry_id",sector.get("id"))
                    hits = [h for r in distribution for h in r["hypotheses"] if h["industry_id"]==sid]
                    industries.append(dict(**key,tier=tier,industry=sid,name=sector["name"],
                                           primary=sum(h["rank"]==1 for h in hits),alternatives=sum(h["rank"]>1 for h in hits),
                                           slot_share=fraction(len(hits),sum(slots.values()))))
            for row in subset:
                refs = {a["ref"]:a for a in row.get("answers",[])}
                raw = {h.get("profession_id"):h.get("why") for h in selected(row)}
                for h in row["hypotheses"]:
                    valid = all(ref in refs for ref in h["evidence_refs"]) and bool(h["evidence_refs"])
                    matches = row["retrieval"].get("evidence",{}).get(h["id"],[])
                    explanations.append(dict(**key,profile=row["profile"],variant=row["variant"],profession=h["id"],rank=h["rank"],
                                             source=h.get("explanation_source"),valid_refs=valid,
                                             per_profession_retrieval_ref=any(e["answerRef"] in h["evidence_refs"] for e in matches),
                                             trials_present_and_age_valid=set(h.get("trial_ids") or [])<=set(h["allowed_trials"]),
                                             original_llm_why=raw.get(h["id"]),final_why=h["why"],
                                             exact_llm_preservation=raw.get(h["id"])==h["why"] if h["id"] in raw else ""))
    if pipeline=="retrieval_only":
        keyed=matrix[stage,mode]
        for (profile,variant),row in keyed.items():
            if variant=="base":
                continue
            before=keyed[profile,"base"]
            sensitivity.append(dict(stage=stage,retrieval=mode,profile=profile,variant=variant,
                                    changed=top(before)!=top(row),jaccard=overlap(final(before),final(row)),
                                    expected=row.get("expected"),expected_top1=hit(row,1) if row.get("expected") else "",
                                    same_answers=before["inputHash"]==row["inputHash"],technical_failure=bool(before.get("technicalFailure") or row.get("technicalFailure"))))
        for row in rows:
            key = row["profile"],row["variant"]
            baseline = matrix["E2",mode][key]
            mapped = {p for x in final(row) for p in mapping.get(x,[x])} if is_old else set(final(row))
            catalogs.append(dict(stage=stage,retrieval=mode,profile=key[0],variant=key[1],catalog=row["catalogVersion"],
                                 input_sha256=row["inputHash"],expected=row.get("expected"),industry_hit_at_1=hit(row,1) if row.get("expected") else "",
                                 final_ids=" ".join(final(row)),verified_mapping=" ".join(sorted(mapped)),
                                 jaccard_to_E2=overlap(mapped,final(baseline)),status=row["status"],technical_failure=row.get("technicalFailure")))

for factor in ("skills","mmr","soft","riasec","market","mean2","dedup"):
    file = runs / f"ablation-{factor}.jsonl"
    if not file.exists():
        continue
    altered=load_records(file)
    baseline={key:matrix["E4","semantic"][key] for key in altered}
    verify_pairs(baseline,altered,True)
    for key,row in altered.items():
        before=baseline[key]
        ablations.append(dict(factor=factor,profile=key[0],variant=key[1],changed_top1=top(row)!=top(before),
                              jaccard=overlap(final(row),final(before)),original=" ".join(final(before)),
                              experiment=" ".join(final(row)),technical_failure=bool(row.get("technicalFailure") or before.get("technicalFailure"))))

for name, rows in [("profession-frequency",profs),("industry-frequency",industries),("age-group-metrics",ages),
                   ("sensitivity-results",sensitivity),("ranking-metrics",ranking),("catalog-comparison",catalogs),
                   ("explanation-metrics",explanations),("ablation-results",ablations)]:
    write(name,rows)
(dest/"legacy-mapping.json").write_text(json.dumps(mapping,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
