// The whole game, headless and deterministic. No Colyseus, no Babylon — a full
// match can be played in a unit test by calling tick() in a loop.
//
// THE LAG MACHINE: every input is queued with applyAt = now + forcedLagMs and
// only touches the world once sim time passes that stamp. Relative timing
// between a player's inputs is preserved, so at 10s of forced lag your whole
// performance plays back faithfully — ten seconds too late.

import {
  PLAYER, MG, GRENADE, CLAYMORE, CHAIN_RADIUS,
  KILL_TARGET, ROUND_RESET_MS, MAX_FORCED_LAG_MS,
} from "@shared/constants";
import { SPAWN_POINTS } from "@shared/map";
import type { PlayerInput } from "@shared/protocol";
import type { KillCause } from "@shared/protocol";
import { mulberry32 } from "@shared/rng";
import {
  Box, Vec3, worldBoxes, movePlayer, playerBox, rayBox, rayWorld, dist3, lookDir,
} from "./physics";

const IDLE_INPUT: PlayerInput = {
  seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
  jump: false, fire: false, throwGrenade: false, placeClaymore: false, reload: false,
};

interface QueuedInput { applyAt: number; input: PlayerInput }

export interface SimPlayer {
  id: string;
  name: string;
  skin: number;
  pos: Vec3;
  vy: number;
  yaw: number;
  pitch: number;
  moving: boolean;
  hp: number;
  alive: boolean;
  respawnAt: number;
  kills: number;
  deaths: number;
  ammo: number;
  reloading: boolean;
  reloadEndsAt: number;
  lastFireAt: number;
  grenades: number;
  grenadeRestockAt: number;
  claymores: number;
  claymoreRestockAt: number;
  cur: PlayerInput;
  queue: QueuedInput[];
}

export interface SimGrenade { id: string; ownerId: string; pos: Vec3; vel: Vec3; explodeAt: number }
export interface SimClaymore { id: string; ownerId: string; pos: Vec3; yaw: number; armsAt: number; armed: boolean }

export type SimEvent =
  | { type: "kill"; killerId: string; victimId: string; cause: KillCause }
  | { type: "explosion"; x: number; y: number; z: number; kind: "grenade" | "claymore" }
  | { type: "shot"; id: string; ox: number; oy: number; oz: number; tx: number; ty: number; tz: number; hit: boolean }
  | { type: "hit"; shooterId: string; victimId: string; damage: number }
  | { type: "spawn"; id: string }
  | { type: "win"; id: string }
  | { type: "roundReset" };

export class Match {
  timeMs = 0;
  forcedLagMs = 0;
  players = new Map<string, SimPlayer>();
  grenades = new Map<string, SimGrenade>();
  claymores = new Map<string, SimClaymore>();
  winnerId = "";
  private roundResetAt = 0;
  private events: SimEvent[] = [];
  private boxes: Box[] = worldBoxes();
  private rng: () => number;
  private nextId = 1;

  constructor(seed = 1234) {
    this.rng = mulberry32(seed);
  }

  // ---- lifecycle -----------------------------------------------------------

