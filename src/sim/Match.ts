// Deterministic authoritative match simulation. Inputs, pickups, projectiles,
// deployables, damage, and forced lag all advance only through tick().

import {
  PLAYER, MG, CHAIN_RADIUS, DEFAULT_ROUND_DURATION_MS, MAX_FORCED_LAG_MS,
  MIN_ROUND_DURATION_MS, MAX_ROUND_DURATION_MS,
  PICKUP_ACTIVE_COUNT, PICKUP_RADIUS, PICKUP_RESPAWN_MS,
} from "@shared/constants";
import { getMap, type MapDefinition } from "@shared/map";
import {
  PICKUP_WEAPONS, WEAPONS,
  type KillCause, type PickupWeaponKind, type PlayerInput, type WeaponKind,
} from "@shared/protocol";
import { mulberry32 } from "@shared/rng";
import {
  type Box, type Vec3, dist3, lookDir, movePlayer, playerBox, rayBox, rayWorld,
  safePlayerPosition, worldBoxes,
} from "./physics";

const IDLE_INPUT: PlayerInput = {
  seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
  jump: false, fire: false, reload: false,
};

type EntityKind =
  | "grenade" | "claymore" | "rocket" | "ricochet" | "cluster" | "bomblet"
  | "flame" | "homingMine" | "sticky" | "turret" | "plasma" | "teleport";

interface QueuedInput { applyAt: number; input: PlayerInput }

export interface SimPlayer {
  id: string;
  name: string;
  skin: number;
  pos: Vec3;
  vy: number;
  pushX: number;
  pushZ: number;
  yaw: number;
  pitch: number;
  moving: boolean;
  hp: number;
  alive: boolean;
  respawnAt: number;
  kills: number;
  deaths: number;
  weapon: WeaponKind;
  ammo: number;
  reloading: boolean;
  reloadEndsAt: number;
  lastFireAt: number;
  triggerPressed: boolean;
  cur: PlayerInput;
  queue: QueuedInput[];
  naturalRttMs: number;
}

export interface SimPickup {
  id: string;
  pad: number;
  kind: PickupWeaponKind;
  pos: Vec3;
}

export interface SimEntity {
  id: string;
  kind: EntityKind;
  ownerId: string;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  phase: string;
  createdAt: number;
  expiresAt: number;
  nextAt: number;
  bounces: number;
  targetId?: string;
  attachedTo?: string;
  offset?: Vec3;
}

export type SimEvent =
  | { type: "kill"; killerId: string; victimId: string; cause: KillCause }
  | { type: "explosion"; x: number; y: number; z: number; kind: KillCause }
  | {
      type: "shot"; id: string; kind: WeaponKind;
      ox: number; oy: number; oz: number; tx: number; ty: number; tz: number; hit: boolean;
    }
  | { type: "weaponFx"; kind: WeaponKind | "teleportFx"; x: number; y: number; z: number; tx?: number; ty?: number; tz?: number }
  | { type: "pickup"; playerId: string; kind: PickupWeaponKind }
  | { type: "hit"; shooterId: string; victimId: string; damage: number }
  | { type: "spawn"; id: string }
  | { type: "win"; id: string }
  | { type: "roundEnd"; winnerId: string }
  | { type: "roundStart"; roundNumber: number };

export class Match {
  timeMs = 0;
  forcedLagMs = 0;
  lagMode: "host" | "kills" = "host";
  lagPerKillMs = 50;
  lagCapMs = 0;
  players = new Map<string, SimPlayer>();
  pickups = new Map<string, SimPickup>();
  entities = new Map<string, SimEntity>();
  winnerId = "";
  roundPhase: "playing" | "ended" = "playing";
  roundDurationMs: number;
  roundEndsAt: number;
  roundNumber = 1;
  readonly map: MapDefinition;
  private events: SimEvent[] = [];
  private boxes: Box[];
  private rng: () => number;
  private nextId = 1;
  private pickupRespawns = new Map<number, number>();

  constructor(seed = 1234, roundDurationMs = DEFAULT_ROUND_DURATION_MS, mapId?: string) {
    this.rng = mulberry32(seed);
    this.map = getMap(mapId);
    this.boxes = worldBoxes(this.map.boxes);
    this.roundDurationMs = clampRoundDuration(roundDurationMs);
    this.roundEndsAt = this.roundDurationMs;
    this.fillPickupPads();
  }

