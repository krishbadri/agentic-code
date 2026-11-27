"""
CooperBench Dataset Preparation Script

Loads the CooperBench dataset from HuggingFace, groups tasks by (repo, base_commit),
and writes selected task pairs as JSON for the TypeScript integration test to consume.
"""

import json
import sys
from collections import defaultdict
from datasets import load_dataset

def main():
    ds = load_dataset("CodeConflict/cooperbench-dataset")["train"]

    # Group by (repo, base_commit)
    groups = defaultdict(list)
    for row in ds:
        key = f"{row['repo']}@{row['base_commit']}"
        groups[key].append({
            "instance_id": row["instance_id"],
            "repo": row["repo"],
            "base_commit": row["base_commit"],
            "problem_statement": row["problem_statement"],
            "patch": row["patch"],
            "test_patch": row["test_patch"],
            "cooperbench_task_id": row["cooperbench_task_id"],
            "cooperbench_feature_id": row["cooperbench_feature_id"],
        })

    # Select the group matching --repo (default: the pair checked in as dataset.json)
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="stanfordnlp/dspy")
    ap.add_argument("--features", default="2,3", help="comma-separated cooperbench_feature_id values")
    opts = ap.parse_args()
    wanted = [f.strip() for f in opts.features.split(",") if f.strip()]

    target_key = None
    for key in groups:
        if key.startswith(opts.repo + "@") and len(groups[key]) >= 2:
            feats = {str(t["cooperbench_feature_id"]) for t in groups[key]}
            if all(w in feats for w in wanted):
                target_key = key
                break

    if not target_key:
        print(f"ERROR: Could not find a {opts.repo} group with features {wanted}", file=sys.stderr)
        sys.exit(1)

    tasks = groups[target_key]
    print(f"Selected group: {target_key} ({len(tasks)} tasks)", file=sys.stderr)

    by_feat = {str(t["cooperbench_feature_id"]): t for t in tasks}
    selected = [by_feat[w] for w in wanted[:2]]
    print(f"Task A: {selected[0]['instance_id']} (feature {selected[0]['cooperbench_feature_id']})", file=sys.stderr)
    print(f"Task B: {selected[1]['instance_id']} (feature {selected[1]['cooperbench_feature_id']})", file=sys.stderr)

    # Show file overlap
    def patch_files(patch):
        return [l.split(" b/")[1] if " b/" in l else l for l in patch.split("\n") if l.startswith("diff --git")]

    files_a = set(patch_files(selected[0]["patch"]))
    files_b = set(patch_files(selected[1]["patch"]))
    overlap = files_a & files_b
    print(f"Files A: {files_a}", file=sys.stderr)
    print(f"Files B: {files_b}", file=sys.stderr)
    print(f"Overlap: {overlap} ({'CONFLICT EXPECTED' if overlap else 'no conflict'})", file=sys.stderr)

    # Output JSON
    output = {
        "group_key": target_key,
        "repo": selected[0]["repo"],
        "base_commit": selected[0]["base_commit"],
        "tasks": selected,
    }
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
