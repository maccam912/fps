// The Babylon.js presentation layer. Renders whatever the server says is true —
// deliberately NO client-side prediction: under forced lag your own body obeys
// you late, and that's the game.

import {
  Engine, Scene, Vector3, Color3, Color4, FreeCamera,
  HemisphericLight, DirectionalLight, ShadowGenerator,
  MeshBuilder, StandardMaterial, Texture, DynamicTexture,
  TransformNode, AbstractMesh, Mesh, ParticleSystem, PointLight,
  Vector4, LoadAssetContainerAsync, AssetContainer, PBRMaterial,
  DefaultRenderingPipeline, GlowLayer, ImageProcessingConfiguration,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

import { MAP_BOXES, ARENA_SIZE } from "@shared/map";
import { PLAYER, SKIN_COUNT, MAX_FORCED_LAG_MS } from "@shared/constants";
import { WEAPONS, type PlayerInput, type ShotMsg, type ExplosionMsg, type KillMsg, type WeaponFxMsg, type PickupWeaponKind, type WeaponKind } from "@shared/protocol";
import type { EntityState, PickupState, PlayerState } from "@shared/schema";
import { Net } from "./net";
import { Hud } from "./hud";
import { AudioMan } from "./audio";

const INPUT_SEND_MS = 50;
const MOUSE_SENS = 0.0022;
const SMOOTH = 13; // exponential smoothing rate for state-driven motion
const SNAP_DIST = 4; // teleport (respawn) instead of gliding

const SKINS = ["a", "b", "c", "d", "e", "f", "g", "h"];

interface PlayerVisual {
  root: TransformNode;
  state: PlayerState;
  nameTag: Mesh;
  bobPhase: number;
  held: TransformNode | null;
  weapon: WeaponKind;
}

interface WorldVisual {
  root: TransformNode;
  state: EntityState;
  lamp?: Mesh;
}

export class Game {
  private engine: Engine;
  private scene: Scene;
  private camera: FreeCamera;
  private shadows!: ShadowGenerator;
  private hud = new Hud();
  private audio = new AudioMan();

  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private firing = false;
  private latched = { jump: false, reload: false };
  private seq = 0;

  private players = new Map<string, PlayerVisual>();
  private pickupMeshes = new Map<string, TransformNode>();
  private entityMeshes = new Map<string, WorldVisual>();

  private characterContainers: (AssetContainer | null)[] = new Array(SKIN_COUNT).fill(null);
  private weaponContainers = new Map<string, AssetContainer>();

  private viewmodel: TransformNode | null = null;
  private viewmodelKind: WeaponKind | "" = "";
  private recoil = 0;
  private shake = 0;
  private wasAlive = true;
  private lastWinner = "";
  private lastRoundPhase = "playing";
  private lastFootstep = 0;
  private flareTex: Texture | null = null;

  constructor(private canvas: HTMLCanvasElement, private net: Net) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.camera = new FreeCamera("cam", new Vector3(0, PLAYER.eyeHeight, -28), this.scene);
    this.camera.minZ = 0.05;
    this.camera.fov = 1.05;
  }

  async start(): Promise<void> {
    this.buildWorld();
    await this.loadAssets();
    this.bindState();
    this.bindInput();
    this.hud.show();
    this.hud.onSetLag = (ms) => this.net.setLag(ms);
    this.hud.onStartRound = () => this.net.startRound();
    this.audio.playMusic("music-game.ogg", 0.16);
    this.audio.play("join", 0.7);

    setInterval(() => this.sendInput(), INPUT_SEND_MS);
    this.engine.runRenderLoop(() => {
      this.update(this.engine.getDeltaTime() / 1000);
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
  }

  // ---------------------------------------------------------------- world ---

  private buildWorld(): void {
    const s = this.scene;
    s.clearColor = new Color4(0.018, 0.027, 0.05, 1);
    s.ambientColor = new Color3(0.08, 0.11, 0.17);
    s.fogMode = Scene.FOGMODE_LINEAR;
    s.fogStart = 52;
    s.fogEnd = 125;
    s.fogColor = new Color3(0.035, 0.055, 0.09);

    const image = s.imageProcessingConfiguration;
    image.toneMappingEnabled = true;
    image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    image.exposure = 1.08;
    image.contrast = 1.16;
    image.vignetteEnabled = true;
    image.vignetteWeight = 1.35;
    image.vignetteColor = new Color4(0.015, 0.025, 0.05, 1);
    image.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;

    const pipeline = new DefaultRenderingPipeline("main-pipeline", true, s, [this.camera]);
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.82;
    pipeline.bloomWeight = 0.18;
    pipeline.bloomKernel = 48;
    pipeline.samples = 2;

    const glow = new GlowLayer("arena-glow", s, { blurKernelSize: 24 });
    glow.intensity = 0.42;

    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), s);
    hemi.intensity = 0.58;
    hemi.diffuse = new Color3(0.55, 0.68, 0.9);
    hemi.groundColor = new Color3(0.12, 0.1, 0.18);

    const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, 0.35), s);
    sun.position = new Vector3(30, 50, -25);
    sun.diffuse = new Color3(0.78, 0.86, 1);
    sun.intensity = 1.35;
    sun.shadowMinZ = 1;
    sun.shadowMaxZ = 110;
    this.shadows = new ShadowGenerator(2048, sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    this.shadows.bias = 0.0005;
    this.shadows.normalBias = 0.03;
    this.shadows.setDarkness(0.32);

    // Kenney prototype textures are an 8m grid design: tile once per 8 meters.
    const TEX_M = 8;

    const ground = MeshBuilder.CreateGround("ground", { width: ARENA_SIZE + 2, height: ARENA_SIZE + 2 }, s);
    const gmat = new PBRMaterial("gmat", s);
    const gtex = new Texture(`/textures/proto-dark.png`, s);
    gtex.uScale = (ARENA_SIZE + 2) / TEX_M;
    gtex.vScale = (ARENA_SIZE + 2) / TEX_M;
    gmat.albedoTexture = gtex;
    gmat.albedoColor = new Color3(0.42, 0.48, 0.58);
    gmat.metallic = 0.12;
    gmat.roughness = 0.72;
    gmat.environmentIntensity = 0.42;
    gmat.maxSimultaneousLights = 8;
    ground.material = gmat;
    ground.receiveShadows = true;

    const texFiles: Record<string, string> = { a: "proto-orange", b: "proto-purple", c: "proto-green" };
    const mats: Record<string, PBRMaterial> = {};
    for (const v of ["a", "b", "c"]) {
      const m = new PBRMaterial(`box-${v}`, s);
      m.albedoTexture = new Texture(`/textures/${texFiles[v]}.png`, s);
      m.albedoColor = v === "a"
        ? new Color3(0.9, 0.68, 0.48)
        : v === "b"
          ? new Color3(0.62, 0.66, 0.82)
          : new Color3(0.52, 0.78, 0.67);
      m.metallic = v === "b" ? 0.2 : 0.08;
      m.roughness = v === "b" ? 0.55 : 0.68;
      m.environmentIntensity = 0.48;
      m.maxSimultaneousLights = 8;
      mats[v] = m;
    }

    MAP_BOXES.forEach((b, i) => {
      const u = (d: number) => Math.max(0.5, d / TEX_M);
      const faceUV = [
        new Vector4(0, 0, u(b.sx), u(b.sy)), new Vector4(0, 0, u(b.sx), u(b.sy)), // front/back
        new Vector4(0, 0, u(b.sz), u(b.sy)), new Vector4(0, 0, u(b.sz), u(b.sy)), // right/left
        new Vector4(0, 0, u(b.sx), u(b.sz)), new Vector4(0, 0, u(b.sx), u(b.sz)), // top/bottom
      ];
      const mesh = MeshBuilder.CreateBox(`box${i}`, { width: b.sx, height: b.sy, depth: b.sz, faceUV, wrap: true }, s);
      mesh.position.set(b.x, b.y, b.z);
      mesh.material = mats[b.tex];
      mesh.receiveShadows = true;
      mesh.freezeWorldMatrix();
      this.shadows.addShadowCaster(mesh);
    });

    this.buildSky();
    this.buildArenaLighting();
    this.buildAtmosphere();
  }

  private buildSky(): void {
    const tex = new DynamicTexture("sky-gradient", { width: 32, height: 512 }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const gradient = ctx.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, "#050914");
    gradient.addColorStop(0.48, "#10213b");
    gradient.addColorStop(0.72, "#1a3550");
    gradient.addColorStop(1, "#35516a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 512);
    tex.update();

    const sky = MeshBuilder.CreateSphere("sky", {
      diameter: 240,
      segments: 24,
      sideOrientation: Mesh.BACKSIDE,
    }, this.scene);
    const mat = new StandardMaterial("sky-mat", this.scene);
    mat.emissiveTexture = tex;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    sky.material = mat;
    sky.applyFog = false;
    sky.isPickable = false;
    sky.infiniteDistance = true;
  }

  private buildArenaLighting(): void {
    const cyan = new Color3(0.12, 0.82, 1);
    const amber = new Color3(1, 0.36, 0.12);
    const cyanMat = this.makeEmissiveMaterial("lane-cyan", cyan, 2.4);
    const amberMat = this.makeEmissiveMaterial("lane-amber", amber, 2.8);

    // Thin floor guides emphasize the central objective and cardinal lanes.
    const strips: Array<[number, number, number, number, PBRMaterial]> = [
      [-5.5, -5.5, 11, 0.08, cyanMat], [-5.5, 5.5, 11, 0.08, cyanMat],
      [-5.5, 0, 0.08, 11, cyanMat], [5.5, 0, 0.08, 11, cyanMat],
      [0, -18, 0.1, 13, amberMat], [0, 18, 0.1, 13, amberMat],
      [-18, 0, 13, 0.1, amberMat], [18, 0, 13, 0.1, amberMat],
    ];
    strips.forEach(([x, z, width, depth, material], i) => {
      const strip = MeshBuilder.CreateBox(`floor-guide-${i}`, { width, height: 0.035, depth }, this.scene);
      strip.position.set(x, 0.025, z);
      strip.material = material;
      strip.isPickable = false;
      strip.freezeWorldMatrix();
    });

    const fixtures: Array<[number, number, Color3]> = [
      [-27, -27, cyan], [27, 27, cyan], [-27, 27, amber], [27, -27, amber],
    ];
    fixtures.forEach(([x, z, color], i) => {
      const pole = MeshBuilder.CreateCylinder(`light-pole-${i}`, {
        height: 3.6, diameter: 0.14, tessellation: 10,
      }, this.scene);
      pole.position.set(x, 1.8, z);
      const poleMat = new PBRMaterial(`light-pole-mat-${i}`, this.scene);
      poleMat.albedoColor = new Color3(0.08, 0.11, 0.16);
      poleMat.metallic = 0.75;
      poleMat.roughness = 0.32;
      pole.material = poleMat;
      pole.freezeWorldMatrix();

      const lamp = MeshBuilder.CreateCylinder(`light-fixture-${i}`, {
        height: 0.5, diameter: 0.28, tessellation: 12,
      }, this.scene);
      lamp.position.set(x, 3.65, z);
      lamp.material = this.makeEmissiveMaterial(`fixture-mat-${i}`, color, 3.4);
      lamp.isPickable = false;
      lamp.freezeWorldMatrix();

      const light = new PointLight(`arena-light-${i}`, new Vector3(x, 3.4, z), this.scene);
      light.diffuse = color;
      light.intensity = 10;
      light.range = 18;
    });
  }

  private buildAtmosphere(): void {
    const tex = new DynamicTexture("dust-soft", { width: 32, height: 32 }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "rgba(200,225,255,0.5)");
    gradient.addColorStop(0.35, "rgba(120,190,255,0.18)");
    gradient.addColorStop(1, "rgba(60,120,180,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);
    tex.update();
    tex.hasAlpha = true;

    const dust = new ParticleSystem("ambient-dust", 220, this.scene);
    dust.particleTexture = tex;
    dust.emitter = new Vector3(0, 3.5, 0);
    dust.minEmitBox = new Vector3(-32, -2.8, -32);
    dust.maxEmitBox = new Vector3(32, 3.5, 32);
    dust.color1 = new Color4(0.4, 0.65, 0.9, 0.14);
    dust.color2 = new Color4(0.75, 0.82, 1, 0.08);
    dust.colorDead = new Color4(0.3, 0.45, 0.7, 0);
    dust.minSize = 0.025;
    dust.maxSize = 0.09;
    dust.minLifeTime = 7;
    dust.maxLifeTime = 13;
    dust.emitRate = 16;
    dust.gravity = new Vector3(0, 0.015, 0);
    dust.direction1 = new Vector3(-0.08, 0.02, -0.08);
    dust.direction2 = new Vector3(0.08, 0.08, 0.08);
    dust.minEmitPower = 0.05;
    dust.maxEmitPower = 0.15;
    dust.blendMode = ParticleSystem.BLENDMODE_ADD;
    dust.start();
  }

  private makeEmissiveMaterial(name: string, color: Color3, intensity: number): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = color.scale(0.18);
    material.emissiveColor = color.scale(intensity);
    material.metallic = 0.35;
    material.roughness = 0.3;
    material.disableLighting = true;
    return material;
  }

  private async loadAssets(): Promise<void> {
    const s = this.scene;
    const [blasterD, blasterF, blasterI, grenadeA, grenadeB, target, ...chars] = await Promise.all([
      LoadAssetContainerAsync("/models/blaster-d.glb", s),
      LoadAssetContainerAsync("/models/blaster-f.glb", s),
      LoadAssetContainerAsync("/models/blaster-i.glb", s),
      LoadAssetContainerAsync("/models/grenade-a.glb", s),
      LoadAssetContainerAsync("/models/grenade-b.glb", s),
      LoadAssetContainerAsync("/models/target-large.glb", s),
      ...SKINS.map((c) => LoadAssetContainerAsync(`/models/character-${c}.glb`, s)),
    ]);
    this.weaponContainers.set("blasterD", blasterD);
    this.weaponContainers.set("blasterF", blasterF);
    this.weaponContainers.set("blasterI", blasterI);
    this.weaponContainers.set("grenadeA", grenadeA);
    this.weaponContainers.set("grenadeB", grenadeB);
    this.weaponContainers.set("target", target);
    chars.forEach((c, i) => (this.characterContainers[i] = c));
    this.setViewmodel("mg");
  }

  // ------------------------------------------------------------ state sync --

  private bindState(): void {
    const { room, $ } = this.net;

    $(room.state).players.onAdd((p, id) => {
      if (id !== this.net.sessionId) this.spawnPlayerVisual(p, id);
      else this.players.set(id, {
        root: new TransformNode(`self`, this.scene), state: p,
        nameTag: null as unknown as Mesh, bobPhase: 0, held: null, weapon: "mg",
      });
    });
    $(room.state).players.onRemove((_p, id) => {
      const v = this.players.get(id);
      if (v) {
        v.root.dispose();
        v.nameTag?.dispose();
        this.players.delete(id);
      }
    });

    $(room.state).pickups.onAdd((p, id) => {
      const root = this.makePickupVisual(p, id);
      this.pickupMeshes.set(id, root);
    });
    $(room.state).pickups.onRemove((_p, id) => {
      this.pickupMeshes.get(id)?.dispose();
      this.pickupMeshes.delete(id);
    });

    $(room.state).entities.onAdd((e, id) => {
      this.entityMeshes.set(id, this.makeEntityVisual(e, id));
    });
    $(room.state).entities.onRemove((_e, id) => {
      const v = this.entityMeshes.get(id);
      v?.root.dispose();
      this.entityMeshes.delete(id);
    });
  }

  private spawnPlayerVisual(p: PlayerState, id: string): void {
    const root = new TransformNode(`p-${id}`, this.scene);
    root.position.set(p.x, p.y, p.z);

    const container = this.characterContainers[p.skin % SKIN_COUNT];
    if (container) {
      const inst = container.instantiateModelsToScene((n) => `${id}-${n}`);
      const charRoot = inst.rootNodes[0] as TransformNode;
      fitToSize(charRoot, PLAYER.height);
      charRoot.parent = root;
      charRoot.rotation.y = Math.PI; // face the same way as yaw
      charRoot.getChildMeshes().forEach((m) => this.shadows.addShadowCaster(m));
    }

    const held = this.attachHeldWeapon(root, id, p.weapon);

    const nameTag = this.makeNameTag(p.name, id);
    nameTag.parent = root;
    nameTag.position.y = PLAYER.height + 0.35;

    this.players.set(id, { root, state: p, nameTag, bobPhase: Math.random() * 6, held, weapon: p.weapon });
  }

  private makeNameTag(name: string, id: string): Mesh {
    const tex = new DynamicTexture(`nt-${id}`, { width: 256, height: 64 }, this.scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 256, 64);
    tex.drawText(name, null, 44, "bold 36px sans-serif", "#eaffff", "transparent", true);
    const plane = MeshBuilder.CreatePlane(`ntp-${id}`, { width: 1.4, height: 0.35 }, this.scene);
    const mat = new StandardMaterial(`ntm-${id}`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    plane.material = mat;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    return plane;
  }

  // ---------------------------------------------------------------- input ---

  private bindInput(): void {
    const canvas = this.canvas;
    // Babylon's input manager preventDefault()s raw pointer events by default,
    // which makes the browser suppress the synthesized mouse events we rely on.
    this.scene.preventDefaultOnPointerDown = false;
    this.scene.preventDefaultOnPointerUp = false;

    // Lock on raw pointerdown (synthesized `click` can be suppressed), and
    // retry after Chrome's ~1.25s post-Escape cooldown, during which
    // requestPointerLock() rejects.
    let lockRetry: ReturnType<typeof setTimeout> | null = null;
    const requestLock = (isRetry: boolean) => {
      Promise.resolve(canvas.requestPointerLock()).catch((err) => {
        console.warn("pointer lock rejected:", err?.message ?? err);
        if (!isRetry) lockRetry = setTimeout(() => requestLock(true), 1350);
      });
    };
    canvas.addEventListener("pointerdown", () => {
      if (document.pointerLockElement === canvas) return;
      if (lockRetry) { clearTimeout(lockRetry); lockRetry = null; }
      requestLock(false);
    });
    document.addEventListener("pointerlockchange", () => {
      this.hud.setPausedHint(document.pointerLockElement !== canvas);
    });
    document.addEventListener("pointerlockerror", () => {
      console.warn("pointerlockerror event fired");
    });
    this.hud.setPausedHint(true);

    window.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw += e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
    window.addEventListener("mousedown", (e) => {
      if (document.pointerLockElement === canvas && e.button === 0) this.firing = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false;
    });

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      if (k === "Space") { this.latched.jump = true; e.preventDefault(); }
      if (k === "KeyR") this.latched.reload = true;
      if (k === "Tab") { this.hud.setScoreboardVisible(true); e.preventDefault(); }
      if (k === "KeyL" && this.isHost()) {
        const panel = document.getElementById("host-panel")!;
        panel.classList.toggle("hidden");
        if (!panel.classList.contains("hidden")) document.exitPointerLock();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "Tab" && this.net.room.state.roundPhase !== "ended") {
        this.hud.setScoreboardVisible(false);
      }
    });
  }

  private isHost(): boolean {
    return this.net.room.state.hostId === this.net.sessionId;
  }

  private sendInput(): void {
    const moveX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const moveZ = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const input: PlayerInput = {
      seq: this.seq++,
      moveX,
      moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.latched.jump || this.keys.has("Space"),
      fire: this.firing && this.net.room.state.roundPhase === "playing",
      reload: this.latched.reload,
    };
    this.latched = { jump: false, reload: false };
    this.net.sendInput(input);
  }

  // --------------------------------------------------------------- events ---

  onShot(m: ShotMsg): void {
    this.tracer(m);
    const me = this.myState();
    if (m.id === this.net.sessionId) {
      this.recoil = 1;
      this.audio.play("shot", 0.35);
    } else if (me) {
      const d = Math.hypot(m.ox - me.x, m.oz - me.z);
      this.audio.play("shot", 0.3 * att(d, 45));
    }
  }

  onExplosion(m: ExplosionMsg): void {
    this.explosionFx(m.x, m.y, m.z);
    const me = this.myState();
    const d = me ? Math.hypot(m.x - me.x, m.z - me.z) : 99;
    this.audio.play("explosion", att(d, 50));
    if (d < 25) this.audio.play("bigBoom", att(d, 30));
    this.shake = Math.max(this.shake, 0.5 * att(d, 18) + 0.05);
  }

  onKill(m: KillMsg): void {
    const myId = this.net.sessionId;
    this.hud.addKill(m.killerName, m.victimName, m.cause, m.killerId === myId || m.victimId === myId);
    if (m.killerId === myId && m.victimId !== myId) {
      this.hud.banner(`💀 you got ${m.victimName}`, 1800);
      this.audio.play("hit", 0.8);
    } else if (m.victimId === myId) {
      this.audio.play("death", 0.8);
    }
  }

  onHitConfirm(): void {
    this.hud.flashHitmarker();
    this.audio.play("hit", 0.25);
  }

  onWeaponFx(m: WeaponFxMsg): void {
    if (m.kind === "teleportFx") {
      this.explosionFx(m.x, m.y, m.z, new Color3(0.3, 0.8, 1));
      this.audio.play("respawn", 0.7);
    }
  }

  onPickup(m: { kind: PickupWeaponKind }): void {
    this.hud.banner(`${WEAPONS[m.kind].label.toUpperCase()} ACQUIRED`, 1600);
    this.audio.play("join", 0.7);
  }

  // ---------------------------------------------------------------- frame ---

  private update(dt: number): void {
    const state = this.net.room?.state;
    if (!state) return;
    const k = 1 - Math.exp(-SMOOTH * dt);

    for (const [id, v] of this.players) {
      const p = v.state;
      const isMe = id === this.net.sessionId;
      const target = new Vector3(p.x, p.y, p.z);
      if (Vector3.Distance(v.root.position, target) > SNAP_DIST) v.root.position.copyFrom(target);
      else Vector3.LerpToRef(v.root.position, target, k, v.root.position);

      if (!isMe) {
        if (v.weapon !== p.weapon) {
          v.held?.dispose();
          v.held = this.attachHeldWeapon(v.root, id, p.weapon);
          v.weapon = p.weapon;
        }
        v.root.rotation.y = lerpAngle(v.root.rotation.y, p.yaw, k);
        const meshVisible = p.alive;
        v.root.setEnabled(meshVisible);
        if (p.moving && p.alive) {
          v.bobPhase += dt * 11;
          v.root.position.y += Math.abs(Math.sin(v.bobPhase)) * 0.05;
        }
      }
    }

    // Camera follows my (server-delayed) body; orientation is instant.
    const me = this.players.get(this.net.sessionId);
    if (me) {
      const eye = me.root.position.add(new Vector3(0, PLAYER.eyeHeight, 0));
      if (this.shake > 0.001) {
        eye.addInPlace(new Vector3(
          (Math.random() - 0.5) * this.shake * 0.5,
          (Math.random() - 0.5) * this.shake * 0.5,
          (Math.random() - 0.5) * this.shake * 0.5,
        ));
        this.shake *= Math.exp(-6 * dt);
      }
      this.camera.position.copyFrom(eye);
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = -this.pitch;

      const ms = me.state;
      this.hud.setHealth(ms.hp);
      this.hud.setWeapon(ms.weapon, ms.ammo, ms.reloading);
      this.setViewmodel(ms.weapon);
      this.hud.setPing(this.net.rtt, state.forcedLagMs);
      this.hud.setDead(!ms.alive);
      if (!ms.alive && this.wasAlive) document.exitPointerLock?.();
      if (ms.alive && !this.wasAlive) this.audio.play("respawn", 0.5);
      this.wasAlive = ms.alive;

      // footsteps for my delayed self — you HEAR yourself arrive
      if (ms.alive && ms.moving && performance.now() - this.lastFootstep > 370) {
        this.lastFootstep = performance.now();
        this.audio.play("footstep", 0.18);
      }
    }

    // viewmodel recoil + sway
    if (this.viewmodel) {
      this.recoil *= Math.exp(-14 * dt);
      const t = performance.now() / 1000;
      this.viewmodel.position.z = 0.7 - this.recoil * 0.09;
      this.viewmodel.position.y = -0.3 + Math.sin(t * 1.7) * 0.004;
      this.viewmodel.rotation.x = -this.recoil * 0.06;
    }

    for (const [id, root] of this.pickupMeshes) {
      if (!state.pickups.get(id)) continue;
      root.rotation.y += dt * 1.8;
      root.position.y = 0.35 + Math.sin(performance.now() / 350 + Number(id.slice(1))) * 0.08;
    }
    const blinkOn = Math.sin(performance.now() / 110) > 0;
    for (const [id, v] of this.entityMeshes) {
      const e = state.entities.get(id);
      if (!e) continue;
      const target = new Vector3(e.x, e.y, e.z);
      if (Vector3.Distance(v.root.position, target) > SNAP_DIST) v.root.position.copyFrom(target);
      else Vector3.LerpToRef(v.root.position, target, 1 - Math.exp(-20 * dt), v.root.position);
      v.root.rotation.y = e.yaw;
      if (["grenade", "teleport", "bomblet"].includes(e.kind)) v.root.rotation.x += dt * 6;
      if (v.lamp) {
        const mat = v.lamp.material as StandardMaterial;
        mat.emissiveColor = e.phase === "armed" && blinkOn
          ? new Color3(1, 0.1, 0.1)
          : new Color3(0.18, 0.04, 0.04);
      }
    }

    // scoreboard + win banner
    this.hud.renderScoreboard(
      [...state.players.values()].map((p) => ({
        id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, ping: p.ping, host: p.host,
      })),
      this.net.sessionId,
      state.code,
    );
    const roundEnded = state.roundPhase === "ended";
    this.hud.setRound(state.roundTimeLeftMs, state.roundNumber, roundEnded, this.isHost(), state.winnerName);
    if (roundEnded && this.lastRoundPhase !== "ended") {
      this.firing = false;
      document.exitPointerLock?.();
      const result = state.winnerName === "TIE" ? "ROUND ENDS IN A TIE" : `${state.winnerName} WINS THE ROUND`;
      this.hud.banner(result, 3500);
      this.audio.play("win", 0.9);
    }
    if (!roundEnded && this.lastRoundPhase === "ended") {
      this.hud.setScoreboardVisible(false);
      this.hud.banner(`ROUND ${state.roundNumber}`, 1800);
    }
    this.lastWinner = state.winnerName;
    this.lastRoundPhase = state.roundPhase;
  }

  private myState(): PlayerState | undefined {
    return this.net.room.state.players.get(this.net.sessionId);
  }

  private setViewmodel(kind: WeaponKind): void {
    if (this.viewmodelKind === kind) return;
    this.viewmodel?.dispose();
    this.viewmodelKind = kind;
    const vm = new TransformNode("viewmodel", this.scene);
    vm.parent = this.camera;
    vm.position.set(0.3, -0.28, 0.75);
    const key = modelKey(kind);
    const container = this.weaponContainers.get(key);
    if (container) {
      const inst = container.instantiateModelsToScene((n) => `vm-${kind}-${n}`);
      const root = inst.rootNodes[0] as TransformNode;
      fitToSize(root, key.startsWith("grenade") ? 0.32 : 0.5, "center");
      root.parent = vm;
    }
    this.viewmodel = vm;
  }

  private attachHeldWeapon(parent: TransformNode, id: string, kind: WeaponKind): TransformNode | null {
    const container = this.weaponContainers.get(modelKey(kind));
    if (!container) return null;
    const inst = container.instantiateModelsToScene((n) => `${id}-held-${kind}-${n}`);
    const root = inst.rootNodes[0] as TransformNode;
    fitToSize(root, modelKey(kind).startsWith("grenade") ? 0.3 : 0.6, "center");
    root.parent = parent;
    root.position.set(0.25, 1.05, 0.3);
    return root;
  }

  private makePickupVisual(p: PickupState, id: string): TransformNode {
    const wrap = new TransformNode(`pickup-${id}`, this.scene);
    wrap.position.set(p.x, 0.35, p.z);
    const ring = MeshBuilder.CreateTorus(`pickup-ring-${id}`, { diameter: 1.15, thickness: 0.07 }, this.scene);
    ring.parent = wrap;
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.28;
    ring.material = this.emissiveMaterial(`pickup-mat-${id}`, weaponColor(p.kind));

    const container = this.weaponContainers.get(modelKey(p.kind as WeaponKind));
    if (container) {
      const inst = container.instantiateModelsToScene((n) => `${id}-${n}`);
      const root = inst.rootNodes[0] as TransformNode;
      fitToSize(root, 0.65, "center");
      root.parent = wrap;
    }
    return wrap;
  }

  private makeEntityVisual(e: EntityState, id: string): WorldVisual {
    const wrap = new TransformNode(`entity-${id}`, this.scene);
    wrap.position.set(e.x, e.y, e.z);
    wrap.rotation.y = e.yaw;
    const key = modelKey(e.kind as WeaponKind);
    const container = this.weaponContainers.get(key);
    if (container && ["grenade", "teleport", "claymore", "sticky", "homingMine", "turret"].includes(e.kind)) {
      const inst = container.instantiateModelsToScene((n) => `${id}-${n}`);
      const root = inst.rootNodes[0] as TransformNode;
      fitToSize(root, e.kind === "turret" ? 0.75 : 0.3, e.kind === "turret" ? "feet" : "center");
      root.parent = wrap;
    } else {
      const mesh = ["rocket", "cluster", "ricochet"].includes(e.kind)
        ? MeshBuilder.CreateCapsule(`body-${id}`, { height: 0.5, radius: 0.1 }, this.scene)
        : e.kind === "flame"
          ? MeshBuilder.CreateCylinder(`body-${id}`, { height: 0.05, diameter: 3.8 }, this.scene)
          : MeshBuilder.CreateSphere(`body-${id}`, { diameter: e.kind === "plasma" ? 0.75 : 0.28 }, this.scene);
      mesh.parent = wrap;
      mesh.material = this.emissiveMaterial(`entity-mat-${id}`, weaponColor(e.kind));
      if (e.kind === "flame") mesh.position.y = 0.03;
    }

    let lamp: Mesh | undefined;
    if (["claymore", "homingMine", "turret", "sticky"].includes(e.kind)) {
      lamp = MeshBuilder.CreateSphere(`lamp-${id}`, { diameter: 0.09 }, this.scene);
      lamp.material = this.emissiveMaterial(`lamp-mat-${id}`, new Color3(0.2, 0.05, 0.05));
      lamp.parent = wrap;
      lamp.position.y = e.kind === "turret" ? 0.75 : 0.32;
    }
    return { root: wrap, state: e, lamp };
  }

  private emissiveMaterial(name: string, color: Color3): StandardMaterial {
    const mat = new StandardMaterial(name, this.scene);
    mat.diffuseColor = color.scale(0.35);
    mat.emissiveColor = color;
    mat.disableLighting = true;
    return mat;
  }

  // ------------------------------------------------------------------ fx ----

  private tracer(m: ShotMsg): void {
    const from = new Vector3(m.ox, m.oy, m.oz);
    const to = new Vector3(m.tx, m.ty, m.tz);
    const len = Vector3.Distance(from, to);
    if (len < 0.1) return;
    const beam = MeshBuilder.CreateBox("tracer", { width: 0.025, height: 0.025, depth: len }, this.scene);
    const mat = new StandardMaterial("tm", this.scene);
    mat.emissiveColor = m.kind === "shock"
      ? new Color3(0.3, 0.8, 1)
      : m.hit ? new Color3(1, 0.45, 0.2) : new Color3(1, 0.9, 0.4);
    mat.disableLighting = true;
    mat.alpha = 0.85;
    beam.material = mat;
    beam.position = Vector3.Center(from, to);
    beam.lookAt(to);
    beam.isPickable = false;
    setTimeout(() => { mat.dispose(); beam.dispose(); }, 70);
  }

  private flare(): Texture {
    if (this.flareTex) return this.flareTex;
    const dt = new DynamicTexture("flare", { width: 64, height: 64 }, this.scene, false);
    const ctx = dt.getContext() as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,200,90,0.8)");
    g.addColorStop(1, "rgba(255,120,30,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    dt.update();
    dt.hasAlpha = true;
    this.flareTex = dt;
    return dt;
  }

  private explosionFx(x: number, y: number, z: number, color = new Color3(1, 0.6, 0.25)): void {
    const pos = new Vector3(x, Math.max(0.3, y), z);

    const ps = new ParticleSystem("boom", 90, this.scene);
    ps.particleTexture = this.flare();
    ps.emitter = pos.clone();
    ps.minEmitBox = new Vector3(-0.2, 0, -0.2);
    ps.maxEmitBox = new Vector3(0.2, 0.4, 0.2);
    ps.color1 = new Color4(1, 0.85, 0.4, 1);
    ps.color2 = new Color4(1, 0.4, 0.1, 1);
    ps.colorDead = new Color4(0.25, 0.2, 0.2, 0);
    ps.minSize = 0.6; ps.maxSize = 2.2;
    ps.minLifeTime = 0.25; ps.maxLifeTime = 0.6;
    ps.emitRate = 0;
    ps.manualEmitCount = 90;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, 4, 0);
    ps.direction1 = new Vector3(-5, 1, -5);
    ps.direction2 = new Vector3(5, 7, 5);
    ps.minEmitPower = 2; ps.maxEmitPower = 9;
    ps.disposeOnStop = true;
    ps.start();
    setTimeout(() => ps.stop(), 120);

    const light = new PointLight("boomlight", pos.add(new Vector3(0, 1, 0)), this.scene);
    light.diffuse = color;
    light.intensity = 18;
    light.range = 18;
    const fade = setInterval(() => {
      light.intensity *= 0.8;
      if (light.intensity < 0.4) { clearInterval(fade); light.dispose(); }
    }, 30);
  }
}

