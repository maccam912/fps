# LAG WAR 💥

A browser FPS where **the host controls the lag**. Free-for-all arena deathmatch,
no login, party codes — and a host console that injects 0 ms to **10 whole
seconds** of artificial latency for *everyone* in the match. At 200 ms it feels
like bad wifi. At 3 s it's slapstick. At 10 s it's a turn-based game played in
real time.

Because precise aim is hopeless under heavy lag, the arsenal is built for chaos:

- 🔫 **Machine gun** — 12.5 rounds/sec with a wild spray cone. Hose an area, walk away, listen for the kill feed.
- 💣 **Grenades** (G) — 2.5 s fuse, big blast, restock over time. Fire and forget.
- 💥 **Claymores** (F) — plant, arm in 1.5 s, anyone who trips one dies. Explosions chain-detonate nearby explosives.

Built with **Babylon.js** (3D client), **Colyseus** (authoritative server),
TypeScript everywhere. Art & audio by [Kenney](https://kenney.nl) (CC0).

## Play

```bash
npm install
npm run dev          # server on :2567, client on :5173
```

Open http://localhost:5173, hit **CREATE PARTY**, share the URL (the party code
is in the link). Friends on your network/host can join the same code.

| Input | Action |
| --- | --- |
| WASD / mouse | move / aim |
| LMB | fire (hold) |
| G | throw grenade |
| F | plant claymore |
| R | reload |
| Space | jump |
| Tab | scoreboard (kills, deaths, natural ping) |
| L | **host only**: lag console (slider, presets up to 10 s) |

First to 15 kills wins the round; scores reset.

## How the lag works

- Clients ping the server every 2 s to measure **natural RTT** (shown on the scoreboard).
- The host's **forced lag** is applied server-side: every input (movement, aim,
  trigger pulls) is queued and only applied to the authoritative sim
  `forcedLagMs` later, preserving relative timing — your 500 ms strafe is still
  a 500 ms strafe, just N seconds late.
- There is deliberately **no client-side prediction**: your own body obeys you
  late. Your mouse *look* stays instant (so 10 s of lag is funny instead of
  nauseating), but where your shots go is decided by where you were aiming when
  you pulled the trigger — N seconds ago.

## Production / Docker

```bash
docker build -t lagwar .
docker run -p 2567:2567 lagwar
```

One process serves the built client and the WebSocket on the same port — point
a domain at it and the invite links just work.

## Tests

```bash
npm test           # sim unit tests (a full match plays out in one test) + room integration
npm run typecheck
npm run build:client && npm run smoke   # headless 2-player end-to-end w/ screenshots
```

The whole game (movement, weapons, lag buffer, rounds) lives in
`src/sim/Match.ts` as a deterministic `tick(dt)` class with zero engine/network
imports — the Colyseus room and the Babylon client are thin shells around it.

## Credits

All models, textures and sounds are CC0 assets by [Kenney](https://kenney.nl):
Blaster Kit, Blocky Characters, Prototype Textures, Sci-Fi Sounds, Impact
Sounds, Interface Sounds, Music Loops.
