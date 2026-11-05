// French Trainer: cloze cards from the private data repo (words.json + sentences.json), progress in progress.json.
import { GitHubStore } from "./github-store.js";
import { STYLES, getStyle, setStyle, getThemeMode, setThemeMode } from "./theme.js";
import { checkForUpdate } from "./update-check.js";
import { STAGES, stageOf, seed, review, grade } from "./srs.js";

const $ = (id) => document.getElementById(id);
const LS = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: session only */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

let words = [];            // words.json entries
let sentences = {};        // id -> { lemma, pos, gender, gloss, sentences: [{fr, en, hint}] }
let progress = { version: 1, cards: {}, days: {} };   // cards: id -> state (only cards reviewed in this app)
let byId = new Map(), byLemma = new Map();
let progressStore = null, saveTimer = null;
let queue = [], current = null, phase = "ask";        // ask -> (retype) -> shown

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
    index(); buildQueue(); next();
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
  index();
  buildQueue();
  next();
}

/** Remote and local progress: per card the more recent review wins. */
function mergeProgress(remote, local) {
  const out = { version: 1, cards: {}, days: {} };
  for (const src of [remote, local]) {
    if (!src) continue;
    for (const [id, st] of Object.entries(src.cards ?? {})) {
      if (!out.cards[id] || st.last > out.cards[id].last) out.cards[id] = st;
    }
    for (const [d, n] of Object.entries(src.days ?? {})) out.days[d] = Math.max(out.days[d] ?? 0, n);
  }
  return out;
}

function index() {
  byId = new Map(words.map((w) => [w.id, w]));
  byLemma = new Map();
  for (const [id, s] of Object.entries(sentences)) {
    const key = (s.lemma || "").toLowerCase();
    if (!key) continue;
    if (!byLemma.has(key)) byLemma.set(key, []);
    byLemma.get(key).push(id);
  }
}

const stateOf = (id) => progress.cards[id] ?? seed(byId.get(id) ?? {});
// cards not yet reviewed here keep the stage from the Lingvist import
const stage = (id) => progress.cards[id] ? stageOf(progress.cards[id]) : (byId.get(id)?.stage ?? "new");
const today = () => new Date().toISOString().slice(0, 10);

function saveSoon(delay = 4000) {
  progress.updated = new Date().toISOString();
  LS.set("ft.progress", progress);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!progressStore) return;
  try { await progressStore.save(progress, "Progress"); error(""); }
  catch (e) { error(`Not synced: ${e.message}`); }
}

// ---------- queue ----------

function playable() { return words.filter((w) => sentences[w.id]?.sentences?.length); }

function buildQueue(ahead = 0) {
  const now = Date.now();
  const cards = playable().map((w) => ({ id: w.id, due: stateOf(w.id).due }));
  let pick = cards.filter((c) => c.due <= now);
  if (!pick.length && ahead) pick = cards.sort((a, b) => a.due - b.due).slice(0, ahead);
  pick.sort((a, b) => a.due - b.due);
  queue = pick.map((c) => c.id);
}

function next() {
  if (!queue.length) buildQueue();
  renderCounts();
  renderStages();
  if (!queue.length) { finished(); return; }
  current = queue.shift();
  phase = "ask";
  renderCard();
}

function finished() {
  current = null;
  const upcoming = playable().map((w) => stateOf(w.id).due).filter((d) => d > Date.now()).sort((a, b) => a - b)[0];
  const n = playable().length;
  $("done-text").textContent = !n
    ? "No sentences yet. Run tools/make_sentences.py and push french-data."
    : `All ${n} cards with sentences are done for now.` + (upcoming ? ` Next one due ${new Date(upcoming).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : "");
  show("done");
}

// ---------- card ----------

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function renderCard() {
  const w = byId.get(current), s = sentences[current], st = stateOf(current);
  const sent = s.sentences[st.reps % s.sentences.length];
  const re = new RegExp(`(?<![\\p{L}])${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu");
  const m = re.exec(sent.fr);
  const before = m ? sent.fr.slice(0, m.index) : sent.fr + " ", after = m ? sent.fr.slice(m.index + m[0].length) : "";
  current = w.id;
  current_target = m ? m[0] : w.word;
  const width = Math.max(current_target.length, 3) + 1;
  $("sentence").innerHTML = `${esc(before)}<span class="solution" id="solution" hidden></span><input class="gap" id="gap" style="width:${width}ch" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Missing word">${esc(after)}`;
  $("hint").textContent = sent.hint || s.gloss || "";
  $("translation").textContent = sent.en || "";
  const st_ = stage(current);
  $("stage").textContent = st_;
  $("stage").style.color = `var(--st-${st_})`;
  $("pos").textContent = "";
  feedback("", "");
  $("related").innerHTML = "";
  $("next").textContent = "Check";
  $("reveal").hidden = false;
  show("trainer");
  $("gap").focus();
}
let current_target = "";

function check(revealed = false) {
  const gap = $("gap");
  const typed = gap.value;
  if (phase === "shown") { next(); return; }
  if (!revealed && !typed.trim()) { gap.focus(); return; }
  const g = revealed ? "wrong" : grade(typed, current_target);

  if (phase === "ask") {
    const st = review(stateOf(current), g === "ok");
    progress.cards[current] = st;
    progress.days[today()] = (progress.days[today()] ?? 0) + 1;
    saveSoon();
    if (g !== "ok") queue.splice(Math.min(3, queue.length), 0, current);  // back in this session
    renderCounts();
  }

  if (g === "ok") {
    phase = "shown";
    gap.classList.remove("bad");
    gap.classList.add("good");
    gap.readOnly = true;
    $("solution").hidden = true;
    feedback(phaseWasRetype ? "Now you have it." : "Correct", "good");
    afterAnswer();
    return;
  }
  // wrong or accents: show the word, type it once correctly
  phase = "retype";
  phaseWasRetype = true;
  $("solution").textContent = current_target + " ";
  $("solution").hidden = false;
  gap.value = "";
  gap.classList.add("bad");
  feedback(g === "accent" ? "Watch the accents. Type it once more." : "Type it once more.", "bad");
  $("reveal").hidden = true;
  gap.focus();
}
let phaseWasRetype = false;

function afterAnswer() {
  phaseWasRetype = false;
  const s = sentences[current];
  $("pos").textContent = [s.lemma, s.pos, s.gender].filter(Boolean).join(" · ") + (s.gloss ? ` — ${s.gloss}` : "");
  // linked cards: same lemma (word family / other forms)
  const rel = (byLemma.get((s.lemma || "").toLowerCase()) ?? []).filter((id) => id !== current).slice(0, 8);
  $("related").innerHTML = rel.map((id) => {
    const st = stage(id);
    return `<span class="chip" title="${st}"><i style="background:var(--st-${st})"></i>${esc(byId.get(id)?.word ?? "")}</span>`;
  }).join("");
  $("next").textContent = "Next";
  $("reveal").hidden = true;
  renderCounts();
  renderStages();
  $("next").focus();
}

function feedback(text, cls) { const f = $("feedback"); f.textContent = text; f.className = `feedback ${cls}`; }

// ---------- overview ----------

function renderCounts() {
  const now = Date.now();
  const due = playable().filter((w) => stateOf(w.id).due <= now).length;
  $("counts").textContent = words.length ? `${due} due · ${progress.days[today()] ?? 0} today` : "";
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
$("ahead").addEventListener("click", () => { buildQueue(20); next(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && phase === "shown" && !$("settings").open && current) { e.preventDefault(); next(); }
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

checkForUpdate();
loadData();
