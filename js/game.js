/**
 * Tickle Maze — underground mansion engine (Canvas 2D)
 */
(function () {
  "use strict";

  const TILE = window.MazeGen.TILE;
  const CELL = 80; // 2× tiles (~20×14 tiles on 1600×1120)
  const PX = CELL / 40; // scale factor for pixel-authored sprite radii
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

  // Succubus sight
  const SUCC_LOS_RANGE = 11;
  const SUCC_HEAR_RANGE = 14;

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
    maze.enemySpawns.forEach((s, i) => {
      const isSucc = i === 0;
      const e = {
        x: s.x + 0.5,
        y: s.y + 0.5,
        kind: isSucc ? "succubus" : "minion",
        speed: isSucc ? SUCC_WANDER : MINION_SPEED,
        wanderSpeed: isSucc ? SUCC_WANDER : MINION_SPEED,
        chaseSpeed: isSucc ? SUCC_CHASE : MINION_SPEED * 1.15,
        awareness: isSucc ? SUCC_LOS_RANGE : 5.5,
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
          if (e.pathTimer <= 0) {
            e.path = findPath(e.x, e.y, player.x, player.y);
            e.pathTimer = 0.28;
          }
        } else {
          // Aimless wander — quiet & slow
          if (e.pathTimer <= 0 || !e.path || !e.path.length) {
            e.pathTimer = 1.4 + Math.random() * 1.2;
            // Pick a random floor a short ways away
            const ang = Math.random() * Math.PI * 2;
            const distW = 3 + Math.random() * 5;
            let tx = Math.floor(e.x + Math.cos(ang) * distW);
            let ty = Math.floor(e.y + Math.sin(ang) * distW);
            if (isWall(tx, ty)) {
              const dirs = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
              ];
              const d = dirs[Math.floor(Math.random() * 4)];
              tx = Math.floor(e.x) + d[0] * (1 + Math.floor(Math.random() * 3));
              ty = Math.floor(e.y) + d[1] * (1 + Math.floor(Math.random() * 3));
            }
            if (!isWall(tx, ty)) e.path = findPath(e.x, e.y, tx + 0.5, ty + 0.5);
            else e.path = [];
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

      if (dist < e.awareness && e.pathTimer <= 0) {
        e.path = findPath(e.x, e.y, player.x, player.y);
        e.pathTimer = 0.5;
      } else if (dist >= e.awareness && e.pathTimer <= 0) {
        e.pathTimer = 1.2 + Math.random();
        const dirs = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ];
        const d = dirs[Math.floor(Math.random() * 4)];
        const tx = Math.floor(e.x) + d[0];
        const ty = Math.floor(e.y) + d[1];
        if (!isWall(tx, ty)) e.path = [{ x: tx, y: ty }];
      }
      if (e.path && e.path.length) {
        const t = e.path[0];
        const tx = t.x + 0.5,
          ty = t.y + 0.5;
        const dx = tx - e.x,
          dy = ty - e.y;
        const len = Math.hypot(dx, dy) || 1;
        tryMove(e, dx / len, dy / len, dt, e.wanderSpeed);
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
        x: (tx + 0.5) * CELL,
        y: (ty + 0.5) * CELL,
        vx: (Math.random() - 0.5) * 60 * PX,
        vy: (Math.random() - 0.5) * 60 * PX,
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

  function clampCameraToRegion(camX, camY, viewW, viewH, reg) {
    if (!reg) {
      return {
        x: Math.max(0, Math.min(Math.max(0, maze.cols - viewW), camX)),
        y: Math.max(0, Math.min(Math.max(0, maze.rows - viewH), camY))
      };
    }
    // Framing box: allow ~mid-wall peek so doorway gaps show; keep next rooms off-screen
    const left = reg.x - CAM_ROOM_PAD;
    const top = reg.y - CAM_ROOM_PAD;
    const right = reg.x + reg.w + CAM_ROOM_PAD;
    const bottom = reg.y + reg.h + CAM_ROOM_PAD;
    const rw = right - left;
    const rh = bottom - top;

    let x = camX;
    let y = camY;
    if (viewW >= rw) {
      x = left + rw / 2 - viewW / 2;
    } else {
      const minX = left;
      const maxX = right - viewW;
      x = Math.max(minX, Math.min(maxX, x));
    }
    if (viewH >= rh) {
      y = top + rh / 2 - viewH / 2;
    } else {
      const minY = top;
      const maxY = bottom - viewH;
      y = Math.max(minY, Math.min(maxY, y));
    }
    return { x, y };
  }

  function updateCamera(dt) {
    const viewW = canvas.width / CELL;
    const viewH = canvas.height / CELL;
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

    // Soft follow inside the room; near walls the later clamp stops peeking
    if (screenX > halfW + deadW) targetX = player.x - (halfW + deadW);
    else if (screenX < halfW - deadW) targetX = player.x - (halfW - deadW);

    if (screenY > halfH + deadH) targetY = player.y - (halfH + deadH);
    else if (screenY < halfH - deadH) targetY = player.y - (halfH - deadH);

    // When the region is smaller than the view, keep framed on the region center
    // but bias slightly toward the player for a living follow feel
    if (reg) {
      const rw = reg.w + CAM_ROOM_PAD * 2;
      const rh = reg.h + CAM_ROOM_PAD * 2;
      if (viewW >= rw) {
        targetX = reg.x + reg.w / 2 - viewW / 2 + (player.x - (reg.x + reg.w / 2)) * 0.15;
      }
      if (viewH >= rh) {
        targetY = reg.y + reg.h / 2 - viewH / 2 + (player.y - (reg.y + reg.h / 2)) * 0.15;
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
    // Softly pull toward hard clamp (avoids peeking during transition)
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
  function draw() {
    if (!maze) return;
    const w = canvas.width,
      h = canvas.height;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, w, h);

    const viewW = w / CELL,
      viewH = h / CELL;

    torchFlicker = 0.85 + Math.sin(animTime * 6) * 0.08 + Math.sin(animTime * 13) * 0.04;

    const camRegion = getRegionAtWorld(player.x, player.y);

    const x0 = Math.max(0, Math.floor(camera.x) - 1);
    const y0 = Math.max(0, Math.floor(camera.y) - 1);
    const x1 = Math.min(maze.cols - 1, Math.ceil(camera.x + viewW) + 1);
    const y1 = Math.min(maze.rows - 1, Math.ceil(camera.y + viewH) + 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Room-lock: void outside current room/corridor (no peeking into neighbors)
        if (!tileVisibleInRegion(x, y, camRegion)) continue;
        const sx = (x - camera.x) * CELL;
        const sy = (y - camera.y) * CELL;
        const t = maze.grid[y][x];
        if (t === TILE.WALL) {
          // Faux-3D weathered stone brick (ref: gray-brown top + dark vertical face)
          const wallH = Math.floor(CELL * 0.32);
          const topY = sy - wallH;
          const shade = ((x * 5 + y * 11) & 3);
          const topBase = shade === 0 ? "#5a5348" : shade === 1 ? "#4e4840" : shade === 2 ? "#635c50" : "#524c44";
          const topLite = shade === 0 ? "#6e6658" : shade === 1 ? "#625a4e" : shade === 2 ? "#766e60" : "#686054";
          // Footprint under raised top
          ctx.fillStyle = "#1a1714";
          ctx.fillRect(sx, sy, CELL, CELL);
          // Top face
          ctx.fillStyle = topBase;
          ctx.fillRect(sx, topY, CELL, CELL);
          ctx.fillStyle = topLite;
          ctx.fillRect(sx + 1 * PX, topY + 1 * PX, CELL - 2 * PX, CELL - 2 * PX);
          // Irregular brick courses on top
          ctx.strokeStyle = "rgba(22, 18, 14, 0.55)";
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(sx, topY + CELL * 0.33);
          ctx.lineTo(sx + CELL, topY + CELL * 0.33);
          ctx.moveTo(sx, topY + CELL * 0.66);
          ctx.lineTo(sx + CELL, topY + CELL * 0.66);
          const brickOff = ((x + Math.floor(y / 2)) % 2) * (CELL / 2);
          ctx.moveTo(sx + brickOff, topY);
          ctx.lineTo(sx + brickOff, topY + CELL * 0.33);
          ctx.moveTo(sx + CELL / 2 - brickOff + CELL / 2, topY + CELL * 0.33);
          ctx.lineTo(sx + CELL / 2 - brickOff + CELL / 2, topY + CELL * 0.66);
          ctx.moveTo(sx + brickOff, topY + CELL * 0.66);
          ctx.lineTo(sx + brickOff, topY + CELL);
          ctx.stroke();
          // Wear / lichen flecks
          if ((x * 3 + y * 7) % 9 === 0) {
            ctx.fillStyle = "rgba(110, 130, 90, 0.18)";
            ctx.fillRect(sx + 5 * PX, topY + 6 * PX, 8 * PX, 5 * PX);
          }
          if ((x * 5 + y) % 13 === 0) {
            ctx.fillStyle = "rgba(30, 26, 22, 0.28)";
            ctx.fillRect(sx + 12 * PX, topY + 14 * PX, 6 * PX, 4 * PX);
          }
          // Vertical south face when open space below
          const below = y + 1 >= maze.rows ? TILE.FLOOR : maze.grid[y + 1][x];
          if (below !== TILE.WALL) {
            ctx.fillStyle = "#2a2620";
            ctx.fillRect(sx, sy + CELL - wallH, CELL, wallH);
            ctx.fillStyle = "#3a342c";
            ctx.fillRect(sx + 1 * PX, sy + CELL - wallH, CELL - 2 * PX, wallH);
            ctx.strokeStyle = "rgba(12, 10, 8, 0.55)";
            ctx.beginPath();
            ctx.moveTo(sx, sy + CELL - wallH * 0.55);
            ctx.lineTo(sx + CELL, sy + CELL - wallH * 0.55);
            ctx.stroke();
            // Mortar bricks on face
            ctx.beginPath();
            ctx.moveTo(sx + CELL * 0.35, sy + CELL - wallH);
            ctx.lineTo(sx + CELL * 0.35, sy + CELL);
            ctx.moveTo(sx + CELL * 0.7, sy + CELL - wallH);
            ctx.lineTo(sx + CELL * 0.7, sy + CELL);
            ctx.stroke();
          }
        } else {
          // Sand + irregular cobblestone floor (ref: tan sand with scattered stones)
          const sandA = (x * 17 + y * 31) & 3;
          ctx.fillStyle =
            sandA === 0 ? "#c9a878" : sandA === 1 ? "#d4b484" : sandA === 2 ? "#b89568" : "#c8a674";
          ctx.fillRect(sx, sy, CELL, CELL);
          // Soft sand grain
          ctx.fillStyle = "rgba(255, 236, 200, 0.07)";
          ctx.fillRect(sx, sy, CELL, CELL);
          const cobble = ((x * 13) ^ (y * 29)) % 7;
          if (cobble < 4) {
            const ox = ((x * 7 + y) % 9) * PX;
            const oy = ((y * 11 + x) % 9) * PX;
            const cw = CELL - 18 * PX - ((x * 3) % 5) * PX;
            const ch = CELL - 20 * PX - ((y * 5) % 4) * PX;
            ctx.fillStyle =
              cobble === 0
                ? "rgba(95, 88, 78, 0.5)"
                : cobble === 1
                  ? "rgba(120, 110, 98, 0.42)"
                  : cobble === 2
                    ? "rgba(85, 78, 70, 0.38)"
                    : "rgba(105, 98, 88, 0.35)";
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(sx + 5 * PX + ox * 0.4, sy + 5 * PX + oy * 0.4, cw, ch, 5 * PX);
            else ctx.rect(sx + 5 * PX + ox * 0.4, sy + 5 * PX + oy * 0.4, cw, ch);
            ctx.fill();
            ctx.strokeStyle = "rgba(45, 38, 30, 0.28)";
            ctx.lineWidth = 1;
            ctx.stroke();
            // Stone highlight
            ctx.fillStyle = "rgba(220, 205, 175, 0.12)";
            ctx.fillRect(sx + 7 * PX + ox * 0.4, sy + 7 * PX + oy * 0.4, cw * 0.45, ch * 0.3);
          }
          // Doorway arch hint: floor tile with walls on both sides of a passage
          const nW = y > 0 && maze.grid[y - 1][x] === TILE.WALL;
          const sW = y < maze.rows - 1 && maze.grid[y + 1][x] === TILE.WALL;
          const eW = x < maze.cols - 1 && maze.grid[y][x + 1] === TILE.WALL;
          const wW = x > 0 && maze.grid[y][x - 1] === TILE.WALL;
          const isVDoor = eW && wW && !nW && !sW;
          const isHDoor = nW && sW && !eW && !wW;
          if (isVDoor || isHDoor) {
            ctx.strokeStyle = "rgba(70, 62, 52, 0.55)";
            ctx.lineWidth = 3 * PX;
            ctx.beginPath();
            if (isVDoor) {
              ctx.moveTo(sx + 4 * PX, sy + CELL);
              ctx.lineTo(sx + 4 * PX, sy + CELL * 0.4);
              ctx.quadraticCurveTo(sx + CELL / 2, sy + 2 * PX, sx + CELL - 4 * PX, sy + CELL * 0.4);
              ctx.lineTo(sx + CELL - 4 * PX, sy + CELL);
            } else {
              ctx.moveTo(sx, sy + 4 * PX);
              ctx.lineTo(sx + CELL * 0.4, sy + 4 * PX);
              ctx.quadraticCurveTo(sx + CELL - 2 * PX, sy + CELL / 2, sx + CELL * 0.4, sy + CELL - 4 * PX);
              ctx.lineTo(sx, sy + CELL - 4 * PX);
            }
            ctx.stroke();
            ctx.fillStyle = "rgba(20, 16, 12, 0.18)";
            ctx.fillRect(sx + 6 * PX, sy + 6 * PX, CELL - 12 * PX, CELL - 12 * PX);
          }

          if (t === TILE.EXIT) {
            const unlocked = keysCollected >= keysRequired;
            const eg = ctx.createRadialGradient(
              sx + CELL / 2,
              sy + CELL / 2,
              2 * PX,
              sx + CELL / 2,
              sy + CELL / 2,
              CELL
            );
            if (unlocked) {
              eg.addColorStop(0, `rgba(94,234,212,${0.75 * torchFlicker})`);
              eg.addColorStop(1, "transparent");
              ctx.fillStyle = eg;
              ctx.fillRect(sx - 4 * PX, sy - 4 * PX, CELL + 8 * PX, CELL + 8 * PX);
              // Open gate arch
              ctx.strokeStyle = "#5eead4";
              ctx.lineWidth = 2 * PX;
              ctx.strokeRect(sx + 4 * PX, sy + 3 * PX, CELL - 8 * PX, CELL - 6 * PX);
              ctx.fillStyle = "rgba(94,234,212,0.25)";
              ctx.fillRect(sx + 6 * PX, sy + 5 * PX, CELL - 12 * PX, CELL - 10 * PX);
              ctx.fillStyle = "#5eead4";
              ctx.font = "bold " + Math.round(9 * PX) + "px sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("OPEN", sx + CELL / 2, sy + CELL / 2 + 3 * PX);
            } else {
              eg.addColorStop(0, `rgba(251,191,36,${0.45 * torchFlicker})`);
              eg.addColorStop(1, "transparent");
              ctx.fillStyle = eg;
              ctx.fillRect(sx - 4 * PX, sy - 4 * PX, CELL + 8 * PX, CELL + 8 * PX);
              // Locked iron gate
              ctx.fillStyle = "#3a3048";
              ctx.fillRect(sx + 3 * PX, sy + 2 * PX, CELL - 6 * PX, CELL - 4 * PX);
              ctx.strokeStyle = "#fbbf24";
              ctx.lineWidth = 1.5 * PX;
              ctx.strokeRect(sx + 3 * PX, sy + 2 * PX, CELL - 6 * PX, CELL - 4 * PX);
              // Bars
              ctx.beginPath();
              for (let bi = 1; bi <= 3; bi++) {
                const bx = sx + 3 * PX + ((CELL - 6 * PX) * bi) / 4;
                ctx.moveTo(bx, sy + 3 * PX);
                ctx.lineTo(bx, sy + CELL - 3 * PX);
              }
              ctx.stroke();
              // Lock body
              ctx.fillStyle = "#fbbf24";
              ctx.fillRect(sx + CELL / 2 - 4 * PX, sy + CELL / 2 - 2 * PX, 8 * PX, 7 * PX);
              ctx.beginPath();
              ctx.arc(sx + CELL / 2, sy + CELL / 2 - 3 * PX, 3.5 * PX, Math.PI, 0);
              ctx.stroke();
              ctx.fillStyle = "#fde68a";
              ctx.font = "bold " + Math.round(8 * PX) + "px sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("LOCKED", sx + CELL / 2, sy + CELL - 5 * PX);
            }
          } else if (t === TILE.KEY) {
            const bounce = Math.sin(animTime * 5 + x + y) * 2 * PX;
            ctx.fillStyle = `rgba(251,191,36,${0.35 + 0.2 * torchFlicker})`;
            ctx.beginPath();
            ctx.arc(sx + CELL / 2, sy + CELL / 2 + bounce, 10 * PX, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fbbf24";
            ctx.beginPath();
            ctx.arc(sx + CELL / 2 - 2 * PX, sy + CELL / 2 - 3 * PX + bounce, 5 * PX, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#14101c";
            ctx.beginPath();
            ctx.arc(sx + CELL / 2 - 2 * PX, sy + CELL / 2 - 3 * PX + bounce, 2 * PX, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fbbf24";
            ctx.fillRect(sx + CELL / 2 + 2 * PX, sy + CELL / 2 - 1 * PX + bounce, 7 * PX, 3 * PX);
            ctx.fillRect(sx + CELL / 2 + 6 * PX, sy + CELL / 2 + 2 * PX + bounce, 3 * PX, 4 * PX);
            ctx.fillRect(sx + CELL / 2 + 4 * PX, sy + CELL / 2 + 4 * PX + bounce, 3 * PX, 2 * PX);
          } else if (t === TILE.TRAP) {
            // Hard to see — low-contrast floor seam
            ctx.strokeStyle = "rgba(80,50,70,0.45)";
            ctx.lineWidth = 1;
            ctx.strokeRect(sx + 8 * PX, sy + 8 * PX, CELL - 16 * PX, CELL - 16 * PX);
            ctx.fillStyle = "rgba(60,30,45,0.28)";
            ctx.fillRect(sx + 10 * PX, sy + 10 * PX, CELL - 20 * PX, CELL - 20 * PX);
            ctx.fillStyle = "rgba(120,40,60,0.18)";
            ctx.beginPath();
            ctx.arc(sx + CELL / 2, sy + CELL / 2, 3 * PX, 0, Math.PI * 2);
            ctx.fill();
          } else if (t === TILE.POTION) {
            ctx.fillStyle = "#5eead4";
            ctx.beginPath();
            ctx.arc(sx + CELL / 2, sy + CELL / 2 - 2 * PX, 6 * PX, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#a5f3fc";
            ctx.fillRect(sx + CELL / 2 - 3 * PX, sy + CELL / 2 + 4 * PX, 6 * PX, 5 * PX);
          } else if (
            t === TILE.CLOTH_SHIRT ||
            t === TILE.CLOTH_SHOES ||
            t === TILE.CLOTH_PANTS
          ) {
            ctx.fillStyle = "#e040a0";
            ctx.fillRect(sx + 6 * PX, sy + 8 * PX, CELL - 12 * PX, CELL - 14 * PX);
            ctx.fillStyle = "#ffb3e0";
            ctx.font = Math.round(10 * PX) + "px sans-serif";
            ctx.textAlign = "center";
            const label =
              t === TILE.CLOTH_SHIRT ? "👕" : t === TILE.CLOTH_SHOES ? "👟" : "👖";
            ctx.fillText(label, sx + CELL / 2, sy + CELL / 2 + 4 * PX);
          }
        }
      }
    }

    const px = (player.x - camera.x) * CELL;
    const py = (player.y - camera.y) * CELL;

    // Manor decorations (rugs / furniture) — walkable, drawn on open floor
    if (maze.decorations) {
      for (const d of maze.decorations) {
        if (!tileVisibleInRegion(d.x, d.y, camRegion)) continue;
        if (d.type === "rug") {
          const sx = (d.x - camera.x) * CELL;
          const sy = (d.y - camera.y) * CELL;
          const rw = d.w * CELL;
          const rh = d.h * CELL;
          if (sx + rw < -4 || sy + rh < -4 || sx > canvas.width + 4 || sy > canvas.height + 4)
            continue;
          ctx.fillStyle = "rgba(90, 35, 55, 0.42)";
          ctx.fillRect(sx + 2 * PX, sy + 2 * PX, rw - 4 * PX, rh - 4 * PX);
          ctx.strokeStyle = "rgba(180, 90, 120, 0.35)";
          ctx.lineWidth = 2 * PX;
          ctx.strokeRect(sx + 3 * PX, sy + 3 * PX, rw - 6 * PX, rh - 6 * PX);
          ctx.strokeStyle = "rgba(220, 160, 100, 0.2)";
          ctx.lineWidth = 1 * PX;
          ctx.strokeRect(sx + 6 * PX, sy + 6 * PX, rw - 12 * PX, rh - 12 * PX);
        } else if (d.type === "furniture") {
          const sx = (d.x - camera.x) * CELL;
          const sy = (d.y - camera.y) * CELL;
          const fw = (d.w || 1) * CELL;
          const fh = (d.h || 1) * CELL;
          if (sx + fw < -4 || sy + fh < -4 || sx > canvas.width + 4 || sy > canvas.height + 4)
            continue;
          if (d.style === 0) {
            // Dark wood bookshelf with aged books (ref side décor)
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
            // Cabinet / chest of drawers
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
            // Small pedestal / urn accent
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
          const sx = (d.x - camera.x) * CELL;
          const sy = (d.y - camera.y) * CELL;
          const bw = (d.w || 1) * CELL;
          const bh = (d.h || 2) * CELL;
          if (sx + bw < -4 || sy + bh < -4 || sx > canvas.width + 4 || sy > canvas.height + 4)
            continue;
          // Red drape hanging on wall — non-blocking
          ctx.fillStyle = "rgba(140, 25, 45, 0.85)";
          ctx.fillRect(sx + 4 * PX, sy + 2 * PX, bw - 8 * PX, bh - 4 * PX);
          ctx.fillStyle = "rgba(190, 40, 60, 0.55)";
          ctx.fillRect(sx + 6 * PX, sy + 4 * PX, bw - 12 * PX, bh - 10 * PX);
          ctx.strokeStyle = "rgba(255, 180, 120, 0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx + bw / 2, sy + 2 * PX);
          ctx.lineTo(sx + bw / 2, sy + bh - 4 * PX);
          ctx.stroke();
          // Rod
          ctx.fillStyle = "rgba(200, 160, 80, 0.7)";
          ctx.fillRect(sx + 2 * PX, sy + 1 * PX, bw - 4 * PX, 3 * PX);
        } else if (d.type === "cobweb" || d.type === "cobweb") {
          const sx = (d.x - camera.x) * CELL;
          const sy = (d.y - camera.y) * CELL;
          if (sx < -CELL || sy < -CELL || sx > canvas.width + CELL || sy > canvas.height + CELL)
            continue;
          ctx.strokeStyle = "rgba(200, 195, 210, 0.28)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx + 4 * PX, sy + 4 * PX);
          ctx.lineTo(sx + CELL - 6 * PX, sy + 10 * PX);
          ctx.moveTo(sx + 6 * PX, sy + 4 * PX);
          ctx.lineTo(sx + 10 * PX, sy + CELL - 8 * PX);
          ctx.moveTo(sx + 4 * PX, sy + 12 * PX);
          ctx.lineTo(sx + CELL - 8 * PX, sy + 6 * PX);
          ctx.moveTo(sx + CELL / 2, sy + 4 * PX);
          ctx.lineTo(sx + 8 * PX, sy + CELL / 2);
          ctx.stroke();
          ctx.fillStyle = "rgba(220, 215, 230, 0.15)";
          ctx.beginPath();
          ctx.arc(sx + 8 * PX, sy + 8 * PX, 3 * PX, 0, Math.PI * 2);
          ctx.fill();
        } else if (d.type === "painting") {
          const sx = (d.x - camera.x) * CELL;
          const sy = (d.y - camera.y) * CELL;
          const pw = (d.w || 1) * CELL;
          const ph = (d.h || 1) * CELL;
          if (sx + pw < -4 || sy + ph < -4 || sx > canvas.width + 4 || sy > canvas.height + 4)
            continue;
          // Ornate gold frame + canvas (ref paintings)
          ctx.fillStyle = "#c9a227";
          ctx.fillRect(sx + 3 * PX, sy + 3 * PX, pw - 6 * PX, ph - 6 * PX);
          ctx.fillStyle = "#e8c84a";
          ctx.fillRect(sx + 5 * PX, sy + 5 * PX, pw - 10 * PX, ph - 10 * PX);
          ctx.fillStyle = "#8b6914";
          ctx.strokeStyle = "#8b6914";
          ctx.lineWidth = 1.5 * PX;
          ctx.strokeRect(sx + 4 * PX, sy + 4 * PX, pw - 8 * PX, ph - 8 * PX);
          ctx.fillStyle = "#2a2230";
          ctx.fillRect(sx + 9 * PX, sy + 9 * PX, pw - 18 * PX, ph - 18 * PX);
          const theme = d.theme || "tickle";
          // Soft painted vignette
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
          // Simple figure oval
          ctx.fillStyle = "rgba(255, 240, 230, 0.35)";
          ctx.beginPath();
          ctx.ellipse(sx + pw / 2, sy + ph * 0.42, pw * 0.14, ph * 0.16, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(40, 30, 50, 0.45)";
          ctx.beginPath();
          ctx.ellipse(sx + pw / 2, sy + ph * 0.62, pw * 0.2, ph * 0.18, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (d.type === "entranceGate" || d.type === "exitGate") {
          const sx = (d.x - camera.x) * CELL;
          const sy = (d.y - camera.y) * CELL;
          const gw = (d.w || 4) * CELL;
          const gh = (d.h || 2) * CELL;
          if (sx + gw < -4 || sy + gh < -4 || sx > canvas.width + 4 || sy > canvas.height + 4)
            continue;
          const isExit = d.type === "exitGate";
          const unlocked = !isExit || keysCollected >= keysRequired;
          // Stone arch frame
          ctx.fillStyle = "#4a443c";
          ctx.fillRect(sx, sy, gw, gh);
          ctx.fillStyle = "#5c5448";
          ctx.fillRect(sx + 2 * PX, sy + 2 * PX, gw - 4 * PX, gh - 4 * PX);
          // Arch opening
          ctx.fillStyle = unlocked ? "rgba(30, 24, 18, 0.85)" : "rgba(18, 14, 12, 0.95)";
          ctx.beginPath();
          ctx.moveTo(sx + 8 * PX, sy + gh);
          ctx.lineTo(sx + 8 * PX, sy + gh * 0.42);
          ctx.quadraticCurveTo(sx + gw / 2, sy + 4 * PX, sx + gw - 8 * PX, sy + gh * 0.42);
          ctx.lineTo(sx + gw - 8 * PX, sy + gh);
          ctx.closePath();
          ctx.fill();
          // Portcullis grate
          ctx.strokeStyle = unlocked ? "rgba(70, 80, 90, 0.45)" : "rgba(40, 45, 55, 0.9)";
          ctx.lineWidth = 2.5 * PX;
          ctx.beginPath();
          const bars = Math.max(4, Math.floor(gw / (10 * PX)));
          for (let bi = 1; bi < bars; bi++) {
            const bx = sx + 10 * PX + ((gw - 20 * PX) * bi) / bars;
            ctx.moveTo(bx, sy + gh * 0.28);
            ctx.lineTo(bx, sy + gh - 2 * PX);
          }
          for (let hi = 1; hi <= 3; hi++) {
            const hy = sy + gh * 0.28 + ((gh * 0.65) * hi) / 4;
            ctx.moveTo(sx + 10 * PX, hy);
            ctx.lineTo(sx + gw - 10 * PX, hy);
          }
          ctx.stroke();
          // Gold trim on arch
          ctx.strokeStyle = "rgba(201, 162, 39, 0.75)";
          ctx.lineWidth = 3 * PX;
          ctx.beginPath();
          ctx.moveTo(sx + 6 * PX, sy + gh - 2 * PX);
          ctx.lineTo(sx + 6 * PX, sy + gh * 0.4);
          ctx.quadraticCurveTo(sx + gw / 2, sy + 2 * PX, sx + gw - 6 * PX, sy + gh * 0.4);
          ctx.lineTo(sx + gw - 6 * PX, sy + gh - 2 * PX);
          ctx.stroke();
          ctx.fillStyle = isExit ? (unlocked ? "#5eead4" : "#fbbf24") : "#c4b896";
          ctx.font = "bold " + Math.round(9 * PX) + "px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(
            isExit ? (unlocked ? "EXIT" : "LOCKED") : "ENTRANCE",
            sx + gw / 2,
            sy + gh - 5 * PX
          );
        } else if (d.type === "gateTorch" || d.type === "stairs") {
          // gateTorch drawn via torch list; stairs legacy no-op (gates replace them)
        }
      }
    }

    if (maze.torches) {
      for (const t of maze.torches) {
        if (!tileVisibleInRegion(t.x, t.y, camRegion)) continue;
        const sx = (t.x - camera.x) * CELL;
        const sy = (t.y - camera.y) * CELL;
        if (sx < -CELL || sy < -CELL || sx > canvas.width + CELL || sy > canvas.height + CELL)
          continue;
        const flicker = torchFlicker * (0.92 + Math.sin(animTime * 9 + t.x * 1.7) * 0.08);
        // Wall bracket
        ctx.fillStyle = "#2a2218";
        ctx.fillRect(sx + CELL / 2 - 4 * PX, sy + 10 * PX, 8 * PX, 5 * PX);
        ctx.fillStyle = "#4a3a28";
        ctx.fillRect(sx + CELL / 2 - 2.5 * PX, sy + 6 * PX, 5 * PX, 12 * PX);
        // Flame body
        ctx.fillStyle = `rgba(255,140,40,${0.55 * flicker})`;
        ctx.beginPath();
        ctx.ellipse(sx + CELL / 2, sy + 5 * PX, 7 * PX * flicker, 10 * PX * flicker, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,190,60,${0.9 * flicker})`;
        ctx.beginPath();
        ctx.ellipse(sx + CELL / 2, sy + 4 * PX, 4.5 * PX * flicker, 8 * PX * flicker, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,245,200,${0.95 * flicker})`;
        ctx.beginPath();
        ctx.ellipse(sx + CELL / 2, sy + 3 * PX, 2.2 * PX, 4 * PX, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const e of enemies) {
      if (!tileVisibleInRegion(Math.floor(e.x), Math.floor(e.y), camRegion)) continue;
      // Hide minions that are about to despawn (fade)
      let alpha = 1;
      if (e.kind === "minion" && e.fleeing && e.despawnAt) {
        const left = e.despawnAt - performance.now();
        if (left < 350) alpha = Math.max(0, left / 350);
      }
      ctx.globalAlpha = alpha;
      const ex = (e.x - camera.x) * CELL;
      const ey = (e.y - camera.y) * CELL;
      if (e.kind === "succubus") {
        ctx.fillStyle = e.hasSight ? "#e050b0" : "#c040a0";
        ctx.beginPath();
        ctx.arc(ex, ey, 11 * PX, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ff6bcb";
        ctx.lineWidth = 2 * PX;
        ctx.beginPath();
        ctx.moveTo(ex - 5 * PX, ey - 9 * PX);
        ctx.lineTo(ex - 8 * PX, ey - 16 * PX);
        ctx.moveTo(ex + 5 * PX, ey - 9 * PX);
        ctx.lineTo(ex + 8 * PX, ey - 16 * PX);
        ctx.stroke();
        ctx.strokeStyle = `rgba(224,64,160,${0.4 + Math.sin(e.anim) * 0.2})`;
        ctx.beginPath();
        ctx.arc(ex, ey, (14 + Math.sin(e.anim) * 2) * PX, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#a78bfa";
        ctx.beginPath();
        ctx.arc(ex, ey, 8 * PX, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.arc(ex - 2 * PX, ey - 1 * PX, 1.5 * PX, 0, Math.PI * 2);
        ctx.arc(ex + 2 * PX, ey - 1 * PX, 1.5 * PX, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const inv = performance.now() < invulnUntil;
    if (!inv || Math.floor(animTime * 12) % 2 === 0) {
      ctx.fillStyle = player.sprinting ? "#a8e0ff" : "#7ec8ff";
      ctx.beginPath();
      ctx.arc(px, py, 9 * PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = player.clothing.shirt ? "#5eead4" : "#333";
      ctx.fillRect(px - 8 * PX, py - 14 * PX, 5 * PX, 3 * PX);
      ctx.fillStyle = player.clothing.pants ? "#5eead4" : "#333";
      ctx.fillRect(px - 2 * PX, py + 10 * PX, 5 * PX, 3 * PX);
      ctx.fillStyle = player.clothing.shoes ? "#5eead4" : "#333";
      ctx.fillRect(px + 4 * PX, py + 10 * PX, 5 * PX, 3 * PX);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= 1 / 60;
      p.x += p.vx / 60;
      p.y += p.vy / 60;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x - camera.x * CELL, p.y - camera.y * CELL, 3 * PX, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Lighting
    lightCtx.clearRect(0, 0, w, h);
    lightCtx.globalCompositeOperation = "source-over";
    lightCtx.fillStyle = `rgba(4, 2, 10, ${AMBIENT_DARK})`;
    lightCtx.fillRect(0, 0, w, h);
    lightCtx.globalCompositeOperation = "destination-out";

    if (maze.torches) {
      for (const t of maze.torches) {
        if (!tileVisibleInRegion(t.x, t.y, camRegion)) continue;
        const tx = (t.x + 0.5 - camera.x) * CELL;
        const ty = (t.y + 0.35 - camera.y) * CELL;
        const rad = TORCH_RADIUS * CELL * (0.9 + (torchFlicker - 0.85) * 0.6);
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
      const rad = 1.6 * CELL;
      const g = lightCtx.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, "rgba(0,0,0,0.4)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      lightCtx.fillStyle = g;
      lightCtx.beginPath();
      lightCtx.arc(px, py, rad, 0, Math.PI * 2);
      lightCtx.fill();
    }

    {
      const range = FLASH_RANGE * CELL;
      const ang = player.facing;
      lightCtx.beginPath();
      lightCtx.moveTo(px, py);
      lightCtx.arc(px, py, range, ang - FLASH_HALF, ang + FLASH_HALF);
      lightCtx.closePath();
      const fg = lightCtx.createRadialGradient(px, py, CELL * 0.3, px, py, range);
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
        const tx = (t.x + 0.5 - camera.x) * CELL;
        const ty = (t.y + 0.35 - camera.y) * CELL;
        const rad = TORCH_RADIUS * CELL * 0.85 * torchFlicker;
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
      const range = FLASH_RANGE * CELL;
      const ang = player.facing;
      const tipX = px + Math.cos(ang) * range * 0.45;
      const tipY = py + Math.sin(ang) * range * 0.45;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, range, ang - FLASH_HALF, ang + FLASH_HALF);
      ctx.closePath();
      const fg = ctx.createRadialGradient(px, py, 0, tipX, tipY, range * 0.7);
      fg.addColorStop(0, "rgba(200,220,255,0.16)");
      fg.addColorStop(0.6, "rgba(180,200,255,0.06)");
      fg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = fg;
      ctx.fill();
    }
    ctx.restore();

    {
      const range = FLASH_RANGE * CELL;
      const ang = player.facing;
      ctx.strokeStyle = "rgba(180,200,255,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.arc(px, py, range, ang - FLASH_HALF, ang + FLASH_HALF);
      ctx.closePath();
      ctx.stroke();
    }

    {
      if (!inv || Math.floor(animTime * 12) % 2 === 0) {
        const tip = 14;
        ctx.fillStyle = "rgba(220,235,255,0.85)";
        ctx.beginPath();
        ctx.moveTo(px + player.facingDx * tip, py + player.facingDy * tip);
        ctx.lineTo(
          px - player.facingDy * 5 - player.facingDx * 2,
          py + player.facingDx * 5 - player.facingDy * 2
        );
        ctx.lineTo(
          px + player.facingDy * 5 - player.facingDx * 2,
          py - player.facingDx * 5 - player.facingDy * 2
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
    vig.addColorStop(0, "transparent");
    vig.addColorStop(1, "rgba(5,2,10,0.45)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = "center";
    ctx.font = "bold " + Math.round(12 * PX) + "px Segoe UI, sans-serif";
    for (const ft of floatTexts) {
      const fx = (ft.x - camera.x) * CELL;
      const fy = (ft.y - camera.y) * CELL;
      ctx.globalAlpha = Math.max(0, Math.min(1, ft.life));
      ctx.fillStyle = "#ffb3e0";
      ctx.strokeStyle = "rgba(20,5,30,0.85)";
      ctx.lineWidth = 3;
      ctx.strokeText(ft.text, fx, fy);
      ctx.fillText(ft.text, fx, fy);
      ctx.globalAlpha = 1;
    }
  }

  // --- Update loop ---
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
