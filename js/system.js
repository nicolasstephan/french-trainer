// How it works (menu → How it works): a diagram of the learning system, like the Landscape Prototype's Pipeline window.
// Boxes = where a word is; arrows = what moves it on. Below: one card per box, plus the card order and grading.
// Keep it true to the code: the numbers come from srs.js and app.js (passed in initSystem); when a rule changes there,
// check the wording here too. Live counts (top right of each box) come from the current card states.
import { LADDER, GRADUATE, RETENTION, stageOf } from "./srs.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const nowS = () => Math.floor(Date.now() / 1000);
const pct = (x) => `${Math.round(x * 100)} %`;

let ctx = null;   // accessors and rule constants from app.js

export function initSystem(c) {
  ctx = c;
  $("sy-dia").addEventListener("click", (e) => {
    const n = e.target.closest("[data-k]");
    if (n) flash(n.dataset.k);
  });
  $("sy-dia").addEventListener("keydown", (e) => {
    const n = e.target.closest("[data-k]");
    if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); flash(n.dataset.k); }
  });
}

function flash(k) {
  const c = document.querySelector(`.sy-card[data-k="${k}"]`);
  if (!c) return;
  c.scrollIntoView({ block: "nearest", behavior: "smooth" });
  c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash");
}

// ---------- live counts ----------

function counts() {
  const now = nowS(), r = ctx.rules;
  const n = { words: 0, queued: 0, flight: 0, ladder: 0, young: 0, familiar: 0, known: 0, due: 0 };
  const playable = new Set(ctx.playable());
  for (const w of ctx.words()) {
    n.words++;
    const c = ctx.cards().get(w.id);
    if (!c || !playable.has(w.id)) continue;
    if (!c.reps) { n.queued++; continue; }
    if (c.level < GRADUATE) { n.ladder++; if (now - c.last < r.SESSION) n.flight++; continue; }
    n[stageOf(c)]++;
    if (c.due <= now) n.due++;
  }
  return n;
}

// ---------- diagram ----------

const IC = {   // 24 px line icons, currentColor
  src: '<path d="M4 5.5C6.5 4 9.5 4 12 5.5v14C9.5 18 6.5 18 4 19.5zM20 5.5C17.5 4 14.5 4 12 5.5v14c2.5-1.5 5.5-1.5 8 0z"/>',
  run: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  queue: '<rect x="4" y="4" width="16" height="4.5" rx="1"/><rect x="4" y="10" width="16" height="4.5" rx="1" opacity=".7"/><rect x="4" y="16" width="16" height="4.5" rx="1" opacity=".45"/>',
  ladder: '<path d="M4 20h4v-4h4v-4h4V8h4V4"/>',
  long: '<rect x="3.5" y="5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2"/>',
};
const icon = (k, sz) => `<svg x="12" y="12" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${IC[k]}</svg>`;

/** Boxes in viewBox units (W 380, scales with the card); x/y/w/h, kicker, title, count, extra body. */
function nodes(n) {
  const L = LADDER.map((g, i) => {
    const x = 14 + i * 37;
    return `<rect x="${x}" y="50" width="30" height="20" rx="3" class="sy-step"/><text x="${x + 15}" y="64" class="sy-stepn" text-anchor="middle">${i}</text>`
      + `<text x="${x + 15}" y="84" class="sy-small" text-anchor="middle">+${g}</text>`;
  }).join("");
  const bands = [["young", "< 7 d"], ["familiar", "7–30 d"], ["known", "30 d +"]].map(([st, t], i) => {
    const x = 14 + i * 59;
    return `<rect x="${x}" y="50" width="55" height="8" rx="2" style="fill:var(--st-${st})"/>`
      + `<text x="${x}" y="72" class="sy-small sy-strong">${st}</text><text x="${x}" y="85" class="sy-small">${t}</text>`;
  }).join("");
  return [
    { k: "src", x: 10, y: 10, w: 180, h: 64, ic: "src", kick: "Words", t: "Sources", sub: "Lingvist · books · word list", n: n.words },
    { k: "run", x: 236, y: 10, w: 134, h: 64, ic: "run", kick: "Daily 13:00", t: "Daily run", sub: "sentences · ⚑ checks" },
    { k: "queue", x: 10, y: 120, w: 200, h: 72, ic: "queue", kick: "Stage new", t: "New-word queue", sub: "book words first, then common", n: n.queued, dot: "new" },
    { k: "ladder", x: 10, y: 250, w: 200, h: 96, ic: "ladder", kick: `Levels 0–${GRADUATE - 1}`, t: "Learning ladder", n: n.ladder, dot: "learning", body: L },
    { k: "long", x: 10, y: 420, w: 200, h: 96, ic: "long", kick: `Level ${GRADUATE} · FSRS-6`, t: "Long term", n: n.young + n.familiar + n.known, body: bands },
  ];
}

