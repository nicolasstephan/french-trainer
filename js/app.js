// French Trainer: cloze cards from the private data repo (words.json + sentences.json), progress in progress.json.
// Scheduling: js/srs.js (learning ladder + FSRS). Card state is rebuilt from answer logs:
// the Lingvist history (words.json) + this app's answers (progress.json, v2: log per card).
import { GitHubStore } from "./github-store.js";
import { STYLES, getStyle, setStyle, getThemeMode, setThemeMode } from "./theme.js";
import { checkForUpdate } from "./update-check.js";
import { STAGES, GRADUATE, LADDER, stageOf, replayAll, answer, grade } from "./srs.js";

const $ = (id) => document.getElementById(id);
const LS = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: session only */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};
const nowS = () => Math.floor(Date.now() / 1000);

let words = [];            // words.json entries (with Lingvist history)
let sentences = {};        // id -> { lemma, pos, gender, gloss, meanings, sentences: [{fr, de, hint}] }
let progress = { version: 2, log: {}, days: {} };   // log: id -> [[unix s, ok], ...] answers given in this app
let cards = new Map();     // id -> scheduler state (replayed)
let iter = 0;              // answers given so far (all cards): the ladder's clock
let byId = new Map(), byLemma = new Map();
let progressStore = null, saveTimer = null;
let current = null, previous = null, phase = "ask", missed = false;   // ask -> (retype) -> shown

// ---------- data ----------

function config() { return { repo: LS.get("ft.repo", ""), token: LS.get("ft.token", "") }; }

// local development: http://127.0.0.1:<port>/French%20Trainer/?local reads ../french-data directly (progress stays in this browser)
const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && new URLSearchParams(location.search).has("local");

async function loadData() {
  if (LOCAL) {
    const get = async (f) => { const r = await fetch(`../french-data/${f}`, { cache: "no-store" }); return r.ok ? r.json() : null; };
    words = (await get("words.json"))?.words ?? [];
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
    const [w, s, p] = await Promise.all([store("words.json").loadRaw(), store("sentences.json").loadRaw(), progressStore.load()]);
    words = w?.words ?? [];
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

/** Remote + local progress: union of the answer logs (v1 files from the first version had no log and are dropped). */
function mergeProgress(...srcs) {
  const out = { version: 2, log: {}, days: {} };
  for (const src of srcs) {
    if (!src) continue;
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
  for (const [id, s] of Object.entries(sentences)) {
    const key = (s.lemma || "").toLowerCase();
    if (!key) continue;
    if (!byLemma.has(key)) byLemma.set(key, []);
    byLemma.get(key).push(id);
  }
  ({ cards, iter } = replayAll(Object.fromEntries(words.map((w) => [w.id, [...(w.history ?? []), ...(progress.log[w.id] ?? [])]]))));
  next();
}

const stage = (id) => stageOf(cards.get(id));
const today = () => new Date().toISOString().slice(0, 10);

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
  const waiting = ids.filter((id) => learning(id) && !inFlight(id)).sort(byDue);
  const fill = flying >= FLIGHT ? [...reviews, ...waiting] : [...reviews, ...waiting].sort(byDue);
  const soonest = ids.filter(inFlight).sort(byIter);
  return turn[0] ?? fill[0] ?? soonest[0]
    ?? (ahead ? ids.sort(byDue)[0] : null)
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
  $("hint").textContent = sent.hint || s.gloss || "";
  // German translation with the target's translation marked [[...]] (older entries: plain English)
  $("translation").innerHTML = sent.de ? esc(sent.de).replace(/\[\[(.+?)\]\]/, "<mark>$1</mark>") : esc(sent.en || "");
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
  progress.days[today()] = (progress.days[today()] ?? 0) + 1;
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
    feedback(missed ? "Now you have it. (doesn't count)"
      : c.level < GRADUATE ? `Correct · ${c.level}/${GRADUATE} · again in ${LADDER[c.level]} cards`
      : `Correct · next in ${until(c.due)}`, "good");
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
  feedback(g === "accent" ? "Watch the accents. Type it once more." : "Type it once more.", "bad");
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
    if (c.level < GRADUATE && c.ok) learning++;
    else if (c.due <= now) due++;
  }
  $("counts").textContent = words.length ? `${learning} learning · ${due} due · ${progress.days[today()] ?? 0} today` : "";
}

function renderStages() {
  const n = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const w of words) n[stage(w.id)]++;
  const total = words.length || 1;
  $("stage-bar").innerHTML = STAGES.map((s) => `<span style="width:${(100 * n[s]) / total}%;background:var(--st-${s})" title="${s} ${n[s]}"></span>`).join("");
  $("stage-legend").innerHTML = STAGES.map((s) => `<span><i style="background:var(--st-${s})"></i>${s} ${n[s]}</span>`).join("")
    + `<span>sentences ${Object.keys(sentences).length}/${words.length}</span>`;
}

// ---------- ui ----------

function show(id) {
  for (const s of ["setup", "loading", "trainer", "done"]) $(s).hidden = s !== id;
}
function error(msg) { $("error").textContent = msg; $("error").hidden = !msg; }

$("answer-form").addEventListener("submit", (e) => { e.preventDefault(); check(); });
$("next").addEventListener("click", () => check());
$("reveal").addEventListener("click", () => check(true));
$("ahead").addEventListener("click", () => next(true));
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
  LS.set("ft.repo", form.repo.value.trim());
  LS.set("ft.token", form.token.value.trim());
  error("");
  loadData();
});
$("disconnect").addEventListener("click", () => {
  LS.del("ft.token"); LS.del("ft.cache");
  dlg.close();
  words = []; sentences = {}; progressStore = null;
  renderCounts(); renderStages(); show("setup");
});

if (LOCAL) window.__ft = { get target() { return target; }, get iter() { return iter; }, get card() { return cards.get(current); } };

checkForUpdate();
loadData();
