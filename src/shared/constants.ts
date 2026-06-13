// Tuning for the whole game. The sim, server and client all read from here.

export const TICK_RATE = 30; // server sim ticks per second
export const TICK_MS = 1000 / TICK_RATE;
export const PATCH_MS = 50; // colyseus state patch interval

export const MAX_FORCED_LAG_MS = 10_000;

export const PLAYER = {
  hp: 100,
  speed: 6.5, // m/s
  radius: 0.45, // half-width of collision box
  height: 1.8,
  eyeHeight: 1.55,
  jumpVel: 8,
  gravity: 22,
  stepUp: 0.55, // auto-climb ledges up to this height (stairs)
  respawnMs: 3000,
} as const;

export const MG = {
  fireIntervalMs: 80, // 12.5 rounds/sec — hold and hose
  damage: 9,
  spreadRad: 0.055, // wild cone, perfect for area denial under lag
  range: 80,
  magSize: 50,
  reloadMs: 1600,
} as const;

export const PICKUP_ACTIVE_COUNT = 4;
export const PICKUP_RESPAWN_MS = 12_000;
export const PICKUP_RADIUS = 1.1;

// Explosions sympathetically detonate other explosives within this range.
export const CHAIN_RADIUS = 3.0;

export const DEFAULT_ROUND_DURATION_MS = 5 * 60_000;
export const MIN_ROUND_DURATION_MS = 60_000;
export const MAX_ROUND_DURATION_MS = 60 * 60_000;

export const SKIN_COUNT = 8; // character-a .. character-h

export const ROOM_NAME = "ffa";
