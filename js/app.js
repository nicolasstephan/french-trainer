// French Trainer: cloze cards from the private data repo (words.json + sentences.json), progress in progress.json.
// Scheduling: js/srs.js (learning ladder + FSRS). Card state is rebuilt from answer logs:
// the Lingvist history (words.json) + this app's answers (progress.json, v2: log per card).
import { GitHubStore } from "./github-store.js";
import { STYLES, getStyle, setStyle, getThemeMode, setThemeMode } from "./theme.js";
import { checkForUpdate } from "./update-check.js";
import { STAGES, GRADUATE, LADDER, stageOf, replayAll, answer, grade } from "./srs.js";
import { initReader, openLibrary, emptyReading, mergeReading, readingDays, key as formKey, DEFAULT_READ_PAGES, PAGE_WORDS } from "./reader.js";

const $ = (id) => document.getElementById(id);
const LS = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: session only */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};
const nowS = () => Math.floor(Date.now() / 1000);

let words = [];            // words.json entries (with Lingvist history)
let sentences = {};        // id -> { lemma, pos, gender, gloss, meanings, sentences: [{fr, de, hint}] }
let progress = { version: 2, log: {}, days: {}, reading: emptyReading() };   // log: id -> [[unix s, ok], ...] answers given in this app
let cards = new Map();     // id -> scheduler state (replayed)
let iter = 0;              // answers given so far (all cards): the ladder's clock
let byId = new Map(), byLemma = new Map(), byForm = new Map();
let progressStore = null, saveTimer = null;
let current = null, previous = null, phase = "ask", missed = false;   // ask -> (retype) -> shown

// ---------- data ----------

function config() { return { repo: LS.get("ft.repo", ""), token: LS.get("ft.token", "") }; }

// local development: http://127.0.0.1:<port>/French%20Trainer/?local reads ../french-data directly (progress stays in this browser)
const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && new URLSearchParams(location.search).has("local");

async function loadData() {
  if (LOCAL) {
    const get = async (f) => { const r = await fetch(`../french-data/${f}`, { cache: "no-store" }); return r.ok ? r.json() : null; };
    words = withExtra((await get("words.json"))?.words, (await get("extra_words.json"))?.words);
    sentences = (await get("sentences.json")) ?? {};
    progress = mergeProgress(null, LS.get("ft.progress"));
    start();
    return;
  }
  const { repo, token } = config();
  if (!repo || !token) { show("setup"); return; }
  show("loading");
  const store = (path) => new GitHubStore({ repo, token, path });
  try {
    progressStore = store("progress.json");
    const [w, x, s, p] = await Promise.all([store("words.json").loadRaw(), store("extra_words.json").loadRaw(),
      store("sentences.json").loadRaw(), progressStore.load()]);
    words = withExtra(w?.words, x?.words);
    sentences = s ?? {};
    LS.set("ft.cache", { words, sentences });
    progress = mergeProgress(p, LS.get("ft.progress"));
  } catch (e) {
    const cache = LS.get("ft.cache");
    if (!cache) { error(e.message); show("setup"); return; }
    error(`Offline (${e.message}); using the copy on this device.`);
    ({ words, sentences } = cache);
    progress = mergeProgress(null, LS.get("ft.progress"));
  }
  start();
}

/** Lingvist cards + the queue of new words (no history; introduced by newWordCapacity, in queue order). */
function withExtra(lingvist, extra) {
  const out = lingvist ?? [], have = new Set(out.map((w) => w.id));
  for (const w of extra ?? []) if (!have.has(w.id)) out.push({ ...w, history: [], extra: true });
  return out;
}

/** Remote + local progress: union of the answer logs (v1 files from the first version had no log and are dropped);
 *  settings (daily goal): the most recently changed wins. */
