import { Room, Client } from "@colyseus/core";
import { EntityState, GameState, PickupState, PlayerState } from "@shared/schema";
import { MSG, PlayerInput, KillMsg } from "@shared/protocol";
import { TICK_MS, PATCH_MS, MAX_FORCED_LAG_MS, SKIN_COUNT } from "@shared/constants";
import { Match } from "../sim/Match";

interface JoinOptions { code?: string; name?: string }

export class FpsRoom extends Room<GameState> {
  maxClients = 16;
  private match = new Match(Date.now() & 0xffffffff);
  private skinCounter = 0;

  onCreate(options: JoinOptions) {
    this.setState(new GameState());
    this.state.code = String(options.code ?? "").toUpperCase().slice(0, 8);
    this.setPatchRate(PATCH_MS);

    this.onMessage(MSG.input, (client, input: PlayerInput) => {
      if (!input || typeof input !== "object") return;
      this.match.enqueueInput(client.sessionId, sanitizeInput(input));
    });

    // Ping must answer instantly — it measures *natural* latency.
    this.onMessage(MSG.ping, (client, msg: { t: number }) => {
      client.send(MSG.pong, { t: msg?.t ?? 0 });
    });

    this.onMessage(MSG.rtt, (client, msg: { ms: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.ping = Math.max(0, Math.min(65535, Math.round(msg?.ms ?? 0)));
    });

    this.onMessage(MSG.setLag, (client, msg: { ms: number }) => {
      if (client.sessionId !== this.state.hostId) return;
      const ms = Math.max(0, Math.min(MAX_FORCED_LAG_MS, Math.round(msg?.ms ?? 0)));
      this.match.setForcedLag(ms);
      this.state.forcedLagMs = ms;
    });

    this.setSimulationInterval((dt) => this.update(dt), TICK_MS);
  }

  onJoin(client: Client, options: JoinOptions) {
    const name = sanitizeName(options.name);
    const skin = this.skinCounter++ % SKIN_COUNT;
    this.match.addPlayer(client.sessionId, name, skin);

    const ps = new PlayerState();
    ps.id = client.sessionId;
    ps.name = name;
    ps.skin = skin;
    this.state.players.set(client.sessionId, ps);

    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
      ps.host = true;
    }
    this.syncToState();
  }

  onLeave(client: Client) {
    this.match.removePlayer(client.sessionId);
    this.state.players.delete(client.sessionId);
    // Pass the crown
    if (client.sessionId === this.state.hostId) {
      const next = this.state.players.keys().next();
      this.state.hostId = next.done ? "" : next.value;
      const p = next.done ? undefined : this.state.players.get(next.value);
      if (p) p.host = true;
    }
  }

  private update(dt: number) {
    this.match.tick(dt);
    this.syncToState();

    for (const ev of this.match.drainEvents()) {
      switch (ev.type) {
        case "kill": {
          const killer = this.match.players.get(ev.killerId);
          const victim = this.match.players.get(ev.victimId);
          const msg: KillMsg = {
            killerId: ev.killerId,
            killerName: killer?.name ?? "?",
            victimId: ev.victimId,
            victimName: victim?.name ?? "?",
            cause: ev.cause,
          };
          this.broadcast(MSG.kill, msg);
          break;
        }
        case "explosion":
          this.broadcast(MSG.explosion, { x: ev.x, y: ev.y, z: ev.z, kind: ev.kind });
          break;
        case "shot":
          this.broadcast(MSG.shot, {
            id: ev.id, kind: ev.kind,
            ox: ev.ox, oy: ev.oy, oz: ev.oz, tx: ev.tx, ty: ev.ty, tz: ev.tz, hit: ev.hit,
          });
          break;
        case "weaponFx":
          this.broadcast(MSG.weaponFx, ev);
          break;
        case "pickup": {
          const c = this.clients.find((cl) => cl.sessionId === ev.playerId);
          c?.send(MSG.pickup, { kind: ev.kind });
          break;
        }
        case "hit": {
          const c = this.clients.find((cl) => cl.sessionId === ev.shooterId);
          c?.send(MSG.hitConfirm, { damage: ev.damage });
          break;
        }
      }
    }
  }

  /** Mirror the sim into the synced schema. */
  private syncToState() {
    const s = this.state;
    for (const [id, p] of this.match.players) {
      const ps = s.players.get(id);
      if (!ps) continue;
      ps.x = round2(p.pos.x);
      ps.y = round2(p.pos.y);
      ps.z = round2(p.pos.z);
      ps.yaw = round3(p.yaw);
      ps.pitch = round3(p.pitch);
      ps.moving = p.moving;
      ps.hp = Math.max(0, Math.min(255, p.hp));
      ps.alive = p.alive;
      ps.kills = p.kills;
      ps.deaths = p.deaths;
      ps.weapon = p.weapon;
      ps.ammo = p.ammo;
      ps.reloading = p.reloading;
    }

    syncMap(this.match.pickups, s.pickups, (p) => {
      const ps = new PickupState();
      ps.id = p.id;
      ps.kind = p.kind;
      return ps;
    }, (p, ps) => {
      ps.x = round2(p.pos.x);
      ps.y = round2(p.pos.y);
      ps.z = round2(p.pos.z);
    });

    syncMap(this.match.entities, s.entities, (e) => {
      const es = new EntityState();
      es.id = e.id;
      es.kind = e.kind;
      es.ownerId = e.ownerId;
      return es;
    }, (e, es) => {
      es.x = round2(e.pos.x);
      es.y = round2(e.pos.y);
      es.z = round2(e.pos.z);
      es.yaw = round3(e.yaw);
      es.phase = e.phase;
    });

    s.winnerId = this.match.winnerId;
    s.winnerName = this.match.winnerId
      ? this.match.players.get(this.match.winnerId)?.name ?? ""
      : "";
  }
}

function syncMap<S extends { id: string }, T>(
  source: Map<string, S>,
  target: { get(k: string): T | undefined; set(k: string, v: T): void; delete(k: string): boolean; forEach(cb: (v: T, k: string) => void): void },
  create: (s: S) => T,
  update: (s: S, t: T) => void,
) {
  const seen = new Set<string>();
  for (const [id, s] of source) {
    seen.add(id);
    let t = target.get(id);
    if (!t) {
      t = create(s);
      target.set(id, t);
    }
    update(s, t);
  }
  const stale: string[] = [];
  target.forEach((_v, k) => {
    if (!seen.has(k)) stale.push(k);
  });
  for (const k of stale) target.delete(k);
}

function sanitizeInput(i: PlayerInput): PlayerInput {
  return {
    seq: Number(i.seq) || 0,
    moveX: clamp(Number(i.moveX) || 0, -1, 1),
    moveZ: clamp(Number(i.moveZ) || 0, -1, 1),
    yaw: Number(i.yaw) || 0,
    pitch: clamp(Number(i.pitch) || 0, -1.5, 1.5),
    jump: !!i.jump,
    fire: !!i.fire,
    reload: !!i.reload,
  };
}

function sanitizeName(name: unknown): string {
  const s = String(name ?? "").trim().slice(0, 16);
  return s || `Player${Math.floor(Math.random() * 900 + 100)}`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function round2(v: number) { return Math.round(v * 100) / 100 }
function round3(v: number) { return Math.round(v * 1000) / 1000 }
