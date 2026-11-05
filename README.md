# French Trainer

Personal French vocabulary trainer, Lingvist-style. Static web app on GitHub Pages so it works on the phone: https://nicolasstephan.github.io/french-trainer/

## Idea

- One card = one word in context: a French sentence with a gap; type the missing word (English hint).
- Spaced repetition: correct answers push a card further out, misses bring it back soon.
- Cards link to each other (zettelkasten-like): shared lemmas, word families, topics.

## Data (same split as fitness-assistant)

This repo is public and holds only code. Personal data lives in the private repo `nicolasstephan/french-data`, cloned next to this one as `../french-data`; the app reads and writes it through a fine-grained GitHub token kept in the browser.

| File in french-data | Made by | What |
|---|---|---|
| `imports/lingvist/` | Lingvist export | raw account export; **local only** (email, password hash, IP) |
| `words.json` | `tools/import_lingvist.py` | one entry per Lingvist card: form, stage, interval, history stats |
| `sentences.json` | `tools/make_sentences.py` | per card: lemma, POS, gloss, 3 cloze sentences with translation + hint |

### Stages

The export only has Lingvist's state *before* each answer, so the importer computes the state after the last one: held = max(scheduled interval, real gap); first-try correct → next = held × 2.5 (1 day to 180 days), miss → 10 min. Stage by next interval: `learning` < 1 d, `young` < 7 d, `familiar` < 30 d, `known` ≥ 30 d; a single failed sighting is `new`.

### Sentences

`python tools/make_sentences.py [--limit N] [--redo w1,w2]` runs headless Claude Code (`claude -p`, no API key), 25 words per batch, level by stage, the rest of each sentence preferably from known words. Resumable: only words without sentences are done.
