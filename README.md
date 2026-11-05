# French Trainer

Personal French vocabulary trainer, Lingvist-style. Runs as a static web app on GitHub Pages so it works on the phone.

## Idea

- One card = one word in context: a French sentence with a gap; type the missing word (translation as the hint).
- Spaced repetition: correct answers push a card further out, wrong ones bring it back soon.
- Cards link to each other (zettelkasten-like): shared words, word families, topics.
- Progress lives in browser storage (later: optional sync).

## Data

- `data/lingvist-raw/`: full Lingvist account export (2025-10-19 to 2025-11-05). **Not in git**: it contains personal data (email, password hash, IP).
- What it has: ~12.8k answer events (`events/*.json`, schema `guess:0.14`) for 3,382 distinct words, with answer, typing attempts, mistakes and Lingvist's SRS state per answer.
- What it lacks: the sentences and translations. Each card only references a Lingvist content file (`content_path`), which isn't in the export.
- Plan: extract a clean `data/words.json` (word, history, strength) that can be committed, then pair each word with example sentences from an open source (e.g. Tatoeba FR-EN/FR-DE).
