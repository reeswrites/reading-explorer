/* Reading Explorer — ego-network browser over the creator + microgenre graph.
 *
 * Only the focused node and its direct neighbours are ever in the d3-force
 * simulation, so rendering stays cheap regardless of total graph size.
 *
 * Hub authors can have 100+ neighbours, which is an unreadable hairball, so
 * each ego view shows only the strongest connections by edge weight.
 */
const AUTHOR_NEIGHBOR_CAP = 24;
const GENRE_NEIGHBOR_CAP = 8;

const state = {
  nodesById: new Map(),   // id -> node {id, type, name}
  adjacency: new Map(),   // id -> [{ other: id, edge }]
  authorNames: [],        // [{id, name, type}] for search
  focusId: null,
  trail: [],              // breadcrumb: array of node ids
  sim: null,
};

const svg = d3.select("#graph");
const viewport = svg.append("g").attr("class", "viewport");
const gLinks = viewport.append("g").attr("class", "links");
const gNodes = viewport.append("g").attr("class", "nodes");
const tooltip = document.getElementById("tooltip");
const hint = document.getElementById("hint");

// pan/zoom — needed so the ~300-node overview map has room to breathe
const zoom = d3.zoom()
  .scaleExtent([0.15, 4])
  .on("zoom", (ev) => viewport.attr("transform", ev.transform));
svg.call(zoom);

function resetZoom(scale = 1) {
  const stage = document.getElementById("stage");
  svg.transition().duration(400).call(
    zoom.transform,
    d3.zoomIdentity
      .translate(stage.clientWidth / 2, stage.clientHeight / 2)
      .scale(scale)
      .translate(-stage.clientWidth / 2, -stage.clientHeight / 2)
  );
}

// ---------------------------------------------------------------- data load
fetch("graph.json")
  .then((r) => {
    if (!r.ok) throw new Error(`graph.json: ${r.status}`);
    return r.json();
  })
  .then(initGraph)
  .catch((err) => {
    hint.textContent =
      "Could not load graph.json — run the pipeline first (see README). " + err;
  });

function initGraph(graph) {
  for (const n of graph.nodes) {
    state.nodesById.set(n.id, n);
    state.adjacency.set(n.id, []);
  }
  for (const e of graph.edges) {
    // store adjacency both directions; keep the raw edge for "why" + weight
    if (state.adjacency.has(e.source))
      state.adjacency.get(e.source).push({ other: e.target, edge: e });
    if (state.adjacency.has(e.target))
      state.adjacency.get(e.target).push({ other: e.source, edge: e });
  }
  state.authorNames = graph.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
  }));

  // total incident edge weight per node — drives overview ranking + which
  // labels are worth showing in the crowded overview
  state.score = new Map();
  const bump = (id, w) => state.score.set(id, (state.score.get(id) || 0) + w);
  for (const e of graph.edges) { bump(e.source, e.weight); bump(e.target, e.weight); }

  setupSearch();
  document.getElementById("brand").addEventListener("click", showOverview);
  showOverview();
}

// ----------------------------------------------------------------- overview
// A "you are here" starter map: the strongest authors + genres and the edges
// among them. Click any node to drop into its ego view.
const OVERVIEW_AUTHORS = 240;
const OVERVIEW_GENRES = 60;

function showOverview() {
  state.focusId = null;
  state.trail = [];
  renderBreadcrumb();
  document.getElementById("search").value = "";
  hint.hidden = true;

  const authors = [];
  const genres = [];
  for (const n of state.nodesById.values()) {
    (n.type === "author" ? authors : genres).push(n);
  }
  const byScore = (a, b) => (state.score.get(b.id) || 0) - (state.score.get(a.id) || 0);
  authors.sort(byScore);
  genres.sort(byScore);
  const aTop = authors.slice(0, OVERVIEW_AUTHORS);
  const gTop = genres.slice(0, OVERVIEW_GENRES);
  const inSet = new Set([...aTop, ...gTop].map((n) => n.id));

  // only the strongest nodes get a label up front (else 300 labels overlap);
  // hovering any node reveals its label
  const nodes = aTop.map((n, i) => ({ ...n, showLabel: i < 30 }))
    .concat(gTop.map((n, i) => ({ ...n, showLabel: i < 25 })));

  // edges with both endpoints in the overview set (dedup via adjacency)
  const links = [];
  const seenEdge = new Set();
  for (const id of inSet) {
    for (const { other, edge } of state.adjacency.get(id) || []) {
      if (!inSet.has(other)) continue;
      const key = edge.source + "|" + edge.target;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      links.push({
        source: edge.source, target: edge.target,
        type: edge.type, weight: edge.weight, via: edge.via || null,
      });
    }
  }

  const meta = document.getElementById("meta");
  meta.innerHTML = `<b>Overview</b> — ${OVERVIEW_AUTHORS} strongest authors, ` +
    `${OVERVIEW_GENRES} microgenres · click a node to explore · scroll to zoom`;
  meta.hidden = false;

  draw(nodes, links, { overview: true });
  resetZoom(0.55);
}