function mergeProgress(...srcs) {
  const out = { version: 2, log: {}, days: {}, reading: mergeReading(...srcs.map((x) => x?.reading)) };
  for (const src of srcs) {
    if (!src) continue;
    if (src.goal && (src.goalSet ?? 0) >= (out.goalSet ?? 0)) { out.goal = src.goal; out.goalSet = src.goalSet ?? 0; }
    if (src.maxNew != null && (src.maxNewSet ?? 0) >= (out.maxNewSet ?? -1)) { out.maxNew = src.maxNew; out.maxNewSet = src.maxNewSet ?? 0; }
    for (const [id, log] of Object.entries(src.log ?? {})) {
      const seen = new Map((out.log[id] ?? []).map((e) => [e[0], e]));
      for (const e of log) seen.set(e[0], e);
      out.log[id] = [...seen.values()].sort((a, b) => a[0] - b[0]);
    }
    for (const [d, n] of Object.entries(src.days ?? {})) out.days[d] = Math.max(out.days[d] ?? 0, n);
  }
  return out;
}

function start() {
  byId = new Map(words.map((w) => [w.id, w]));
  byLemma = new Map();
  byForm = new Map(words.map((w) => [formKey(w.word), w.id]));
  for (const [id, s] of Object.entries(sentences)) {
    const key = (s.lemma || "").toLowerCase();
    if (!key) continue;
    if (!byLemma.has(key)) byLemma.set(key, []);
    byLemma.get(key).push(id);
  }
  // the reading goal counts from the first day this version runs (older days: cards only)
  if (!progress.reading.since) progress.reading.since = today();
  ({ cards, iter } = replayAll(Object.fromEntries(words.map((w) => [w.id, [...(w.history ?? []), ...(progress.log[w.id] ?? [])]]))));
  home();
}

const stage = (id) => stageOf(cards.get(id));

// ---------- daily goal ----------

const DEFAULT_GOAL = 60;
const goal = () => progress.goal ?? DEFAULT_GOAL;
/** Local calendar day of a unix time (s) as YYYY-MM-DD. */
const dayKey = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const today = () => dayKey(nowS());
/** Answers per day, counted from the app's answer log (so several devices add up). */
function dayCounts() {
  const n = {};
  for (const log of Object.values(progress.log)) for (const [t] of log) { const k = dayKey(t); n[k] = (n[k] ?? 0) + 1; }
  return n;
}
const doneToday = () => dayCounts()[today()] ?? 0;
// reading goal: set in pages (progress.reading.pages), counted in words (a page = PAGE_WORDS)
const readPages = () => progress.reading.pages ?? DEFAULT_READ_PAGES;
const readGoal = () => readPages() * PAGE_WORDS;
const pagesOf = (w) => { const p = w / PAGE_WORDS; return p >= 10 || Number.isInteger(p) ? String(Math.round(p)) : p.toFixed(1); };
const readToday = () => ({ n: readingDays(progress.reading, dayKey)[today()] ?? 0, goal: readGoal() });
/** Share of the day's goals done (0..1), the average of cards and reading; reached = both done. */
function dayScore(k, counts, reads) {
  const c = Math.min(1, (counts[k] ?? 0) / goal());
  const rg = readGoal(), readOn = rg > 0 && k >= (progress.reading.since ?? k);
  if (!readOn) return { f: c, reached: c >= 1 };
  const r = Math.min(1, (reads[k] ?? 0) / rg);
  return { f: (c + r) / 2, reached: c >= 1 && r >= 1 };
}