  addPlayer(id: string, name: string, skin: number): SimPlayer {
    const spawn = this.pickSpawn();
    const p: SimPlayer = {
      id, name, skin,
      pos: { x: spawn.x, y: 0, z: spawn.z },
      vy: 0, yaw: spawn.yaw, pitch: 0, moving: false,
      hp: PLAYER.hp, alive: true, respawnAt: 0,
      kills: 0, deaths: 0,
      ammo: MG.magSize, reloading: false, reloadEndsAt: 0, lastFireAt: -1e9,
      grenades: GRENADE.maxCarried, grenadeRestockAt: 0,
      claymores: CLAYMORE.maxCarried, claymoreRestockAt: 0,
      cur: { ...IDLE_INPUT, yaw: spawn.yaw },
      queue: [],
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    for (const [cid, c] of this.claymores) if (c.ownerId === id) this.claymores.delete(cid);
  }

  setForcedLag(ms: number): void {
    this.forcedLagMs = Math.max(0, Math.min(MAX_FORCED_LAG_MS, Math.round(ms)));
  }

  /** Queue an input; it takes effect forcedLagMs of sim time from now. */
  enqueueInput(id: string, input: PlayerInput): void {
    const p = this.players.get(id);
    if (!p) return;
    const applyAt = this.timeMs + this.forcedLagMs;
    // Keep the queue sorted even if the host lowers the lag mid-flight.
    let i = p.queue.length;
    while (i > 0 && p.queue[i - 1].applyAt > applyAt) i--;
    p.queue.splice(i, 0, { applyAt, input });
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ---- main loop -----------------------------------------------------------

  tick(dtMs: number): void {
    this.timeMs += dtMs;
    const dt = dtMs / 1000;

    for (const p of this.players.values()) {
      this.applyDueInputs(p);
      this.stepPlayer(p, dt);
    }
    this.stepGrenades(dt);
    this.stepClaymores();
    this.stepRound();
  }

  private applyDueInputs(p: SimPlayer): void {
    while (p.queue.length > 0 && p.queue[0].applyAt <= this.timeMs) {
      const { input } = p.queue.shift()!;
      const prev = p.cur;
      p.cur = input;
      if (!p.alive || this.winnerId) continue;
      // Edge-triggered actions fire at the moment of application.
      if (input.throwGrenade && !prev.throwGrenade) this.throwGrenade(p, input);
      if (input.placeClaymore && !prev.placeClaymore) this.placeClaymore(p, input);
      if (input.reload && !prev.reload) this.startReload(p);
    }
  }

  private stepPlayer(p: SimPlayer, dt: number): void {
    // Respawn
    if (!p.alive) {
      if (this.timeMs >= p.respawnAt) this.respawn(p);
      else return;
    }

    const inp = p.cur;
    p.yaw = inp.yaw;
    p.pitch = inp.pitch;

    // Horizontal movement in look-yaw space
    let mx = inp.moveX, mz = inp.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const dx = (mx * cos + mz * sin) * PLAYER.speed * dt;
    const dz = (-mx * sin + mz * cos) * PLAYER.speed * dt;
    p.moving = len > 0.01;

    p.vy -= PLAYER.gravity * dt;
    const { grounded, hitHead } = movePlayer(p.pos, dx, p.vy * dt, dz, this.boxes);
    if (grounded && p.vy <= 0) p.vy = 0;
    if (hitHead && p.vy > 0) p.vy = 0;
    if (grounded && inp.jump) p.vy = PLAYER.jumpVel;

    // Reload completion
    if (p.reloading && this.timeMs >= p.reloadEndsAt) {
      p.reloading = false;
      p.ammo = MG.magSize;
    }
    // Auto-reload on empty
    if (p.ammo === 0 && !p.reloading) this.startReload(p);

    // Restocks
    if (p.grenades < GRENADE.maxCarried && this.timeMs >= p.grenadeRestockAt) {
      p.grenades++;
      p.grenadeRestockAt = this.timeMs + GRENADE.restockMs;
    }
    if (p.claymores < CLAYMORE.maxCarried && this.timeMs >= p.claymoreRestockAt) {
      p.claymores++;
      p.claymoreRestockAt = this.timeMs + CLAYMORE.restockMs;
    }

    // Full-auto fire. Catch-up loop so the true rate survives tick quantization.
    if (inp.fire && !p.reloading && p.ammo > 0 && !this.winnerId) {
      if (this.timeMs - p.lastFireAt > MG.fireIntervalMs * 2) {
        p.lastFireAt = this.timeMs - MG.fireIntervalMs; // fresh trigger pull
      }
      while (p.ammo > 0 && this.timeMs - p.lastFireAt >= MG.fireIntervalMs) {
        p.lastFireAt += MG.fireIntervalMs;
        p.ammo--;
        this.fireShot(p);
      }
    }
  }

  private fireShot(p: SimPlayer): void {
    const origin: Vec3 = { x: p.pos.x, y: p.pos.y + PLAYER.eyeHeight, z: p.pos.z };
    // Wild spray: random offset inside a cone
    const a = this.rng() * Math.PI * 2;
    const r = this.rng() * MG.spreadRad;
    const dir = lookDir(p.yaw + Math.cos(a) * r, p.pitch + Math.sin(a) * r);

    const wallDist = rayWorld(origin, dir, this.boxes, MG.range);
    let victim: SimPlayer | null = null;
    let victimDist = wallDist;
    for (const q of this.players.values()) {
      if (q.id === p.id || !q.alive) continue;
      const t = rayBox(origin, dir, playerBox(q.pos), victimDist);
      if (t !== null && t < victimDist) {
        victim = q;
        victimDist = t;
      }
    }

    const end = {
      x: origin.x + dir.x * victimDist,
      y: origin.y + dir.y * victimDist,
      z: origin.z + dir.z * victimDist,
    };
    this.events.push({
      type: "shot", id: p.id,
      ox: origin.x, oy: origin.y, oz: origin.z,
      tx: end.x, ty: end.y, tz: end.z, hit: victim !== null,
    });

    if (victim) this.damage(victim, MG.damage, p.id, "mg");
  }

  private startReload(p: SimPlayer): void {
    if (p.reloading || p.ammo === MG.magSize) return;
    p.reloading = true;
    p.reloadEndsAt = this.timeMs + MG.reloadMs;
  }

  private throwGrenade(p: SimPlayer, inp: PlayerInput): void {
    if (p.grenades <= 0) return;
    if (p.grenades === GRENADE.maxCarried) p.grenadeRestockAt = this.timeMs + GRENADE.restockMs;
    p.grenades--;
    const dir = lookDir(inp.yaw, inp.pitch);
    const id = `g${this.nextId++}`;
    this.grenades.set(id, {
      id, ownerId: p.id,
      pos: { x: p.pos.x + dir.x * 0.6, y: p.pos.y + PLAYER.eyeHeight - 0.1, z: p.pos.z + dir.z * 0.6 },
      vel: {
        x: dir.x * GRENADE.throwSpeed,
        y: dir.y * GRENADE.throwSpeed + GRENADE.throwUpward,
        z: dir.z * GRENADE.throwSpeed,
      },
      explodeAt: this.timeMs + GRENADE.fuseMs,
    });
  }

  private placeClaymore(p: SimPlayer, inp: PlayerInput): void {
    if (p.claymores <= 0) return;
    if (p.claymores === CLAYMORE.maxCarried) p.claymoreRestockAt = this.timeMs + CLAYMORE.restockMs;
    p.claymores--;
    const dir = lookDir(inp.yaw, 0);
    const id = `c${this.nextId++}`;
    this.claymores.set(id, {
      id, ownerId: p.id,
      pos: { x: p.pos.x + dir.x * CLAYMORE.placeDistance, y: p.pos.y, z: p.pos.z + dir.z * CLAYMORE.placeDistance },
      yaw: inp.yaw,
      armsAt: this.timeMs + CLAYMORE.armMs,
      armed: false,
    });
  }

  private stepGrenades(dt: number): void {
    for (const g of [...this.grenades.values()]) {
      if (this.timeMs >= g.explodeAt) {
        this.grenades.delete(g.id);
        this.explode(g.pos, GRENADE.blastRadius, GRENADE.fullDamageRadius, GRENADE.maxDamage, g.ownerId, "grenade");
        continue;
      }
      g.vel.y -= GRENADE.gravity * dt;
      const next = {
        x: g.pos.x + g.vel.x * dt,
        y: g.pos.y + g.vel.y * dt,
        z: g.pos.z + g.vel.z * dt,
      };
      // Bounce: test each axis against world boxes + floor
      const R = GRENADE.radius;
      const gb: Box = {
        minX: next.x - R, maxX: next.x + R,
        minY: next.y - R, maxY: next.y + R,
        minZ: next.z - R, maxZ: next.z + R,
      };
      let bounced = false;
      if (next.y - R <= 0) {
        next.y = R;
        g.vel.y = -g.vel.y * GRENADE.restitution;
        g.vel.x *= GRENADE.friction;
        g.vel.z *= GRENADE.friction;
        if (Math.abs(g.vel.y) < 0.8) g.vel.y = 0;
        bounced = true;
      }
      if (!bounced) {
        for (const b of this.boxes) {
          if (
            gb.minX < b.maxX && gb.maxX > b.minX &&
            gb.minY < b.maxY && gb.maxY > b.minY &&
            gb.minZ < b.maxZ && gb.maxZ > b.minZ
          ) {
            // Pick the axis of least penetration and reflect it.
            const penX = Math.min(gb.maxX - b.minX, b.maxX - gb.minX);
            const penY = Math.min(gb.maxY - b.minY, b.maxY - gb.minY);
            const penZ = Math.min(gb.maxZ - b.minZ, b.maxZ - gb.minZ);
            if (penY <= penX && penY <= penZ) {
              g.vel.y = -g.vel.y * GRENADE.restitution;
              next.y = g.pos.y;
            } else if (penX <= penZ) {
              g.vel.x = -g.vel.x * GRENADE.restitution;
              next.x = g.pos.x;
            } else {
              g.vel.z = -g.vel.z * GRENADE.restitution;
              next.z = g.pos.z;
            }
            break;
          }
        }
      }
      g.pos = next;
    }
  }

  private stepClaymores(): void {
    for (const c of [...this.claymores.values()]) {
      if (!c.armed) {
        if (this.timeMs >= c.armsAt) c.armed = true;
        else continue;
      }
      for (const p of this.players.values()) {
        if (!p.alive || p.id === c.ownerId) continue;
        const center = { x: p.pos.x, y: p.pos.y + PLAYER.height / 2, z: p.pos.z };
        if (dist3(center, c.pos) <= CLAYMORE.triggerRadius + PLAYER.radius) {
          this.claymores.delete(c.id);
          this.explode(c.pos, CLAYMORE.blastRadius, CLAYMORE.fullDamageRadius, CLAYMORE.damage, c.ownerId, "claymore");
          break;
        }
      }
    }
  }

  private explode(
    at: Vec3,
    radius: number,
    fullDamageRadius: number,
    maxDamage: number,
    ownerId: string,
    kind: "grenade" | "claymore",
  ): void {
    this.events.push({ type: "explosion", x: at.x, y: at.y, z: at.z, kind });

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const center = { x: p.pos.x, y: p.pos.y + PLAYER.height / 2, z: p.pos.z };
      const d = dist3(center, at);
      if (d > radius) continue;
      const dmg = d <= fullDamageRadius
        ? maxDamage
        : Math.round(maxDamage * (1 - (d - fullDamageRadius) / (radius - fullDamageRadius)));
      if (dmg > 0) this.damage(p, dmg, ownerId, kind);
    }

    // Sympathetic detonation: explosions cook off nearby explosives.
    for (const g of this.grenades.values()) {
      if (dist3(g.pos, at) <= CHAIN_RADIUS) {
        g.explodeAt = Math.min(g.explodeAt, this.timeMs + 150);
      }
    }
    for (const c of [...this.claymores.values()]) {
      if (dist3(c.pos, at) <= CHAIN_RADIUS && this.claymores.delete(c.id)) {
        this.explode(c.pos, CLAYMORE.blastRadius, CLAYMORE.fullDamageRadius, CLAYMORE.damage, c.ownerId, "claymore");
      }
    }
  }

  private damage(victim: SimPlayer, amount: number, attackerId: string, cause: KillCause): void {
    if (!victim.alive || this.winnerId) return;
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
      if (killer.kills >= KILL_TARGET && !this.winnerId) {
        this.winnerId = killer.id;
        this.roundResetAt = this.timeMs + ROUND_RESET_MS;
        this.events.push({ type: "win", id: killer.id });
      }
    }
  }

