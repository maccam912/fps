// Shared, hand-authored arena definitions. The server uses these boxes for
// authoritative collision and the client renders the exact same geometry.

export interface MapBox {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  tex: "a" | "b" | "c";
}

export interface SpawnPoint { x: number; z: number; yaw: number }
export interface PickupPoint { x: number; y: number; z: number }

export interface MapDefinition {
  id: string;
  name: string;
  sizeLabel: "SMALL" | "MEDIUM" | "LARGE" | "HUGE";
  description: string;
  width: number;
  depth: number;
  boxes: MapBox[];
  spawns: SpawnPoint[];
  pickups: PickupPoint[];
}

export const WALL_HEIGHT = 6;

function grounded(
  x: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  tex: MapBox["tex"],
): MapBox {
  return { x, y: sy / 2, z, sx, sy, sz, tex };
}

function perimeter(width: number, depth: number): MapBox[] {
  const hx = width / 2;
  const hz = depth / 2;
  return [
    { x: 0, y: WALL_HEIGHT / 2, z: -hz - 0.5, sx: width + 2, sy: WALL_HEIGHT, sz: 1, tex: "b" },
    { x: 0, y: WALL_HEIGHT / 2, z: hz + 0.5, sx: width + 2, sy: WALL_HEIGHT, sz: 1, tex: "b" },
    { x: -hx - 0.5, y: WALL_HEIGHT / 2, z: 0, sx: 1, sy: WALL_HEIGHT, sz: depth + 2, tex: "b" },
    { x: hx + 0.5, y: WALL_HEIGHT / 2, z: 0, sx: 1, sy: WALL_HEIGHT, sz: depth + 2, tex: "b" },
  ];
}

function facingCenter(x: number, z: number): SpawnPoint {
  return { x, z, yaw: Math.atan2(-x, -z) };
}

const crossfire: MapDefinition = {
  id: "crossfire",
  name: "Crossfire",
  sizeLabel: "MEDIUM",
  description: "Balanced lanes, a climbable center tower, and cover in every quadrant.",
  width: 64,
  depth: 64,
  boxes: [
    ...perimeter(64, 64),
    grounded(0, 0, 10, 1, 10, "c"),
    { x: 0, y: 1.5, z: 0, sx: 7, sy: 1, sz: 7, tex: "c" },
    { x: 0, y: 2.5, z: 0, sx: 4, sy: 1, sz: 4, tex: "a" },
    grounded(0, 7, 3, 0.5, 4, "c"),
    grounded(-14, -6, 12, 2.2, 1.2, "b"),
    grounded(14, 6, 12, 2.2, 1.2, "b"),
    grounded(-6, 14, 1.2, 2.2, 12, "b"),
    grounded(6, -14, 1.2, 2.2, 12, "b"),
    grounded(-22, -22, 3, 1.5, 3, "a"),
    grounded(-19, -22, 1.8, 1, 1.8, "a"),
    grounded(22, 22, 3, 1.5, 3, "a"),
    grounded(19, 22, 1.8, 1, 1.8, "a"),
    grounded(-22, 22, 2.4, 1.2, 2.4, "a"),
    grounded(22, -22, 2.4, 1.2, 2.4, "a"),
    grounded(-28, -28, 1.6, 4, 1.6, "c"),
    grounded(28, -28, 1.6, 4, 1.6, "c"),
    grounded(-28, 28, 1.6, 4, 1.6, "c"),
    grounded(28, 28, 1.6, 4, 1.6, "c"),
    grounded(0, -24, 8, 2.5, 1.4, "b"),
    grounded(0, 24, 8, 2.5, 1.4, "b"),
    grounded(-24, 0, 1.4, 2.5, 8, "b"),
    grounded(24, 0, 1.4, 2.5, 8, "b"),
  ],
  spawns: [
    facingCenter(-26, -26), facingCenter(26, -26),
    facingCenter(-26, 26), facingCenter(26, 26),
    facingCenter(0, -28), facingCenter(0, 28),
    facingCenter(-28, 0), facingCenter(28, 0),
  ],
  pickups: [
    { x: -18, y: 0, z: -14 }, { x: 18, y: 0, z: 14 },
    { x: -14, y: 0, z: 18 }, { x: 14, y: 0, z: -18 },
    { x: -25, y: 0, z: -10 }, { x: 25, y: 0, z: 10 },
    { x: -10, y: 0, z: 25 }, { x: 10, y: 0, z: -25 },
    { x: -23, y: 0, z: 12 }, { x: 23, y: 0, z: -12 },
    { x: -12, y: 0, z: -23 }, { x: 12, y: 0, z: 23 },
  ],
};