function home() {
  current = null;
  const counts = dayCounts(), reads = readingDays(progress.reading, dayKey), g = goal(), n = counts[today()] ?? 0;
  const rg = readGoal(), rn = reads[today()] ?? 0;
  $("today-n").textContent = n;
  $("today-goal").textContent = g;
  $("goal-fill").style.width = `${Math.min(100, (100 * n) / g)}%`;
  $("goal-fill").parentElement.classList.toggle("reached", n >= g);
  $("read-row").hidden = !rg;
  $("read-n").textContent = pagesOf(rn);
  $("read-goal").textContent = readPages();
  $("read-row").title = `${rn} / ${rg} words (a page = ${PAGE_WORDS} words)`;
  $("read-fill").style.width = `${Math.min(100, (100 * rn) / (rg || 1))}%`;
  $("read-fill").parentElement.classList.toggle("reached", rn >= rg);
  const left = [n < g ? `${g - n} cards` : "", rg && rn < rg ? `${pagesOf(rg - rn)} page${rg - rn > PAGE_WORDS ? "s" : ""} of reading` : ""].filter(Boolean);
  $("today-text").textContent = !left.length ? "Daily goal reached. Extra practice still counts."
    : n || rn ? `${left.join(" and ")} to go.` : "Not started yet.";
  // last 14 days, oldest first
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(nowS() - i * 86400));
  $("days").innerHTML = days.map((k) => {
    const c = counts[k] ?? 0, r = reads[k] ?? 0, sc = dayScore(k, counts, reads);
    const wd = new Date(`${k}T12:00`).toLocaleDateString([], { weekday: "narrow" });
    return `<div class="day${sc.reached ? " reached" : ""}${k === today() ? " today" : ""}" title="${k}: ${c} / ${g} cards${r ? ` · ${pagesOf(r)} pages read` : ""}">`
      + `<div class="box"><span style="height:${100 * sc.f}%"></span></div>${wd}</div>`;
  }).join("");
  // streak: days in a row with the goal reached (today counts once reached, else the streak runs to yesterday)
  const ok = (i) => dayScore(dayKey(nowS() - i * 86400), counts, reads).reached;
  let streak = 0;
  for (let i = ok(0) ? 0 : 1; ok(i); i++) streak++;
  const reached = days.filter((k) => dayScore(k, counts, reads).reached).length;
  $("streak").textContent = `Goal reached on ${reached} of the last 14 days` + (streak ? ` · streak ${streak} day${streak > 1 ? "s" : ""}` : "");
  const cap = newWordCapacity();
  $("new-text").textContent = !cap.queued && !cap.used ? "No new words queued. Run tools/add_words.py."
    : `New words today: ${cap.used} · allowance ${cap.budget} of ${maxNew()}`
      + (cap.acc != null ? ` (${Math.round(100 * cap.acc)} % right first try, last ${RECENT})` : "")
      + (cap.reason && cap.reason !== "today's new words done" ? ` · now: ${cap.reason}` : "")
      + ` · ${cap.queued} queued`;
  $("practice").textContent = n >= g ? "Practice more" : n ? `Continue · ${n} / ${g}` : "Practice";
  $("read").textContent = !rg || rn >= rg ? "Read" : rn ? `Read · ${pagesOf(rn)} / ${readPages()}` : "Read";
  renderCounts();
  renderStages();
  show("home");
}

function saveSoon(delay = 4000) {
  progress.updated = new Date().toISOString();
  LS.set("ft.progress", progress);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!progressStore) return;
  try { await progressStore.save(progress, "Progress"); error(""); }
  catch (e) { error(`Not synced: ${e.message}`); }
}

// ---------- picking the next card ----------

// ---------- new words: only when the words in training are going well ----------

const DEFAULT_MAX_NEW = 15;   // new words a day at full capacity
const maxNew = () => progress.maxNew ?? DEFAULT_MAX_NEW;
const RECENT = 50;            // answers that decide today's capacity
const unseen = (id) => cards.get(id).reps === 0;

/** New words introduced today (first answer today, no Lingvist history). */
function newToday() {
  let n = 0;
  for (const [id, log] of Object.entries(progress.log)) {
    if (log.length && !byId.get(id)?.history?.length && dayKey(log[0][0]) === today()) n++;
  }
  return n;
}

/** How many new words today, and whether one may come now.
 *  Budget: maxNew × f, f from first-try accuracy over the last RECENT answers (75 % → 0, 90 % → full).
 *  Not now while: 3+ words in training were just missed, the ladder is nearly full, or > 15 reviews are due.
 *  Pace: new words are spread over the day's goal instead of coming in a burst. */
