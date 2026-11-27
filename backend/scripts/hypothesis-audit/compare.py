#!/usr/bin/env python3
"""Comparison table for the hypothesis audit runs (before/after, old/new catalog)."""
import collections
import json
import sys

TIER_KEYS = ("1-4", "5-8", "9-11")


def load(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def base_mocks(records):
    return [r for r in records
            if r["profile"].startswith("mock") and r["variant"] == "base" and r["tier"] != "1-4"]


def probes(records):
    return [r for r in records if r.get("expected") and r["variant"] == "base"]


def top1(record):
    return record["hypotheses"][0] if record["hypotheses"] else None


def jaccard(left, right):
    left, right = set(left), set(right)
    return len(left & right) / len(left | right) if left | right else 1.0


def share(counter, total):
    return round(max(counter.values()) / total, 2) if total and counter else 0.0


def metrics(path):
    records = load(path)
    mocks = base_mocks(records)
    variants = collections.defaultdict(dict)
    for record in records:
        variants[(record["profile"], record["variant"])] = record

    top1_names = collections.Counter(top1(r)["name"] for r in mocks if top1(r))
    top1_industries = collections.Counter(top1(r)["industry_name"] for r in mocks if top1(r))
    top5_industries = collections.Counter(h["industry_name"] for r in mocks for h in r["hypotheses"])
    per_tier = collections.Counter()
    for r in mocks:
        per_tier[(r["tier"], top1(r)["name"])] += 1

    unchanged = 0
    changed_total = 0
    overlaps = []
    for r in mocks:
        flipped = variants.get((r["profile"] + "-flip", "flip"))
        if not flipped:
            continue
        changed_total += 1
        if top1(r) and top1(flipped) and top1(r)["id"] == top1(flipped)["id"]:
            unchanged += 1
        overlaps.append(jaccard([h["id"] for h in r["hypotheses"]], [h["id"] for h in flipped["hypotheses"]]))

    probe_rows = probes(records)
    hits = {1: 0, 3: 0, 5: 0}
    for r in probe_rows:
        order = [h["industry_id"] for h in r["hypotheses"]]
        for k in hits:
            if r["expected"] in order[:k]:
                hits[k] += 1

    same_refs = 0
    all_refs = 0
    empty_reason = 0
    for r in mocks:
        refs = [tuple(h["evidence_refs"]) for h in r["hypotheses"]]
        if len(set(refs)) == 1:
            same_refs += 1
        total_answers = len(r["answers"])
        if any(len(h["evidence_refs"]) >= total_answers for h in r["hypotheses"]):
            all_refs += 1
        if any(not h.get("why") for h in r["hypotheses"]):
            empty_reason += 1

    return {
        "file": path.split("/")[-1],
        "mode": mocks[0]["retrieval"]["mode"] if mocks else "?",
        "professions": mocks[0]["catalogProfessions"] if mocks else 0,
        "mock_profiles": len(mocks),
        "top1_unique": len(top1_names),
        "top1_max_share": share(top1_names, len(mocks)),
        "top1_max_name": top1_names.most_common(1)[0][0] if top1_names else "-",
        "industry_top1_unique": len(top1_industries),
        "industry_top1_max_share": share(top1_industries, len(mocks)),
        "industry_top5_max_share": share(top5_industries, sum(top5_industries.values())),
        "industry_top5_max_name": top5_industries.most_common(1)[0][0] if top5_industries else "-",
        "tier_top1": {tier: [name for (t, name), count in per_tier.most_common() if t == tier][:3]
                      for tier in TIER_KEYS},
        "flip_top1_unchanged": f"{unchanged}/{changed_total}" if changed_total else "0/0",
        "flip_top5_jaccard": round(sum(overlaps) / len(overlaps), 2) if overlaps else 0.0,
        "probe_top1": f"{hits[1]}/{len(probe_rows)}",
        "probe_top3": f"{hits[3]}/{len(probe_rows)}",
        "probe_top5": f"{hits[5]}/{len(probe_rows)}",
        "same_evidence_profiles": f"{same_refs}/{len(mocks)}",
        "all_answers_cited_profiles": f"{all_refs}/{len(mocks)}",
        "empty_reason_profiles": f"{empty_reason}/{len(mocks)}",
    }


def influence(reference, other):
    """How much one variant moves the result of the same profiles."""
    by_profile = {r["profile"]: r for r in load(other)}
    changed_top1 = 0
    jaccards = []
    for record in load(reference):
        if record["variant"] != "base" or record["profile"] not in by_profile:
            continue
        other_record = by_profile[record["profile"]]
        left = [h["id"] for h in record["hypotheses"][:5]]
        right = [h["id"] for h in other_record["hypotheses"][:5]]
        if left[:1] != right[:1]:
            changed_top1 += 1
        if set(left) | set(right):
            jaccards.append(len(set(left) & set(right)) / len(set(left) | set(right)))
    total = len(jaccards)
    return f"top-1 changed {changed_top1}/{total}, top-5 Jaccard {sum(jaccards) / total:.2f}" if total else "-"


def main():
    rows = [metrics(path) for path in sys.argv[1:]]
    keys = list(rows[0].keys())
    print("| metric | " + " | ".join(row["file"] for row in rows) + " |")
    print("| --- | " + " | ".join("---" for _ in rows) + " |")
    for key in keys[1:]:
        values = []
        for row in rows:
            value = row[key]
            values.append(json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else str(value))
        print(f"| {key} | " + " | ".join(values) + " |")
    if len(rows) > 1:
        print("\n| variant vs " + rows[0]["file"] + " | influence |")
        print("| --- | --- |")
        for path in sys.argv[2:]:
            print(f"| {path.split('/')[-1]} | {influence(sys.argv[1], path)} |")


if __name__ == "__main__":
    main()
