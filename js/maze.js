/**
 * Underground mansion generator — large rooms linked by halls/doorways.
 * Seeded RNG so restart keeps the same layout.
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
    CLOTH_PANTS: 7
  };

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

  function carveHall(grid, x1, y1, x2, y2, rng) {
    // L-shaped hallway (1–2 tiles wide for mansion feel)
    const wide = rng() < 0.45;
    function carveAt(x, y) {
      if (y <= 0 || x <= 0 || y >= grid.length - 1 || x >= grid[0].length - 1) return;
      grid[y][x] = TILE.FLOOR;
      if (wide) {
        if (y + 1 < grid.length - 1) grid[y + 1][x] = TILE.FLOOR;
        if (x + 1 < grid[0].length - 1) grid[y][x + 1] = TILE.FLOOR;
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

    // Place spacious rooms
    const rooms = [];
    const roomTarget = 9 + Math.min(level, 4);
    const maxAttempts = 160;
    for (let attempt = 0; attempt < maxAttempts && rooms.length < roomTarget; attempt++) {
      const w = 6 + Math.floor(rng() * 7); // 6–12
      const h = 5 + Math.floor(rng() * 6); // 5–10
      const x = 2 + Math.floor(rng() * (cols - w - 4));
      const y = 2 + Math.floor(rng() * (rows - h - 4));
      const pad = 0;
      let overlaps = false;
      for (const r of rooms) {
        if (
          x - pad < r.x + r.w + pad &&
          x + w + pad > r.x - pad &&
          y - pad < r.y + r.h + pad &&
          y + h + pad > r.y - pad
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

    // Ensure at least a few rooms even on unlucky seeds
    if (rooms.length < 3) {
      const fallbacks = [
        { x: 3, y: 3, w: 10, h: 8 },
        { x: Math.floor(cols / 2) - 4, y: Math.floor(rows / 2) - 4, w: 11, h: 9 },
        { x: cols - 14, y: rows - 12, w: 10, h: 8 }
      ];
      for (const r of fallbacks) {
        if (r.x + r.w >= cols - 1 || r.y + r.h >= rows - 1) continue;
        carveRect(grid, r.x, r.y, r.w, r.h);
        rooms.push(r);
      }
    }

    // Connect rooms in MST-ish order (nearest-neighbor chain + a few extra loops)
    const connected = [0];
    const remaining = rooms.map((_, i) => i).slice(1);
    while (remaining.length) {
      let bestI = 0, bestJ = 0, bestD = Infinity;
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
      const c1 = roomCenter(rooms[bestI]);
      const c2 = roomCenter(rooms[j]);
      carveHall(grid, c1.x, c1.y, c2.x, c2.y, rng);
      connected.push(j);
    }
    // Extra halls for loops
    const extra = 1 + Math.floor(level / 2);
    for (let i = 0; i < extra && rooms.length > 2; i++) {
      const a = rooms[Math.floor(rng() * rooms.length)];
      const b = rooms[Math.floor(rng() * rooms.length)];
      if (a === b) continue;
      const c1 = roomCenter(a);
      const c2 = roomCenter(b);
      carveHall(grid, c1.x, c1.y, c2.x, c2.y, rng);
    }

    // Collect floors
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
      // Remove from floors
      for (let fi = floors.length - 1; fi >= 0; fi--) {
        if (floors[fi].x === picked.x && floors[fi].y === picked.y) {
          floors.splice(fi, 1);
          break;
        }
      }
      return picked;
    }

    // Start in first room center
    const startRoom = rooms[0];
    const start = roomCenter(startRoom);
    grid[start.y][start.x] = TILE.FLOOR;
    for (let i = floors.length - 1; i >= 0; i--) {
      if (floors[i].x === start.x && floors[i].y === start.y) floors.splice(i, 1);
    }

    // Exit in farthest room
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
    const exit = roomCenter(exitRoom);
    // Prefer a floor near exit room center that is still in floors list
    let exitCell = takeFarFrom(start.x, start.y, Math.floor((cols + rows) / 4));
    if (!exitCell) exitCell = { x: exit.x, y: exit.y };
    // Bias toward exit room if possible
    const exitRoomFloors = floors.filter(
      (c) =>
        c.x >= exitRoom.x &&
        c.x < exitRoom.x + exitRoom.w &&
        c.y >= exitRoom.y &&
        c.y < exitRoom.y + exitRoom.h
    );
    if (exitRoomFloors.length) {
      // put exitCell back conceptually — pick from exit room
      const pick = exitRoomFloors[Math.floor(rng() * exitRoomFloors.length)];
      for (let i = floors.length - 1; i >= 0; i--) {
        if (floors[i].x === pick.x && floors[i].y === pick.y) floors.splice(i, 1);
      }
      // restore previous exitCell to floors if different
      if (exitCell && (exitCell.x !== pick.x || exitCell.y !== pick.y)) {
        floors.push(exitCell);
      }
      exitCell = pick;
    }
    grid[exitCell.y][exitCell.x] = TILE.EXIT;

    // Subtle traps — prefer room interiors away from start
    const trapCount = 4 + level;
    const traps = [];
    for (let i = 0; i < trapCount && floors.length; i++) {
      const t = takeFarFrom(start.x, start.y, 6);
      if (!t) break;
      if (t.x === exitCell.x && t.y === exitCell.y) continue;
      grid[t.y][t.x] = TILE.TRAP;
      traps.push(t);
    }

    let potion = null;
    if (floors.length) {
      potion = takeFarFrom(start.x, start.y, 8);
      if (potion) grid[potion.y][potion.x] = TILE.POTION;
    }

    const clothTiles = [TILE.CLOTH_SHIRT, TILE.CLOTH_SHOES, TILE.CLOTH_PANTS];
    const clothPickups = [];
    for (const ct of clothTiles) {
      if (!floors.length) break;
      const c = takeFarFrom(start.x, start.y, 6);
      if (!c) break;
      grid[c.y][c.x] = ct;
      clothPickups.push({ x: c.x, y: c.y, tile: ct });
    }

    const enemySpawns = [];
    const minionCount = 2 + Math.min(level, 3);
    for (let i = 0; i < minionCount + 1; i++) {
      const e = takeFarFrom(start.x, start.y, 10);
      if (!e) break;
      enemySpawns.push(e);
    }

    // Wall sconces / torches near walls inside rooms & halls
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
      enemySpawns,
      torches,
      rooms,
      seed,
      TILE
    };
  }

  /** Pick a random floor tile far from (px,py); never on that tile. */
  function randomFloorFar(maze, px, py, minDist) {
    const floors = [];
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        if (maze.grid[y][x] === TILE.WALL) continue;
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
        if (d < (minDist || 8)) continue;
        floors.push({ x, y, d });
      }
    }
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
    // Prefer farther tiles
    floors.sort((a, b) => b.d - a.d);
    const top = floors.slice(0, Math.max(8, Math.floor(floors.length * 0.35)));
    return top[Math.floor(Math.random() * top.length)];
  }

  return { generate, TILE, mulberry32, randomFloorFar };
})();