// ------------------------------------------------------------------- search
function setupSearch() {
  const input = document.getElementById("search");
  const results = document.getElementById("results");

  const render = (matches) => {
    results.innerHTML = "";
    if (!matches.length) {
      results.hidden = true;
      return;
    }
    for (const m of matches) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = m.name;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = m.type === "author" ? "author" : "microgenre";
      li.append(name, tag);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        input.value = m.name;
        results.hidden = true;
        startAt(m.id);
      });
      results.appendChild(li);
    }
    results.hidden = false;
  };

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    const matches = state.authorNames
      .filter((n) => n.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // prefix matches first, then alphabetical
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, 20);
    render(matches);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => (results.hidden = true), 120);
  });
}

// starting fresh from search resets the breadcrumb trail
function startAt(id) {
  state.trail = [];
  focus(id, /*fresh=*/ true);
}

// --------------------------------------------------------------- breadcrumb
function renderBreadcrumb() {
  const bar = document.getElementById("breadcrumb");
  bar.innerHTML = "";
  state.trail.forEach((id, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      bar.appendChild(sep);
    }
    const node = state.nodesById.get(id);
    const chip = document.createElement("span");
    chip.className = "crumb " + node.type +
      (i === state.trail.length - 1 ? " current" : "");
    chip.textContent = node.name;
    chip.title = node.type;
    chip.addEventListener("click", () => {
      // truncate trail to this crumb, then re-focus it
      state.trail = state.trail.slice(0, i);
      focus(id);
    });
    bar.appendChild(chip);
  });
}

// caption under the graph: what's shown vs. what exists
function updateFocusMeta(node, nAuthors, nGenres, authorHidden) {
  const meta = document.getElementById("meta");
  const shownAuthors = Math.min(nAuthors, AUTHOR_NEIGHBOR_CAP);
  let s = `<b>${esc(node.name)}</b> — ${shownAuthors} of ${nAuthors} ` +
    `connected author${nAuthors === 1 ? "" : "s"}`;
  if (nGenres) s += `, ${Math.min(nGenres, GENRE_NEIGHBOR_CAP)} microgenre` +
    `${nGenres === 1 ? "" : "s"}`;
  if (authorHidden) s += ` · showing strongest links`;
  meta.innerHTML = s;
  meta.hidden = false;
}

// -------------------------------------------------------------------- focus
function focus(id, fresh) {
  const node = state.nodesById.get(id);
  if (!node) return;
  hint.hidden = true;
  state.focusId = id;

  // append to breadcrumb unless we jumped back to a crumb already there
  const last = state.trail[state.trail.length - 1];
  if (last !== id) state.trail.push(id);
  renderBreadcrumb();

  const neighbors = state.adjacency.get(id) || [];

  // dedupe, split by neighbour type, keep only the strongest by edge weight
  const seen = new Set([id]);
  const authors = [];
  const genres = [];
  for (const { other, edge } of neighbors) {
    if (seen.has(other)) continue;
    seen.add(other);
    const nb = state.nodesById.get(other);
    if (!nb) continue;
    (nb.type === "author" ? authors : genres).push({ nb, edge });
  }
  const byWeight = (a, b) => b.edge.weight - a.edge.weight;
  authors.sort(byWeight);
  genres.sort(byWeight);
  const authorHidden = Math.max(0, authors.length - AUTHOR_NEIGHBOR_CAP);
  const shown = authors.slice(0, AUTHOR_NEIGHBOR_CAP)
    .concat(genres.slice(0, GENRE_NEIGHBOR_CAP));

  // build fresh node/link arrays for the ego network (star around focus)
  const nodes = [{ ...node, isFocus: true }];
  const links = [];
  for (const { nb, edge } of shown) {
    nodes.push({ ...nb });
    links.push({
      source: id,
      target: nb.id,
      type: edge.type,
      weight: edge.weight,
      via: edge.via || null,
    });
  }

  updateFocusMeta(node, authors.length, genres.length, authorHidden);
  draw(nodes, links);
  resetZoom(1);
}

