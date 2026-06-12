import { Schema, MapSchema, type } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("uint8") skin = 0;
  @type("boolean") host = false;

  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("number") pitch = 0;
  @type("boolean") moving = false;

  @type("uint8") hp = 100;
  @type("boolean") alive = true;
  @type("uint16") kills = 0;
  @type("uint16") deaths = 0;

  @type("uint8") ammo = 50;
  @type("boolean") reloading = false;
  @type("uint8") grenades = 3;
  @type("uint8") claymores = 2;

  @type("uint16") ping = 0; // natural RTT in ms, self-reported by the client
}

export class GrenadeState extends Schema {
  @type("string") id = "";
  @type("string") ownerId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
}

export class ClaymoreState extends Schema {
  @type("string") id = "";
  @type("string") ownerId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("boolean") armed = false;
}

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: GrenadeState }) grenades = new MapSchema<GrenadeState>();
  @type({ map: ClaymoreState }) claymores = new MapSchema<ClaymoreState>();

  @type("string") hostId = "";
  @type("uint16") forcedLagMs = 0;
  @type("string") code = "";

  @type("string") winnerId = "";
  @type("string") winnerName = "";
}