const pit: MapDefinition = {
  id: "pit",
  name: "The Pit",
  sizeLabel: "SMALL",
  description: "A compact brawl with tight cover, short sightlines, and constant trouble.",
  width: 46,
  depth: 46,
  boxes: [
    ...perimeter(46, 46),
    grounded(0, 0, 8, 1.2, 8, "a"),
    grounded(-12, 0, 1.2, 2.6, 13, "b"),
    grounded(12, 0, 1.2, 2.6, 13, "b"),
    grounded(0, -12, 13, 2.6, 1.2, "b"),
    grounded(0, 12, 13, 2.6, 1.2, "b"),
    grounded(-15, -15, 3, 2, 3, "c"),
    grounded(15, -15, 3, 2, 3, "c"),
    grounded(-15, 15, 3, 2, 3, "c"),
    grounded(15, 15, 3, 2, 3, "c"),
    grounded(-6, -18, 5, 1, 2, "a"),
    grounded(18, -6, 2, 1, 5, "a"),
    grounded(6, 18, 5, 1, 2, "a"),
    grounded(-18, 6, 2, 1, 5, "a"),
  ],
  spawns: [
    facingCenter(-19, -19), facingCenter(19, -19),
    facingCenter(-19, 19), facingCenter(19, 19),
    facingCenter(0, -20), facingCenter(0, 20),
    facingCenter(-20, 0), facingCenter(20, 0),
  ],
  pickups: [
    { x: -7, y: 0, z: -7 }, { x: 7, y: 0, z: 7 },
    { x: -7, y: 0, z: 7 }, { x: 7, y: 0, z: -7 },
    { x: 0, y: 0, z: -18 }, { x: 18, y: 0, z: 0 },
    { x: 0, y: 0, z: 18 }, { x: -18, y: 0, z: 0 },
  ],
};

const switchyard: MapDefinition = {
  id: "switchyard",
  name: "Switchyard",
  sizeLabel: "LARGE",
  description: "Long rail-yard lanes broken by freight blocks and dangerous crossovers.",
  width: 88,
  depth: 64,
  boxes: [
    ...perimeter(88, 64),
    grounded(-25, -12, 24, 3, 4, "a"),
    grounded(4, -12, 18, 2.2, 4, "a"),
    grounded(28, -12, 12, 3.5, 4, "a"),
    grounded(-29, 12, 14, 3.5, 4, "c"),
    grounded(-7, 12, 20, 2.2, 4, "c"),
    grounded(23, 12, 25, 3, 4, "c"),
    grounded(-14, 0, 1.2, 2.5, 12, "b"),
    grounded(14, 0, 1.2, 2.5, 12, "b"),
    grounded(0, 0, 8, 1, 8, "b"),
    grounded(-39, -23, 3, 1.4, 3, "a"),
    grounded(39, 23, 3, 1.4, 3, "a"),
    grounded(-39, 23, 3, 1.4, 3, "a"),
    grounded(39, -23, 3, 1.4, 3, "a"),
  ],
  spawns: [
    facingCenter(-39, -26), facingCenter(39, -26),
    facingCenter(-39, 26), facingCenter(39, 26),
    facingCenter(-20, -27), facingCenter(20, 27),
    facingCenter(-41, 0), facingCenter(41, 0),
  ],
  pickups: [
    { x: -36, y: 0, z: 0 }, { x: 36, y: 0, z: 0 },
    { x: -20, y: 0, z: -22 }, { x: 20, y: 0, z: 22 },
    { x: -20, y: 0, z: 22 }, { x: 20, y: 0, z: -22 },
    { x: -2, y: 0, z: -22 }, { x: 2, y: 0, z: 22 },
    { x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 },
  ],
};

