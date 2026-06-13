import { Client, Room, getStateCallbacks } from "colyseus.js";
import type { GameState } from "@shared/schema";
import { MSG, PlayerInput, KillMsg, ExplosionMsg, ShotMsg, WeaponFxMsg, PickupWeaponKind } from "@shared/protocol";
import { ROOM_NAME } from "@shared/constants";

const PING_INTERVAL_MS = 2000;

function endpoint(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Vite dev server runs on 5173; the Colyseus server is on 2567.
  // In production one process serves both on the same origin.
  if (location.port === "5173") return `${proto}//${location.hostname}:2567`;
  return `${proto}//${location.host}`;
}

export interface NetEvents {
  onKill?: (m: KillMsg) => void;
  onExplosion?: (m: ExplosionMsg) => void;
  onShot?: (m: ShotMsg) => void;
  onWeaponFx?: (m: WeaponFxMsg) => void;
  onPickup?: (m: { kind: PickupWeaponKind }) => void;
  onHitConfirm?: (m: { damage: number }) => void;
}

export class Net {
  room!: Room<GameState>;
  $!: ReturnType<typeof getStateCallbacks<GameState>>;
  rtt = 0; // smoothed natural round-trip in ms
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  get sessionId(): string {
    return this.room.sessionId;
  }

  async connect(
    code: string,
    name: string,
    events: NetEvents,
    roundDurationMinutes?: number,
    delayedMouseLook?: boolean,
    mapId?: string,
  ): Promise<void> {
    const client = new Client(endpoint());
    this.room = await client.joinOrCreate<GameState>(ROOM_NAME, {
      code: code.toUpperCase(), // filterBy matches raw strings — normalize here
      name,
      roundDurationMinutes,
      delayedMouseLook,
      mapId,
    });
    this.$ = getStateCallbacks(this.room);
    await waitFor(() => Boolean(this.room.state.mapId), 5000);

    this.room.onMessage(MSG.pong, (m: { t: number }) => {
      const sample = performance.now() - m.t;
      this.rtt = this.rtt === 0 ? sample : this.rtt * 0.7 + sample * 0.3;
      this.room.send(MSG.rtt, { ms: Math.round(this.rtt) });
    });
    this.room.onMessage(MSG.kill, (m: KillMsg) => events.onKill?.(m));
    this.room.onMessage(MSG.explosion, (m: ExplosionMsg) => events.onExplosion?.(m));
    this.room.onMessage(MSG.shot, (m: ShotMsg) => events.onShot?.(m));
    this.room.onMessage(MSG.weaponFx, (m: WeaponFxMsg) => events.onWeaponFx?.(m));
    this.room.onMessage(MSG.pickup, (m: { kind: PickupWeaponKind }) => events.onPickup?.(m));
    this.room.onMessage(MSG.hitConfirm, (m: { damage: number }) => events.onHitConfirm?.(m));

    const ping = () => this.room.send(MSG.ping, { t: performance.now() });
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
    ping();
  }

  sendInput(input: PlayerInput): void {
    this.room.send(MSG.input, input);
  }

  setLag(ms: number): void {
    this.room.send(MSG.setLag, { ms });
  }

  startRound(): void {
    this.room.send(MSG.startRound);
  }

  dispose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.room?.leave();
  }
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error("timed out waiting for initial room state"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}
