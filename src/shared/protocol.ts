// Message names and payload shapes exchanged over Colyseus messages.

export interface PlayerInput {
  seq: number;
  moveX: number; // -1..1 strafe (right positive)
  moveZ: number; // -1..1 forward positive
  yaw: number; // radians, look direction at the time the input was made
  pitch: number;
  jump: boolean;
  fire: boolean;
  reload: boolean;
}

export const PICKUP_WEAPONS = [
  "grenade", "claymore", "rocket", "ricochet", "cluster", "flamethrower",
  "homingMine", "shock", "sticky", "turret", "plasma", "teleport",
] as const;
export type PickupWeaponKind = typeof PICKUP_WEAPONS[number];
export type WeaponKind = "mg" | PickupWeaponKind;

export interface WeaponDefinition {
  label: string;
  ammo: number;
  cooldownMs: number;
  automatic: boolean;
}

export const WEAPONS: Record<WeaponKind, WeaponDefinition> = {
  mg: { label: "Machine Gun", ammo: 50, cooldownMs: 80, automatic: true },
  grenade: { label: "Grenade Launcher", ammo: 3, cooldownMs: 500, automatic: false },
  claymore: { label: "Claymore Deployer", ammo: 2, cooldownMs: 700, automatic: false },
  rocket: { label: "Rocket Launcher", ammo: 4, cooldownMs: 700, automatic: false },
  ricochet: { label: "Ricochet Blaster", ammo: 18, cooldownMs: 180, automatic: true },
  cluster: { label: "Cluster Launcher", ammo: 3, cooldownMs: 900, automatic: false },
  flamethrower: { label: "Flamethrower", ammo: 60, cooldownMs: 100, automatic: true },
  homingMine: { label: "Homing Mine", ammo: 3, cooldownMs: 800, automatic: false },
  shock: { label: "Shock Cannon", ammo: 8, cooldownMs: 750, automatic: false },
  sticky: { label: "Sticky Bombs", ammo: 4, cooldownMs: 550, automatic: false },
  turret: { label: "Deployable Turret", ammo: 2, cooldownMs: 900, automatic: false },
  plasma: { label: "Plasma Orb", ammo: 2, cooldownMs: 1100, automatic: false },
  teleport: { label: "Teleport Grenade", ammo: 3, cooldownMs: 650, automatic: false },
};

export const MSG = {
  // client -> server
  input: "input",
  ping: "ping", // { t: clientTimeMs }
  rtt: "rtt", // { ms } measured round trip, stored for the scoreboard
  setLag: "setLag", // host only: { ms: 0..10000 }
  startRound: "startRound", // host only, resets scores and starts the configured timer

  // server -> client
  pong: "pong", // { t } echoed
  kill: "kill", // { killerId, killerName, victimId, victimName, cause }
  explosion: "explosion", // { x, y, z, kind: "grenade" | "claymore" }
  shot: "shot", // { id, ox,oy,oz, tx,ty,tz, hit } tracer line for effects
  weaponFx: "weaponFx",
  pickup: "pickup",
  hitConfirm: "hitConfirm", // { damage } you damaged someone (hitmarker)
} as const;

export type KillCause = Exclude<WeaponKind, "teleport">;

export interface KillMsg {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  cause: KillCause;
}

export interface ExplosionMsg { x: number; y: number; z: number; kind: KillCause }
export interface ShotMsg {
  id: string; kind: WeaponKind;
  ox: number; oy: number; oz: number; tx: number; ty: number; tz: number; hit: boolean;
}
export interface WeaponFxMsg {
  kind: WeaponKind | "teleportFx";
  x: number; y: number; z: number;
  tx?: number; ty?: number; tz?: number;
}
