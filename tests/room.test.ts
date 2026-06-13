import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import { FpsRoom } from "../src/server/FpsRoom";
import { MSG } from "@shared/protocol";
import { ROOM_NAME } from "@shared/constants";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await boot({
    initializeGameServer: (gameServer) => {
      gameServer.define(ROOM_NAME, FpsRoom).filterBy(["code"]);
    },
  });
});

afterAll(async () => {
  await server.shutdown();
});

beforeEach(async () => {
  await server.cleanup();
});

const IDLE = {
  seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
  jump: false, fire: false, reload: false,
};

// NOTE: @colyseus/testing 0.16.3's client-side waitForNextPatch hooks a method
// that no longer exists in colyseus.js 0.16.22 and never resolves. Poll instead.
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until(): condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Send a message and wait until the server room has processed it. */
async function sendAndProcess(room: any, client: any, type: string, payload: unknown) {
  const processed = room.waitForMessage(type);
  client.send(type, payload);
  await processed;
}

describe("FpsRoom", () => {
  it("players join via party code, first joiner is host", async () => {
    // filterBy compares raw option values, so the client UI normalizes the
    // code to uppercase before joining.
    const c1 = await server.sdk.joinOrCreate(ROOM_NAME, { code: "ABCD", name: "Matt" });
    const c2 = await server.sdk.joinOrCreate(ROOM_NAME, { code: "ABCD", name: "Guest" });
    expect(c2.roomId).toBe(c1.roomId);

    await until(() => c1.state.players?.size === 2);
    expect(c1.state.code).toBe("ABCD");
    expect(c1.state.hostId).toBe(c1.sessionId);
    expect(c1.state.players.get(c1.sessionId)?.host).toBe(true);
    expect(c1.state.players.get(c2.sessionId)?.host).toBe(false);
    expect(c1.state.players.get(c1.sessionId)?.name).toBe("Matt");
    expect(c1.state.pickups.size).toBe(4);

    await c2.leave();
    await c1.leave();
  });

  it("different codes land in different rooms", async () => {
    const a = await server.sdk.joinOrCreate(ROOM_NAME, { code: "AAAA", name: "A" });
    const b = await server.sdk.joinOrCreate(ROOM_NAME, { code: "BBBB", name: "B" });
    expect(a.roomId).not.toBe(b.roomId);
    await a.leave();
    await b.leave();
  });

  it("uses the creator's delayed mouse look setting", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "LOOK", name: "Host", delayedMouseLook: true,
    });
    const peer = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "LOOK", name: "Peer", delayedMouseLook: false,
    });
    await until(() => peer.state.players?.size === 2);

    expect(host.state.delayedMouseLook).toBe(true);
    expect(peer.state.delayedMouseLook).toBe(true);

    await peer.leave();
    await host.leave();
  });

  it("uses the creator's selected map for every player in the room", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "MAPS", name: "Host", mapId: "megacomplex",
    });
    const peer = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "MAPS", name: "Peer", mapId: "pit",
    });
    await until(() => peer.state.players?.size === 2);

    expect(host.state.mapId).toBe("megacomplex");
    expect(peer.state.mapId).toBe("megacomplex");

    await peer.leave();
    await host.leave();
  });

  it("adds up to two lag-free practice bots when the party is created", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "BOTS", name: "Host", botCount: 99,
    });
    const room = server.getRoomById(host.roomId) as any;
    await until(() => host.state.players?.size === 3);

    const bots = [...host.state.players.values()].filter((player) => player.bot);
    expect(bots).toHaveLength(2);
    expect(host.state.hostId).toBe(host.sessionId);
    expect(bots.map((bot) => bot.name)).toEqual(["Practice Bot 1", "Practice Bot 2"]);

    await sendAndProcess(room, host, MSG.setLag, { ms: 1000 });
    await until(() => host.state.players.get(host.sessionId)?.forcedLagMs === 1000);
    expect(bots.every((bot) => bot.forcedLagMs === 0 && bot.artificialLagMs === 0)).toBe(true);

    const start = bots.map((bot) => [bot.x, bot.z]);
    await until(() => bots.some((bot, i) => bot.x !== start[i][0] || bot.z !== start[i][1]));

    await host.leave();
  });

  it("uses the creator's per-kill lag multiplier and optional cap", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "KILL", name: "Host", lagMode: "kills", lagPerKillMs: 75, lagCapMs: 500,
    });
    const peer = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "KILL", name: "Peer", lagMode: "host", lagPerKillMs: 999,
    });
    const room = server.getRoomById(host.roomId) as any;
    await until(() => peer.state.players?.size === 2);

    expect(peer.state.lagMode).toBe("kills");
    expect(peer.state.lagPerKillMs).toBe(75);
    expect(peer.state.lagCapMs).toBe(500);

    room.match.players.get(host.sessionId).kills = 4;
    room.match.players.get(peer.sessionId).kills = 10;
    await until(() => host.state.players.get(host.sessionId)?.forcedLagMs === 300);
    expect(host.state.players.get(peer.sessionId)?.forcedLagMs).toBe(500);

    await sendAndProcess(room, host, MSG.setLag, { ms: 1000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(host.state.forcedLagMs).toBe(0);

    await peer.leave();
    await host.leave();
  });

  it("leaves per-kill lag uncapped when the creator omits the cap", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "FREE", name: "Host", lagMode: "kills", lagPerKillMs: 50,
    });
    const room = server.getRoomById(host.roomId) as any;
    await until(() => host.state.players?.has(host.sessionId));
    room.match.players.get(host.sessionId).kills = 30;

    await until(() => host.state.players?.get(host.sessionId)?.forcedLagMs === 1500);
    expect(host.state.lagCapMs).toBe(0);

    await host.leave();
  });

  it("resolves random and invalid map selections to a valid map", async () => {
    const random = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "RNDA", name: "Random", mapId: "random",
    });
    const invalid = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "RNDB", name: "Invalid", mapId: "does-not-exist",
    });
    await until(() => Boolean(random.state.mapId) && Boolean(invalid.state.mapId));

    expect(["crossfire", "pit", "switchyard", "citadel", "maze", "megacomplex"]).toContain(random.state.mapId);
    expect(["crossfire", "pit", "switchyard", "citadel", "maze", "megacomplex"]).toContain(invalid.state.mapId);

    await random.leave();
    await invalid.leave();
  });

  it("host can set forced lag; non-host cannot; values clamp at 10s", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, { code: "LAGG", name: "Host" });
    const peer = await server.sdk.joinOrCreate(ROOM_NAME, { code: "LAGG", name: "Peer" });
    const room = server.getRoomById(host.roomId);

    await sendAndProcess(room, host, MSG.setLag, { ms: 1500 });
    await until(() => host.state.forcedLagMs === 1500);

    await sendAndProcess(room, peer, MSG.setLag, { ms: 4242 });
    await new Promise((r) => setTimeout(r, 200));
    expect(host.state.forcedLagMs).toBe(1500); // peer is not the host

    await sendAndProcess(room, host, MSG.setLag, { ms: 99_999 });
    await until(() => host.state.forcedLagMs === 10_000); // clamped

    await peer.leave();
    await host.leave();
  });

  it("uses the host's custom duration and only the host can start the next round", async () => {
    const host = await server.sdk.joinOrCreate(ROOM_NAME, {
      code: "TIME", name: "Host", roundDurationMinutes: 2,
    });
    const peer = await server.sdk.joinOrCreate(ROOM_NAME, { code: "TIME", name: "Peer" });
    const room = server.getRoomById(host.roomId) as any;
    await until(() => host.state.roundDurationMs === 120_000);

    room.match.roundEndsAt = room.match.timeMs + 1;
    await until(() => host.state.roundPhase === "ended");

    await sendAndProcess(room, peer, MSG.startRound, {});
    await new Promise((r) => setTimeout(r, 100));
    expect(host.state.roundPhase).toBe("ended");

    await sendAndProcess(room, host, MSG.startRound, {});
    await until(() => host.state.roundPhase === "playing" && host.state.roundNumber === 2);
    expect(host.state.players.get(host.sessionId)?.kills).toBe(0);

    await peer.leave();
    await host.leave();
  });

  it("ping is answered instantly and rtt lands on the scoreboard", async () => {
    const c = await server.sdk.joinOrCreate(ROOM_NAME, { code: "PING", name: "P" });
    const room = server.getRoomById(c.roomId);

    const pong = c.waitForMessage(MSG.pong);
    c.send(MSG.ping, { t: 12345 });
    expect((await pong).t).toBe(12345);

    await sendAndProcess(room, c, MSG.rtt, { ms: 87 });
    await until(() => c.state.players?.get(c.sessionId)?.ping === 87);

    await sendAndProcess(room, c, MSG.setLag, { ms: 100 });
    await until(() => c.state.players?.get(c.sessionId)?.artificialLagMs === 57);
    expect(c.state.players.get(c.sessionId)?.forcedLagMs).toBe(100);

    await c.leave();
  });

  it("inputs move the player; forced lag delays them end-to-end", async () => {
    const c = await server.sdk.joinOrCreate(ROOM_NAME, { code: "MOVE", name: "M" });
    const room = server.getRoomById(c.roomId);
    await until(() => c.state.players?.size === 1);

    const me = () => c.state.players.get(c.sessionId)!;
    const z0 = me().z;
    await sendAndProcess(room, c, MSG.input, { ...IDLE, seq: 1, moveZ: 1 });
    await until(() => me().z !== z0); // moves promptly at 0 forced lag

    // Crank the lag to 1s, send a "stop": we keep walking until it lands.
    await sendAndProcess(room, c, MSG.setLag, { ms: 1000 });
    await sendAndProcess(room, c, MSG.input, { ...IDLE, seq: 2 });
    await new Promise((r) => setTimeout(r, 400));
    const zMid = me().z;
    await new Promise((r) => setTimeout(r, 150));
    expect(me().z).not.toBe(zMid); // still walking: the stop is in the delay queue

    await new Promise((r) => setTimeout(r, 900)); // now past the 1s mark
    const z3 = me().z;
    await new Promise((r) => setTimeout(r, 300));
    expect(me().z).toBe(z3); // the stop finally applied

    await c.leave();
  });

  it("host crown passes when the host leaves", async () => {
    const h = await server.sdk.joinOrCreate(ROOM_NAME, { code: "CRWN", name: "H" });
    const p = await server.sdk.joinOrCreate(ROOM_NAME, { code: "CRWN", name: "P" });
    await until(() => p.state.players?.size === 2);
    await h.leave();
    await until(() => p.state.hostId === p.sessionId);
    expect(p.state.players.get(p.sessionId)?.host).toBe(true);
    await p.leave();
  });
});
