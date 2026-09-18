/**
 * Underground tunnel mansion generator — a maze of SCREEN-SIZED rooms
 * connected ONLY by open arched doorways in shared walls. No hallways.
 * Seeded RNG so restart keeps the same layout.
 *
 * Sizing (level 1..10), tuned for screen-sized chambers. Camera uses
 * CELL=112 (~14×10 tiles visible on 1600×1120) — closer zoom; rooms often
 * need soft follow. Generator sizes (~×7/8 of full viewport at CELL=80):
 *   room size  ~14–19 wide × ~10–14 tall (square or rectangular)
 *   L1 rooms   ~8–20 chambers (ref-map scale; prioritize L1 quality)
 *   map grid   sized to the room cluster + rock border (not 165–290)
 *   dead-ends  ~10% on L1, modest rise per level
 */
window.MazeGen = (function () {
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const TILE = {
    WALL: 1,
    FLOOR: 0,
    EXIT: 2,
    TRAP: 3,
    POTION: 4,
    CLOTH_SHIRT: 5,
    CLOTH_SHOES: 6,
    CLOTH_PANTS: 7,
    KEY: 8,
    CHEST: 9
  };

  const KEYS_REQUIRED = 3;

  function levelParams(level) {
    const lv = Math.max(1, level | 0);
    const t = Math.min(lv, 10);
    // L1 ~12 rooms (ref-map order); modest growth — still screen-sized chambers
    const roomCount = Math.max(
      8,
      Math.round(12 + (t - 1) * 0.7 + (lv > 10 ? (lv - 10) * 0.4 : 0))
    );
    const avgW = 17;
    const avgH = 13;
    const colsAcross = Math.max(3, Math.round(Math.sqrt(roomCount)));
    const rowsDown = Math.max(3, Math.ceil(roomCount / colsAcross));
    const margin = 4;
    const cols = colsAcross * avgW + (colsAcross - 1) + margin * 2;
    const rows = rowsDown * avgH + (rowsDown - 1) + margin * 2;
    const deadEndRate = Math.min(
      0.28,
      0.1 + 0.015 * (t - 1) + (lv > 10 ? 0.01 * Math.min(lv - 10, 5) : 0)
    );
    return { cols: cols, rows: rows, roomCount: roomCount, deadEndRate: deadEndRate, level: lv };
  }

  function carveRect(grid, x0, y0, w, h) {
    const rows = grid.length;
    const cols = grid[0].length;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (y > 0 && x > 0 && y < rows - 1 && x < cols - 1) {
          grid[y][x] = TILE.FLOOR;
        }
      }
    }
  }

  function roomCenter(r) {
    return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
  }

  function inRoom(r, x, y) {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }

  function mazeRoomOf(rooms, x, y) {
    for (let i = 0; i < rooms.length; i++) {
      if (inRoom(rooms[i], x, y)) return rooms[i];
    }
    return null;
  }

  /** BSP: screen-sized leaves (~14–19 × ~10–14) separated by 1-tile shared walls. */
  function bspPartition(root, targetLeaves, rng) {
    const minW = 12;
    const minH = 10;
    const preferW = 16;
    const preferH = 12;
    const softMaxW = 19;
    const softMaxH = 14;
    const hardMaxW = 23;
    const hardMaxH = 18;
    const leaves = [];

    function softOver(node) {
      return node.w > softMaxW || node.h > softMaxH;
    }
    function hardOver(node) {
      return node.w > hardMaxW || node.h > hardMaxH;
    }
    function canSplitW(node) {
      return node.w >= minW * 2 + 1;
    }
    function canSplitH(node) {
      return node.h >= minH * 2 + 1;
    }

    /** Pick a split so both children land near the prefer band when possible. */
    function chooseSplitX(node) {
      const minSplit = node.x + minW;
      const maxSplit = node.x + node.w - minW - 1;
      if (minSplit > maxSplit) return null;
      // Ideal: left width ≈ preferW (or half if parent is only slightly large)
      const idealLeft = Math.min(
        softMaxW,
        Math.max(minW, Math.min(preferW, Math.floor((node.w - 1) / 2)))
      );
      let splitX = node.x + idealLeft;
      if (splitX < minSplit) splitX = minSplit;
      if (splitX > maxSplit) splitX = maxSplit;
      // Jitter within ±2 while staying valid
      const jitter = Math.floor(rng() * 5) - 2;
      splitX = Math.max(minSplit, Math.min(maxSplit, splitX + jitter));
      return splitX;
    }

    function chooseSplitY(node) {
      const minSplit = node.y + minH;
      const maxSplit = node.y + node.h - minH - 1;
      if (minSplit > maxSplit) return null;
      const idealTop = Math.min(
        softMaxH,
        Math.max(minH, Math.min(preferH, Math.floor((node.h - 1) / 2)))
      );
      let splitY = node.y + idealTop;
      if (splitY < minSplit) splitY = minSplit;
      if (splitY > maxSplit) splitY = maxSplit;
      const jitter = Math.floor(rng() * 5) - 2;
      splitY = Math.max(minSplit, Math.min(maxSplit, splitY + jitter));
      return splitY;
    }

    function doSplit(node) {
      const needW = node.w > softMaxW && canSplitW(node);
      const needH = node.h > softMaxH && canSplitH(node);
      let horizontal;
      if (needW && needH) {
        horizontal = node.h / softMaxH > node.w / softMaxW;
      } else if (needH) {
        horizontal = true;
      } else if (needW) {
        horizontal = false;
      } else if (canSplitW(node) && canSplitH(node)) {
        horizontal = node.h > node.w * 1.1 ? true : node.w > node.h * 1.1 ? false : rng() < 0.5;
      } else {
        horizontal = canSplitH(node);
      }

      if (!horizontal && canSplitW(node)) {
        const splitX = chooseSplitX(node);
        if (splitX == null) return null;
        return [
          { x: node.x, y: node.y, w: splitX - node.x, h: node.h },
          { x: splitX + 1, y: node.y, w: node.x + node.w - splitX - 1, h: node.h }
        ];
      }
      if (canSplitH(node)) {
        const splitY = chooseSplitY(node);
        if (splitY == null) return null;
        return [
          { x: node.x, y: node.y, w: node.w, h: splitY - node.y },
          { x: node.x, y: splitY + 1, w: node.w, h: node.y + node.h - splitY - 1 }
        ];
      }
      if (canSplitW(node)) {
        const splitX = chooseSplitX(node);
        if (splitX == null) return null;
        return [
          { x: node.x, y: node.y, w: splitX - node.x, h: node.h },
          { x: splitX + 1, y: node.y, w: node.x + node.w - splitX - 1, h: node.h }
        ];
      }
      return null;
    }

    function split(node, depth) {
      const can = canSplitW(node) || canSplitH(node);
      const must = hardOver(node) && can;
      const wantMore = leaves.length + 1 < targetLeaves;
      const soft = softOver(node) && can && (wantMore || depth < 2);
      const stop =
        !can ||
        (!must && !soft && !wantMore && depth > 0) ||
        (!must && !wantMore && softOver(node) === false && depth > 0) ||
        (!must && depth > 3 && leaves.length >= targetLeaves);

      if (stop && !must) {
        leaves.push(node);
        return;
      }
      const kids = doSplit(node);
      if (!kids) {
        leaves.push(node);
        return;
      }
      split(kids[0], depth + 1);
      split(kids[1], depth + 1);
    }

    split(root, 0);

    // Guarantee nothing past hard max; prefer soft max while under ~20 rooms for L1-scale
    let guard = 0;
    while (guard++ < 400) {
      leaves.sort(function (a, b) {
        return b.w * b.h - a.w * a.h;
      });
      const node = leaves[0];
      const must = hardOver(node) && (canSplitW(node) || canSplitH(node));
      const soft =
        softOver(node) &&
        (canSplitW(node) || canSplitH(node)) &&
        leaves.length < Math.max(targetLeaves, Math.min(20, targetLeaves + 4));
      if (!must && !soft) break;
      if (!must && leaves.length >= 20) break;
      const kids = doSplit(node);
      if (!kids) break;
      leaves.shift();
      leaves.push(kids[0], kids[1]);
    }
    return leaves;
  }

  function sharedWall(a, b) {
    if (a.x + a.w + 1 === b.x) {
      const lo = Math.max(a.y, b.y) + 1;
      const hi = Math.min(a.y + a.h, b.y + b.h) - 2;
      if (hi - lo >= 1) return { dir: "v", wall: a.x + a.w, lo: lo, hi: hi };
    }
    if (b.x + b.w + 1 === a.x) {
      const lo = Math.max(a.y, b.y) + 1;
      const hi = Math.min(a.y + a.h, b.y + b.h) - 2;
      if (hi - lo >= 1) return { dir: "v", wall: b.x + b.w, lo: lo, hi: hi };
    }
    if (a.y + a.h + 1 === b.y) {
      const lo = Math.max(a.x, b.x) + 1;
      const hi = Math.min(a.x + a.w, b.x + b.w) - 2;
      if (hi - lo >= 1) return { dir: "h", wall: a.y + a.h, lo: lo, hi: hi };
    }
    if (b.y + b.h + 1 === a.y) {
      const lo = Math.max(a.x, b.x) + 1;
      const hi = Math.min(a.x + a.w, b.x + b.w) - 2;
      if (hi - lo >= 1) return { dir: "h", wall: b.y + b.h, lo: lo, hi: hi };
    }
    return null;
  }

  function carveDoorway(grid, edge, rng) {
    const span = edge.hi - edge.lo + 1;
    if (span < 2) return null;
    // Open arches: typically 3 tiles, sometimes 4 on long shared walls
    const width = Math.min(span, span >= 5 ? (rng() < 0.45 ? 4 : 3) : span >= 3 ? 3 : 2);
    let start;
    if (rng() < 0.55) {
      start = edge.lo + Math.floor(rng() * (span - width + 1));
    } else {
      start = rng() < 0.5 ? edge.lo : edge.hi - width + 1;
      if (start < edge.lo) start = edge.lo;
      if (start > edge.hi - width + 1) start = edge.hi - width + 1;
    }
    const cells = [];
    if (edge.dir === "v") {
      const x = edge.wall;
      for (let y = start; y < start + width; y++) {
        if (y > 0 && y < grid.length - 1 && x > 0 && x < grid[0].length - 1) {
          grid[y][x] = TILE.FLOOR;
          cells.push({ x: x, y: y });
        }
      }
    } else {
      const y = edge.wall;
      for (let x = start; x < start + width; x++) {
        if (y > 0 && y < grid.length - 1 && x > 0 && x < grid[0].length - 1) {
          grid[y][x] = TILE.FLOOR;
          cells.push({ x: x, y: y });
        }
      }
    }
    return cells.length ? cells : null;
  }

  function buildAdjacency(rooms) {
    const edges = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const w = sharedWall(rooms[i], rooms[j]);
        if (w) edges.push({ i: i, j: j, wall: w });
      }
    }
    return edges;
  }

  function ufMake(n) {
    const p = Array.from({ length: n }, function (_, i) {
      return i;
    });
    const r = Array(n).fill(0);
    return {
      find: function (x) {
        while (p[x] !== x) {
          p[x] = p[p[x]];
          x = p[x];
        }
        return x;
      },
      union: function (a, b) {
        a = this.find(a);
        b = this.find(b);
        if (a === b) return false;
        if (r[a] < r[b]) p[a] = b;
        else if (r[a] > r[b]) p[b] = a;
        else {
          p[b] = a;
          r[a]++;
        }
        return true;
      },
      same: function (a, b) {
        return this.find(a) === this.find(b);
      }
    };
  }

  function degreeMap(selected, n) {
    const deg = Array(n).fill(0);
    for (let i = 0; i < selected.length; i++) {
      deg[selected[i].i]++;
      deg[selected[i].j]++;
    }
    return deg;
  }

  function countPathsToExit(n, selected, startIdx, exitIdx, need) {
    const adj = Array.from({ length: n }, function () {
      return [];
    });
    for (let ei = 0; ei < selected.length; ei++) {
      const e = selected[ei];
      adj[e.i].push({ to: e.j, ei: ei });
      adj[e.j].push({ to: e.i, ei: ei });
    }
    let found = 0;
    const blocked = new Uint8Array(selected.length);
    for (let attempt = 0; attempt < need + 2; attempt++) {
      const prev = Array(n).fill(-1);
      const prevE = Array(n).fill(-1);
      const q = [startIdx];
      prev[startIdx] = startIdx;
      let qi = 0;
      let reached = false;
      while (qi < q.length) {
        const u = q[qi++];
        if (u === exitIdx) {
          reached = true;
          break;
        }
        for (let k = 0; k < adj[u].length; k++) {
          const edge = adj[u][k];
          if (blocked[edge.ei]) continue;
          if (prev[edge.to] !== -1) continue;
          prev[edge.to] = u;
          prevE[edge.to] = edge.ei;
          q.push(edge.to);
        }
      }
      if (!reached) break;
      found++;
      let cur = exitIdx;
      while (cur !== startIdx) {
        const ei = prevE[cur];
        if (ei < 0) break;
        blocked[ei] = 1;
        cur = prev[cur];
      }
    }
    return found;
  }

  function hasEdge(selected, i, j) {
    for (let k = 0; k < selected.length; k++) {
      const s = selected[k];
      if ((s.i === i && s.j === j) || (s.i === j && s.j === i)) return true;
    }
    return false;
  }

  function selectDoorways(rooms, allEdges, startIdx, exitIdx, deadEndRate, rng) {
    const n = rooms.length;
    const targetDead = Math.max(1, Math.round(n * deadEndRate));
    const edges = allEdges.slice();
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = edges[i];
      edges[i] = edges[j];
      edges[j] = tmp;
    }

    function scoreEdge(e) {
      let s = rng() * 0.5;
      if (e.i === exitIdx || e.j === exitIdx) s += 2;
      if (e.i === startIdx || e.j === startIdx) s += 0.8;
      if (e.wall.dir === "v") s += 0.35;
      return s;
    }
    edges.sort(function (a, b) {
      return scoreEdge(b) - scoreEdge(a);
    });

    const selected = [];
    const uf = ufMake(n);

    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (i === startIdx || i === exitIdx) continue;
      const c = roomCenter(rooms[i]);
      let maxX = 0,
        maxY = 0;
      for (let ri = 0; ri < rooms.length; ri++) {
        maxX = Math.max(maxX, rooms[ri].x + rooms[ri].w);
        maxY = Math.max(maxY, rooms[ri].y + rooms[ri].h);
      }
      const distEdge = Math.min(c.x, c.y, maxX - c.x, maxY - c.y);
      candidates.push({ i: i, score: distEdge + rng() });
    }
    candidates.sort(function (a, b) {
      return a.score - b.score;
    });
    const deadSet = {};
    for (let i = 0; i < Math.min(targetDead, candidates.length); i++) {
      deadSet[candidates[i].i] = true;
    }

    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (deadSet[e.i] || deadSet[e.j]) continue;
      if (uf.union(e.i, e.j)) selected.push(e);
    }

    const deadIds = Object.keys(deadSet).map(Number);
    for (let di = 0; di < deadIds.length; di++) {
      const d = deadIds[di];
      const opts = edges.filter(function (e) {
        return (e.i === d || e.j === d) && !hasEdge(selected, e.i, e.j);
      });
      opts.sort(function (a, b) {
        const aOther = a.i === d ? a.j : a.i;
        const bOther = b.i === d ? b.j : b.i;
        const aOk = !deadSet[aOther] ? 1 : 0;
        const bOk = !deadSet[bOther] ? 1 : 0;
        return bOk - aOk || rng() - 0.5;
      });
      let attached = false;
      for (let oi = 0; oi < opts.length; oi++) {
        const e = opts[oi];
        const other = e.i === d ? e.j : e.i;
        if (deadSet[other] && opts.length > 1) continue;
        if (uf.union(e.i, e.j)) {
          selected.push(e);
          attached = true;
          break;
        }
      }
      if (!attached && opts.length) {
        selected.push(opts[0]);
        uf.union(opts[0].i, opts[0].j);
      }
    }

    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (uf.same(e.i, e.j)) continue;
      const deg = degreeMap(selected, n);
      if (deadSet[e.i] && deg[e.i] >= 1) continue;
      if (deadSet[e.j] && deg[e.j] >= 1) continue;
      if (uf.union(e.i, e.j)) selected.push(e);
    }

    const exitEdges = edges.filter(function (e) {
      return e.i === exitIdx || e.j === exitIdx;
    });
    for (let ei = 0; ei < exitEdges.length; ei++) {
      const e = exitEdges[ei];
      const deg = degreeMap(selected, n);
      if (deg[exitIdx] >= 3) break;
      const other = e.i === exitIdx ? e.j : e.i;
      if (deadSet[other]) continue;
      if (hasEdge(selected, e.i, e.j)) continue;
      selected.push(e);
    }

    let loops = 0;
    const loopTarget = Math.max(3, Math.floor(n * 0.35));
    for (let ei = 0; ei < edges.length; ei++) {
      if (loops >= loopTarget) break;
      const e = edges[ei];
      if (deadSet[e.i] || deadSet[e.j]) continue;
      if (hasEdge(selected, e.i, e.j)) continue;
      if (uf.same(e.i, e.j)) {
        selected.push(e);
        loops++;
      }
    }

    // Ensure exit degree >= 3 when possible (helps alternate routes)
    {
      const exitOpts = edges.filter(function (e) {
        return (e.i === exitIdx || e.j === exitIdx) && !hasEdge(selected, e.i, e.j);
      });
      for (let ei = 0; ei < exitOpts.length; ei++) {
        const deg = degreeMap(selected, n);
        if (deg[exitIdx] >= 4) break;
        const e = exitOpts[ei];
        const other = e.i === exitIdx ? e.j : e.i;
        if (deadSet[other]) continue;
        selected.push(e);
      }
    }

    // Ensure start degree >= 2
    {
      const startOpts = edges.filter(function (e) {
        return (e.i === startIdx || e.j === startIdx) && !hasEdge(selected, e.i, e.j);
      });
      for (let ei = 0; ei < startOpts.length; ei++) {
        const deg = degreeMap(selected, n);
        if (deg[startIdx] >= 3) break;
        const e = startOpts[ei];
        const other = e.i === startIdx ? e.j : e.i;
        if (deadSet[other]) continue;
        selected.push(e);
      }
    }

    let paths = countPathsToExit(n, selected, startIdx, exitIdx, 3);
    let boostGuard = 0;
    while (paths < 3 && boostGuard++ < 80) {
      let added = false;
      // Prefer unused edges near the exit or that bridge high-degree nodes
      const scored = [];
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        if (deadSet[e.i] || deadSet[e.j]) continue;
        if (hasEdge(selected, e.i, e.j)) continue;
        let s = rng();
        if (e.i === exitIdx || e.j === exitIdx) s += 5;
        if (e.i === startIdx || e.j === startIdx) s += 2;
        if (e.wall && e.wall.dir === "v") s += 0.5;
        scored.push({ e: e, s: s });
      }
      scored.sort(function (a, b) {
        return b.s - a.s;
      });
      if (scored.length) {
        selected.push(scored[0].e);
        added = true;
      }
      if (!added) break;
      paths = countPathsToExit(n, selected, startIdx, exitIdx, 3);
    }

    return selected;
  }

  function placeSideDecorations(rooms, grid, rng, startRoom, exitRoom) {
    const decorations = [];
    const paintingThemes = ["tickle", "feather", "laugh", "ribbon"];
    for (let ri = 0; ri < rooms.length; ri++) {
      const r = rooms[ri];
      const furnSides = [
        { side: "n", facing: "s" },
        { side: "s", facing: "n" },
        { side: "w", facing: "e" },
        { side: "e", facing: "w" }
      ];
      // Side-only décor; more pieces in screen-sized rooms, center stays clear
      const count = 4 + Math.floor(rng() * 4);
      for (let fi = 0; fi < count; fi++) {
        const s = furnSides[Math.floor(rng() * 4)];
        let fx, fy, fw, fh;
        if (s.side === "n") {
          fw = 1 + Math.floor(rng() * 2);
          fh = 1;
          fx = r.x + 3 + Math.floor(rng() * Math.max(1, r.w - fw - 6));
          fy = r.y;
        } else if (s.side === "s") {
          fw = 1 + Math.floor(rng() * 2);
          fh = 1;
          fx = r.x + 3 + Math.floor(rng() * Math.max(1, r.w - fw - 6));
          fy = r.y + r.h - 1;
        } else if (s.side === "w") {
          fw = 1;
          fh = 1 + Math.floor(rng() * 2);
          fx = r.x;
          fy = r.y + 3 + Math.floor(rng() * Math.max(1, r.h - fh - 6));
        } else {
          fw = 1;
          fh = 1 + Math.floor(rng() * 2);
          fx = r.x + r.w - 1;
          fy = r.y + 3 + Math.floor(rng() * Math.max(1, r.h - fh - 6));
        }
        let ok = true;
        for (let yy = fy; yy < fy + fh && ok; yy++) {
          for (let xx = fx; xx < fx + fw; xx++) {
            if (!grid[yy] || grid[yy][xx] === TILE.WALL) ok = false;
          }
        }
        if (!ok) continue;
        const roll = rng();
        let type, style, theme;
        if (roll < 0.32) {
          type = "painting";
          style = Math.floor(rng() * paintingThemes.length);
          theme = paintingThemes[style];
        } else if (roll < 0.58) {
          type = "furniture";
          style = 0; // bookshelf
          theme = null;
        } else if (roll < 0.86) {
          type = "furniture";
          style = 1; // cabinet / dresser
          theme = null;
        } else {
          type = "furniture";
          style = 3; // pedestal / urn accent
          theme = null;
        }
        decorations.push({
          type: type,
          x: fx,
          y: fy,
          w: fw,
          h: fh,
          facing: s.facing,
          style: style,
          theme: theme
        });
      }
      if (rng() < 0.45) {
        const corners = [
          { x: r.x, y: r.y },
          { x: r.x + r.w - 1, y: r.y },
          { x: r.x, y: r.y + r.h - 1 },
          { x: r.x + r.w - 1, y: r.y + r.h - 1 }
        ];
        const c = corners[Math.floor(rng() * 4)];
        if (grid[c.y] && grid[c.y][c.x] !== TILE.WALL) {
          decorations.push({ type: "cobweb", x: c.x, y: c.y });
        }
      }
    }

    if (startRoom) {
      const sw = Math.min(5, Math.max(3, Math.floor(startRoom.w / 4)));
      const sx = startRoom.x + Math.floor((startRoom.w - sw) / 2);
      decorations.push({
        type: "entranceGate",
        x: sx,
        y: startRoom.y,
        w: sw,
        h: 2,
        gate: "entrance"
      });
      // Flanking torches for portcullis feel (also added to torches later if needed)
      decorations.push({
        type: "gateTorch",
        x: sx - 1,
        y: startRoom.y + 1
      });
      decorations.push({
        type: "gateTorch",
        x: sx + sw,
        y: startRoom.y + 1
      });
    }
    if (exitRoom) {
      const sw = Math.min(5, Math.max(3, Math.floor(exitRoom.w / 4)));
      const sx = exitRoom.x + Math.floor((exitRoom.w - sw) / 2);
      decorations.push({
        type: "exitGate",
        x: sx,
        y: exitRoom.y + exitRoom.h - 2,
        w: sw,
        h: 2,
        gate: "exit"
      });
      decorations.push({
        type: "gateTorch",
        x: sx - 1,
        y: exitRoom.y + exitRoom.h - 2
      });
      decorations.push({
        type: "gateTorch",
        x: sx + sw,
        y: exitRoom.y + exitRoom.h - 2
      });
    }
    return decorations;
  }

  function punchRockLink(grid, rooms, i, j, cols, rows) {
    const a = rooms[i];
    const b = rooms[j];
    const ac = roomCenter(a);
    const bc = roomCenter(b);
    if (Math.abs(ac.x - bc.x) > Math.abs(ac.y - bc.y)) {
      const yLo = Math.max(a.y + 1, b.y + 1);
      const yHi = Math.min(a.y + a.h - 2, b.y + b.h - 2);
      const yy = yLo <= yHi ? yLo + Math.floor((yHi - yLo) / 2) : ac.y;
      const x0 = Math.min(ac.x, bc.x);
      const x1 = Math.max(ac.x, bc.x);
      for (let x = x0; x <= x1; x++) {
        if (yy > 0 && yy < rows - 1 && x > 0 && x < cols - 1) {
          grid[yy][x] = TILE.FLOOR;
          if (yy + 1 < rows - 1) grid[yy + 1][x] = TILE.FLOOR;
        }
      }
    } else {
      const xLo = Math.max(a.x + 1, b.x + 1);
      const xHi = Math.min(a.x + a.w - 2, b.x + b.w - 2);
      const xx = xLo <= xHi ? xLo + Math.floor((xHi - xLo) / 2) : ac.x;
      const y0 = Math.min(ac.y, bc.y);
      const y1 = Math.max(ac.y, bc.y);
      for (let y = y0; y <= y1; y++) {
        if (xx > 0 && xx < cols - 1 && y > 0 && y < rows - 1) {
          grid[y][xx] = TILE.FLOOR;
          if (xx + 1 < cols - 1) grid[y][xx + 1] = TILE.FLOOR;
        }
      }
    }
  }

  function generate(colsHint, rowsHint, seed, level) {
    const params = levelParams(level || 1);
    const cols = params.cols;
    const rows = params.rows;
    const rng = mulberry32((seed >>> 0) ^ ((level | 0) * 0x9e3779b9));
    const grid = Array.from({ length: rows }, function () {
      return Array(cols).fill(TILE.WALL);
    });

    const margin = 4;
    const root = {
      x: margin,
      y: margin,
      w: cols - 2 * margin,
      h: rows - 2 * margin
    };

    let leaves = bspPartition(root, params.roomCount, rng);
    if (leaves.length < 5) leaves = bspPartition(root, Math.max(8, params.roomCount), rng);

    const rooms = leaves.map(function (r, i) {
      return { x: r.x, y: r.y, w: r.w, h: r.h, name: "r" + i };
    });

    for (let i = 0; i < rooms.length; i++) {
      carveRect(grid, rooms[i].x, rooms[i].y, rooms[i].w, rooms[i].h);
    }

    let startIdx = 0;
    let bestTop = Infinity;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      const score = r.y * 1000 + Math.abs(roomCenter(r).x - cols / 2);
      if (score < bestTop) {
        bestTop = score;
        startIdx = i;
      }
    }
    let exitIdx = 0;
    let bestBot = -Infinity;
    for (let i = 0; i < rooms.length; i++) {
      if (i === startIdx) continue;
      const r = rooms[i];
      const score = (r.y + r.h) * 1000 - Math.abs(roomCenter(r).x - cols / 2) * 0.25;
      if (score > bestBot) {
        bestBot = score;
        exitIdx = i;
      }
    }
    if (exitIdx === startIdx) exitIdx = (startIdx + 1) % rooms.length;
    rooms[startIdx].name = "entrance";
    rooms[exitIdx].name = "exit";

    const allEdges = buildAdjacency(rooms);
    const ufAdj = ufMake(rooms.length);
    for (let i = 0; i < allEdges.length; i++) ufAdj.union(allEdges[i].i, allEdges[i].j);
    // Join every adjacency component to the entrance component (live UF root —
    // do not cache find() across unions; rank can re-parent the old root).
    let linkGuard = 0;
    while (linkGuard++ < rooms.length + 8) {
      const main = ufAdj.find(startIdx);
      let orphan = -1;
      for (let i = 0; i < rooms.length; i++) {
        if (ufAdj.find(i) !== main) {
          orphan = i;
          break;
        }
      }
      if (orphan < 0) break;
      let best = null;
      let bestD = Infinity;
      for (let j = 0; j < rooms.length; j++) {
        if (ufAdj.find(j) !== main) continue;
        const ca = roomCenter(rooms[orphan]);
        const cb = roomCenter(rooms[j]);
        const d = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (best == null) break;
      punchRockLink(grid, rooms, orphan, best, cols, rows);
      ufAdj.union(orphan, best);
      const sw = sharedWall(rooms[orphan], rooms[best]);
      allEdges.push({
        i: orphan,
        j: best,
        wall:
          sw || {
            dir: "v",
            wall: roomCenter(rooms[orphan]).x,
            lo: roomCenter(rooms[orphan]).y,
            hi: roomCenter(rooms[orphan]).y + 1
          }
      });
    }

    const selected = selectDoorways(rooms, allEdges, startIdx, exitIdx, params.deadEndRate, rng);
    for (let i = 0; i < selected.length; i++) {
      const e = selected[i];
      if (e.wall && (e.wall.dir === "v" || e.wall.dir === "h") && e.wall.lo != null) {
        carveDoorway(grid, e.wall, rng);
      }
    }

    // Guarantee start can walk to every room center (and thus the exit) on the grid.
    (function ensureWalkableGraph() {
      function reachableSet(fromX, fromY) {
        const seen = {};
        const q = [fromX + "," + fromY];
        seen[q[0]] = true;
        let qi = 0;
        while (qi < q.length) {
          const parts = q[qi++].split(",");
          const x = +parts[0];
          const y = +parts[1];
          const nbs = [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1]
          ];
          for (let ni = 0; ni < 4; ni++) {
            const nx = nbs[ni][0];
            const ny = nbs[ni][1];
            if (ny < 1 || nx < 1 || ny >= rows - 1 || nx >= cols - 1) continue;
            if (grid[ny][nx] === TILE.WALL) continue;
            const key = nx + "," + ny;
            if (seen[key]) continue;
            seen[key] = true;
            q.push(key);
          }
        }
        return seen;
      }
      let guard = 0;
      while (guard++ < rooms.length + 4) {
        const sc = roomCenter(rooms[startIdx]);
        const seen = reachableSet(sc.x, sc.y);
        let orphan = -1;
        let bestD = Infinity;
        for (let i = 0; i < rooms.length; i++) {
          const c = roomCenter(rooms[i]);
          if (seen[c.x + "," + c.y]) continue;
          const d = Math.abs(c.x - sc.x) + Math.abs(c.y - sc.y);
          if (d < bestD) {
            bestD = d;
            orphan = i;
          }
        }
        if (orphan < 0) break;
        // Link orphan to nearest already-reachable room.
        let best = startIdx;
        let bestJD = Infinity;
        for (let j = 0; j < rooms.length; j++) {
          const c = roomCenter(rooms[j]);
          if (!seen[c.x + "," + c.y]) continue;
          const oc = roomCenter(rooms[orphan]);
          const d = Math.abs(c.x - oc.x) + Math.abs(c.y - oc.y);
          if (d < bestJD) {
            bestJD = d;
            best = j;
          }
        }
        punchRockLink(grid, rooms, orphan, best, cols, rows);
        const sw = sharedWall(rooms[orphan], rooms[best]);
        if (sw) carveDoorway(grid, sw, rng);
      }
    })();

    const startRoom = rooms[startIdx];
    const exitRoom = rooms[exitIdx];
    const start = {
      x: startRoom.x + Math.floor(startRoom.w / 2),
      y: startRoom.y + 1
    };
    grid[start.y][start.x] = TILE.FLOOR;

    const exitCell = {
      x: exitRoom.x + Math.floor(exitRoom.w / 2),
      y: exitRoom.y + exitRoom.h - 2
    };
    grid[exitCell.y][exitCell.x] = TILE.EXIT;

    const decorations = placeSideDecorations(rooms, grid, rng, startRoom, exitRoom);

    const floors = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y][x] !== TILE.WALL) floors.push({ x: x, y: y });
      }
    }

    function takeFarFrom(px, py, minDist) {
      const candidates = floors.filter(function (c) {
        return Math.abs(c.x - px) + Math.abs(c.y - py) >= minDist;
      });
      const pool = candidates.length ? candidates : floors.slice();
      if (!pool.length) return null;
      const i = Math.floor(rng() * pool.length);
      const picked = pool[i];
      for (let fi = floors.length - 1; fi >= 0; fi--) {
        if (floors[fi].x === picked.x && floors[fi].y === picked.y) {
          floors.splice(fi, 1);
          break;
        }
      }
      return picked;
    }

    function takeInRoom(room, avoid, minDist) {
      const pool = [];
      for (let i = floors.length - 1; i >= 0; i--) {
        const c = floors[i];
        if (!inRoom(room, c.x, c.y)) continue;
        if (c.x <= room.x || c.x >= room.x + room.w - 1) continue;
        if (c.y <= room.y || c.y >= room.y + room.h - 1) continue;
        if (Math.abs(c.x - avoid.x) + Math.abs(c.y - avoid.y) < minDist) continue;
        pool.push({ c: c, i: i });
      }
      if (!pool.length) return null;
      const pick = pool[Math.floor(rng() * pool.length)];
      floors.splice(pick.i, 1);
      return pick.c;
    }

    for (let i = floors.length - 1; i >= 0; i--) {
      if (
        (floors[i].x === start.x && floors[i].y === start.y) ||
        (floors[i].x === exitCell.x && floors[i].y === exitCell.y)
      ) {
        floors.splice(i, 1);
      }
    }

    // At least 5 traps on L1; more each level (hard to see but present)
    const trapTarget = 5 + Math.max(0, params.level - 1) * 2;
    const traps = [];
    const trapMinSpacing = 6;
    const trapRooms = rooms.filter(function (_, i) {
      return i !== startIdx;
    });
    let trapGuard = 0;
    while (traps.length < trapTarget && trapGuard++ < trapTarget * 40) {
      let t = null;
      if (trapRooms.length) {
        t = takeInRoom(trapRooms[Math.floor(rng() * trapRooms.length)], start, 5);
      }
      if (!t) t = takeFarFrom(start.x, start.y, 8);
      if (!t) break;
      let spaced = true;
      for (let ti = 0; ti < traps.length; ti++) {
        if (Math.abs(traps[ti].x - t.x) + Math.abs(traps[ti].y - t.y) < trapMinSpacing) {
          spaced = false;
          break;
        }
      }
      if (!spaced) {
        // put cell back into floors so we can keep trying
        floors.push(t);
        continue;
      }
      grid[t.y][t.x] = TILE.TRAP;
      traps.push(t);
    }

    let potion = null;
    const potionRooms = rooms.filter(function (_, i) {
      return i !== startIdx;
    });
    if (potionRooms.length) {
      potion = takeInRoom(potionRooms[Math.floor(rng() * potionRooms.length)], start, 6);
    }
    if (!potion) potion = takeFarFrom(start.x, start.y, 10);
    if (potion) grid[potion.y][potion.x] = TILE.POTION;

    const clothTiles = [TILE.CLOTH_SHIRT, TILE.CLOTH_SHOES, TILE.CLOTH_PANTS];
    const clothPickups = [];
    for (let ci = 0; ci < clothTiles.length; ci++) {
      const ct = clothTiles[ci];
      const nonStart = rooms.filter(function (_, i) {
        return i !== startIdx;
      });
      let c = null;
      if (nonStart.length) c = takeInRoom(nonStart[Math.floor(rng() * nonStart.length)], start, 5);
      if (!c) c = takeFarFrom(start.x, start.y, 8);
      if (!c) break;
      grid[c.y][c.x] = ct;
      clothPickups.push({ x: c.x, y: c.y, tile: ct });
    }

    // Exactly KEYS_REQUIRED keys, strongly scattered (large min distance; never adjacent/cluster)
    const keyPickups = [];
    const keyRooms = rooms.filter(function (_, i) {
      return i !== startIdx && i !== exitIdx;
    });
    const keyCandidates = [];
    const kr = keyRooms.length ? keyRooms : rooms;
    for (let ri = 0; ri < kr.length; ri++) {
      const r = kr[ri];
      for (let i = 0; i < floors.length; i++) {
        const c = floors[i];
        if (!inRoom(r, c.x, c.y)) continue;
        if (c.x <= r.x || c.x >= r.x + r.w - 1) continue;
        if (c.y <= r.y || c.y >= r.y + r.h - 1) continue;
        keyCandidates.push(c);
      }
    }
    // Prefer large separation: start far from entrance; keys far from each other & exit
    const mapSpan = Math.max(cols, rows);
    let minKeyDist = Math.max(14, Math.floor(mapSpan * 0.28));
    const minKeyFromStart = Math.max(12, Math.floor(mapSpan * 0.22));
    const minKeyFromExit = 8;
    const pickedKeys = [];

    function keyOk(c, minPeer) {
      const ds = Math.abs(c.x - start.x) + Math.abs(c.y - start.y);
      if (ds < minKeyFromStart) return false;
      const de = Math.abs(c.x - exitCell.x) + Math.abs(c.y - exitCell.y);
      if (de < minKeyFromExit) return false;
      for (let p = 0; p < pickedKeys.length; p++) {
        const d = Math.abs(c.x - pickedKeys[p].x) + Math.abs(c.y - pickedKeys[p].y);
        if (d < minPeer) return false;
        // Never same/adjacent tiles
        if (d < 2) return false;
      }
      return true;
    }

    function removeCandidate(c) {
      for (let fi = floors.length - 1; fi >= 0; fi--) {
        if (floors[fi].x === c.x && floors[fi].y === c.y) {
          floors.splice(fi, 1);
          break;
        }
      }
      for (let ci = keyCandidates.length - 1; ci >= 0; ci--) {
        if (keyCandidates[ci].x === c.x && keyCandidates[ci].y === c.y) {
          keyCandidates.splice(ci, 1);
        }
      }
    }

    // Retry with relaxed spacing if the map cannot satisfy the strict minimum
    for (let attempt = 0; attempt < 8 && pickedKeys.length < KEYS_REQUIRED; attempt++) {
      const peerNeed = Math.max(2, minKeyDist - attempt * 2);
      const sampleN = Math.min(keyCandidates.length, 600);
      for (let ki = pickedKeys.length; ki < KEYS_REQUIRED; ki++) {
        if (!keyCandidates.length) break;
        let best = null;
        let bestScore = -1;
        for (let s = 0; s < sampleN; s++) {
          const c = keyCandidates[Math.floor(rng() * keyCandidates.length)];
          if (!keyOk(c, peerNeed)) continue;
          let minD = Infinity;
          if (!pickedKeys.length) {
            minD = Math.abs(c.x - start.x) + Math.abs(c.y - start.y);
          } else {
            for (let p = 0; p < pickedKeys.length; p++) {
              const d = Math.abs(c.x - pickedKeys[p].x) + Math.abs(c.y - pickedKeys[p].y);
              if (d < minD) minD = d;
            }
          }
          // Prefer different rooms when possible
          let roomBonus = 0;
          for (let p = 0; p < pickedKeys.length; p++) {
            const sameRoom =
              mazeRoomOf(rooms, c.x, c.y) &&
              mazeRoomOf(rooms, pickedKeys[p].x, pickedKeys[p].y) &&
              mazeRoomOf(rooms, c.x, c.y) === mazeRoomOf(rooms, pickedKeys[p].x, pickedKeys[p].y);
            if (sameRoom) roomBonus -= 8;
            else roomBonus += 2;
          }
          const score = minD + roomBonus;
          if (score > bestScore) {
            bestScore = score;
            best = c;
          }
        }
        if (!best) break;
        pickedKeys.push(best);
        grid[best.y][best.x] = TILE.KEY;
        keyPickups.push({ x: best.x, y: best.y });
        removeCandidate(best);
      }
    }
    // Fallback: fill remaining with far takes (still no adjacent)
    while (keyPickups.length < KEYS_REQUIRED) {
      const k = takeFarFrom(start.x, start.y, 8);
      if (!k) break;
      let ok = true;
      for (let p = 0; p < keyPickups.length; p++) {
        if (Math.abs(keyPickups[p].x - k.x) + Math.abs(keyPickups[p].y - k.y) < 2) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        floors.push(k);
        continue;
      }
      grid[k.y][k.x] = TILE.KEY;
      keyPickups.push(k);
    }

    // Scarce treasure chests (2–4 on L1, mild scale) — potion and/or clothing
    const chestCount = Math.min(6, 2 + Math.floor(rng() * 3) + Math.floor((params.level - 1) * 0.5));
    const chests = [];
    const chestMinDist = 10;
    const lootPool = ["potion", "cloth", "cloth", "potion"];
    let chestGuard = 0;
    while (chests.length < chestCount && chestGuard++ < chestCount * 50) {
      let c = null;
      const nonStart = rooms.filter(function (_, i) {
        return i !== startIdx;
      });
      if (nonStart.length) c = takeInRoom(nonStart[Math.floor(rng() * nonStart.length)], start, 6);
      if (!c) c = takeFarFrom(start.x, start.y, 10);
      if (!c) break;
      let spaced = true;
      for (let ci = 0; ci < chests.length; ci++) {
        if (Math.abs(chests[ci].x - c.x) + Math.abs(chests[ci].y - c.y) < chestMinDist) {
          spaced = false;
          break;
        }
      }
      // Also keep clear of keys
      for (let ki = 0; ki < keyPickups.length; ki++) {
        if (Math.abs(keyPickups[ki].x - c.x) + Math.abs(keyPickups[ki].y - c.y) < 3) {
          spaced = false;
          break;
        }
      }
      if (!spaced) {
        floors.push(c);
        continue;
      }
      const loot = lootPool[Math.floor(rng() * lootPool.length)];
      grid[c.y][c.x] = TILE.CHEST;
      chests.push({ x: c.x, y: c.y, loot: loot });
    }

    const enemySpawns = [];
    // +1 slot is reserved for the succubus in game.js (index 0)
    // Modest bump so multiple flying minion types appear on L1
    const minionCount = 4 + Math.min(params.level, 10);
    for (let i = 0; i < minionCount + 1; i++) {
      const nonStart = rooms.filter(function (_, ri) {
        return ri !== startIdx;
      });
      let e = null;
      if (nonStart.length) e = takeInRoom(nonStart[Math.floor(rng() * nonStart.length)], start, 10);
      if (!e) e = takeFarFrom(start.x, start.y, 12);
      if (!e) break;
      enemySpawns.push(e);
    }

    const torches = [];
    // ~1–2 warm sconces per room so each chamber glows like the refs
    const torchTarget = Math.max(10, Math.round(rooms.length * 1.6) + params.level);
    const torchCandidates = [];
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (grid[y][x] === TILE.WALL) continue;
        let wallN = 0;
        if (grid[y][x + 1] === TILE.WALL) wallN++;
        if (grid[y][x - 1] === TILE.WALL) wallN++;
        if (grid[y + 1][x] === TILE.WALL) wallN++;
        if (grid[y - 1][x] === TILE.WALL) wallN++;
        // Prefer wall-adjacent cells that are not room centers
        if (wallN >= 1) torchCandidates.push({ x: x, y: y });
      }
    }
    for (let i = torchCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = torchCandidates[i];
      torchCandidates[i] = torchCandidates[j];
      torchCandidates[j] = tmp;
    }
    const torchSpacing = 7;
    for (let ti = 0; ti < torchCandidates.length; ti++) {
      if (torches.length >= torchTarget) break;
      const c = torchCandidates[ti];
      let ok = true;
      for (let t = 0; t < torches.length; t++) {
        if (Math.abs(torches[t].x - c.x) + Math.abs(torches[t].y - c.y) < torchSpacing) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      torches.push({ x: c.x, y: c.y });
      decorations.push({ type: "sconce", x: c.x, y: c.y });
    }
    // Ensure gate flanking torch cells are lit
    for (let di = 0; di < decorations.length; di++) {
      const d = decorations[di];
      if (d.type !== "gateTorch") continue;
      if (d.y < 1 || d.x < 1 || d.y >= rows - 1 || d.x >= cols - 1) continue;
      if (grid[d.y][d.x] === TILE.WALL) continue;
      let exists = false;
      for (let t = 0; t < torches.length; t++) {
        if (torches[t].x === d.x && torches[t].y === d.y) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        torches.push({ x: d.x, y: d.y });
        decorations.push({ type: "sconce", x: d.x, y: d.y });
      }
    }

    const regionAt = Array.from({ length: rows }, function () {
      return Array(cols).fill(null);
    });
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      r.kind = "room";
      r.id = i;
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (y < 0 || x < 0 || y >= rows || x >= cols) continue;
          if (grid[y][x] === TILE.WALL) continue;
          regionAt[y][x] = r;
        }
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y][x] === TILE.WALL) continue;
        if (regionAt[y][x]) continue;
        let best = null;
        let bestD = Infinity;
        for (let ri = 0; ri < rooms.length; ri++) {
          const r = rooms[ri];
          const cx = Math.max(r.x, Math.min(r.x + r.w - 1, x));
          const cy = Math.max(r.y, Math.min(r.y + r.h - 1, y));
          const d = Math.abs(cx - x) + Math.abs(cy - y);
          if (d < bestD) {
            bestD = d;
            best = r;
          }
        }
        if (best) regionAt[y][x] = best;
      }
    }

    const corridors = [];
    const regions = rooms.slice();

    const allFloors = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y][x] !== TILE.WALL) allFloors.push({ x: x, y: y });
      }
    }

    const seen = {};
    const q = [start.x + "," + start.y];
    seen[q[0]] = true;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (let qi = 0; qi < q.length; qi++) {
      const parts = q[qi].split(",");
      const cx = +parts[0];
      const cy = +parts[1];
      for (let di = 0; di < dirs.length; di++) {
        const nx = cx + dirs[di][0];
        const ny = cy + dirs[di][1];
        if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
        if (grid[ny][nx] === TILE.WALL) continue;
        const k = nx + "," + ny;
        if (seen[k]) continue;
        seen[k] = true;
        q.push(k);
      }
    }

    // Actual dead-end room count for reporting
    const deg = degreeMap(selected, rooms.length);
    let deadEnds = 0;
    for (let i = 0; i < deg.length; i++) {
      if (deg[i] === 1) deadEnds++;
    }

    return {
      cols: cols,
      rows: rows,
      grid: grid,
      start: start,
      exit: exitCell,
      traps: traps,
      potion: potion,
      clothPickups: clothPickups,
      chests: chests,
      keyPickups: keyPickups,
      keysRequired: KEYS_REQUIRED,
      keysPlaced: keyPickups.length,
      enemySpawns: enemySpawns,
      torches: torches,
      decorations: decorations,
      rooms: rooms,
      corridors: corridors,
      regions: regions,
      regionAt: regionAt,
      floors: allFloors,
      seed: seed,
      TILE: TILE,
      level: params.level,
      deadEndRate: params.deadEndRate,
      deadEndRooms: deadEnds,
      roomCount: rooms.length,
      reachableFloor: q.length,
      exitReachable: !!seen[exitCell.x + "," + exitCell.y],
      handcrafted: false
    };
  }

  function randomFloorFar(maze, px, py, minDist, avoidPoints, minPeerDist) {
    const peerMin = minPeerDist == null ? 6 : minPeerDist;
    const playerMin = minDist == null ? 10 : minDist;
    const avoid = avoidPoints || [];
    const list = maze.floors || null;

    function collect(pMin, eMin) {
      const out = [];
      if (list && list.length) {
        const step = list.length > 8000 ? Math.ceil(list.length / 6000) : 1;
        for (let i = 0; i < list.length; i += step) {
          const x = list[i].x;
          const y = list[i].y;
          if (maze.grid[y][x] === TILE.WALL) continue;
          const cx = x + 0.5;
          const cy = y + 0.5;
          const dPlayer = Math.hypot(cx - px, cy - py);
          if (dPlayer < pMin) continue;
          let ok = true;
          for (let ai = 0; ai < avoid.length; ai++) {
            if (Math.hypot(cx - avoid[ai].x, cy - avoid[ai].y) < eMin) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          out.push({ x: x, y: y, d: dPlayer });
        }
        return out;
      }
      for (let y = 0; y < maze.rows; y++) {
        for (let x = 0; x < maze.cols; x++) {
          if (maze.grid[y][x] === TILE.WALL) continue;
          const cx = x + 0.5;
          const cy = y + 0.5;
          const dPlayer = Math.hypot(cx - px, cy - py);
          if (dPlayer < pMin) continue;
          let ok = true;
          for (let ai = 0; ai < avoid.length; ai++) {
            if (Math.hypot(cx - avoid[ai].x, cy - avoid[ai].y) < eMin) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          out.push({ x: x, y: y, d: dPlayer });
        }
      }
      return out;
    }

    let floors = collect(playerMin, peerMin);
    if (!floors.length) floors = collect(Math.max(4, playerMin * 0.5), Math.max(3, peerMin * 0.5));
    if (!floors.length) floors = collect(2, 2);
    if (!floors.length) {
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (maze.grid[c.y][c.x] === TILE.WALL) continue;
          if (Math.floor(px) === c.x && Math.floor(py) === c.y) continue;
          floors.push({ x: c.x, y: c.y, d: 0 });
        }
      } else {
        for (let y = 0; y < maze.rows; y++) {
          for (let x = 0; x < maze.cols; x++) {
            if (maze.grid[y][x] === TILE.WALL) continue;
            if (Math.floor(px) === x && Math.floor(py) === y) continue;
            floors.push({ x: x, y: y, d: 0 });
          }
        }
      }
    }
    if (!floors.length) return null;
    floors.sort(function (a, b) {
      return b.d - a.d;
    });
    const top = floors.slice(0, Math.max(8, Math.floor(floors.length * 0.4)));
    return top[Math.floor(Math.random() * top.length)];
  }

  return {
    generate: generate,
    TILE: TILE,
    KEYS_REQUIRED: KEYS_REQUIRED,
    mulberry32: mulberry32,
    randomFloorFar: randomFloorFar,
    levelParams: levelParams
  };
})();
