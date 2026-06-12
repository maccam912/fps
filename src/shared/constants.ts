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

export const GRENADE = {
  throwSpeed: 17,
  throwUpward: 4.5, // extra vertical kick
  fuseMs: 2500,
  radius: 0.18, // physical size
  blastRadius: 5.5,
  fullDamageRadius: 1.0, // direct hits devastate
  maxDamage: 95,
  restitution: 0.45,
  friction: 0.7, // horizontal damping per bounce
  gravity: 18,
  maxCarried: 3,
  restockMs: 6000, // regain one every N ms
} as const;

export const CLAYMORE = {
  armMs: 1500,
  triggerRadius: 2.6,
  blastRadius: 4.5,
  fullDamageRadius: 3.2, // anyone who trips it dies
  damage: 100,
  placeDistance: 1.2,
  maxCarried: 2,
  restockMs: 10_000,
} as const;

// Explosions sympathetically detonate other explosives within this range.
export const CHAIN_RADIUS = 3.0;

export const KILL_TARGET = 15; // first to N kills wins the round
export const ROUND_RESET_MS = 6000; // victory banner time before scores reset

export const SKIN_COUNT = 8; // character-a .. character-h

export const ROOM_NAME = "ffa";
