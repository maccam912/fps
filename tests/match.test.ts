import { describe, it, expect } from "vitest";
import { Match, SimPlayer } from "../src/sim/Match";
import { TICK_MS, PLAYER, MG, GRENADE, CLAYMORE, KILL_TARGET, ROUND_RESET_MS } from "@shared/constants";
import type { PlayerInput } from "@shared/protocol";

function input(partial: Partial<PlayerInput> = {}): PlayerInput {
  return {
    seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
    jump: false, fire: false, throwGrenade: false, placeClaymore: false, reload: false,
    ...partial,
  };
}

function run(m: Match, ms: number) {
  const ticks = Math.round(ms / TICK_MS);
  for (let i = 0; i < ticks; i++) m.tick(TICK_MS);
}

/** Aim p at q (yaw measured with 0 = +Z, x = sin yaw). */
function yawToward(p: SimPlayer, q: SimPlayer): number {
  return Math.atan2(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
}

function place(p: SimPlayer, x: number, z: number) {
  p.pos.x = x;
  p.pos.y = 0;
  p.pos.z = z;
}

describe("movement", () => {
  it("walks forward when an input is applied", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, -20);
    m.enqueueInput("a", input({ moveZ: 1, yaw: 0 }));
    run(m, 1000);
    expect(p.pos.z).toBeGreaterThan(-20 + PLAYER.speed * 0.8);
    expect(p.pos.z).toBeLessThan(-20 + PLAYER.speed * 1.2);
  });

  it("is blocked by the arena wall", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 12, 20); // clear lane toward the +Z wall
    m.enqueueInput("a", input({ moveZ: 1, yaw: 0 }));
    run(m, 5000);
    expect(p.pos.z).toBeLessThan(32);
    expect(p.pos.z).toBeGreaterThan(29);
  });

  it("jumps and lands", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, -12, 8); // open ground
    m.enqueueInput("a", input({ jump: true }));
    run(m, 200);
    expect(p.pos.y).toBeGreaterThan(0.5);
    m.enqueueInput("a", input({}));
    run(m, 2000);
    expect(p.pos.y).toBe(0);
  });

  it("climbs the tower stairs via step-up", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, 10.5); // south of the stair block at z 5..9 (h=0.5), tier 1 top at y=1
    m.enqueueInput("a", input({ moveZ: 1, yaw: Math.PI })); // walk toward -Z
    run(m, 1600);
    expect(p.pos.y).toBeGreaterThanOrEqual(1);
  });
});

describe("forced lag (the whole point)", () => {
  it("applies inputs immediately at 0 forced lag", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, -20);
    m.enqueueInput("a", input({ moveZ: 1 }));
    m.tick(TICK_MS);
    expect(p.pos.z).toBeGreaterThan(-20);
  });

  it("delays inputs by exactly the forced lag", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, -20);
    m.setForcedLag(1000);
    m.enqueueInput("a", input({ moveZ: 1, yaw: 0 }));
    run(m, 967); // just shy of 1s
    expect(p.pos.z).toBe(-20); // hasn't budged
    run(m, 100); // now past the 1s mark
    expect(p.pos.z).toBeGreaterThan(-20);
  });

  it("preserves relative timing between inputs (a 500ms walk stays 500ms)", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, -20);
    m.setForcedLag(2000);
    m.enqueueInput("a", input({ moveZ: 1, yaw: 0 }));
    run(m, 500);
    m.enqueueInput("a", input({ moveZ: 0 })); // release W after 500ms
    run(m, 1400); // t=1900 < 2000: still frozen
    expect(p.pos.z).toBe(-20);
    run(m, 3000); // everything has played out
    const walked = p.pos.z + 20;
    expect(walked).toBeGreaterThan(PLAYER.speed * 0.4);
    expect(walked).toBeLessThan(PLAYER.speed * 0.65);
  });

  it("delayed fire happens late, in the direction aimed at press time", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, 0, -20);
    place(b, 0, -15); // 5m in front of A
    m.setForcedLag(3000);
    m.enqueueInput("a", input({ fire: true, yaw: yawToward(a, b) }));
    run(m, 2900);
    expect(b.hp).toBe(PLAYER.hp); // nothing yet
    run(m, 500); // shots start landing after 3s
    expect(b.hp).toBeLessThan(PLAYER.hp);
  });

  it("lowering the lag mid-flight keeps the queue ordered", () => {
    const m = new Match(1);
    const p = m.addPlayer("a", "A", 0);
    place(p, 0, -20);
    m.setForcedLag(5000);
    m.enqueueInput("a", input({ moveZ: 1, yaw: 0, seq: 1 }));
    m.setForcedLag(0);
    m.enqueueInput("a", input({ moveZ: 0, seq: 2 })); // applies immediately, BEFORE seq 1
    run(m, 4900);
    expect(p.pos.z).toBe(-20); // stop arrived first; walk hasn't arrived yet
    run(m, 1200); // seq 1 lands at t=5s and nothing ever stops it
    expect(p.pos.z).toBeGreaterThan(-20);
  });
});