const citadel: MapDefinition = {
  id: "citadel",
  name: "Citadel",
  sizeLabel: "LARGE",
  description: "A broad fortress ring with four courtyards and a layered central keep.",
  width: 92,
  depth: 92,
  boxes: [
    ...perimeter(92, 92),
    grounded(0, 0, 18, 1, 18, "c"),
    { x: 0, y: 1.5, z: 0, sx: 12, sy: 2, sz: 12, tex: "c" },
    { x: 0, y: 3, z: 0, sx: 6, sy: 1, sz: 6, tex: "a" },
    grounded(0, 12, 4, 0.5, 6, "c"),
    grounded(-25, -25, 18, 3, 1.5, "b"),
    grounded(25, -25, 18, 3, 1.5, "b"),
    grounded(-25, 25, 18, 3, 1.5, "b"),
    grounded(25, 25, 18, 3, 1.5, "b"),
    grounded(-25, -25, 1.5, 3, 18, "b"),
    grounded(25, -25, 1.5, 3, 18, "b"),
    grounded(-25, 25, 1.5, 3, 18, "b"),
    grounded(25, 25, 1.5, 3, 18, "b"),
    grounded(0, -34, 14, 2.4, 1.4, "a"),
    grounded(0, 34, 14, 2.4, 1.4, "a"),
    grounded(-34, 0, 1.4, 2.4, 14, "a"),
    grounded(34, 0, 1.4, 2.4, 14, "a"),
    grounded(-39, -39, 4, 4, 4, "c"),
    grounded(39, -39, 4, 4, 4, "c"),
    grounded(-39, 39, 4, 4, 4, "c"),
    grounded(39, 39, 4, 4, 4, "c"),
  ],
  spawns: [
    facingCenter(-40, -32), facingCenter(40, -32),
    facingCenter(-40, 32), facingCenter(40, 32),
    facingCenter(0, -41), facingCenter(0, 41),
    facingCenter(-41, 0), facingCenter(41, 0),
    facingCenter(-17, -38), facingCenter(17, 38),
  ],
  pickups: [
    { x: -34, y: 0, z: -16 }, { x: 34, y: 0, z: 16 },
    { x: -34, y: 0, z: 16 }, { x: 34, y: 0, z: -16 },
    { x: -16, y: 0, z: -34 }, { x: 16, y: 0, z: 34 },
    { x: 16, y: 0, z: -34 }, { x: -16, y: 0, z: 34 },
    { x: -13, y: 0, z: 0 }, { x: 13, y: 0, z: 0 },
    { x: 0, y: 0, z: -13 }, { x: 0, y: 0, z: 18 },
  ],
};

const maze: MapDefinition = {
  id: "maze",
  name: "Neon Maze",
  sizeLabel: "LARGE",
  description: "Dense offset corridors, ambush corners, and almost no clean sightline.",
  width: 84,
  depth: 76,
  boxes: [
    ...perimeter(84, 76),
    grounded(-25, -20, 22, 2.8, 1.2, "b"),
    grounded(10, -20, 28, 2.8, 1.2, "b"),
    grounded(29, -8, 1.2, 2.8, 25, "b"),
    grounded(20, 10, 18, 2.8, 1.2, "c"),
    grounded(-15, 10, 30, 2.8, 1.2, "c"),
    grounded(-31, 22, 1.2, 2.8, 22, "c"),
    grounded(-10, 27, 24, 2.8, 1.2, "b"),
    grounded(24, 27, 18, 2.8, 1.2, "b"),
    grounded(-13, -5, 1.2, 2.8, 20, "a"),
    grounded(9, 2, 1.2, 2.8, 18, "a"),
    grounded(-34, -4, 14, 2.8, 1.2, "a"),
    grounded(35, 17, 1.2, 2.8, 17, "a"),
    grounded(-4, -31, 1.2, 2.8, 11, "c"),
    grounded(12, 34, 1.2, 2.8, 7, "c"),
    grounded(-4, 2, 5, 1.2, 5, "a"),
  ],
  spawns: [
    facingCenter(-37, -32), facingCenter(37, -32),
    facingCenter(-37, 32), facingCenter(37, 32),
    facingCenter(0, -34), facingCenter(0, 34),
    facingCenter(-38, 10), facingCenter(38, -10),
  ],
  pickups: [
    { x: -34, y: 0, z: -12 }, { x: 34, y: 0, z: 8 },
    { x: -22, y: 0, z: -29 }, { x: 22, y: 0, z: 34 },
    { x: -22, y: 0, z: 19 }, { x: 19, y: 0, z: -10 },
    { x: -3, y: 0, z: 17 }, { x: 3, y: 0, z: -12 },
    { x: -37, y: 0, z: 29 }, { x: 37, y: 0, z: -29 },
  ],
};

