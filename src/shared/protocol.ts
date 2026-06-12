// Message names and payload shapes exchanged over Colyseus messages.

export interface PlayerInput {
  seq: number;
  moveX: number; // -1..1 strafe (right positive)
  moveZ: number; // -1..1 forward positive
  yaw: number; // radians, look direction at the time the input was made
  pitch: number;
  jump: boolean;
  fire: boolean;
  throwGrenade: boolean; // edge-triggered in the sim
  placeClaymore: boolean; // edge-triggered in the sim
  reload: boolean;
}

export const MSG = {
  // client -> server
  input: "input",
  ping: "ping", // { t: clientTimeMs }
  rtt: "rtt", // { ms } measured round trip, stored for the scoreboard
  setLag: "setLag", // host only: { ms: 0..10000 }

  // server -> client
  pong: "pong", // { t } echoed
  kill: "kill", // { killerId, killerName, victimId, victimName, cause }
  explosion: "explosion", // { x, y, z, kind: "grenade" | "claymore" }
  shot: "shot", // { id, ox,oy,oz, tx,ty,tz, hit } tracer line for effects
  hitConfirm: "hitConfirm", // { damage } you damaged someone (hitmarker)
} as const;

export type KillCause = "mg" | "grenade" | "claymore";

export interface KillMsg {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  cause: KillCause;
}

export interface ExplosionMsg { x: number; y: number; z: number; kind: "grenade" | "claymore" }
export interface ShotMsg { id: string; ox: number; oy: number; oz: number; tx: number; ty: number; tz: number; hit: boolean }
