"""Fill the queue of new words (../french-data/extra_words.json) and give them cloze sentences.

    python tools/add_words.py              # 40 new words, then sentences for them
    python tools/add_words.py --n 60 --dry # show what would be added
    python tools/add_words.py --no-sentences
    python tools/add_words.py --tapped-only --push # only the words added in the reader; commit + push (scheduled task)

The app decides WHEN a queued word is introduced (js/app.js: newWordCapacity, by how well you are doing);
this tool decides WHICH words wait in the queue, in this order:
  1. words you added in the reader (button, or looked up twice: progress.json reading.added / reading.looked),
  2. words from the coming pages of the book you read last: the next AHEAD_PAGES pages after your position,
     ranked by how often they occur from there to the end (rare words: tap them, no card),
  3. only when 1 and 2 run out: frequent everyday words (Lexique 3 lemma frequencies, films + books).
The app keeps that priority too: book and tapped words go before frequency words queued earlier.
Everything is by dictionary form (lemma): a word is skipped if you already have any form of it as a card.
Lemmas come from the book glossary (in context) or Lexique 3 (imports/lexique/Lexique383.tsv, local only;
http://www.lexique.org, CC BY-SA 4.0).
"""
import argparse
import csv
import json
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_book as ib   # noqa: E402  same tokenizer, CORE words and data paths

AHEAD_PAGES = 15
MIN_LEFT = 3          # a book word needs at least this many occurrences from your position on
TAPPED_MIN = 2
CONTENT = {"NOM", "VER", "ADJ", "ADV"}
VULGAR = {"foutre", "putain", "merde", "con", "connard", "conne", "bordel", "salaud", "salope", "chier", "enculé", "baiser", "cul", "ouais"}   # frequency list: content words only (function words are in CORE)