  addPlayer(id: string, name: string, skin: number): SimPlayer {
    const spawn = this.pickSpawn();
    const p: SimPlayer = {
      id, name, skin,
      pos: { x: spawn.x, y: 0, z: spawn.z },
      vy: 0, pushX: 0, pushZ: 0,
      yaw: spawn.yaw, pitch: 0, moving: false,
      hp: PLAYER.hp, alive: true, respawnAt: 0,
      kills: 0, deaths: 0,
      weapon: "mg", ammo: MG.magSize, reloading: false, reloadEndsAt: 0,
      lastFireAt: -1e9, triggerPressed: false,
      cur: { ...IDLE_INPUT, yaw: spawn.yaw },
      queue: [],
      naturalRttMs: 0,
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    for (const [eid, e] of this.entities) {
      if (e.ownerId === id || e.attachedTo === id) this.entities.delete(eid);
    }
  }

  setForcedLag(ms: number): void {
    this.forcedLagMs = Math.max(0, Math.min(MAX_FORCED_LAG_MS, Math.round(ms)));
  }

  setKillLag(perKillMs: number, capMs = 0): void {
    this.lagMode = "kills";
    this.lagPerKillMs = sanitizeNonNegativeMs(perKillMs);
    this.lagCapMs = sanitizeNonNegativeMs(capMs);
  }

  getPlayerLagMs(id: string): number {
    if (this.lagMode === "host") return this.forcedLagMs;
    const lag = Math.min(
      Number.MAX_SAFE_INTEGER,
      (this.players.get(id)?.kills ?? 0) * this.lagPerKillMs,
    );
    return this.lagCapMs > 0 ? Math.min(lag, this.lagCapMs) : lag;
  }

  setPlayerRtt(id: string, rttMs: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.naturalRttMs = sanitizeNonNegativeMs(rttMs);
  }

  getPlayerArtificialLagMs(id: string): number {
    const targetLagMs = this.getPlayerLagMs(id);
    const naturalOneWayMs = (this.players.get(id)?.naturalRttMs ?? 0) / 2;
    return Math.max(0, Math.round(targetLagMs - naturalOneWayMs));
  }

  enqueueInput(id: string, input: PlayerInput): void {
    if (this.roundPhase !== "playing") return;
    const p = this.players.get(id);
    if (!p) return;
    const applyAt = this.timeMs + this.getPlayerArtificialLagMs(id);
    let i = p.queue.length;
    while (i > 0 && p.queue[i - 1].applyAt > applyAt) i--;
    p.queue.splice(i, 0, { applyAt, input });
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  tick(dtMs: number): void {
    this.timeMs += dtMs;
    if (this.roundPhase === "ended") return;
    const dt = dtMs / 1000;
    for (const p of this.players.values()) {
      this.applyDueInputs(p);
      this.stepPlayer(p, dt);
    }
    this.stepPickups();
    this.stepEntities(dt);
    this.stepRound();
  }

  get roundTimeLeftMs(): number {
    return this.roundPhase === "playing" ? Math.max(0, this.roundEndsAt - this.timeMs) : 0;
  }

  startRound(): void {
    this.roundNumber++;
    this.roundPhase = "playing";
    this.roundEndsAt = this.timeMs + this.roundDurationMs;
    this.winnerId = "";
    this.entities.clear();
    this.fillPickupPads();
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.queue = [];
      p.cur = { ...IDLE_INPUT, yaw: p.yaw };
      p.triggerPressed = false;
      this.equip(p, "mg");
      this.respawn(p);
    }
    this.events.push({ type: "roundStart", roundNumber: this.roundNumber });
  }

  private applyDueInputs(p: SimPlayer): void {
    while (p.queue.length > 0 && p.queue[0].applyAt <= this.timeMs) {
      const { input } = p.queue.shift()!;
      const prev = p.cur;
      p.cur = input;
      if (input.fire && !prev.fire) p.triggerPressed = true;
      if (input.reload && !prev.reload && p.alive && !this.winnerId) this.startReload(p);
    }
  }

  private stepPlayer(p: SimPlayer, dt: number): void {
    if (!p.alive) {
      p.triggerPressed = false;
      if (this.timeMs >= p.respawnAt) this.respawn(p);
      return;
    }

    const inp = p.cur;
    p.yaw = inp.yaw;
    p.pitch = inp.pitch;
    let mx = inp.moveX, mz = inp.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const dx = (mx * cos + mz * sin) * PLAYER.speed * dt + p.pushX * dt;
    const dz = (-mx * sin + mz * cos) * PLAYER.speed * dt + p.pushZ * dt;
    p.moving = len > 0.01;
    p.pushX *= Math.exp(-5 * dt);
    p.pushZ *= Math.exp(-5 * dt);

    p.vy -= PLAYER.gravity * dt;
    const { grounded, hitHead } = movePlayer(p.pos, dx, p.vy * dt, dz, this.boxes);
    if (grounded && p.vy <= 0) p.vy = 0;
    if (hitHead && p.vy > 0) p.vy = 0;
    if (grounded && inp.jump) p.vy = PLAYER.jumpVel;

    if (p.reloading && this.timeMs >= p.reloadEndsAt) {
      p.reloading = false;
      p.ammo = MG.magSize;
    }
    if (p.weapon === "mg" && p.ammo === 0 && !p.reloading) this.startReload(p);

    const def = WEAPONS[p.weapon];
    const wantsFire = def.automatic ? inp.fire : p.triggerPressed;
    if (wantsFire && !p.reloading && p.ammo > 0 && !this.winnerId) {
      if (def.automatic && this.timeMs - p.lastFireAt > def.cooldownMs * 2) {
        p.lastFireAt = this.timeMs - def.cooldownMs;
      }
      while (p.ammo > 0 && this.timeMs - p.lastFireAt >= def.cooldownMs) {
        p.lastFireAt += def.cooldownMs;
        p.ammo--;
        this.fireWeapon(p);
        if (!def.automatic) break;
      }
    }
    p.triggerPressed = false;
    if (p.weapon !== "mg" && p.ammo === 0) this.equip(p, "mg");
  }

  private fireWeapon(p: SimPlayer): void {
    switch (p.weapon) {
      case "mg": this.fireHitscan(p, "mg", MG.damage, MG.range, MG.spreadRad); break;
      case "grenade": this.spawnBallistic(p, "grenade", 17, 4.5, 2500); break;
      case "claymore": this.placeEntity(p, "claymore", 1.2, 1500); break;
      case "rocket": this.spawnProjectile(p, "rocket", 20, 5000); break;
      case "ricochet": this.spawnProjectile(p, "ricochet", 40, 3000); break;
      case "cluster": this.spawnProjectile(p, "cluster", 18, 4000); break;
      case "flamethrower": this.fireFlame(p); break;
      case "homingMine": this.placeEntity(p, "homingMine", 1.2, 1000); break;
      case "shock": this.fireShock(p); break;
      case "sticky": this.spawnProjectile(p, "sticky", 24, 5000); break;
      case "turret": this.placeEntity(p, "turret", 1.2, 1000); break;
      case "plasma": this.spawnProjectile(p, "plasma", 5, 6000); break;
      case "teleport": this.spawnBallistic(p, "teleport", 15, 4, 1500); break;
    }
  }

  private origin(p: SimPlayer): Vec3 {
    return { x: p.pos.x, y: p.pos.y + PLAYER.eyeHeight, z: p.pos.z };
  }

  private fireHitscan(p: SimPlayer, kind: WeaponKind, damage: number, range: number, spread = 0): SimPlayer | null {
    const origin = this.origin(p);
    let yaw = p.yaw, pitch = p.pitch;
    if (spread > 0) {
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * spread;
      yaw += Math.cos(a) * r;
      pitch += Math.sin(a) * r;
    }
    const dir = lookDir(yaw, pitch);
    const wallDist = rayWorld(origin, dir, this.boxes, range);
    let victim: SimPlayer | null = null;
    let victimDist = wallDist;
    for (const q of this.players.values()) {
      if (q.id === p.id || !q.alive) continue;
      const t = rayBox(origin, dir, playerBox(q.pos), victimDist);
      if (t !== null && t < victimDist) { victim = q; victimDist = t; }
    }
    const end = add(origin, scale(dir, victimDist));
    this.events.push({
      type: "shot", id: p.id, kind,
      ox: origin.x, oy: origin.y, oz: origin.z,
      tx: end.x, ty: end.y, tz: end.z, hit: victim !== null,
    });
    if (victim) this.damage(victim, damage, p.id, kind as KillCause);
    return victim;
  }

  private fireShock(p: SimPlayer): void {
    const victim = this.fireHitscan(p, "shock", 15, 24);
    if (!victim) return;
    const dir = lookDir(p.yaw, 0);
    victim.pushX += dir.x * 15;
    victim.pushZ += dir.z * 15;
    victim.vy = Math.max(victim.vy, 6);
  }

  private fireFlame(p: SimPlayer): void {
    const origin = this.origin(p);
    const dir = lookDir(p.yaw, p.pitch);
    const at = add(origin, scale(dir, 3.5));
    at.y = Math.max(0.05, Math.min(at.y, 1));
    this.createEntity("flame", p.id, at, zero(), p.yaw, "burning", 3000, 250);
    this.events.push({ type: "weaponFx", kind: "flamethrower", x: origin.x, y: origin.y, z: origin.z, tx: at.x, ty: at.y, tz: at.z });
    for (const q of this.players.values()) {
      if (!q.alive || q.id === p.id) continue;
      const to = sub({ x: q.pos.x, y: q.pos.y + 0.9, z: q.pos.z }, origin);
      const d = length(to);
      if (d <= 7 && dot(normalize(to), dir) > 0.82) this.damage(q, 10, p.id, "flamethrower");
    }
  }

  private spawnProjectile(p: SimPlayer, kind: EntityKind, speed: number, lifeMs: number): void {
    const origin = this.origin(p);
    const dir = lookDir(p.yaw, p.pitch);
    const e = this.createEntity(kind, p.id, add(origin, scale(dir, 0.7)), scale(dir, speed), p.yaw, "flying", lifeMs, 0);
    this.events.push({ type: "weaponFx", kind: kind as WeaponKind, x: origin.x, y: origin.y, z: origin.z, tx: e.pos.x, ty: e.pos.y, tz: e.pos.z });
  }

  private spawnBallistic(p: SimPlayer, kind: "grenade" | "teleport", speed: number, upward: number, fuseMs: number): void {
    const origin = this.origin(p);
    const dir = lookDir(p.yaw, p.pitch);
    this.createEntity(
      kind, p.id, add(origin, scale(dir, 0.6)),
      { x: dir.x * speed, y: dir.y * speed + upward, z: dir.z * speed },
      p.yaw, "flying", fuseMs, 0,
    );
  }

  private placeEntity(p: SimPlayer, kind: "claymore" | "homingMine" | "turret", distance: number, armMs: number): void {
    const dir = lookDir(p.yaw, 0);
    const pos = { x: p.pos.x + dir.x * distance, y: p.pos.y, z: p.pos.z + dir.z * distance };
    const lifeMs = kind === "turret" ? 20_000 : kind === "homingMine" ? 18_000 : 600_000;
    this.createEntity(kind, p.id, pos, zero(), p.yaw, "arming", lifeMs, armMs);
  }

  private createEntity(
    kind: EntityKind, ownerId: string, pos: Vec3, vel: Vec3, yaw: number,
    phase: string, lifeMs: number, nextDelay: number,
  ): SimEntity {
    const id = `e${this.nextId++}`;
    const e: SimEntity = {
      id, kind, ownerId, pos: { ...pos }, vel: { ...vel }, yaw, phase,
      createdAt: this.timeMs, expiresAt: this.timeMs + lifeMs,
      nextAt: this.timeMs + nextDelay, bounces: 0,
    };
    this.entities.set(id, e);
    return e;
  }

  private stepPickups(): void {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const pickup of [...this.pickups.values()]) {
        if (dist3(p.pos, pickup.pos) > PICKUP_RADIUS + PLAYER.radius) continue;
        this.equip(p, pickup.kind);
        this.pickups.delete(pickup.id);
        this.pickupRespawns.set(pickup.pad, this.timeMs + PICKUP_RESPAWN_MS);
        this.events.push({ type: "pickup", playerId: p.id, kind: pickup.kind });
        break;
      }
    }
    for (const [pad, at] of [...this.pickupRespawns]) {
      if (this.timeMs < at || this.pickups.size >= PICKUP_ACTIVE_COUNT) continue;
      const point = this.map.pickups[pad];
      const occupied = [...this.players.values()].some((p) => p.alive && dist3(p.pos, point) < 2);
      if (occupied) {
        this.pickupRespawns.set(pad, this.timeMs + 1000);
        continue;
      }
      this.spawnPickup(pad);
      this.pickupRespawns.delete(pad);
    }
  }

  private fillPickupPads(): void {
    this.pickups.clear();
    this.pickupRespawns.clear();
    const pads = this.map.pickups.map((_p, i) => i);
    shuffle(pads, this.rng);
    for (const pad of pads.slice(0, PICKUP_ACTIVE_COUNT)) this.spawnPickup(pad);
  }

  private spawnPickup(pad: number): void {
    const active = new Set([...this.pickups.values()].map((p) => p.kind));
    const available = PICKUP_WEAPONS.filter((kind) => !active.has(kind));
    const pool = available.length > 0 ? available : PICKUP_WEAPONS;
    const kind = pool[Math.floor(this.rng() * pool.length)];
    const point = this.map.pickups[pad];
    this.pickups.set(`p${pad}`, { id: `p${pad}`, pad, kind, pos: { ...point } });
  }

  private equip(p: SimPlayer, weapon: WeaponKind): void {
    p.weapon = weapon;
    p.ammo = weapon === "mg" ? MG.magSize : WEAPONS[weapon].ammo;
    p.reloading = false;
    p.lastFireAt = this.timeMs - WEAPONS[weapon].cooldownMs;
  }

  private startReload(p: SimPlayer): void {
    if (p.weapon !== "mg" || p.reloading || p.ammo === MG.magSize) return;
    p.reloading = true;
    p.reloadEndsAt = this.timeMs + MG.reloadMs;
  }

  private stepEntities(dt: number): void {
    for (const e of [...this.entities.values()]) {
      if (!this.entities.has(e.id)) continue;
      switch (e.kind) {
        case "grenade": this.stepGrenade(e, dt, false); break;
        case "teleport": this.stepGrenade(e, dt, true); break;
        case "claymore": this.stepClaymore(e); break;
        case "rocket": this.stepRocket(e, dt); break;
        case "ricochet": this.stepRicochet(e, dt); break;
        case "cluster": this.stepCluster(e, dt); break;
        case "bomblet": this.stepBomblet(e, dt); break;
        case "flame": this.stepFlame(e); break;
        case "homingMine": this.stepHomingMine(e, dt); break;
        case "sticky": this.stepSticky(e, dt); break;
        case "turret": this.stepTurret(e); break;
        case "plasma": this.stepPlasma(e, dt); break;
      }
    }
  }

  private stepGrenade(e: SimEntity, dt: number, teleport: boolean): void {
    if (this.timeMs >= e.expiresAt) {
      this.entities.delete(e.id);
      if (teleport) this.teleportOwner(e);
      else this.explode(e.pos, 5.5, 1, 95, e.ownerId, "grenade");
      return;
    }
    this.moveBouncing(e, dt, 18, 0.45, 0.7);
  }

  private stepClaymore(e: SimEntity): void {
    if (this.timeMs >= e.expiresAt) { this.entities.delete(e.id); return; }
    if (e.phase === "arming" && this.timeMs >= e.nextAt) e.phase = "armed";
    if (e.phase !== "armed") return;
    const target = this.nearestEnemy(e.ownerId, e.pos, 2.6);
    if (target) {
      this.entities.delete(e.id);
      this.explode(e.pos, 4.5, 3.2, 100, e.ownerId, "claymore");
    }
  }

  private stepRocket(e: SimEntity, dt: number): void {
    const hit = this.moveLinear(e, dt, 0.2);
    if (hit || this.timeMs >= e.expiresAt) {
      this.entities.delete(e.id);
      this.explode(e.pos, 4.5, 1, 100, e.ownerId, "rocket");
    }
  }

  private stepRicochet(e: SimEntity, dt: number): void {
    const victim = this.projectileVictim(e, dt);
    if (victim) {
      this.entities.delete(e.id);
      this.damage(victim, 28, e.ownerId, "ricochet");
      return;
    }
    const axis = this.movePoint(e, dt);
    if (axis) {
      e.vel[axis] *= -1;
      e.bounces++;
    }
    if (e.bounces > 4 || this.timeMs >= e.expiresAt) this.entities.delete(e.id);
  }

  private stepCluster(e: SimEntity, dt: number): void {
    if (this.moveLinear(e, dt, 0.2) || this.timeMs >= e.expiresAt) {
      this.entities.delete(e.id);
      for (let i = 0; i < 6; i++) {
        const angle = this.rng() * Math.PI * 2;
        const speed = 4 + this.rng() * 5;
        this.createEntity(
          "bomblet", e.ownerId, e.pos,
          { x: Math.cos(angle) * speed, y: 4 + this.rng() * 4, z: Math.sin(angle) * speed },
          angle, "flying", 800, 0,
        );
      }
    }
  }

  private stepBomblet(e: SimEntity, dt: number): void {
    if (this.timeMs >= e.expiresAt) {
      this.entities.delete(e.id);
      this.explode(e.pos, 2.4, 0.5, 45, e.ownerId, "cluster");
      return;
    }
    this.moveBouncing(e, dt, 18, 0.35, 0.72);
  }

  private stepFlame(e: SimEntity): void {
    if (this.timeMs >= e.expiresAt) { this.entities.delete(e.id); return; }
    if (this.timeMs < e.nextAt) return;
    e.nextAt += 250;
    for (const p of this.players.values()) {
      if (p.alive && p.id !== e.ownerId && dist3(p.pos, e.pos) <= 2.2) {
        this.damage(p, 8, e.ownerId, "flamethrower");
      }
    }
  }

  private stepHomingMine(e: SimEntity, dt: number): void {
    if (this.timeMs >= e.expiresAt) { this.entities.delete(e.id); return; }
    if (e.phase === "arming") {
      if (this.timeMs >= e.nextAt) e.phase = "armed";
      return;
    }
    const target = this.nearestEnemy(e.ownerId, e.pos, 30);
    if (!target) return;
    const d = sub(target.pos, e.pos);
    if (length(d) <= 1.3 + PLAYER.radius) {
      this.entities.delete(e.id);
      this.explode(e.pos, 4, 1.2, 100, e.ownerId, "homingMine");
      return;
    }
    const dir = normalize({ x: d.x, y: 0, z: d.z });
    e.vel = scale(dir, 3.2);
    this.movePoint(e, dt);
    e.yaw = Math.atan2(dir.x, dir.z);
  }

  private stepSticky(e: SimEntity, dt: number): void {
    if (e.phase === "flying") {
      const victim = this.projectileVictim(e, dt);
      if (victim) {
        e.phase = "stuck";
        e.attachedTo = victim.id;
        e.offset = sub(e.pos, victim.pos);
        e.vel = zero();
        e.expiresAt = this.timeMs + 3000;
      } else if (this.moveLinear(e, dt, 0.12)) {
        e.phase = "stuck";
        e.vel = zero();
        e.expiresAt = this.timeMs + 3000;
      }
    } else if (e.attachedTo) {
      const target = this.players.get(e.attachedTo);
      if (target?.alive) e.pos = add(target.pos, e.offset ?? zero());
    }
    if (this.timeMs >= e.expiresAt) {
      this.entities.delete(e.id);
      this.explode(e.pos, 4.5, 1.5, 100, e.ownerId, "sticky");
    }
  }

  private stepTurret(e: SimEntity): void {
    if (this.timeMs >= e.expiresAt) { this.entities.delete(e.id); return; }
    if (e.phase === "arming") {
      if (this.timeMs >= e.nextAt) { e.phase = "armed"; e.nextAt = this.timeMs; }
      return;
    }
    if (this.timeMs < e.nextAt) return;
    e.nextAt += 250;
    const target = this.nearestEnemy(e.ownerId, e.pos, 22);
    if (!target || !this.hasLineOfSight(e.pos, target)) return;
    const origin = { x: e.pos.x, y: e.pos.y + 0.7, z: e.pos.z };
    const center = { x: target.pos.x, y: target.pos.y + 0.9, z: target.pos.z };
    const dir = normalize(sub(center, origin));
    e.yaw = Math.atan2(dir.x, dir.z);
    this.events.push({
      type: "shot", id: e.ownerId, kind: "turret",
      ox: origin.x, oy: origin.y, oz: origin.z,
      tx: center.x, ty: center.y, tz: center.z, hit: true,
    });
    this.damage(target, 6, e.ownerId, "turret");
  }

  private stepPlasma(e: SimEntity, dt: number): void {
    if (this.timeMs >= e.nextAt) {
      e.nextAt += 250;
      for (const p of this.players.values()) {
        if (p.alive && p.id !== e.ownerId && dist3(p.pos, e.pos) <= 4.5) {
          this.damage(p, 8, e.ownerId, "plasma");
        }
      }
    }
    if (this.moveLinear(e, dt, 0.35) || this.timeMs >= e.expiresAt) {
      this.entities.delete(e.id);
      this.explode(e.pos, 7, 1.5, 90, e.ownerId, "plasma");
    }
  }

  private projectileVictim(e: SimEntity, dt: number): SimPlayer | null {
    const speed = length(e.vel);
    if (speed < 0.001) return null;
    const dir = scale(e.vel, 1 / speed);
    const maxDist = speed * dt;
    let victim: SimPlayer | null = null;
    let best = maxDist;
    for (const p of this.players.values()) {
      if (!p.alive || p.id === e.ownerId) continue;
      const t = rayBox(e.pos, dir, playerBox(p.pos), best);
      if (t !== null && t < best) { victim = p; best = t; }
    }
    if (victim) e.pos = add(e.pos, scale(dir, best));
    return victim;
  }

  private moveLinear(e: SimEntity, dt: number, radius: number): boolean {
    const victim = this.projectileVictim(e, dt);
    if (victim) {
      if (e.kind === "sticky") return false;
      return true;
    }
    const speed = length(e.vel);
    if (speed < 0.001) return false;
    const dir = scale(e.vel, 1 / speed);
    const travel = speed * dt;
    const wall = rayWorld(e.pos, dir, this.boxes, travel + radius);
    if (wall < travel + radius - 1e-6) {
      e.pos = add(e.pos, scale(dir, Math.max(0, wall - radius)));
      return true;
    }
    e.pos = add(e.pos, scale(e.vel, dt));
    return false;
  }

  private movePoint(e: SimEntity, dt: number): "x" | "y" | "z" | null {
    const old = { ...e.pos };
    const next = add(e.pos, scale(e.vel, dt));
    if (next.y <= 0) { e.pos = { x: next.x, y: 0, z: next.z }; return "y"; }
    const probe = 0.16;
    for (const b of this.boxes) {
      if (
        next.x >= b.minX - probe && next.x <= b.maxX + probe &&
        next.y >= b.minY - probe && next.y <= b.maxY + probe &&
        next.z >= b.minZ - probe && next.z <= b.maxZ + probe
      ) {
        e.pos = old;
        const dx = Math.min(Math.abs(old.x - b.minX), Math.abs(old.x - b.maxX));
        const dy = Math.min(Math.abs(old.y - b.minY), Math.abs(old.y - b.maxY));
        const dz = Math.min(Math.abs(old.z - b.minZ), Math.abs(old.z - b.maxZ));
        return dx <= dy && dx <= dz ? "x" : dy <= dz ? "y" : "z";
      }
    }
    e.pos = next;
    return null;
  }

  private moveBouncing(e: SimEntity, dt: number, gravity: number, restitution: number, friction: number): void {
    e.vel.y -= gravity * dt;
    const axis = this.movePoint(e, dt);
    if (!axis) return;
    e.vel[axis] *= -restitution;
    if (axis === "y") {
      e.vel.x *= friction;
      e.vel.z *= friction;
      if (Math.abs(e.vel.y) < 0.8) e.vel.y = 0;
    }
  }

  private explode(
    at: Vec3, radius: number, fullDamageRadius: number, maxDamage: number,
    ownerId: string, kind: KillCause,
  ): void {
    this.events.push({ type: "explosion", x: at.x, y: at.y, z: at.z, kind });
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const center = { x: p.pos.x, y: p.pos.y + PLAYER.height / 2, z: p.pos.z };
      const d = dist3(center, at);
      if (d > radius) continue;
      const damage = d <= fullDamageRadius
        ? maxDamage
        : Math.round(maxDamage * (1 - (d - fullDamageRadius) / (radius - fullDamageRadius)));
      if (damage > 0) this.damage(p, damage, ownerId, kind);
    }
    for (const e of [...this.entities.values()]) {
      if (dist3(e.pos, at) > CHAIN_RADIUS || !isExplosive(e.kind)) continue;
      if (e.kind === "claymore") {
        this.entities.delete(e.id);
        this.explode(e.pos, 4.5, 3.2, 100, e.ownerId, "claymore");
      } else {
        e.expiresAt = Math.min(e.expiresAt, this.timeMs + 150);
      }
    }
  }

  private teleportOwner(e: SimEntity): void {
    const owner = this.players.get(e.ownerId);
    if (!owner?.alive) return;
    const offsets = [
      { x: 0, z: 0 }, { x: 0.8, z: 0 }, { x: -0.8, z: 0 },
      { x: 0, z: 0.8 }, { x: 0, z: -0.8 },
      { x: 0.8, z: 0.8 }, { x: -0.8, z: -0.8 },
    ];
    for (const off of offsets) {
      const pos = { x: e.pos.x + off.x, y: Math.max(0, e.pos.y), z: e.pos.z + off.z };
      if (!safePlayerPosition(pos, this.boxes)) continue;
      owner.pos = pos;
      owner.vy = 0;
      this.events.push({ type: "weaponFx", kind: "teleportFx", x: pos.x, y: pos.y, z: pos.z });
      return;
    }
  }

  private nearestEnemy(ownerId: string, at: Vec3, range: number): SimPlayer | null {
    let best: SimPlayer | null = null;
    let bestDist = range;
    for (const p of this.players.values()) {
      if (!p.alive || p.id === ownerId) continue;
      const d = dist3(p.pos, at);
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return best;
  }

  private hasLineOfSight(at: Vec3, target: SimPlayer): boolean {
    const origin = { x: at.x, y: at.y + 0.7, z: at.z };
    const center = { x: target.pos.x, y: target.pos.y + 0.9, z: target.pos.z };
    const delta = sub(center, origin);
    const d = length(delta);
    return rayWorld(origin, normalize(delta), this.boxes, d) >= d - 0.05;
  }

  private damage(victim: SimPlayer, amount: number, attackerId: string, cause: KillCause): void {
    if (!victim.alive || this.roundPhase !== "playing") return;
    victim.hp -= amount;
    if (attackerId !== victim.id) {
      this.events.push({ type: "hit", shooterId: attackerId, victimId: victim.id, damage: amount });
    }
    if (victim.hp > 0) return;
    victim.hp = 0;
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = this.timeMs + PLAYER.respawnMs;
    this.events.push({ type: "kill", killerId: attackerId, victimId: victim.id, cause });
    const killer = this.players.get(attackerId);
    if (killer && attackerId !== victim.id) {
      killer.kills++;
    }
  }

  private respawn(p: SimPlayer): void {
    const spawn = this.pickSpawn();
    p.pos = { x: spawn.x, y: 0, z: spawn.z };
    p.vy = 0;
    p.pushX = 0;
    p.pushZ = 0;
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.hp = PLAYER.hp;
    p.alive = true;
    p.reloading = false;
    p.cur = { ...IDLE_INPUT, yaw: spawn.yaw };
    this.events.push({ type: "spawn", id: p.id });
  }

  private stepRound(): void {
    if (this.timeMs < this.roundEndsAt) return;
    this.roundPhase = "ended";
    this.winnerId = this.findWinnerId();
    for (const p of this.players.values()) {
      p.cur = { ...IDLE_INPUT, yaw: p.yaw };
      p.queue = [];
      p.moving = false;
      p.triggerPressed = false;
    }
    this.events.push({ type: "roundEnd", winnerId: this.winnerId });
  }

  private findWinnerId(): string {
    const ranked = [...this.players.values()].sort(
      (a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name),
    );
    if (ranked.length === 0) return "";
    if (
      ranked.length > 1 &&
      ranked[0].kills === ranked[1].kills &&
      ranked[0].deaths === ranked[1].deaths
    ) return "";
    return ranked[0].id;
  }

  private pickSpawn() {
    let best = this.map.spawns[Math.floor(this.rng() * this.map.spawns.length)];
    let bestScore = -1;
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (alive.length === 0) return best;
    for (const s of this.map.spawns) {
      let nearest = Infinity;
      for (const p of alive) nearest = Math.min(nearest, Math.hypot(p.pos.x - s.x, p.pos.z - s.z));
      if (nearest > bestScore) { bestScore = nearest; best = s; }
    }
    return best;
  }
}

function isExplosive(kind: EntityKind): boolean {
  return ["grenade", "claymore", "rocket", "cluster", "bomblet", "homingMine", "sticky", "plasma"].includes(kind);
}

function zero(): Vec3 { return { x: 0, y: 0, z: 0 } }
function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function scale(v: Vec3, n: number): Vec3 { return { x: v.x * n, y: v.y * n, z: v.z * n } }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function length(v: Vec3): number { return Math.hypot(v.x, v.y, v.z) }
function normalize(v: Vec3): Vec3 {
  const n = length(v);
  return n > 1e-9 ? scale(v, 1 / n) : zero();
}
function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function clampRoundDuration(ms: number): number {
  const value = Number.isFinite(ms) ? Math.round(ms) : DEFAULT_ROUND_DURATION_MS;
  return Math.max(MIN_ROUND_DURATION_MS, Math.min(MAX_ROUND_DURATION_MS, value));
}

function sanitizeNonNegativeMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(ms)));
}
