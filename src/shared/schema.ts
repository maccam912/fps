import { Schema, MapSchema, type } from "@colyseus/schema";
import type { WeaponKind } from "./protocol";

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

  @type("string") weapon: WeaponKind = "mg";
  @type("uint16") ammo = 50;
  @type("boolean") reloading = false;

  @type("uint16") ping = 0; // natural RTT in ms, self-reported by the client
}

export class PickupState extends Schema {
  @type("string") id = "";
  @type("string") kind = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
}

export class EntityState extends Schema {
  @type("string") id = "";
  @type("string") kind = "";
  @type("string") ownerId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") yaw = 0;
  @type("string") phase = "";
}

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: PickupState }) pickups = new MapSchema<PickupState>();
  @type({ map: EntityState }) entities = new MapSchema<EntityState>();

  @type("string") hostId = "";
  @type("uint16") forcedLagMs = 0;
  @type("boolean") delayedMouseLook = false;
  @type("string") code = "";
  @type("string") mapId = "";

  @type("string") roundPhase = "playing";
  @type("number") roundDurationMs = 0;
  @type("number") roundTimeLeftMs = 0;
  @type("uint16") roundNumber = 1;
  @type("string") winnerId = "";
  @type("string") winnerName = "";
}
