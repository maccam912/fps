import { describe, expect, it } from "vitest";
import { Match, type SimPlayer } from "../src/sim/Match";
import {
  MG, MIN_ROUND_DURATION_MS, PICKUP_ACTIVE_COUNT, PICKUP_RESPAWN_MS,
  PLAYER, TICK_MS,
} from "@shared/constants";
import { PICKUP_WEAPONS, WEAPONS, type PlayerInput, type WeaponKind } from "@shared/protocol";
import { MAPS, selectMapId } from "@shared/map";
import { safePlayerPosition, worldBoxes } from "../src/sim/physics";

function input(partial: Partial<PlayerInput> = {}): PlayerInput {
  return {
    seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
    jump: false, fire: false, reload: false,
    ...partial,
  };
}

function run(m: Match, ms: number): void {
  const ticks = Math.ceil(ms / TICK_MS);
  for (let i = 0; i < ticks; i++) m.tick(TICK_MS);
}

function place(p: SimPlayer, x: number, z: number): void {
  p.pos = { x, y: 0, z };
}

function yawToward(a: SimPlayer, b: SimPlayer): number {
  return Math.atan2(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
}

function equip(p: SimPlayer, kind: WeaponKind, ammo = WEAPONS[kind].ammo): void {
  p.weapon = kind;
  p.ammo = ammo;
  p.reloading = false;
  p.lastFireAt = -1e9;
}

function tapFire(m: Match, p: SimPlayer, partial: Partial<PlayerInput> = {}): void {
  m.enqueueInput(p.id, input({ fire: true, ...partial }));
  m.tick(TICK_MS);
  m.enqueueInput(p.id, input({ fire: false, ...partial }));
  m.tick(TICK_MS);
}

describe("map catalog", () => {
  it("offers varied footprints including multiple larger arenas", () => {
    expect(MAPS).toHaveLength(6);
    expect(new Set(MAPS.map((map) => `${map.width}x${map.depth}`)).size).toBeGreaterThanOrEqual(5);
    expect(MAPS.filter((map) => map.width * map.depth > 64 * 64)).toHaveLength(4);
    expect(MAPS.some((map) => map.sizeLabel === "HUGE")).toBe(true);
  });

  it.each(MAPS)("$name has safe in-bounds spawns and enough reachable pickup pads", (map) => {
    const boxes = worldBoxes(map.boxes);
    expect(map.spawns.length).toBeGreaterThanOrEqual(8);
    expect(map.pickups.length).toBeGreaterThanOrEqual(PICKUP_ACTIVE_COUNT);

    for (const spawn of map.spawns) {
      expect(Math.abs(spawn.x)).toBeLessThan(map.width / 2);
      expect(Math.abs(spawn.z)).toBeLessThan(map.depth / 2);
      expect(safePlayerPosition({ x: spawn.x, y: 0, z: spawn.z }, boxes)).toBe(true);
    }
    for (const pickup of map.pickups) {
      expect(Math.abs(pickup.x)).toBeLessThan(map.width / 2);
      expect(Math.abs(pickup.z)).toBeLessThan(map.depth / 2);
      expect(safePlayerPosition(pickup, boxes)).toBe(true);
    }
  });

  it("accepts explicit maps and resolves random or invalid selections from the catalog", () => {
    expect(selectMapId("citadel", () => 0)).toBe("citadel");
    expect(selectMapId("random", () => 0)).toBe(MAPS[0].id);
    expect(selectMapId("not-a-map", () => 0.999999)).toBe(MAPS[MAPS.length - 1].id);
  });
});

describe("movement and forced lag", () => {
  it("moves, collides, and delays input without changing its duration", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, -20);
    m.setForcedLag(1000);
    m.enqueueInput("a", input({ moveZ: 1 }));
    run(m, 500);
    m.enqueueInput("a", input());
    run(m, 450);
    expect(p.pos.z).toBe(-20);
    run(m, 700);
    expect(p.pos.z).toBeGreaterThan(-18);
    expect(p.pos.z).toBeLessThan(-15);
  });

  it("adds configurable uncapped lag per kill for each player", () => {
    const m = new Match(1);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    m.setKillLag(75);
    a.kills = 4;
    b.kills = 20;

    expect(m.getPlayerLagMs("a")).toBe(300);
    expect(m.getPlayerLagMs("b")).toBe(1500);

    m.enqueueInput("a", input({ moveZ: 1 }));
    m.enqueueInput("b", input({ moveZ: 1 }));
    expect(a.queue[0].applyAt).toBe(300);
    expect(b.queue[0].applyAt).toBe(1500);
  });

  it("caps kill-based lag when a cap is configured", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    m.setKillLag(50, 400);
    p.kills = 20;
    expect(m.getPlayerLagMs("a")).toBe(400);
  });
});

