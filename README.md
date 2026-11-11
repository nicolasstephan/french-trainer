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
| `books/<id>.json` | `tools/import_book.py` | an ebook: title, author, chapters, paragraphs |
| `books/<id>.gloss.json` | `tools/import_book.py --gloss` | every word form of the book → lemma, POS, German gloss, other meanings |
| `books/index.json` | `tools/import_book.py` | the library list, with how much of the book your words cover |
| `imports/books/` | you | raw ebooks; **local only** (gitignored, bought books stay off GitHub) |

### Scheduling (`js/srs.js`)

Lingvist-style learning ladder + FSRS-5 for long-term memory. Lingvist's own rules, read from the export (state per answer): a miss brings the word back after ~50 s, then each first-try correct multiplies the gap by 5 (25 s → 2 min → 10 min → 1 h → …); then a forgetting model targeting 80 % recall takes over; right at first sight → ~280 days.

- **Ladder:** level 0–5, one pip per first-try correct; a miss (or Enter on an empty gap) keeps the counter (never reset; a long-term card that slips → 4) and the card comes back after 2 cards. Retyping after a miss never counts. Steps are iterations, not minutes: the card comes back after 2, 4, 8, 16, 32 other cards (like Memrise / Quizlet; Lingvist uses time). Right at first sight, or right after ≥ 1 day → level 5 at once.
- **In flight:** ladder cards answered within the last hour come back by iteration and go first; at most 8 at once, the gaps are filled with due reviews. Older half-learned cards wait with the reviews.
- **Long term:** FSRS-5 (default parameters) updates stability S and difficulty D on every answer; next review when predicted recall drops to 90 %.
- **Stages:** `new` (never right), `learning` (ladder), then by stability: `young` < 7 d, `familiar` < 30 d, `known` ≥ 30 d.
- State is never stored: each card's log (`words.json` history from Lingvist + `progress.json` log from the app) is replayed, so rule changes re-schedule everything.
- Order: in-flight ladder cards whose turn has come, then due reviews / waiting cards (oldest first), then the in-flight card whose turn comes next (no waiting).
- Local test: serve `D:\work\private` and open `/French%20Trainer/?local`; `window.__ft` exposes the current target, card and iteration.

### Word list

Menu → **Words**: every card with its status (queued, new, learning with its pips, young, familiar, known), the next review and how often it was right first try. Sort by status (weakest first), A–Z, next review, most missed, last practiced, or the new-word queue (↓/↑ reverses); filter by status, search French or German. Words without a sentence yet are dimmed (not in practice); hover a row for details.

### Sentences

`python tools/make_sentences.py [--limit N] [--redo w1,w2] [--push]` runs headless Claude Code (`claude -p`, no API key) with **Sonnet** (`--model`), 60 words per call, one call at a time with a 60 s pause (`--batch`, `--jobs`, `--pause`; ~3 min per batch) so a run doesn't use up the Claude allowance; a usage-limit error stops the run and the rest waits for the next one, level by stage, the rest of each sentence preferably from known words. Order: learning, new, young, familiar, known, and within a stage what Lingvist had due first. Resumable: every batch is saved at once; only words without sentences are done; failed batches are retried next run. `--push` commits and pushes `sentences.json` after each batch, so the phone gets the words as they come.

**Alternatives:** each sentence has `alt`, other words that are also right in the gap (synonyms in the fitting form, usually none). Typing one is not a miss: the app says it's also right but another word is wanted, clears the gap, and the next try counts normally. Until a sentence has `alt` (entries carry `"alts": 1` once checked), another card of yours with the same part of speech whose German covers the sentence's hint counts too (not other forms of the same lemma). `make_sentences.py --alts [--limit N] [--push]` adds `alt` to sentences made before it existed (120 words per call).

**In the background:** `powershell -File tools\sentences_task.ps1 -Register` (once) adds the Windows task *French Trainer sentences*: daily at 13:00 and 5 min after logon, a missed run starts when the laptop is available again; it runs only while you are logged on (it uses your Claude Code login) and exits at once when nothing is missing. Each run: words added in the reader → queue, then at most 120 words of sentences, then the reader 30 pages ahead (`import_book.py --ahead`), then alternatives for up to 400 older words (`--alts`). Log: `french-data/imports/logs/sentences.log`. `-Unregister` removes it.

### Reader

Read French books in the app; tap any word for its German translation. Reading counts toward the daily goal.

