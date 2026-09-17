/**
 * Tickle Maze — underground mansion engine (Canvas 2D)
 */
(function () {
  "use strict";

  const TILE = window.MazeGen.TILE;
  const CELL = 80; // 2× tiles (~20×14 tiles on 1600×1120)
  const PX = CELL / 40; // scale factor for map décor / wall detail
  // Entity sprites ~5× larger than the old PX-authored radii (keep CELL so rooms stay screen-filling)
  const SP = PX * (5 / 3); // was 5×; user: 3× smaller
  // Large mansion — camera frames a window into the current room
  const COLS = 96;
  const ROWS = 72;

  // Speeds: walk < succubus chase < sprint (light bump so big rooms don't feel sluggish)
  const PLAYER_WALK = 2.85;
  const PLAYER_SPRINT = 5.05;
  const SUCC_WANDER = 2.35;
  const SUCC_CHASE = SUCC_WANDER * 1.35; // ~3.17 — faster than walk, slower than sprint
  const MINION_SPEED = 2.15;

  const STAMINA_MAX = 100;
  const STAMINA_DRAIN = 32; // /sec while sprinting
  const STAMINA_REGEN = 16; // /sec when not

  // Flashlight / lighting
  const FLASH_RANGE = 5.8;
  const FLASH_CONE_DEG = 60;
  const FLASH_HALF = (FLASH_CONE_DEG * Math.PI) / 180 / 2;
  const FLASH_COS = Math.cos(FLASH_HALF);
  const AMBIENT_DARK = 0.68; // warmer room read vs refs
  const TORCH_RADIUS = 4.2;

  // Room-locked camera: soft follow inside current region
  const CAM_EDGE_FOLLOW = 0.55;
  const CAM_LERP = 8.5;
  const CAM_ROOM_PAD = 0.5; // mid-wall (~50% into boundary wall) so doorways stay visible
  const CAM_ROOM_TRANSITION = 5.5;

  // Oblique / elevated side view (simulation stays tile-space; drawing projects)
  // screenX = dx*kx + dy*skew, screenY = dy*ky — look into the room from the south
  const ISO = {
    kx: 74, // tile width on screen
    ky: 56, // foreshortened depth (elevated angle)
    skew: 34, // side angle (y pushes x)
    wallH: 68, // vertical wall face height (px)
    padTop: 72 // leave room for north walls rising above floor
  };

  // Succubus sight
  const SUCC_LOS_RANGE = 11;
  const SUCC_HEAR_RANGE = 14;

  // Flying tickly minion visual varieties (behavior identical)
  const MINION_TYPES = [
    { id: "bat", body: "#a78bfa", wing: "#7c3aed", eye: "#fde047", accent: "#c4b5fd", wingStyle: "bat" },
    { id: "moth", body: "#f9a8d4", wing: "#fbcfe8", eye: "#fff7ed", accent: "#fce7f3", wingStyle: "moth" },
    { id: "imp", body: "#fb923c", wing: "#ea580c", eye: "#fef08a", accent: "#fdba74", wingStyle: "pointy" },
    { id: "wisp", body: "#67e8f9", wing: "#22d3ee", eye: "#ecfeff", accent: "#a5f3fc", wingStyle: "wispy" },
    { id: "beetle", body: "#86efac", wing: "#4ade80", eye: "#fef9c3", accent: "#bbf7d0", wingStyle: "bug" },
    { id: "raven", body: "#c084fc", wing: "#6b21a8", eye: "#fde68a", accent: "#e9d5ff", wingStyle: "raven" }
  ];

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const canvas = $("game-canvas");
  const ctx = canvas.getContext("2d");
  const cineCanvas = $("cine-canvas");
  const cineCtx = cineCanvas.getContext("2d");
  const lightCanvas = document.createElement("canvas");
  lightCanvas.width = canvas.width;
  lightCanvas.height = canvas.height;
  const lightCtx = lightCanvas.getContext("2d");

  // --- State ---
  let muted = false;
  let level = 1;
  let levelSeed = 42;
  let maze = null;
  let player = null;
  let keysCollected = 0;
  let keysRequired = 3;
  let gateUnlocked = false;
  let lockedGateToastAt = 0;
  let enemies = [];
  let mode = "title";
  let invulnUntil = 0;
  let keys = Object.create(null);
  let lastTs = 0;
  let toastTimer = null;
  let particles = [];
  let torchFlicker = 0;
  let resistState = null;
  let camera = {
    x: 0,
    y: 0,
    initialized: false,
    regionId: null,
    transitioning: false
  };
  let clothingLossStack = []; // LIFO order of lost pieces (shirt/shoes/pants)
  let animTime = 0;
  let floatTexts = [];
  let heartbeat = { next: 0, gain: null, osc: null };
  let succubusRef = null;

  function defaultClothing() {
    return { shirt: true, shoes: true, pants: true };
  }

  function clothingCount(c) {
    return (c.shirt ? 1 : 0) + (c.shoes ? 1 : 0) + (c.pants ? 1 : 0);
  }

  function isFullyClothed() {
    return clothingCount(player.clothing) >= 3;
  }

  /** Record a single-piece loss (LIFO restore). */
  function loseClothingPiece(piece) {
    if (!player.clothing[piece]) return false;
    player.clothing[piece] = false;
    clothingLossStack.push(piece);
    return true;
  }

  /** Strip every worn piece, pushing each onto the LIFO stack (shirt→shoes→pants). */
  function stripAllClothing() {
    let any = false;
    for (const p of ["shirt", "shoes", "pants"]) {
      if (player.clothing[p]) {
        player.clothing[p] = false;
        clothingLossStack.push(p);
        any = true;
      }
    }
    return any;
  }

  /**
   * Restore the last-lost missing piece (LIFO). Returns piece name or null.
   * Does not modify pickups — caller decides whether to consume.
   */
  function restoreLastLostPiece() {
    if (isFullyClothed()) return null;
    while (clothingLossStack.length) {
      const p = clothingLossStack.pop();
      if (!player.clothing[p]) {
        player.clothing[p] = true;
        return p;
      }
    }
    // Stack empty but still missing (edge case): restore first missing
    for (const p of ["shirt", "shoes", "pants"]) {
      if (!player.clothing[p]) {
        player.clothing[p] = true;
        return p;
      }
    }
    return null;
  }

  function computeTicklishnessPct() {
    const base = 20 + player.sensitivity * 0.8;
    const reduced = base - clothingCount(player.clothing) * 15;
    return Math.max(0, Math.min(100, Math.round(reduced)));
  }

  // --- Audio ---
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {}
    }
    return audioCtx;
  }

  function beep(freq, dur, type) {
    if (muted) return;
    try {
      const ac = ensureAudio();
      if (!ac) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type || "sine";
      o.frequency.value = freq;
      g.gain.value = 0.04;
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
      o.stop(ac.currentTime + dur);
    } catch (_) {}
  }

  /** Soft heartbeat thump — volume scales with proximity (0–1). */
  function playHeartbeat(intensity) {
    if (muted || intensity < 0.05) return;
    try {
      const ac = ensureAudio();
      if (!ac) return;
      const now = ac.currentTime;
      const vol = 0.02 + intensity * 0.14;

      function thump(delay, freq) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + delay);
        g.gain.exponentialRampToValueAtTime(vol, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.16);
        o.connect(g);
        g.connect(ac.destination);
        o.start(now + delay);
        o.stop(now + delay + 0.18);
      }
      thump(0, 55);
      thump(0.12, 48);
    } catch (_) {}
  }

  function updateHeartbeat(dt) {
    if (mode !== "play" || !succubusRef || !player) return;
    const dist = Math.hypot(player.x - succubusRef.x, player.y - succubusRef.y);
    if (dist > SUCC_HEAR_RANGE) {
      heartbeat.next = Math.max(heartbeat.next, 0.4);
      return;
    }
    // Closer → louder & faster
    const t = 1 - dist / SUCC_HEAR_RANGE;
    const intensity = Math.pow(t, 1.35);
    const interval = 1.15 - intensity * 0.7; // 1.15s → ~0.45s
    heartbeat.next -= dt;
    if (heartbeat.next <= 0) {
      playHeartbeat(intensity);
      heartbeat.next = Math.max(0.35, interval);
    }
  }

  // --- UI helpers ---
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
  }

  function showOverlay(id, show) {
    const el = $(id);
    if (show) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }

  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), ms || 2200);
  }

  function updateHUD() {
    if (!player) return;
    ["shirt", "shoes", "pants"].forEach((p) => {
      const el = $("cloth-" + p);
      if (player.clothing[p]) el.classList.remove("gone");
      else el.classList.add("gone");
    });
    const tick = computeTicklishnessPct();
    $("tickle-fill").style.width = tick + "%";
    $("tickle-pct").textContent = tick + "%";
    $("sens-fill").style.width = player.sensitivity + "%";
    $("sens-pct").textContent = Math.round(player.sensitivity) + "%";
    $("stamina-fill").style.width = player.stamina + "%";
    $("stamina-pct").textContent = Math.round(player.stamina) + "%";
    $("level-label").textContent = "Level " + level;
    const keysEl = $("keys-label");
    if (keysEl) {
      keysEl.textContent = "Keys " + keysCollected + "/" + keysRequired;
      keysEl.classList.toggle("ready", keysCollected >= keysRequired);
    }
  }

  function setMuteUI() {
    $("btn-mute").textContent = muted ? "🔇" : "🔊";
    $("btn-mute-title").textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
  }

  // --- Level setup ---
  /**
   * Build / rebuild a level.
   * opts.keepSeed — reuse levelSeed (retry same layout)
   * opts.carryRisk — keep clothing + sensitivity from previous level (level advance)
   * Without carryRisk: full clothes + sensitivity 0 (fresh start / game-over restart)
   */
  function buildLevel(keepSeed, opts) {
    opts = opts || {};
    const carryRisk = !!opts.carryRisk;
    const prevClothing = player && carryRisk ? { ...player.clothing } : null;
    const prevSens = player && carryRisk ? player.sensitivity : 0;
    const prevLoss = carryRisk ? clothingLossStack.slice() : [];

    if (!keepSeed) levelSeed = (Date.now() ^ (level * 9973)) >>> 0;
    // Map size / room count / dead-end rate come from MazeGen.levelParams(level)
    const lp =
      (window.MazeGen.levelParams && window.MazeGen.levelParams(level)) || {
        cols: COLS,
        rows: ROWS
      };
    maze = window.MazeGen.generate(lp.cols, lp.rows, levelSeed + level * 10007, level);

    keysRequired = maze.keysRequired || window.MazeGen.KEYS_REQUIRED || 3;
    keysCollected = 0;
    gateUnlocked = false;

    player = {
      x: maze.start.x + 0.5,
      y: maze.start.y + 0.5,
      speed: PLAYER_WALK,
      clothing: prevClothing || defaultClothing(),
      sensitivity: carryRisk ? prevSens : 0,
      facing: 0,
      facingDx: 1,
      facingDy: 0,
      stamina: STAMINA_MAX,
      sprinting: false
    };
    enemies = [];
    succubusRef = null;
    const spawns = (maze.enemySpawns && maze.enemySpawns.slice()) || [];
    // Guarantee at least one spawn slot for the succubus
    if (!spawns.length) {
      const far =
        (window.MazeGen.randomFloorFar &&
          window.MazeGen.randomFloorFar(maze, maze.start.x, maze.start.y, 10)) ||
        null;
      spawns.push(far || { x: maze.start.x + 3, y: maze.start.y });
    }
    spawns.forEach((s, i) => {
      const isSucc = i === 0;
      const mt = MINION_TYPES[(i - 1) % MINION_TYPES.length];
      const e = {
        x: s.x + 0.5,
        y: s.y + 0.5,
        kind: isSucc ? "succubus" : "minion",
        minionType: isSucc ? null : mt.id,
        sprite: isSucc ? null : mt,
        speed: isSucc ? SUCC_WANDER : MINION_SPEED,
        wanderSpeed: isSucc ? SUCC_WANDER : MINION_SPEED,
        chaseSpeed: isSucc ? SUCC_CHASE : MINION_SPEED * 1.15,
        awareness: isSucc ? SUCC_LOS_RANGE : 14,
        pathTimer: 0,
        path: [],
        anim: Math.random() * Math.PI * 2,
        scared: false,
        fleeUntil: 0,
        fleeing: false,
        despawnAt: 0,
        hasSight: false,
        chasing: false,
        wanderTarget: null
      };
      enemies.push(e);
      if (isSucc) succubusRef = e;
    });
    // Hard guarantee: if somehow missing, inject succubus far from player
    if (!succubusRef) {
      const far =
        (window.MazeGen.randomFloorFar &&
          window.MazeGen.randomFloorFar(maze, player.x, player.y, 12)) ||
        { x: maze.exit.x, y: maze.exit.y };
      const e = {
        x: far.x + 0.5,
        y: far.y + 0.5,
        kind: "succubus",
        minionType: null,
        sprite: null,
        speed: SUCC_WANDER,
        wanderSpeed: SUCC_WANDER,
        chaseSpeed: SUCC_CHASE,
        awareness: SUCC_LOS_RANGE,
        pathTimer: 0,
        path: [],
        anim: Math.random() * Math.PI * 2,
        scared: false,
        fleeUntil: 0,
        fleeing: false,
        despawnAt: 0,
        hasSight: false,
        chasing: false,
        wanderTarget: null
      };
      enemies.unshift(e);
      succubusRef = e;
    }
    particles = [];
    floatTexts = [];
    invulnUntil = 0;
    clothingLossStack = prevLoss;
    if (!carryRisk) clothingLossStack = [];
    camera.initialized = false;
    camera.regionId = null;
    camera.transitioning = false;
    heartbeat.next = 0.5;
    updateHUD();
  }

  function startGame(fresh) {
    level = 1;
    if (fresh) levelSeed = (Math.random() * 1e9) >>> 0;
    buildLevel(true);
    mode = "play";
    showScreen("game-screen");
    showOverlay("cinematic", false);
    showOverlay("pause-overlay", false);
    showOverlay("win-overlay", false);
    showOverlay("gameover-overlay", false);
    ensureAudio();
    beep(440, 0.08);
    toast("Find " + keysRequired + " keys to unlock the exit gate…", 3000);
  }

  function restartSameLevel() {
    buildLevel(true);
    mode = "play";
    showOverlay("gameover-overlay", false);
    showOverlay("win-overlay", false);
    showOverlay("cinematic", false);
    showOverlay("pause-overlay", false);
    showScreen("game-screen");
    toast("Retry! Same mansion — clothes restored, sensitivity cleared.", 2500);
    beep(523, 0.1);
  }

  function nextLevel() {
    level++;
    // New seed/layout; clothing & sensitivity carry forward as ongoing risk
    buildLevel(false, { carryRisk: true });
    mode = "play";
    showOverlay("win-overlay", false);
    toast(
      "Deeper into the manor… Level " +
        level +
        " — find " +
        keysRequired +
        " keys. Harder halls await!",
      2800
    );
  }

  // --- Collision / movement ---
  function isWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= maze.cols || ty >= maze.rows) return true;
    return maze.grid[ty][tx] === TILE.WALL;
  }

  function tryMove(ent, dx, dy, dt, speed) {
    const nx = ent.x + dx * speed * dt;
    const ny = ent.y + dy * speed * dt;
    const r = 0.28;
    let x = ent.x,
      y = ent.y;
    if (
      !isWall(Math.floor(nx - r), Math.floor(ent.y - r)) &&
      !isWall(Math.floor(nx + r), Math.floor(ent.y - r)) &&
      !isWall(Math.floor(nx - r), Math.floor(ent.y + r)) &&
      !isWall(Math.floor(nx + r), Math.floor(ent.y + r))
    ) {
      x = nx;
    }
    if (
      !isWall(Math.floor(x - r), Math.floor(ny - r)) &&
      !isWall(Math.floor(x + r), Math.floor(ny - r)) &&
      !isWall(Math.floor(x - r), Math.floor(ny + r)) &&
      !isWall(Math.floor(x + r), Math.floor(ny + r))
    ) {
      y = ny;
    }
    ent.x = x;
    ent.y = y;
  }

  // --- Line of sight (Bresenham through open floors) ---
  function hasLineOfSight(x0, y0, x1, y1, maxRange) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist > maxRange) return false;
    const steps = Math.max(2, Math.ceil(dist * 4));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (isWall(Math.floor(x), Math.floor(y))) return false;
    }
    return true;
  }

  // --- Pathfinding ---
  function findPath(sx, sy, gx, gy) {
    const start = { x: Math.floor(sx), y: Math.floor(sy) };
    const goal = { x: Math.floor(gx), y: Math.floor(gy) };
    if (start.x === goal.x && start.y === goal.y) return [];
    const key = (x, y) => x + "," + y;
    const q = [start];
    const came = new Map();
    came.set(key(start.x, start.y), null);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    let found = false;
    let guard = 0;
    const guardMax = Math.max(
      8000,
      (maze.floors && maze.floors.length) || maze.cols * maze.rows
    );
    while (q.length && guard++ < guardMax) {
      const cur = q.shift();
      if (cur.x === goal.x && cur.y === goal.y) {
        found = true;
        break;
      }
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx,
          ny = cur.y + dy;
        if (isWall(nx, ny)) continue;
        const k = key(nx, ny);
        if (came.has(k)) continue;
        came.set(k, cur);
        q.push({ x: nx, y: ny });
      }
    }
    if (!found) return [];
    const path = [];
    let c = goal;
    while (c) {
      path.push(c);
      c = came.get(key(c.x, c.y));
    }
    path.reverse();
    return path.slice(1);
  }

  function enemyInFlashlight(e) {
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05 || dist > FLASH_RANGE) return false;
    const nx = dx / dist;
    const ny = dy / dist;
    const dot = player.facingDx * nx + player.facingDy * ny;
    return dot >= FLASH_COS;
  }

  /** True if world point sits in the player's rear hemisphere (opposite facing). */
  function isBehindPlayer(ex, ey) {
    const dx = ex - player.x;
    const dy = ey - player.y;
    const len = Math.hypot(dx, dy) || 1;
    const dot = player.facingDx * (dx / len) + player.facingDy * (dy / len);
    return dot < -0.2;
  }

  /**
   * Persistent sneak/flank goal: walkable cell behind the player, preferably
   * outside the flashlight cone. Circles via side-rear offsets so minions
   * approach from behind instead of charging the beam.
   */
  function sneakFlankTarget(e, preferClose) {
    const backDx = -player.facingDx;
    const backDy = -player.facingDy;
    const sideDx = -player.facingDy;
    const sideDy = player.facingDx;
    const toEx = e.x - player.x;
    const toEy = e.y - player.y;
    const sideSign = toEx * sideDx + toEy * sideDy >= 0 ? 1 : -1;

    const candidates = [];
    const dists = preferClose ? [0.85, 1.2, 1.55, 2.0] : [1.5, 2.1, 2.7, 3.4, 4.2];
    for (const d of dists) {
      candidates.push({ x: player.x + backDx * d, y: player.y + backDy * d, bias: 3 });
      candidates.push({
        x: player.x + backDx * d * 0.72 + sideDx * sideSign * d * 0.9,
        y: player.y + backDy * d * 0.72 + sideDy * sideSign * d * 0.9,
        bias: 4
      });
      candidates.push({
        x: player.x + backDx * d * 0.72 - sideDx * sideSign * d * 0.9,
        y: player.y + backDy * d * 0.72 - sideDy * sideSign * d * 0.9,
        bias: 2
      });
      candidates.push({
        x: player.x + backDx * d * 0.3 + sideDx * sideSign * d * 1.15,
        y: player.y + backDy * d * 0.3 + sideDy * sideSign * d * 1.15,
        bias: 1.4
      });
    }
    if (preferClose && isBehindPlayer(e.x, e.y)) {
      candidates.push({ x: player.x, y: player.y, bias: 5 });
    }

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const tx = Math.floor(c.x);
      const ty = Math.floor(c.y);
      if (isWall(tx, ty)) continue;
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      const inBeam = enemyInFlashlight({ x: cx, y: cy });
      const behind = isBehindPlayer(cx, cy);
      const distToMe = Math.hypot(cx - e.x, cy - e.y);
      const distToPlayer = Math.hypot(cx - player.x, cy - player.y);
      let score = c.bias * 10;
      if (behind) score += 8;
      if (!inBeam) score += 6;
      else score -= 12;
      score -= distToMe * 0.35;
      if (distToPlayer < 3.5) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = { x: tx, y: ty };
      }
    }
    if (!best) {
      const bx = Math.floor(player.x + backDx * 2);
      const by = Math.floor(player.y + backDy * 2);
      if (!isWall(bx, by)) return { x: bx, y: by };
      return { x: Math.floor(player.x), y: Math.floor(player.y) };
    }
    return best;
  }

  function fleeTargetAwayFromPlayer(e) {
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const len = Math.hypot(dx, dy) || 1;
    let fx = dx / len;
    let fy = dy / len;
    let best = null;
    for (let s = 6; s >= 1; s--) {
      const tx = Math.floor(e.x + fx * s);
      const ty = Math.floor(e.y + fy * s);
      if (!isWall(tx, ty)) {
        best = { x: tx, y: ty };
        break;
      }
    }
    if (!best) {
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ];
      let bestScore = -Infinity;
      for (const [ox, oy] of dirs) {
        const tx = Math.floor(e.x) + ox;
        const ty = Math.floor(e.y) + oy;
        if (isWall(tx, ty)) continue;
        const score = Math.hypot(tx + 0.5 - player.x, ty + 0.5 - player.y);
        if (score > bestScore) {
          bestScore = score;
          best = { x: tx, y: ty };
        }
      }
    }
    return best;
  }

  function spawnScareText(e) {
    floatTexts.push({
      x: e.x,
      y: e.y - 0.6,
      text: "Minion fled!",
      life: 1.2,
      vy: -0.55
    });
    beep(320, 0.08, "triangle");
  }

  const RESPAWN_PEER_DIST = 7;
  const RESPAWN_PLAYER_DIST = 12;

  /** World positions of other living enemies (optionally excluding one). */
  function enemyAvoidList(exclude) {
    const list = [];
    for (const o of enemies) {
      if (o === exclude) continue;
      if (o.fleeing && o.despawnAt && performance.now() < o.despawnAt) continue;
      list.push({ x: o.x, y: o.y });
    }
    return list;
  }

  function clearEnemyCombatState(e) {
    e.scared = false;
    e.fleeing = false;
    e.despawnAt = 0;
    e.hasSight = false;
    e.chasing = false;
    e.path = [];
    e.pathTimer = 0.4 + Math.random() * 0.4;
    e.speed = e.wanderSpeed;
    e.wanderTarget = null;
  }

  /** Place one creature on a spaced floor tile; resumes aimless wander. */
  function respawnCreature(e, showDots) {
    const avoid = enemyAvoidList(e);
    const spot = window.MazeGen.randomFloorFar(
      maze,
      player.x,
      player.y,
      RESPAWN_PLAYER_DIST,
      avoid,
      RESPAWN_PEER_DIST
    );
    if (!spot) return;
    e.x = spot.x + 0.5;
    e.y = spot.y + 0.5;
    clearEnemyCombatState(e);
    if (showDots !== false) {
      floatTexts.push({
        x: e.x,
        y: e.y - 0.5,
        text: "…",
        life: 0.8,
        vy: -0.3
      });
    }
  }

  function respawnMinion(e) {
    respawnCreature(e, true);
  }

  /**
   * After any completed tickle resolution: all minions + succubus vanish and
   * respawn spaced apart on the current level, chase/LOS cleared (wander).
   * Triggered traps stay gone until the level is reloaded.
   */
  function afterTickleResolve() {
    // Respawn sequentially so each respects already-placed peers
    const order = enemies.slice().sort((a, b) => (a.kind === "succubus" ? -1 : 1));
    for (const e of order) {
      respawnCreature(e, true);
    }
    if (succubusRef) {
      succubusRef.hasSight = false;
      succubusRef.chasing = false;
      succubusRef.speed = succubusRef.wanderSpeed;
    }
  }

  function updateEnemies(dt) {
    const now = performance.now();
    for (const e of enemies) {
      e.anim += dt * 4;

      // Minion mid-despawn / respawn
      if (e.kind === "minion" && e.fleeing && e.despawnAt && now >= e.despawnAt) {
        respawnMinion(e);
        continue;
      }

      const dist = Math.hypot(player.x - e.x, player.y - e.y);

      // --- Succubus: ignore flashlight; LOS chase ---
      if (e.kind === "succubus") {
        const sight = hasLineOfSight(e.x, e.y, player.x, player.y, SUCC_LOS_RANGE);
        e.hasSight = sight;
        e.chasing = sight;
        e.speed = sight ? e.chaseSpeed : e.wanderSpeed;

        e.pathTimer -= dt;
        if (sight) {
          // Direct LOS chase (ignores flashlight); still grab on contact
          if (e.pathTimer <= 0) {
            e.path = findPath(e.x, e.y, player.x, player.y);
            e.pathTimer = 0.28;
          }
        } else {
          // No LOS: prefer flanking toward the player's rear (sneak approach)
          if (e.pathTimer <= 0 || !e.path || !e.path.length) {
            e.pathTimer = 0.5 + Math.random() * 0.35;
            const dest = sneakFlankTarget(e, dist < 3.2);
            e.path = findPath(e.x, e.y, dest.x + 0.5, dest.y + 0.5);
            if (!e.path.length) {
              const ang = Math.random() * Math.PI * 2;
              const distW = 2 + Math.random() * 4;
              let tx = Math.floor(e.x + Math.cos(ang) * distW);
              let ty = Math.floor(e.y + Math.sin(ang) * distW);
              if (!isWall(tx, ty)) e.path = findPath(e.x, e.y, tx + 0.5, ty + 0.5);
              else e.path = [];
            }
          }
        }

        if (e.path && e.path.length) {
          const t = e.path[0];
          const tx = t.x + 0.5,
            ty = t.y + 0.5;
          const dx = tx - e.x,
            dy = ty - e.y;
          const len = Math.hypot(dx, dy) || 1;
          tryMove(e, dx / len, dy / len, dt, e.speed);
          if (Math.hypot(tx - e.x, ty - e.y) < 0.15) e.path.shift();
        }

        if (now >= invulnUntil && dist < 0.55) {
          triggerCatch("succubus");
          return;
        }
        continue;
      }

      // --- Minions: flashlight scares → flee → despawn → respawn ---
      const beamed = enemyInFlashlight(e);
      if (beamed && !e.fleeing) {
        e.scared = true;
        e.fleeing = true;
        e.fleeUntil = now + 900;
        e.despawnAt = now + 1100;
        spawnScareText(e);
      }

      e.pathTimer -= dt;

      if (e.fleeing || e.scared) {
        if (e.pathTimer <= 0) {
          const dest = fleeTargetAwayFromPlayer(e);
          if (dest) {
            e.path = findPath(e.x, e.y, dest.x + 0.5, dest.y + 0.5);
            if (!e.path.length) e.path = [dest];
          }
          e.pathTimer = 0.22;
        }
        const fleeSpeed = e.wanderSpeed * 1.55;
        if (e.path && e.path.length) {
          const t = e.path[0];
          const tx = t.x + 0.5,
            ty = t.y + 0.5;
          const dx = tx - e.x,
            dy = ty - e.y;
          const len = Math.hypot(dx, dy) || 1;
          tryMove(e, dx / len, dy / len, dt, fleeSpeed);
          if (Math.hypot(tx - e.x, ty - e.y) < 0.15) e.path.shift();
        }
        continue;
      }

      // Persistently sneak: path to rear/flank (outside cone), then grab from behind
      if (e.pathTimer <= 0) {
        const close = dist < 2.4;
        if (dist < 1.35 && (isBehindPlayer(e.x, e.y) || dist < 0.9)) {
          // Close enough behind (or hugging) — dive for the grab
          e.path = findPath(e.x, e.y, player.x, player.y);
        } else {
          const dest = sneakFlankTarget(e, close);
          e.path = findPath(e.x, e.y, dest.x + 0.5, dest.y + 0.5);
          if (!e.path.length) e.path = [dest];
        }
        e.pathTimer = close ? 0.26 : 0.4;
      }
      // Slightly quicker when already behind so grabs feel snappy
      const sneakSpeed =
        isBehindPlayer(e.x, e.y) && dist < 3.5 ? e.wanderSpeed * 1.12 : e.wanderSpeed;
      if (e.path && e.path.length) {
        const t = e.path[0];
        const tx = t.x + 0.5,
          ty = t.y + 0.5;
        const dx = tx - e.x,
          dy = ty - e.y;
        const len = Math.hypot(dx, dy) || 1;
        tryMove(e, dx / len, dy / len, dt, sneakSpeed);
        if (Math.hypot(tx - e.x, ty - e.y) < 0.15) e.path.shift();
      }

      if (now >= invulnUntil && dist < 0.55) {
        if (enemyInFlashlight(e)) {
          e.scared = true;
          e.fleeing = true;
          e.fleeUntil = now + 900;
          e.despawnAt = now + 1100;
          spawnScareText(e);
          continue;
        }
        triggerCatch("minion");
        return;
      }
    }
  }

  function succubusActivelyChasing() {
    return !!(succubusRef && succubusRef.hasSight && succubusRef.chasing);
  }

  // --- Pickups / traps ---
  function checkTiles() {
    const tx = Math.floor(player.x);
    const ty = Math.floor(player.y);
    if (tx < 0 || ty < 0 || tx >= maze.cols || ty >= maze.rows) return;
    const t = maze.grid[ty][tx];
    if (t === TILE.EXIT) {
      if (keysCollected >= keysRequired) {
        if (!gateUnlocked) {
          gateUnlocked = true;
          toast("The gate unlocks with a heavy click!", 1800);
          beep(880, 0.12, "triangle");
        }
        winLevel();
      } else {
        const now = performance.now();
        if (now - lockedGateToastAt > 1800) {
          lockedGateToastAt = now;
          const need = keysRequired - keysCollected;
          toast(
            "Gate locked — need " +
              need +
              " more key" +
              (need === 1 ? "" : "s") +
              " (" +
              keysCollected +
              "/" +
              keysRequired +
              ")",
            2000
          );
          beep(180, 0.08, "square");
        }
      }
      return;
    }
    if (t === TILE.KEY) {
      maze.grid[ty][tx] = TILE.FLOOR;
      keysCollected++;
      updateHUD();
      spawnPickupFX(tx, ty, "#fbbf24");
      beep(740, 0.1, "triangle");
      if (keysCollected >= keysRequired) {
        gateUnlocked = true;
        toast("Keys " + keysCollected + "/" + keysRequired + " — the exit gate can open!", 2600);
        beep(990, 0.15, "triangle");
      } else {
        toast("Key found! (" + keysCollected + "/" + keysRequired + ")", 2000);
      }
      return;
    }
    if (t === TILE.TRAP && performance.now() >= invulnUntil) {
      maze.grid[ty][tx] = TILE.FLOOR;
      if (succubusActivelyChasing()) {
        triggerComboCatch();
      } else {
        triggerCatch("trap");
      }
      return;
    }
    if (t === TILE.POTION) {
      maze.grid[ty][tx] = TILE.FLOOR;
      player.sensitivity = Math.max(0, player.sensitivity - 40);
      if (player.sensitivity < 5) player.sensitivity = 0;
      updateHUD();
      toast("Sensitivity potion! A cool wave washes the tickles away… (−40%)", 2600);
      beep(660, 0.15, "triangle");
      spawnPickupFX(tx, ty, "#5eead4");
    }
    if (t === TILE.CLOTH_SHIRT || t === TILE.CLOTH_SHOES || t === TILE.CLOTH_PANTS) {
      // Any clothing pickup restores the last-lost piece (LIFO).
      // Full clothing: do nothing — pickup stays on the map.
      if (isFullyClothed()) {
        return;
      }
      const names = { shirt: "Shirt", shoes: "Shoes", pants: "Pants" };
      const restored = restoreLastLostPiece();
      if (!restored) return;
      maze.grid[ty][tx] = TILE.FLOOR;
      toast("Recovered your " + names[restored] + "! (−15% ticklishness)", 2200);
      beep(520, 0.1);
      updateHUD();
      spawnPickupFX(tx, ty, "#e040a0");
    }
  }

  function spawnPickupFX(tx, ty, color) {
    for (let i = 0; i < 12; i++) {
      particles.push({
        x: tx + 0.5,
        y: ty + 0.5,
        vx: (Math.random() - 0.5) * 1.2,
        vy: (Math.random() - 0.5) * 1.2,
        life: 0.6,
        color
      });
    }
  }

  // --- Catch / cinematic / resist ---
  function triggerComboCatch() {
    // Trap + succubus with sight → strip ALL instantly (stay alive; GO only on fail resist while nude)
    const hadClothes = clothingCount(player.clothing) > 0;
    if (hadClothes) {
      stripAllClothing();
      updateHUD();
      toast("All clothing lost to the trap + succubus!", 2200);
    } else {
      toast("Trapped bare — resist or the giggles win!", 2200);
    }

    const pick = window.pickScene({ shirt: true, shoes: true, pants: true });
    const tick = computeTicklishnessPct();
    const drain = 22 + tick * 0.5;
    const tapGain = Math.max(2.0, 7.0 - tick * 0.05);

    resistState = {
      type: pick.type,
      scene: {
        title: "Double Trouble!",
        text:
          "The trap snares you just as the succubus lunges — four hands and a wicked giggle strip every last scrap in seconds!",
        captions: [
          "Trap and mistress together~!",
          "Clothes? Gone!",
          "Mash to survive the onslaught!"
        ]
      },
      clothingPiece: pick.clothingPiece,
      source: "combo",
      meter: 38,
      drain,
      tapGain,
      captionIdx: 0,
      captionTimer: 0,
      success: false,
      done: false,
      fullStrip: true
    };

    mode = "cinematic";
    $("cine-title").textContent = resistState.scene.title;
    $("cine-text").textContent = resistState.scene.text;
    $("cine-caption").textContent = resistState.scene.captions[0];
    $("resist-fill").style.width = resistState.meter + "%";
    showOverlay("cinematic", true);
    drawCinematicArt(pick.type);
    beep(160, 0.28, "sawtooth");
  }

  function triggerCatch(source) {
    const pick = window.pickScene(player.clothing);
    const tick = computeTicklishnessPct();
    const drain = 18 + tick * 0.45;
    const tapGain = Math.max(2.2, 7.5 - tick * 0.045);

    resistState = {
      type: pick.type,
      scene: pick.scene,
      clothingPiece: pick.clothingPiece,
      source,
      meter: 42,
      drain,
      tapGain,
      captionIdx: 0,
      captionTimer: 0,
      success: false,
      done: false,
      fullStrip: false
    };

    mode = "cinematic";
    $("cine-title").textContent = pick.scene.title;
    $("cine-text").textContent = pick.scene.text;
    $("cine-caption").textContent = pick.scene.captions[0];
    $("resist-fill").style.width = resistState.meter + "%";
    showOverlay("cinematic", true);
    drawCinematicArt(pick.type);
    beep(200, 0.2, "sawtooth");
  }

  function drawCinematicArt(type) {
    const w = cineCanvas.width,
      h = cineCanvas.height;
    cineCtx.clearRect(0, 0, w, h);
    const g = cineCtx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#1a0c28");
    g.addColorStop(1, "#080410");
    cineCtx.fillStyle = g;
    cineCtx.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      cineCtx.fillStyle = `rgba(255,154,60,${0.15 + Math.random() * 0.1})`;
      cineCtx.beginPath();
      cineCtx.arc(80 + i * 120, 40, 30 + Math.random() * 10, 0, Math.PI * 2);
      cineCtx.fill();
    }
    function body(x, y, color, scale) {
      cineCtx.fillStyle = color;
      cineCtx.beginPath();
      cineCtx.ellipse(x, y - 20 * scale, 14 * scale, 18 * scale, 0, 0, Math.PI * 2);
      cineCtx.fill();
      cineCtx.beginPath();
      cineCtx.ellipse(x, y + 10 * scale, 18 * scale, 22 * scale, 0, 0, Math.PI * 2);
      cineCtx.fill();
    }
    body(w * 0.72, h * 0.55, "#c040a0", 1.15);
    cineCtx.strokeStyle = "#ff6bcb";
    cineCtx.lineWidth = 3;
    cineCtx.beginPath();
    cineCtx.moveTo(w * 0.72 - 10, h * 0.55 - 42);
    cineCtx.quadraticCurveTo(w * 0.72 - 18, h * 0.55 - 70, w * 0.72 - 4, h * 0.55 - 55);
    cineCtx.moveTo(w * 0.72 + 10, h * 0.55 - 42);
    cineCtx.quadraticCurveTo(w * 0.72 + 18, h * 0.55 - 70, w * 0.72 + 4, h * 0.55 - 55);
    cineCtx.stroke();
    cineCtx.fillStyle = "rgba(140,60,180,0.5)";
    cineCtx.beginPath();
    cineCtx.ellipse(w * 0.72 - 40, h * 0.5, 28, 18, -0.5, 0, Math.PI * 2);
    cineCtx.ellipse(w * 0.72 + 40, h * 0.5, 28, 18, 0.5, 0, Math.PI * 2);
    cineCtx.fill();
    body(w * 0.35, h * 0.62, "#7ec8ff", 1);
    cineCtx.fillStyle = "#fde047";
    for (let i = 0; i < 18; i++) {
      const sx = w * 0.35 + (Math.random() - 0.5) * 80;
      const sy =
        h * (type === "feet" ? 0.82 : type === "belly" ? 0.58 : 0.65) +
        (Math.random() - 0.5) * 40;
      cineCtx.beginPath();
      cineCtx.arc(sx, sy, 2 + Math.random() * 3, 0, Math.PI * 2);
      cineCtx.fill();
    }
    cineCtx.fillStyle = "#ff6bcb";
    cineCtx.font = "bold 16px Segoe UI, sans-serif";
    cineCtx.fillText(
      type === "feet" ? "✦ FEET ✦" : type === "belly" ? "✦ BELLY / FLANKS ✦" : "✦ TIED DOWN ✦",
      24,
      h - 18
    );
  }

  function resistTap() {
    if (mode !== "cinematic" || !resistState || resistState.done) return;
    resistState.meter = Math.min(100, resistState.meter + resistState.tapGain);
    $("resist-fill").style.width = resistState.meter + "%";
    beep(400 + resistState.meter * 4, 0.04, "square");
    if (resistState.meter >= 100) {
      resistState.done = true;
      resistState.success = true;
      finishResist(true);
    }
  }

  function updateResist(dt) {
    if (!resistState || resistState.done) return;
    resistState.meter -= resistState.drain * dt;
    if (resistState.meter < 0) resistState.meter = 0;
    $("resist-fill").style.width = resistState.meter + "%";

    resistState.captionTimer += dt;
    if (resistState.captionTimer > 1.4) {
      resistState.captionTimer = 0;
      resistState.captionIdx =
        (resistState.captionIdx + 1) % resistState.scene.captions.length;
      $("cine-caption").textContent = resistState.scene.captions[resistState.captionIdx];
      drawCinematicArt(resistState.type);
    }

    if (resistState.meter <= 0) {
      resistState.done = true;
      resistState.success = false;
      finishResist(false);
    }
  }

  function finishResist(success) {
    const piece = resistState.clothingPiece;
    const names = { shirt: "Shirt", shoes: "Shoes", pants: "Pants" };
    const wasCombo = resistState.fullStrip;
    showOverlay("cinematic", false);

    if (success) {
      if (wasCombo) {
        // Already stripped at combo start; escape with invuln (no single-piece path)
        toast("You thrash free — bare, blushing, but still in the race!", 2600);
        invulnUntil = performance.now() + 2500;
        updateHUD();
        beep(700, 0.12, "triangle");
        mode = "play";
        afterTickleResolve();
        return;
      }
      if (player.clothing[piece]) {
        loseClothingPiece(piece);
        toast("You wriggled free — but lost your " + names[piece] + "!", 2600);
      } else {
        // Sensitivity raises ticklishness difficulty only — never game over
        player.sensitivity = Math.min(100, player.sensitivity + 3);
        toast("Already bare there… sensitivity rises! (+3%)", 2600);
      }
      invulnUntil = performance.now() + 2200;
      updateHUD();
      beep(700, 0.12, "triangle");
      mode = "play";
      afterTickleResolve();
      return;
    }

    // Fail resist — game over ONLY if already wearing no clothing
    const woreNothing = clothingCount(player.clothing) === 0;
    if (woreNothing) {
      gameOver("Caught with nothing left to lose… the giggles win!");
      return;
    }
    // Had clothes: strip all, stay alive
    stripAllClothing();
    updateHUD();
    toast("Failed to resist! All clothing lost in a ticklish flurry!", 2800);
    invulnUntil = performance.now() + 2500;
    beep(150, 0.3, "sawtooth");
    mode = "play";
    afterTickleResolve();
  }

  function winLevel() {
    mode = "win";
    $("win-flavor").textContent =
      "With enough keys, the locked gate swings open. You dash through, half-laughing. The succubus waves coyly — \"Next time, darling~\" Level " +
      level +
      " clear! Clothing and sensitivity carry into deeper halls…";
    showOverlay("win-overlay", true);
    beep(523, 0.1);
    setTimeout(() => beep(659, 0.1), 100);
    setTimeout(() => beep(784, 0.2), 200);
  }

  function gameOver(reason) {
    mode = "gameover";
    $("go-reason").textContent = reason;
    showOverlay("gameover-overlay", true);
    beep(110, 0.4, "sawtooth");
  }

  // --- Room-locked camera ---
  function getRegionAtWorld(wx, wy) {
    if (!maze || !maze.regionAt) return null;
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (ty < 0 || tx < 0 || ty >= maze.rows || tx >= maze.cols) return null;
    let reg = maze.regionAt[ty][tx];
    if (reg) return reg;
    // Doorway / edge: search nearby floor for a region (prefer rooms)
    let best = null;
    let bestD = 99;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = tx + dx,
          ny = ty + dy;
        if (ny < 0 || nx < 0 || ny >= maze.rows || nx >= maze.cols) continue;
        const r = maze.regionAt[ny][nx];
        if (!r) continue;
        const d = Math.abs(dx) + Math.abs(dy);
        const score = d + (r.kind === "room" ? 0 : 0.25);
        if (score < bestD) {
          bestD = score;
          best = r;
        }
      }
    }
    return best;
  }

  function regionIdOf(reg) {
    if (!reg) return null;
    return (reg.kind || "room") + ":" + reg.id;
  }

  /** True if tile is inside the active region, a bordering wall, or a doorway opening. */
  function tileVisibleInRegion(x, y, reg) {
    if (!reg) return true;
    if (y < 0 || x < 0 || y >= maze.rows || x >= maze.cols) return false;
    const here = maze.regionAt[y][x];
    if (here && here.id === reg.id && here.kind === reg.kind) return true;
    // Walls + short doorway/corridor floors that touch this region (not neighbor rooms)
    const isWall = maze.grid[y][x] === TILE.WALL;
    const isDoorway = here && here.kind === "corridor";
    if (isWall || isDoorway) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ]) {
        const nx = x + dx,
          ny = y + dy;
        if (ny < 0 || nx < 0 || ny >= maze.rows || nx >= maze.cols) continue;
        const n = maze.regionAt[ny][nx];
        if (n && n.id === reg.id && n.kind === reg.kind) return true;
      }
    }
    return false;
  }

  function getViewTiles() {
    const viewH = (canvas.height - ISO.padTop) / ISO.ky;
    const viewW = canvas.width / ISO.kx;
    return { viewW, viewH };
  }

  /** Floor-plane projection: angled elevated look into the room (south near side open). */
  function worldToScreen(wx, wy) {
    const dx = wx - camera.x;
    const dy = wy - camera.y;
    return {
      x: dx * ISO.kx + dy * ISO.skew,
      y: dy * ISO.ky + ISO.padTop
    };
  }

  function depthOf(wx, wy) {
    return wy * 1000 + wx;
  }

  /** South (near) wall of the current room — hide so we look into the space. */
  function isNearSouthWall(x, y, reg) {
    if (y <= 0) return false;
    if (maze.grid[y][x] !== TILE.WALL) return false;
    const above = maze.grid[y - 1][x];
    if (above === TILE.WALL) return false;
    if (!reg) return true;
    const n = maze.regionAt[y - 1] && maze.regionAt[y - 1][x];
    if (n && n.id === reg.id) return true;
    if (tileVisibleInRegion(x, y - 1, reg) && above !== TILE.WALL) return true;
    return false;
  }

  function fillPoly(c, pts, fill, stroke, lineWidth) {
    if (!pts || pts.length < 3) return;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lineWidth || 1;
      c.stroke();
    }
  }

  function floorQuad(tx, ty) {
    return [
      worldToScreen(tx, ty),
      worldToScreen(tx + 1, ty),
      worldToScreen(tx + 1, ty + 1),
      worldToScreen(tx, ty + 1)
    ];
  }

  function clampCameraToRegion(camX, camY, viewW, viewH, reg) {
    if (!reg) {
      return {
        x: Math.max(0, Math.min(Math.max(0, maze.cols - viewW), camX)),
        y: Math.max(0, Math.min(Math.max(0, maze.rows - viewH), camY))
      };
    }
    // Extra north pad for raised walls; small south pad (near wall omitted)
    const left = reg.x - CAM_ROOM_PAD;
    const top = reg.y - CAM_ROOM_PAD - 0.35;
    const right = reg.x + reg.w + CAM_ROOM_PAD;
    const bottom = reg.y + reg.h + CAM_ROOM_PAD * 0.35;
    const rw = right - left;
    const rh = bottom - top;

    let x = camX;
    let y = camY;
    if (viewW >= rw) {
      x = left + rw / 2 - viewW / 2;
    } else {
      x = Math.max(left, Math.min(right - viewW, x));
    }
    if (viewH >= rh) {
      // Bias slightly south so we look into the room
      y = top + rh / 2 - viewH / 2 + rh * 0.06;
    } else {
      y = Math.max(top, Math.min(bottom - viewH, y));
    }
    return { x, y };
  }

  function updateCamera(dt) {
    const { viewW, viewH } = getViewTiles();
    const reg = getRegionAtWorld(player.x, player.y);
    const rid = regionIdOf(reg);

    if (!camera.initialized) {
      let cx = player.x - viewW / 2;
      let cy = player.y - viewH / 2;
      const clamped = clampCameraToRegion(cx, cy, viewW, viewH, reg);
      camera.x = clamped.x;
      camera.y = clamped.y;
      camera.regionId = rid;
      camera.transitioning = false;
      camera.initialized = true;
      return;
    }

    if (rid !== camera.regionId) {
      camera.regionId = rid;
      camera.transitioning = true;
    }

    const halfW = viewW / 2;
    const halfH = viewH / 2;
    const deadW = halfW * CAM_EDGE_FOLLOW;
    const deadH = halfH * CAM_EDGE_FOLLOW;

    const screenX = player.x - camera.x;
    const screenY = player.y - camera.y;
    let targetX = camera.x;
    let targetY = camera.y;

    if (screenX > halfW + deadW) targetX = player.x - (halfW + deadW);
    else if (screenX < halfW - deadW) targetX = player.x - (halfW - deadW);

    if (screenY > halfH + deadH) targetY = player.y - (halfH + deadH);
    else if (screenY < halfH - deadH) targetY = player.y - (halfH - deadH);

    if (reg) {
      const rw = reg.w + CAM_ROOM_PAD * 2;
      const rh = reg.h + CAM_ROOM_PAD * 2;
      if (viewW >= rw) {
        targetX = reg.x + reg.w / 2 - viewW / 2 + (player.x - (reg.x + reg.w / 2)) * 0.15;
      }
      if (viewH >= rh) {
        targetY =
          reg.y + reg.h / 2 - viewH / 2 + (player.y - (reg.y + reg.h / 2)) * 0.12 + rh * 0.04;
      }
    }

    const clampedTarget = clampCameraToRegion(targetX, targetY, viewW, viewH, reg);
    targetX = clampedTarget.x;
    targetY = clampedTarget.y;

    const lerpRate = camera.transitioning ? CAM_ROOM_TRANSITION : CAM_LERP;
    const k = 1 - Math.exp(-lerpRate * dt);
    camera.x += (targetX - camera.x) * k;
    camera.y += (targetY - camera.y) * k;

    const hard = clampCameraToRegion(camera.x, camera.y, viewW, viewH, reg);
    camera.x += (hard.x - camera.x) * Math.min(1, k * 1.4);
    camera.y += (hard.y - camera.y) * Math.min(1, k * 1.4);

    if (
      camera.transitioning &&
      Math.abs(camera.x - targetX) < 0.04 &&
      Math.abs(camera.y - targetY) < 0.04
    ) {
      camera.transitioning = false;
    }
  }


  // --- Rendering ---
    // --- Rendering ---
  function drawSuccubusSprite(ex, ey, e) {
    const flap = Math.sin(e.anim * 1.6) * 0.35;
    const glow = 0.45 + Math.sin(e.anim) * 0.2;
    // Magenta aura — always readable
    const aura = ctx.createRadialGradient(ex, ey, 4 * SP, ex, ey, 28 * SP);
    aura.addColorStop(0, `rgba(255, 80, 180, ${0.55 * glow})`);
    aura.addColorStop(0.55, `rgba(200, 40, 140, ${0.22 * glow})`);
    aura.addColorStop(1, "rgba(120, 20, 80, 0)");
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(ex, ey, 28 * SP, 0, Math.PI * 2);
    ctx.fill();
    // Bat wings
    ctx.fillStyle = e.hasSight ? "rgba(160, 40, 120, 0.85)" : "rgba(120, 30, 100, 0.75)";
    ctx.beginPath();
    ctx.moveTo(ex - 6 * SP, ey);
    ctx.quadraticCurveTo(ex - 22 * SP, ey - 14 * SP - flap * 10 * SP, ex - 30 * SP, ey + 2 * SP);
    ctx.quadraticCurveTo(ex - 20 * SP, ey + 6 * SP, ex - 8 * SP, ey + 4 * SP);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ex + 6 * SP, ey);
    ctx.quadraticCurveTo(ex + 22 * SP, ey - 14 * SP - flap * 10 * SP, ex + 30 * SP, ey + 2 * SP);
    ctx.quadraticCurveTo(ex + 20 * SP, ey + 6 * SP, ex + 8 * SP, ey + 4 * SP);
    ctx.closePath();
    ctx.fill();
    // Wing membrane ribs
    ctx.strokeStyle = "rgba(255, 140, 200, 0.45)";
    ctx.lineWidth = 1.2 * SP;
    ctx.beginPath();
    ctx.moveTo(ex - 8 * SP, ey);
    ctx.lineTo(ex - 24 * SP, ey - 6 * SP - flap * 6 * SP);
    ctx.moveTo(ex + 8 * SP, ey);
    ctx.lineTo(ex + 24 * SP, ey - 6 * SP - flap * 6 * SP);
    ctx.stroke();
    // Body
    ctx.fillStyle = e.hasSight ? "#e050b0" : "#c040a0";
    ctx.beginPath();
    ctx.ellipse(ex, ey + 1 * SP, 12 * SP, 15 * SP, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head
    ctx.fillStyle = "#d060b0";
    ctx.beginPath();
    ctx.arc(ex, ey - 12 * SP, 9 * SP, 0, Math.PI * 2);
    ctx.fill();
    // Horns
    ctx.strokeStyle = "#ff6bcb";
    ctx.lineWidth = 2.5 * SP;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ex - 5 * SP, ey - 16 * SP);
    ctx.quadraticCurveTo(ex - 10 * SP, ey - 28 * SP, ex - 3 * SP, ey - 24 * SP);
    ctx.moveTo(ex + 5 * SP, ey - 16 * SP);
    ctx.quadraticCurveTo(ex + 10 * SP, ey - 28 * SP, ex + 3 * SP, ey - 24 * SP);
    ctx.stroke();
    // Eyes
    ctx.fillStyle = e.hasSight ? "#fff7ae" : "#ffe4f0";
    ctx.beginPath();
    ctx.arc(ex - 3.5 * SP, ey - 12 * SP, 2.2 * SP, 0, Math.PI * 2);
    ctx.arc(ex + 3.5 * SP, ey - 12 * SP, 2.2 * SP, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#2a0618";
    ctx.beginPath();
    ctx.arc(ex - 3.5 * SP, ey - 12 * SP, 1 * SP, 0, Math.PI * 2);
    ctx.arc(ex + 3.5 * SP, ey - 12 * SP, 1 * SP, 0, Math.PI * 2);
    ctx.fill();
    // Pulse ring when chasing
    ctx.strokeStyle = `rgba(255, 100, 200, ${0.35 + glow * 0.4})`;
    ctx.lineWidth = 2 * SP;
    ctx.beginPath();
    ctx.arc(ex, ey, (18 + Math.sin(e.anim) * 3) * SP, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawMinionSprite(ex, ey, e) {
    const t = e.sprite || MINION_TYPES[0];
    const flap = Math.sin(e.anim * 2.4 + (e.x || 0)) * 0.5;
    const bob = Math.sin(e.anim * 1.8) * 1.5 * SP;
    const cy = ey + bob;
    // Soft glow
    ctx.fillStyle = t.accent + "55";
    ctx.beginPath();
    ctx.arc(ex, cy, 14 * SP, 0, Math.PI * 2);
    ctx.fill();

    // Wings by style
    ctx.fillStyle = t.wing;
    const style = t.wingStyle;
    if (style === "bat" || style === "raven") {
      const span = style === "raven" ? 18 : 15;
      ctx.beginPath();
      ctx.moveTo(ex - 4 * SP, cy);
      ctx.quadraticCurveTo(ex - span * SP, cy - 10 * SP - flap * 8 * SP, ex - (span + 4) * SP, cy + 2 * SP);
      ctx.quadraticCurveTo(ex - 12 * SP, cy + 5 * SP, ex - 4 * SP, cy + 3 * SP);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ex + 4 * SP, cy);
      ctx.quadraticCurveTo(ex + span * SP, cy - 10 * SP - flap * 8 * SP, ex + (span + 4) * SP, cy + 2 * SP);
      ctx.quadraticCurveTo(ex + 12 * SP, cy + 5 * SP, ex + 4 * SP, cy + 3 * SP);
      ctx.closePath();
      ctx.fill();
    } else if (style === "moth") {
      ctx.beginPath();
      ctx.ellipse(ex - 10 * SP, cy - flap * 3 * SP, 9 * SP, 7 * SP, -0.4, 0, Math.PI * 2);
      ctx.ellipse(ex + 10 * SP, cy - flap * 3 * SP, 9 * SP, 7 * SP, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.accent + "aa";
      ctx.beginPath();
      ctx.ellipse(ex - 10 * SP, cy - flap * 3 * SP, 4 * SP, 3 * SP, -0.4, 0, Math.PI * 2);
      ctx.ellipse(ex + 10 * SP, cy - flap * 3 * SP, 4 * SP, 3 * SP, 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (style === "pointy") {
      ctx.beginPath();
      ctx.moveTo(ex - 3 * SP, cy);
      ctx.lineTo(ex - 16 * SP, cy - 12 * SP - flap * 6 * SP);
      ctx.lineTo(ex - 6 * SP, cy + 4 * SP);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ex + 3 * SP, cy);
      ctx.lineTo(ex + 16 * SP, cy - 12 * SP - flap * 6 * SP);
      ctx.lineTo(ex + 6 * SP, cy + 4 * SP);
      ctx.closePath();
      ctx.fill();
      // Little horns
      ctx.strokeStyle = t.wing;
      ctx.lineWidth = 1.8 * SP;
      ctx.beginPath();
      ctx.moveTo(ex - 3 * SP, cy - 7 * SP);
      ctx.lineTo(ex - 5 * SP, cy - 13 * SP);
      ctx.moveTo(ex + 3 * SP, cy - 7 * SP);
      ctx.lineTo(ex + 5 * SP, cy - 13 * SP);
      ctx.stroke();
    } else if (style === "wispy") {
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.ellipse(ex - 9 * SP, cy - flap * 4 * SP, 7 * SP, 11 * SP, -0.3, 0, Math.PI * 2);
      ctx.ellipse(ex + 9 * SP, cy - flap * 4 * SP, 7 * SP, 11 * SP, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // bug / beetle — short buzzing wings
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(ex - 8 * SP, cy - 2 * SP - flap * 2 * SP, 6 * SP, 3.5 * SP, -0.2, 0, Math.PI * 2);
      ctx.ellipse(ex + 8 * SP, cy - 2 * SP - flap * 2 * SP, 6 * SP, 3.5 * SP, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Body
    ctx.fillStyle = t.body;
    ctx.beginPath();
    if (style === "beetle" || style === "bug") {
      ctx.ellipse(ex, cy, 8 * SP, 10 * SP, 0, 0, Math.PI * 2);
    } else if (style === "wispy") {
      ctx.ellipse(ex, cy, 7 * SP, 9 * SP, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(ex, cy, 8 * SP, 0, Math.PI * 2);
    }
    ctx.fill();
    // Eyes
    ctx.fillStyle = t.eye;
    ctx.beginPath();
    ctx.arc(ex - 2.5 * SP, cy - 1.5 * SP, 2 * SP, 0, Math.PI * 2);
    ctx.arc(ex + 2.5 * SP, cy - 1.5 * SP, 2 * SP, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1020";
    ctx.beginPath();
    ctx.arc(ex - 2.5 * SP, cy - 1.5 * SP, 0.9 * SP, 0, Math.PI * 2);
    ctx.arc(ex + 2.5 * SP, cy - 1.5 * SP, 0.9 * SP, 0, Math.PI * 2);
    ctx.fill();
    // Antennae for moth/beetle
    if (style === "moth" || style === "bug" || style === "beetle") {
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 1.2 * SP;
      ctx.beginPath();
      ctx.moveTo(ex - 2 * SP, cy - 7 * SP);
      ctx.quadraticCurveTo(ex - 6 * SP, cy - 14 * SP, ex - 4 * SP, cy - 15 * SP);
      ctx.moveTo(ex + 2 * SP, cy - 7 * SP);
      ctx.quadraticCurveTo(ex + 6 * SP, cy - 14 * SP, ex + 4 * SP, cy - 15 * SP);
      ctx.stroke();
    }
  }

  function drawPlayerSprite(px, py) {
    // Soft personal glow
    ctx.fillStyle = "rgba(126, 200, 255, 0.25)";
    ctx.beginPath();
    ctx.arc(px, py, 16 * SP, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = player.sprinting ? "#a8e0ff" : "#7ec8ff";
    ctx.beginPath();
    ctx.arc(px, py, 9 * SP, 0, Math.PI * 2);
    ctx.fill();
    // Head hint
    ctx.fillStyle = "#9ad4ff";
    ctx.beginPath();
    ctx.arc(px, py - 10 * SP, 5.5 * SP, 0, Math.PI * 2);
    ctx.fill();
    // Clothing indicators (larger chips)
    ctx.fillStyle = player.clothing.shirt ? "#5eead4" : "#333";
    ctx.fillRect(px - 10 * SP, py - 4 * SP, 7 * SP, 4 * SP);
    ctx.fillStyle = player.clothing.pants ? "#5eead4" : "#333";
    ctx.fillRect(px - 3 * SP, py + 8 * SP, 7 * SP, 4 * SP);
    ctx.fillStyle = player.clothing.shoes ? "#5eead4" : "#333";
    ctx.fillRect(px + 5 * SP, py + 8 * SP, 7 * SP, 4 * SP);
  }

  function drawFloorTile(x, y, t) {
    const quad = floorQuad(x, y);
    const sandA = (x * 17 + y * 31) & 3;
    const fill =
      sandA === 0 ? "#c9a878" : sandA === 1 ? "#d4b484" : sandA === 2 ? "#b89568" : "#c8a674";
    fillPoly(ctx, quad, fill, "rgba(60,48,36,0.22)", 1);
    fillPoly(ctx, quad, "rgba(255, 236, 200, 0.07)", null);

    const cobble = ((x * 13) ^ (y * 29)) % 7;
    if (cobble < 4) {
      const a = worldToScreen(x + 0.18, y + 0.18);
      const b = worldToScreen(x + 0.82, y + 0.2);
      const c = worldToScreen(x + 0.8, y + 0.82);
      const d = worldToScreen(x + 0.2, y + 0.8);
      const col =
        cobble === 0
          ? "rgba(95, 88, 78, 0.5)"
          : cobble === 1
            ? "rgba(120, 110, 98, 0.42)"
            : cobble === 2
              ? "rgba(85, 78, 70, 0.38)"
              : "rgba(105, 98, 88, 0.35)";
      fillPoly(ctx, [a, b, c, d], col, "rgba(45, 38, 30, 0.28)", 1);
    }

    // Doorway arch hint on passage floors
    const nW = y > 0 && maze.grid[y - 1][x] === TILE.WALL;
    const sW = y < maze.rows - 1 && maze.grid[y + 1][x] === TILE.WALL;
    const eW = x < maze.cols - 1 && maze.grid[y][x + 1] === TILE.WALL;
    const wW = x > 0 && maze.grid[y][x - 1] === TILE.WALL;
    const isVDoor = eW && wW && !nW && !sW;
    const isHDoor = nW && sW && !eW && !wW;
    if (isVDoor || isHDoor) {
      ctx.strokeStyle = "rgba(70, 62, 52, 0.65)";
      ctx.lineWidth = 3 * PX;
      ctx.beginPath();
      if (isVDoor) {
        const L = worldToScreen(x + 0.12, y + 1);
        const R = worldToScreen(x + 0.88, y + 1);
        const TL = worldToScreen(x + 0.12, y + 0.35);
        const TR = worldToScreen(x + 0.88, y + 0.35);
        const top = worldToScreen(x + 0.5, y + 0.05);
        ctx.moveTo(L.x, L.y);
        ctx.lineTo(TL.x, TL.y);
        ctx.quadraticCurveTo(top.x, top.y - ISO.wallH * 0.55, TR.x, TR.y);
        ctx.lineTo(R.x, R.y);
      } else {
        const T = worldToScreen(x, y + 0.12);
        const B = worldToScreen(x, y + 0.88);
        const TR = worldToScreen(x + 0.35, y + 0.12);
        const BR = worldToScreen(x + 0.35, y + 0.88);
        const tip = worldToScreen(x + 0.95, y + 0.5);
        ctx.moveTo(T.x, T.y);
        ctx.lineTo(TR.x, TR.y);
        ctx.quadraticCurveTo(tip.x, tip.y - ISO.wallH * 0.2, BR.x, BR.y);
        ctx.lineTo(B.x, B.y);
      }
      ctx.stroke();
      fillPoly(ctx, floorQuad(x, y), "rgba(20, 16, 12, 0.14)", null);
    }

    if (t === TILE.EXIT) {
      const unlocked = keysCollected >= keysRequired;
      const c = worldToScreen(x + 0.5, y + 0.5);
      const eg = ctx.createRadialGradient(c.x, c.y, 2 * PX, c.x, c.y, ISO.kx);
      if (unlocked) {
        eg.addColorStop(0, `rgba(94,234,212,${0.75 * torchFlicker})`);
        eg.addColorStop(1, "transparent");
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(c.x, c.y, ISO.kx * 0.7, 0, Math.PI * 2);
        ctx.fill();
        fillPoly(ctx, floorQuad(x, y), "rgba(94,234,212,0.2)", "#5eead4", 2 * PX);
        ctx.fillStyle = "#5eead4";
        ctx.font = "bold " + Math.round(9 * PX) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("OPEN", c.x, c.y - ISO.wallH * 0.15);
      } else {
        eg.addColorStop(0, `rgba(251,191,36,${0.45 * torchFlicker})`);
        eg.addColorStop(1, "transparent");
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(c.x, c.y, ISO.kx * 0.7, 0, Math.PI * 2);
        ctx.fill();
        const gw = ISO.kx * 0.55;
        const gh = ISO.wallH * 0.85;
        const gx = c.x - gw / 2;
        const gy = c.y - gh;
        ctx.fillStyle = "#3a3048";
        ctx.fillRect(gx, gy, gw, gh);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 1.5 * PX;
        ctx.strokeRect(gx, gy, gw, gh);
        ctx.beginPath();
        for (let bi = 1; bi <= 3; bi++) {
          const bx = gx + (gw * bi) / 4;
          ctx.moveTo(bx, gy + 2 * PX);
          ctx.lineTo(bx, gy + gh - 2 * PX);
        }
        ctx.stroke();
        ctx.fillStyle = "#fbbf24";
        ctx.fillRect(c.x - 4 * PX, c.y - gh * 0.45, 8 * PX, 7 * PX);
        ctx.fillStyle = "#fde68a";
        ctx.font = "bold " + Math.round(8 * PX) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("LOCKED", c.x, c.y - 4 * PX);
      }
    } else if (t === TILE.KEY) {
      const bounce = Math.sin(animTime * 5 + x + y) * 2 * SP;
      const c = worldToScreen(x + 0.5, y + 0.5);
      const ky = c.y - 6 * SP + bounce;
      ctx.fillStyle = `rgba(251,191,36,${0.35 + 0.2 * torchFlicker})`;
      ctx.beginPath();
      ctx.arc(c.x, ky, 10 * SP, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.arc(c.x - 2 * SP, ky - 3 * SP, 5 * SP, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#14101c";
      ctx.beginPath();
      ctx.arc(c.x - 2 * SP, ky - 3 * SP, 2 * SP, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(c.x + 2 * SP, ky - 1 * SP, 7 * SP, 3 * SP);
      ctx.fillRect(c.x + 6 * SP, ky + 2 * SP, 3 * SP, 4 * SP);
      ctx.fillRect(c.x + 4 * SP, ky + 4 * SP, 3 * SP, 2 * SP);
    } else if (t === TILE.TRAP) {
      const c = worldToScreen(x + 0.5, y + 0.5);
      const trapQ = [
        worldToScreen(x + 0.22, y + 0.22),
        worldToScreen(x + 0.78, y + 0.22),
        worldToScreen(x + 0.78, y + 0.78),
        worldToScreen(x + 0.22, y + 0.78)
      ];
      fillPoly(ctx, trapQ, "rgba(60,30,45,0.28)", "rgba(80,50,70,0.45)", 1);
      ctx.fillStyle = "rgba(120,40,60,0.18)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3 * PX, 0, Math.PI * 2);
      ctx.fill();
    } else if (t === TILE.POTION) {
      const c = worldToScreen(x + 0.5, y + 0.5);
      ctx.fillStyle = "#5eead4";
      ctx.beginPath();
      ctx.arc(c.x, c.y - 8 * SP, 6 * SP, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a5f3fc";
      ctx.fillRect(c.x - 3 * SP, c.y - 2 * SP, 6 * SP, 5 * SP);
    } else if (t === TILE.CLOTH_SHIRT || t === TILE.CLOTH_SHOES || t === TILE.CLOTH_PANTS) {
      const c = worldToScreen(x + 0.5, y + 0.5);
      ctx.fillStyle = "#e040a0";
      ctx.fillRect(c.x - 10 * SP, c.y - 18 * SP, 20 * SP, 16 * SP);
      ctx.fillStyle = "#ffb3e0";
      ctx.font = Math.round(10 * SP) + "px sans-serif";
      ctx.textAlign = "center";
      const label = t === TILE.CLOTH_SHIRT ? "👕" : t === TILE.CLOTH_SHOES ? "👟" : "👖";
      ctx.fillText(label, c.x, c.y - 6 * SP);
    }
  }

  function drawWallTile(x, y, reg) {
    if (isNearSouthWall(x, y, reg)) {
      // Classic dungeon cutaway: omit near/south wall (faint stub only)
      const stub = [
        worldToScreen(x + 0.05, y + 0.85),
        worldToScreen(x + 0.95, y + 0.85),
        worldToScreen(x + 0.95, y + 1),
        worldToScreen(x + 0.05, y + 1)
      ];
      fillPoly(ctx, stub, "rgba(42,38,32,0.35)", "rgba(20,16,12,0.2)", 1);
      return;
    }

    const wh = ISO.wallH;
    const shade = (x * 5 + y * 11) & 3;
    const topBase = shade === 0 ? "#5a5348" : shade === 1 ? "#4e4840" : shade === 2 ? "#635c50" : "#524c44";
    const topLite = shade === 0 ? "#6e6658" : shade === 1 ? "#625a4e" : shade === 2 ? "#766e60" : "#686054";
    const faceDark = "#2a2620";
    const faceMid = "#3a342c";
    const faceSide = "#322e28";

    const tl = worldToScreen(x, y);
    const tr = worldToScreen(x + 1, y);
    const br = worldToScreen(x + 1, y + 1);
    const bl = worldToScreen(x, y + 1);
    const tlH = { x: tl.x, y: tl.y - wh };
    const trH = { x: tr.x, y: tr.y - wh };
    const brH = { x: br.x, y: br.y - wh };
    const blH = { x: bl.x, y: bl.y - wh };

    const nFloor = y > 0 && maze.grid[y - 1][x] !== TILE.WALL;
    const sFloor = y < maze.rows - 1 && maze.grid[y + 1][x] !== TILE.WALL;
    const eFloor = x < maze.cols - 1 && maze.grid[y][x + 1] !== TILE.WALL;
    const wFloor = x > 0 && maze.grid[y][x - 1] !== TILE.WALL;

    fillPoly(ctx, [tl, tr, br, bl], "#1a1714", null);

    if (sFloor) {
      fillPoly(ctx, [bl, br, brH, blH], faceDark, "rgba(12,10,8,0.45)", 1);
      fillPoly(
        ctx,
        [
          { x: bl.x + 1, y: bl.y - 1 },
          { x: br.x - 1, y: br.y - 1 },
          { x: brH.x - 1, y: brH.y + 1 },
          { x: blH.x + 1, y: blH.y + 1 }
        ],
        faceMid,
        null
      );
    }
    if (eFloor) {
      fillPoly(ctx, [tr, br, brH, trH], faceSide, "rgba(12,10,8,0.4)", 1);
    }
    if (wFloor) {
      fillPoly(ctx, [tl, bl, blH, tlH], "#2e2a24", "rgba(12,10,8,0.4)", 1);
    }
    if (nFloor) {
      fillPoly(ctx, [tl, tr, trH, tlH], faceMid, "rgba(12,10,8,0.5)", 1);
      ctx.strokeStyle = "rgba(12, 10, 8, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i <= 3; i++) {
        const tt = i / 4;
        ctx.moveTo(tl.x, tl.y - wh * tt);
        ctx.lineTo(tr.x, tr.y - wh * tt);
      }
      const mx = (tl.x + tr.x) / 2;
      ctx.moveTo(mx, tl.y);
      ctx.lineTo(mx, tl.y - wh);
      ctx.stroke();
    }

    fillPoly(ctx, [tlH, trH, brH, blH], topBase, "rgba(22,18,14,0.55)", 1.1);
    fillPoly(
      ctx,
      [
        { x: tlH.x + 2, y: tlH.y + 2 },
        { x: trH.x - 2, y: trH.y + 2 },
        { x: brH.x - 2, y: brH.y - 2 },
        { x: blH.x + 2, y: blH.y - 2 }
      ],
      topLite,
      null
    );
    ctx.strokeStyle = "rgba(22, 18, 14, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const midN = { x: (tlH.x + trH.x) / 2, y: (tlH.y + trH.y) / 2 };
    const midS = { x: (blH.x + brH.x) / 2, y: (blH.y + brH.y) / 2 };
    const midW = { x: (tlH.x + blH.x) / 2, y: (tlH.y + blH.y) / 2 };
    const midE = { x: (trH.x + brH.x) / 2, y: (trH.y + brH.y) / 2 };
    ctx.moveTo(midW.x, midW.y);
    ctx.lineTo(midE.x, midE.y);
    ctx.moveTo(midN.x, midN.y);
    ctx.lineTo(midS.x, midS.y);
    ctx.stroke();

    if ((x * 3 + y * 7) % 9 === 0) {
      ctx.fillStyle = "rgba(110, 130, 90, 0.18)";
      ctx.fillRect(tlH.x + 6, tlH.y + 6, 10, 6);
    }
  }

  function drawTorchBillboard(t) {
    const base = worldToScreen(t.x + 0.5, t.y + 0.55);
    const sx = base.x;
    const sy = base.y - ISO.wallH * 0.55;
    if (sx < -80 || sy < -80 || sx > canvas.width + 80 || sy > canvas.height + 80) return;
    const flicker = torchFlicker * (0.92 + Math.sin(animTime * 9 + t.x * 1.7) * 0.08);
    ctx.fillStyle = "#2a2218";
    ctx.fillRect(sx - 4 * PX, sy + 10 * PX, 8 * PX, 5 * PX);
    ctx.fillStyle = "#4a3a28";
    ctx.fillRect(sx - 2.5 * PX, sy + 6 * PX, 5 * PX, 12 * PX);
    ctx.fillStyle = `rgba(255,140,40,${0.55 * flicker})`;
    ctx.beginPath();
    ctx.ellipse(sx, sy + 5 * PX, 7 * PX * flicker, 10 * PX * flicker, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,190,60,${0.9 * flicker})`;
    ctx.beginPath();
    ctx.ellipse(sx, sy + 4 * PX, 4.5 * PX * flicker, 8 * PX * flicker, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,245,200,${0.95 * flicker})`;
    ctx.beginPath();
    ctx.ellipse(sx, sy + 3 * PX, 2.2 * PX, 4 * PX, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDecorBillboard(d) {
    const fw = (d.w || 1) * ISO.kx * 0.85;
    const fh = (d.h || 1) * ISO.wallH * 0.9;
    const foot = worldToScreen(d.x + (d.w || 1) * 0.5, d.y + (d.h || 1) * 0.9);
    const sx = foot.x - fw / 2;
    const sy = foot.y - fh;
    if (sx + fw < -4 || sy + fh < -4 || sx > canvas.width + 4 || sy > canvas.height + 4) return;

    if (d.type === "furniture") {
      if (d.style === 0) {
        ctx.fillStyle = "#3a2a1c";
        ctx.fillRect(sx + 4 * PX, sy + 2 * PX, fw - 8 * PX, fh - 4 * PX);
        ctx.fillStyle = "#2a1c12";
        ctx.fillRect(sx + 6 * PX, sy + 4 * PX, fw - 12 * PX, fh - 8 * PX);
        const shelves = Math.max(2, Math.floor((fh - 8 * PX) / (10 * PX)));
        for (let si = 0; si < shelves; si++) {
          const yy = sy + 6 * PX + si * ((fh - 10 * PX) / shelves);
          ctx.fillStyle = "#4a3424";
          ctx.fillRect(sx + 6 * PX, yy + 7 * PX, fw - 12 * PX, 2 * PX);
          const books = 3 + ((d.x + d.y + si) % 3);
          for (let bi = 0; bi < books; bi++) {
            const bx = sx + 8 * PX + bi * ((fw - 16 * PX) / books);
            const hues = ["#6b3a2a", "#2a3a5a", "#5a4a2a", "#3a2a4a", "#4a2a2a"];
            ctx.fillStyle = hues[(d.x + bi + si) % hues.length];
            ctx.fillRect(bx, yy, Math.max(3 * PX, (fw - 16 * PX) / books - 2 * PX), 7 * PX);
          }
        }
        ctx.strokeStyle = "rgba(90, 70, 45, 0.7)";
        ctx.lineWidth = 2 * PX;
        ctx.strokeRect(sx + 4 * PX, sy + 2 * PX, fw - 8 * PX, fh - 4 * PX);
      } else if (d.style === 1) {
        ctx.fillStyle = "#3d2c1e";
        ctx.fillRect(sx + 5 * PX, sy + 4 * PX, fw - 10 * PX, fh - 8 * PX);
        ctx.fillStyle = "#2c1e14";
        ctx.fillRect(sx + 7 * PX, sy + 6 * PX, fw - 14 * PX, fh - 12 * PX);
        const drawers = 2 + ((d.x + d.y) % 2);
        for (let di = 0; di < drawers; di++) {
          const dy = sy + 8 * PX + di * ((fh - 16 * PX) / drawers);
          ctx.strokeStyle = "rgba(120, 90, 55, 0.55)";
          ctx.lineWidth = 1.5 * PX;
          ctx.strokeRect(sx + 8 * PX, dy, fw - 16 * PX, (fh - 16 * PX) / drawers - 2 * PX);
          ctx.fillStyle = "#c9a227";
          ctx.beginPath();
          ctx.arc(sx + fw / 2, dy + ((fh - 16 * PX) / drawers - 2 * PX) / 2, 2 * PX, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = "rgba(100, 75, 45, 0.65)";
        ctx.lineWidth = 2 * PX;
        ctx.strokeRect(sx + 5 * PX, sy + 4 * PX, fw - 10 * PX, fh - 8 * PX);
      } else {
        ctx.fillStyle = "#4a3a2c";
        ctx.fillRect(sx + fw * 0.3, sy + fh * 0.55, fw * 0.4, fh * 0.35);
        ctx.fillStyle = "#5a4a3a";
        ctx.beginPath();
        ctx.ellipse(sx + fw / 2, sy + fh * 0.45, fw * 0.22, fh * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#c9a227";
        ctx.fillRect(sx + fw * 0.42, sy + fh * 0.2, fw * 0.16, fh * 0.12);
      }
    } else if (d.type === "banner") {
      ctx.fillStyle = "rgba(140, 25, 45, 0.85)";
      ctx.fillRect(sx + 4 * PX, sy + 2 * PX, fw - 8 * PX, fh - 4 * PX);
      ctx.fillStyle = "rgba(190, 40, 60, 0.55)";
      ctx.fillRect(sx + 6 * PX, sy + 4 * PX, fw - 12 * PX, fh - 10 * PX);
      ctx.fillStyle = "rgba(200, 160, 80, 0.7)";
      ctx.fillRect(sx + 2 * PX, sy + 1 * PX, fw - 4 * PX, 3 * PX);
    } else if (d.type === "cobweb") {
      ctx.strokeStyle = "rgba(200, 195, 210, 0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + 4 * PX, sy + 4 * PX);
      ctx.lineTo(sx + fw - 6 * PX, sy + 10 * PX);
      ctx.moveTo(sx + 6 * PX, sy + 4 * PX);
      ctx.lineTo(sx + 10 * PX, sy + fh - 8 * PX);
      ctx.stroke();
    } else if (d.type === "painting") {
      const pw = fw;
      const ph = fh * 0.85;
      ctx.fillStyle = "#c9a227";
      ctx.fillRect(sx + 3 * PX, sy + 3 * PX, pw - 6 * PX, ph - 6 * PX);
      ctx.fillStyle = "#e8c84a";
      ctx.fillRect(sx + 5 * PX, sy + 5 * PX, pw - 10 * PX, ph - 10 * PX);
      ctx.strokeStyle = "#8b6914";
      ctx.lineWidth = 1.5 * PX;
      ctx.strokeRect(sx + 4 * PX, sy + 4 * PX, pw - 8 * PX, ph - 8 * PX);
      ctx.fillStyle = "#2a2230";
      ctx.fillRect(sx + 9 * PX, sy + 9 * PX, pw - 18 * PX, ph - 18 * PX);
      const theme = d.theme || "tickle";
      const pg = ctx.createRadialGradient(
        sx + pw / 2,
        sy + ph / 2,
        2 * PX,
        sx + pw / 2,
        sy + ph / 2,
        Math.min(pw, ph) * 0.4
      );
      if (theme === "feather") {
        pg.addColorStop(0, "rgba(210, 230, 255, 0.85)");
        pg.addColorStop(1, "rgba(60, 80, 120, 0.5)");
      } else if (theme === "laugh") {
        pg.addColorStop(0, "rgba(255, 210, 140, 0.85)");
        pg.addColorStop(1, "rgba(120, 70, 40, 0.5)");
      } else if (theme === "ribbon") {
        pg.addColorStop(0, "rgba(255, 150, 190, 0.85)");
        pg.addColorStop(1, "rgba(100, 40, 70, 0.5)");
      } else {
        pg.addColorStop(0, "rgba(255, 190, 220, 0.85)");
        pg.addColorStop(1, "rgba(90, 40, 80, 0.5)");
      }
      ctx.fillStyle = pg;
      ctx.fillRect(sx + 9 * PX, sy + 9 * PX, pw - 18 * PX, ph - 18 * PX);
    } else if (d.type === "entranceGate" || d.type === "exitGate") {
      const gw = Math.max(fw, ISO.kx * 2.2);
      const gh = Math.max(fh, ISO.wallH * 1.15);
      const gx = foot.x - gw / 2;
      const gy = foot.y - gh;
      const isExit = d.type === "exitGate";
      const unlocked = !isExit || keysCollected >= keysRequired;
      ctx.fillStyle = "#4a443c";
      ctx.fillRect(gx, gy, gw, gh);
      ctx.fillStyle = "#5c5448";
      ctx.fillRect(gx + 2 * PX, gy + 2 * PX, gw - 4 * PX, gh - 4 * PX);
      ctx.fillStyle = unlocked ? "rgba(30, 24, 18, 0.85)" : "rgba(18, 14, 12, 0.95)";
      ctx.beginPath();
      ctx.moveTo(gx + 8 * PX, gy + gh);
      ctx.lineTo(gx + 8 * PX, gy + gh * 0.42);
      ctx.quadraticCurveTo(gx + gw / 2, gy + 4 * PX, gx + gw - 8 * PX, gy + gh * 0.42);
      ctx.lineTo(gx + gw - 8 * PX, gy + gh);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = unlocked ? "rgba(70, 80, 90, 0.45)" : "rgba(40, 45, 55, 0.9)";
      ctx.lineWidth = 2.5 * PX;
      ctx.beginPath();
      const bars = Math.max(4, Math.floor(gw / (10 * PX)));
      for (let bi = 1; bi < bars; bi++) {
        const bx = gx + 10 * PX + ((gw - 20 * PX) * bi) / bars;
        ctx.moveTo(bx, gy + gh * 0.28);
        ctx.lineTo(bx, gy + gh - 2 * PX);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(201, 162, 39, 0.75)";
      ctx.lineWidth = 3 * PX;
      ctx.beginPath();
      ctx.moveTo(gx + 6 * PX, gy + gh - 2 * PX);
      ctx.lineTo(gx + 6 * PX, gy + gh * 0.4);
      ctx.quadraticCurveTo(gx + gw / 2, gy + 2 * PX, gx + gw - 6 * PX, gy + gh * 0.4);
      ctx.lineTo(gx + gw - 6 * PX, gy + gh - 2 * PX);
      ctx.stroke();
      ctx.fillStyle = isExit ? (unlocked ? "#5eead4" : "#fbbf24") : "#c4b896";
      ctx.font = "bold " + Math.round(9 * PX) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        isExit ? (unlocked ? "EXIT" : "LOCKED") : "ENTRANCE",
        gx + gw / 2,
        gy + gh - 5 * PX
      );
    }
  }

  function draw() {
    if (!maze) return;
    const w = canvas.width,
      h = canvas.height;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, w, h);

    torchFlicker = 0.85 + Math.sin(animTime * 6) * 0.08 + Math.sin(animTime * 13) * 0.04;

    const camRegion = getRegionAtWorld(player.x, player.y);
    const { viewW, viewH } = getViewTiles();

    const x0 = Math.max(0, Math.floor(camera.x) - 2);
    const y0 = Math.max(0, Math.floor(camera.y) - 2);
    const x1 = Math.min(maze.cols - 1, Math.ceil(camera.x + viewW) + 3);
    const y1 = Math.min(maze.rows - 1, Math.ceil(camera.y + viewH) + 3);

    // Floors back→front
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!tileVisibleInRegion(x, y, camRegion)) continue;
        if (maze.grid[y][x] === TILE.WALL) continue;
        drawFloorTile(x, y, maze.grid[y][x]);
      }
    }

    // Rugs on floor plane
    if (maze.decorations) {
      for (const d of maze.decorations) {
        if (d.type !== "rug") continue;
        if (!tileVisibleInRegion(d.x, d.y, camRegion)) continue;
        const a = worldToScreen(d.x + 0.08, d.y + 0.08);
        const b = worldToScreen(d.x + (d.w || 1) - 0.08, d.y + 0.08);
        const c = worldToScreen(d.x + (d.w || 1) - 0.08, d.y + (d.h || 1) - 0.08);
        const e = worldToScreen(d.x + 0.08, d.y + (d.h || 1) - 0.08);
        fillPoly(ctx, [a, b, c, e], "rgba(90, 35, 55, 0.42)", "rgba(180, 90, 120, 0.35)", 2 * PX);
      }
    }

    // Walls back→front (near/south omitted inside drawWallTile)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!tileVisibleInRegion(x, y, camRegion)) continue;
        if (maze.grid[y][x] !== TILE.WALL) continue;
        drawWallTile(x, y, camRegion);
      }
    }

    // Depth-sorted upright props + entities
    const sprites = [];
    if (maze.decorations) {
      for (const d of maze.decorations) {
        if (!tileVisibleInRegion(d.x, d.y, camRegion)) continue;
        if (d.type === "rug" || d.type === "gateTorch" || d.type === "stairs" || d.type === "sconce")
          continue;
        sprites.push({
          depth: depthOf(d.x + (d.w || 1) * 0.5, d.y + (d.h || 1) * 0.85),
          kind: "decor",
          d
        });
      }
    }
    if (maze.torches) {
      for (const t of maze.torches) {
        if (!tileVisibleInRegion(t.x, t.y, camRegion)) continue;
        sprites.push({ depth: depthOf(t.x + 0.5, t.y + 0.7), kind: "torch", t });
      }
    }
    for (const e of enemies) {
      if (!tileVisibleInRegion(Math.floor(e.x), Math.floor(e.y), camRegion)) continue;
      sprites.push({ depth: depthOf(e.x, e.y), kind: "enemy", e });
    }
    sprites.push({ depth: depthOf(player.x, player.y), kind: "player" });
    sprites.sort((a, b) => a.depth - b.depth);

    const inv = performance.now() < invulnUntil;

    for (const s of sprites) {
      if (s.kind === "decor") {
        drawDecorBillboard(s.d);
      } else if (s.kind === "torch") {
        drawTorchBillboard(s.t);
      } else if (s.kind === "enemy") {
        let alpha = 1;
        const e = s.e;
        if (e.kind === "minion" && e.fleeing && e.despawnAt) {
          const left = e.despawnAt - performance.now();
          if (left < 350) alpha = Math.max(0, left / 350);
        }
        ctx.globalAlpha = alpha;
        const foot = worldToScreen(e.x, e.y);
        const ey = foot.y - 6 * SP;
        if (e.kind === "succubus") drawSuccubusSprite(foot.x, ey, e);
        else drawMinionSprite(foot.x, ey, e);
        ctx.globalAlpha = 1;
      } else if (s.kind === "player") {
        if (!inv || Math.floor(animTime * 12) % 2 === 0) {
          const foot = worldToScreen(player.x, player.y);
          drawPlayerSprite(foot.x, foot.y - 4 * SP);
        }
      }
    }

    const pFoot = worldToScreen(player.x, player.y);
    const px = pFoot.x;
    const py = pFoot.y - 4 * SP;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= 1 / 60;
      p.x += p.vx / 60;
      p.y += p.vy / 60;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      const ps = worldToScreen(p.x, p.y);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(ps.x, ps.y - 8 * SP, 3 * SP, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Lighting overlay
    lightCtx.clearRect(0, 0, w, h);
    lightCtx.globalCompositeOperation = "source-over";
    lightCtx.fillStyle = `rgba(4, 2, 10, ${AMBIENT_DARK})`;
    lightCtx.fillRect(0, 0, w, h);
    lightCtx.globalCompositeOperation = "destination-out";

    if (maze.torches) {
      for (const t of maze.torches) {
        if (!tileVisibleInRegion(t.x, t.y, camRegion)) continue;
        const tp = worldToScreen(t.x + 0.5, t.y + 0.35);
        const tx = tp.x;
        const ty = tp.y - ISO.wallH * 0.35;
        const rad = TORCH_RADIUS * ISO.kx * (0.9 + (torchFlicker - 0.85) * 0.6);
        const g = lightCtx.createRadialGradient(tx, ty, 0, tx, ty, rad);
        g.addColorStop(0, "rgba(0,0,0,0.88)");
        g.addColorStop(0.45, "rgba(0,0,0,0.5)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        lightCtx.fillStyle = g;
        lightCtx.beginPath();
        lightCtx.arc(tx, ty, rad, 0, Math.PI * 2);
        lightCtx.fill();
      }
    }

    {
      const rad = 1.6 * ISO.kx;
      const g = lightCtx.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, "rgba(0,0,0,0.4)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      lightCtx.fillStyle = g;
      lightCtx.beginPath();
      lightCtx.arc(px, py, rad, 0, Math.PI * 2);
      lightCtx.fill();
    }

    // Flashlight cone projected from world wedge
    {
      const range = FLASH_RANGE;
      const ang = player.facing;
      lightCtx.beginPath();
      lightCtx.moveTo(px, py);
      const steps = 18;
      for (let i = 0; i <= steps; i++) {
        const a = ang - FLASH_HALF + (FLASH_HALF * 2 * i) / steps;
        const sp = worldToScreen(player.x + Math.cos(a) * range, player.y + Math.sin(a) * range);
        lightCtx.lineTo(sp.x, sp.y - 4 * SP);
      }
      lightCtx.closePath();
      const tip = worldToScreen(
        player.x + Math.cos(ang) * range * 0.45,
        player.y + Math.sin(ang) * range * 0.45
      );
      const fg = lightCtx.createRadialGradient(px, py, ISO.kx * 0.3, tip.x, tip.y, range * ISO.kx);
      fg.addColorStop(0, "rgba(0,0,0,0.97)");
      fg.addColorStop(0.55, "rgba(0,0,0,0.75)");
      fg.addColorStop(1, "rgba(0,0,0,0)");
      lightCtx.fillStyle = fg;
      lightCtx.fill();
    }

    lightCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(lightCanvas, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (maze.torches) {
      for (const t of maze.torches) {
        if (!tileVisibleInRegion(t.x, t.y, camRegion)) continue;
        const tp = worldToScreen(t.x + 0.5, t.y + 0.35);
        const tx = tp.x;
        const ty = tp.y - ISO.wallH * 0.35;
        const rad = TORCH_RADIUS * ISO.kx * 0.85 * torchFlicker;
        const g = ctx.createRadialGradient(tx, ty, 0, tx, ty, rad);
        g.addColorStop(0, "rgba(255,140,40,0.22)");
        g.addColorStop(0.5, "rgba(255,100,30,0.08)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(tx, ty, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    {
      const range = FLASH_RANGE;
      const ang = player.facing;
      ctx.beginPath();
      ctx.moveTo(px, py);
      const steps = 18;
      for (let i = 0; i <= steps; i++) {
        const a = ang - FLASH_HALF + (FLASH_HALF * 2 * i) / steps;
        const sp = worldToScreen(player.x + Math.cos(a) * range, player.y + Math.sin(a) * range);
        ctx.lineTo(sp.x, sp.y - 4 * SP);
      }
      ctx.closePath();
      const tip = worldToScreen(
        player.x + Math.cos(ang) * range * 0.45,
        player.y + Math.sin(ang) * range * 0.45
      );
      const fg = ctx.createRadialGradient(px, py, 0, tip.x, tip.y - 4 * SP, range * ISO.kx * 0.7);
      fg.addColorStop(0, "rgba(200,220,255,0.16)");
      fg.addColorStop(0.6, "rgba(180,200,255,0.06)");
      fg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = fg;
      ctx.fill();
    }
    ctx.restore();

    {
      const range = FLASH_RANGE;
      const ang = player.facing;
      ctx.strokeStyle = "rgba(180,200,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      const steps = 18;
      for (let i = 0; i <= steps; i++) {
        const a = ang - FLASH_HALF + (FLASH_HALF * 2 * i) / steps;
        const sp = worldToScreen(player.x + Math.cos(a) * range, player.y + Math.sin(a) * range);
        ctx.lineTo(sp.x, sp.y - 4 * SP);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // Facing chevron (world-projected)
    if (!inv || Math.floor(animTime * 12) % 2 === 0) {
      const tipW = 0.35;
      const tip = worldToScreen(player.x + player.facingDx * tipW, player.y + player.facingDy * tipW);
      const left = worldToScreen(
        player.x - player.facingDy * 0.12 - player.facingDx * 0.08,
        player.y + player.facingDx * 0.12 - player.facingDy * 0.08
      );
      const right = worldToScreen(
        player.x + player.facingDy * 0.12 - player.facingDx * 0.08,
        player.y - player.facingDx * 0.12 - player.facingDy * 0.08
      );
      ctx.fillStyle = "rgba(220,235,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y - 4 * SP);
      ctx.lineTo(left.x, left.y - 4 * SP);
      ctx.lineTo(right.x, right.y - 4 * SP);
      ctx.closePath();
      ctx.fill();
    }

    const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
    vig.addColorStop(0, "transparent");
    vig.addColorStop(1, "rgba(5,2,10,0.45)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = "center";
    ctx.font = "bold " + Math.round(12 * SP) + "px Segoe UI, sans-serif";
    for (const ft of floatTexts) {
      const fp = worldToScreen(ft.x, ft.y);
      ctx.globalAlpha = Math.max(0, Math.min(1, ft.life));
      ctx.fillStyle = "#ffb3e0";
      ctx.strokeStyle = "rgba(20,5,30,0.85)";
      ctx.lineWidth = 3;
      ctx.strokeText(ft.text, fp.x, fp.y - 20 * SP);
      ctx.fillText(ft.text, fp.x, fp.y - 20 * SP);
      ctx.globalAlpha = 1;
    }
  }


  function update(dt) {
    animTime += dt;
    if (mode === "cinematic") {
      updateResist(dt);
      return;
    }
    if (mode !== "play") return;

    let dx = 0,
      dy = 0;
    if (keys["ArrowUp"] || keys["w"] || keys["W"] || keys._up) dy -= 1;
    if (keys["ArrowDown"] || keys["s"] || keys["S"] || keys._down) dy += 1;
    if (keys["ArrowLeft"] || keys["a"] || keys["A"] || keys._left) dx -= 1;
    if (keys["ArrowRight"] || keys["d"] || keys["D"] || keys._right) dx += 1;

    const wantSprint =
      keys["Shift"] || keys["ShiftLeft"] || keys["ShiftRight"] || keys._sprint;
    const canSprint = wantSprint && player.stamina > 0 && (dx || dy);
    player.sprinting = !!canSprint;

    if (player.sprinting) {
      player.stamina = Math.max(0, player.stamina - STAMINA_DRAIN * dt);
      if (player.stamina <= 0) player.sprinting = false;
    } else {
      player.stamina = Math.min(STAMINA_MAX, player.stamina + STAMINA_REGEN * dt);
    }

    const moveSpeed = player.sprinting ? PLAYER_SPRINT : PLAYER_WALK;
    player.speed = moveSpeed;

    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const nx = dx / len,
        ny = dy / len;
      tryMove(player, nx, ny, dt, moveSpeed);
      player.facing = Math.atan2(ny, nx);
      player.facingDx = nx;
      player.facingDy = ny;
    }

    updateHUD();
    updateCamera(dt);
    updateHeartbeat(dt);

    for (let i = floatTexts.length - 1; i >= 0; i--) {
      const ft = floatTexts[i];
      ft.life -= dt;
      ft.y += ft.vy * dt;
      if (ft.life <= 0) floatTexts.splice(i, 1);
    }

    updateEnemies(dt);
    if (mode === "play") checkTiles();
  }

  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    update(dt);
    if (
      mode === "play" ||
      mode === "pause" ||
      mode === "cinematic" ||
      mode === "win" ||
      mode === "gameover"
    ) {
      if (maze) draw();
    }
    requestAnimationFrame(frame);
  }

  // --- Input ---
  window.addEventListener("keydown", (e) => {
    keys[e.key] = true;
    if (e.key === "Shift") keys["Shift"] = true;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") keys[e.code] = true;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      if (mode === "cinematic") resistTap();
    }
    if ((e.key === "Escape" || e.key === "p" || e.key === "P") && mode === "play") {
      mode = "pause";
      showOverlay("pause-overlay", true);
    } else if ((e.key === "Escape" || e.key === "p" || e.key === "P") && mode === "pause") {
      mode = "play";
      showOverlay("pause-overlay", false);
    }
  });
  window.addEventListener("keyup", (e) => {
    keys[e.key] = false;
    if (e.key === "Shift") keys["Shift"] = false;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") keys[e.code] = false;
  });

  $("btn-resist").addEventListener("click", resistTap);
  $("btn-resist").addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      resistTap();
    },
    { passive: false }
  );

  document.querySelectorAll(".dpad").forEach((btn) => {
    const dir = btn.dataset.dir;
    const map = { up: "_up", down: "_down", left: "_left", right: "_right" };
    const k = map[dir];
    const on = (e) => {
      e.preventDefault();
      keys[k] = true;
    };
    const off = (e) => {
      e.preventDefault();
      keys[k] = false;
    };
    btn.addEventListener("touchstart", on, { passive: false });
    btn.addEventListener("touchend", off, { passive: false });
    btn.addEventListener("touchcancel", off, { passive: false });
    btn.addEventListener("mousedown", on);
    btn.addEventListener("mouseup", off);
    btn.addEventListener("mouseleave", off);
  });

  const sprintBtn = $("btn-sprint");
  if (sprintBtn) {
    const on = (e) => {
      e.preventDefault();
      keys._sprint = true;
    };
    const off = (e) => {
      e.preventDefault();
      keys._sprint = false;
    };
    sprintBtn.addEventListener("touchstart", on, { passive: false });
    sprintBtn.addEventListener("touchend", off, { passive: false });
    sprintBtn.addEventListener("touchcancel", off, { passive: false });
    sprintBtn.addEventListener("mousedown", on);
    sprintBtn.addEventListener("mouseup", off);
    sprintBtn.addEventListener("mouseleave", off);
  }

  $("btn-start").addEventListener("click", () => startGame(true));
  $("btn-resume").addEventListener("click", () => {
    mode = "play";
    showOverlay("pause-overlay", false);
  });
  $("btn-quit-title").addEventListener("click", () => {
    mode = "title";
    showOverlay("pause-overlay", false);
    showScreen("title-screen");
  });
  $("btn-restart").addEventListener("click", restartSameLevel);
  $("btn-title-go").addEventListener("click", () => {
    mode = "title";
    showOverlay("gameover-overlay", false);
    showScreen("title-screen");
  });
  $("btn-next").addEventListener("click", nextLevel);
  $("btn-replay-win").addEventListener("click", restartSameLevel);
  $("btn-title-win").addEventListener("click", () => {
    mode = "title";
    showOverlay("win-overlay", false);
    showScreen("title-screen");
  });
  $("btn-pause").addEventListener("click", () => {
    if (mode === "play") {
      mode = "pause";
      showOverlay("pause-overlay", true);
    }
  });
  function toggleMute() {
    muted = !muted;
    setMuteUI();
  }
  $("btn-mute").addEventListener("click", toggleMute);
  $("btn-mute-title").addEventListener("click", toggleMute);

  cineCanvas.addEventListener("click", resistTap);

  setMuteUI();
  requestAnimationFrame(frame);
})();
