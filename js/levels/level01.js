/**
 * Handcrafted Level 1 — matches maps/level-01.jpg topology.
 * Open rooms + short doorways; decorations are visual-only (non-blocking)
 * except corner pillars which are solid wall tiles.
 */
window.Level01 = (function () {
  const COLS = 50;
  const ROWS = 40;

  /**
   * Room rects (floor bounds). Gaps of ≥2 leave wall strips; connections carve doorways.
   * Order is used for ids; vestibule is start room, gate is exit room.
   */
  const ROOMS = [
    { name: "vestibule", x: 20, y: 2, w: 10, h: 6 }, // entrance top-center
    { name: "nw", x: 8, y: 2, w: 9, h: 5 },
    { name: "ne", x: 33, y: 2, w: 10, h: 6 },
    { name: "upperWest", x: 3, y: 9, w: 13, h: 8 },
    { name: "northCentral", x: 19, y: 10, w: 12, h: 6 },
    { name: "upperEast", x: 34, y: 10, w: 11, h: 8 },
    { name: "eastAlcove", x: 44, y: 12, w: 5, h: 5 },
    { name: "midWest", x: 3, y: 19, w: 12, h: 7 },
    { name: "hub", x: 18, y: 18, w: 14, h: 10 }, // central chamber
    { name: "midEast", x: 35, y: 20, w: 11, h: 8 },
    { name: "lowerWest", x: 4, y: 28, w: 12, h: 6 },
    { name: "gate", x: 18, y: 30, w: 14, h: 7 }, // exit chamber
    { name: "lowerEast", x: 34, y: 30, w: 12, h: 7 }
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
  const START = { x: 24, y: 2 };

  /** Locked gate / EXIT tile — bottom center of gate chamber. */
  const EXIT = { x: 24, y: 36 };

  /**
   * Static decorations from the art (walkable unless type==="pillar").
   * Banners / cobwebs / stairs / rugs / furniture are draw-only.
   */
  const DECORATIONS = [
    // Entrance stairs marker
    { type: "stairs", x: 23, y: 2, w: 4, h: 2, facing: "s" },
    // Gate approach stairs (visual only — EXIT is the door tile)
    { type: "stairs", x: 23, y: 34, w: 4, h: 2, facing: "s" },

    // Red drapes / banners (west walls)
    { type: "banner", x: 3, y: 11, w: 1, h: 3 }, // upperWest
    { type: "banner", x: 19, y: 11, w: 1, h: 3 }, // northCentral
    { type: "banner", x: 4, y: 30, w: 1, h: 3 }, // lowerWest

    // Cobwebs
    { type: "cobweb", x: 8, y: 2 },
    { type: "cobweb", x: 16, y: 2 },
    { type: "cobweb", x: 8, y: 6 },
    { type: "cobweb", x: 44, y: 12 },
    { type: "cobweb", x: 48, y: 12 },
    { type: "cobweb", x: 44, y: 16 },
    { type: "cobweb", x: 48, y: 16 },
    { type: "cobweb", x: 34, y: 30 },
    { type: "cobweb", x: 45, y: 30 },
    { type: "cobweb", x: 34, y: 36 },
    { type: "cobweb", x: 45, y: 36 },
    { type: "cobweb", x: 4, y: 28 },
    { type: "cobweb", x: 15, y: 28 },
    { type: "cobweb", x: 4, y: 33 },

    // Rugs in larger rooms
    { type: "rug", x: 23, y: 4, w: 4, h: 2 }, // vestibule
    { type: "rug", x: 22, y: 12, w: 6, h: 3 }, // northCentral
    { type: "rug", x: 21, y: 21, w: 8, h: 4 }, // hub
    { type: "rug", x: 6, y: 12, w: 5, h: 3 }, // upperWest
    { type: "rug", x: 37, y: 13, w: 5, h: 3 }, // upperEast
    { type: "rug", x: 21, y: 32, w: 8, h: 2 }, // gate chamber
    { type: "rug", x: 37, y: 32, w: 5, h: 3 }, // lowerEast

    // Furniture clutter (walkable silhouettes) — hub + wings
    { type: "furniture", x: 19, y: 19, w: 2, h: 1, facing: "s", style: 1 },
    { type: "furniture", x: 29, y: 19, w: 2, h: 1, facing: "s", style: 0 },
    { type: "furniture", x: 18, y: 24, w: 1, h: 2, facing: "e", style: 2 },
    { type: "furniture", x: 30, y: 24, w: 1, h: 2, facing: "w", style: 0 },
    { type: "furniture", x: 5, y: 9, w: 2, h: 1, facing: "s", style: 0 },
    { type: "furniture", x: 13, y: 15, w: 2, h: 1, facing: "n", style: 1 },
    { type: "furniture", x: 36, y: 10, w: 2, h: 1, facing: "s", style: 1 },
    { type: "furniture", x: 42, y: 16, w: 2, h: 1, facing: "n", style: 2 },
    { type: "furniture", x: 5, y: 21, w: 1, h: 2, facing: "e", style: 0 },
    { type: "furniture", x: 37, y: 36, w: 2, h: 1, facing: "n", style: 1 },
    { type: "furniture", x: 6, y: 32, w: 2, h: 1, facing: "n", style: 2 },
    { type: "furniture", x: 38, y: 22, w: 1, h: 2, facing: "e", style: 0 }
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
