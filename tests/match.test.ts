import { describe, expect, it } from "vitest";
import { Match, type SimPlayer } from "../src/sim/Match";
import {
  KILL_TARGET, MG, PICKUP_ACTIVE_COUNT, PICKUP_RESPAWN_MS,
  PLAYER, ROUND_RESET_MS, TICK_MS,
} from "@shared/constants";
import { PICKUP_WEAPONS, WEAPONS, type PlayerInput, type WeaponKind } from "@shared/protocol";

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
  it("declares a winner and resets players, entities, and pickups", () => {
    const m = new Match(20);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    a.kills = KILL_TARGET - 1;
    place(a, 0, -20);
    place(b, 0, -15);
    equip(a, "mg");
    m.enqueueInput("a", input({ fire: true, yaw: yawToward(a, b) }));
    run(m, 4000);
    expect(m.winnerId).toBe("a");
    run(m, ROUND_RESET_MS + 100);
    expect(m.winnerId).toBe("");
    expect(a.weapon).toBe("mg");
    expect(a.kills).toBe(0);
    expect(m.pickups.size).toBe(PICKUP_ACTIVE_COUNT);
    expect(m.entities.size).toBe(0);
  });
});
