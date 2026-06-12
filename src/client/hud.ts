// All DOM/HUD manipulation lives here so game.ts stays about the 3D scene.

import type { KillCause } from "@shared/protocol";

const CAUSE_ICON: Record<KillCause, string> = {
  mg: "🔫",
  grenade: "💣",
  claymore: "💥",
};

export interface ScoreRow {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  ping: number;
  host: boolean;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export class Hud {
  onSetLag: ((ms: number) => void) | null = null;
  private lastHp = 100;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Host lag console wiring
    const slider = el<HTMLInputElement>("lag-slider");
    const num = el<HTMLInputElement>("lag-number");
    const apply = (ms: number) => {
      ms = Math.max(0, Math.min(10000, Math.round(ms)));
      slider.value = String(ms);
      num.value = String(ms);
      this.onSetLag?.(ms);
    };
    slider.addEventListener("input", () => apply(Number(slider.value)));
    num.addEventListener("change", () => apply(Number(num.value)));
    document.querySelectorAll<HTMLButtonElement>(".hp-presets button").forEach((b) => {
      b.addEventListener("click", () => apply(Number(b.dataset.lag)));
    });
  }

  show(): void {
    el("hud").classList.remove("hidden");
    el("lobby").classList.add("hidden");
  }

  setHealth(hp: number): void {
    const fill = el("health-fill");
    fill.style.width = `${hp}%`;
    fill.classList.toggle("low", hp <= 35);
    el("health-num").textContent = String(hp);
    if (hp < this.lastHp) this.flashDamage();
    this.lastHp = hp;
  }

  setAmmo(ammo: number, reloading: boolean): void {
    const n = el("ammo-num");
    n.classList.toggle("reloading", reloading);
    n.textContent = reloading ? "RELOADING" : String(ammo);
  }

  setSupplies(grenades: number, claymores: number): void {
    el("grenade-pips").textContent = "● ".repeat(grenades).trim() || "—";
    el("claymore-pips").textContent = "▲ ".repeat(claymores).trim() || "—";
  }

  setPing(naturalMs: number, forcedMs: number): void {
    el("ping-natural").textContent = `ping ${Math.round(naturalMs)}ms`;
    const f = el("ping-forced");
    f.classList.toggle("hidden", forcedMs === 0);
    f.textContent = `+lag ${(forcedMs / 1000).toFixed(1)}s`;

    const banner = el("lag-banner");
    banner.classList.toggle("hidden", forcedMs === 0);
    el("lag-value").textContent = `${(forcedMs / 1000).toFixed(1)}s`;

    // keep host console in sync when someone else… well, only the host edits it,
    // but reflect server state after clamping.
    const slider = el<HTMLInputElement>("lag-slider");
    if (document.activeElement !== slider && document.activeElement?.id !== "lag-number") {
      slider.value = String(forcedMs);
      el<HTMLInputElement>("lag-number").value = String(forcedMs);
    }
  }

  addKill(killerName: string, victimName: string, cause: KillCause, involvesMe: boolean): void {
    const feed = el("killfeed");
    const entry = document.createElement("div");
    entry.className = "kf-entry" + (involvesMe ? " me" : "");
    entry.innerHTML = `<span class="killer"></span> ${CAUSE_ICON[cause]} <span class="victim"></span>`;
    (entry.querySelector(".killer") as HTMLElement).textContent = killerName;
    (entry.querySelector(".victim") as HTMLElement).textContent = victimName;
    feed.prepend(entry);
    while (feed.children.length > 6) feed.lastChild?.remove();
    setTimeout(() => entry.remove(), 6000);
  }

  banner(text: string, ms = 2500): void {
    const b = el("center-banner");
    b.textContent = text;
    b.classList.remove("hidden");
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => b.classList.add("hidden"), ms);
  }

  setDead(dead: boolean): void {
    el("death-overlay").classList.toggle("hidden", !dead);
  }

  flashHitmarker(): void {
    const h = el("hitmarker");
    h.classList.add("show");
    setTimeout(() => h.classList.remove("show"), 60);
  }

  private flashDamage(): void {
    const v = el("damage-vignette");
    v.classList.add("show");
    setTimeout(() => v.classList.remove("show"), 80);
  }

  setScoreboardVisible(visible: boolean): void {
    el("scoreboard").classList.toggle("hidden", !visible);
  }

  renderScoreboard(rows: ScoreRow[], myId: string, code: string): void {
    el("sb-code").textContent = code ? `party ${code}` : "";
    const body = el("sb-body");
    body.innerHTML = "";
    rows
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .forEach((r) => {
        const tr = document.createElement("tr");
        if (r.id === myId) tr.className = "me";
        const crown = r.host ? "👑" : "";
        tr.innerHTML = `<td>${crown}</td><td></td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.ping}ms</td>`;
        (tr.children[1] as HTMLElement).textContent = r.name;
        body.appendChild(tr);
      });
  }

  setHostPanelVisible(visible: boolean): void {
    el("host-panel").classList.toggle("hidden", !visible);
  }

  setPausedHint(visible: boolean): void {
    el("paused-hint").classList.toggle("hidden", !visible);
  }

  toast(): void {
    const t = el("share-toast");
    t.classList.remove("hidden");
    setTimeout(() => t.classList.add("hidden"), 1800);
  }
}
