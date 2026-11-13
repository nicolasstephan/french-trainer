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
    python tools/make_sentences.py --push          # commit + push sentences.json after every batch (scheduled job)
    python tools/make_sentences.py --alts --limit 400 --push   # alternatives for sentences made before "alt" existed

"alt" per sentence: other words that are also right in the gap. The app then says "also right, but another word is
wanted" instead of counting a miss. Entries with alt checked carry "alts": 1.

Model: Sonnet by default (--model; same quality for this job at a fraction of Opus's usage). Batches of 60 words,
one at a time with a pause in between (--batch, --jobs, --pause), so a run doesn't eat the whole usage allowance;
a usage-limit error stops the run (the rest waits for the next one). Each finished batch is saved at once.
Scheduled: tools/sentences_task.ps1 registers a daily Windows task that runs this with --push.

Difficulty follows the stage: new/learning words get short, simple sentences built from
vocabulary you already know well; familiar/known words get longer, more natural ones.
"""
import argparse
import json
import random
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

PER_WORD = 3
BATCH = 60
JOBS = 1
PAUSE = 60            # seconds between batches
MODEL = "sonnet"
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
"alt" = other French words that would be EQUALLY correct in the gap: same meaning as the hint, the exact form that
fits the gap (agreement, tense, elision), natural French. Real synonyms only, not the target; usually [].

Reply with JSON only, no prose, shaped:
{{"<id>": {{"lemma": "...", "pos": "...", "gender": null, "gloss": "...", "meanings": ["..."],
  "sentences": [{{"fr": "...", "de": "... [[...]] ...", "hint": "...", "alt": []}}]}}}}

Words (id | target | level):
{words}
"""


def data_dir():
    return Path(__file__).resolve().parents[1].parent / "french-data"


def ask_claude(prompt, model=MODEL):
    exe = shutil.which("claude") or shutil.which("claude.cmd")
    r = subprocess.run([exe, "-p", "--model", model, "--output-format", "text"], input=prompt,
                       capture_output=True, text=True, encoding="utf-8", timeout=900)
    if r.returncode:
        # skip claude's sign-in warnings: the real error comes after them
        lines = [l for l in (r.stderr + r.stdout).splitlines() if l.strip() and not l.startswith("Warning:")]
        raise RuntimeError(" ".join(lines)[-300:] or f"exit {r.returncode}")
    # the first complete JSON object (replies sometimes add a line of prose or a second block after it)
    start = r.stdout.find("{")
    if start < 0:
        raise ValueError("no JSON in reply")
    return json.JSONDecoder().raw_decode(r.stdout[start:])[0]


def clean_alts(word, alts):
    """Single words or short phrases, not the target itself."""
    out = []
    for a in alts if isinstance(alts, list) else []:
        a = str(a).strip()
        if a and a.lower() != word.lower() and len(a.split()) <= 3 and a not in out:
            out.append(a)
    return out


def check(word, entry):
    """Keep sentences that contain the target as a whole word."""
    pat = re.compile(r"(?<!\w)" + re.escape(word) + r"(?![\w])", re.I)
    entry["sentences"] = [s for s in entry.get("sentences", [])
                          if pat.search(s.get("fr", "")) and 1 <= s.get("de", "").count("[[") <= 3]
    for s in entry["sentences"]:
        s["alt"] = clean_alts(word, s.get("alt"))
    entry["v"] = VERSION
    entry["alts"] = 1
    return entry


ALT_PROMPT = """You check French cloze sentences for a vocabulary trainer. The learner is German and types the missing
word (___). For each sentence, list other French words that would be EQUALLY correct in the gap: same meaning as the
German hint, the exact form that fits the gap (agreement, tense, mood, elision, e.g. after "l'" or "qu'" only words
starting with a vowel sound), natural French a teacher would accept. Real synonyms only; not the target itself;
not a different form of the target; nothing that changes the meaning. Most gaps have none: then [].

Reply with JSON only, no prose: {{"<id>": [[alternatives for sentence 1], [sentence 2], ...]}}

Sentences (id | target | sentence number | German hint | sentence):
{lines}
"""


def gapped(fr, word):
    pat = re.compile(r"(?<!\w)" + re.escape(word) + r"(?![\w])", re.I)
    return pat.sub("___", fr, count=1)


def backfill_alts(args, data, out, out_path):
    """Add "alt" to entries made before it existed (one call per batch of words, same pacing as sentences)."""
    todo = [(i, e) for i, e in out.items() if is_current(e) and not e.get("alts")]
    if args.limit:
        todo = todo[:args.limit]
    print(f"alternatives: {len(todo)} words to check", flush=True)
    size = args.batch * 2   # the replies are short
    batches = [todo[i:i + size] for i in range(0, len(todo), size)]
    t0 = time.time()
    for n, batch in enumerate(batches, 1):
        if n > 1 and args.pause:
            time.sleep(args.pause)
        lines = "\n".join(f"{i} | {e['word']} | {k + 1} | {s.get('hint') or e.get('gloss', '')} | {gapped(s['fr'], e['word'])}"
                          for i, e in batch for k, s in enumerate(e["sentences"]))
        try:
            res = ask_claude(ALT_PROMPT.format(lines=lines), args.model)
        except Exception as e:
            if (isinstance(e, RuntimeError) and re.search(r"\b(limit|usage|quota|rate)\b", str(e), re.I)):
                print(f"alt batch {n}/{len(batches)}: usage limit reached, stopping ({str(e)[:200]})", flush=True)
                break
            print(f"alt batch {n}/{len(batches)}: failed ({str(e)[:200]})", flush=True)
            continue
        got = with_alt = 0
        for i, e in batch:
            r = res.get(i)
            if not isinstance(r, list):
                continue
            for k, s in enumerate(e["sentences"]):
                s["alt"] = clean_alts(e["word"], r[k] if k < len(r) else [])
                with_alt += bool(s["alt"])
            e["alts"] = 1
            got += 1
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"alt batch {n}/{len(batches)}: {got}/{len(batch)} words, {with_alt} sentences with alternatives "
              f"({(time.time() - t0) / 60:.0f} min)", flush=True)
        if args.push and got:
            push(data, f"Sentences: alternatives for {got} words")
    left = sum(1 for e in out.values() if is_current(e) and not e.get("alts"))
    print(f"alternatives done: {left} words still without")


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
    ap.add_argument("--extra", action="store_true", help="only the queued new words (extra_words.json, by rank)")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--batch", type=int, default=BATCH, help="words per call")
    ap.add_argument("--jobs", type=int, default=JOBS, help="calls at the same time")
    ap.add_argument("--pause", type=int, default=PAUSE, help="seconds between batches")
    ap.add_argument("--push", action="store_true", help="commit and push sentences.json after every batch")
    ap.add_argument("--alts", action="store_true", help="only add alternatives (alt) to existing sentences")
    args = ap.parse_args()
    data = Path(args.data)
    words = json.loads((data / "words.json").read_text(encoding="utf-8"))["words"]
    xp = data / "extra_words.json"
    extra = json.loads(xp.read_text(encoding="utf-8"))["words"] if xp.exists() else []
    out_path = data / "sentences.json"
    out = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    redo = {w.strip() for w in args.redo.split(",") if w.strip()}
    for w in words + extra:
        if w["word"] in redo:
            out.pop(w["id"], None)
    if args.alts:
        backfill_alts(args, data, out, out_path)
        return

    known = [w["word"] for w in words if w["stage"] == "known" and w["first_try_rate"] >= 0.6]
    todo = [w for w in (extra if args.extra else words + extra) if not is_current(out.get(w["id"]))]
    # words that had sentences in an older format (English) come first, so the app never goes back to fewer cards
    old = {i for i, e in out.items() if not is_current(e)}
    # hardest first: they need sentences soonest; within a stage the ones Lingvist had due first
    order = {"learning": 0, "new": 1, "young": 2, "familiar": 3, "known": 4}
    # queued new words (tools/add_words.py) first, in queue order: the app introduces them in that order
    todo.sort(key=lambda w: (w["id"] not in old, "rank" not in w, w.get("rank", 0), order[w["stage"]],
                             w.get("due") or "", w["word"]))
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} words to do, {len(out)} done")

    batches = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)]

    stop = threading.Event()   # set on a usage-limit error: the remaining batches wait for the next run

    def run(batch, n):
        if n > 1 and args.pause:
            time.sleep(args.pause)
        if stop.is_set():
            raise RuntimeError("skipped (usage limit)")
        lines = "\n".join(f"{w['id']} | {w['word']} | {LEVEL[w['stage']]}" for w in batch)
        prompt = PROMPT.format(n=PER_WORD, known=", ".join(random.sample(known, min(150, len(known)))), words=lines)
        return ask_claude(prompt, args.model)

    t0, failed = time.time(), 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futs = {pool.submit(run, b, n): n for n, b in enumerate(batches, 1)}
        for fut in as_completed(futs):   # results are merged here, one at a time
            n, batch = futs[fut], batches[futs[fut] - 1]
            try:
                res = fut.result()
            except Exception as e:  # keep going; the next run retries these
                failed += 1
                if (isinstance(e, RuntimeError) and re.search(r"\b(limit|usage|quota|rate)\b", str(e), re.I)) and not stop.is_set():
                    stop.set()
                    print(f"batch {n}/{len(batches)}: usage limit reached, stopping ({str(e)[:200]})", flush=True)
                elif not stop.is_set():
                    print(f"batch {n}/{len(batches)}: failed ({str(e)[:200]})", flush=True)
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
            print(f"batch {n}/{len(batches)}: {got}/{len(batch)} words, total {len(out)} "
                  f"({(time.time() - t0) / 60:.0f} min)", flush=True)
            if args.push and got:
                push(data, f"Sentences: +{got} words ({len(out)} total)")
    print(f"done: {len(out)} words have sentences" + (f", {failed} batches failed (retried next run)" if failed else ""))


def push(data, msg, path="sentences.json"):
    """Commit one data file and push; the app writes only progress.json, so a rebase never conflicts."""
    git = ["git", "-C", str(data)]
    subprocess.run(git + ["add", path], check=False)
    if subprocess.run(git + ["diff", "--cached", "--quiet"]).returncode == 0:
        return
    subprocess.run(git + ["commit", "-q", "-m", msg], check=False)
    for _ in range(3):
        subprocess.run(git + ["pull", "-q", "--rebase", "--autostash"], check=False)
        if subprocess.run(git + ["push", "-q"]).returncode == 0:
            return
        time.sleep(5)
    print("  (push failed; the next batch tries again)")


if __name__ == "__main__":
    main()
