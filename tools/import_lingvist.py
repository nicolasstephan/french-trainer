"""Turn the Lingvist account export into word stages.

Reads  ../french-data/imports/lingvist/raw/events/*.json  (guess events)
Writes ../french-data/words.json

One entry per Lingvist card (sense_uuid): the form you type into the gap, its review
history, and a learning stage.

Lingvist's own state in the export (simple_algorithm_state, guess_params) is the one
*before* each answer, so the state after the last answer is computed here with a plain
SRS step: held = max(scheduled interval, actual gap since previous review);
first-try correct -> next = max(held * GROW, 1 day), miss -> next = MISS.
`answer` is the first thing typed; the real form is evaluation_criteria.correct_answer.

    python tools/import_lingvist.py [--data ../french-data]
"""
import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

GUESS = "urn:lingvist:schemas:events:guess:"
DAY = 86400
GROW = 2.5
MISS = 10 * 60  # a miss brings the card back in the next session
MAX = 180 * DAY

# stage by Lingvist's last predicted review interval (seconds)
STAGES = [  # (upper bound, name)
    (DAY, "learning"),       # comes back the same day
    (7 * DAY, "young"),
    (30 * DAY, "familiar"),
    (float("inf"), "known"),
]


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def stage_for(interval):
    if interval is None:
        return "new"
    for bound, name in STAGES:
        if interval < bound:
            return name


def load_guesses(events_dir):
    out = []
    for f in sorted(events_dir.glob("*.json")):
        for env in json.loads(f.read_text(encoding="utf-8")):
            ev = env["event"]
            if ev["schema"].startswith(GUESS):
                out.append((ts(ev["client_event_ts"]), ev["data"]))
    out.sort(key=lambda x: x[0])
    return out


def first_try(entry_events):
    """Correct on the first submit, without revealing."""
    for e in entry_events:
        if e["type"] == "reveal":
            return False
        if e["type"] == "submit":
            return e.get("treatment") == "correct"
    return False


def canonical(d):
    crit = ((d.get("evaluation_criteria") or {}).get("interpreted_criteria") or {})
    return crit.get("correct_answer") or next(
        (e for e in reversed(d.get("all_entries") or []) if e), None) or d.get("answer")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(Path(__file__).resolve().parents[1].parent / "french-data"))
    args = ap.parse_args()
    data = Path(args.data)
    guesses = load_guesses(data / "imports/lingvist/raw/events")

    cards = defaultdict(list)
    for t, d in guesses:
        cards[d.get("sense_uuid") or d.get("lexical_unit_uuid")].append((t, d))

    now = datetime.now(timezone.utc)
    words = []
    for sense, hist in cards.items():
        t_last, last = hist[-1]
        form = canonical(last)
        if not form:
            continue
        firsts = [first_try(d.get("entry_events", [])) for _, d in hist]
        scheduled = (last.get("simple_algorithm_state") or {}).get("predicted_interval") or 0
        gap = (t_last - hist[-2][0]).total_seconds() if len(hist) > 1 else 0
        held = max(scheduled, gap)
        interval = min(max(held * GROW, DAY), MAX) if firsts[-1] else MISS
        # recent streak of first-try corrects
        streak = 0
        for ok in reversed(firsts):
            if not ok:
                break
            streak += 1
        due = t_last.timestamp() + interval if interval else None
        words.append({
            "id": sense,
            "word": form,
            "lexical_unit": last.get("lexical_unit_uuid"),
            "stage": stage_for(interval) if len(hist) > 1 or firsts[-1] else "new",
            "interval_days": round(interval / DAY, 2) if interval else None,
            "reviews": len(hist),
            "first_try_rate": round(sum(firsts) / len(firsts), 2),
            "streak": streak,
            "difficulty": round((last.get("guess_params") or {}).get("difficulty") or 0, 2),
            "first_seen": hist[0][0].date().isoformat(),
            "last_seen": t_last.isoformat(timespec="seconds"),
            "due": datetime.fromtimestamp(due, timezone.utc).isoformat(timespec="seconds") if due else None,
            "overdue": bool(due and due < now.timestamp()),
            # every answer: [unix seconds, 1 = right on the first try]; the app replays this through its scheduler
            "history": [[int(t.timestamp()), int(ok)] for (t, _), ok in zip(hist, firsts)],
        })

    words.sort(key=lambda w: (w["word"].lower(), w["id"]))
    out = {
        "source": "lingvist export",
        "generated": now.isoformat(timespec="seconds"),
        "range": [guesses[0][0].date().isoformat(), guesses[-1][0].date().isoformat()],
        "stages": {s: sum(w["stage"] == s for w in words) for s in ["new", "learning", "young", "familiar", "known"]},
        "words": words,
    }
    (data / "words.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(words)} cards, {len({w['word'] for w in words})} forms, {out['range'][0]} to {out['range'][1]}")
    print("stages:", out["stages"])


if __name__ == "__main__":
    main()
