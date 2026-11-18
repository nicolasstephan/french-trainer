// Stats (menu → Stats): charts of the learning history, built from the same answer logs as the scheduler
// (Lingvist history in words.json + this app's answers in progress.json). Plain SVG; every color is a CSS variable,
// so the charts follow theme and style switches without a redraw. Each chart has a hover/keyboard tooltip and a
// table view. One range filter at the top scopes every chart except the forecast (which looks ahead).
import { STAGES, GRADUATE, blank, answer, stageOf } from "./srs.js";

const $ = (id) => document.getElementById(id);
const nowS = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => Math.round(n).toLocaleString();
const RANGES = {
  30: { days: 30, bin: "day", label: "30 days" },
  90: { days: 91, bin: "week", label: "90 days" },
  365: { days: 364, bin: "week", label: "1 year" },
  all: { days: 0, bin: "month", label: "All" },
};
// stacked bottom → top: the strongest words form the base
const STACK = ["known", "familiar", "young", "learning"];
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };

let ctx = null;          // accessors from app.js
let range = store.get("ft.statsRange", "90");
if (!RANGES[range]) range = "90";

export function initStats(c) {
  ctx = c;
  $("st-filter").innerHTML = Object.entries(RANGES).map(([k, r]) =>
    `<button type="button" class="chip" data-r="${k}" aria-pressed="${k === range}">${r.label}</button>`).join("");
  $("st-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-r]");
    if (!b) return;
    range = b.dataset.r;
    store.set("ft.statsRange", range);
    renderStats();
  });
  let t = null;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (!$("stats").hidden) renderStats(); }, 150); });
}

// ---------- data ----------

const addDays = (k, n) => { const d = new Date(`${k}T12:00`); d.setDate(d.getDate() + n); return ctx.dayKey(d.getTime() / 1000); };
const monday = (k) => { const d = new Date(`${k}T12:00`); return addDays(k, -((d.getDay() + 6) % 7)); };
const label = (k, bin) => bin === "month"
  ? `${new Date(`${k}-15T12:00`).toLocaleDateString([], { month: "short" })} ’${k.slice(2, 4)}`
  :new Date(`${k}T12:00`).toLocaleDateString([], { day: "numeric", month: "short" });

/** Replays every answer in time order: answers per day and the stage counts after each day. */
function history() {
  const log = ctx.progress().log, all = [];
  for (const w of ctx.words()) {
    for (const [t, ok] of w.history ?? []) all.push([t, ok, w.id, null]);
    for (const [t, ok, day] of log[w.id] ?? []) all.push([t, ok, w.id, day ?? null]);
  }
  all.sort((a, b) => a[0] - b[0]);
  const perDay = {}, snaps = [], cards = new Map(), st = new Map();
  const n = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let prev = null;
  all.forEach(([t, ok, id, day], i) => {
    const k = ctx.dayKey(t);
    if (prev && k !== prev) snaps.push([prev, { ...n }]);
    prev = k;
    let c = cards.get(id);
    if (!c) cards.set(id, (c = blank()));
    const review = c.reps > 0 && c.level >= GRADUATE;   // a long-term review (FSRS aims for 90 % here)
    answer(c, !!ok, t, i);
    const s = stageOf(c), o = st.get(id);
    if (o !== s) { if (o) n[o]--; n[s]++; st.set(id, s); }
    // [answers, right first try, long-term reviews, of them right]; a catch-up answer counts for its credited day
    const d = perDay[day ?? k] ??= [0, 0, 0, 0];
    d[0]++;
    if (ok) d[1]++;
    if (review) { d[2]++; if (ok) d[3]++; }
  });
  if (prev) snaps.push([prev, { ...n }]);
  return { perDay, snaps, first: all.length ? ctx.dayKey(all[0][0]) : ctx.dayKey(nowS()) };
}

/** The range cut into bins (days, weeks or months), each with its days. */
function binsFor(first, r) {
  const today = ctx.dayKey(nowS());
  const start = r.days ? addDays(today, -(r.days - 1)) : first;
  const keyOf = (k) => (r.bin === "day" ? k : r.bin === "week" ? monday(k) : k.slice(0, 7));
  const out = [];
  for (let k = start; k <= today; k = addDays(k, 1)) {
    const b = keyOf(k);
    if (out.at(-1)?.key !== b) out.push({ key: b, label: label(b, r.bin), days: [] });
    out.at(-1).days.push(k);
  }
  return out;
}

