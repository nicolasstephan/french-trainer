"""Generate cloze sentences for every word in ../french-data/words.json.

Uses headless Claude Code (`claude -p`, the subscription; no API key needed).
Writes ../french-data/sentences.json, keyed by card id, and is resumable: words that
already have sentences in the current format are skipped (older entries, e.g. English
translations, are redone first), so re-run it after new imports.
Translations are German, as direct as possible (cognates first), with the target's
translation marked [[like this]] in "de", plus other meanings of the word.

    python tools/make_sentences.py                 # all missing words
    python tools/make_sentences.py --limit 40      # try a small batch first
    python tools/make_sentences.py --redo cou,parmi

Difficulty follows the stage: new/learning words get short, simple sentences built from
vocabulary you already know well; familiar/known words get longer, more natural ones.
"""
import argparse
import json
import random
import re
import shutil
import subprocess
from pathlib import Path

PER_WORD = 3
BATCH = 25
LEVEL = {
    "new": "A2: short (6-10 words), present or passé composé, everyday context",
    "learning": "A2: short (6-10 words), everyday context",
    "young": "B1: 8-14 words, natural everyday or news context",
    "familiar": "B1-B2: 10-16 words, varied tenses and contexts",
    "known": "B2: 10-18 words, natural, idiomatic, varied contexts",
}

PROMPT = """You write French cloze sentences for a vocabulary trainer (like Lingvist). The learner is German.
For each target word below, write {n} different sentences. Rules:
- The sentence must contain the target EXACTLY as given (same spelling, accents, apostrophes, inflection), once.
- The context must make the target the clearly best answer, given the German hint.
- Level per word is given. Prefer these words I already know for the rest of the sentence: {known}.
- Natural, modern French; vary topics; no names of real people.
German translations: always the MOST DIRECT one. If German has (almost) the same word, use it
(caractéristique -> Charakteristik, spécifications -> Spezifikationen, essentiel -> essenziell, agricole -> agrikulturell
only if it is real German usage, otherwise landwirtschaftlich). Prefer cognates and word-for-word translations over
idiomatic ones, as long as the German stays correct. Build each sentence so that this direct translation fits.
Mirror the French grammar in the German so the form of the target is visible: same tense and mood
(futur simple -> werden + Infinitiv, e.g. j'aurai -> ich werde ... haben; futur proche -> werden or gehen + zu only
if natural, else werden; conditionnel -> würde / Konjunktiv II; passé composé -> Perfekt; imparfait -> Präteritum;
plus-que-parfait -> Plusquamperfekt; subjonctif -> Konjunktiv where German allows it), same person and number,
singular/plural and gender kept where German has them. Never replace a French future with a German present.
For each word give: lemma, part of speech (noun/verb/adj/adv/pron/prep/conj/det/other), gender for nouns (m/f),
"gloss": the direct German translation of the target as used, and "meanings": 2-5 other common German meanings
of the lemma (not repeating the gloss; empty list if none).
Per sentence: "de" = full German translation in which the German for the target is wrapped in [[ ]]. Usually one
[[...]]; if the German form is split (werde ... haben, hat ... gesehen, ruft ... an), mark each part:
"Morgen [[werde]] ich mehr Zeit für dich [[haben]]." "hint" = the German for the target as one phrase ("werde haben").

Reply with JSON only, no prose, shaped:
{{"<id>": {{"lemma": "...", "pos": "...", "gender": null, "gloss": "...", "meanings": ["..."],
  "sentences": [{{"fr": "...", "de": "... [[...]] ...", "hint": "..."}}]}}}}

Words (id | target | level):
{words}
"""


def data_dir():
    return Path(__file__).resolve().parents[1].parent / "french-data"


def ask_claude(prompt):
    exe = shutil.which("claude") or shutil.which("claude.cmd")
    r = subprocess.run([exe, "-p", "--output-format", "text"], input=prompt,
                       capture_output=True, text=True, encoding="utf-8", timeout=900)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:500])
    m = re.search(r"\{.*\}", r.stdout, re.S)
    return json.loads(m.group(0))


def check(word, entry):
    """Keep sentences that contain the target as a whole word."""
    pat = re.compile(r"(?<!\w)" + re.escape(word) + r"(?![\w])", re.I)
    entry["sentences"] = [s for s in entry.get("sentences", [])
                          if pat.search(s.get("fr", "")) and 1 <= s.get("de", "").count("[[") <= 3]
    entry["v"] = VERSION
    return entry


# format/rules version of an entry; older entries are redone first
# 1: German + marked translation, 2: German mirrors French tense/mood, split forms marked in parts
VERSION = 2


def is_current(entry):
    """Sentences made with the current rules."""
    return bool(entry and entry.get("sentences") and entry.get("v", 1 if "de" in entry["sentences"][0] else 0) >= VERSION)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(data_dir()))
    ap.add_argument("--limit", type=int, default=0, help="max words this run")
    ap.add_argument("--redo", default="", help="comma-separated words to regenerate")
    args = ap.parse_args()
    data = Path(args.data)
    words = json.loads((data / "words.json").read_text(encoding="utf-8"))["words"]
    out_path = data / "sentences.json"
    out = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    redo = {w.strip() for w in args.redo.split(",") if w.strip()}
    for w in words:
        if w["word"] in redo:
            out.pop(w["id"], None)

    known = [w["word"] for w in words if w["stage"] == "known" and w["first_try_rate"] >= 0.6]
    todo = [w for w in words if not is_current(out.get(w["id"]))]
    # words that had sentences in an older format (English) come first, so the app never goes back to fewer cards
    old = {i for i, e in out.items() if not is_current(e)}
    # hardest first: they need sentences soonest
    order = {"learning": 0, "new": 1, "young": 2, "familiar": 3, "known": 4}
    todo.sort(key=lambda w: (w["id"] not in old, order[w["stage"]], w["word"]))
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} words to do, {len(out)} done")

    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        lines = "\n".join(f"{w['id']} | {w['word']} | {LEVEL[w['stage']]}" for w in batch)
        prompt = PROMPT.format(n=PER_WORD, known=", ".join(random.sample(known, min(150, len(known)))), words=lines)
        try:
            res = ask_claude(prompt)
        except Exception as e:  # keep going; the next run retries these
            print(f"batch {i // BATCH + 1}: failed ({e})")
            continue
        got = 0
        for w in batch:
            if w["id"] in res:
                entry = check(w["word"], res[w["id"]])
                if entry["sentences"]:
                    entry["word"] = w["word"]
                    out[w["id"]] = entry
                    got += 1
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"batch {i // BATCH + 1}: {got}/{len(batch)} words, total {len(out)}")


if __name__ == "__main__":
    main()
