import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.LAGWAR_URL || "http://localhost:2567/";
const OUT = "scripts/shots/maps";
const MAPS = (process.env.MAPS || "switchyard,citadel,maze,megacomplex").split(",");

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 180_000,
  args: [
    "--no-sandbox",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
  defaultViewport: { width: 1280, height: 720 },
});

try {
  for (const mapId of MAPS) {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.select("#map-select", mapId);
    await page.click("#create-btn");
    await page.waitForFunction(() => window.__lagwar?.net?.room?.state?.mapId);
    await page.waitForFunction(
      () => !document.querySelector("#hud")?.classList.contains("hidden"),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const info = await page.evaluate(() => {
      const { game, net } = window.__lagwar;
      const player = net.room.state.players.get(net.room.sessionId);
      const forward = game.camera.getForwardRay().direction;
      let nearest = null;
      for (const [index, box] of game.map.boxes.entries()) {
        if (box.y + box.sy / 2 <= 1.6 || box.y - box.sy / 2 >= 1.6) continue;
        let near = 0;
        let far = 1000;
        for (const [origin, direction, min, max] of [
          [player.x, forward.x, box.x - box.sx / 2, box.x + box.sx / 2],
          [player.z, forward.z, box.z - box.sz / 2, box.z + box.sz / 2],
        ]) {
          if (Math.abs(direction) < 1e-9) {
            if (origin < min || origin > max) near = Infinity;
            continue;
          }
          let a = (min - origin) / direction;
          let b = (max - origin) / direction;
          if (a > b) [a, b] = [b, a];
          near = Math.max(near, a);
          far = Math.min(far, b);
        }
        if (near <= far && far >= 0 && (!nearest || near < nearest.distance)) {
          nearest = { index, distance: near, box };
        }
      }
      return {
        mapId: net.room.state.mapId,
        renderedMap: {
          id: game.map.id,
          width: game.map.width,
          depth: game.map.depth,
        },
        position: { x: player.x, y: player.y, z: player.z },
        serverYaw: player.yaw,
        inputYaw: game.inputYaw,
        viewYaw: game.viewYaw,
        simForward: {
          x: Math.sin(game.viewYaw),
          z: Math.cos(game.viewYaw),
        },
        cameraForward: { x: forward.x, y: forward.y, z: forward.z },
        nearest,
      };
    });
    await page.screenshot({ path: `${OUT}/${mapId}.png` });
    console.log(JSON.stringify(info));
    await page.close();
  }
} finally {
  await browser.close();
}