function newWordCapacity() {
  const now = nowS();
  const recent = Object.values(progress.log).flat().sort((a, b) => b[0] - a[0]).slice(0, RECENT);
  const acc = recent.length >= 15 ? recent.filter((e) => e[1]).length / recent.length : null;
  const f = acc == null ? 2 / 3 : Math.min(1, Math.max(0, (acc - 0.75) / 0.15));
  const budget = Math.round(maxNew() * f), used = newToday();
  const ids = playable();
  const c = (id) => cards.get(id);
  const training = ids.filter((id) => c(id).level < GRADUATE && c(id).reps > 0 && now - c(id).last < SESSION);
  const struggling = training.filter((id) => c(id).miss).length;
  const due = ids.filter((id) => c(id).level >= GRADUATE && c(id).due <= now).length;
  const queued = ids.filter(unseen).length;
  let reason = "";
  if (!queued) reason = "queue empty (run tools/add_words.py)";
  else if (used >= budget) reason = budget ? "today's new words done" : `first-try rate ${Math.round(100 * acc)} %: consolidate first`;
  else if (struggling >= 3) reason = `${struggling} words need work first`;
  else if (training.length >= FLIGHT - 2) reason = "enough words in training";
  else if (due > 15) reason = `${due} reviews first`;
  const pace = used < Math.ceil(budget * Math.min(1, (doneToday() + 1) / goal()));
  return { budget, used, acc, queued, reason, ok: !reason && pace, okAnyPace: !reason };
}

const playable = () => words.filter((w) => sentences[w.id]?.sentences?.length).map((w) => w.id);
// Ladder cards answered within SESSION are "in flight": they come back by iteration and go first.
// Older half-learned cards (e.g. from the last Lingvist session) wait with the due reviews.
// At most FLIGHT cards are on the ladder at once; past that the gaps are filled with reviews.
const SESSION = 3600, FLIGHT = 8;

/** 1. in-flight ladder cards whose turn has come, 2. due reviews / waiting half-learned cards (oldest first;
 *  reviews first while the ladder is full), 3. with nothing due: the in-flight card whose turn comes next. */
function pick(ahead = false) {
  const now = nowS();
  const c = (id) => cards.get(id);
  const all = playable();
  const ids = all.filter((id) => id !== previous);
  const learning = (id) => c(id).level < GRADUATE;
  const inFlight = (id) => learning(id) && c(id).reps > 0 && now - c(id).last < SESSION;
  const flying = all.filter(inFlight).length;
  const byIter = (a, b) => c(a).dueIter - c(b).dueIter, byDue = (a, b) => c(a).due - c(b).due;
  const turn = ids.filter((id) => inFlight(id) && c(id).dueIter <= iter).sort(byIter);
  const reviews = ids.filter((id) => !learning(id) && c(id).due <= now).sort(byDue);
  const waiting = ids.filter((id) => learning(id) && !inFlight(id) && !unseen(id)).sort(byDue);
  // new words from the queue, in queue order, only while there is capacity (newWordCapacity)
  const cap = newWordCapacity();
  // book look-ahead and tapped words first (together, in queue order); Lexique frequency words only after them
  const tier = (id) => (byId.get(id).source === "freq" ? 1 : 0);
  const byRank = (a, b) => tier(a) - tier(b) || (byId.get(a).rank ?? 1e9) - (byId.get(b).rank ?? 1e9);
  const fresh = cap.okAnyPace ? ids.filter(unseen).sort(byRank) : [];
  const fill = flying >= FLIGHT ? [...reviews, ...waiting] : [...reviews, ...waiting].sort(byDue);
  const soonest = ids.filter(inFlight).sort(byIter);
  return turn[0] ?? (cap.ok ? fresh[0] : null) ?? fill[0] ?? soonest[0] ?? fresh[0]
    ?? (ahead ? ids.filter((id) => !unseen(id)).sort(byDue)[0] : null)
    ?? (all.includes(previous) && (learning(previous) || c(previous).due <= now) ? previous : null);
}

function next(ahead = false) {
  renderCounts();
  renderStages();
  const id = pick(ahead);
  if (!id) { finished(); return; }
  current = id;
  phase = "ask";
  missed = false;
  renderCard();
}

