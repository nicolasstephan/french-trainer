"""Import a French ebook (EPUB without DRM, or plain .txt) into ../french-data/books/ for the reader.

    python tools/import_book.py path/to/book.epub              # import + coverage report
    python tools/import_book.py path/to/book.epub --id hobbit  # choose the book id (default: from the title)
    python tools/import_book.py --gloss verne-tour-du-monde --limit 1500   # German glossary, in reading order
    python tools/import_book.py --coverage hobbit              # how much of the book your words cover
    python tools/import_book.py --ahead 30 --push              # glossary + sentence translations 30 pages past
                                                               # your position (scheduled task)

Writes (all in the private data repo, never in this public code repo):
  books/<id>.json        title, author, chapters, paragraphs (long ones split at sentence ends)
  books/<id>.gloss.json  word form -> [lemma, pos, German gloss, other meanings]; made with headless
                         Claude Code (`claude -p`), resumable, forms in reading order so the first
                         chapters are covered first
  books/<id>.de.json     paragraph -> German translation of each sentence (same split as the app), made
                         ahead of your reading position
  books/index.json       the library list the app shows
The raw file is copied to imports/books/ (gitignored: bought ebooks stay local).

Tokens follow the same rules as the app (js/reader.js): letters with inner hyphens, elided articles/
pronouns split off (l'homme -> l' + homme), clitic pronouns after a hyphen split off (dit-il -> dit + il).
"""
import argparse
import html
import json
import random
import re
import shutil
import subprocess
import sys
import unicodedata
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from posixpath import dirname, join, normpath

MAX_PARA = 150      # words; longer paragraphs are split at sentence ends
GLOSS_BATCH = 120   # word forms per claude call