  private respawn(p: SimPlayer): void {
    const spawn = this.pickSpawn();
    p.pos = { x: spawn.x, y: 0, z: spawn.z };
    p.vy = 0;
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.hp = PLAYER.hp;
    p.alive = true;
    p.ammo = MG.magSize;
    p.reloading = false;
    p.grenades = GRENADE.maxCarried;
    p.claymores = CLAYMORE.maxCarried;
    // Drop stale queued look angles so the spawn facing sticks until new input.
    p.cur = { ...IDLE_INPUT, yaw: spawn.yaw };
    this.events.push({ type: "spawn", id: p.id });
  }

  private stepRound(): void {
    if (!this.winnerId || this.timeMs < this.roundResetAt) return;
    this.winnerId = "";
    this.grenades.clear();
    this.claymores.clear();
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      this.respawn(p);
    }
    this.events.push({ type: "roundReset" });
  }

  /** Spawn at the point farthest from living opponents. */
  private pickSpawn() {
    let best = SPAWN_POINTS[Math.floor(this.rng() * SPAWN_POINTS.length)];
    let bestScore = -1;
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (alive.length === 0) return best;
    for (const s of SPAWN_POINTS) {
      let nearest = Infinity;
      for (const p of alive) {
        nearest = Math.min(nearest, Math.hypot(p.pos.x - s.x, p.pos.z - s.z));
      }
      if (nearest > bestScore) {
        bestScore = nearest;
        best = s;
      }
    }
    return best;
  }
}
