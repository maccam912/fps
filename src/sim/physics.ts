// Minimal deterministic AABB physics: enough for a blocky arena shooter,
// no physics engine needed. All units are meters; +Y is up.

import { MAP_BOXES } from "@shared/map";
import { PLAYER } from "@shared/constants";

export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface Vec3 { x: number; y: number; z: number }

export function worldBoxes(): Box[] {
  return MAP_BOXES.map((b) => ({
    minX: b.x - b.sx / 2, maxX: b.x + b.sx / 2,
    minY: b.y - b.sy / 2, maxY: b.y + b.sy / 2,
    minZ: b.z - b.sz / 2, maxZ: b.z + b.sz / 2,
  }));
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX &&
    a.minY < b.maxY && a.maxY > b.minY &&
    a.minZ < b.maxZ && a.maxZ > b.minZ
  );
}

// Player collision box from feet position.
export function playerBox(pos: Vec3): Box {
  const r = PLAYER.radius;
  return {
    minX: pos.x - r, maxX: pos.x + r,
    minY: pos.y, maxY: pos.y + PLAYER.height,
    minZ: pos.z - r, maxZ: pos.z + r,
  };
}

/**
 * Move a player's feet position by (dx, dy, dz) against the world.
 * Axis-separated: X, Z (with step-up onto low ledges), then Y.
 * Returns { grounded, hitHead }.
 */
export function movePlayer(
  pos: Vec3,
  dx: number,
  dy: number,
  dz: number,
  boxes: Box[],
): { grounded: boolean; hitHead: boolean } {
  const r = PLAYER.radius;

  const tryAxis = (axis: "x" | "z", d: number) => {
    if (d === 0) return;
    pos[axis] += d;
    const pb = playerBox(pos);
    for (const b of boxes) {
      if (!overlaps(pb, b)) continue;
      // Low ledge? step up instead of blocking (only when feet are near the top).
      const ledge = b.maxY - pos.y;
      if (ledge > 0 && ledge <= PLAYER.stepUp) {
        const stepped = { x: pos.x, y: b.maxY, z: pos.z };
        const sb = playerBox(stepped);
        if (!boxes.some((o) => overlaps(sb, o))) {
          pos.y = b.maxY;
          return tryAxis(axis, 0); // re-check remaining boxes at new height
        }
      }
      // Clamp against the face we came from.
      if (d > 0) pos[axis] = (axis === "x" ? b.minX : b.minZ) - r - 1e-4;
      else pos[axis] = (axis === "x" ? b.maxX : b.maxZ) + r + 1e-4;
      const pb2 = playerBox(pos);
      Object.assign(pb, pb2);
    }
  };

  tryAxis("x", dx);
  tryAxis("z", dz);

  // Vertical
  let grounded = false;
  let hitHead = false;
  pos.y += dy;
  if (pos.y <= 0) {
    pos.y = 0;
    grounded = true;
  }
  const pb = playerBox(pos);
  for (const b of boxes) {
    if (!overlaps(pb, b)) continue;
    if (dy <= 0) {
      // Landing on top: only if our feet were at/above the top before this move.
      const prevY = pos.y - dy;
      if (prevY >= b.maxY - 0.01) {
        pos.y = b.maxY;
        grounded = true;
        continue;
      }
    }
    if (dy > 0 && pos.y + PLAYER.height > b.minY && pos.y < b.minY) {
      pos.y = b.minY - PLAYER.height - 1e-4;
      hitHead = true;
    }
  }

  // Standing-on check when not moving vertically much
  if (!grounded) {
    const probe = playerBox({ x: pos.x, y: pos.y - 0.02, z: pos.z });
    grounded = pos.y <= 0.02 || boxes.some((b) => overlaps(probe, b) && pos.y >= b.maxY - 0.05);
  }

  return { grounded, hitHead };
}

/** Slab-method ray vs AABB. Returns hit distance or null. */
export function rayBox(o: Vec3, d: Vec3, b: Box, maxDist: number): number | null {
  let tmin = 0;
  let tmax = maxDist;
  const axes: ["x", "minX", "maxX"] | any = [
    ["x", b.minX, b.maxX],
    ["y", b.minY, b.maxY],
    ["z", b.minZ, b.maxZ],
  ];
  for (const [axis, lo, hi] of axes as [keyof Vec3, number, number][]) {
    const dir = d[axis];
    const orig = o[axis];
    if (Math.abs(dir) < 1e-9) {
      if (orig < lo || orig > hi) return null;
      continue;
    }
    let t1 = (lo - orig) / dir;
    let t2 = (hi - orig) / dir;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Nearest world geometry hit along a ray (also clips at the floor plane). */
export function rayWorld(o: Vec3, d: Vec3, boxes: Box[], maxDist: number): number {
  let best = maxDist;
  for (const b of boxes) {
    const t = rayBox(o, d, b, best);
    if (t !== null && t < best) best = t;
  }
  if (d.y < -1e-9) {
    const t = -o.y / d.y;
    if (t > 0 && t < best) best = t;
  }
  return best;
}

export function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Direction vector from yaw/pitch (yaw 0 = +Z forward, pitch up = positive). */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}