// --------------------------------------------------------------------- draw
function draw(nodes, links, opts = {}) {
  const overview = !!opts.overview;
  const stage = document.getElementById("stage");
  const w = stage.clientWidth;
  const h = stage.clientHeight;

  if (state.sim) state.sim.stop();

  const wExtent = d3.extent(links, (l) => l.weight);
  const strokeScale = d3.scaleSqrt()
    .domain([wExtent[0] || 1, wExtent[1] || 1])
    .range(overview ? [0.4, 3] : [1.2, 6]);

  // --- links ---
  const link = gLinks.selectAll("line")
    .data(links, (d) => (d.source.id || d.source) + "|" + (d.target.id || d.target));
  link.exit().remove();
  const linkEnter = link.enter().append("line")
    .attr("class", (d) => "link " + (d.type === "author-author" ? "aa" : "ag"))
    .on("mousemove", (ev, d) => showEdgeTooltip(ev, d))
    .on("mouseleave", hideTooltip);
  const linkAll = linkEnter.merge(link)
    .attr("stroke-width", (d) => strokeScale(d.weight));

  // --- nodes ---
  const node = gNodes.selectAll("g.node").data(nodes, (d) => d.id);
  node.exit().remove();

  const nodeEnter = node.enter().append("g")
    .attr("class", (d) => "node" + (d.isFocus ? " focus" : ""));

  nodeEnter.each(function (d) {
    const g = d3.select(this);
    if (d.type === "author") {
      g.append("circle").attr("r", d.isFocus ? 13 : overview ? 5 : 9);
    } else {
      const s = d.isFocus ? 22 : overview ? 11 : 16;
      g.append("rect")
        .attr("width", s).attr("height", s)
        .attr("x", -s / 2).attr("y", -s / 2)
        .attr("rx", 4).attr("ry", 4);
    }
    const labelY = d.type === "author"
      ? (d.isFocus ? 26 : overview ? 13 : 20)
      : (d.isFocus ? 30 : overview ? 17 : 24);
    g.append("text")
      .attr("class", "node-label")
      .attr("x", 0).attr("y", labelY)
      .attr("text-anchor", "middle")
      .style("opacity", d.showLabel === false ? 0 : 1)
      .text(d.name);
  });

  const nodeAll = nodeEnter.merge(node)
    .attr("class", (d) => "node" + (d.isFocus ? " focus" : ""));

  // click a node -> drop into its ego view
  nodeAll.on("click", (ev, d) => {
    if (d.id !== state.focusId) focus(d.id);
  });

  // in the crowded overview, hovering reveals a hidden label
  nodeAll.on("mouseenter", function (ev, d) {
    if (d.showLabel === false) d3.select(this).select("text").style("opacity", 1);
  }).on("mouseleave", function (ev, d) {
    if (d.showLabel === false) d3.select(this).select("text").style("opacity", 0);
  });

  nodeAll.call(d3.drag()
    .on("start", (ev, d) => {
      if (!ev.active) state.sim.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on("end", (ev, d) => {
      if (!ev.active) state.sim.alphaTarget(0);
      d.fx = null; d.fy = null;
    }));

  // --- simulation ---
  const focusNode = nodes.find((n) => n.isFocus);
  if (focusNode) { focusNode.fx = w / 2; focusNode.fy = h / 2; }

  state.sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id)
      .distance(overview ? 45 : 110).strength(overview ? 0.25 : 0.5))
    .force("charge", d3.forceManyBody().strength(overview ? -90 : -320))
    .force("collide", d3.forceCollide().radius(overview ? 12 : 34))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .on("tick", () => {
      linkAll
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      nodeAll.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
  state.sim.alpha(0.9).restart();
}

// ------------------------------------------------------------------ tooltip
function showEdgeTooltip(ev, d) {
  let html;
  if (d.type === "author-author") {
    const src = esc(nameOf(d.source));
    const tgt = esc(nameOf(d.target));
    html = `<div class="tt-title">${src} ↔ ${tgt}</div>` +
      `<div class="tt-pair">connected via ${d.weight} similar-book vote` +
      `${d.weight === 1 ? "" : "s"}:</div>`;
    const pairs = (d.via || []).slice(0, 8)
      .map((p) => `<div class="tt-pair">• <b>${esc(p[0])}</b> ↔ <b>${esc(p[1])}</b></div>`)
      .join("");
    html += pairs;
  } else {
    const srcIsGenre = idOf(d.source).startsWith("genre:");
    const author = esc(srcIsGenre ? nameOf(d.target) : nameOf(d.source));
    const genre = esc(srcIsGenre ? nameOf(d.source) : nameOf(d.target));
    html = `<div class="tt-title">${author} → ${genre}</div>` +
      `<div class="tt-pair">shelf affinity weight: ${d.weight.toLocaleString()}</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  positionTooltip(ev);
}

function positionTooltip(ev) {
  const stage = document.getElementById("stage").getBoundingClientRect();
  let x = ev.clientX - stage.left + 14;
  let y = ev.clientY - stage.top + 14;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  if (x + tw > stage.width) x = ev.clientX - stage.left - tw - 14;
  if (y + th > stage.height) y = ev.clientY - stage.top - th - 14;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}

function hideTooltip() {
  tooltip.hidden = true;
}

// -------------------------------------------------------------------- utils
function idOf(nodeOrId) {
  return nodeOrId && nodeOrId.id ? nodeOrId.id : nodeOrId;
}

function nameOf(nodeOrId) {
  const n = state.nodesById.get(idOf(nodeOrId));
  return n ? n.name : idOf(nodeOrId);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// keep the graph centred on window resize
window.addEventListener("resize", () => {
  if (state.focusId) focus(state.focusId);
  else showOverview();
});