describe("weapon pickups", () => {
  it("spawns four distinct pickup weapons on fixed pads", () => {
    const m = new Match(2);
    expect(m.pickups.size).toBe(PICKUP_ACTIVE_COUNT);
    const kinds = [...m.pickups.values()].map((p) => p.kind);
    expect(new Set(kinds).size).toBe(PICKUP_ACTIVE_COUNT);
    expect(kinds.every((kind) => PICKUP_WEAPONS.includes(kind))).toBe(true);
  });

  it("walk-over collection replaces the weapon and refills the pad later", () => {
    const m = new Match(2);
    const p = m.addPlayer("a", "A", 0);
    const pickup = [...m.pickups.values()][0];
    p.pos = { ...pickup.pos };
    m.tick(TICK_MS);
    expect(p.weapon).toBe(pickup.kind);
    expect(p.ammo).toBe(WEAPONS[pickup.kind].ammo);
    expect(m.pickups.has(pickup.id)).toBe(false);

    place(p, 0, 0);
    run(m, PICKUP_RESPAWN_MS + 100);
    expect(m.pickups.has(pickup.id)).toBe(true);
  });

  it("keeps pickup ammo through death and falls back to a full machine gun when empty", () => {
    const m = new Match(3);
    const p = m.addPlayer("a", "A", 0);
    equip(p, "shock", 2);
    p.alive = false;
    p.respawnAt = m.timeMs + 100;
    run(m, 150);
    expect(p.weapon).toBe("shock");
    expect(p.ammo).toBe(2);

    tapFire(m, p);
    tapFire(m, p);
    expect(p.weapon).toBe("mg");
    expect(p.ammo).toBe(MG.magSize);
  });

  it("grenades and claymores use the same primary-fire path as every pickup", () => {
    const m = new Match(4);
    const p = m.addPlayer("a", "A", 0);
    place(p, 10, 10);
    equip(p, "grenade");
    tapFire(m, p, { pitch: -0.8 });
    expect([...m.entities.values()].some((e) => e.kind === "grenade")).toBe(true);

    m.entities.clear();
    equip(p, "claymore");
    tapFire(m, p);
    expect([...m.entities.values()].some((e) => e.kind === "claymore")).toBe(true);
  });
});

describe("weapon behavior", () => {
  it.each([
    ["rocket", "rocket"],
    ["ricochet", "ricochet"],
    ["cluster", "cluster"],
    ["homingMine", "homingMine"],
    ["sticky", "sticky"],
    ["turret", "turret"],
    ["plasma", "plasma"],
    ["teleport", "teleport"],
  ] as const)("%s creates its authoritative world entity", (weapon, entity) => {
    const m = new Match(10);
    const p = m.addPlayer("a", "A", 0);
    place(p, -10, -20);
    equip(p, weapon);
    tapFire(m, p, { yaw: 0, pitch: 0.2 });
    expect([...m.entities.values()].some((e) => e.kind === entity)).toBe(true);
  });

  it("flamethrower creates burning ground and damages targets in its cone", () => {
    const m = new Match(11);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, 0, -20);
    place(b, 0, -16);
    equip(a, "flamethrower");
    tapFire(m, a, { yaw: yawToward(a, b) });
    expect([...m.entities.values()].some((e) => e.kind === "flame")).toBe(true);
    expect(b.hp).toBeLessThan(PLAYER.hp);
  });

  it("shock cannon damages and launches a target", () => {
    const m = new Match(12);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, 0, -20);
    place(b, 0, -15);
    equip(a, "shock");
    tapFire(m, a, { yaw: yawToward(a, b) });
    expect(b.hp).toBe(PLAYER.hp - 15);
    expect(Math.hypot(b.pushX, b.pushZ)).toBeGreaterThan(5);
    expect(b.vy).toBeGreaterThan(0);
  });

  it("cluster shells split into six deterministic bomblets on impact", () => {
    const m = new Match(13);
    const a = m.addPlayer("a", "A", 0);
    place(a, 0, -30);
    equip(a, "cluster");
    tapFire(m, a, { yaw: Math.PI, pitch: 0 });
    run(m, 300);
    expect([...m.entities.values()].filter((e) => e.kind === "bomblet")).toHaveLength(6);
  });

  it("teleport grenade moves its living owner after the fuse", () => {
    const m = new Match(14);
    const a = m.addPlayer("a", "A", 0);
    place(a, -20, -20);
    equip(a, "teleport");
    const before = { ...a.pos };
    tapFire(m, a, { yaw: 0, pitch: 0.2 });
    run(m, 1700);
    expect(Math.hypot(a.pos.x - before.x, a.pos.z - before.z)).toBeGreaterThan(2);
  });

  it("forced lag delays pickup-weapon fire", () => {
    const m = new Match(15);
    const a = m.addPlayer("a", "A", 0);
    equip(a, "rocket");
    m.setForcedLag(1000);
    m.enqueueInput("a", input({ fire: true }));
    run(m, 900);
    expect(m.entities.size).toBe(0);
    run(m, 200);
    expect([...m.entities.values()].some((e) => e.kind === "rocket")).toBe(true);
  });
});

describe("rounds", () => {
  it("ends on the timer, preserves scores, and waits for a new round", () => {
    const m = new Match(20, MIN_ROUND_DURATION_MS);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    a.kills = 4;
    a.deaths = 2;
    b.kills = 3;
    b.deaths = 1;

    run(m, MIN_ROUND_DURATION_MS + 100);
    expect(m.roundPhase).toBe("ended");
    expect(m.winnerId).toBe("a");
    expect(a.kills).toBe(4);
    expect(a.deaths).toBe(2);
    expect(m.roundTimeLeftMs).toBe(0);

    run(m, 5000);
    expect(m.roundPhase).toBe("ended");
    expect(a.kills).toBe(4);

    m.startRound();
    expect(m.roundPhase).toBe("playing");
    expect(m.winnerId).toBe("");
    expect(a.weapon).toBe("mg");
    expect(a.kills).toBe(0);
    expect(a.deaths).toBe(0);
    expect(m.pickups.size).toBe(PICKUP_ACTIVE_COUNT);
    expect(m.entities.size).toBe(0);
    expect(m.roundNumber).toBe(2);
    expect(m.roundTimeLeftMs).toBe(MIN_ROUND_DURATION_MS);
  });

  it("reports a tie when kills and deaths are equal", () => {
    const m = new Match(21, MIN_ROUND_DURATION_MS);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    a.kills = b.kills = 2;
    a.deaths = b.deaths = 3;
    run(m, MIN_ROUND_DURATION_MS + 100);
    expect(m.roundPhase).toBe("ended");
    expect(m.winnerId).toBe("");
  });
});
