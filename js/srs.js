// Scheduler: Lingvist-style learning ladder + FSRS-5 for long-term memory.
//
// Learning ladder (the "5 times right" part, like Lingvist's short steps):
//   a card has a level 0..5. Right on the first try -> level + 1; a miss keeps the level (the counter is never
//   reset; a long-term card that slips goes to 4, one right brings it back) and the card comes back soon
//   (after LADDER[0] cards). Shortcuts to level 5, as in Lingvist: right the very first time
//   the word is seen (already known), or right after a gap of a day or more (it held overnight).
//   Below 5 the card comes back after LADDER[level] other cards (2, 4, 8, 16, 32: iterations, not minutes,
//   like Memrise / Quizlet; Lingvist uses time, ×5 per step). Retyping after a miss never counts.
//   The iteration counter is the number of answers given so far (all cards, in time order).
// Long term (level 5): FSRS-5 (open-spaced-repetition, default parameters) tracks stability S (days until
//   recall drops to 90 %) and difficulty D on every answer; the next review is when predicted recall falls
//   to RETENTION. Lingvist targets 80 %; FSRS's recommended default is 90 %.
//
// State is never stored: it is rebuilt by replaying a card's answer log [[unix s, ok], ...]
// (Lingvist history from words.json + answers in this app). Changing the rules here re-schedules everything.

export const DAY = 86400;
export const LADDER = [2, 4, 8, 16, 32];   // cards in between until the next sighting at level 0..4
export const GRADUATE = 5;
export const RETENTION = 0.9;
const MAX_DAYS = 365;

// FSRS-5 default weights
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5, FACTOR = 19 / 81;
const clampD = (d) => Math.min(10, Math.max(1, d));
const d0 = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
/** Predicted recall after t days at stability s. */
export const recall = (t, s) => Math.pow(1 + (FACTOR * t) / s, DECAY);
const interval = (s, r = RETENTION) => (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);

function fsrs(c, g, now) {
  if (!c.s) { c.s = W[g - 1]; c.d = d0(g); return; }
  const t = (now - c.last) / DAY;
  if (t < 1) {
    c.s *= Math.exp(W[17] * (g - 3 + W[18]));          // same-day review
  } else {
    const r = recall(t, c.s);
    c.s = g === 1
      ? Math.min(W[11] * Math.pow(c.d, -W[12]) * (Math.pow(c.s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)), c.s)
      : c.s * (Math.exp(W[8]) * (11 - c.d) * Math.pow(c.s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) + 1);
  }
  c.s = Math.max(c.s, 0.01);
  const dp = c.d - W[6] * (g - 3) * (10 - c.d) / 9;
  c.d = clampD(W[7] * d0(4) + (1 - W[7]) * dp);
}

// due: unix s (long term); dueIter: iteration (ladder)
export const blank = () => ({ miss: false, level: 0, s: 0, d: 0, last: 0, due: 0, dueIter: 0, reps: 0, lapses: 0, ok: 0 });

/** Applies one answer (ok = right on the first try) at unix seconds `now`, as answer number `iter`. */
export function answer(c, ok, now, iter) {
  const first = c.reps === 0, gap = now - c.last;
  fsrs(c, ok ? 3 : 1, now);
  c.reps++;
  if (ok) {
    c.ok++;
    // right at first sight (already known) or after a night (it held) -> long term, like Lingvist
    c.level = first || gap >= DAY ? GRADUATE : Math.min(c.level + 1, GRADUATE);
  } else {
    c.lapses++;
    c.level = Math.min(c.level, GRADUATE - 1);   // the counter stays; a long-term card drops back into the ladder
  }
  c.miss = !ok;
  c.last = now;
  if (c.level < GRADUATE) {
    c.dueIter = iter + LADDER[ok ? c.level : 0] + 1;   // a missed card comes back soon
    c.due = now;                                          // ladder cards are due by iteration, not time
  } else {
    c.due = now + Math.min(Math.max(interval(c.s), 1), MAX_DAYS) * DAY;
  }
  return c;
}

/** All cards from their answer logs ({id: [[unix s, ok], ...]}), replayed in global time order so the
 *  iteration counter is right. Returns { cards: Map(id -> state), iter: answers so far }. */
export function replayAll(logs) {
  const all = [];
  for (const [id, log] of Object.entries(logs)) for (const [t, ok] of log) all.push([t, ok, id]);
  all.sort((a, b) => a[0] - b[0]);
  const cards = new Map(Object.keys(logs).map((id) => [id, blank()]));
  all.forEach(([t, ok, id], i) => answer(cards.get(id), !!ok, t, i));
  return { cards, iter: all.length };
}

export const STAGES = ["new", "learning", "young", "familiar", "known"];
export function stageOf(c) {
  if (!c.ok) return "new";
  if (c.level < GRADUATE) return "learning";
  if (c.s < 7) return "young";
  if (c.s < 30) return "familiar";
  return "known";
}

/** Compare the typed answer with the target. Returns "ok", "accent" (only accents/case differ) or "wrong". */
export function grade(typed, target) {
  const norm = (s) => s.normalize("NFC").replace(/[’ʼ`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const bare = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (norm(typed) === norm(target)) return "ok";
  if (bare(typed) === bare(target)) return "accent";
  return "wrong";
}
