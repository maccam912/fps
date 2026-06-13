// Headless end-to-end: boot the production server (serves built client + ws),
// join two browser clients to one party, walk, crank the forced lag to 2s and
// prove inputs are delayed, verify weapon pickups, and screenshot everything.
//
// Prereq: `npm run build:client` (the server serves dist/client).
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 2567;
const URL = `http://localhost:${PORT}/?code=SMOK`;
const OUT = "scripts/shots";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollFor(page, fn, { timeout = 15000, every = 250, label = "" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await page.evaluate(fn)) return true;
    } catch { /* page busy */ }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---- 1. boot the server -----------------------------------------------------
const server = spawn("npx", ["tsx", "src/server/index.ts"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT) },
});
server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`  [server!] ${d}`));

for (let i = 0; ; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/health`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  if (i > 60) throw new Error("server never came up");
  await sleep(250);
}
console.log("✓ server up");

// ---- 2. two clients ---------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  defaultViewport: { width: 1340, height: 760 },
});

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

async function openClient(name, shotName) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => fail(`[${name}] PAGEERROR ${e.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { document.getElementById("name-input").value = ""; });
  await page.type("#name-input", name);
  if (shotName) await page.screenshot({ path: `${OUT}/${shotName}` });
  await page.click("#join-btn");
  await pollFor(page, () => window.__lagwar?.net?.room?.sessionId != null, { label: `${name} joined` });
  await pollFor(
    page,
    () => !document.getElementById("hud").classList.contains("hidden"),
    { label: `${name} hud` },
  );
  return page;
}

try {
  const a = await openClient("Alice", "lobby.png");
  console.log("✓ Alice joined");
  const b = await openClient("Bob");
  console.log("✓ Bob joined");

  await pollFor(a, () => window.__lagwar.net.room.state.players.size === 2, { label: "both players visible" });
  console.log("✓ both players in one party room");
  const pickupCount = await a.evaluate(() => window.__lagwar.net.room.state.pickups.size);
  if (pickupCount !== 4) fail(`expected 4 weapon pickups, saw ${pickupCount}`);
  else console.log("✓ four random weapon pickups spawned");

  const myPos = (page) =>
    page.evaluate(() => {
      const { net } = window.__lagwar;
      const p = net.room.state.players.get(net.room.sessionId);
      return { x: p.x, z: p.z };
    });
  const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);

  // face the arena center so walks never pin against a wall
  const faceCenter = (page) =>
    page.evaluate(() => {
      const { net, game } = window.__lagwar;
      const p = net.room.state.players.get(net.room.sessionId);
      game.yaw = Math.atan2(-p.x, -p.z);
    });

  // ---- movement at 0 forced lag
  await faceCenter(a);
  const p0 = await myPos(a);
  await a.keyboard.down("KeyW");
  await sleep(800);
  await a.keyboard.up("KeyW");
  await sleep(300);
  const p1 = await myPos(a);
  if (dist(p0, p1) < 0.5) fail("player did not move at 0 lag");
  else console.log(`✓ walked ${dist(p0, p1).toFixed(1)}m at 0 lag`);

  // ---- forced lag: host sets 2000ms
  await a.evaluate(() => window.__lagwar.net.setLag(2000));
  await pollFor(a, () => window.__lagwar.net.room.state.forcedLagMs === 2000, { label: "lag applied" });
  await pollFor(b, () => window.__lagwar.net.room.state.forcedLagMs === 2000, { label: "lag visible to peer" });
  console.log("✓ host set forced lag to 2000ms (peer sees it too)");
  await faceCenter(a);
  await sleep(2300); // let the lagged input queue flush the old idle inputs

  const p2 = await myPos(a);
  // W+D so that even if a wall blocks one axis, the strafe still slides us
  await a.keyboard.down("KeyW");
  await a.keyboard.down("KeyD");
  await sleep(700);
  await a.keyboard.up("KeyW");
  await a.keyboard.up("KeyD");
  const p3 = await myPos(a);
  if (dist(p2, p3) > 0.3) fail(`moved too early under 2s lag (${dist(p2, p3).toFixed(1)}m)`);
  else console.log("✓ input did NOT apply during the first 700ms (delayed)");
  await sleep(2800);
  const p4 = await myPos(a);
  if (dist(p2, p4) < 0.5) fail("delayed input never applied");
  else console.log(`✓ the walk arrived ~2s late (moved ${dist(p2, p4).toFixed(1)}m)`);

  // ---- unified weapon HUD and primary fire
  const weaponLabel = await a.$eval("#weapon-name", (el) => el.textContent);
  if (!weaponLabel) fail("active weapon label missing");
  else console.log(`✓ unified weapon HUD active (${weaponLabel})`);
  await a.mouse.down();
  await sleep(300);
  await a.mouse.up();
  console.log("✓ primary fire sent through the unified weapon input");

  // ---- scoreboard + screenshots
  await a.keyboard.down("Tab");
  await sleep(400);
  await a.screenshot({ path: `${OUT}/ingame-scoreboard.png` });
  await a.keyboard.up("Tab");
  await sleep(200);
  await a.screenshot({ path: `${OUT}/ingame-a.png` });
  await b.screenshot({ path: `${OUT}/ingame-b.png` });
  console.log(`✓ screenshots in ${OUT}/`);

  const pings = await a.evaluate(() =>
    [...window.__lagwar.net.room.state.players.values()].map((p) => p.ping),
  );
  console.log(`  natural pings reported: ${pings.join(", ")}ms`);
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
  server.kill();
}

if (failed) {
  console.error("SMOKE FAILED");
  process.exit(1);
}
console.log("SMOKE PASSED");
process.exit(0);