def lexique(data):
    """ortho -> [(lemma, cgram, freq)], lemma -> best (freq, cgram). Lemma frequency per million (films, books)."""
    path = data / "imports" / "lexique" / "Lexique383.tsv"
    if not path.exists():
        sys.exit(f"missing {path}: download http://www.lexique.org/databases/Lexique383/Lexique383.tsv there")
    forms, lemmas = defaultdict(list), {}
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            # geometric mean: common in films AND books (no film-only slang, no book-only literary words)
            fl = (float(r["freqlemfilms2"] or 0) * float(r["freqlemlivres"] or 0)) ** 0.5
            forms[r["ortho"]].append((r["lemme"], r["cgram"], fl))
            if fl > lemmas.get(r["lemme"], (0, ""))[0]:
                lemmas[r["lemme"]] = (fl, r["cgram"])
    return forms, lemmas


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ib.data_dir()))
    ap.add_argument("--n", type=int, default=40, help="words to add this run")
    ap.add_argument("--book", help="book id (default: the one read last)")
    ap.add_argument("--dry", action="store_true", help="only show the candidates")
    ap.add_argument("--no-sentences", action="store_true")
    ap.add_argument("--tapped-only", action="store_true", help="only words added in the reader (no book / frequency words)")
    ap.add_argument("--push", action="store_true", help="commit and push extra_words.json (and sentences)")
    args = ap.parse_args()
    data = Path(args.data)

    # progress.json is written by the app on GitHub: get the latest reading position first
    r = subprocess.run(["git", "-C", str(data), "pull", "--ff-only", "-q"], capture_output=True, text=True)
    if r.returncode:
        print(f"(git pull failed, using the local progress.json: {r.stderr.strip()[:120]})")

    forms, lemmas = lexique(data)
    words = ib.load(data / "words.json", {"words": []})["words"]
    xpath = data / "extra_words.json"
    extra = ib.load(xpath, {"words": []})
    sents = ib.load(data / "sentences.json", {})
    progress = ib.load(data / "progress.json", {})
    reading = progress.get("reading", {})

    def lemmas_of(form, gloss=None):
        k = ib.key(form)
        if gloss and gloss.get(k) and gloss[k][0]:
            return {ib.key(gloss[k][0])}
        return {ib.key(l) for l, _, _ in forms.get(k, [])} or {k}

    # everything you have as a card, by lemma
    known = set(ib.CORE)
    for w in words + extra["words"]:
        known |= lemmas_of(w["word"])
        known.add(ib.key(w.get("lemma") or w["word"]))
    for s in sents.values():
        if s.get("lemma"):
            known.add(ib.key(s["lemma"]))

    # the book read last (or --book), from your position on
    books = reading.get("books", {})
    book_id = args.book or max(books, key=lambda b: books[b].get("at", 0), default=None)
    book_cands = []
    gloss_all = {}
    for gp in (data / "books").glob("*.gloss.json"):
        gloss_all.update(ib.load(gp, {}))
    if book_id and (data / "books" / f"{book_id}.json").exists():
        book = ib.load(data / "books" / f"{book_id}.json", None)
        gloss = ib.load(data / "books" / f"{book_id}.gloss.json", {})
        pos = books.get(book_id, {}).get("pos", 0)
        win_end, w = pos, 0
        while win_end < len(book["paras"]) and w < AHEAD_PAGES * 220:
            w += len(ib.words_of(book["paras"][win_end]))
            win_end += 1
        in_win, left, form_of = Counter(), Counter(), defaultdict(Counter)
        for i in range(pos, len(book["paras"])):
            p = book["paras"][i]
            for a, b in ib.tokens(p):
                f = p[a:b]
                k = ib.key(f)
                g = gloss.get(k)
                if k in ib.CORE or (g and g[1] == "name") or (f[0].isupper() and not forms.get(k)):
                    continue   # names (glossary or not a French word)
                if not forms.get(k):
                    continue   # not in Lexique 3: not a French word (hobbit, invented words); tap it instead
                for lem in lemmas_of(f, gloss):
                    if lem in known or len(lem) < 2 or " " in lem:
                        continue
                    left[lem] += 1
                    form_of[lem][k] += 1
                    if i < win_end:
                        in_win[lem] += 1
        book_cands = sorted((l for l in in_win if left[l] >= MIN_LEFT),
                            key=lambda l: -(3 * in_win[l] + left[l]))
        print(f"book {book_id}: position ¶{pos}, next {AHEAD_PAGES} pages to ¶{win_end}: "
              f"{len(in_win)} unknown lemmas, {len(book_cands)} recur ≥ {MIN_LEFT}× from here")

    tapped = [ib.key(k) for k, (n, _) in sorted(reading.get("looked", {}).items(), key=lambda x: -x[1][1])
              if n >= TAPPED_MIN]
    tapped = list(dict.fromkeys([ib.key(k) for k in reading.get("added", {})] + tapped))   # "Add to my cards" first
    tapped_lem = []
    for k in tapped:
        for lem in lemmas_of(k, gloss_all):
            if lem not in known and lem not in tapped_lem and forms.get(k):
                tapped_lem.append(lem)

    freq = [l for l, (fl, cg) in sorted(lemmas.items(), key=lambda x: -x[1][0])
            if cg in CONTENT and l not in known and l not in VULGAR and len(l) > 1 and not re.search(r"[^a-zàâäçéèêëîïôöùûüÿœæ'-]", l)]

    # queue: tapped and book look-ahead words first (together); Lexique frequency words only fill up the rest
    picked, src = [], {}
    def take(l, s):
        if l not in src and len(picked) < args.n:
            picked.append(l)
            src[l] = s
    for l in tapped_lem:
        take(l, "tapped")
    for l in [] if args.tapped_only else book_cands:
        take(l, f"book:{book_id}")
    for l in [] if args.tapped_only else freq:
        if len(picked) >= args.n:
            break
        take(l, "freq")

    rank0 = max([w.get("rank", 0) for w in extra["words"]], default=0)
    now = time.strftime("%Y-%m-%d")
    new = []
    for i, l in enumerate(picked):
        new.append({"id": f"x:{l}", "word": l, "lemma": l, "source": src[l], "rank": rank0 + i + 1, "added": now,
                    "stage": "new"})
    for w in new:
        print(f"  {w['rank']:4} {w['source']:<18} {w['word']}")
    if args.dry or not new:
        print("dry run, nothing written" if args.dry else "nothing to add")
        return
    extra["words"].extend(new)
    ib.save(xpath, extra, indent=1)
    print(f"{len(new)} words added, queue {len(extra['words'])}")
    if args.push:
        import make_sentences as ms
        ms.push(data, f"Queue: +{len(new)} words", "extra_words.json")
    if not args.no_sentences:
        subprocess.run([sys.executable, str(Path(__file__).with_name("make_sentences.py")), "--extra"]
                       + (["--push"] if args.push else []), check=False)


if __name__ == "__main__":
    main()
