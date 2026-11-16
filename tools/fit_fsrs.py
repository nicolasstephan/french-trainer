"""Fit the FSRS-6 memory model to your own answers and write the weights into js/srs.js.

The default weights are averages from many Anki users. Fitted on your history (Lingvist + this app), the model
predicts *your* recall, so "come back when recall drops to RETENTION" means what it says.

    pip install fsrs-rs-python==0.9.3          # once: the official optimizer (Rust, as in Anki)
    python tools/fit_fsrs.py                   # fit, compare with the defaults, show the result
    python tools/fit_fsrs.py --write           # ... and write the weights into js/srs.js (then commit + push)

Ratings: right on the first try = 3 (Good), a miss = 1 (Again); the app has no Hard/Easy. Days count from 4:00
local time, as in Anki. Refit every few months; more answers make the fit better.
"""
import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import fsrs_rs_python as fsrs

ROOT = Path(__file__).resolve().parents[1]
SRS = ROOT / "js" / "srs.js"


def day(t):
    return (datetime.fromtimestamp(t) - timedelta(hours=4)).date()


def logs(data):
    words = json.loads((data / "words.json").read_text(encoding="utf-8"))["words"]
    pp = data / "progress.json"
    app = json.loads(pp.read_text(encoding="utf-8")).get("log", {}) if pp.exists() else {}
    out = {}
    for w in words:
        seen = {}
        for e in (w.get("history") or []) + (app.get(w["id"]) or []):
            seen[e[0]] = e[1]
        if seen:
            out[w["id"]] = sorted(seen.items())
    return out


def items(all_logs):
    """One item per review on a later day, holding the card's history up to it (what the optimizer expects)."""
    res, ids = [], []
    for n, (cid, log) in enumerate(all_logs.items()):
        reviews, prev = [], None
        for t, ok in log:
            d = day(t)
            dt = 0 if prev is None else (d - prev).days
            reviews.append(fsrs.FSRSReview(3 if ok else 1, dt))
            prev = d
            if len(reviews) > 1 and dt > 0:
                res.append(fsrs.FSRSItem(list(reviews)))
                ids.append(n)
    return res, ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT.parent / "french-data"))
    ap.add_argument("--write", action="store_true", help="write the fitted weights into js/srs.js")
    args = ap.parse_args()
    all_logs = logs(Path(args.data))
    train, ids = items(all_logs)
    print(f"{len(all_logs)} cards, {sum(map(len, all_logs.values()))} answers, {len(train)} reviews on a later day")

    w = fsrs.FSRS(fsrs.DEFAULT_PARAMETERS).compute_parameters(train, card_ids=ids)
    w = [round(x, 4) for x in w]
    for name, p in (("defaults", fsrs.DEFAULT_PARAMETERS), ("fitted  ", w)):
        ev = fsrs.FSRS(p).evaluate(train)
        print(f"{name}: log loss {ev.log_loss:.4f}, RMSE (bins) {ev.rmse_bins:.4f}   (lower is better)")
    print("weights:", w)

    # what the fitted model does with a typical word: intervals after 1..5 right answers in a row (90 % / 93 %)
    m = fsrs.FSRS(w)
    for r in (0.90, 0.93):
        state, iv, path = None, 0, []
        for _ in range(5):
            nxt = m.next_states(state, r, iv).good
            state, iv = nxt.memory, max(1, round(nxt.interval))
            path.append(iv)
        print(f"retention {r:.0%}: days until the next review after 1..5 right answers: {path}")

    if args.write:
        src = SRS.read_text(encoding="utf-8")
        line = f"export const W = {json.dumps(w)};   // fitted {datetime.now():%Y-%m-%d} (tools/fit_fsrs.py), {len(train)} reviews"
        src, n = re.subn(r"^export const W = \[.*$", line.replace("\\", "\\\\"), src, count=1, flags=re.M)
        if not n:
            raise SystemExit("js/srs.js: no 'export const W = [...]' line found")
        SRS.write_text(src, encoding="utf-8")
        print("written to js/srs.js")


if __name__ == "__main__":
    main()
