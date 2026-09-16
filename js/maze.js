/**
 * Cave maze generator — recursive backtracker with rooms & open caves.
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

  const TILE = { WALL: 1, FLOOR: 0, EXIT: 2, TRAP: 3, POTION: 4, CLOTH_SHIRT: 5, CLOTH_SHOES: 6, CLOTH_PANTS: 7 };

  function generate(cols, rows, seed, level) {
    const rng = mulberry32(seed >>> 0);
    const grid = Array.from({ length: rows }, () => Array(cols).fill(TILE.WALL));

    // Odd cells as carve targets
    function inBounds(x, y) {
      return x > 0 && y > 0 && x < cols - 1 && y < rows - 1;
    }

    const stack = [];
    let cx = 1, cy = 1;
    grid[cy][cx] = TILE.FLOOR;
    stack.push([cx, cy]);

    const dirs = [[2, 0], [-2, 0], [0, 2], [0, -2]];

    while (stack.length) {
      const [x, y] = stack[stack.length - 1];
      const neighbors = [];
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (inBounds(nx, ny) && grid[ny][nx] === TILE.WALL) neighbors.push([nx, ny, dx, dy]);
      }
      if (!neighbors.length) {
        stack.pop();
        continue;
      }
      // shuffle
      for (let i = neighbors.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [neighbors[i], neighbors[j]] = [neighbors[j], neighbors[i]];
      }
      const [nx, ny, dx, dy] = neighbors[0];
      grid[y + dy / 2][x + dx / 2] = TILE.FLOOR;
      grid[ny][nx] = TILE.FLOOR;
      stack.push([nx, ny]);
    }

    // Carve some wider caves / loops for fairness
    const openPasses = 8 + level * 2;
    for (let i = 0; i < openPasses; i++) {
      const x = 1 + Math.floor(rng() * (cols - 2));
      const y = 1 + Math.floor(rng() * (rows - 2));
      if (grid[y][x] === TILE.WALL) {
        let floorN = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (grid[y + dy] && grid[y + dy][x + dx] === TILE.FLOOR) floorN++;
        }
        if (floorN >= 2) grid[y][x] = TILE.FLOOR;
      }
    }

    // Collect floor cells
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
      const pool = candidates.length ? candidates : floors;
      const i = Math.floor(rng() * pool.length);
      return pool.splice(i, 1)[0] || floors.pop();
    }

    const start = { x: 1, y: 1 };
    // ensure start is floor
    grid[start.y][start.x] = TILE.FLOOR;

    // Remove start from floors list
    for (let i = floors.length - 1; i >= 0; i--) {
      if (floors[i].x === start.x && floors[i].y === start.y) floors.splice(i, 1);
    }

    const exit = takeFarFrom(start.x, start.y, Math.floor((cols + rows) / 3));
    grid[exit.y][exit.x] = TILE.EXIT;

    // Traps
    const trapCount = 3 + level;
    const traps = [];
    for (let i = 0; i < trapCount && floors.length; i++) {
      const t = takeFarFrom(start.x, start.y, 4);
      if (!t) break;
      if (t.x === exit.x && t.y === exit.y) continue;
      grid[t.y][t.x] = TILE.TRAP;
      traps.push(t);
    }

    // Potion
    let potion = null;
    if (floors.length) {
      potion = takeFarFrom(start.x, start.y, 6);
      if (potion) grid[potion.y][potion.x] = TILE.POTION;
    }

    // Clothing pickups (one of each) — for when player loses them
    const clothTiles = [TILE.CLOTH_SHIRT, TILE.CLOTH_SHOES, TILE.CLOTH_PANTS];
    const clothPickups = [];
    for (const ct of clothTiles) {
      if (!floors.length) break;
      const c = takeFarFrom(start.x, start.y, 5);
      if (!c) break;
      grid[c.y][c.x] = ct;
      clothPickups.push({ x: c.x, y: c.y, tile: ct });
    }

    // Enemy spawns
    const enemySpawns = [];
    const minionCount = 2 + Math.min(level, 3);
    for (let i = 0; i < minionCount + 1; i++) {
      // +1 for succubus
      const e = takeFarFrom(start.x, start.y, 8);
      if (!e) break;
      enemySpawns.push(e);
    }

    // Wall-mounted / corridor torches (warm glow pools)
    const torches = [];
    const torchTarget = 6 + level;
    const torchCandidates = [];
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (grid[y][x] !== TILE.FLOOR) continue;
        let wallN = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (grid[y + dy][x + dx] === TILE.WALL) wallN++;
        }
        // Prefer corridor / near-wall floor cells for torch sconces
        if (wallN >= 1) torchCandidates.push({ x, y });
      }
    }
    for (let i = torchCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [torchCandidates[i], torchCandidates[j]] = [torchCandidates[j], torchCandidates[i]];
    }
    const used = new Set();
    for (const c of torchCandidates) {
      if (torches.length >= torchTarget) break;
      const k = c.x + "," + c.y;
      if (used.has(k)) continue;
      // Space torches apart a bit
      let ok = true;
      for (const t of torches) {
        if (Math.abs(t.x - c.x) + Math.abs(t.y - c.y) < 4) { ok = false; break; }
      }
      if (!ok) continue;
      used.add(k);
      torches.push({ x: c.x, y: c.y });
    }

    return {
      cols, rows, grid, start, exit, traps, potion, clothPickups, enemySpawns, torches, seed, TILE
    };
  }

  return { generate, TILE, mulberry32 };
})();
