// Ebook reader: books from the private data repo (books/index.json, books/<id>.json, books/<id>.gloss.json,
// made by tools/import_book.py). Pages of about PAGE_WORDS words, never across a chapter; tap a word for its
// German translation (book glossary, else your own card, else a DeepL link). Reading progress lives in
// progress.json under "reading"; a page counts toward the daily reading goal when you turn past it (once).

export const PAGE_WORDS = 220;
export const DEFAULT_READ_PAGES = 3;    // daily reading goal in pages of PAGE_WORDS (counted in words)

// ---------- tokens (same rules as tools/import_book.py) ----------

const TOKEN = /\p{L}+(?:['’]\p{L}+)*(?:-\p{L}+(?:['’]\p{L}+)*)*/gu;
const ELIDED = new Set(["l", "d", "j", "m", "n", "s", "t", "c", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu"]);
const CLITIC = new Set(["je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "le", "la", "les", "lui", "leur",
  "moi", "toi", "y", "en", "ce", "t"]);

/** Word tokens of a text as [start, end] offsets. */
export function tokens(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    let s = m.index, w = m[0];
    for (;;) {   // l'homme -> l' + homme (aujourd'hui, quelqu'un stay whole)
      const e = /^(\p{L}+)['’](?=\p{L})/u.exec(w);
      if (!e || !ELIDED.has(e[1].toLowerCase())) break;
      out.push([s, s + e[0].length]);
      s += e[0].length;
      w = w.slice(e[0].length);
    }
    const parts = w.split("-");   // dit-il -> dit + il, a-t-il -> a + t + il
    let i = parts.length;
    while (i > 1 && CLITIC.has(parts[i - 1].toLowerCase())) i--;
    const head = parts.slice(0, i).join("-");
    out.push([s, s + head.length]);
    let pos = s + head.length;
    for (const p of parts.slice(i)) { pos++; out.push([pos, pos + p.length]); pos += p.length; }
  }
  return out;
}
export const key = (form) => form.toLowerCase().replace(/’/g, "'");
const countWords = (text) => tokens(text).length;

// ---------- reading progress (inside progress.json) ----------

export function emptyReading() { return { log: [], books: {}, looked: {} }; }

/** Union of reading logs; per book the latest position wins and read ranges are merged. */
export function mergeReading(a, b) {
  const out = emptyReading();
  for (const src of [a, b]) {
    if (!src) continue;
    if (src.pages != null && (src.goalSet ?? 0) >= (out.goalSet ?? -1)) { out.pages = src.pages; out.goalSet = src.goalSet ?? 0; }
    if (src.since && (!out.since || src.since < out.since)) out.since = src.since;
    const id = (e) => `${e[0]}|${e[1]}|${e[3] ?? ""}`;   // [unix s, book, words, first paragraph]
    const seen = new Set(out.log.map(id));
    for (const e of src.log ?? []) if (!seen.has(id(e))) { out.log.push(e); seen.add(id(e)); }
    for (const [id, bk] of Object.entries(src.books ?? {})) {
      const o = (out.books[id] ??= { pos: 0, at: 0, read: [] });
      if ((bk.at ?? 0) >= o.at) { o.pos = bk.pos ?? 0; o.at = bk.at ?? 0; }
      o.read = mergeRanges([...o.read, ...(bk.read ?? [])]);
    }
    for (const [k, [n, t]] of Object.entries(src.looked ?? {})) {
      const o = out.looked[k];
      out.looked[k] = o ? [Math.max(o[0], n), Math.max(o[1], t)] : [n, t];
    }
  }
  out.log.sort((x, y) => x[0] - y[0]);
  return out;
}
function mergeRanges(rs) {
  const s = rs.map((r) => [...r]).sort((x, y) => x[0] - y[0]), out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push(r);
  }
  return out;
}
/** Words read per local day, from the reading log. */
export function readingDays(reading, dayKey) {
  const n = {};
  // a 5th element is the day the page was credited to (catching up a past day), else the day it was read
  for (const [t, , w, , day] of reading?.log ?? []) { const k = day ?? dayKey(t); n[k] = (n[k] ?? 0) + w; }
  return n;
}

// ---------- reader ----------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nowS = () => Math.floor(Date.now() / 1000);

let ctx = null;          // { getReading, save, fetchFile, ownCard, show, toHome, onRead }
let library = [], book = null, gloss = {}, pages = [], paraWords = [], page = 0, wordsOf = [];

export function initReader(c) {
  ctx = c;
  $("lib-home").addEventListener("click", () => ctx.toHome());
  $("rd-lib").addEventListener("click", () => { closeSheet(); openLibrary(); });
  $("rd-prev").addEventListener("click", () => turn(-1));
  $("rd-next").addEventListener("click", () => turn(1));
  $("rd-chapter").addEventListener("change", (e) => { closeSheet(); goPara(Number(e.target.value)); });
  $("rd-smaller").addEventListener("click", () => fontSize(-1));
  $("rd-bigger").addEventListener("click", () => fontSize(1));
  $("rd-text").addEventListener("click", onTap);
  $("sheet-close").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if ($("reader").hidden || $("settings").open) return;
    if (e.key === "ArrowRight") turn(1);
    else if (e.key === "ArrowLeft") turn(-1);
    else if (e.key === "Escape") closeSheet();
  });
  // swipe left / right to turn the page (a tap stays a word lookup)
  let t0 = null;
  $("rd-text").addEventListener("touchstart", (e) => { const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY }; }, { passive: true });
  $("rd-text").addEventListener("touchend", (e) => {
    if (!t0) return;
    const t = e.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    t0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50) turn(dx < 0 ? 1 : -1);
  }, { passive: true });
  applyFont();
}

