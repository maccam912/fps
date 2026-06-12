// Tiny pooled audio player for Kenney .ogg one-shots + music loops.

const ONESHOTS = {
  shot: ["laserSmall_000.ogg", "laserSmall_001.ogg", "laserSmall_002.ogg", "laserSmall_003.ogg"],
  explosion: ["explosionCrunch_000.ogg", "explosionCrunch_002.ogg", "explosionCrunch_004.ogg"],
  bigBoom: ["lowFrequency_explosion_000.ogg"],
  hit: ["impactMetal_000.ogg", "impactMetal_002.ogg"],
  respawn: ["forceField_000.ogg"],
  footstep: [
    "footstep_concrete_000.ogg", "footstep_concrete_001.ogg",
    "footstep_concrete_002.ogg", "footstep_concrete_003.ogg",
  ],
  click: ["click_001.ogg"],
  join: ["confirmation_001.ogg"],
  death: ["back_001.ogg"],
  win: ["bong_001.ogg"],
} as const;

export type SfxName = keyof typeof ONESHOTS;

export class AudioMan {
  // shared across instances so the game can replace the lobby's music
  private static music: HTMLAudioElement | null = null;
  private unlocked = false;

  constructor() {
    // Browsers require a user gesture before audio plays.
    const unlock = () => {
      this.unlocked = true;
      AudioMan.music?.play().catch(() => {});
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  /** volume 0..1; pass distance-based attenuation from the caller. */
  play(name: SfxName, volume = 1): void {
    if (!this.unlocked || volume <= 0.02) return;
    const files = ONESHOTS[name];
    const file = files[Math.floor(Math.random() * files.length)];
    const a = new Audio(`/audio/${file}`);
    a.volume = Math.min(1, volume);
    a.play().catch(() => {});
  }

  playMusic(file: "music-lobby.ogg" | "music-game.ogg", volume = 0.25): void {
    if (AudioMan.music?.src.endsWith(file)) return;
    AudioMan.music?.pause();
    AudioMan.music = new Audio(`/audio/${file}`);
    AudioMan.music.loop = true;
    AudioMan.music.volume = volume;
    if (this.unlocked) AudioMan.music.play().catch(() => {});
  }
}
