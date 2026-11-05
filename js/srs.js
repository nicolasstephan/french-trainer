// Spaced repetition, continuing from the Lingvist import (tools/import_lingvist.py uses the same rules).
// A card state: { i: interval s, due: ms, reps, lapses, last: ms }.

export const MIN = 60, HOUR = 3600, DAY = 86400;
const GROW = 2.5, MAX = 180 * DAY;

export const STAGES = ["new", "learning", "young", "familiar", "known"];

export function stageOf(state) {
  if (!state.reps) return "new";
  const i = state.i;
  if (i < DAY) return "learning";
  if (i < 7 * DAY) return "young";
  if (i < 30 * DAY) return "familiar";
  return "known";
}

/** Initial state from a words.json entry. */
export function seed(w) {
  const due = w.due ? Date.parse(w.due) : Date.now();
  return { i: (w.interval_days ?? 0) * DAY, due, reps: w.reviews ?? 0, lapses: 0, last: Date.parse(w.last_seen) || 0 };
}

/** Next state after an answer. ok = right on the first try. */
export function review(state, ok, now = Date.now()) {
  const held = Math.max(state.i, state.last ? (now - state.last) / 1000 : 0);
  let i;
  if (!ok) i = 10 * MIN;
  else if (state.i < 10 * MIN) i = 25 * MIN;        // just missed / brand new: once more later today
  else if (state.i < DAY) i = DAY;                  // learning step done
  else i = Math.min(held * GROW, MAX);
  return { i, due: now + i * 1000, reps: state.reps + 1, lapses: state.lapses + (ok ? 0 : 1), last: now };
}

/** Compare the typed answer with the target. Returns "ok", "accent" (only accents/case differ) or "wrong". */
export function grade(typed, target) {
  const norm = (s) => s.normalize("NFC").replace(/[’ʼ`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const bare = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (norm(typed) === norm(target)) return "ok";
  if (bare(typed) === bare(target)) return "accent";
  return "wrong";
}
