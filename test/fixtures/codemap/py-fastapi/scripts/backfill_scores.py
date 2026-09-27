"""Re-score every lead in a CSV export. Usage: python scripts/backfill_scores.py leads.csv"""
from __future__ import annotations

import csv
import sys

from app.swfte_clients.lead_scoring import invoke_lead_scoring
from app.swfte_sdk import get_client


def main(path: str) -> int:
    client = get_client()
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            done = client.workflows.invoke_and_wait(
                "wf_Lead5Sc",
                {"company": row["company"], "domain": row["domain"]},
                timeout=120,
            )
            print(row["domain"], done.outputs["tier"])
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--one":
        res = invoke_lead_scoring({"company": sys.argv[2], "domain": sys.argv[3]})
        print(res["output"]["score"])
        sys.exit(0)
    sys.exit(main(sys.argv[1]))
