# Cave Tickle Maze

**Play online:** https://grey142.github.io/tickle-Maze/

Repo: https://github.com/grey142/tickle-Maze

A playful browser maze game: explore glowing caves while a teasing succubus and her tickly minions try to catch you. Resist tickle cinematics, manage clothing & sensitivity, and reach the EXIT.

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
- **Flashlight:** Always on — shines in the direction you last moved (no toggle). Point it at minions or the succubus to scare them away; they flee while in the beam. Approaching from **behind** (outside the cone) still lets them grab you
- **Lighting:** The whole cave stays visible but dim; wall torches cast warm glow pools; your flashlight is the bright forward cone
- **Resist:** Mash Space / tap the big button during catch cinematics
- **Pause:** Esc or P
- **Goal:** Reach the teal **EXIT** tile
- **Clothing:** Start with Shirt, Shoes, Pants. Each worn piece reduces ticklishness by 15%. Losing a resist QTE strips all clothes; succeeding strips only the scene’s piece (or raises sensitivity if that piece is already gone)
- **Sensitivity:** Separate meter. Fills toward game over at 100%. Find the teal **potion** to reduce it (−40%)
- **Game over:** Fail a resist with no clothes left, or sensitivity hits 100%
- **Restart:** Same maze layout (same seed), clothes restored, sensitivity cleared

## Files

- `index.html` — shell + UI overlays
- `css/style.css` — cave / magenta theme
- `js/maze.js` — seeded maze generator
- `js/scenes.js` — feet / belly / tied cinematic pools
- `js/game.js` — gameplay, enemies, QTE, HUD

## Tech

Vanilla HTML/CSS/Canvas 2D. No build step, no frameworks.
