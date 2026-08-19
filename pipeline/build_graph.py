#!/usr/bin/env python3
"""Build the creator + microgenre discovery graph from the UCSD Book Graph.

Reads the line-delimited-JSON Goodreads dumps, projects work-level
`similar_books` edges up to author-author edges (preserving the specific book
pairs as `via` metadata), extracts microgenre nodes from `popular_shelves`,
draws author->microgenre edges, and emits a single adjacency-style graph.json.

Stdlib only. Both input files are gzipped, one JSON object per line, so we
stream them line by line and never hold the raw dumps in memory.

Usage:
    python3 build_graph.py \
        --books data/goodreads_books.json.gz \
        --authors data/goodreads_book_authors.json.gz \
        --out frontend/graph.json

Start with a high --min-reviews (e.g. 500) for a fast smoke pass, then lower it.
"""

import argparse
import gzip
import json
import re
import sys
from collections import Counter, defaultdict

# Regex patterns for systematic shelf noise the exact-match exclude-list can't
# cover: year logs ("2014-reads", "read-2019"), star ratings ("4-stars"),
# reading-status/format/misc tags. Matched case-insensitively against the
# lowercased shelf name.
NOISE_PATTERNS = [re.compile(p) for p in [
    r"^\d+$",                       # bare numbers ("1001")
    r"^\d+-books?$",                # "1001-books"
    r"(^|[-_])(19|20)\d\d([-_]|$)",  # any 4-digit year token
    r"\d+-?stars?\b",               # "4-stars", "5star"
    r"(^|[-_])stars?([-_]|$)",       # "star", "stars"
    r"(^|[-_])reads?([-_]|$)",       # "-reads", "read", "reads"
    r"(^|[-_])re-?read",            # "reread", "re-read"
    r"(^|[-_])tbr([-_]|$)",          # to-be-read
    r"(^|[-_])dnf",                 # did-not-finish
    r"finish",                      # finished / unfinished / didn-t-finish
    r"(^|[-_])arc([-_]|$)",          # advance reader copy
    r"book-?(club|group)",          # "book-club", "bookclub", "book-group"
    r"(^|[-_])shelf",               # "bookshelf", "my-shelf"
    r"(^|[-_])wish-?list",
    r"(^|[-_])(owned?|own)([-_]|$)",
    r"(^|[-_])(kindle|ebook|e-book|audio|audiobook|audible|"
    r"paperback|hardcover|hardback)",
    r"(^|[-_])(default|favou?rites?|favs?)([-_]|$)",
    r"(^|[-_])(library|borrowed)([-_]|$)",
]]


def is_noise(name, excludes):
    """True if a shelf name is reading-log / format / rating noise."""
    if name in excludes:
        return True
    return any(p.search(name) for p in NOISE_PATTERNS)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def open_maybe_gzip(path):
    """Open a .gz or plain file for text reading."""
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "rt", encoding="utf-8")