// --------------------------------------------------------------- helpers ----

/**
 * Uniformly scale a loaded model. mode "feet": target = bounding HEIGHT, model
 * stands on the origin. mode "center": target = longest axis, model centered.
 */
function fitToSize(root: TransformNode, target: number, mode: "feet" | "center" = "feet"): void {
  const meshes = root.getChildMeshes() as AbstractMesh[];
  if (meshes.length === 0) return;
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bb.minimumWorld);
    max = Vector3.Maximize(max, bb.maximumWorld);
  }
  const size = max.subtract(min);
  const basis = mode === "feet" ? size.y : Math.max(size.x, size.y, size.z);
  if (basis <= 0.0001) return;
  const f = target / basis;
  root.scaling.scaleInPlace(f);
  if (mode === "feet") {
    root.position.y -= min.y * f;
  } else {
    const center = min.add(max).scale(0.5 * f);
    root.position.subtractInPlace(center);
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** simple linear distance attenuation */
function att(d: number, range: number): number {
  return Math.max(0, 1 - d / range);
}

function modelKey(kind: WeaponKind | string): string {
  if (["grenade", "teleport", "sticky", "cluster"].includes(kind)) return kind === "teleport" ? "grenadeB" : "grenadeA";
  if (["claymore", "homingMine", "turret"].includes(kind)) return "target";
  if (["rocket", "shock", "plasma"].includes(kind)) return "blasterD";
  if (["ricochet", "flamethrower"].includes(kind)) return "blasterF";
  return "blasterI";
}

function weaponColor(kind: string): Color3 {
  const colors: Record<string, Color3> = {
    grenade: new Color3(0.3, 1, 0.35),
    claymore: new Color3(1, 0.55, 0.15),
    rocket: new Color3(1, 0.2, 0.1),
    ricochet: new Color3(1, 0.25, 0.85),
    cluster: new Color3(1, 0.8, 0.15),
    flamethrower: new Color3(1, 0.35, 0.05),
    flame: new Color3(1, 0.25, 0.02),
    homingMine: new Color3(0.8, 0.15, 0.15),
    shock: new Color3(0.2, 0.75, 1),
    sticky: new Color3(0.65, 1, 0.2),
    turret: new Color3(0.7, 0.7, 1),
    plasma: new Color3(0.45, 0.2, 1),
    teleport: new Color3(0.15, 0.9, 1),
    bomblet: new Color3(1, 0.75, 0.1),
  };
  return colors[kind] ?? new Color3(1, 0.8, 0.3);
}