/** Stage counts at the end of day k (the last snapshot on or before it). */
function stagesAt(snaps, k) {
  let lo = 0, hi = snaps.length - 1, hit = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (snaps[m][0] <= k) { hit = snaps[m][1]; lo = m + 1; } else hi = m - 1; }
  return hit ?? Object.fromEntries(STAGES.map((s) => [s, 0]));
}
const learned = (s) => s.young + s.familiar + s.known;

// ---------- render ----------

export function renderStats() {
  for (const b of $("st-filter").querySelectorAll("[data-r]")) b.setAttribute("aria-pressed", String(b.dataset.r === range));
  const r = RANGES[range], h = history(), bins = binsFor(h.first, r), reads = ctx.readingDays();
  const per = r.bin === "day" ? "day" : r.bin;
  for (const b of bins) {
    b.n = b.ok = b.rn = b.rok = b.read = 0;
    for (const k of b.days) {
      const d = h.perDay[k];
      if (d) { b.n += d[0]; b.ok += d[1]; b.rn += d[2]; b.rok += d[3]; }
      b.read += reads[k] ?? 0;
    }
    b.st = stagesAt(h.snaps, b.days.at(-1));
  }
  const days = bins.flatMap((b) => b.days), firstDay = days[0];

  // tiles
  const total = bins.reduce((a, b) => a + b.n, 0), right = bins.reduce((a, b) => a + b.ok, 0);
  const practiced = days.filter((k) => h.perDay[k]?.[0]).length;
  const nowSt = stagesAt(h.snaps, days.at(-1)), before = stagesAt(h.snaps, addDays(firstDay, -1));
  const grow = learned(nowSt) - learned(before);
  let prevRate = null;
  if (r.days) {
    let pn = 0, pok = 0;
    for (let i = 1; i <= days.length; i++) { const d = h.perDay[addDays(firstDay, -i)]; if (d) { pn += d[0]; pok += d[1]; } }
    if (pn >= 20) prevRate = pok / pn;
  }
  const rate = total ? right / total : null;
  const delta = rate != null && prevRate != null ? Math.round(100 * (rate - prevRate)) : null;
  $("st-tiles").innerHTML = [
    tile("Words learned", fmt(learned(nowSt)), grow ? `${grow > 0 ? "+" : "−"}${fmt(Math.abs(grow))} ${r.days ? `in ${r.label}` : "since the start"}` : "no change"),
    tile("Answers", fmt(total), `${(total / days.length).toFixed(0)} a day on average`),
    tile("Right first try", rate == null ? "–" : `${Math.round(100 * rate)} %`,
      delta == null ? "" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} pts vs the ${r.label} before`),
    tile("Days practiced", `${practiced}`, `of ${days.length}`),
  ].join("");

  // words by stage
  chart($("ch-stage"), {
    kind: "stack", bins,
    series: STACK.map((s) => ({ name: s, color: `var(--st-${s})`, values: bins.map((b) => b.st[s]) })),
    aria: `Words by stage at the end of each ${per}`,
    tip: (i) => `<b>${esc(binTitle(bins[i], r.bin))}</b>` + [...STACK].reverse().map((s) =>
      `<span><i style="background:var(--st-${s})"></i>${s} ${fmt(bins[i].st[s])}</span>`).join("")
      + `<span class="dim">learned ${fmt(learned(bins[i].st))}</span>`,
  });
  $("lg-stage").innerHTML = [...STACK].reverse().map((s) => `<span><i style="background:var(--st-${s})"></i>${s}</span>`).join("");
  table($("tb-stage"), [per, ...[...STACK].reverse(), "learned"],
    bins.map((b) => [binTitle(b, r.bin), ...[...STACK].reverse().map((s) => fmt(b.st[s])), fmt(learned(b.st))]));

  // answers: per day; weeks and months as their daily average, so a week that has just begun is no dip
  const g = ctx.goal(), avg = r.bin !== "day";
  const perDayOf = (b) => b.n / b.days.length;
  $("h-answers").textContent = avg ? `Answers per day, ${r.bin}ly average` : "Answers per day";
  chart($("ch-answers"), {
    kind: "cols", bins, series: [{ name: "answers", color: "var(--data-1)", values: bins.map(perDayOf) }],
    ref: { y: g, label: `goal ${g}` }, endLabel: true,
    aria: $("h-answers").textContent,
    tip: (i) => { const b = bins[i]; return `<b>${esc(binTitle(b, r.bin))}</b>`
      + (avg ? `<span>${fmt(perDayOf(b))} a day</span><span class="dim">${fmt(b.n)} answers in ${b.days.length} days</span>` : `<span>${fmt(b.n)} answers</span>`)
      + (b.n ? `<span class="dim">${Math.round((100 * b.ok) / b.n)} % right first try</span>` : ""); },
  });
  table($("tb-answers"), [per, ...(avg ? ["a day"] : []), "answers", "right first try"],
    bins.map((b) => [binTitle(b, r.bin), ...(avg ? [fmt(perDayOf(b))] : []), fmt(b.n), b.n ? `${Math.round((100 * b.ok) / b.n)} %` : "–"]));

  // first-try rate: long-term reviews (what the scheduler's 90 % is about) and all answers
  // (bins with too few answers are left out: a handful of answers make a meaningless %)
  const MIN = r.bin === "day" ? 10 : 25;
  const pct = (ok, n) => (n >= MIN ? (100 * ok) / n : null);
  const revRates = bins.map((b) => pct(b.rok, b.rn)), allRates = bins.map((b) => pct(b.ok, b.n));
  const lo = Math.min(80, ...[...revRates, ...allRates].filter((x) => x != null));
  const RATE = [{ name: "long-term reviews", color: "var(--data-1)", values: revRates },
    { name: "all answers", color: "var(--data-2)", values: allRates }];
  $("h-rate").textContent = `Right first try, per ${per}`;
  $("lg-rate").innerHTML = RATE.map((s) => `<span><i class="ln" style="background:${s.color}"></i>${s.name}</span>`).join("");
  const p = (v) => (v == null ? "–" : `${Math.round(v)} %`);
  chart($("ch-rate"), {
    kind: "line", bins, series: RATE,
    min: Math.max(0, Math.floor(lo / 10) * 10), max: 100, unit: " %",
    ref: { y: 90, label: "target 90 % (on time)" }, endLabel: true,
    aria: `Share right on the first try per ${per}: long-term reviews and all answers`,
    tip: (i) => { const b = bins[i]; return `<b>${esc(binTitle(b, r.bin))}</b>`
      + `<span><i class="ln" style="background:var(--data-1)"></i>reviews ${p(revRates[i])} <span class="dim">(${fmt(b.rok)}/${fmt(b.rn)})</span></span>`
      + `<span><i class="ln" style="background:var(--data-2)"></i>all ${p(allRates[i])} <span class="dim">(${fmt(b.ok)}/${fmt(b.n)})</span></span>`; },
  });
  table($("tb-rate"), [per, "long-term reviews", "reviews", "all answers", "answers"],
    bins.map((b, i) => [binTitle(b, r.bin), p(revRates[i]), fmt(b.rn), p(allRates[i]), fmt(b.n)]));

  // forecast (always the next 30 days)
  forecast(g);

  // reading (from the first day with reading)
  const firstRead = Object.keys(reads).filter((k) => reads[k] > 0).sort()[0];
  const rb = firstRead ? bins.filter((b) => b.days.at(-1) >= firstRead) : [];
  $("card-read").hidden = !rb.length;
  if (rb.length) {
    const pg = (b) => b.read / ctx.pageWords / b.days.length;   // pages a day (the bin's average)
    $("h-read").textContent = avg ? `Pages read per day, ${r.bin}ly average` : "Pages read per day";
    chart($("ch-read"), {
      kind: "cols", bins: rb, series: [{ name: "pages", color: "var(--data-1)", values: rb.map(pg) }],
      ref: ctx.readPages() ? { y: ctx.readPages(), label: `goal ${ctx.readPages()}` } : null,
      endLabel: true, decimals: 1,
      aria: $("h-read").textContent,
      tip: (i) => `<b>${esc(binTitle(rb[i], r.bin))}</b><span>${pg(rb[i]).toFixed(1)} pages a day</span>`
        + `<span class="dim">${fmt(rb[i].read)} words in ${rb[i].days.length} day${rb[i].days.length > 1 ? "s" : ""}</span>`,
    });
    table($("tb-read"), [per, "pages a day", "words"], rb.map((b) => [binTitle(b, r.bin), pg(b).toFixed(1), fmt(b.read)]));
  }
}

function binTitle(b, bin) {
  if (bin === "day") return new Date(`${b.key}T12:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  if (bin === "week") return `week of ${b.label}`;
  return new Date(`${b.key}-15T12:00`).toLocaleDateString([], { month: "long", year: "numeric" });
}

const tile = (lbl, value, sub) =>
  `<div class="st-tile"><span class="st-lbl">${esc(lbl)}</span><span class="st-val">${esc(value)}</span><span class="st-sub">${esc(sub)}</span></div>`;

/** Long-term cards due per day for the next 30 days, and a rough look at the backlog. */
function forecast(g) {
  const now = nowS(), today = ctx.dayKey(now), N = 30, H = 365;
  const due = new Array(H + 1).fill(0);
  let dueToday = 0;
  for (const c of ctx.cards().values()) {
    if (!c.reps || c.level < GRADUATE) continue;   // ladder cards are due by count, not by date
    if (c.due <= now) { dueToday++; continue; }
    const k = ctx.dayKey(c.due);
    if (k === today) { dueToday++; continue; }
    const d = Math.round((new Date(`${k}T12:00`) - new Date(`${today}T12:00`)) / 86400000);
    if (d <= H) due[d]++;
  }
  // rough: every card of the daily goal spent on reviews; new words and ladder repeats make it slower
  let carry = dueToday, clear = null;
  for (let d = 0; d <= H; d++) { if (d) carry += due[d]; carry -= g; if (carry <= 0) { clear = d; break; } }
  $("st-due").innerHTML = tile("Due today", fmt(dueToday), "long-term reviews, incl. overdue")
    + tile(`At ${g} a day`, clear == null ? "> 1 year" : clear === 0 ? "today" : `${clear} day${clear > 1 ? "s" : ""}`,
      "until nothing is overdue (rough)");
  const bins = Array.from({ length: N }, (_, i) => { const k = addDays(today, i + 1); return { key: k, label: label(k, "day") }; });
  chart($("ch-due"), {
    kind: "cols", bins, series: [{ name: "due", color: "var(--data-1)", values: due.slice(1, N + 1) }],
    ref: { y: g, label: `goal ${g}` },
    aria: "Long-term reviews due per day, next 30 days",
    tip: (i) => `<b>${esc(binTitle(bins[i], "day"))}</b><span>${fmt(due[i + 1])} reviews due</span>`,
  });
  table($("tb-due"), ["day", "reviews due"], bins.map((b, i) => [binTitle(b, "day"), fmt(due[i + 1])]));
}

function table(el, head, rows) {
  el.innerHTML = `<table><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>`
    + rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
}

// ---------- SVG charts: columns, stacked columns, line ----------

/** Clean ticks from 0 (or min) to at least max, 3-5 of them. */
function ticks(min, max) {
  const span = Math.max(max - min, 1), raw = span / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => span / s <= 4) ?? 10 * p;
  const out = [];
  for (let v = Math.floor(min / step) * step; v < max + step - 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const tickFmt = (v) => (v >= 10000 ? `${+(v / 1000).toFixed(1)}K` : v.toLocaleString());

/** Column with a 4px rounded data end, square at the baseline. */
function colPath(x, y, w, h, round) {
  if (h <= 0) return "";
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ""}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ""}V${y + h}Z`;
}

function chart(el, o) {
  const W = Math.max(260, el.clientWidth || 320), H = 180;
  const L = 40, R = o.endLabel ? 34 : 10, T = 14, B = 24, pw = W - L - R, ph = H - T - B;
  const n = o.bins.length, slot = pw / n;
  const totals = o.bins.map((_, i) => o.series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max0 = o.max ?? Math.max(1, ...(o.kind === "stack" ? totals : o.series[0].values.map((v) => v ?? 0)), o.ref?.y ?? 0);
  const tk = ticks(o.min ?? 0, max0), y0 = tk[0], y1 = tk.at(-1);
  const Y = (v) => T + ph - ((v - y0) / (y1 - y0)) * ph;
  const X = (i) => L + slot * (i + 0.5);
  const parts = [];
  // grid + y labels (solid hairlines, recessive)
  for (const v of tk) {
    parts.push(`<line class="ch-grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>`);
    parts.push(`<text class="ch-ax" x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end">${tickFmt(v)}${o.unit && v === y1 ? "%" : ""}</text>`);
  }
  // x labels: first, middle, last
  const xl = n === 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
  for (const i of xl) {
    const anchor = n > 2 && i === 0 ? "start" : n > 2 && i === n - 1 ? "end" : "middle";
    const x = anchor === "start" ? L : anchor === "end" ? W - R : X(i);
    parts.push(`<text class="ch-ax" x="${x}" y="${H - 6}" text-anchor="${anchor}">${esc(o.bins[i].label)}</text>`);
  }
  // marks
  const cw = Math.max(1, Math.min(24, slot - 2));
  if (o.kind === "cols" || o.kind === "stack") {
    o.bins.forEach((_, i) => {
      let base = y0;
      const x = X(i) - cw / 2;
      const segs = o.series.map((s) => ({ s, v: s.values[i] ?? 0 })).filter((p) => p.v > 0);
      segs.forEach(({ s, v }, j) => {
        const top = Y(base + v), bot = Y(base);
        const gap = j > 0 ? 2 : 0;   // 2px surface gap between stacked segments
        parts.push(`<path d="${colPath(x, top, cw, bot - top - gap, j === segs.length - 1)}" style="fill:${s.color}"/>`);
        base += v;
      });
    });
  } else {
    for (const s of o.series) {
      let d = "", pen = false;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      parts.push(`<path class="ch-line" d="${d}" style="stroke:${s.color}"/>`);
      // lone points (no neighbor to draw a line to) get a dot
      s.values.forEach((v, i) => {
        if (v != null && s.values[i - 1] == null && s.values[i + 1] == null) parts.push(`<circle cx="${X(i)}" cy="${Y(v)}" r="4" class="ch-dot" style="fill:${s.color}"/>`);
      });
    }
  }
  // reference line: solid, labeled
  if (o.ref && o.ref.y <= y1 && o.ref.y >= y0) {
    parts.push(`<line class="ch-ref" x1="${L}" x2="${W - R}" y1="${Y(o.ref.y)}" y2="${Y(o.ref.y)}"/>`);
    parts.push(`<text class="ch-ref-t" x="${L + 4}" y="${Y(o.ref.y) - 4}">${esc(o.ref.label)}</text>`);
  }
  // end labels: each series' latest value; a label that would collide with one already placed is left to the tooltip
  if (o.endLabel) {
    const placed = [];
    for (const vals of o.kind === "stack" ? [totals] : o.series.map((s) => s.values)) {
      let i = n - 1;
      while (i >= 0 && vals[i] == null) i--;
      if (i < 0) continue;
      const v = vals[i], y = Math.min(T + ph, Math.max(T + 8, Y(v) + 4));
      if (placed.some((p) => Math.abs(p - y) < 12)) continue;
      placed.push(y);
      const txt = o.unit ? `${Math.round(v)}${o.unit}` : o.decimals ? v.toFixed(o.decimals) : fmt(v);
      parts.push(`<text class="ch-end" x="${W - R + 4}" y="${y}">${esc(txt)}</text>`);
    }
  }
  parts.push(`<line class="ch-cross" id="" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="${esc(o.aria)}. Use the arrow keys for values; a table follows.">${parts.join("")}</svg><div class="ch-tip" hidden></div>`;
  hover(el, o, { X, L, W, R, slot, n });
}