L = r"[^\W\d_]"
TOKEN = re.compile(rf"{L}+(?:['’]{L}+)*(?:-{L}+(?:['’]{L}+)*)*")
ELIDED = {"l", "d", "j", "m", "n", "s", "t", "c", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu"}
CLITIC = {"je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "le", "la", "les", "lui", "leur",
          "moi", "toi", "y", "en", "ce", "t"}


def tokens(text):
    """Word tokens as (start, end) spans; the app's tokenizer does the same."""
    out = []
    for m in TOKEN.finditer(text):
        s, w = m.start(), m.group(0)
        # elision: l'homme -> l' + homme (aujourd'hui, quelqu'un stay whole)
        while True:
            e = re.match(rf"({L}+)['’](?={L})", w)
            if not e or e.group(1).lower() not in ELIDED:
                break
            out.append((s, s + e.end()))
            s += e.end()
            w = w[e.end():]
        # clitics: dit-il -> dit + il, a-t-il -> a + t + il, donne-le-moi -> donne + le + moi
        parts = w.split("-")
        i = len(parts)
        while i > 1 and parts[i - 1].lower() in CLITIC:
            i -= 1
        pos = s
        head = "-".join(parts[:i])
        out.append((pos, pos + len(head)))
        pos += len(head)
        for p in parts[i:]:
            pos += 1
            out.append((pos, pos + len(p)))
            pos += len(p)
    return out


def words_of(text):
    return [text[a:b] for a, b in tokens(text)]


def key(form):
    """Glossary key: lower case, typographic apostrophe normalized."""
    return form.lower().replace("’", "'")


# ---------- reading the ebook ----------

BLOCK = {"p", "div", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "dd", "dt", "pre"}
SKIP = {"script", "style", "head", "title", "nav"}


class Blocks(HTMLParser):
    """XHTML -> [(kind, text)] with kind 'h' (heading) or 'p'."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.buf, self.stack, self.skip, self.head = [], [], [], 0, 0

    def flush(self):
        text = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        self.buf = []
        if text:
            self.out.append(("h" if self.head else "p", text))

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "") + " " + (a.get("id") or "")
        # Project Gutenberg boilerplate (licence header/footer)
        if tag in SKIP or re.search(r"pg-boilerplate|pg-header|pg-footer|pgheader|pgfooter", cls):
            self.skip += 1
            self.stack.append((tag, True))
            return
        self.stack.append((tag, False))
        if tag in BLOCK or tag == "br":
            if tag == "br":
                self.buf.append(" ")
            else:
                self.flush()
        if re.fullmatch(r"h[1-6]", tag) or re.search(r"\b(chapter|chapitre|title|heading)", cls, re.I) and tag in BLOCK:
            self.head += 1
            self.stack[-1] = (tag, "head")

    def handle_endtag(self, tag):
        while self.stack:
            t, flag = self.stack.pop()
            if flag is True:
                self.skip -= 1
            if t in BLOCK:
                self.flush()
            if flag == "head":
                self.head -= 1
            if t == tag:
                break

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)


def read_epub(path):
    z = zipfile.ZipFile(path)
    try:
        if "META-INF/encryption.xml" in z.namelist() and b"EncryptedData" in z.read("META-INF/encryption.xml"):
            if not all(n.startswith("META-INF") or n.endswith((".ttf", ".otf", ".woff")) for n in
                       re.findall(r'URI="([^"]+)"', z.read("META-INF/encryption.xml").decode("utf-8", "replace"))):
                sys.exit("This EPUB has DRM (encrypted content). Remove the DRM or export a DRM-free copy first.")
    except KeyError:
        pass
    container = z.read("META-INF/container.xml").decode("utf-8")
    opf_path = re.search(r'full-path="([^"]+)"', container).group(1)
    opf = z.read(opf_path).decode("utf-8")
    base = dirname(opf_path)
    meta = lambda tag: html.unescape(re.sub(r"<[^>]+>", "", (re.search(rf"<dc:{tag}[^>]*>(.*?)</dc:{tag}>", opf, re.S) or [None, ""])[1])).strip()
    items = {}
    for m in re.finditer(r"<item\b[^>]*>", opf):
        t = m.group(0)
        i, h = re.search(r'\bid="([^"]+)"', t), re.search(r'\bhref="([^"]+)"', t)
        if i and h:
            items[i.group(1)] = normpath(join(base, html.unescape(h.group(1)).split("#")[0]))
    spine = [items[i] for i in re.findall(r'<itemref\b[^>]*idref="([^"]+)"', opf) if i in items]
    toc = {}
    nav = [v for v in items.values() if v.endswith(".ncx")] + \
          [items[m.group(1)] for m in re.finditer(r'<item\b[^>]*properties="[^"]*\bnav\b[^"]*"[^>]*>', opf)
           for m in [re.search(r'\bid="([^"]+)"', m.group(0))] if m and m.group(1) in items]
    for tp in nav:
        x = z.read(tp).decode("utf-8", "replace")
        tb = dirname(tp)
        if tp.endswith(".ncx"):
            pairs = re.findall(r"<navLabel>\s*<text>(.*?)</text>\s*</navLabel>\s*<content\s+src=\"([^\"]+)\"", x, re.S)
        else:
            pairs = [(t, h) for h, t in re.findall(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', x, re.S)]
        for label, href in pairs:
            doc = normpath(join(tb, html.unescape(href).split("#")[0]))
            label = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", label))).strip()
            toc.setdefault(doc, label)
        if toc:
            break
    docs = []
    for name in spine:
        p = Blocks()
        p.feed(z.read(name).decode("utf-8", "replace"))
        p.flush()
        docs.append((toc.get(name, ""), p.out))
    return meta("title"), meta("creator"), docs


def read_txt(path):
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    m = re.search(r"\*\*\* ?START OF.*?\*\*\*(.*)\*\*\* ?END OF", text, re.S)   # Gutenberg plain text
    text = m.group(1) if m else text
    blocks = []
    for b in re.split(r"\n\s*\n", text):
        b = re.sub(r"\s+", " ", b).strip()
        if not b:
            continue
        # a short line in capitals, or "Chapitre ..." -> heading
        heading = len(b) < 120 and (b.isupper() or re.match(r"(chapitre|chapter|partie|livre)\b", b, re.I))
        blocks.append(("h" if heading else "p", b))
    return Path(path).stem, "", [("", blocks)]


def split_long(text):
    """Split a paragraph longer than MAX_PARA words at sentence ends."""
    if len(words_of(text)) <= MAX_PARA:
        return [text]
    sents = re.split(r"(?<=[.!?…»])\s+(?=[«—\-A-ZÀ-ÖØ-Þ\"“])", text)
    out, cur = [], ""
    for s in sents:
        if cur and len(words_of(cur + " " + s)) > MAX_PARA:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return out


# table-of-contents entries that are not part of the story
MATTER = re.compile(r"^(couverture|cover|copyright|achevé d.imprimer|ouvrages de|ouvrages du|du même auteur|titre|title page|"
                    r"table des matières|sommaire|contents|présentation|4e de couverture|crédits?)\b", re.I)


def build(title, author, docs):
    """Chapters from headings (consecutive headings form one title); with almost no headings,
    every spine document is a chapter. Chapters without text (tables of contents) are dropped."""
    use_docs = sum(1 for _, d in docs for k, _ in d if k == "h") < 3
    chapters, cur = [], None

    def new(t):
        nonlocal cur
        cur = {"title": t, "paras": []}
        chapters.append(cur)

    has_toc = any(label for label, _ in docs)
    new("")
    for label, d in docs:
        if MATTER.search(label or "-"):
            continue
        # spine documents as chapters: a new TOC entry starts one; without a TOC every document does;
        # with a TOC, a document it doesn't list continues the chapter before it
        if use_docs and (label or not has_toc):
            if cur["paras"]:
                new(label)
            else:
                cur["title"] = label
        run = []   # headings in a row without text (a TOC is one long run)
        for kind, text in d:
            if kind == "h":
                if not run or cur["paras"]:
                    new(text)
                run = (run + [text])[-2:]
                cur["title"] = " · ".join(run)
                continue
            run = []
            cur["paras"].extend(split_long(text))
    # drop chapters with no real text (TOC entries, title pages) but keep a front part with substance
    kept = [c for c in chapters if sum(len(words_of(p)) for p in c["paras"]) >= 40]
    paras, chaps = [], []
    for i, c in enumerate(kept):
        chaps.append({"title": c["title"] or (f"Teil {i + 1}"), "p": len(paras)})
        paras.extend(c["paras"])
    return {"title": title, "author": author, "lang": "fr", "chapters": chaps, "paras": paras,
            "words": sum(len(words_of(p)) for p in paras)}


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40] or "book"


# ---------- data repo ----------

def data_dir():
    return Path(__file__).resolve().parents[1].parent / "french-data"


def load(p, default):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def save(p, obj, indent=None):
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":")) + "\n",
                 encoding="utf-8")


def update_index(data, book_id):
    books = data / "books"
    idx = load(books / "index.json", {"books": []})
    b = load(books / f"{book_id}.json", None)
    g = load(books / f"{book_id}.gloss.json", {})
    entry = {"id": book_id, "title": b["title"], "author": b["author"], "words": b["words"],
             "paras": len(b["paras"]), "chapters": len(b["chapters"]), "gloss": len(g),
             "forms": len(distinct_forms(b)), "coverage": coverage(data, b, g)}
    idx["books"] = [x for x in idx["books"] if x["id"] != book_id] + [entry]
    save(books / "index.json", idx, indent=1)
    return entry


# Basic forms Lingvist never asks (its course starts above them); counted as known for the coverage.
CORE = set("""
le la les l' un une des du de d' au aux à et ou mais donc or ni car que qu' qui quoi dont où ce c' cet cette ces
se s' je j' tu il elle on nous vous ils elles me m' te t' moi toi lui leur leurs eux y en ne n' pas plus non oui si
mon ma mes ton ta tes son sa ses notre nos votre vos sur sous dans par pour avec sans chez entre vers contre avant
après pendant depuis comme quand bien très tout tous toute toutes même aussi alors encore déjà jamais rien personne
peu beaucoup trop là ici puis enfin aussitôt quel quelle quels quelles lequel laquelle lesquels lesquelles
être suis es est sommes êtes sont était étais étaient été sera serait seront fut furent soit
avoir ai as a avons avez ont avait avais avaient eu aura aurait auront eut eût eurent ait
faire fait faisait fais font aller va vont allait dire dit disait dis
un deux trois quatre cinq six sept huit neuf dix vingt cent mille premier première mr mrs monsieur madame
ça cela ceci celui celle ceux celles chaque autre autres jusque lorsque puisque quoique parce quelque quelques
aucun aucune tel telle tels telles certain certains certaine certaines plusieurs
""".split())


def distinct_forms(book):
    """Glossary keys in reading order, with the first sentence each appears in (context for the glossary)."""
    seen = {}
    for p in book["paras"]:
        for a, b in tokens(p):
            k = key(p[a:b])
            if k not in seen:
                lo, hi = p.rfind(" ", 0, max(0, a - 50)), p.find(" ", b + 50)
                seen[k] = p[lo + 1 if lo >= 0 else 0: hi if hi >= 0 else len(p)]
    return seen


def coverage(data, book, gloss):
    """Share of running words (names excluded) that are in your Lingvist words, by stage.
    Matched by form, and by lemma where the glossary knows it."""
    words = load(data / "words.json", {"words": []})["words"]
    sents = load(data / "sentences.json", {})
    rank = {"new": 0, "learning": 1, "young": 2, "familiar": 3, "known": 4}
    best = {}
    def put(k, st):
        if rank[st] > rank.get(best.get(k), -1):
            best[k] = st
    for w in words:
        put(key(w["word"]), w["stage"])
        lem = sents.get(w["id"], {}).get("lemma")
        if lem:
            put("=" + key(lem), w["stage"])
    for k in CORE:
        put(k, "known")
    for w in words:   # a known form also teaches its lemma (from the book glossary)
        g = gloss.get(key(w["word"]))
        if g and g[0]:
            put("=" + key(g[0]), w["stage"])
    caps, total = {}, 0
    for p in book["paras"]:
        for a, b in tokens(p):
            f = p[a:b]
            mid = a > 0 and not re.search(r"[.!?«—:]\s*$", p[:a])
            c = caps.setdefault(key(f), [0, 0])
            c[0] += 1
            c[1] += f[0].isupper() and mid
    n = {s: 0 for s in rank}
    unknown = 0
    names = {k for k, (cnt, up) in caps.items() if up and up >= cnt * 0.8 and not best.get(k)}
    for k, (cnt, _) in caps.items():
        if k in names:
            continue
        total += cnt
        g = gloss.get(k)
        st = best.get(k) or (best.get("=" + key(g[0])) if g and g[0] else None)
        if st:
            n[st] += cnt
        else:
            unknown += cnt
    pct = lambda x: round(100 * x / max(1, total), 1)
    young_up = n["young"] + n["familiar"] + n["known"]
    return {"tokens": total, "any": pct(sum(n.values())), "young_plus": pct(young_up), "known": pct(n["known"]),
            "unknown_forms": sum(1 for k in caps if k not in names and not best.get(k)
                                 and not (gloss.get(k) and best.get("=" + key(gloss[k][0] or ""))))}


# ---------- glossary ----------

GLOSS_PROMPT = """You make a French -> German reading glossary for a German learner (level about B1).
For each French word form below (lower case, with the passage it first appears in), give:
- lemma (dictionary form; for verbs the infinitive),
- pos: noun/verb/adj/adv/pron/prep/conj/det/num/name/interj/other,
- gloss: the German translation that fits THIS passage, as direct as possible (cognates first). For verb forms
  translate the form (était -> war, aurait -> hätte), for nouns add the article (le livre -> das Buch: "Buch (n.)"
  is NOT wanted; write "das Buch"), for adjectives the base form,
- other: up to 3 other common German meanings of the lemma (may be empty), as one short string.
For names: lemma = the name, gloss = what it is (e.g. "Stadt London", "Vorname").
Old or literary forms (passé simple, imparfait du subjonctif): say so in brackets, e.g. "fut" -> "war (passé simple von être)".

Reply with JSON only, no prose: {{"<form>": ["<lemma>", "<pos>", "<gloss>", "<other>"], ...}}

Forms (form | passage):
{forms}
"""


MODEL = "sonnet"
LIMIT_ERR = re.compile(r"limit|usage|quota|rate", re.I)


def ask_claude(prompt, model=MODEL):
    exe = shutil.which("claude") or shutil.which("claude.cmd")
    r = subprocess.run([exe, "-p", "--model", model, "--output-format", "text"], input=prompt,
                       capture_output=True, text=True, encoding="utf-8", timeout=900)
    if r.returncode:
        lines = [l for l in (r.stderr + r.stdout).splitlines() if l.strip() and not l.startswith("Warning:")]
        raise RuntimeError(" ".join(lines)[-300:] or f"exit {r.returncode}")
    # the first complete JSON object (a reply sometimes adds prose after it)
    start = r.stdout.find("{")
    if start < 0:
        raise ValueError("no JSON in reply")
    return json.JSONDecoder().raw_decode(r.stdout[start:])[0]


def push(data, paths, msg):
    """Commit the given data files and push (the app writes only progress.json, so a rebase never conflicts)."""
    git = ["git", "-C", str(data)]
    subprocess.run(git + ["add", *paths], check=False)
    if subprocess.run(git + ["diff", "--cached", "--quiet"]).returncode == 0:
        return
    subprocess.run(git + ["commit", "-q", "-m", msg], check=False)
    for _ in range(3):
        subprocess.run(git + ["pull", "-q", "--rebase", "--autostash"], check=False)
        if subprocess.run(git + ["push", "-q"]).returncode == 0:
            return
    print("  (push failed; the next batch tries again)")


def make_gloss(data, book_id, limit, upto=None, do_push=False):
    """Glossary entries for the forms in reading order (upto: only forms that occur before this paragraph).
    Returns False when a usage limit stopped it."""
    books = data / "books"
    book = load(books / f"{book_id}.json", None)
    if not book:
        sys.exit(f"no book {book_id} in {books}")
    gpath = books / f"{book_id}.gloss.json"
    gloss = load(gpath, {})
    forms = distinct_forms(book)
    wanted = forms if upto is None else distinct_forms({"paras": book["paras"][:upto]})
    todo = [k for k in wanted if k not in gloss]
    if limit:
        todo = todo[:limit]
    print(f"{book_id}: {len(forms)} forms, {len(gloss)} in the glossary, {len(todo)} to do now"
          + (f" (up to paragraph {upto})" if upto is not None else ""), flush=True)
    for i in range(0, len(todo), GLOSS_BATCH):
        batch = todo[i:i + GLOSS_BATCH]
        lines = "\n".join(f"{k} | {forms[k]}" for k in batch)
        try:
            res = ask_claude(GLOSS_PROMPT.format(forms=lines))
        except Exception as e:   # the next run retries these
            print(f"gloss batch {i // GLOSS_BATCH + 1}: failed ({str(e)[:200]})", flush=True)
            if LIMIT_ERR.search(str(e)):
                return False
            continue
        got = 0
        for k in batch:
            v = res.get(k)
            if isinstance(v, list) and len(v) >= 3:
                gloss[k] = [str(x or "") for x in (v + [""])[:4]]
                got += 1
        save(gpath, gloss)
        update_index(data, book_id)
        print(f"gloss batch {i // GLOSS_BATCH + 1}: {got}/{len(batch)}, glossary {len(gloss)}/{len(forms)}", flush=True)
        if do_push and got:
            push(data, [f"books/{book_id}.gloss.json", "books/index.json"], f"Glossary {book_id}: {len(gloss)}/{len(forms)}")
    if upto is None:
        print(json.dumps(update_index(data, book_id), ensure_ascii=False))
    return True


# ---------- sentence translations ----------

# Sentence ends: . ! ? … (one or more), closing quotes/brackets after them, then a space or the end.
# The app splits the same way (sentences() in js/reader.js), so translations line up with the tapped sentence.
SENT_END = re.compile(r"[.!?…]+(?:[\s\u00a0\u202f]*[»”\")\]])*(?=\s|$)")
ABBREV = re.compile(r"(?:^|[\s(«])(?:M|Mr|Mrs|Mme|Mlle|Dr|St|[A-Z])$")


def sentences(text):
    """Sentence spans [start, end) of a paragraph; abbreviations like M. or Mr. don't end a sentence."""
    out, s = [], 0
    for m in SENT_END.finditer(text):
        if m.group(0) == "." and ABBREV.search(text[:m.start()]):
            continue
        if text[s:m.end()].strip():
            out.append((s, m.end()))
        s = m.end()
    if text[s:].strip():
        out.append((s, len(text)))
    return out


TRANS_PROMPT = """Translate French sentences from a book into German for a German learner reading the original.
Translate each numbered sentence on its own (one German sentence per French one, same count, same order), close to
the French wording and structure while staying correct, natural German; keep names as they are; mirror the tense
(passé simple -> Präteritum). The paragraph context is given by the order of the sentences.

Reply with JSON only, no prose: {{"<paragraph>": ["<German 1>", "<German 2>", ...], ...}}

Sentences (paragraph.sentence | French):
{lines}
"""
TRANS_WORDS = 1500   # French words per call


def make_translations(data, book_id, start, end, do_push=False):
    """German translations of every sentence in paragraphs [start, end): books/<id>.de.json, {para: [German, ...]}.
    Returns False when a usage limit stopped it."""
    books = data / "books"
    book = load(books / f"{book_id}.json", None)
    tpath = books / f"{book_id}.de.json"
    trans = load(tpath, {})
    todo = [p for p in range(start, min(end, len(book["paras"]))) if str(p) not in trans and sentences(book["paras"][p])]
    print(f"{book_id}: translations for paragraphs {start}-{end}: {len(todo)} to do", flush=True)
    batches, cur, w = [], [], 0
    for p in todo:
        n = len(words_of(book["paras"][p]))
        if cur and w + n > TRANS_WORDS:
            batches.append(cur)
            cur, w = [], 0
        cur.append(p)
        w += n
    if cur:
        batches.append(cur)
    for bi, batch in enumerate(batches, 1):
        spans = {p: sentences(book["paras"][p]) for p in batch}
        lines = "\n".join(f"{p}.{i + 1} | {book['paras'][p][a:b].strip()}" for p in batch for i, (a, b) in enumerate(spans[p]))
        try:
            res = ask_claude(TRANS_PROMPT.format(lines=lines))
        except Exception as e:
            print(f"translation batch {bi}/{len(batches)}: failed ({str(e)[:200]})", flush=True)
            if LIMIT_ERR.search(str(e)):
                return False
            continue
        got = 0
        for p in batch:
            de = res.get(str(p))
            if isinstance(de, list) and len(de) == len(spans[p]) and all(isinstance(x, str) and x.strip() for x in de):
                trans[str(p)] = [x.strip() for x in de]
                got += 1
        save(tpath, trans)
        print(f"translation batch {bi}/{len(batches)}: {got}/{len(batch)} paragraphs, {len(trans)} in all", flush=True)
        if do_push and got:
            push(data, [f"books/{book_id}.de.json"], f"Translations {book_id}: {len(trans)} paragraphs")
    return True


# ---------- ahead of the reader ----------

def para_after(book, pos, pages):
    """The paragraph about `pages` pages (of 220 words) after paragraph pos."""
    w, p = 0, pos
    while p < len(book["paras"]) and w < pages * 220:
        w += len(words_of(book["paras"][p]))
        p += 1
    return p


def ahead(data, pages, do_push):
    """For the books you are reading (most recent first): glossary and sentence translations up to `pages` pages
    past your position, so the next pages are always covered. Positions come from progress.json (reading.books)."""
    prog = load(data / "progress.json", {})
    reading = sorted(((st.get("at", 0), bid, st.get("pos", 0)) for bid, st in (prog.get("reading", {}).get("books") or {}).items()),
                     reverse=True)
    if not reading:
        print("no book started")
        return
    for _, bid, pos in reading[:2]:
        book = load(data / "books" / f"{bid}.json", None)
        if not book:
            continue
        end = para_after(book, pos, pages)
        # translations from a page before your position (going back a page is common), then the glossary
        ok = make_translations(data, bid, para_after_back(book, pos), end, do_push)
        if not ok or not make_gloss(data, bid, 0, upto=end, do_push=do_push):
            print("usage limit: stopping", flush=True)
            return


def para_after_back(book, pos, words=220):
    w, p = 0, pos
    while p > 0 and w < words:
        p -= 1
        w += len(words_of(book["paras"][p]))
    return p


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", help=".epub or .txt to import")
    ap.add_argument("--id", help="book id (default: from the title)")
    ap.add_argument("--data", default=str(data_dir()))
    ap.add_argument("--gloss", metavar="ID", help="make the German glossary for this book")
    ap.add_argument("--limit", type=int, default=0, help="glossary: max word forms this run")
    ap.add_argument("--coverage", metavar="ID", help="recompute the coverage of this book")
    ap.add_argument("--ahead", type=int, metavar="PAGES", help="glossary + sentence translations this many pages past "
                    "your reading position (books you are reading; scheduled task)")
    ap.add_argument("--push", action="store_true", help="commit and push the book files after every batch")
    args = ap.parse_args()
    data = Path(args.data)
    (data / "books").mkdir(exist_ok=True)
    if args.ahead:
        ahead(data, args.ahead, args.push)
        return
    if args.gloss:
        make_gloss(data, args.gloss, args.limit, do_push=args.push)
        return
    if args.coverage:
        print(json.dumps(update_index(data, args.coverage), ensure_ascii=False, indent=1))
        return
    if not args.file:
        ap.error("give a file to import, or --gloss / --coverage ID")
    src = Path(args.file)
    title, author, docs = read_epub(src) if src.suffix.lower() == ".epub" else read_txt(src)
    book = build(title, author, docs)
    book_id = args.id or slug(f"{author.split()[-1] if author else ''} {title}")
    book["id"] = book_id
    raw = data / "imports" / "books"
    raw.mkdir(parents=True, exist_ok=True)
    if src.resolve() != (raw / src.name).resolve():
        shutil.copy2(src, raw / src.name)
    save(data / "books" / f"{book_id}.json", book)
    e = update_index(data, book_id)
    print(f"{book_id}: {book['title']} / {book['author']}: {len(book['chapters'])} chapters, "
          f"{len(book['paras'])} paragraphs, {book['words']} words, {e['forms']} distinct forms")
    for c in book["chapters"][:5]:
        print("  ", c["p"], c["title"][:90])
    c = e["coverage"]
    print(f"coverage by your Lingvist words: any stage {c['any']} %, young+ {c['young_plus']} %, known {c['known']} %"
          f" ({c['unknown_forms']} forms not in your words)")
    print(f"next: python tools/import_book.py --gloss {book_id} --limit 1500")


if __name__ == "__main__":
    main()
