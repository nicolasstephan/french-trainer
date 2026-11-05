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

### Scheduling (`js/srs.js`)

Lingvist-style learning ladder + FSRS-5 for long-term memory. Lingvist's own rules, read from the export (state per answer): a miss brings the word back after ~50 s, then each first-try correct multiplies the gap by 5 (25 s → 2 min → 10 min → 1 h → …); then a forgetting model targeting 80 % recall takes over; right at first sight → ~280 days.

- **Ladder:** level 0–5, one pip per first-try correct; a miss → 0 (a long-term card that slips → 2). Retyping after a miss never counts. Steps: 30 s, 1 min, 5 min, 25 min, 2 h. Right at first sight, or right after ≥ 1 day → level 5 at once.
- **Long term:** FSRS-5 (default parameters) updates stability S and difficulty D on every answer; next review when predicted recall drops to 90 %.
- **Stages:** `new` (never right), `learning` (ladder), then by stability: `young` < 7 d, `familiar` < 30 d, `known` ≥ 30 d.
- State is never stored: each card's log (`words.json` history from Lingvist + `progress.json` log from the app) is replayed, so rule changes re-schedule everything.
- Order: learning cards whose step is due, then due reviews (most overdue first), then learning cards due within 20 min.

### Sentences

`python tools/make_sentences.py [--limit N] [--redo w1,w2]` runs headless Claude Code (`claude -p`, no API key), 25 words per batch, level by stage, the rest of each sentence preferably from known words. Resumable: only words without sentences are done.
