/**
 * Cave Tickle Maze — main game engine (Canvas 2D)
 */
(function () {
  "use strict";

  const TILE = window.MazeGen.TILE;
  const CELL = 28;
  const COLS = 25;
  const ROWS = 19;

  // Flashlight / lighting
  const FLASH_RANGE = 5.8;          // tiles
  const FLASH_CONE_DEG = 60;        // full cone angle
  const FLASH_HALF = (FLASH_CONE_DEG * Math.PI) / 180 / 2;
  const FLASH_COS = Math.cos(FLASH_HALF);
  const AMBIENT_DARK = 0.72;        // overlay opacity (cave stays visible but dim)
  const TORCH_RADIUS = 3.2;         // tiles

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const canvas = $("game-canvas");
  const ctx = canvas.getContext("2d");
  const cineCanvas = $("cine-canvas");
  const cineCtx = cineCanvas.getContext("2d");
  // Offscreen lighting layer (dark + punched lights) so destination-out
  // never erases the maze itself
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
  let enemies = [];
  let mode = "title"; // title | play | cinematic | pause | win | gameover
  let invulnUntil = 0;
  let keys = Object.create(null);
  let lastTs = 0;
  let toastTimer = null;
  let particles = [];
  let torchFlicker = 0;
  let resistState = null;
  let camera = { x: 0, y: 0 };
  let animTime = 0;
  let pickupFlash = [];
  let floatTexts = [];

  function defaultClothing() {
    return { shirt: true, shoes: true, pants: true };
  }

  function clothingCount(c) {
    return (c.shirt ? 1 : 0) + (c.shoes ? 1 : 0) + (c.pants ? 1 : 0);
  }

  function computeTicklishnessPct() {
    // Display & difficulty: sensitivity-driven + base, minus 15% per clothing piece
    const base = 20 + player.sensitivity * 0.8; // 20–100 as sens fills
    const reduced = base - clothingCount(player.clothing) * 15;
    return Math.max(0, Math.min(100, Math.round(reduced)));
  }

  // --- Audio (tiny beeps via WebAudio, optional) ---
  let audioCtx = null;
  function beep(freq, dur, type) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || "sine";
      o.frequency.value = freq;
      g.gain.value = 0.04;
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.stop(audioCtx.currentTime + dur);
    } catch (_) {}
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
    $("level-label").textContent = "Level " + level;
  }

  function setMuteUI() {
    $("btn-mute").textContent = muted ? "🔇" : "🔊";
    $("btn-mute-title").textContent = muted ? "🔇 Sound Off" : "🔊 Sound On";
  }

  // --- Level setup ---
  function buildLevel(keepSeed) {
    if (!keepSeed) levelSeed = (Date.now() ^ (level * 9973)) >>> 0;
    maze = window.MazeGen.generate(COLS, ROWS, levelSeed + level * 10007, level);
    player = {
      x: maze.start.x + 0.5,
      y: maze.start.y + 0.5,
      speed: 3.6,
      clothing: defaultClothing(),
      sensitivity: 0,
      facing: 0,          // radians (atan2), flashlight direction
      facingDx: 1,
      facingDy: 0
    };
    enemies = [];
    // First spawn = succubus, rest = minions
    maze.enemySpawns.forEach((s, i) => {
      enemies.push({
        x: s.x + 0.5,
        y: s.y + 0.5,
        kind: i === 0 ? "succubus" : "minion",
        speed: i === 0 ? 2.35 : 1.85,
        awareness: i === 0 ? 9 : 5.5,
        pathTimer: 0,
        path: [],
        anim: Math.random() * Math.PI * 2,
        scared: false,
        fleeUntil: 0,
        flankBias: i === 0 ? (Math.random() < 0.5 ? 1 : -1) : 0
      });
    });
    particles = [];
    pickupFlash = [];
    floatTexts = [];
    invulnUntil = 0;
    updateHUD();
  }

  function startGame(fresh) {
    level = 1;
    if (fresh) levelSeed = (Math.random() * 1e9) >>> 0;
    buildLevel(true); // use current levelSeed (just set if fresh)
    mode = "play";
    showScreen("game-screen");
    showOverlay("cinematic", false);
    showOverlay("pause-overlay", false);
    showOverlay("win-overlay", false);
    showOverlay("gameover-overlay", false);
    beep(440, 0.08);
    toast("Find the glowing EXIT… and try not to giggle!", 2800);
  }

  function restartSameLevel() {
    buildLevel(true); // keep seed
    mode = "play";
    showOverlay("gameover-overlay", false);
    showOverlay("win-overlay", false);
    showOverlay("cinematic", false);
    showOverlay("pause-overlay", false);
    showScreen("game-screen");
    toast("Retry! Same maze — clothes restored, sensitivity cleared.", 2500);
    beep(523, 0.1);
  }

  function nextLevel() {
    level++;
    buildLevel(false);
    mode = "play";
    showOverlay("win-overlay", false);
    toast("Deeper into the caves… Level " + level, 2200);
  }

  // --- Collision / movement ---
  function isWall(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= maze.cols || ty >= maze.rows) return true;
    const t = maze.grid[ty][tx];
    return t === TILE.WALL;
  }

  function tryMove(ent, dx, dy, dt, speed) {
    const nx = ent.x + dx * speed * dt;
    const ny = ent.y + dy * speed * dt;
    const r = 0.28;
    // Axis-separated collision for fairness
    let x = ent.x, y = ent.y;
    if (!isWall(Math.floor(nx - r), Math.floor(ent.y - r)) &&
        !isWall(Math.floor(nx + r), Math.floor(ent.y - r)) &&
        !isWall(Math.floor(nx - r), Math.floor(ent.y + r)) &&
        !isWall(Math.floor(nx + r), Math.floor(ent.y + r))) {
      x = nx;
    }
    if (!isWall(Math.floor(x - r), Math.floor(ny - r)) &&
        !isWall(Math.floor(x + r), Math.floor(ny - r)) &&
        !isWall(Math.floor(x - r), Math.floor(ny + r)) &&
        !isWall(Math.floor(x + r), Math.floor(ny + r))) {
      y = ny;
    }
    ent.x = x; ent.y = y;
  }

  // --- Pathfinding (BFS, tile-based) ---
  function findPath(sx, sy, gx, gy) {
    const start = { x: Math.floor(sx), y: Math.floor(sy) };
    const goal = { x: Math.floor(gx), y: Math.floor(gy) };
    if (start.x === goal.x && start.y === goal.y) return [];
    const key = (x, y) => x + "," + y;
    const q = [start];
    const came = new Map();
    came.set(key(start.x, start.y), null);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let found = false;
    while (q.length) {
      const cur = q.shift();
      if (cur.x === goal.x && cur.y === goal.y) { found = true; break; }
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
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

  /** Unit facing + whether an enemy body is inside the flashlight cone (in front). */
  function enemyInFlashlight(e) {
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05 || dist > FLASH_RANGE) return false;
    const nx = dx / dist;
    const ny = dy / dist;
    const dot = player.facingDx * nx + player.facingDy * ny;
    // Must be roughly in front and within cone half-angle
    return dot >= FLASH_COS;
  }

  /** True if enemy is primarily behind the player (rear hemisphere). */
  function enemyBehindPlayer(e) {
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const dist = Math.hypot(dx, dy) || 1;
    const dot = player.facingDx * (dx / dist) + player.facingDy * (dy / dist);
    return dot < 0;
  }

  function fleeTargetAwayFromPlayer(e) {
    // Prefer a walkable tile further from the player along the flee vector
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const len = Math.hypot(dx, dy) || 1;
    let fx = dx / len;
    let fy = dy / len;
    // Succubus: bias sideways to flank after beam break
    if (e.kind === "succubus") {
      const px = -fy * e.flankBias;
      const py = fx * e.flankBias;
      fx = fx * 0.55 + px * 0.45;
      fy = fy * 0.55 + py * 0.45;
      const fl = Math.hypot(fx, fy) || 1;
      fx /= fl; fy /= fl;
    }
    const steps = e.kind === "succubus" ? 3 : 5;
    let best = null;
    for (let s = steps; s >= 1; s--) {
      const tx = Math.floor(e.x + fx * s);
      const ty = Math.floor(e.y + fy * s);
      if (!isWall(tx, ty)) {
        best = { x: tx, y: ty };
        break;
      }
    }
    if (!best) {
      // Try cardinals away from player
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
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
    const label = e.kind === "succubus"
      ? "Succubus hissed and fled!"
      : "Monster hissed and fled!";
    floatTexts.push({
      x: e.x,
      y: e.y - 0.6,
      text: label,
      life: 1.4,
      vy: -0.55
    });
    beep(320, 0.08, "triangle");
  }

  function updateEnemies(dt) {
    const now = performance.now();
    for (const e of enemies) {
      e.anim += dt * 4;
      const dist = Math.hypot(player.x - e.x, player.y - e.y);
      const beamed = enemyInFlashlight(e);

      // Scare: beam hits enemy → flee (succubus braver / shorter linger)
      if (beamed) {
        const wasScared = e.scared;
        e.scared = true;
        const linger = e.kind === "succubus" ? 450 : 1100;
        e.fleeUntil = Math.max(e.fleeUntil, now + linger);
        if (!wasScared) spawnScareText(e);
      } else if (e.scared && now >= e.fleeUntil) {
        e.scared = false;
        // Succubus may flip flank side when recovering
        if (e.kind === "succubus") e.flankBias *= -1;
      }

      e.pathTimer -= dt;

      if (e.scared || now < e.fleeUntil) {
        // Flee away from flashlight / player
        if (e.pathTimer <= 0) {
          const dest = fleeTargetAwayFromPlayer(e);
          if (dest) {
            e.path = findPath(e.x, e.y, dest.x + 0.5, dest.y + 0.5);
            if (!e.path.length) e.path = [dest];
          }
          e.pathTimer = e.kind === "succubus" ? 0.22 : 0.28;
        }
        const fleeSpeed = e.speed * (e.kind === "succubus" ? 1.25 : 1.45);
        if (e.path && e.path.length) {
          const t = e.path[0];
          const tx = t.x + 0.5, ty = t.y + 0.5;
          const dx = tx - e.x, dy = ty - e.y;
          const len = Math.hypot(dx, dy) || 1;
          tryMove(e, dx / len, dy / len, dt, fleeSpeed);
          if (Math.hypot(tx - e.x, ty - e.y) < 0.15) e.path.shift();
        }
        // While scared / illuminated, cannot grab (flashlight protects the front)
        continue;
      }

      if (dist < e.awareness && e.pathTimer <= 0) {
        // Succubus: slight flank offset when chasing from the side
        let gx = player.x, gy = player.y;
        if (e.kind === "succubus" && dist > 1.2) {
          const ox = -player.facingDy * e.flankBias * 1.5;
          const oy = player.facingDx * e.flankBias * 1.5;
          const tx = Math.floor(player.x + ox);
          const ty = Math.floor(player.y + oy);
          if (!isWall(tx, ty)) {
            gx = tx + 0.5;
            gy = ty + 0.5;
          }
        }
        e.path = findPath(e.x, e.y, gx, gy);
        e.pathTimer = e.kind === "succubus" ? 0.35 : 0.55;
      } else if (dist >= e.awareness && e.pathTimer <= 0) {
        // Wander
        e.pathTimer = 1.2 + Math.random();
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const d = dirs[Math.floor(Math.random() * 4)];
        const tx = Math.floor(e.x) + d[0];
        const ty = Math.floor(e.y) + d[1];
        if (!isWall(tx, ty)) e.path = [{ x: tx, y: ty }];
      }
      if (e.path && e.path.length) {
        const t = e.path[0];
        const tx = t.x + 0.5, ty = t.y + 0.5;
        const dx = tx - e.x, dy = ty - e.y;
        const len = Math.hypot(dx, dy) || 1;
        tryMove(e, dx / len, dy / len, dt, e.speed);
        if (Math.hypot(tx - e.x, ty - e.y) < 0.15) e.path.shift();
      }

      // Catch player — rear / out-of-beam approaches still grab
      // (front beam already handled by scare branch above)
      if (now >= invulnUntil && dist < 0.55) {
        // Extra safety: if somehow still in beam at contact, scare instead
        if (enemyInFlashlight(e)) {
          e.scared = true;
          e.fleeUntil = now + (e.kind === "succubus" ? 450 : 1100);
          spawnScareText(e);
          continue;
        }
        triggerCatch(e.kind === "succubus" ? "succubus" : "minion");
        return;
      }
    }
  }

  // --- Pickups / traps ---
  function checkTiles() {
    const tx = Math.floor(player.x);
    const ty = Math.floor(player.y);
    if (tx < 0 || ty < 0 || tx >= maze.cols || ty >= maze.rows) return;
    const t = maze.grid[ty][tx];
    if (t === TILE.EXIT) {
      winLevel();
      return;
    }
    if (t === TILE.TRAP && performance.now() >= invulnUntil) {
      maze.grid[ty][tx] = TILE.FLOOR; // one-shot
      triggerCatch("trap");
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
      maze.grid[ty][tx] = TILE.FLOOR;
      const map = {
        [TILE.CLOTH_SHIRT]: "shirt",
        [TILE.CLOTH_SHOES]: "shoes",
        [TILE.CLOTH_PANTS]: "pants"
      };
      const piece = map[t];
      const names = { shirt: "Shirt", shoes: "Shoes", pants: "Pants" };
      if (!player.clothing[piece]) {
        player.clothing[piece] = true;
        toast("Found your " + names[piece] + "! (−15% ticklishness)", 2200);
        beep(520, 0.1);
      } else {
        toast("Extra " + names[piece] + " — already wearing that.", 1800);
      }
      updateHUD();
      spawnPickupFX(tx, ty, "#e040a0");
    }
  }

  function spawnPickupFX(tx, ty, color) {
    for (let i = 0; i < 12; i++) {
      particles.push({
        x: (tx + 0.5) * CELL, y: (ty + 0.5) * CELL,
        vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60,
        life: 0.6, color
      });
    }
  }

  // --- Catch / cinematic / resist ---
  function triggerCatch(source) {
    const pick = window.pickScene(player.clothing);
    const tick = computeTicklishnessPct();
    // QTE: fill starts mid; drain faster & tap weaker when ticklish
    const drain = 18 + tick * 0.45; // % per second
    const tapGain = Math.max(2.2, 7.5 - tick * 0.045);
    const needTapsHint = Math.ceil(55 / tapGain);

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
      done: false
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
    const w = cineCanvas.width, h = cineCanvas.height;
    cineCtx.clearRect(0, 0, w, h);
    // Cave bg
    const g = cineCtx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#1a0c28");
    g.addColorStop(1, "#080410");
    cineCtx.fillStyle = g;
    cineCtx.fillRect(0, 0, w, h);
    // Torches
    for (let i = 0; i < 5; i++) {
      cineCtx.fillStyle = `rgba(255,154,60,${0.15 + Math.random() * 0.1})`;
      cineCtx.beginPath();
      cineCtx.arc(80 + i * 120, 40, 30 + Math.random() * 10, 0, Math.PI * 2);
      cineCtx.fill();
    }
    // Simple stylized figures
    function body(x, y, color, scale) {
      cineCtx.fillStyle = color;
      cineCtx.beginPath();
      cineCtx.ellipse(x, y - 20 * scale, 14 * scale, 18 * scale, 0, 0, Math.PI * 2);
      cineCtx.fill();
      cineCtx.beginPath();
      cineCtx.ellipse(x, y + 10 * scale, 18 * scale, 22 * scale, 0, 0, Math.PI * 2);
      cineCtx.fill();
    }
    // Succubus (magenta)
    body(w * 0.72, h * 0.55, "#c040a0", 1.15);
    // Horns
    cineCtx.strokeStyle = "#ff6bcb";
    cineCtx.lineWidth = 3;
    cineCtx.beginPath();
    cineCtx.moveTo(w * 0.72 - 10, h * 0.55 - 42);
    cineCtx.quadraticCurveTo(w * 0.72 - 18, h * 0.55 - 70, w * 0.72 - 4, h * 0.55 - 55);
    cineCtx.moveTo(w * 0.72 + 10, h * 0.55 - 42);
    cineCtx.quadraticCurveTo(w * 0.72 + 18, h * 0.55 - 70, w * 0.72 + 4, h * 0.55 - 55);
    cineCtx.stroke();
    // Wings
    cineCtx.fillStyle = "rgba(140,60,180,0.5)";
    cineCtx.beginPath();
    cineCtx.ellipse(w * 0.72 - 40, h * 0.5, 28, 18, -0.5, 0, Math.PI * 2);
    cineCtx.ellipse(w * 0.72 + 40, h * 0.5, 28, 18, 0.5, 0, Math.PI * 2);
    cineCtx.fill();

    // Player (victim)
    body(w * 0.35, h * 0.62, "#7ec8ff", 1);
    // Tickle sparks
    cineCtx.fillStyle = "#fde047";
    for (let i = 0; i < 18; i++) {
      const sx = w * 0.35 + (Math.random() - 0.5) * 80;
      const sy = h * (type === "feet" ? 0.82 : type === "belly" ? 0.58 : 0.65) + (Math.random() - 0.5) * 40;
      cineCtx.beginPath();
      cineCtx.arc(sx, sy, 2 + Math.random() * 3, 0, Math.PI * 2);
      cineCtx.fill();
    }
    // Labels
    cineCtx.fillStyle = "#ff6bcb";
    cineCtx.font = "bold 16px Segoe UI, sans-serif";
    cineCtx.fillText(type === "feet" ? "✦ FEET ✦" : type === "belly" ? "✦ BELLY / FLANKS ✦" : "✦ TIED DOWN ✦", 24, h - 18);
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
      resistState.captionIdx = (resistState.captionIdx + 1) % resistState.scene.captions.length;
      $("cine-caption").textContent = resistState.scene.captions[resistState.captionIdx];
      // Refresh art sparks
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
    showOverlay("cinematic", false);

    if (success) {
      if (player.clothing[piece]) {
        player.clothing[piece] = false;
        toast("You wriggled free — but lost your " + names[piece] + "!", 2600);
      } else {
        // Already missing → raise sensitivity (+3% via sensitivity system)
        player.sensitivity = Math.min(100, player.sensitivity + 3);
        toast("Already bare there… sensitivity rises! (+3%)", 2600);
      }
      invulnUntil = performance.now() + 2200;
      updateHUD();
      beep(700, 0.12, "triangle");

      if (player.sensitivity >= 100) {
        gameOver("Sensitivity maxed out — too ticklish to continue!");
        return;
      }
      mode = "play";
      return;
    }

    // Fail resist
    const hadAny = clothingCount(player.clothing) > 0;
    player.clothing = { shirt: false, shoes: false, pants: false };
    updateHUD();
    if (!hadAny) {
      gameOver("Caught with nothing left to lose… the giggles win!");
      return;
    }
    toast("Failed to resist! All clothing lost in a ticklish flurry!", 2800);
    invulnUntil = performance.now() + 2500;
    beep(150, 0.3, "sawtooth");
    mode = "play";
  }

  function winLevel() {
    mode = "win";
    $("win-flavor").textContent =
      "You dash through the glowing exit, half-laughing. The succubus waves coyly from the dark — \"Next time, darling~\" Level " + level + " clear!";
    showOverlay("win-overlay", true);
    beep(523, 0.1); setTimeout(() => beep(659, 0.1), 100); setTimeout(() => beep(784, 0.2), 200);
  }

  function gameOver(reason) {
    mode = "gameover";
    $("go-reason").textContent = reason;
    showOverlay("gameover-overlay", true);
    beep(110, 0.4, "sawtooth");
  }

  // --- Rendering ---
  function draw() {
    if (!maze) return;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = "#0a0612";
    ctx.fillRect(0, 0, w, h);

    // Camera follow
    const viewW = w / CELL, viewH = h / CELL;
    camera.x = player.x - viewW / 2;
    camera.y = player.y - viewH / 2;
    camera.x = Math.max(0, Math.min(maze.cols - viewW, camera.x));
    camera.y = Math.max(0, Math.min(maze.rows - viewH, camera.y));

    torchFlicker = 0.85 + Math.sin(animTime * 6) * 0.08 + Math.sin(animTime * 13) * 0.04;

    const x0 = Math.max(0, Math.floor(camera.x) - 1);
    const y0 = Math.max(0, Math.floor(camera.y) - 1);
    const x1 = Math.min(maze.cols - 1, Math.ceil(camera.x + viewW) + 1);
    const y1 = Math.min(maze.rows - 1, Math.ceil(camera.y + viewH) + 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const sx = (x - camera.x) * CELL;
        const sy = (y - camera.y) * CELL;
        const t = maze.grid[y][x];
        if (t === TILE.WALL) {
          ctx.fillStyle = "#1e1830";
          ctx.fillRect(sx, sy, CELL, CELL);
          ctx.fillStyle = "#2a2438";
          ctx.fillRect(sx + 2, sy + 2, CELL - 4, CELL - 4);
          // purple accent cracks
          if ((x + y) % 5 === 0) {
            ctx.strokeStyle = "rgba(139,92,246,0.35)";
            ctx.beginPath();
            ctx.moveTo(sx + 4, sy + 8);
            ctx.lineTo(sx + CELL - 6, sy + CELL - 10);
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = "#12101c";
          ctx.fillRect(sx, sy, CELL, CELL);
          // floor tint
          ctx.fillStyle = "rgba(80,40,100,0.12)";
          ctx.fillRect(sx, sy, CELL, CELL);

          if (t === TILE.EXIT) {
            const eg = ctx.createRadialGradient(sx + CELL / 2, sy + CELL / 2, 2, sx + CELL / 2, sy + CELL / 2, CELL);
            eg.addColorStop(0, `rgba(94,234,212,${0.7 * torchFlicker})`);
            eg.addColorStop(1, "transparent");
            ctx.fillStyle = eg;
            ctx.fillRect(sx - 4, sy - 4, CELL + 8, CELL + 8);
            ctx.fillStyle = "#5eead4";
            ctx.font = "bold 11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("EXIT", sx + CELL / 2, sy + CELL / 2 + 4);
          } else if (t === TILE.TRAP) {
            ctx.fillStyle = "rgba(255,77,109,0.35)";
            ctx.beginPath();
            ctx.arc(sx + CELL / 2, sy + CELL / 2, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#ff4d6d";
            ctx.stroke();
          } else if (t === TILE.POTION) {
            ctx.fillStyle = "#5eead4";
            ctx.beginPath();
            ctx.arc(sx + CELL / 2, sy + CELL / 2 - 2, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#a5f3fc";
            ctx.fillRect(sx + CELL / 2 - 3, sy + CELL / 2 + 4, 6, 5);
          } else if (t === TILE.CLOTH_SHIRT || t === TILE.CLOTH_SHOES || t === TILE.CLOTH_PANTS) {
            ctx.fillStyle = "#e040a0";
            ctx.fillRect(sx + 6, sy + 8, CELL - 12, CELL - 14);
            ctx.fillStyle = "#ffb3e0";
            ctx.font = "10px sans-serif";
            ctx.textAlign = "center";
            const label = t === TILE.CLOTH_SHIRT ? "👕" : t === TILE.CLOTH_SHOES ? "👟" : "👖";
            ctx.fillText(label, sx + CELL / 2, sy + CELL / 2 + 4);
          }
        }
      }
    }

    const px = (player.x - camera.x) * CELL;
    const py = (player.y - camera.y) * CELL;

    // Draw wall-mounted torch sprites (before entities)
    if (maze.torches) {
      for (const t of maze.torches) {
        const sx = (t.x - camera.x) * CELL;
        const sy = (t.y - camera.y) * CELL;
        if (sx < -CELL || sy < -CELL || sx > canvas.width + CELL || sy > canvas.height + CELL) continue;
        const flicker = torchFlicker * (0.92 + Math.sin(animTime * 9 + t.x * 1.7) * 0.08);
        // Sconce
        ctx.fillStyle = "#3a2a20";
        ctx.fillRect(sx + CELL / 2 - 3, sy + 4, 6, 10);
        // Flame
        ctx.fillStyle = `rgba(255,180,60,${0.85 * flicker})`;
        ctx.beginPath();
        ctx.ellipse(sx + CELL / 2, sy + 6, 4 * flicker, 7 * flicker, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,240,180,${0.9 * flicker})`;
        ctx.beginPath();
        ctx.ellipse(sx + CELL / 2, sy + 5, 2, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Enemies
    for (const e of enemies) {
      const ex = (e.x - camera.x) * CELL;
      const ey = (e.y - camera.y) * CELL;
      if (e.kind === "succubus") {
        ctx.fillStyle = "#c040a0";
        ctx.beginPath();
        ctx.arc(ex, ey, 11, 0, Math.PI * 2);
        ctx.fill();
        // horns
        ctx.strokeStyle = "#ff6bcb";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ex - 5, ey - 9);
        ctx.lineTo(ex - 8, ey - 16);
        ctx.moveTo(ex + 5, ey - 9);
        ctx.lineTo(ex + 8, ey - 16);
        ctx.stroke();
        // aura
        ctx.strokeStyle = `rgba(224,64,160,${0.4 + Math.sin(e.anim) * 0.2})`;
        ctx.beginPath();
        ctx.arc(ex, ey, 14 + Math.sin(e.anim) * 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#a78bfa";
        ctx.beginPath();
        ctx.arc(ex, ey, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.arc(ex - 2, ey - 1, 1.5, 0, Math.PI * 2);
        ctx.arc(ex + 2, ey - 1, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Player
    const inv = performance.now() < invulnUntil;
    if (!inv || Math.floor(animTime * 12) % 2 === 0) {
      ctx.fillStyle = "#7ec8ff";
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
      // clothing indicators as tiny dots
      ctx.fillStyle = player.clothing.shirt ? "#5eead4" : "#333";
      ctx.fillRect(px - 8, py - 14, 5, 3);
      ctx.fillStyle = player.clothing.pants ? "#5eead4" : "#333";
      ctx.fillRect(px - 2, py + 10, 5, 3);
      ctx.fillStyle = player.clothing.shoes ? "#5eead4" : "#333";
      ctx.fillRect(px + 4, py + 10, 5, 3);
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= 1 / 60;
      p.x += p.vx / 60; p.y += p.vy / 60;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x - camera.x * CELL, p.y - camera.y * CELL, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // --- Lighting: dim cave + torch pools + forward flashlight ---
    // Build darkness on offscreen canvas; destination-out punches light holes
    // without erasing the maze. Overlay keeps layout visible but shadowy.
    lightCtx.clearRect(0, 0, w, h);
    lightCtx.globalCompositeOperation = "source-over";
    lightCtx.fillStyle = `rgba(4, 2, 10, ${AMBIENT_DARK})`;
    lightCtx.fillRect(0, 0, w, h);

    lightCtx.globalCompositeOperation = "destination-out";

    // Torch glow pools
    if (maze.torches) {
      for (const t of maze.torches) {
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

    // Soft ambient pool around player (dim personal light)
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

    // Flashlight cone (brighter beam ahead of facing)
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

    // Warm colored glows (additive tint over punched lights)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (maze.torches) {
      for (const t of maze.torches) {
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
    // Cool-white flashlight tint
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

    // Flashlight rim hint (visible beam edge)
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

    // Facing chevron on player (flashlight direction cue)
    {
      const inv = performance.now() < invulnUntil;
      if (!inv || Math.floor(animTime * 12) % 2 === 0) {
        const tip = 14;
        ctx.fillStyle = "rgba(220,235,255,0.85)";
        ctx.beginPath();
        ctx.moveTo(px + player.facingDx * tip, py + player.facingDy * tip);
        ctx.lineTo(px - player.facingDy * 5 - player.facingDx * 2,
                   py + player.facingDx * 5 - player.facingDy * 2);
        ctx.lineTo(px + player.facingDy * 5 - player.facingDx * 2,
                   py - player.facingDx * 5 - player.facingDy * 2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Soft outer vignette (doesn't kill HUD — HUD is DOM above canvas)
    const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
    vig.addColorStop(0, "transparent");
    vig.addColorStop(1, "rgba(5,2,10,0.4)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    // Floating scare text (drawn last, fully lit)
    ctx.textAlign = "center";
    ctx.font = "bold 12px Segoe UI, sans-serif";
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

    let dx = 0, dy = 0;
    if (keys["ArrowUp"] || keys["w"] || keys["W"] || keys._up) dy -= 1;
    if (keys["ArrowDown"] || keys["s"] || keys["S"] || keys._down) dy += 1;
    if (keys["ArrowLeft"] || keys["a"] || keys["A"] || keys._left) dx -= 1;
    if (keys["ArrowRight"] || keys["d"] || keys["D"] || keys._right) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const nx = dx / len, ny = dy / len;
      tryMove(player, nx, ny, dt, player.speed);
      // Last nonzero move sets flashlight facing
      player.facing = Math.atan2(ny, nx);
      player.facingDx = nx;
      player.facingDy = ny;
    }

    // Float text
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
    if (mode === "play" || mode === "pause" || mode === "cinematic" || mode === "win" || mode === "gameover") {
      if (maze) draw();
    }
    requestAnimationFrame(frame);
  }

  // --- Input ---
  window.addEventListener("keydown", (e) => {
    keys[e.key] = true;
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
  window.addEventListener("keyup", (e) => { keys[e.key] = false; });

  $("btn-resist").addEventListener("click", resistTap);
  $("btn-resist").addEventListener("touchstart", (e) => { e.preventDefault(); resistTap(); }, { passive: false });

  // Mobile d-pad
  document.querySelectorAll(".dpad").forEach((btn) => {
    const dir = btn.dataset.dir;
    const map = { up: "_up", down: "_down", left: "_left", right: "_right" };
    const k = map[dir];
    const on = (e) => { e.preventDefault(); keys[k] = true; };
    const off = (e) => { e.preventDefault(); keys[k] = false; };
    btn.addEventListener("touchstart", on, { passive: false });
    btn.addEventListener("touchend", off, { passive: false });
    btn.addEventListener("touchcancel", off, { passive: false });
    btn.addEventListener("mousedown", on);
    btn.addEventListener("mouseup", off);
    btn.addEventListener("mouseleave", off);
  });

  // Buttons
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

  // Canvas tap also resists when cinematic (in case)
  canvas.addEventListener("click", () => {});
  cineCanvas.addEventListener("click", resistTap);

  setMuteUI();
  requestAnimationFrame(frame);
})();