// edges: route points (right angles, never through a box), label, label side for vertical runs
const EDGES = [
  { a: "src", b: "run", pts: [[190, 42], [236, 42]], lbl: "words" },
  { a: "run", b: "queue", pts: [[303, 74], [303, 156], [210, 156]], lbl: "with sentences" },
  { a: "queue", b: "ladder", pts: [[110, 192], [110, 250]], lbl: "new word, when allowed" },
  { a: "queue", b: "long", pts: [[210, 180], [355, 180], [355, 492], [210, 492]], lbl: "right at first sight" },
  { a: "ladder", b: "long", pts: [[110, 346], [110, 420]], lbl: `level ${GRADUATE}, or right after a night` },
  { a: "long", b: "ladder", pts: [[210, 440], [300, 440], [300, 298], [210, 298]], lbl: `miss → level ${GRADUATE - 1}`, miss: 1 },
];

function diagram(n) {
  const W = 380, H = 536;
  let g = "";
  for (const e of EDGES) {
    const d = "M" + e.pts.map((p) => p.join(",")).join(" L");
    let lab = null, best = -1;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      if (y1 === y2 && Math.abs(x2 - x1) > best) { best = Math.abs(x2 - x1); lab = { x: (x1 + x2) / 2, y: y1 - 5, a: "middle" }; }
    }
    if (!lab) { const [x1, y1] = e.pts[0], [, y2] = e.pts[e.pts.length - 1]; lab = { x: x1 + 7, y: (y1 + y2) / 2 + 3, a: "start" }; }
    g += `<path d="${d}" class="sy-edge${e.miss ? " miss" : ""}" marker-end="url(#syArr)"/>`
      + `<text x="${lab.x}" y="${lab.y}" class="sy-elbl" text-anchor="${lab.a}">${esc(e.lbl)}</text>`;
  }
  for (const b of nodes(n)) {
    g += `<g class="sy-node" data-k="${b.k}" transform="translate(${b.x},${b.y})" tabindex="0" role="button" aria-label="${esc(b.t)}: details below">`
      + `<rect width="${b.w}" height="${b.h}" rx="6" class="sy-box"/>${icon(b.ic, 22)}`
      + `<text x="44" y="21" class="sy-kick">${esc(b.kick.toUpperCase())}</text>`
      + `<text x="44" y="38" class="sy-title">${esc(b.t)}</text>`
      + (b.sub ? `<text x="14" y="${b.h - 12}" class="sy-small">${esc(b.sub)}</text>` : "")
      + (b.n != null ? `<text x="${b.w - 10}" y="21" class="sy-count" text-anchor="end">${b.n.toLocaleString()}</text>` : "")
      + (b.dot ? `<circle cx="${b.w - 10 - String(b.n.toLocaleString()).length * 6.4 - 8}" cy="17.5" r="3.5" style="fill:var(--st-${b.dot})"/>` : "")
      + (b.body ?? "") + `</g>`;
  }
  return `<svg id="sy-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="How a word moves through the learning system">`
    + `<defs><marker id="syArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
    + `<path d="M0,1 L9,5 L0,9 z" class="sy-ah"/></marker></defs>${g}</svg>`;
}

// ---------- cards ----------

function cards(n) {
  const r = ctx.rules, gaps = LADDER.join(", ");
  const C = [
    { k: "src", t: "Sources", r: "where your words come from", li: [
      "<b>Lingvist</b>: your cards with their full answer history (Nov 2025 – Nov 2026). The scheduler replays it, so old answers still count.",
      "<b>Reader</b>: words you add with <i>Add to my cards</i>, and the book's words 30 pages ahead of where you read.",
      "<b>Frequency list</b>: common words you have not had yet (<code>tools/add_words.py</code>).",
    ] },
    { k: "run", t: "Daily run", r: "scheduled task, 13:00 and after logon or wake", li: [
      "Adds the reader words to the queue.",
      "Has Opus check and fix sentences you flagged with ⚑.",
      "Writes sentences for new words (Sonnet). A word from a book gets the book's own sentence as its first one (shortened to a full sentence of at most 20 words). A word only enters practice once it has sentences.",
      "Finds alternatives: other words that are also right in a gap.",
      "Keeps the book's translations and glossary 30 pages ahead.",
    ] },
    { k: "queue", t: "New-word queue", r: `${n.queued.toLocaleString()} waiting · book and tapped words first, then by frequency`, li: [
      `Up to <b>${ctx.maxNew()}</b> new words a day (Settings), scaled by your right-first-try rate over the last ${r.RECENT} answers: ${pct(r.ACC_NONE)} or less → none, ${pct(r.ACC_FULL)} or more → all.`,
      `Paused while ${r.STRUGGLE} or more words in flight on the ladder were just missed, ${r.FLIGHT - 2} or more are in flight, or more than ${r.REVIEWS_FIRST} reviews are due.`,
      "Spread over the day's card goal instead of coming in a burst.",
      "Right the very first time you see it: you know it already, so it goes straight to long term.",
    ] },
    { k: "ladder", t: "Learning ladder", r: `${n.ladder.toLocaleString()} words · ${n.flight} in flight now`, li: [
      `<b>Right on the first try</b>: one level up. The word comes back after ${gaps} other cards (levels 0 to ${GRADUATE - 1}).`,
      `<b>Miss</b>: the level stays and the word comes back after ${LADDER[0]} cards. You type it once correctly; that retype does not count.`,
      `<b>In flight</b>: words answered in the last ${r.SESSION / 60} minutes come back by card count, at most ${r.FLIGHT} at a time. Older half-learned words wait with the reviews.`,
      `Moves to long term after the right answer at level ${GRADUATE - 1}, or at once when you get it right after a gap of a day or more (it held overnight).`,
    ] },
    { k: "long", t: "Long term", r: `${(n.young + n.familiar + n.known).toLocaleString()} words · ${n.due.toLocaleString()} due now`, li: [
      "FSRS-6 tracks two numbers per word: <b>stability</b> (days until your recall drops to 90 %) and <b>difficulty</b>.",
      `The next review comes when your predicted recall falls to <b>${pct(RETENTION)}</b>: at least 1 day, at most 365.`,
      "<b>Right</b>: stability grows, so the next gap is longer. A second review on the same day changes little.",
      `<b>Miss</b>: back to ladder level ${GRADUATE - 1}; one right answer brings it back.`,
      "The weights are fitted to your own answers (<code>tools/fit_fsrs.py</code>), so 90 % means 90 % for you.",
      `Stage by stability: <b>young</b> under 7 days (${n.young.toLocaleString()}), <b>familiar</b> 7–30 days (${n.familiar.toLocaleString()}), <b>known</b> 30 days or more (${n.known.toLocaleString()}). Days start at 4:00.`,
    ] },
    { k: "next", t: "Which card comes next", r: "checked in this order before every card", ol: [
      "A word Opus fixed after your ⚑ flag, with the new sentence and Opus's note.",
      "A ladder word whose turn has come.",
      "A new word, if the queue allows one and today's pacing says it is time.",
      `Due reviews and waiting half-learned words, oldest first (reviews first while the ladder is full).`,
      "The ladder word whose turn comes next, a little early.",
      "Nothing left: <i>Nothing due</i>. <i>Practice ahead</i> takes the words due soonest.",
    ], foot: "Never the same card twice in a row, unless it is the only one." },
    { k: "grade", t: "What counts as right", r: "only the first try counts", li: [
      "<b>Right</b>: the word exactly as wanted on the first try.",
      "<b>Miss</b>: anything else, including wrong accents or an empty answer.",
      "<b>Also right</b>: another word that fits the gap is not a miss. The gap clears and you try again.",
      "Each time the card shows another of the word's sentences.",
      "Card states are never stored: they are rebuilt from your answer log on every load, so a rule change reschedules every word.",
    ] },
  ];
  return C.map((c) => `<div class="sy-card" data-k="${c.k}"><div class="sy-ct">${esc(c.t)}</div><div class="sy-cr">${esc(c.r)}</div>`
    + (c.li ? `<ul>${c.li.map((x) => `<li>${x}</li>`).join("")}</ul>` : `<ol>${c.ol.map((x) => `<li>${x}</li>`).join("")}</ol>`)
    + (c.foot ? `<p class="sy-cr">${esc(c.foot)}</p>` : "") + `</div>`).join("");
}

export function renderSystem() {
  const n = counts();
  $("sy-dia").innerHTML = diagram(n);
  $("sy-body").innerHTML = cards(n);
}