/** Tooltip + crosshair on the nearest bin; arrow keys move it. */
function hover(el, o, g) {
  const svg = el.querySelector("svg"), tip = el.querySelector(".ch-tip"), cross = svg.querySelector(".ch-cross");
  let cur = -1;
  const at = (i) => {
    cur = Math.max(0, Math.min(g.n - 1, i));
    cross.setAttribute("x1", g.X(cur)); cross.setAttribute("x2", g.X(cur)); cross.setAttribute("visibility", "visible");
    tip.innerHTML = o.tip(cur);
    tip.hidden = false;
    const scale = svg.getBoundingClientRect().width / g.W;
    const x = g.X(cur) * scale, tw = tip.offsetWidth, ew = el.clientWidth;
    tip.style.left = `${Math.max(0, Math.min(ew - tw, x - tw / 2))}px`;
  };
  const off = () => { cur = -1; tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * g.W;
    if (x < g.L - 8 || x > g.W - g.R + 8) { off(); return; }
    at(Math.floor((x - g.L) / g.slot));
  });
  svg.addEventListener("pointerleave", off);
  svg.addEventListener("blur", off);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); at(cur < 0 ? g.n - 1 : cur + (e.key === "ArrowRight" ? 1 : -1)); }
    else if (e.key === "Escape") off();
  });
}
