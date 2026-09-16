/**
 * Underground tunnel mansion generator — large square maps of open
 * rectangular rooms connected ONLY by doorways cut in shared walls.
 * No hallways. Seeded RNG so restart keeps the same layout.
 *
 * Sizing (level 1..10):
 *   map edge  ~165 → ~290 tiles (square)
 *   rooms     base × 1.05^(level-1)
 *   dead-ends 10% + 2% per level above 1
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
    KEY: 8
  };

  const KEYS_REQUIRED = 3;
  const BASE_ROOMS = 18;

  function levelParams(level) {
    const lv = Math.max(1, level | 0);
    const t = Math.min(lv, 10);
    let size = Math.round(165 + (t - 1) * (125 / 9));
    if (lv > 10) size = Math.min(340, size + (lv - 10) * 8);
    const roomCount = Math.max(
      8,
      Math.round(BASE_ROOMS * Math.pow(1.05, t - 1) + (lv > 10 ? (lv - 10) * 1.5 : 0))
    );
    const deadEndRate = Math.min(
      0.4,
      0.1 + 0.02 * (t - 1) + (lv > 10 ? 0.02 * Math.min(lv - 10, 5) : 0)
    );
    return { cols: size, rows: size, roomCount, deadEndRate, level: lv };
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

  /** BSP: leaves separated by 1-tile shared walls. */
  function bspPartition(root, targetLeaves, rng) {
    const minLeafW = 14;
    const minLeafH = 12;
    const leaves = [];

    function split(node, depth) {
      const canW = node.w >= minLeafW * 2 + 1;
      const canH = node.h >= minLeafH * 2 + 1;
      const stop =
        (!canW && !canH) ||
        (leaves.length + 1 >= targetLeaves && depth > 1) ||
        (depth > 2 && leaves.length >= targetLeaves * 0.85 && rng() < 0.2);

      if (stop) {
        leaves.push(node);
        return;
      }
      if (!canW && !canH) {
        leaves.push(node);
        return;
      }

      let horizontal;
      if (canW && canH) {
        horizontal = node.w > node.h * 1.15 ? false : node.h > node.w * 1.15 ? true : rng() < 0.5;
      } else {
        horizontal = !!canH && !canW;
      }

      if (!horizontal) {
        const minSplit = node.x + minLeafW;
        const maxSplit = node.x + node.w - minLeafW - 1;
        if (minSplit > maxSplit) {
          leaves.push(node);
          return;
        }
        const splitX = minSplit + Math.floor(rng() * (maxSplit - minSplit + 1));
        split({ x: node.x, y: node.y, w: splitX - node.x, h: node.h }, depth + 1);
        split(
          { x: splitX + 1, y: node.y, w: node.x + node.w - splitX - 1, h: node.h },
          depth + 1
        );
      } else {
        const minSplit = node.y + minLeafH;
        const maxSplit = node.y + node.h - minLeafH - 1;
        if (minSplit > maxSplit) {
          leaves.push(node);
          return;
        }
        const splitY = minSplit + Math.floor(rng() * (maxSplit - minSplit + 1));
        split({ x: node.x, y: node.y, w: node.w, h: splitY - node.y }, depth + 1);
        split(
          { x: node.x, y: splitY + 1, w: node.w, h: node.y + node.h - splitY - 1 },
          depth + 1
        );
      }
    }

    split(root, 0);

    let guard = 0;
    while (leaves.length < targetLeaves && guard++ < 100) {
      leaves.sort((a, b) => b.w * b.h - a.w * a.h);
      const node = leaves[0];
      const canW = node.w >= minLeafW * 2 + 1;
      const canH = node.h >= minLeafH * 2 + 1;
      if (!canW && !canH) break;
      leaves.shift();
      const horizontal = canH && (!canW || node.h >= node.w);
      if (!horizontal) {
        const minSplit = node.x + minLeafW;
        const maxSplit = node.x + node.w - minLeafW - 1;
        if (minSplit > maxSplit) {
          leaves.push(node);
          break;
        }
        const splitX = minSplit + Math.floor(rng() * (maxSplit - minSplit + 1));
        leaves.push({ x: node.x, y: node.y, w: splitX - node.x, h: node.h });
        leaves.push({
          x: splitX + 1,
          y: node.y,
          w: node.x + node.w - splitX - 1,
          h: node.h
        });
      } else {
        const minSplit = node.y + minLeafH;
        const maxSplit = node.y + node.h - minLeafH - 1;
        if (minSplit > maxSplit) {
          leaves.push(node);
          break;
        }
        const splitY = minSplit + Math.floor(rng() * (maxSplit - minSplit + 1));
        leaves.push({ x: node.x, y: node.y, w: node.w, h: splitY - node.y });
        leaves.push({
          x: node.x,
          y: splitY + 1,
          w: node.w,
          h: node.y + node.h - splitY - 1
        });
      }
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
    const width = 2 + (rng() < 0.35 ? 1 : 0);
    const span = edge.hi - edge.lo + 1;
    if (span < width) return null;
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
      const count = 2 + Math.floor(rng() * 3);
      for (let fi = 0; fi < count; fi++) {
        const s = furnSides[Math.floor(rng() * 4)];
        let fx, fy, fw, fh;
        if (s.side === "n") {
          fw = 1 + Math.floor(rng() * 2);
          fh = 1;
          fx = r.x + 2 + Math.floor(rng() * Math.max(1, r.w - fw - 4));
          fy = r.y;
        } else if (s.side === "s") {
          fw = 1 + Math.floor(rng() * 2);
          fh = 1;
          fx = r.x + 2 + Math.floor(rng() * Math.max(1, r.w - fw - 4));
          fy = r.y + r.h - 1;
        } else if (s.side === "w") {
          fw = 1;
          fh = 1 + Math.floor(rng() * 2);
          fx = r.x;
          fy = r.y + 2 + Math.floor(rng() * Math.max(1, r.h - fh - 4));
        } else {
          fw = 1;
          fh = 1 + Math.floor(rng() * 2);
          fx = r.x + r.w - 1;
          fy = r.y + 2 + Math.floor(rng() * Math.max(1, r.h - fh - 4));
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
        if (roll < 0.34) {
          type = "painting";
          style = Math.floor(rng() * paintingThemes.length);
          theme = paintingThemes[style];
        } else if (roll < 0.67) {
          type = "furniture";
          style = 0;
          theme = null;
        } else {
          type = "furniture";
          style = 3;
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
      const sw = Math.min(6, Math.max(3, Math.floor(startRoom.w / 3)));
      const sx = startRoom.x + Math.floor((startRoom.w - sw) / 2);
      decorations.push({
        type: "stairs",
        x: sx,
        y: startRoom.y,
        w: sw,
        h: Math.min(3, startRoom.h - 2),
        facing: "s",
        gate: "entrance"
      });
      decorations.push({
        type: "entranceGate",
        x: sx,
        y: startRoom.y,
        w: sw,
        h: 2
      });
    }
    if (exitRoom) {
      const sw = Math.min(6, Math.max(3, Math.floor(exitRoom.w / 3)));
      const sx = exitRoom.x + Math.floor((exitRoom.w - sw) / 2);
      decorations.push({
        type: "stairs",
        x: sx,
        y: exitRoom.y + exitRoom.h - Math.min(3, exitRoom.h - 2),
        w: sw,
        h: Math.min(3, exitRoom.h - 2),
        facing: "s",
        gate: "exit"
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

    const margin = Math.max(6, Math.floor(cols * 0.07));
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
    const rootId = ufAdj.find(0);
    for (let i = 1; i < rooms.length; i++) {
      if (ufAdj.find(i) === rootId) continue;
      let best = null;
      let bestD = Infinity;
      for (let j = 0; j < rooms.length; j++) {
        if (ufAdj.find(j) !== rootId) continue;
        const ca = roomCenter(rooms[i]);
        const cb = roomCenter(rooms[j]);
        const d = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (best == null) continue;
      punchRockLink(grid, rooms, i, best, cols, rows);
      ufAdj.union(i, best);
      const sw = sharedWall(rooms[i], rooms[best]);
      allEdges.push({
        i: i,
        j: best,
        wall: sw || { dir: "v", wall: roomCenter(rooms[i]).x, lo: roomCenter(rooms[i]).y, hi: roomCenter(rooms[i]).y + 1 }
      });
    }

    const selected = selectDoorways(rooms, allEdges, startIdx, exitIdx, params.deadEndRate, rng);
    for (let i = 0; i < selected.length; i++) {
      const e = selected[i];
      if (e.wall && (e.wall.dir === "v" || e.wall.dir === "h") && e.wall.lo != null) {
        carveDoorway(grid, e.wall, rng);
      }
    }

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

    const traps = [];
    if (params.level >= 5 && rng() < 0.35) {
      const nonSE = rooms.filter(function (_, i) {
        return i !== startIdx && i !== exitIdx;
      });
      if (nonSE.length) {
        const pr = nonSE[Math.floor(rng() * nonSE.length)];
        const t = takeInRoom(pr, start, 8);
        if (t) {
          grid[t.y][t.x] = TILE.TRAP;
          traps.push(t);
        }
      }
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
    const pickedKeys = [];
    for (let ki = 0; ki < KEYS_REQUIRED; ki++) {
      if (!keyCandidates.length) break;
      let best = null;
      let bestScore = -1;
      const sampleN = Math.min(keyCandidates.length, 400);
      for (let s = 0; s < sampleN; s++) {
        const c = keyCandidates[Math.floor(rng() * keyCandidates.length)];
        let minD = Infinity;
        if (!pickedKeys.length) {
          minD = Math.abs(c.x - start.x) + Math.abs(c.y - start.y);
        } else {
          for (let p = 0; p < pickedKeys.length; p++) {
            const d = Math.abs(c.x - pickedKeys[p].x) + Math.abs(c.y - pickedKeys[p].y);
            if (d < minD) minD = d;
          }
        }
        const dSE =
          Math.min(
            Math.abs(c.x - start.x) + Math.abs(c.y - start.y),
            Math.abs(c.x - exitCell.x) + Math.abs(c.y - exitCell.y)
          ) * 0.15;
        const score = minD + dSE;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) break;
      pickedKeys.push(best);
      grid[best.y][best.x] = TILE.KEY;
      keyPickups.push({ x: best.x, y: best.y });
      for (let fi = floors.length - 1; fi >= 0; fi--) {
        if (floors[fi].x === best.x && floors[fi].y === best.y) {
          floors.splice(fi, 1);
          break;
        }
      }
      for (let ci = keyCandidates.length - 1; ci >= 0; ci--) {
        if (keyCandidates[ci].x === best.x && keyCandidates[ci].y === best.y) {
          keyCandidates.splice(ci, 1);
        }
      }
    }
    while (keyPickups.length < KEYS_REQUIRED) {
      const k = takeFarFrom(start.x, start.y, 8);
      if (!k) break;
      grid[k.y][k.x] = TILE.KEY;
      keyPickups.push(k);
    }

    const enemySpawns = [];
    const minionCount = 2 + Math.min(params.level, 10);
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
    const torchTarget = 12 + params.level * 2;
    const torchCandidates = [];
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (grid[y][x] === TILE.WALL) continue;
        let wallN = 0;
        if (grid[y][x + 1] === TILE.WALL) wallN++;
        if (grid[y][x - 1] === TILE.WALL) wallN++;
        if (grid[y + 1][x] === TILE.WALL) wallN++;
        if (grid[y - 1][x] === TILE.WALL) wallN++;
        if (wallN >= 1) torchCandidates.push({ x: x, y: y });
      }
    }
    for (let i = torchCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = torchCandidates[i];
      torchCandidates[i] = torchCandidates[j];
      torchCandidates[j] = tmp;
    }
    const torchSpacing = Math.max(4, Math.floor(cols / 40));
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
