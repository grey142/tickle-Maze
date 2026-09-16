/**
 * Handcrafted Level 1 — matches maps/level-01.jpg topology (2× tile footprint).
 * Open rooms + short doorways; decorations are visual-only (non-blocking)
 * except corner pillars which are solid wall tiles.
 */
window.Level01 = (function () {
  const COLS = 100;
  const ROWS = 80;

  /**
   * Room rects (floor bounds). Gaps of ≥2 leave wall strips; connections carve doorways.
   * Order is used for ids; vestibule is start room, gate is exit room.
   * Layout scaled ~2× from the original art-map rects.
   */
  const ROOMS = [
    { name: "vestibule", x: 40, y: 4, w: 20, h: 12 }, // entrance top-center
    { name: "nw", x: 16, y: 4, w: 18, h: 10 },
    { name: "ne", x: 66, y: 4, w: 20, h: 12 },
    { name: "upperWest", x: 6, y: 18, w: 26, h: 16 },
    { name: "northCentral", x: 38, y: 20, w: 24, h: 12 },
    { name: "upperEast", x: 68, y: 20, w: 22, h: 16 },
    { name: "eastAlcove", x: 88, y: 24, w: 10, h: 10 },
    { name: "midWest", x: 6, y: 38, w: 24, h: 14 },
    { name: "hub", x: 36, y: 36, w: 28, h: 20 }, // central chamber
    { name: "midEast", x: 70, y: 40, w: 22, h: 16 },
    { name: "lowerWest", x: 8, y: 56, w: 24, h: 12 },
    { name: "gate", x: 36, y: 60, w: 28, h: 14 }, // exit chamber
    { name: "lowerEast", x: 68, y: 60, w: 24, h: 14 }
  ];

  /** Pairs of room names to connect with short doorways / halls. */
  const CONNECTIONS = [
    ["vestibule", "nw"],
    ["vestibule", "ne"],
    ["vestibule", "northCentral"],
    ["nw", "upperWest"],
    ["ne", "upperEast"],
    ["upperWest", "northCentral"],
    ["northCentral", "upperEast"],
    ["upperEast", "eastAlcove"],
    ["upperWest", "midWest"],
    ["northCentral", "hub"],
    ["upperEast", "midEast"],
    ["midWest", "hub"],
    ["hub", "midEast"],
    ["midWest", "lowerWest"],
    ["hub", "gate"],
    ["midEast", "lowerEast"],
    ["lowerWest", "gate"],
    ["gate", "lowerEast"]
  ];

  /** Player spawn — top of vestibule (stairs into mansion). */
  const START = { x: 48, y: 4 };

  /** Locked gate / EXIT tile — bottom center of gate chamber. */
  const EXIT = { x: 48, y: 72 };

  /**
   * Static decorations from the art (walkable unless type==="pillar").
   * Banners / cobwebs / stairs / rugs / furniture are draw-only.
   */
  const DECORATIONS = [
    // Entrance stairs marker
    { type: "stairs", x: 46, y: 4, w: 8, h: 4, facing: "s" },
    // Gate approach stairs (visual only — EXIT is the door tile)
    { type: "stairs", x: 46, y: 68, w: 8, h: 4, facing: "s" },

    // Red drapes / banners (west walls)
    { type: "banner", x: 6, y: 22, w: 2, h: 6 }, // upperWest
    { type: "banner", x: 38, y: 22, w: 2, h: 6 }, // northCentral
    { type: "banner", x: 8, y: 60, w: 2, h: 6 }, // lowerWest

    // Cobwebs
    { type: "cobweb", x: 16, y: 4 },
    { type: "cobweb", x: 32, y: 4 },
    { type: "cobweb", x: 16, y: 12 },
    { type: "cobweb", x: 88, y: 24 },
    { type: "cobweb", x: 96, y: 24 },
    { type: "cobweb", x: 88, y: 32 },
    { type: "cobweb", x: 96, y: 32 },
    { type: "cobweb", x: 68, y: 60 },
    { type: "cobweb", x: 90, y: 60 },
    { type: "cobweb", x: 68, y: 72 },
    { type: "cobweb", x: 90, y: 72 },
    { type: "cobweb", x: 8, y: 56 },
    { type: "cobweb", x: 30, y: 56 },
    { type: "cobweb", x: 8, y: 66 },

    // Rugs in larger rooms
    { type: "rug", x: 46, y: 8, w: 8, h: 4 }, // vestibule
    { type: "rug", x: 44, y: 24, w: 12, h: 6 }, // northCentral
    { type: "rug", x: 42, y: 42, w: 16, h: 8 }, // hub
    { type: "rug", x: 12, y: 24, w: 10, h: 6 }, // upperWest
    { type: "rug", x: 74, y: 26, w: 10, h: 6 }, // upperEast
    { type: "rug", x: 42, y: 64, w: 16, h: 4 }, // gate chamber
    { type: "rug", x: 74, y: 64, w: 10, h: 6 }, // lowerEast

    // Furniture clutter (walkable silhouettes) — hub + wings
    { type: "furniture", x: 38, y: 38, w: 4, h: 2, facing: "s", style: 1 },
    { type: "furniture", x: 58, y: 38, w: 4, h: 2, facing: "s", style: 0 },
    { type: "furniture", x: 36, y: 48, w: 2, h: 4, facing: "e", style: 2 },
    { type: "furniture", x: 60, y: 48, w: 2, h: 4, facing: "w", style: 0 },
    { type: "furniture", x: 10, y: 18, w: 4, h: 2, facing: "s", style: 0 },
    { type: "furniture", x: 26, y: 30, w: 4, h: 2, facing: "n", style: 1 },
    { type: "furniture", x: 72, y: 20, w: 4, h: 2, facing: "s", style: 1 },
    { type: "furniture", x: 84, y: 32, w: 4, h: 2, facing: "n", style: 2 },
    { type: "furniture", x: 10, y: 42, w: 2, h: 4, facing: "e", style: 0 },
    { type: "furniture", x: 74, y: 72, w: 4, h: 2, facing: "n", style: 1 },
    { type: "furniture", x: 12, y: 64, w: 4, h: 2, facing: "n", style: 2 },
    { type: "furniture", x: 76, y: 44, w: 2, h: 4, facing: "e", style: 0 }
  ];

  /** Optional subtle traps (0–2). Empty = none on handcrafted L1. */
  const TRAPS = [];

  return {
    cols: COLS,
    rows: ROWS,
    rooms: ROOMS,
    connections: CONNECTIONS,
    start: START,
    exit: EXIT,
    decorations: DECORATIONS,
    traps: TRAPS,
    /** Soften hub corners toward octagon (wall cells inside room rect). */
    hubOctagon: true,
    hubName: "hub"
  };
})();
