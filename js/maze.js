/**
 * Underground mansion generator — open rectangular rooms linked by
 * doorways / short halls. Room interiors are clear walkable floor
 * (no internal maze walls). Seeded RNG so restart keeps the same layout.
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

  /** Keys required to unlock the exit gate (fixed requirement). */
  const KEYS_REQUIRED = 3;

  function carveRect(grid, x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (y > 0 && x > 0 && y < grid.length - 1 && x < grid[0].length - 1) {
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

  /** Short doorway / connecting hall between two room edges (not a long maze corridor). */
  function carveConnection(grid, a, b, rng) {
    const ac = roomCenter(a);
    const bc = roomCenter(b);
    const ax0 = a.x,
      ax1 = a.x + a.w - 1,
      ay0 = a.y,
      ay1 = a.y + a.h - 1;
    const bx0 = b.x,
      bx1 = b.x + b.w - 1,
      by0 = b.y,
      by1 = b.y + b.h - 1;

    function carveCell(x, y) {
      if (y <= 0 || x <= 0 || y >= grid.length - 1 || x >= grid[0].length - 1) return;
      grid[y][x] = TILE.FLOOR;
    }

    function carveWide(x, y, horizontal) {
      carveCell(x, y);
      if (horizontal) {
        if (y + 1 < grid.length - 1) carveCell(x, y + 1);
      } else {
        if (x + 1 < grid[0].length - 1) carveCell(x + 1, y);
      }
    }

    // Prefer axis-aligned short links when rooms share an overlap band
    const yOverlap0 = Math.max(ay0 + 1, by0 + 1);
    const yOverlap1 = Math.min(ay1 - 1, by1 - 1);
    const xOverlap0 = Math.max(ax0 + 1, bx0 + 1);
    const xOverlap1 = Math.min(ax1 - 1, bx1 - 1);

    if (yOverlap0 <= yOverlap1 && (ax1 < bx0 - 1 || bx1 < ax0 - 1)) {
      // Side-by-side — horizontal doorway
      const y = yOverlap0 + Math.floor(rng() * (yOverlap1 - yOverlap0 + 1));
      const left = ax1 < bx0 ? ax1 : bx1;
      const right = ax1 < bx0 ? bx0 : ax0;
      for (let x = left; x <= right; x++) carveWide(x, y, true);
      return;
    }

    if (xOverlap0 <= xOverlap1 && (ay1 < by0 - 1 || by1 < ay0 - 1)) {
      // Stacked — vertical doorway
      const x = xOverlap0 + Math.floor(rng() * (xOverlap1 - xOverlap0 + 1));
      const top = ay1 < by0 ? ay1 : by1;
      const bot = ay1 < by0 ? by0 : ay0;
      for (let y = top; y <= bot; y++) carveWide(x, y, false);
      return;
    }

    // Diagonal / no overlap: short L between nearest edge points (still short halls)
    let x1 = ac.x,
      y1 = ac.y,
      x2 = bc.x,
      y2 = bc.y;
    if (ac.x < bc.x) {
      x1 = ax1;
      x2 = bx0;
    } else if (ac.x > bc.x) {
      x1 = ax0;
      x2 = bx1;
    }
    if (ac.y < bc.y) {
      y1 = ay1;
      y2 = by0;
    } else if (ac.y > bc.y) {
      y1 = ay0;
      y2 = by1;
    }

    const wide = true;
    function carveAt(x, y) {
      carveCell(x, y);
      if (wide) {
        if (y + 1 < grid.length - 1) carveCell(x, y + 1);
        if (x + 1 < grid[0].length - 1) carveCell(x + 1, y);
      }
    }
    if (rng() < 0.5) {
      const xStep = x1 < x2 ? 1 : -1;
      for (let x = x1; x !== x2; x += xStep) carveAt(x, y1);
      carveAt(x2, y1);
      const yStep = y1 < y2 ? 1 : -1;
      for (let y = y1; y !== y2; y += yStep) carveAt(x2, y);
      carveAt(x2, y2);
    } else {
      const yStep = y1 < y2 ? 1 : -1;
      for (let y = y1; y !== y2; y += yStep) carveAt(x1, y);
      carveAt(x1, y2);
      const xStep = x1 < x2 ? 1 : -1;
      for (let x = x1; x !== x2; x += xStep) carveAt(x, y2);
      carveAt(x2, y2);
    }
  }

  function generate(cols, rows, seed, level) {
    const rng = mulberry32(seed >>> 0);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(TILE.WALL));

    // Place spacious OPEN rooms with a gap so walls separate them
    // Higher levels: more rooms, slightly larger footprints
    const rooms = [];
    const roomTarget = 8 + Math.min(level * 2, 12);
    const maxAttempts = 280;
    const gap = 2; // wall strip between rooms; doorways carve through
    const sizeBoost = Math.min(level - 1, 4);
    for (let attempt = 0; attempt < maxAttempts && rooms.length < roomTarget; attempt++) {
      const w = 8 + Math.floor(rng() * 6) + Math.floor(sizeBoost / 2); // grows with level
      const h = 7 + Math.floor(rng() * 5) + Math.floor(sizeBoost / 2);
      const x = 2 + Math.floor(rng() * (cols - w - 4));
      const y = 2 + Math.floor(rng() * (rows - h - 4));
      let overlaps = false;
      for (const r of rooms) {
        if (
          x < r.x + r.w + gap &&
          x + w + gap > r.x &&
          y < r.y + r.h + gap &&
          y + h + gap > r.y
        ) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      const room = { x, y, w, h };
      carveRect(grid, x, y, w, h);
      rooms.push(room);
    }

    // Fill remaining room slots with slightly smaller rooms if packing was tight
    for (let attempt = 0; attempt < 200 && rooms.length < roomTarget; attempt++) {
      const w = 6 + Math.floor(rng() * (5 + Math.floor(sizeBoost / 2)));
      const h = 5 + Math.floor(rng() * (4 + Math.floor(sizeBoost / 2)));
      const x = 2 + Math.floor(rng() * (cols - w - 4));
      const y = 2 + Math.floor(rng() * (rows - h - 4));
      let overlaps = false;
      for (const r of rooms) {
        if (
          x < r.x + r.w + gap &&
          x + w + gap > r.x &&
          y < r.y + r.h + gap &&
          y + h + gap > r.y
        ) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      const room = { x, y, w, h };
      carveRect(grid, x, y, w, h);
      rooms.push(room);
    }

    if (rooms.length < 3) {
      const fallbacks = [
        { x: 3, y: 3, w: 11, h: 9 },
        { x: Math.floor(cols / 2) - 5, y: Math.floor(rows / 2) - 4, w: 12, h: 10 },
        { x: cols - 15, y: rows - 13, w: 11, h: 9 }
      ];
      for (const r of fallbacks) {
        if (r.x + r.w >= cols - 1 || r.y + r.h >= rows - 1) continue;
        let overlaps = false;
        for (const o of rooms) {
          if (
            r.x < o.x + o.w + gap &&
            r.x + r.w + gap > o.x &&
            r.y < o.y + o.h + gap &&
            r.y + r.h + gap > o.y
          ) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;
        carveRect(grid, r.x, r.y, r.w, r.h);
        rooms.push(r);
      }
    }

    // Connect rooms (nearest-neighbor MST) via short doorways / halls only
    const connected = [0];
    const remaining = rooms.map((_, i) => i).slice(1);
    while (remaining.length) {
      let bestI = 0,
        bestJ = 0,
        bestD = Infinity;
      for (const i of connected) {
        const a = roomCenter(rooms[i]);
        for (let ri = 0; ri < remaining.length; ri++) {
          const j = remaining[ri];
          const b = roomCenter(rooms[j]);
          const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          if (d < bestD) {
            bestD = d;
            bestI = i;
            bestJ = ri;
          }
        }
      }
      const j = remaining.splice(bestJ, 1)[0];
      carveConnection(grid, rooms[bestI], rooms[j], rng);
      connected.push(j);
    }
    // Extra loops between nearby rooms — more connections on deeper levels
    const extra = 1 + level;
    for (let i = 0; i < extra && rooms.length > 2; i++) {
      let bestA = 0,
        bestB = 1,
        bestD = Infinity;
      for (let a = 0; a < rooms.length; a++) {
        for (let b = a + 1; b < rooms.length; b++) {
          const ca = roomCenter(rooms[a]);
          const cb = roomCenter(rooms[b]);
          const d = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
          if (d < bestD && d > 0) {
            // prefer mid-distance pairs for loops
            bestD = d;
            bestA = a;
            bestB = b;
          }
        }
      }
      // pick a random nearby pair instead of always the closest already connected
      const a = Math.floor(rng() * rooms.length);
      let b = Math.floor(rng() * rooms.length);
      if (a === b) b = (b + 1) % rooms.length;
      const ca = roomCenter(rooms[a]);
      const cb = roomCenter(rooms[b]);
      const d = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
      if (d < 28) carveConnection(grid, rooms[a], rooms[b], rng);
      else carveConnection(grid, rooms[bestA], rooms[bestB], rng);
    }

    // Corner pillars only (1-tile, edges) — do NOT fill rooms into a maze
    const decorations = [];
    for (const r of rooms) {
      if (r.w < 6 || r.h < 6) continue;
      const corners = [
        { x: r.x + 1, y: r.y + 1 },
        { x: r.x + r.w - 2, y: r.y + 1 },
        { x: r.x + 1, y: r.y + r.h - 2 },
        { x: r.x + r.w - 2, y: r.y + r.h - 2 }
      ];
      for (const c of corners) {
        if (rng() < 0.55) {
          // Pillars are solid wall tiles at corners only
          if (grid[c.y][c.x] === TILE.FLOOR) {
            grid[c.y][c.x] = TILE.WALL;
            decorations.push({ type: "pillar", x: c.x, y: c.y });
          }
        }
      }
    }

    // Walkable manor decorations (rugs, furniture silhouettes) — never block pathing
    for (const r of rooms) {
      // Rug near center
      if (r.w >= 7 && r.h >= 6 && rng() < 0.75) {
        const rw = 2 + Math.floor(rng() * Math.min(3, r.w - 4));
        const rh = 2 + Math.floor(rng() * Math.min(2, r.h - 4));
        const rx = r.x + 2 + Math.floor(rng() * Math.max(1, r.w - rw - 4));
        const ry = r.y + 2 + Math.floor(rng() * Math.max(1, r.h - rh - 4));
        decorations.push({ type: "rug", x: rx, y: ry, w: rw, h: rh });
      }
      // Furniture silhouettes along walls (visual only)
      const furnCount = 1 + Math.floor(rng() * 3);
      for (let fi = 0; fi < furnCount; fi++) {
        const side = Math.floor(rng() * 4);
        let fx, fy, fw, fh, facing;
        if (side === 0) {
          // top wall
          fw = 1 + Math.floor(rng() * 2);
          fh = 1;
          fx = r.x + 2 + Math.floor(rng() * Math.max(1, r.w - fw - 4));
          fy = r.y;
          facing = "s";
        } else if (side === 1) {
          fw = 1 + Math.floor(rng() * 2);
          fh = 1;
          fx = r.x + 2 + Math.floor(rng() * Math.max(1, r.w - fw - 4));
          fy = r.y + r.h - 1;
          facing = "n";
        } else if (side === 2) {
          fw = 1;
          fh = 1 + Math.floor(rng() * 2);
          fx = r.x;
          fy = r.y + 2 + Math.floor(rng() * Math.max(1, r.h - fh - 4));
          facing = "e";
        } else {
          fw = 1;
          fh = 1 + Math.floor(rng() * 2);
          fx = r.x + r.w - 1;
          fy = r.y + 2 + Math.floor(rng() * Math.max(1, r.h - fh - 4));
          facing = "w";
        }
        // Only place if those cells are still floor (not pillar)
        let ok = true;
        for (let yy = fy; yy < fy + fh && ok; yy++) {
          for (let xx = fx; xx < fx + fw; xx++) {
            if (yy < 0 || xx < 0 || yy >= rows || xx >= cols || grid[yy][xx] === TILE.WALL) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          decorations.push({
            type: "furniture",
            x: fx,
            y: fy,
            w: fw,
            h: fh,
            facing,
            style: Math.floor(rng() * 3)
          });
        }
      }
    }

    // Collect floors (walkable — excludes corner pillars)
    const floors = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (grid[y][x] === TILE.FLOOR) floors.push({ x, y });
      }
    }

    function takeFarFrom(px, py, minDist) {
      const candidates = floors.filter((c) => {
        const d = Math.abs(c.x - px) + Math.abs(c.y - py);
        return d >= minDist;
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

    function takeInRoom(room, avoidStart, minDist) {
      const pool = [];
      for (let i = floors.length - 1; i >= 0; i--) {
        const c = floors[i];
        if (!inRoom(room, c.x, c.y)) continue;
        // Prefer open interior (not right on the boundary wall edge)
        if (c.x <= room.x || c.x >= room.x + room.w - 1) continue;
        if (c.y <= room.y || c.y >= room.y + room.h - 1) continue;
        const d = Math.abs(c.x - avoidStart.x) + Math.abs(c.y - avoidStart.y);
        if (d < minDist) continue;
        pool.push({ c, i });
      }
      if (!pool.length) return null;
      const pick = pool[Math.floor(rng() * pool.length)];
      floors.splice(pick.i, 1);
      return pick.c;
    }

    const startRoom = rooms[0];
    const start = roomCenter(startRoom);
    // Ensure start cell is floor (in case a pillar landed there — unlikely at center)
    if (grid[start.y][start.x] === TILE.WALL) {
      grid[start.y][start.x] = TILE.FLOOR;
      floors.push({ x: start.x, y: start.y });
    }
    for (let i = floors.length - 1; i >= 0; i--) {
      if (floors[i].x === start.x && floors[i].y === start.y) floors.splice(i, 1);
    }

    // Exit in farthest room center area
    let exitRoom = rooms[rooms.length - 1];
    let bestFar = -1;
    for (const r of rooms) {
      const c = roomCenter(r);
      const d = Math.abs(c.x - start.x) + Math.abs(c.y - start.y);
      if (d > bestFar) {
        bestFar = d;
        exitRoom = r;
      }
    }
    let exitCell = takeInRoom(exitRoom, start, 4);
    if (!exitCell) exitCell = takeFarFrom(start.x, start.y, Math.floor((cols + rows) / 4));
    if (!exitCell) exitCell = { x: roomCenter(exitRoom).x, y: roomCenter(exitRoom).y };
    grid[exitCell.y][exitCell.x] = TILE.EXIT;

    // Traps on open room floors — denser on deeper levels (still not in halls)
    const traps = [];
    const trapRoomChance = Math.min(0.75, 0.38 + level * 0.06);
    const trapsPerRoom = 1 + (level >= 4 ? 1 : 0);
    for (let ri = 0; ri < rooms.length; ri++) {
      const r = rooms[ri];
      if (r === startRoom) continue;
      if (rng() > trapRoomChance) continue;
      for (let ti = 0; ti < trapsPerRoom; ti++) {
        const t = takeInRoom(r, start, 5);
        if (!t) break;
        if (t.x === exitCell.x && t.y === exitCell.y) continue;
        grid[t.y][t.x] = TILE.TRAP;
        traps.push(t);
      }
    }

    let potion = null;
    // Potion in a non-start room interior
    const potionRooms = rooms.filter((r) => r !== startRoom);
    if (potionRooms.length) {
      const pr = potionRooms[Math.floor(rng() * potionRooms.length)];
      potion = takeInRoom(pr, start, 6);
    }
    if (!potion) potion = takeFarFrom(start.x, start.y, 8);
    if (potion) grid[potion.y][potion.x] = TILE.POTION;

    const clothTiles = [TILE.CLOTH_SHIRT, TILE.CLOTH_SHOES, TILE.CLOTH_PANTS];
    const clothPickups = [];
    for (const ct of clothTiles) {
      const nonStart = rooms.filter((r) => r !== startRoom);
      let c = null;
      if (nonStart.length) {
        const pr = nonStart[Math.floor(rng() * nonStart.length)];
        c = takeInRoom(pr, start, 5);
      }
      if (!c) c = takeFarFrom(start.x, start.y, 6);
      if (!c) break;
      grid[c.y][c.x] = ct;
      clothPickups.push({ x: c.x, y: c.y, tile: ct });
    }

    // Manor keys — scatter 3–5 through open rooms (need KEYS_REQUIRED to open gate)
    const keyCount = Math.min(5, KEYS_REQUIRED + Math.min(level - 1, 2));
    const keyPickups = [];
    for (let ki = 0; ki < keyCount; ki++) {
      const nonStart = rooms.filter((r) => r !== startRoom && r !== exitRoom);
      const poolRooms = nonStart.length ? nonStart : rooms.filter((r) => r !== startRoom);
      let k = null;
      if (poolRooms.length) {
        const pr = poolRooms[Math.floor(rng() * poolRooms.length)];
        k = takeInRoom(pr, start, 4);
      }
      if (!k) k = takeFarFrom(start.x, start.y, 6);
      if (!k) break;
      if (k.x === exitCell.x && k.y === exitCell.y) continue;
      grid[k.y][k.x] = TILE.KEY;
      keyPickups.push({ x: k.x, y: k.y });
    }

    const enemySpawns = [];
    // 1 succubus + scaling minions (more on deeper levels)
    const minionCount = 2 + level;
    for (let i = 0; i < minionCount + 1; i++) {
      const nonStart = rooms.filter((r) => r !== startRoom);
      let e = null;
      if (nonStart.length) {
        const pr = nonStart[Math.floor(rng() * nonStart.length)];
        e = takeInRoom(pr, start, 8);
      }
      if (!e) e = takeFarFrom(start.x, start.y, 10);
      if (!e) break;
      enemySpawns.push(e);
    }

    // Wall sconces along room boundary walls (and short halls)
    const torches = [];
    const torchTarget = 10 + level * 2;
    const torchCandidates = [];
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (grid[y][x] !== TILE.FLOOR) continue;
        let wallN = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ]) {
          if (grid[y + dy][x + dx] === TILE.WALL) wallN++;
        }
        if (wallN >= 1) torchCandidates.push({ x, y });
      }
    }
    for (let i = torchCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [torchCandidates[i], torchCandidates[j]] = [torchCandidates[j], torchCandidates[i]];
    }
    for (const c of torchCandidates) {
      if (torches.length >= torchTarget) break;
      let ok = true;
      for (const t of torches) {
        if (Math.abs(t.x - c.x) + Math.abs(t.y - c.y) < 5) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      torches.push({ x: c.x, y: c.y });
      decorations.push({ type: "sconce", x: c.x, y: c.y });
    }

    return {
      cols,
      rows,
      grid,
      start,
      exit: exitCell,
      traps,
      potion,
      clothPickups,
      keyPickups,
      keysRequired: KEYS_REQUIRED,
      keysPlaced: keyPickups.length,
      enemySpawns,
      torches,
      decorations,
      rooms,
      seed,
      TILE
    };
  }

  /**
   * Pick a random floor tile far from the player and from avoidPoints.
   * avoidPoints are world positions {x, y} (centers). Retries with relaxed
   * spacing if needed so respawns never bunch up.
   */
  function randomFloorFar(maze, px, py, minDist, avoidPoints, minPeerDist) {
    const peerMin = minPeerDist == null ? 6 : minPeerDist;
    const playerMin = minDist == null ? 10 : minDist;
    const avoid = avoidPoints || [];

    function collect(pMin, eMin) {
      const floors = [];
      for (let y = 0; y < maze.rows; y++) {
        for (let x = 0; x < maze.cols; x++) {
          if (maze.grid[y][x] === TILE.WALL) continue;
          const cx = x + 0.5,
            cy = y + 0.5;
          const dPlayer = Math.hypot(cx - px, cy - py);
          if (dPlayer < pMin) continue;
          let ok = true;
          for (const a of avoid) {
            if (Math.hypot(cx - a.x, cy - a.y) < eMin) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          floors.push({ x, y, d: dPlayer });
        }
      }
      return floors;
    }

    let floors = collect(playerMin, peerMin);
    if (!floors.length) floors = collect(Math.max(4, playerMin * 0.5), Math.max(3, peerMin * 0.5));
    if (!floors.length) floors = collect(2, 2);
    if (!floors.length) {
      for (let y = 0; y < maze.rows; y++) {
        for (let x = 0; x < maze.cols; x++) {
          if (maze.grid[y][x] === TILE.WALL) continue;
          if (Math.floor(px) === x && Math.floor(py) === y) continue;
          floors.push({ x, y, d: 0 });
        }
      }
    }
    if (!floors.length) return null;
    floors.sort((a, b) => b.d - a.d);
    const top = floors.slice(0, Math.max(8, Math.floor(floors.length * 0.4)));
    return top[Math.floor(Math.random() * top.length)];
  }

  return { generate, TILE, KEYS_REQUIRED, mulberry32, randomFloorFar };
})();