function finished() {
  current = null;
  const ids = playable();
  const upcoming = ids.map((id) => cards.get(id).due).filter((d) => d > nowS()).sort((a, b) => a - b)[0];
  $("done-text").textContent = !ids.length
    ? "No sentences yet. Run tools/make_sentences.py and push french-data."
    : `Nothing due among the ${ids.length} cards with sentences.` + (upcoming ? ` Next one due ${new Date(upcoming * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : "");
  show("done");
}

// ---------- card ----------

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let target = "";

function renderCard() {
  const w = byId.get(current), s = sentences[current], c = cards.get(current);
  const sent = s.sentences[c.reps % s.sentences.length];
  const re = new RegExp(`(?<![\\p{L}])${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu");
  const m = re.exec(sent.fr);
  const before = m ? sent.fr.slice(0, m.index) : sent.fr + " ", after = m ? sent.fr.slice(m.index + m[0].length) : "";
  target = m ? m[0] : w.word;
  $("sentence").innerHTML = `${esc(before)}<span class="solution" id="solution" hidden></span><input class="gap" id="gap" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Missing word">${esc(after)}`;
  fitGap();
  $("gap").addEventListener("input", fitGap);
  // German translation with the target's translation marked [[...]] (older entries: plain English)
  // split German forms are marked in parts: [[werde]] ... [[haben]]
  $("translation").innerHTML = sent.de ? esc(sent.de).replace(/\[\[(.+?)\]\]/g, "<mark>$1</mark>") : esc(sent.en || "");
  const more = (s.meanings ?? []).filter(Boolean);
  $("meanings").textContent = more.length ? `auch: ${more.join(", ")}` : "";
  renderStage();
  $("pos").textContent = "";
  feedback("", "");
  $("related").innerHTML = "";
  $("next").textContent = "Check";
  $("reveal").hidden = false;
  show("trainer");
  $("gap").focus();
}

/** Stage tag; in the learning ladder with one pip per correct answer (5 = learned). */
function renderStage() {
  const c = cards.get(current), st = stageOf(c);
  const pips = st === "learning" || st === "new"
    ? " " + "●".repeat(c.level) + "○".repeat(GRADUATE - c.level) : "";
  $("stage").textContent = st + pips;
  $("stage").style.color = `var(--st-${st})`;
}

/** The gap is as wide as the answer or what's typed, whichever is longer (in the gap's own font). */
function fitGap() {
  const gap = $("gap");
  if (!gap) return;
  gap.style.width = `${Math.max(target.length, gap.value.length, 3) + 1.5}ch`;
}

function record(ok) {
  const t = nowS();
  (progress.log[current] ??= []).push([t, ok ? 1 : 0]);
  answer(cards.get(current), ok, t, iter++);
  saveSoon();
  renderCounts();
}

function check(revealed = false) {
  const gap = $("gap");
  if (phase === "shown") { previous = current; next(); return; }
  const typed = gap.value;
  // retyping after a miss: empty Enter does nothing; this attempt never counts for the ladder
  if (phase === "retype" && !typed.trim()) { gap.focus(); return; }
  const g = revealed || !typed.trim() ? "wrong" : grade(typed, target);   // empty Enter = a miss

  if (phase === "ask") record(g === "ok");

  if (g === "ok") {
    phase = "shown";
    gap.classList.remove("bad");
    gap.classList.add("good");
    gap.readOnly = true;
    $("solution").hidden = true;
    const c = cards.get(current);
    const goalNow = !missed && doneToday() === goal() ? " · Daily goal reached!" : "";
    feedback((missed ? ""
      : c.level < GRADUATE ? `Correct · ${c.level}/${GRADUATE} · again in ${LADDER[c.level]} cards`
      : `Correct · next in ${until(c.due)}`) + goalNow, "good");
    afterAnswer();
    return;
  }
  // wrong, empty or accents: show the word, type it once correctly
  phase = "retype";
  missed = true;
  $("solution").textContent = target + " ";
  $("solution").hidden = false;
  gap.value = "";
  fitGap();
  gap.classList.add("bad");
  feedback(g === "accent" ? "Accents" : "", "bad");
  $("reveal").hidden = true;
  renderStage();
  gap.focus();
}

function until(due) {
  const s = due - nowS();
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

function afterAnswer() {
  const s = sentences[current];
  $("pos").textContent = [s.lemma, s.pos, s.gender].filter(Boolean).join(" · ") + (s.gloss ? ` — ${s.gloss}` : "");
  // linked cards: same lemma (word family / other forms)
  const rel = (byLemma.get((s.lemma || "").toLowerCase()) ?? []).filter((id) => id !== current).slice(0, 8);
  $("related").innerHTML = rel.map((id) => {
    const st = stage(id);
    return `<span class="chip" title="${st}"><i style="background:var(--st-${st})"></i>${esc(byId.get(id)?.word ?? "")}</span>`;
  }).join("");
  renderStage();
  $("next").textContent = "Next";
  $("reveal").hidden = true;
  renderStages();
  $("next").focus();
}

function feedback(text, cls) { const f = $("feedback"); f.textContent = text; f.className = `feedback ${cls}`; }

// ---------- overview ----------

function renderCounts() {
  const now = nowS();
  let learning = 0, due = 0;
  for (const id of playable()) {
    const c = cards.get(id);
    if (!c.reps) continue;   // queued new word
    if (c.level < GRADUATE && c.ok) learning++;
    else if (c.due <= now) due++;
  }
  const n = doneToday(), g = goal();
  $("counts").textContent = words.length ? `${learning} learning · ${due} due · ${n}/${g} today` : "";
  $("session-fill").style.width = `${Math.min(100, (100 * n) / g)}%`;
  $("session-fill").parentElement.classList.toggle("reached", n >= g);
}

function renderStages() {
  const n = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const w of words) n[stage(w.id)]++;
  const total = words.length || 1;
  $("stage-bar").innerHTML = STAGES.map((s) => `<span style="width:${(100 * n[s]) / total}%;background:var(--st-${s})" title="${s} ${n[s]}"></span>`).join("");
  $("stage-legend").innerHTML = STAGES.map((s) => `<span><i style="background:var(--st-${s})"></i>${s} ${n[s]}</span>`).join("")
    + `<span>sentences ${Object.keys(sentences).length}/${words.length}</span>`;
}

// ---------- word list: every card with its status, sortable ----------

const STATUS = ["queued", ...STAGES];   // queued = new word waiting in extra_words.json, not seen yet
const statusOf = (id) => (unseen(id) && byId.get(id)?.extra ? "queued" : stage(id));
const stColor = (st) => `var(--st-${st === "queued" ? "new" : st})`;
const wl = { sort: LS.get("ft.wlSort", "status"), rev: false, filter: new Set(), q: "" };
const WL_MAX = 600;

function ago(t) {
  const s = nowS() - t;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function wordRows() {
  return words.map((w) => {
    const c = cards.get(w.id), s = sentences[w.id] ?? {}, st = statusOf(w.id);
    let when;
    if (st === "queued") when = `queue #${w.rank ?? "?"}`;
    else if (!s.sentences?.length) when = "no sentence yet";
    else if (!c.reps) when = "not practiced";
    else if (c.level < GRADUATE) when = c.dueIter <= iter ? "due now" : `in ${c.dueIter - iter} cards`;
    else when = c.due <= nowS() ? "due now" : `in ${until(c.due)}`;
    return { w: w.word, gloss: s.gloss ?? "", lemma: s.lemma ?? "", st, c, fails: c.reps - c.ok, when,
      playable: !!s.sentences?.length, rank: w.rank ?? 1e9 };
  });
}

function openWords() {
  $("wl-sort").value = wl.sort;
  renderWords();
  show("words");
}

function renderWords() {
  const all = wordRows();
  const n = Object.fromEntries(STATUS.map((s) => [s, 0]));
  for (const r of all) n[r.st]++;
  $("wl-filter").innerHTML = STATUS.filter((s) => n[s]).map((s) =>
    `<button type="button" class="chip${wl.filter.has(s) ? " on" : ""}" data-st="${s}" aria-pressed="${wl.filter.has(s)}">`
    + `<i style="background:${stColor(s)}"></i>${s} ${n[s]}</button>`).join("");
  const q = wl.q.trim().toLowerCase();
  const rows = all.filter((r) => (!wl.filter.size || wl.filter.has(r.st))
    && (!q || r.w.toLowerCase().includes(q) || r.gloss.toLowerCase().includes(q) || r.lemma.toLowerCase().includes(q)));
  const alpha = (a, b) => a.w.localeCompare(b.w, "fr");
  // weakest first: never right, then the ladder by level, then long term by stability; queued words last
  const strength = (r) => r.st === "queued" ? 99 : r.st === "new" ? 0 : r.st === "learning" ? 1 + r.c.level / 10 : 2 + r.c.s / 1000;
  const due = (r) => r.st === "queued" || !r.c.reps ? Infinity : r.c.level < GRADUATE ? nowS() + (r.c.dueIter - iter) : r.c.due;
  const rate = (r) => (r.c.reps ? r.fails / r.c.reps : 0);
  rows.sort({
    status: (a, b) => b.playable - a.playable || strength(a) - strength(b) || b.fails - a.fails || alpha(a, b),
    alpha,
    due: (a, b) => b.playable - a.playable || due(a) - due(b) || alpha(a, b),
    missed: (a, b) => b.fails - a.fails || rate(b) - rate(a) || alpha(a, b),
    recent: (a, b) => b.c.last - a.c.last || alpha(a, b),
    queue: (a, b) => (a.st === "queued" ? 0 : 1) - (b.st === "queued" ? 0 : 1) || a.rank - b.rank || alpha(a, b),
  }[wl.sort] ?? alpha);
  if (wl.rev) rows.reverse();
  $("wl-dir").textContent = wl.rev ? "↑" : "↓";
  $("wl-count").textContent = rows.length === all.length ? `· ${all.length}` : `· ${rows.length} of ${all.length}`;
  const info = (r) => wl.sort === "recent" ? (r.c.reps ? ago(r.c.last) : "never")
    : wl.sort === "missed" ? `missed ${r.fails}×` : r.when;
  $("wl-list").innerHTML = rows.slice(0, WL_MAX).map((r) => {
    const col = stColor(r.st);
    const pips = r.st === "learning" || (r.st === "new" && r.c.reps)
      ? ` <span class="wl-pips">${"●".repeat(r.c.level)}${"○".repeat(GRADUATE - r.c.level)}</span>` : "";
    const tip = `${r.c.reps} answers, ${r.c.ok} right first try` + (r.c.reps ? `, last ${ago(r.c.last)}` : "")
      + (r.c.level >= GRADUATE ? `, stability ${r.c.s.toFixed(1)} days` : "") + (r.playable ? "" : " · no sentence yet, not in practice");
    return `<div class="wl-row${r.playable ? "" : " off"}" title="${esc(tip)}"><i style="background:${col}"></i>`
      + `<div class="wl-main"><span class="wl-word">${esc(r.w)}</span><span class="wl-gloss">${esc(r.gloss)}</span></div>`
      + `<div class="wl-side"><span class="wl-st" style="color:${col}">${r.st}${pips}</span>`
      + `<span class="wl-when">${esc(info(r))}${r.c.reps ? ` · ${r.c.ok}/${r.c.reps} right` : ""}</span></div></div>`;
  }).join("")
    + (rows.length > WL_MAX ? `<p class="dim small">First ${WL_MAX} of ${rows.length}: search or filter to narrow down.</p>` : "")
    + (!rows.length ? `<p class="dim small">No words match.</p>` : "");
}

$("wl-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-st]");
  if (!b) return;
  if (wl.filter.has(b.dataset.st)) wl.filter.delete(b.dataset.st); else wl.filter.add(b.dataset.st);
  renderWords();
});
$("wl-sort").addEventListener("change", (e) => { wl.sort = e.target.value; wl.rev = false; LS.set("ft.wlSort", wl.sort); renderWords(); });
$("wl-dir").addEventListener("click", () => { wl.rev = !wl.rev; renderWords(); });
$("wl-search").addEventListener("input", (e) => { wl.q = e.target.value; renderWords(); });

// ---------- ui ----------

function show(id) {
  for (const s of ["setup", "loading", "home", "trainer", "done", "library", "reader", "words"]) $(s).hidden = s !== id;
  if (id !== "reader") $("sheet").hidden = true;
  document.querySelector(".stages").hidden = id === "reader" || id === "library" || id === "words";
}
function error(msg) { $("error").textContent = msg; $("error").hidden = !msg; }

$("answer-form").addEventListener("submit", (e) => { e.preventDefault(); check(); });
$("next").addEventListener("click", () => check());
$("reveal").addEventListener("click", () => check(true));
$("ahead").addEventListener("click", () => next(true));
$("practice").addEventListener("click", () => next());
$("read").addEventListener("click", () => openLibrary());
$("words-btn").addEventListener("click", () => openWords());
$("wl-home").addEventListener("click", () => home());
const toHome = () => { if (words.length) { if (saveTimer) saveNow(); home(); } };
for (const b of ["to-home", "done-home", "logo-home"]) $(b).addEventListener("click", toHome);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && phase === "shown" && !$("settings").open && current) { e.preventDefault(); check(); }
});
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveNow(); });

