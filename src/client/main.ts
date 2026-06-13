import { Net } from "./net";
import { Game } from "./game";
import { AudioMan } from "./audio";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const nameInput = $<HTMLInputElement>("name-input");
const codeInput = $<HTMLInputElement>("code-input");
const durationInput = $<HTMLInputElement>("round-duration");
const errBox = $("lobby-error");

const ADJ = ["Laggy", "Rubber", "Packet", "Jitter", "Buffer", "Choppy", "Dialup", "Pingy"];
const NOUN = ["Bander", "Loss", "Storm", "Ghost", "Sniper", "Gremlin", "Walrus", "Wizard"];
function randomName(): string {
  return ADJ[(Math.random() * ADJ.length) | 0] + NOUN[(Math.random() * NOUN.length) | 0];
}
function randomCode(): string {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join("");
}

nameInput.value = localStorage.getItem("lagwar-name") ?? randomName();
const urlCode = new URLSearchParams(location.search).get("code");
if (urlCode) codeInput.value = urlCode.toUpperCase();

async function join(code: string, roundDurationMinutes?: number): Promise<void> {
  const name = nameInput.value.trim() || randomName();
  localStorage.setItem("lagwar-name", name);
  errBox.classList.add("hidden");
  try {
    const net = new Net();
    const canvas = $<HTMLCanvasElement>("game-canvas");
    const game = new Game(canvas, net);
    await net.connect(code, name, {
      onKill: (m) => game.onKill(m),
      onExplosion: (m) => game.onExplosion(m),
      onShot: (m) => game.onShot(m),
      onWeaponFx: (m) => game.onWeaponFx(m),
      onPickup: (m) => game.onPickup(m),
      onHitConfirm: () => game.onHitConfirm(),
    }, roundDurationMinutes);

    // Exposed for the headless smoke test.
    (window as any).__lagwar = { net, game };

    // Put the party code in the URL so the link IS the invite.
    const url = new URL(location.href);
    url.searchParams.set("code", code.toUpperCase());
    history.replaceState(null, "", url.toString());

    await game.start();
  } catch (e) {
    console.error(e);
    errBox.textContent = "couldn't reach the server — is it running?";
    errBox.classList.remove("hidden");
  }
}

$("create-btn").addEventListener("click", () => {
  const minutes = Math.max(1, Math.min(60, Number(durationInput.value) || 5));
  join(codeInput.value.trim() || randomCode(), minutes);
});
$("join-btn").addEventListener("click", () => {
  const code = codeInput.value.trim();
  if (!code) {
    errBox.textContent = "enter a party code first";
    errBox.classList.remove("hidden");
    return;
  }
  join(code);
});
codeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-btn").click();
});

// lobby ambience
new AudioMan().playMusic("music-lobby.ogg", 0.2);
