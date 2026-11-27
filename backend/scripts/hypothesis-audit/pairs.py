"""Validate identities and comparability before reporting paired experiments."""
import json
from pathlib import Path


def load_records(path):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    keyed = {}
    for row in rows:
        variant = row["variant"]
        profile = row["profile"].removesuffix("-flip") if variant == "flip" else row["profile"]
        key = profile, variant
        if key in keyed:
            raise ValueError(f"{path}: duplicate pair key {key}")
        keyed[key] = row
    versions = {row.get("catalogVersion") for row in rows}
    if not rows or len(versions) != 1 or None in versions:
        raise ValueError(f"{path}: missing rows or mixed catalog versions {versions}")
    return keyed


def verify_pairs(left, right, same_catalog=False):
    if left.keys() != right.keys():
        raise ValueError(f"Missing pairs: left only {sorted(left.keys()-right.keys())}, right only {sorted(right.keys()-left.keys())}")
    for key, first in left.items():
        second = right[key]
        hashes = first.get("inputHash"), second.get("inputHash")
        if all(hashes):
            same_answers = hashes[0] == hashes[1]
        else:
            same_answers = [(a["questionId"], a["selected"]) for a in first.get("answers", [])] == [
                (a["questionId"], a["selected"]) for a in second.get("answers", [])]
        if not same_answers or first["grade"] != second["grade"] or first.get("municipality") != second.get("municipality"):
            raise ValueError(f"Different inputs for {key}")
        if same_catalog and first["catalogVersion"] != second["catalogVersion"]:
            raise ValueError(f"Different catalog versions for {key}")