def to_int(value, default=0):
    """UCSD dumps store counts as strings; coerce safely."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_exclude_shelves(path):
    excludes = set()
    try:
        with open(path, "rt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                excludes.add(line.lower())
    except FileNotFoundError:
        log(f"[warn] exclude list not found at {path}; no shelves excluded")
    return excludes


def load_authors(path):
    """author_id -> name."""
    names = {}
    with open_maybe_gzip(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            aid = rec.get("author_id")
            if aid is not None:
                names[str(aid)] = rec.get("name") or f"Unknown ({aid})"
    log(f"[authors] loaded {len(names):,} author names")
    return names


def stream_books(path, min_reviews, excludes):
    """Yield light records for books clearing the review threshold.

    Record: {id, title, author_ids (list, all roles), similar (list),
             shelves (list of (name_lower, count_int), noise excluded)}.
    """
    kept = {}
    total = 0
    for line in open_maybe_gzip(path):
        line = line.strip()
        if not line:
            continue
        total += 1
        if total % 200000 == 0:
            log(f"[books] scanned {total:,} ... kept {len(kept):,}")
        rec = json.loads(line)
        if to_int(rec.get("text_reviews_count")) < min_reviews:
            continue
        book_id = rec.get("book_id")
        if book_id is None:
            continue
        book_id = str(book_id)

        author_ids = [
            str(a["author_id"])
            for a in rec.get("authors", [])
            if a.get("author_id") is not None
        ]
        if not author_ids:
            continue

        shelves = []
        for s in rec.get("popular_shelves", []):
            name = (s.get("name") or "").strip().lower()
            if not name or is_noise(name, excludes):
                continue
            shelves.append((name, to_int(s.get("count"))))

        kept[book_id] = {
            "title": rec.get("title") or f"Book {book_id}",
            "author_ids": author_ids,
            "similar": [str(b) for b in rec.get("similar_books", [])],
            "shelves": shelves,
        }
    log(f"[books] scanned {total:,} total, kept {len(kept):,} above "
        f"min_reviews={min_reviews}")
    return kept


def build_author_author_edges(kept, via_cap):
    """Undirected author-author edges keyed by sorted (aid, aid) tuple.

    Value: {"weight": int, "via": [[titleA, titleB], ...], "_seen": set}.
    An edge forms only when both books are in `kept` (neighbour's author is
    resolvable), and never between an author and themself.
    """
    edges = {}
    for rec in kept.values():
        a_title = rec["title"]
        a_authors = rec["author_ids"]
        for nb_id in rec["similar"]:
            nb = kept.get(nb_id)
            if nb is None:
                continue
            b_title = nb["title"]
            for aA in a_authors:
                for aB in nb["author_ids"]:
                    if aA == aB:
                        continue
                    key = (aA, aB) if aA < aB else (aB, aA)
                    edge = edges.get(key)
                    if edge is None:
                        edge = {"weight": 0, "via": [], "_seen": set()}
                        edges[key] = edge
                    edge["weight"] += 1
                    pair = (a_title, b_title) if a_title < b_title else (b_title, a_title)
                    if pair not in edge["_seen"]:
                        edge["_seen"].add(pair)
                        if len(edge["via"]) < via_cap:
                            edge["via"].append([pair[0], pair[1]])
    log(f"[edges] {len(edges):,} raw author-author edges")
    return edges


def select_top_genres(kept, top_n):
    counts = Counter()
    for rec in kept.values():
        for name, cnt in rec["shelves"]:
            counts[name] += cnt
    top = [name for name, _ in counts.most_common(top_n)]
    log(f"[genres] {len(counts):,} distinct shelves, keeping top {len(top):,}")
    return set(top)


def build_author_genre_edges(kept, genre_set, min_weight, per_author):
    """author -> its top-`per_author` genres by summed shelf count.

    Returns {(author_id, genre): weight}. A per-author cap keeps each author's
    *signature* microgenres instead of every shelf it has ever touched (popular
    books hit almost every top shelf, so a global weight threshold alone leaves
    the graph hopelessly dense).
    """
    by_author = defaultdict(lambda: defaultdict(int))
    for rec in kept.values():
        book_genres = [(n, c) for (n, c) in rec["shelves"] if n in genre_set]
        if not book_genres:
            continue
        for aid in rec["author_ids"]:
            for name, cnt in book_genres:
                by_author[aid][name] += cnt

    edges = {}
    for aid, gmap in by_author.items():
        top = sorted(gmap.items(), key=lambda kv: kv[1], reverse=True)
        kept_edges = 0
        for name, w in top:
            if w < min_weight or kept_edges >= per_author:
                break
            edges[(aid, name)] = w
            kept_edges += 1
    log(f"[edges] {len(edges):,} author-genre edges "
        f"(min_weight={min_weight}, top {per_author}/author)")
    return edges


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--books", default="data/goodreads_books.json.gz")
    ap.add_argument("--authors", default="data/goodreads_book_authors.json.gz")
    ap.add_argument("--exclude", default="pipeline/exclude_shelves.txt")
    ap.add_argument("--min-reviews", type=int, default=50,
                    help="keep books with text_reviews_count >= this")
    ap.add_argument("--top-genres", type=int, default=200)
    ap.add_argument("--min-author-genre", type=int, default=3,
                    help="min weight to draw an author->genre edge")
    ap.add_argument("--genre-per-author", type=int, default=6,
                    help="keep only each author's top-K genres by weight")
    ap.add_argument("--max-authors", type=int, default=3000,
                    help="cap author nodes by total incident edge weight")
    ap.add_argument("--via-cap", type=int, default=10,
                    help="max book-pairs stored per author-author edge")
    ap.add_argument("--out", default="frontend/graph.json")
    args = ap.parse_args()

    for path, label in [(args.books, "books"), (args.authors, "authors")]:
        try:
            open_maybe_gzip(path).close()
        except FileNotFoundError:
            log(f"[error] {label} file not found: {path}\n"
                f"        Download the UCSD Book Graph dumps into data/ first "
                f"(see README).")
            sys.exit(1)

    excludes = load_exclude_shelves(args.exclude)
    author_names = load_authors(args.authors)
    kept = stream_books(args.books, args.min_reviews, excludes)
    if not kept:
        log("[error] no books kept — lower --min-reviews and retry")
        sys.exit(1)

    aa_edges = build_author_author_edges(kept, args.via_cap)
    genre_set = select_top_genres(kept, args.top_genres)
    ag_edges = build_author_genre_edges(kept, genre_set, args.min_author_genre,
                                        args.genre_per_author)

    # --- rank authors by total incident weight, cap to --max-authors ---
    incident = Counter()
    for (aA, aB), edge in aa_edges.items():
        incident[aA] += edge["weight"]
        incident[aB] += edge["weight"]
    for (aid, _genre), w in ag_edges.items():
        incident[aid] += w
    keep_authors = {aid for aid, _ in incident.most_common(args.max_authors)}
    log(f"[nodes] {len(incident):,} authors touched, keeping top "
        f"{len(keep_authors):,}")

    # --- assemble surviving edges ---
    out_edges = []
    used_authors = set()
    used_genres = set()
    for (aA, aB), edge in aa_edges.items():
        if aA not in keep_authors or aB not in keep_authors:
            continue
        used_authors.add(aA)
        used_authors.add(aB)
        out_edges.append({
            "source": f"author:{aA}",
            "target": f"author:{aB}",
            "type": "author-author",
            "weight": edge["weight"],
            "via": edge["via"],
        })
    for (aid, genre), w in ag_edges.items():
        if aid not in keep_authors:
            continue
        used_authors.add(aid)
        used_genres.add(genre)
        out_edges.append({
            "source": f"author:{aid}",
            "target": f"genre:{genre}",
            "type": "author-genre",
            "weight": w,
        })

    # --- nodes: only authors/genres that survived into >=1 edge ---
    nodes = []
    for aid in sorted(used_authors):
        nodes.append({
            "id": f"author:{aid}",
            "type": "author",
            "name": author_names.get(aid, f"Unknown ({aid})"),
        })
    for genre in sorted(used_genres):
        nodes.append({
            "id": f"genre:{genre}",
            "type": "microgenre",
            "name": genre,
        })

    graph = {"nodes": nodes, "edges": out_edges}
    with open(args.out, "wt", encoding="utf-8") as fh:
        json.dump(graph, fh, ensure_ascii=False)

    n_authors = len(used_authors)
    n_genres = len(used_genres)
    n_aa = sum(1 for e in out_edges if e["type"] == "author-author")
    n_ag = len(out_edges) - n_aa
    log("")
    log("=== summary ===")
    log(f"  books kept          : {len(kept):,}")
    log(f"  author nodes        : {n_authors:,}")
    log(f"  microgenre nodes    : {n_genres:,}")
    log(f"  author-author edges : {n_aa:,}")
    log(f"  author-genre edges  : {n_ag:,}")
    log(f"  wrote               : {args.out}")


if __name__ == "__main__":
    main()