const megacomplex: MapDefinition = {
  id: "megacomplex",
  name: "Megacomplex",
  sizeLabel: "HUGE",
  description: "A sprawling combat district with plazas, lanes, bunkers, and room to roam.",
  width: 124,
  depth: 104,
  boxes: [
    ...perimeter(124, 104),
    grounded(0, 0, 16, 1, 16, "c"),
    { x: 0, y: 1.5, z: 0, sx: 10, sy: 2, sz: 10, tex: "c" },
    grounded(-35, -27, 24, 3, 1.5, "b"),
    grounded(35, -27, 24, 3, 1.5, "b"),
    grounded(-35, 27, 24, 3, 1.5, "b"),
    grounded(35, 27, 24, 3, 1.5, "b"),
    grounded(-44, 0, 1.5, 3, 24, "b"),
    grounded(44, 0, 1.5, 3, 24, "b"),
    grounded(-20, -40, 14, 2, 4, "a"),
    grounded(20, -40, 14, 2, 4, "a"),
    grounded(-20, 40, 14, 2, 4, "a"),
    grounded(20, 40, 14, 2, 4, "a"),
    grounded(-54, -38, 4, 4, 4, "c"),
    grounded(54, -38, 4, 4, 4, "c"),
    grounded(-54, 38, 4, 4, 4, "c"),
    grounded(54, 38, 4, 4, 4, "c"),
    grounded(-26, 0, 10, 2.5, 1.4, "a"),
    grounded(26, 0, 10, 2.5, 1.4, "a"),
    grounded(0, -25, 1.4, 2.5, 10, "a"),
    grounded(0, 25, 1.4, 2.5, 10, "a"),
    grounded(-52, -10, 8, 1.2, 4, "c"),
    grounded(52, 10, 8, 1.2, 4, "c"),
    grounded(-10, 46, 4, 1.2, 8, "c"),
    grounded(10, -46, 4, 1.2, 8, "c"),
  ],
  spawns: [
    facingCenter(-56, -45), facingCenter(56, -45),
    facingCenter(-56, 45), facingCenter(56, 45),
    facingCenter(0, -47), facingCenter(0, 47),
    facingCenter(-57, 18), facingCenter(57, -18),
    facingCenter(-30, -46), facingCenter(30, -46),
    facingCenter(-30, 46), facingCenter(30, 46),
  ],
  pickups: [
    { x: -50, y: 0, z: -22 }, { x: 50, y: 0, z: 22 },
    { x: -50, y: 0, z: 22 }, { x: 50, y: 0, z: -22 },
    { x: -28, y: 0, z: -38 }, { x: 28, y: 0, z: 38 },
    { x: 28, y: 0, z: -38 }, { x: -28, y: 0, z: 38 },
    { x: -18, y: 0, z: -14 }, { x: 18, y: 0, z: 14 },
    { x: -18, y: 0, z: 14 }, { x: 18, y: 0, z: -14 },
    { x: 0, y: 0, z: -35 }, { x: 0, y: 0, z: 35 },
    { x: -38, y: 0, z: 0 }, { x: 38, y: 0, z: 0 },
  ],
};

export const MAPS = [
  crossfire,
  pit,
  switchyard,
  citadel,
  maze,
  megacomplex,
] as const;

export type MapId = (typeof MAPS)[number]["id"];
export const DEFAULT_MAP_ID: MapId = "crossfire";

export function getMap(id: unknown): MapDefinition {
  return MAPS.find((map) => map.id === id) ?? crossfire;
}

export function selectMapId(requested: unknown, random: () => number = Math.random): MapId {
  if (requested !== "random" && MAPS.some((map) => map.id === requested)) {
    return requested as MapId;
  }
  return MAPS[Math.floor(random() * MAPS.length)]!.id;
}