describe("machine gun", () => {
  it("damages and eventually kills, awarding the kill", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, 0, -20);
    place(b, 0, -15);
    m.enqueueInput("a", input({ fire: true, yaw: yawToward(a, b) }));
    run(m, 4000);
    expect(a.kills).toBeGreaterThanOrEqual(1);
    expect(b.deaths).toBeGreaterThanOrEqual(1);
  });

  it("consumes ammo and auto-reloads", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    place(a, 0, -20);
    m.enqueueInput("a", input({ fire: true, yaw: 0 }));
    let waited = 0;
    while (a.ammo > 0 && waited < 10000) { m.tick(TICK_MS); waited += TICK_MS; }
    expect(waited).toBeLessThan(MG.magSize * MG.fireIntervalMs + 300);
    m.tick(TICK_MS); // auto-reload kicks in
    expect(a.reloading).toBe(true);
    run(m, MG.reloadMs + 200);
    expect(a.reloading).toBe(false);
    expect(a.ammo).toBeGreaterThan(0);
  });

  it("victim respawns with full hp after the respawn delay", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, 0, -20);
    place(b, 0, -15);
    m.enqueueInput("a", input({ fire: true, yaw: yawToward(a, b) }));
    let waited = 0;
    while (b.alive && waited < 10000) { m.tick(TICK_MS); waited += TICK_MS; }
    expect(b.alive).toBe(false);
    run(m, PLAYER.respawnMs + 200);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(PLAYER.hp);
  });
});

describe("grenades", () => {
  it("explodes after the fuse and damages players in range", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, -10, -18);
    place(b, -10, -16);
    // Drop it nearly at our feet so it stays put (suicidal, but deterministic)
    m.enqueueInput("a", input({ throwGrenade: true, yaw: yawToward(a, b), pitch: -1.4 }));
    m.tick(TICK_MS);
    expect(m.grenades.size).toBe(1);
    expect(a.grenades).toBe(GRENADE.maxCarried - 1);
    run(m, GRENADE.fuseMs - 300);
    expect(b.hp).toBe(PLAYER.hp);
    run(m, 500);
    expect(m.grenades.size).toBe(0);
    expect(b.hp).toBeLessThan(PLAYER.hp);
  });

  it("throw is edge-triggered: holding the key throws once", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    place(a, -10, -20);
    m.enqueueInput("a", input({ throwGrenade: true }));
    m.tick(TICK_MS);
    m.enqueueInput("a", input({ throwGrenade: true })); // still held
    run(m, 200);
    expect(a.grenades).toBe(GRENADE.maxCarried - 1);
  });

  it("restocks over time", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    place(a, -10, -20);
    m.enqueueInput("a", input({ throwGrenade: true }));
    m.tick(TICK_MS);
    expect(a.grenades).toBe(GRENADE.maxCarried - 1);
    run(m, GRENADE.restockMs + 200);
    expect(a.grenades).toBe(GRENADE.maxCarried);
  });
});