// settings
const dlg = $("settings"), form = $("settings-form");
function openSettings() {
  const { repo, token } = config();
  form.repo.value = repo || "nicolasstephan/french-data";
  form.token.value = token;
  form.goal.value = goal();
  form.newmax.value = maxNew();
  form.readgoal.value = readPages();
  $("theme-mode").value = getThemeMode();
  $("style-mode").innerHTML = STYLES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  $("style-mode").value = getStyle();
  dlg.showModal();
}
$("settings-open").addEventListener("click", openSettings);
$("setup-open").addEventListener("click", openSettings);
$("settings-cancel").addEventListener("click", () => dlg.close());
$("theme-mode").addEventListener("change", (e) => setThemeMode(e.target.value));
$("style-mode").addEventListener("change", (e) => setStyle(e.target.value));
form.addEventListener("submit", () => {
  const repo = form.repo.value.trim(), token = form.token.value.trim();
  const nm = Math.round(Number(form.newmax.value));
  if (form.newmax.value !== "" && nm >= 0 && nm !== maxNew()) {
    progress.maxNew = nm;
    progress.maxNewSet = nowS();
    saveSoon(500);
  }
  const g = Math.round(Number(form.goal.value));
  if (g >= 1 && g !== goal()) {
    progress.goal = g;
    progress.goalSet = nowS();
    saveSoon(500);
  }
  const rp = Math.round(Number(form.readgoal.value) * 2) / 2;   // half pages allowed
  if (form.readgoal.value !== "" && rp >= 0 && rp !== readPages()) {
    progress.reading.pages = rp;
    progress.reading.goalSet = nowS();
    saveSoon(500);
  }
  error("");
  if (repo !== config().repo || token !== config().token || !words.length) {
    LS.set("ft.repo", repo);
    LS.set("ft.token", token);
    loadData();
  } else if (!$("reader").hidden || !$("library").hidden) { /* stay in the book */ }
  else if (!current) home();
  else renderCounts();
});
$("disconnect").addEventListener("click", () => {
  LS.del("ft.token"); LS.del("ft.cache");
  dlg.close();
  words = []; sentences = {}; progressStore = null;
  renderCounts(); renderStages(); show("setup");
});

