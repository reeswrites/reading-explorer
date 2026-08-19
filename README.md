# Reading Explorer

A browsable node-link graph for discovering **books** at the **creator
(author)** and **microgenre** level — click a node, see its neighbours, follow
the thread. Rabbit-hole browsing, not a fixed spatial map.

Extends the Literature-Map / Gnod pattern by adding a microgenre layer and by
**preserving *why* two authors are connected** (which specific book pairs) as
edge metadata, shown on hover.

All edges derive from existing structured fields in the **UCSD Book Graph**
(Goodreads scrape). No ML / embeddings / clustering — v1 books only.

---

## Quick start (demo data)

A small handcrafted sample graph ships at `frontend/graph.json`, so you can try
the UI immediately without downloading anything:

```sh
cd frontend
python3 -m http.server 8000
# open http://localhost:8000
```

Search an author (e.g. "Jemisin"), then click through neighbours.

## Real data

The sample is tiny. To build the real graph you need the UCSD Book Graph dumps.

### 1. Download (manual — academic license, ~2GB)

From <https://cseweb.ucsd.edu/~jmcauley/datasets/goodreads.html> download into
`data/`:

- `goodreads_books.json.gz` (~2GB, 2.3M books)
- `goodreads_book_authors.json.gz`

> Academic license: **non-commercial use, no redistribution.** Fine for a
> personal prototype. The files are line-delimited JSON (one object per line);
> the pipeline streams them and never loads a full dump into memory.

### 2. Build the graph

```sh
python3 pipeline/build_graph.py \
    --books data/goodreads_books.json.gz \
    --authors data/goodreads_book_authors.json.gz \
    --out frontend/graph.json
```

Tuning knobs (defaults in parentheses):

| Flag | Meaning |
| --- | --- |
| `--min-reviews` (50) | keep books with `text_reviews_count >=` this |
| `--top-genres` (200) | number of microgenre nodes to keep |
| `--min-author-genre` (3) | min weight to draw an author→genre edge |
| `--genre-per-author` (6) | keep only each author's top-K genres by weight |
| `--max-authors` (3000) | cap author nodes by total incident edge weight |
| `--via-cap` (10) | max book-pairs stored per author-author edge |

The graph shipped in `frontend/graph.json` was built with:

```sh
python3 pipeline/build_graph.py --min-reviews 500 --top-genres 300 \
    --genre-per-author 6 --out frontend/graph.json
```

→ 16k books, 3,000 authors, 228 microgenres, ~19k author-author + 18k
author-genre edges (6 MB). Lower `--min-reviews` for a bigger, denser graph.

Shelf noise (year-logs like `2014-reads`, ratings like `4-stars`, formats,
reading-status tags) is stripped by both `pipeline/exclude_shelves.txt` (exact
names) and regex patterns in `build_graph.py` (`NOISE_PATTERNS`). Author-name /
series shelves (`discworld`, `dan-brown`) and accent duplicates
(`classics`/`clàssics`) still leak through — acceptable for v1.

**Tip:** start with a high threshold for a fast smoke pass, then lower it:

```sh
python3 pipeline/build_graph.py --min-reviews 500 --out frontend/graph.json
```

The script prints a summary (books kept, authors, genres, edges) — use it to
tune. Noise shelves (`to-read`, `owned`, `favorites`, …) are stripped via
`pipeline/exclude_shelves.txt`; edit that list once you see real shelf data.

### 3. Serve

```sh
cd frontend && python3 -m http.server 8000
```

---

## How it works

**Pipeline** (`pipeline/build_graph.py`, stdlib only):

1. Load author id→name.
2. Stream books, keep those above the review threshold.
3. **Author-author edges** — for each kept book `A` and each `B` in its
   `similar_books` (that also passed the filter), add a weighted undirected
   edge between their authors and record the `(titleA, titleB)` pair as `via`.
   Multi-author books attribute to *all* listed authors.
4. **Microgenre nodes** — top-N `popular_shelves` tags by summed count, minus
   the exclude-list.
5. **Author→genre edges** — per-author shelf-tag affinity, thresholded.
6. Emit `frontend/graph.json`.

**Frontend** (`frontend/`, vanilla JS + vendored d3-force + SVG, no build step):

- **Overview map on load** — the ~240 strongest authors + 60 microgenres and
  the edges among them, force-clustered into a browsable "you are here" map
  (pan/scroll to zoom). Clusters emerge on their own (YA/fantasy, classics,
  mystery, comics…). Only the top nodes are labelled; hover reveals the rest.
  Click any node to drop into its ego view. Node/genre counts are the
  `OVERVIEW_*` constants in `app.js`.
- **Ego view** — only the focused node and its direct neighbours are in the
  simulation, so it stays fast at any graph size. Hub authors can have 100+
  neighbours, so each view shows only the strongest links by edge weight
  (top 24 authors + 8 genres; `*_NEIGHBOR_CAP` in `app.js`), with a caption
  noting how many exist.
- Search to start, click a neighbour to recenter, clickable breadcrumb trail,
  hover an author-author edge to see the book pairs behind it. Click the
  **Reading Explorer** title to return to the overview.

## graph.json schema

```json
{
  "nodes": [
    {"id": "author:123", "type": "author", "name": "N. K. Jemisin"},
    {"id": "genre:hopepunk", "type": "microgenre", "name": "hopepunk"}
  ],
  "edges": [
    {"source": "author:123", "target": "author:456", "type": "author-author",
     "weight": 4, "via": [["The Fifth Season", "Ancillary Justice"]]},
    {"source": "author:123", "target": "genre:hopepunk", "type": "author-genre",
     "weight": 7}
  ]
}
```

## Layout

```
data/                   downloaded .gz dumps (git-ignored)
pipeline/build_graph.py the pipeline
pipeline/exclude_shelves.txt  noise-shelf exclude-list (editable)
frontend/               index.html, app.js, style.css, vendor/d3, graph.json
```

## Out of scope (v1)

Embeddings / clustering; movies/TMDb (phase 2); mood/tone axis; multi-lens
switching; spatial coordinate layout; persistence.