describe("claymores", () => {
  it("arms after a delay, then proximity-detonates on an enemy", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(a, 10, 10);
    place(b, 10, 20);
    m.enqueueInput("a", input({ placeClaymore: true, yaw: 0 }));
    m.tick(TICK_MS);
    expect(m.claymores.size).toBe(1);
    run(m, CLAYMORE.armMs + 100);
    expect([...m.claymores.values()][0].armed).toBe(true);

    // B walks toward the claymore (placed near 10, 11.2)
    m.enqueueInput("b", input({ moveZ: 1, yaw: Math.PI }));
    let waited = 0;
    while (b.alive && waited < 5000) { m.tick(TICK_MS); waited += TICK_MS; }
    expect(b.alive).toBe(false);
    expect(m.claymores.size).toBe(0);
    expect(a.kills).toBe(1);
  });

  it("does not trigger on its owner", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    place(a, 10, 10);
    m.enqueueInput("a", input({ placeClaymore: true, yaw: 0 }));
    m.tick(TICK_MS);
    run(m, CLAYMORE.armMs + 500); // owner standing right next to it
    expect(m.claymores.size).toBe(1);
    expect(a.alive).toBe(true);
  });
});

describe("chain detonation", () => {
  it("an explosion cooks off a nearby claymore", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    place(b, -25, -25); // b owns the claymore
    m.enqueueInput("b", input({ placeClaymore: true, yaw: 0 }));
    m.tick(TICK_MS);
    const claymorePos = [...m.claymores.values()][0].pos;
    place(b, 25, 25); // b leaves

    // a drops a grenade right next to b's claymore
    place(a, claymorePos.x - 1, claymorePos.z - 1);
    m.enqueueInput("a", input({ throwGrenade: true, yaw: 0, pitch: -1.4 }));
    run(m, GRENADE.fuseMs + 400);
    expect(m.claymores.size).toBe(0); // chained
  });
});

describe("rounds", () => {
  it("declares a winner at the kill target and resets scores after the banner", () => {
    const m = new Match(7);
    const a = m.addPlayer("a", "A", 0);
    const b = m.addPlayer("b", "B", 1);
    a.kills = KILL_TARGET - 1;
    place(a, 0, -20);
    place(b, 0, -15);
    m.enqueueInput("a", input({ fire: true, yaw: yawToward(a, b) }));
    let waited = 0;
    while (!m.winnerId && waited < 10000) { m.tick(TICK_MS); waited += TICK_MS; }
    expect(m.winnerId).toBe("a");
    expect(a.kills).toBe(KILL_TARGET);
    const evs = m.drainEvents();
    expect(evs.some((e) => e.type === "win")).toBe(true);
    run(m, ROUND_RESET_MS + 200);
    expect(m.winnerId).toBe("");
    expect(a.kills).toBe(0);
    expect(b.deaths).toBe(0);
  });
});

describe("a full match plays out in this unit test", () => {
  it("two scripted players fight to a winner under 800ms forced lag", () => {
    const m = new Match(42);
    const a = m.addPlayer("a", "Spray", 0);
    const b = m.addPlayer("b", "Pray", 1);
    m.setForcedLag(800);

    let winner: string | null = null;
    let elapsed = 0;
    const maxMs = 15 * 60_000;

    const script = (self: SimPlayer, foe: SimPlayer) => {
      if (!self.alive) return;
      const dist = Math.hypot(foe.pos.x - self.pos.x, foe.pos.z - self.pos.z);
      m.enqueueInput(self.id, input({
        fire: true,
        yaw: yawToward(self, foe),
        moveZ: dist > 8 ? 1 : 0, // close the gap
        moveX: Math.sin(elapsed / 500) * 0.5, // wiggle
        jump: elapsed % 1400 < 700, // hop over obstacles
      }));
    };

    while (!winner && elapsed < maxMs) {
      if (elapsed % 99 < TICK_MS) {
        script(a, b);
        script(b, a);
      }
      if (elapsed % 4000 < TICK_MS && a.alive) {
        m.enqueueInput("a", input({ throwGrenade: true, yaw: yawToward(a, b), pitch: 0.3 }));
        m.enqueueInput("a", input({ throwGrenade: false, yaw: yawToward(a, b) }));
      }
      m.tick(TICK_MS);
      elapsed += TICK_MS;
      for (const ev of m.drainEvents()) {
        if (ev.type === "win") winner = ev.id;
      }
    }

    expect(winner).not.toBeNull();
    expect(m.players.get(winner!)!.kills).toBeGreaterThanOrEqual(KILL_TARGET);
  }, 60_000);
});
