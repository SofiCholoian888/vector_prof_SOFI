#!/usr/bin/env python3
"""Metrics for the hypothesis audit JSONL produced by audit.mjs."""
import collections
import json
import sys


from pairs import load_records


def load(paths):
    return [row for path in paths for row in load_records(path).values()]


def ids(record, limit=None):
    return [item["id"] for item in record["hypotheses"][:limit]]


def top1(record):
    return ids(record, 1)[0] if record["hypotheses"] else None


def industry_counts(records, limit=None):
    counter = collections.Counter()
    for record in records:
        for item in record["hypotheses"][:limit]:
            counter[(item["industry_id"], item["industry_name"])] += 1
    return counter


def tie_report(records):
    exact_ties = 0
    id_sorted = 0
    total = 0
    spread = []
    for record in records:
        order = record["retrieval"]["professionIds"][:20]
        scores = record["retrieval"].get("professionScores", {})
        if len(order) < 2:
            continue
        total += 1
        values = [scores.get(pid, 0) for pid in order]
        spread.append(max(values) - min(values))
        if len(set(round(value, 12) for value in values)) < len(values):
            exact_ties += 1
        if order == sorted(order):
            id_sorted += 1
    return {
        "records": total,
        "with_exact_score_ties": exact_ties,
        "top20_sorted_by_id": id_sorted,
        "max_score_spread": round(max(spread), 6) if spread else None,
    }


def summarize(records, title):
    print(f"\n### {title}")
    print("records:", len(records))
    print("technical failures:", sum(bool(r.get("technicalFailure")) for r in records))
    print("status:", dict(collections.Counter(r["status"] for r in records)))
    print("actual modes:", dict(collections.Counter(r["retrieval"].get("mode", "error") for r in records)))
    original_records = records
    records = [r for r in records if not r.get("technicalFailure")]
    mocks = [r for r in records if r["profile"].startswith("mock") and r["variant"] == "base"]
    probes = [r for r in records if r["profile"].startswith("probe")]
    print(f"profile rows={len(records)} mock={len(mocks)} probes={len(probes)}")
    print("tie report:", tie_report(records))

    senior = [r for r in mocks if 5 <= r["grade"] <= 11]
    print("\ntop-1 on mock profiles (grades 5-11):")
    for name, count in collections.Counter(
        f'{top1(r)} {r["hypotheses"][0]["name"]}' if r["hypotheses"] else f'[empty: {r["status"]}]' for r in senior
    ).most_common():
        print(f"  {count:2d}  {name}")
    print("\ntop-5 profession frequency on mock profiles:")
    counter = collections.Counter(
        item["name"] for r in senior for item in r["hypotheses"][:5]
    )
    for name, count in counter.most_common(12):
        print(f"  {count:2d}  {name}")
    print("\ntop-1 industry on mock profiles:")
    for (industry_id, name), count in industry_counts(senior, 1).most_common():
        print(f"  {count:2d}  {industry_id} {name}")
    print("\ntop-5 industry on mock profiles:")
    for (industry_id, name), count in industry_counts(senior, 5).most_common():
        print(f"  {count:2d}  {industry_id} {name}")

    print("\nby age tier (top-1):")
    for tier in ("5-8", "9-11"):
        subset = [r for r in senior if r.get("tier") == tier]
        counter = collections.Counter(f'{top1(r)} {r["hypotheses"][0]["name"]}' if r["hypotheses"] else f'[empty: {r["status"]}]' for r in subset)
        print(f"  {tier} (n={len(subset)}): {counter.most_common(4)}")

    if probes:
        print("\nprobe accuracy (explicit interest -> expected industry):")
        for limit in (1, 3, 5):
            hits = sum(
                1
                for r in probes
                if any(item["industry_id"] == r["expected"] for item in r["hypotheses"][:limit])
            )
            print(f"  in top-{limit}: {hits}/{len(probes)}")
        print("  per probe:")
        for r in probes:
            first = r["hypotheses"][0] if r["hypotheses"] else None
            print(
                f"    {r['expected']} -> {first['industry_id'] if first else '-'} "
                f"{first['name'] if first else 'NO HYPOTHESES'}"
            )

    flips = [r for r in records if r["variant"] == "flip"]
    if flips:
        base = {r["profile"]: r for r in original_records if r["variant"] == "base"}
        same_top1 = 0
        jaccards = []
        for flip in flips:
            original = base.get(flip["profile"].removesuffix("-flip"))
            if not original:
                raise ValueError(f"No base for {flip['profile']}")
            if original.get("technicalFailure"):
                continue
            same_top1 += top1(flip) == top1(original)
            left, right = set(ids(original, 5)), set(ids(flip, 5))
            jaccards.append(len(left & right) / len(left | right) if left | right else 1.0)
        print(
            f"\nsensitivity to one changed answer: top-1 unchanged "
            f"{same_top1}/{len(jaccards)}, mean top-5 Jaccard {sum(jaccards)/max(len(jaccards), 1):.2f}"
        )

    print("\nexplanation grounding:")
    identical = 0
    cited_all = 0
    for r in senior:
        sets = {tuple(item["evidence_refs"]) for item in r["hypotheses"]}
        if len(r["hypotheses"]) > 1 and len(sets) == 1:
            identical += 1
        total_refs = {answer["ref"] for answer in r.get("answers", [])}
        if r["hypotheses"] and set(r["hypotheses"][0]["evidence_refs"]) == total_refs:
            cited_all += 1
    print(f"  profiles where every hypothesis cites the same answers: {identical}/{len(senior)}")
    print(f"  profiles where hypothesis cites every dossier answer: {cited_all}/{len(senior)}")


if __name__ == "__main__":
    summarize(load(sys.argv[1:]), " ".join(sys.argv[1:]))