// ---------- books ----------

/** A file from the data repo (books/...): GitHub (or ../french-data locally), with an offline copy in Cache Storage. */
async function fetchFile(path) {
  const cacheKey = `https://french-trainer.cache/${path}`;
  const cache = typeof caches === "undefined" ? null : await caches.open("ft-books").catch(() => null);
  try {
    let doc;
    if (LOCAL) {
      const r = await fetch(`../french-data/${path}`, { cache: "no-store" });
      doc = r.ok ? await r.json() : null;
    } else {
      const { repo, token } = config();
      doc = await new GitHubStore({ repo, token, path }).loadRaw();
    }
    if (doc && cache) cache.put(cacheKey, new Response(JSON.stringify(doc))).catch(() => {});
    return doc;
  } catch (e) {
    const hit = await cache?.match(cacheKey);
    if (hit) return hit.json();
    throw e;
  }
}

/** Your own card for a word form in a book (or its lemma): word, stage and German gloss. */
function ownCard(k, lemma) {
  let id = byForm.get(k);
  if (!id && lemma) id = byForm.get(formKey(lemma)) ?? byLemma.get(formKey(lemma))?.[0];
  if (!id) id = byLemma.get(k)?.[0];
  if (!id || !cards.has(id)) return null;
  const s = sentences[id];
  return { word: byId.get(id)?.word ?? k, stage: stage(id), gloss: s?.gloss ?? "", meanings: s?.meanings ?? [] };
}

initReader({
  getReading: () => progress.reading,
  save: () => saveSoon(),
  readToday,
  fetchFile,
  ownCard,
  show,
  toHome,
});

if (LOCAL) window.__ft = { get target() { return target; }, get iter() { return iter; }, get card() { return cards.get(current); } };

checkForUpdate();
loadData();
