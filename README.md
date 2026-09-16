# Tickle Maze — Underground Mansion

**Play online:** https://grey142.github.io/tickle-Maze/

Repo: https://github.com/grey142/tickle-Maze

A playful browser game set in a spacious underground mansion. Explore large open torch-lit rooms (floor, decorations, and sparse traps — not mazes inside rooms) linked by doorways and short halls while a teasing succubus and her tickly minions try to catch you. Collect **keys** to unlock the **exit gate**, resist tickle cinematics, manage clothing & sensitivity, sprint between rooms, and advance deeper.

Adult-flavored teasing fantasy tone — not graphic.

## How to open

From this folder:

```bash
cd /workspace/maze-tickle-game
python3 -m http.server 8080
```

Then open **http://localhost:8080/** in your browser.

You can also open `index.html` directly (File → Open) — no ES modules are required.

## How to play

- **Move:** WASD or arrow keys (on-screen D-pad on touch devices)
- **Sprint:** Hold **Shift** (or the mobile **SPRINT** button). Drains the stamina bar; regenerates when you stop. Sprint is faster than the succubus chase; walking is slower than her chase
- **Camera:** Close-up **room-locked** view — you only see the room (or short hall) you are in. The camera soft-follows inside that space and clamps near walls/doorways so neighboring rooms stay off-screen (void outside). Crossing a doorway slides the camera into the next room
- **Flashlight:** Always on — shines in the direction you last moved. Beaming **minions** makes them flee, vanish, and respawn elsewhere (spaced away from you and other creatures). The **succubus is not afraid of light**
- **Succubus:** Wanders slowly and quietly. Heartbeats get louder as she approaches (main “she’s near” cue). If she has line of sight, she speeds up by 35% to chase; when she loses sight she returns to wandering
- **Traps:** Subtle / hard to spot floor seams. Hitting one triggers a grab cinematic; that trap is gone for the rest of this run on the level (returns only when the level reloads). **If she is actively chasing with sight when you hit a trap**, you lose **all clothing instantly** (combo), then resist
- **After any tickle resolution:** Minions and the succubus vanish and respawn at spaced random floor tiles on the current level, back to aimless wander (chase cleared)
- **Resist:** Mash Space / tap the big button during catch cinematics
- **Pause:** Esc or P
- **Keys & locked gate:** Each level scatters **3–5 golden keys** in open rooms. You need **3 keys** (HUD: `Keys 2/3`) to unlock the exit. The exit shows as a **LOCKED** gate until you have enough keys; then it becomes **OPEN**. Reach the open gate to clear the level
- **Level advance:** Level 1 uses a **handcrafted** mansion layout (from the art map). Deeper floors use a **new seed/layout** with **more rooms/connections**, **more traps**, and **more minions** (succubus still present). **Clothing and sensitivity carry forward** as ongoing risk. **Keys reset** each level
- **Clothing:** Start with Shirt, Shoes, Pants. Each worn piece reduces ticklishness by **15%**. Losses are tracked in order; **clothing pickups restore the last-lost piece (LIFO)**. If you are already fully clothed, pickups do nothing and stay on the map. Failing a resist while still clothed strips all clothes but you keep playing; succeeding strips only the scene’s piece (or raises sensitivity if that piece is already gone)
- **Sensitivity:** Separate meter that raises ticklishness difficulty. Find the teal **potion** to reduce it (−40%). **Sensitivity never causes game over**
- **Game over:** **Only** if you fail a resist while wearing **no clothing**
- **Restart (game over / replay):** Same mansion layout (same seed), **clothes restored**, **sensitivity cleared**, traps restored, **keys reset**. (Advancing to the next level keeps clothing/sensitivity.)

## Files

- `index.html` — shell + UI overlays
- `css/style.css` — manor / magenta theme
- `maps/level-01.jpg` — handcrafted Level 1 reference art
- `js/levels/level01.js` — Level 1 room/corridor layout matching the art map
- `js/maze.js` — seeded underground-mansion generator (Level 1 handcrafted; Level 2+ procedural open rooms + doorways)
- `js/scenes.js` — feet / belly / tied cinematic pools
- `js/game.js` — gameplay, room-locked camera, sprint, keys/gate, enemies, QTE, HUD

## Tech

Vanilla HTML/CSS/Canvas 2D. No build step, no frameworks. GitHub Pages via root (`main`).
