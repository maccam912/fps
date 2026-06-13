// The arena: hand-authored axis-aligned boxes. The sim collides against these,
// the client renders matching meshes with Kenney prototype textures.

export interface MapBox {
  x: number; // center
  y: number; // center (boxes sit on the floor, so y = sy/2 for grounded boxes)
  z: number;
  sx: number; // full size
  sy: number;
  sz: number;
  tex: "a" | "b" | "c"; // prototype texture variation
}

export const ARENA_SIZE = 64; // playable square, walls just outside
export const WALL_HEIGHT = 6;

function grounded(x: number, z: number, sx: number, sy: number, sz: number, tex: MapBox["tex"]): MapBox {
  return { x, y: sy / 2, z, sx, sy, sz, tex };
}

const H = ARENA_SIZE / 2;

export const MAP_BOXES: MapBox[] = [
  // perimeter walls
  { x: 0, y: WALL_HEIGHT / 2, z: -H - 0.5, sx: ARENA_SIZE + 2, sy: WALL_HEIGHT, sz: 1, tex: "b" },
  { x: 0, y: WALL_HEIGHT / 2, z: H + 0.5, sx: ARENA_SIZE + 2, sy: WALL_HEIGHT, sz: 1, tex: "b" },
  { x: -H - 0.5, y: WALL_HEIGHT / 2, z: 0, sx: 1, sy: WALL_HEIGHT, sz: ARENA_SIZE + 2, tex: "b" },
  { x: H + 0.5, y: WALL_HEIGHT / 2, z: 0, sx: 1, sy: WALL_HEIGHT, sz: ARENA_SIZE + 2, tex: "b" },

  // central tower: three tiers you can hop up (1m steps via stepUp+jump)
  grounded(0, 0, 10, 1, 10, "c"),
  { x: 0, y: 1.5, z: 0, sx: 7, sy: 1, sz: 7, tex: "c" },
  { x: 0, y: 2.5, z: 0, sx: 4, sy: 1, sz: 4, tex: "a" },

  // stair blocks up the tower (south side)
  grounded(0, 7.0, 3, 0.5, 4, "c"),

  // four long cover walls, pinwheel layout
  grounded(-14, -6, 12, 2.2, 1.2, "b"),
  grounded(14, 6, 12, 2.2, 1.2, "b"),
  grounded(-6, 14, 1.2, 2.2, 12, "b"),
  grounded(6, -14, 1.2, 2.2, 12, "b"),

  // crate clusters (jump-on-able)
  grounded(-22, -22, 3, 1.5, 3, "a"),
  grounded(-19, -22, 1.8, 1, 1.8, "a"),
  grounded(22, 22, 3, 1.5, 3, "a"),
  grounded(19, 22, 1.8, 1, 1.8, "a"),
  grounded(-22, 22, 2.4, 1.2, 2.4, "a"),
  grounded(22, -22, 2.4, 1.2, 2.4, "a"),

  // corner columns
  grounded(-28, -28, 1.6, 4, 1.6, "c"),
  grounded(28, -28, 1.6, 4, 1.6, "c"),
  grounded(-28, 28, 1.6, 4, 1.6, "c"),
  grounded(28, 28, 1.6, 4, 1.6, "c"),

  // mid-edge bunkers
  grounded(0, -24, 8, 2.5, 1.4, "b"),
  grounded(0, 24, 8, 2.5, 1.4, "b"),
  grounded(-24, 0, 1.4, 2.5, 8, "b"),
  grounded(24, 0, 1.4, 2.5, 8, "b"),
];

export interface SpawnPoint { x: number; z: number; yaw: number }

// Spread around the arena, facing the center.
export const SPAWN_POINTS: SpawnPoint[] = [
  { x: -26, z: -26, yaw: Math.PI * 0.25 },
  { x: 26, z: -26, yaw: -Math.PI * 0.25 },
  { x: -26, z: 26, yaw: Math.PI * 0.75 },
  { x: 26, z: 26, yaw: -Math.PI * 0.75 },
  { x: 0, z: -28, yaw: 0 },
  { x: 0, z: 28, yaw: Math.PI },
  { x: -28, z: 0, yaw: Math.PI / 2 },
  { x: 28, z: 0, yaw: -Math.PI / 2 },
];

export interface PickupPoint { x: number; y: number; z: number }

// Open, reachable locations away from player spawns and narrow collision gaps.
export const PICKUP_POINTS: PickupPoint[] = [
  { x: -18, y: 0, z: -14 }, { x: 18, y: 0, z: 14 },
  { x: -14, y: 0, z: 18 }, { x: 14, y: 0, z: -18 },
  { x: -25, y: 0, z: -10 }, { x: 25, y: 0, z: 10 },
  { x: -10, y: 0, z: 25 }, { x: 10, y: 0, z: -25 },
  { x: -23, y: 0, z: 12 }, { x: 23, y: 0, z: -12 },
  { x: -12, y: 0, z: -23 }, { x: 12, y: 0, z: 23 },
];