export async function openLibrary() {
  ctx.show("library");
  $("lib-list").innerHTML = `<p class="dim">Loading…</p>`;
  try {
    library = (await ctx.fetchFile("books/index.json"))?.books ?? [];
  } catch (e) {
    $("lib-list").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  const reading = ctx.getReading();
  $("lib-list").innerHTML = library.length ? library.map((b) => {
    const st = reading.books[b.id], done = st ? Math.round((100 * readWords(st.read, b)) / b.words) : 0;
    const cov = b.coverage ? ` · ${Math.round(b.coverage.any)} % of the words in your vocabulary` : "";
    return `<button class="book" data-id="${esc(b.id)}">
      <span class="book-title">${esc(b.title)}</span>
      <span class="dim small">${esc(b.author)} · ${Math.round(b.words / 1000)}k words${cov}</span>
      <span class="goal-bar"><span style="width:${done}%"></span></span>
      <span class="dim small">${st ? `${done} % read` : "Not started"}${b.gloss < b.forms ? ` · glossary ${Math.round((100 * b.gloss) / b.forms)} %` : ""}</span>
    </button>`;
  }).join("") : `<p class="dim">No books yet. Import one: <code>python tools/import_book.py book.epub</code>, then push french-data.</p>`;
  for (const el of $("lib-list").querySelectorAll(".book")) el.addEventListener("click", () => openBook(el.dataset.id));
}
// words read in a book, from its read paragraph ranges (paragraph word counts are only known once it is open)
function readWords(read, b) {
  if (book?.id === b.id) return read.reduce((s, [a, e]) => s + paraWords.slice(a, e).reduce((x, y) => x + y, 0), 0);
  const paras = read.reduce((s, [a, e]) => s + e - a, 0);
  return Math.min(b.words, (paras * b.words) / Math.max(1, b.paras));
}

async function openBook(id) {
  $("lib-list").innerHTML = `<p class="dim">Opening…</p>`;
  try {
    const [b, g] = await Promise.all([ctx.fetchFile(`books/${id}.json`), ctx.fetchFile(`books/${id}.gloss.json`).catch(() => null)]);
    if (!b) throw new Error(`books/${id}.json not found`);
    book = b; gloss = g ?? {};
  } catch (e) {
    $("lib-list").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  book.id = id;
  paraWords = book.paras.map(countWords);
  // pages: greedy runs of paragraphs up to PAGE_WORDS, starting fresh at every chapter
  pages = [];
  const starts = book.chapters.map((c) => c.p);
  book.chapters.forEach((c, ci) => {
    const end = starts[ci + 1] ?? book.paras.length;
    let s = c.p, w = 0;
    for (let p = c.p; p < end; p++) {
      if (w && w + paraWords[p] > PAGE_WORDS) { pages.push({ s, e: p, ch: ci, w }); s = p; w = 0; }
      w += paraWords[p];
    }
    if (s < end) pages.push({ s, e: end, ch: ci, w });
  });
  $("rd-chapter").innerHTML = book.chapters.map((c, i) => `<option value="${c.p}">${esc(shortTitle(c.title, i))}</option>`).join("");
  const st = ctx.getReading().books[id];
  goPara(st?.pos ?? 0, false);
  ctx.show("reader");
}
const shortTitle = (t, i) => (t.length > 60 ? t.slice(0, 57) + "…" : t) || `Teil ${i + 1}`;

function goPara(p, save = true) {
  page = Math.max(0, pages.findIndex((pg) => p >= pg.s && p < pg.e));
  render(save);
}

function render(save = true) {
  const pg = pages[page], reading = ctx.getReading();
  const looked = reading.looked ?? {};
  let html = "";
  if (pg.s === book.chapters[pg.ch].p) html += `<h3 class="rd-ch">${esc(book.chapters[pg.ch].title)}</h3>`;
  for (let p = pg.s; p < pg.e; p++) {
    const text = book.paras[p];
    let out = "", last = 0;
    for (const [a, b] of tokens(text)) {
      const k = key(text.slice(a, b));
      out += esc(text.slice(last, a)) + `<span class="w${looked[k] ? " looked" : ""}" data-p="${p}" data-a="${a}" data-b="${b}">${esc(text.slice(a, b))}</span>`;
      last = b;
    }
    html += `<p>${out}${esc(text.slice(last))}</p>`;
  }
  $("rd-text").innerHTML = html;
  $("rd-chapter").value = String(book.chapters[pg.ch].p);
  $("rd-title").textContent = book.title;
  const before = pages.slice(0, page).reduce((s, x) => s + x.w, 0);
  $("rd-pos").textContent = `${page + 1} / ${pages.length} · ${Math.round((100 * before) / book.words)} %`;
  $("rd-prev").disabled = page === 0;
  $("rd-next").textContent = page === pages.length - 1 ? "Finish" : "Next";
  renderGoal();
  window.scrollTo({ top: 0 });
  if (save) {
    const st = (reading.books[book.id] ??= { pos: 0, at: 0, read: [] });
    st.pos = pg.s; st.at = nowS();
    ctx.save();
  }
}

function renderGoal() {
  const { n, goal } = ctx.readToday();
  $("rd-goal").style.width = goal ? `${Math.min(100, (100 * n) / goal)}%` : "0";
  $("rd-goal").parentElement.classList.toggle("reached", goal > 0 && n >= goal);
  $("rd-goal").parentElement.title = `Reading today: ${(n / PAGE_WORDS).toFixed(1)}${goal ? ` / ${goal / PAGE_WORDS}` : ""} pages (${n} words)`;
}

/** Turning forward past a page marks it read; its new words count for today. */
function turn(dir) {
  closeSheet();
  if (dir > 0) {
    const pg = pages[page], reading = ctx.getReading();
    const st = (reading.books[book.id] ??= { pos: 0, at: 0, read: [] });
    let fresh = 0;
    for (let p = pg.s; p < pg.e; p++) if (!st.read.some(([a, e]) => p >= a && p < e)) fresh += paraWords[p];
    st.read = mergeRanges([...st.read, [pg.s, pg.e]]);
    if (fresh) {
      const before = ctx.readToday();
      const day = ctx.creditDay?.();
      reading.log.push(day ? [nowS(), book.id, fresh, pg.s, day] : [nowS(), book.id, fresh, pg.s]);
      const after = ctx.readToday();
      if (after.goal && before.n < after.goal && after.n >= after.goal) toast("Daily reading goal reached!");
    }
    if (page === pages.length - 1) { ctx.save(); toast("Fin. Book finished."); renderGoal(); return; }
  }
  const np = page + dir;
  if (np < 0 || np >= pages.length) return;
  page = np;
  render();
}

function toast(msg) {
  const t = $("rd-toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

// ---------- word lookup ----------

let tapped = null;

function onTap(e) {
  const w = e.target.closest(".w");
  if (!w) { closeSheet(); return; }
  if (window.getSelection()?.toString()) return;   // selecting text, not tapping
  tapped?.classList.remove("on");
  tapped = w;
  w.classList.add("on");
  const p = Number(w.dataset.p), a = Number(w.dataset.a), b = Number(w.dataset.b);
  const text = book.paras[p], form = text.slice(a, b), k = key(form);
  const g = gloss[k] ?? gloss[k.replace(/'$/, "e")] ?? null;   // l' -> le
  const own = ctx.ownCard(k, g?.[0]);
  const sentence = sentenceAt(text, a, b);
  const reading = ctx.getReading();
  const l = reading.looked[k];
  reading.looked[k] = [(l?.[0] ?? 0) + 1, nowS()];
  w.classList.add("looked");
  ctx.save();

  const lemma = g && g[0] && key(g[0]) !== k ? g[0] : "";
  $("sheet-word").textContent = form;
  $("sheet-lemma").textContent = [lemma, g?.[1]].filter(Boolean).join(" · ");
  $("sheet-gloss").textContent = g?.[2] || own?.gloss || "";
  $("sheet-other").textContent = g?.[3] ? `auch: ${g[3]}` : own?.meanings?.length ? `auch: ${own.meanings.join(", ")}` : "";
  $("sheet-none").hidden = !!(g?.[2] || own?.gloss);
  $("sheet-own").innerHTML = own
    ? `<span class="chip"><i style="background:var(--st-${own.stage})"></i>${esc(own.word)} · ${own.stage}</span>`
    : `<span class="dim small">Not in your cards</span>`;
  $("sheet-sentence").innerHTML = esc(sentence.text.slice(0, sentence.a)) + `<mark>${esc(form)}</mark>` + esc(sentence.text.slice(sentence.a + form.length));
  $("sheet-deepl").href = `https://www.deepl.com/translator#fr/de/${encodeURIComponent(sentence.text)}`;
  $("sheet").hidden = false;
}

function sentenceAt(text, a, b) {
  let s = a, e = b;
  while (s > 0 && !/[.!?…]\s/.test(text.slice(s - 2, s))) s--;
  while (e < text.length && !/[.!?…]/.test(text[e])) e++;
  e = Math.min(text.length, e + 1);
  const raw = text.slice(s, e), lead = raw.length - raw.trimStart().length;
  return { text: raw.trim(), a: a - s - lead };
}

function closeSheet() {
  $("sheet").hidden = true;
  tapped?.classList.remove("on");
  tapped = null;
}

// ---------- font size ----------

const SIZES = [1, 1.1, 1.2, 1.32, 1.45];
const sizeIndex = () => { try { return Number(localStorage.getItem("ft.readerSize") ?? 2); } catch { return 2; } };
function fontSize(d) {
  const i = Math.max(0, Math.min(SIZES.length - 1, sizeIndex() + d));
  try { localStorage.setItem("ft.readerSize", String(i)); } catch { /* blocked */ }
  applyFont();
}
function applyFont() {
  document.documentElement.style.setProperty("--rd-size", `${SIZES[sizeIndex()] ?? 1.2}rem`);
}
