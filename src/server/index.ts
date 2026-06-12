import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME } from "@shared/constants";
import { FpsRoom } from "./FpsRoom";

const PORT = Number(process.env.PORT) || 2567;
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

// In production, serve the built client.
const clientDist = resolve(__dirname, "../../dist/client");
app.use(express.static(clientDist));

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// A party code maps a shareable link to a single room.
gameServer.define(ROOM_NAME, FpsRoom).filterBy(["code"]);

gameServer
  .listen(PORT)
  .then(() => console.log(`💥 LAG WAR server listening on :${PORT}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