- **Import:** `python tools/import_book.py book.epub` (EPUB without DRM, or `.txt`; for Kindle files convert to EPUB with Calibre first). Chapters come from headings; paragraphs over 150 words are split at sentence ends. Prints the coverage: the share of running words (names excluded) that are in your Lingvist words. Core function words Lingvist never asks (le, à, et, il …) count as known. Lemmas come from the glossary, so the number goes up once the glossary exists.
- **Glossary:** `python tools/import_book.py --gloss <id> --limit 1500` runs headless Claude Code on the word forms in reading order (120 per call, about 2.5 min), so the first chapters are covered first. It is resumable, and a whole novel (about 9k forms) takes about 3 h. Each entry has the lemma, POS, a German gloss that fits the first passage, and other meanings; passé simple and subjonctif forms are flagged.
- **Tap a word:** the panel shows the glossary entry, your own card for that form or lemma (with its stage), the sentence and its German translation. Where none is prepared yet, the sentence is machine-translated on the spot (in italics): Chrome's built-in on-device translator where the browser has one, else MyMemory (free, any browser, about 5,000 characters a day without an account); results are cached on the device (`ft.mt`). A DeepL link appears only if both fail. Looked-up words get a dotted underline and are kept in `progress.json` (`reading.looked`). **Add to my cards** in the panel, or looking a word up a second time, adds it (`reading.added`, message *Added to your cards*); the scheduled task turns these into queued cards (`add_words.py --tapped-only`) and makes their sentences. Names and chapter numbers get no button.
- **Ahead of you:** `python tools/import_book.py --ahead 30 [--push]` makes the glossary and the sentence translations (`books/<id>.de.json`, per paragraph one German sentence per French one, split like the app: `sentences()` in `js/reader.js`) up to 30 pages past your position in the books you are reading (positions from `progress.json`), starting a page before it. The scheduled task runs it daily with Sonnet, so the next pages are covered without translating whole books.
- **Pages:** about 220 words each, never across a chapter; swipe or ←/→ to turn, A−/A+ for the text size. Turning past a page marks it read. Its words count once (`reading.log`, `reading.books[id].read` ranges), so going back and re-reading doesn't count again.
- **Daily goal:** cards plus reading, by default 60 cards + 3 pages. A page is 220 words: the reader counts words, the goal and home screen show pages (Settings: pages, half pages allowed, 0 = off). A day is reached when both goals are met; days before the reader existed count cards only. The 14-day boxes show the average of the two.
- **Catching up:** tap a past day in *Last 14 days*: practice and reading now count for that day (answers carry the day as a 3rd element, reading log entries as a 5th; the scheduler still uses the real time). *Back to today* or tapping today ends it; a reload starts on today.
- **Sync button** (header, as in Fitness Assistant): dot + status (synced at, saving, error); tap = pull words, sentences and progress from GitHub, merge with this device, push. On a phone only the dot shows.
- Books and glossaries are fetched through the token like the other data and kept offline in Cache Storage (`ft-books`).

### New words (beyond Lingvist)

`python tools/add_words.py [--n 40] [--book ID] [--dry]` fills the queue `extra_words.json` in french-data, then runs `make_sentences.py --extra` for the queued words. Lingvist imports never touch the queue. Everything works by dictionary form (lemma): a word is skipped if any form of it is already a card. Sources, in priority order (1 and 2 together):

1. **Tapped:** words you added in the reader (button, or looked up at least twice).
2. **Book look-ahead:** unknown lemmas in the next 15 pages after your reading position (the book read last), ranked by 3 × count in those pages + count to the end. A word must recur at least 3 times from your position on; rarer ones you just tap.
3. **Frequency:** Lexique 3 lemmas (nouns, verbs, adjectives, adverbs) by the geometric mean of their film and book frequency, so a word has to be common in both. Vulgar words are skipped. They only fill up the queue when there aren't enough tapped and book words, and the app introduces them only after all book and tapped words, even ones queued later.

Lexique 3 (`imports/lexique/Lexique383.tsv`, 25 MB, local only) comes from http://www.lexique.org/databases/Lexique383/Lexique383.tsv (CC BY-SA 4.0).

**When a new word comes is decided by the app** (`newWordCapacity` in `js/app.js`), based on how well you're doing:
- **Budget per day:** "new words per day" (Settings, default 15) × f. f comes from your first-try rate over the last 50 answers: 75 % → 0, 90 % → full, linear in between (2/3 with fewer than 15 answers).
- **Not now while:** 3 or more words in training were just missed (last answer wrong), the ladder has 6 of its 8 slots in use, or more than 15 reviews are due. The words you're struggling with come first.
- **Pace:** new words are spread over the day's card goal (by card 30 of 60, at most half the budget), and they take a slot only when nothing else is waiting.
- The home screen shows "New words today: x / budget", your first-try rate, and why no new word is coming right now.
