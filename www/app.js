import { withQuickRaceCheats, canSubmitRaceScore } from "./race-cheats.js?v=7ff6fafad2";
import { loadStartupData } from "./app-startup.js?v=7ff6fafad2";
import { playOutcomeVideo } from "./race-outcome.js?v=7ff6fafad2";
// Road Rash front end: original artwork, text (TEXT/ENU.DLL), fonts (TEXT/FUT*.DLL are TrueType Futura Condensed),
// music and videos; races run in race.js, Mano-a-Mano rooms in mano.js.
// Screens copy the original's layouts on its 640x480 canvas: a title box top left, the description under it, and the
// choices along the bottom in a column-major grid (the Restroom lists its items down the left instead).
import { runRace } from "./race.js?v=7ff6fafad2";
import { manoLobby } from "./mano.js?v=7ff6fafad2";
import { track, setActivity } from "./analytics.js?v=7ff6fafad2";
import { AUDIO, isMuted, setMuted, onMute } from "./audio.js?v=7ff6fafad2";
import { offerInstall, shareLinks, WA_ICON, SHARE_ICON } from "./install.js?v=7ff6fafad2";
import { offerPromo } from "./promo.js?v=7ff6fafad2";

const [T, SPEC] = await loadStartupData(document.getElementById("app"), ["./assets/text.json", "./data/bikes.json"]);
const NAV = { 2: "Quick Race", 4: "Career", 6: "Settings", 8: "Main Menu", 13: "Play with Friends", 48: "Race Club", 50: "Bike Shop", 54: "Choose Track", 56: "Back", 86: "Back" };
const t = (id) => NAV[id] ?? T[id] ?? "";
const app = document.getElementById("app");
const img = (p) => `./assets/img/${p}.jpg`;

// ---- Game data (names and blurbs from the game's text table) ----
const TRACKS = [
  { id: "city", name: t(16), blurb: t(21), card: "city" },
  // menu order = the EXE's course table (0x46c558): City, Hiway, Medly, Napa, Canyn; names are text 16-20
  { id: "hiway", name: t(17), blurb: t(22), card: "sierra" },
  { id: "medly", name: t(18), blurb: t(23), card: "penin" },
  { id: "napa", name: t(19), blurb: t(24), card: "napa" },
  { id: "canyn", name: t(20), blurb: t(25), card: "pch" },
];
// race length per track and level in tenths of a mile (EXE 0x468f58, [track * 5 + level - 1], track order as TRACKS)
const TRACK_LEN = [[53, 84, 115, 135, 163], [53, 79, 98, 129, 171], [53, 80, 110, 150, 168], [50, 76, 106, 128, 185], [55, 81, 110, 126, 161]];
const CLASSES = [{ id: "rat", name: t(58), blurb: t(59) }, { id: "sport", name: t(60), blurb: t(61) }, { id: "super", name: t(62), blurb: t(63) }];
const BIKE_PICS = { rat: ["banzai", "corsair", "kamikaze", "perro", "killer"], sport: ["diablo", "kamikaze", "stiletto", "dmg", "perro"], super: ["banzai", "diablo", "stiletto", "corsair", "kamikaze"] };
// Shop order (text table) is Rat, Sport, Super; the game's internal bike ids are Rat 0-4, Super 5-9, Sport 10-14.
const shopToId = (i) => (i < 5 ? i : i < 10 ? 10 + (i - 5) : 5 + (i - 10));
const BIKES = [...Array(15)].map((_, i) => {
  const cls = CLASSES[(i / 5) | 0].id, desc = t(144 + i), spec = SPEC.bikes[shopToId(i)], pic = BIKE_PICS[cls][i % 5];
  const [hp, lb] = (desc.match(/(\d+) HP\/(\d+) lb/) || [0, 50, 400]).slice(1).map(Number);
  return { i, id: spec.id, cls, brand: t(96 + i), model: t(112 + i), full: t(128 + i), desc, hp, lb, price: spec.price, floor: `showroom/${cls}/${pic}`, pic: `bikes/${cls}/${pic}`, video: `${cls}/${pic}`,
    spec, grip: { rat: 1.05, sport: 1, super: 0.95 }[cls] };
});
const byId = (id) => BIKES.find((b) => b.id === id);
const raceBike = (b) => ({ top: b.spec.top / 2.237, topMph: b.spec.top, spec: b.spec, gears: b.spec.gears, nitro: b.spec.nitro, grip: b.grip, cls: b.cls });
// Characters from the EXE: rider row (height, weight, stamina...), starting cash and starting bike (decoded in tools/bikes.js).
const CHARS = ["axle", "bose", "cydney", "jon", "pearl", "rhonda", "jim", "mike"].map((id, i) => { const c = SPEC.chars[i], r = SPEC.riders[c.row];
  return { id, i, name: t(32 + i), short: t(358 + i), bio: t(40 + i), scheme: [5, 2, 10, 8, 1, 4, 11, 6][i], bike: byId(c.bike).i, cash: c.cash, row: c.row, rider: r }; });
// Rider record fields as race options: weight feeds the bike physics; strength, stamina and weapon drive fights.
const riderOpts = (r) => ({ weight: r.weight, stamina: r.stamina, weaponKind: [null, "club", "chain"][r.weapon] ?? null, strength: r.strength });
const RIVAL_NAMES = [...Array(30)].map((_, i) => t(320 + i)).filter((n) => n && n !== "*");
const BANDS = [225, 226, 227, 228, 229, 230].map((id, k) => ({ id, name: t(id), blurb: t(231 + k) }));
const SONGS = [
  ["hb_trip", 225, 241], ["hb_pass", 225, 242], ["mm_dino", 226, 243], ["p_pansy", 227, 244], ["p_jessie", 227, 245], ["p_bridge", 227, 246],
  ["sg_rusty", 228, 247], ["sg_outsh", 228, 248], ["sg_kicks", 228, 249], ["sg_super", 228, 250], ["sd_train", 229, 251], ["sd_duel", 229, 252],
  ["t_teeth", 230, 253], ["t_auto", 230, 254],
].map(([file, band, title]) => ({ file, bandId: band, band: t(band), title: t(title) }));
const MUSIC_VIDEOS = [{ name: "Paw — Jessie", file: "jessie" }, { name: "Swervedriver — Duel", file: "duel" }];
const PURSE = [3000, 2500, 2200, 2000, 1800, 1600, 1400, 1200]; // prize money by place, from the EXE (scaled by level)
const SCHMOOZE = Object.entries(T).filter(([k, v]) => +k >= 500 && +k < 1000 && v.length > 25 && !/[%|]/.test(v)).map(([, v]) => v);

// ---- State ----
const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const save = load("rr-save");
const S = { mode: "thrash", level: 1, cars: false, song: "random", char: null, cash: 1000, bike: 4, owned: [4], qualified: {}, name: "Player 1",
  mix: { master: 1, music: 1, sfx: 1, engine: 1, others: 1, siren: 1 }, ...(save || {}) };
// Chase (3rd person) is the default view; saves from builds where the handlebar view was the default get reset once.
let persistedState = JSON.stringify(S);
const persist = () => { try { const state = JSON.stringify(S); if (state !== persistedState) { localStorage.setItem("rr-save", state); persistedState = state; } } catch {} };
if (!S.viewV2) { S.view = "chase"; S.viewV2 = true; persist(); }
// Players who never picked a name get a Road Rash-style one (shown on the leaderboard, in rooms and races); nameAuto
// stays true until they change it, so results screens keep offering the name box.
const HANDLE_A = ["Mad", "Slick", "Wild", "Iron", "Rusty", "Crazy", "Lucky", "Dirty", "Turbo", "Nitro", "Greasy", "Rowdy", "Psycho", "Hot", "Big", "Lil"];
const HANDLE_B = ["Viper", "Chain", "Biscuit", "Spoke", "Throttle", "Wheelie", "Gravel", "Piston", "Knuckles", "Burnout", "Muffler", "Kickstand", "Asphalt", "Sprocket", "Clutch", "Crowbar"];
const pick = (a) => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length];
if (!S.name || /^Player \d+$/.test(S.name)) { S.name = `${pick(HANDLE_A)} ${pick(HANDLE_B)}`.slice(0, 16); S.nameAuto = true; persist(); }
const MS = ["master", "music", "sfx", "engine", "others", "siren"]; S.mix = { master: 1, music: 1, sfx: 1, engine: 1, others: 1, siren: 1, ...(S.mix || {}) };
persist();
// Progress and preferences save on changes; also flush when leaving the page.
// Keep the existing rr-save key so returning players retain their progress.
addEventListener("pagehide", persist);
document.addEventListener("visibilitychange", () => { if (document.hidden) persist(); });

// ---- Music ----
let menuTune = null, nowPlaying = null;
function menuMusic(on = true, song) {
  if (!on) { menuTune?.pause(); return; }
  if (menuTune && !menuTune.paused && !song) return;
  menuTune?.pause();
  nowPlaying = song || (S.song !== "random" && SONGS.find((x) => x.file === S.song)) || SONGS[(Math.random() * SONGS.length) | 0];
  menuTune = new Audio(`./assets/music/${nowPlaying.file}.${AUDIO}`); menuTune.volume = Math.min(1, 0.4 * S.mix.music * S.mix.master); menuTune.loop = true; menuTune.muted = isMuted(); menuTune.play()?.catch(() => {});
}
const raceSong = () => { const s = S.song === "random" ? SONGS[(Math.random() * SONGS.length) | 0] : SONGS.find((x) => x.file === S.song) || SONGS[0]; return { url: `./assets/music/${s.file}.${AUDIO}`, ...s }; };
const sfx = (n, v = 0.6) => { if (isMuted()) return; const a = new Audio(`./assets/sfx/${n}.wav`); a.volume = Math.min(1, v * S.mix.sfx * S.mix.master); a.play()?.catch(() => {}); };

// ---- Screen kit ----
let keyHandler = null;
addEventListener("keydown", (e) => { if (typeof e.key !== "string") return; if (keyHandler) { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key) && e.target?.tagName !== "INPUT" && !e.target?.closest?.(".credits-screen, .front-menu")) e.preventDefault(); keyHandler(e); } });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
// the 640x480 stage, scaled to fit the window
function fit() { const st = app.querySelector(".stage"), dock = app.querySelector(".mobile-menu"); if (st) { const dockHeight = dock?.offsetHeight || 0; st.style.transform = `scale(${Math.min(app.clientWidth / 640, (app.clientHeight - dockHeight) / 480)})`; st.style.translate = dockHeight ? `0 ${-dockHeight / 2}px` : ""; } }
addEventListener("resize", fit);
window.visualViewport?.addEventListener("resize", fit);
let mobileMenuObserver = null;
function dockTouchMenus(...lists) {
  if (!matchMedia("(pointer: coarse)").matches) return;
  const dock = document.createElement("nav"); dock.className = "mobile-menu"; dock.setAttribute("aria-label", "Game choices");
  for (const list of lists) dock.appendChild(list);
  app.appendChild(dock); fit();
  mobileMenuObserver?.disconnect();
  mobileMenuObserver = new MutationObserver(fit);
  for (const list of lists) mobileMenuObserver.observe(list, { childList: true, subtree: true });
}
function stage(bgHtml, html = "") {
  mobileMenuObserver?.disconnect(); mobileMenuObserver = null;
  app.innerHTML = `<div class="stage">${bgHtml}${html}</div>`; fit();
  return app.firstElementChild;
}
const bgImg = (src) => `<img class="bg" src="${src}">`;
// A screen: background, title box, description and a grid of choices along the bottom (column-major, `rows` rows).
// items: [{label, desc, title, go, off, onShow}]; title: fixed string, or null to show the selected item's label.
function gridScreen({ bg, title = null, items, rows = 1, cols, status, foot, right = false, start = 0, back, onMove }) {
  const root = stage(bg, `<div class="tbox${right ? " right" : ""}"><span class="title"></span></div><div class="desc"></div>${foot !== undefined ? `<div class="foot">${foot}</div>` : ""}
    ${status ? `<div class="status">${status}</div>` : ""}<div class="mbar"></div><ul class="grid"></ul>`);
  const nc = cols || Math.ceil(items.length / rows), ul = root.querySelector(".grid");
  const colX = nc === 4 ? [24, 184, 344, 504] : nc === 2 ? [104, 384] : nc === 3 ? [24, 236, 450] : [...Array(nc)].map((_, c) => 24 + (c * 592) / nc), rowY = rows === 1 ? [422] : [422, 451];
  if (rows > 2) rowY.splice(0, 2, ...[...Array(rows)].map((_, r) => 404 + r * 24));
  root.querySelector(".mbar").style.top = `${rowY[0] - 3}px`;
  ul.innerHTML = items.map((it, i) => `<li data-i="${i}" class="${it.off ? "off" : ""}" style="left:${colX[(i / rows) | 0]}px;top:${rowY[i % rows]}px">${esc(it.label)}</li>`).join("");
  if (matchMedia("(pointer: coarse)").matches) {
    dockTouchMenus(ul); root.querySelector(".mbar").style.display = "none";
  }
  let sel = Math.min(start, items.length - 1); if (items[sel]?.off) sel = items.findIndex((x) => !x.off);
  const show = () => {
    ul.querySelectorAll("li").forEach((li, i) => li.classList.toggle("on", i === sel));
    const it = items[sel], tl = root.querySelector(".title"); tl.textContent = it.title ?? title ?? it.label; tl.style.marginRight = `${-0.26 * tl.offsetWidth}px`;
    const d = root.querySelector(".desc"); d.textContent = it.desc ?? ""; d.classList.toggle("right", !!it.descRight);
    onMove?.(it, sel, root);
  };
  const pick = () => { const it = items[sel]; if (!it.off) { sfx("bounce", 0.4); it.go(); } };
  const move = (d) => { const r = sel % rows, c = (sel / rows) | 0; let n = sel;
    if (d === "up") n = r > 0 ? sel - 1 : sel; else if (d === "down") n = r < rows - 1 && sel + 1 < items.length ? sel + 1 : sel;
    else if (d === "left") n = c > 0 ? sel - rows : sel; else if (d === "right") n = sel + rows < items.length ? sel + rows : c < nc - 1 ? items.length - 1 : sel;
    if (n !== sel && !items[n].off) { sel = n; show(); } else if (n !== sel) { sel = n; move(d); } };
  ul.onmousemove = (e) => { const li = e.target.closest("li"); if (li && +li.dataset.i !== sel && !items[+li.dataset.i].off) { sel = +li.dataset.i; show(); } };
  ul.onclick = (e) => { const li = e.target.closest("li"); if (li && !items[+li.dataset.i].off) { sel = +li.dataset.i; show(); pick(); } };
  keyHandler = (e) => {
    const k = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[e.key];
    if (k) move(k); else if (e.key === "Enter" || e.key === " ") pick(); else if (e.key === "Escape") (back || items.at(-1).go)();
  };
  show(); return { root, select: (i) => { sel = i; show(); } };
}
function video(name, then) {
  menuMusic(false);
  app.innerHTML = `<div class="full"><video class="cut" src="./assets/video/${name}.mp4" autoplay playsinline></video><div class="hint">Enter or click to skip</div></div>`;
  const v = app.querySelector("video"); let gone = false; v.muted = isMuted();
  const end = () => { if (gone) return; gone = true; v.pause(); keyHandler = null; then(); };
  v.onended = end; v.onerror = end; app.firstElementChild.onclick = end; keyHandler = (e) => { if (["Enter", "Escape", " "].includes(e.key)) end(); };
  v.play()?.catch(() => { if (gone) return; v.muted = true; v.play()?.catch(end); });
  return end;
}
// Use the original outcome clips without applying Career's money or progression changes.
function outcomeVideo(res, then) {
  return playOutcomeVideo(video, res, then);
}
// Sound on/off: a speaker button at the top right of every menu screen (races have M and the pause menu), M anywhere
const muteButton = document.createElement("button");
muteButton.className = "mute-toggle"; muteButton.type = "button";
const paintMute = (m) => { muteButton.textContent = m ? "🔇" : "🔊"; muteButton.setAttribute("aria-label", m ? "Sound off. Turn sound on" : "Sound on. Turn sound off"); muteButton.title = m ? "Sound off (M)" : "Sound on (M)"; };
paintMute(isMuted()); document.body.append(muteButton);
muteButton.onclick = () => setMuted(!isMuted());
onMute((m) => { paintMute(m); if (menuTune) menuTune.muted = m; const v = app.querySelector("video.cut"); if (v) v.muted = m; track("sound_toggled", { muted: m }); });
addEventListener("keydown", (e) => { if (e.key?.toLowerCase() === "m" && !document.getElementById("race") && !e.target?.closest?.("input,textarea,select")) setMuted(!isMuted()); });
// a dark message box over the current screen with one or two choices
function alertBox(head, body, then, { choices } = {}) {
  const st = app.querySelector(".stage") || stage("");
  const box = document.createElement("div"); box.className = "alert";
  const opts = choices || [{ label: t(205), go: then }];
  box.innerHTML = `${head ? `<div class="ah">${esc(head)}</div>` : ""}<div class="ab">${esc(body)}</div><div class="ac">${opts.map((o, i) => `<span data-i="${i}">${esc(o.label)}</span>`).join("")}</div>`;
  st.appendChild(box); let sel = 0;
  const show = () => box.querySelectorAll(".ac span").forEach((s, i) => s.classList.toggle("on", i === sel)); show();
  const done = (i) => { box.remove(); opts[i].go(); };
  box.onclick = (e) => { const s = e.target.closest("span"); if (s) done(+s.dataset.i); };
  keyHandler = (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { sel = (sel + 1) % opts.length; show(); } else if (e.key === "Enter" || e.key === " ") done(sel); else if (e.key === "Escape") done(opts.length - 1); };
}
const statusLine = () => S.mode === "big" ? `${esc(CHARS.find((c) => c.id === S.char)?.short || S.name)}&emsp;${t(91 + S.level - 1)}&emsp;${t(29)}: $${S.cash}` : `${esc(S.name)}&emsp;${t(91 + S.level - 1)}`;

// ---- Screens ----
// Native menu controls keep their normal keyboard, focus and touch behavior.
function menuScreen(heading, html, { back = title, home = false, art = "credits" } = {}) {
  mobileMenuObserver?.disconnect(); mobileMenuObserver = null;
  app.innerHTML = `<main class="front-menu${home ? " menu-home" : ""}">
    <img class="menu-art" src="${img(art)}" alt="">
    <div class="menu-wrap"><header class="menu-header"><span class="menu-brand">ROAD RASH</span>${home ? "" : '<button class="quiet" data-back type="button">← Back</button>'}</header>
    <div class="menu-body"><h1 tabindex="-1">${heading}</h1>${html}</div></div></main>`;
  const root = app.firstElementChild;
  for (const button of root.querySelectorAll("button")) button.setAttribute("aria-label", button.textContent.trim());
  root.querySelector('[data-back]')?.addEventListener('click', back);
  keyHandler = e => {
    // Leave text editing and native select navigation to the browser.
    if (e.target?.closest?.('input,select,textarea')) return;
    if (e.key === 'Escape') { e.preventDefault(); back(); return; }
    const buttons = [...root.querySelectorAll('.menu-body button')].filter(b=>!b.disabled && b.getClientRects().length);
    if (!buttons.length) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();
      let i = buttons.indexOf(document.activeElement);
      if (i < 0) i = Math.max(0, buttons.findIndex(b=>b.classList.contains('primary')));
      const d = ['ArrowDown','ArrowRight'].includes(e.key) ? 1 : -1;
      buttons[(i+d+buttons.length)%buttons.length].focus();
    } else if (e.key === 'Enter' && !e.target?.closest?.('button,summary,a')) {
      e.preventDefault(); (buttons.find(b=>b.classList.contains('primary')) || buttons[0]).click();
    }
  };
  root.querySelector('h1').focus({preventScroll:true});
  return root;
}
function title() {
  const root = menuScreen('Road <span>Rash</span>', `<nav class="home-actions" aria-label="Play">
    <button class="primary" data-play>Race Now</button>
    <button data-friends>Play with Friends</button>
    <button data-career>${S.char ? 'Continue Career' : 'Career'}</button>
    <button data-garage>Garage</button>
    <button data-board>Leaderboard</button>
    </nav><p class="home-caption">A classic. One click from the starting line.</p>
    <nav class="home-footer" aria-label="More"><button class="quiet" data-settings>Settings</button><button class="quiet" data-help>How to Play</button><button class="quiet" data-credits>Credits</button><button class="quiet" data-fullscreen>Fullscreen</button><button class="quiet" data-quit>Quit</button></nav>`, {home:true,art:"splash"});
  root.querySelector('[data-play]').onclick = () => { track('menu_choice', {choice: 'race_now'}); S.mode = 'thrash'; persist(); race(TRACKS[0], {quick:true}); };
  root.querySelector('[data-friends]').onclick = () => { track('menu_choice', {choice: 'friends'}); S.mode = 'mano'; persist(); mano(); };
  root.querySelector('[data-garage]').onclick = () => { track('menu_choice', {choice: 'garage'}); openGarage(title); };
  root.querySelector('[data-board]').onclick = () => { track('menu_choice', {choice: 'leaderboard'}); leaderboard(); };
  root.querySelector('[data-career]').onclick = () => { track('menu_choice', {choice: S.char ? 'continue_career' : 'career'}); startCareer(); };
  root.querySelector('[data-settings]').onclick = () => restroom(title);
  root.querySelector('[data-help]').onclick = () => howToPlay(title);
  root.querySelector('[data-credits]').onclick = () => credits(title);
  root.querySelector('[data-fullscreen]').onclick = () => window.__openrashToggleFullscreen?.();
  root.querySelector('[data-quit]').onclick = () => window.__openrashQuit?.();
}
function howToPlay(back = title) {
  menuScreen('How to Play', `<p>Race to the finish. Stay on the road, dodge rivals and fight your way through.</p>
    <div class="menu-card"><h2>Keyboard</h2><dl class="control-list"><dt>Accelerate / Brake</dt><dd>↑ / ↓ (or W / S)</dd><dt>Steer</dt><dd>← / → (or A / D)</dd><dt>Punch</dt><dd>Space or Z</dd><dt>Kick</dt><dd>K or C</dd><dt>Nitro (Super bikes only)</dt><dd>N</dd><dt>Camera View</dt><dd>V (Chase / Handlebar)</dd><dt>Sound On / Off</dt><dd>M</dd><dt>Fullscreen</dt><dd>F11 or Alt + Enter</dd><dt>Pause</dt><dd>Escape</dd></dl></div>
    <div class="menu-card"><h2>Nitro</h2><p>Only Super bikes carry nitro: a few shots of extra speed, shown as dots next to NITRO at the top of the screen. Press N during a race. Race Now gives you a nitro bike at levels 4 and 5 (Settings → Quick race difficulty); open Garage from the main menu to buy a Super bike for Career.</p></div>
    <div class="menu-card"><h2>Cheats</h2><p>In Race Now, pause with Escape, then choose Cheats. Pick from the list or enter a code such as SPOON! for nitro. Using a cheat makes that race unscored. Cheats reset for the next race and are unavailable in Career or multiplayer.</p></div>`, {back});
}
function startCareer(next = careerMenu) {
  S.mode = 'big';
  if (!S.char) { const c = CHARS[0]; Object.assign(S,{char:c.id,cash:c.cash,bike:c.bike,owned:[c.bike],level:1,qualified:{}}); }
  persist(); next();
}
function careerMenu() {
  menuMusic();
  const root = menuScreen('Your Career', `<p>Level ${S.level} · $${S.cash.toLocaleString()} · ${esc(BIKES[S.bike].full)}</p>
    <div class="home-actions"><button class="primary" data-race>Choose a Race</button><button data-shop>Garage / Bike Shop</button><button data-rider>New Career</button></div>
    <p class="menu-muted">Finish in the top three on every track to reach the next level. Progress saves automatically.</p>`,{art:'street'});
  root.querySelector('[data-race]').onclick = () => trackSelect(careerMenu);
  root.querySelector('[data-shop]').onclick = () => openGarage(careerMenu);
  root.querySelector('[data-rider]').onclick = () => { if (confirm('Start a new career? This resets your rider, money and race progress.')) charSelect(careerMenu); };
}
// Race Now results: Race Again counts down and starts the next race by itself (58% of players stopped after one race).
// A tap, key or scroll stops the countdown (Enter or Space starts the race now); held keys left over from the race
// (auto-repeat) and anything in the first second don't count. It waits while the tab is hidden and never follows a quit.
const AUTO_NEXT_S = 10;
function autoNext(root, res, go) {
  const btn = root.querySelector('[data-again]'); if (!btn || res.status === 'quit') return;
  const label = btn.textContent, events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  let left = AUTO_NEXT_S, timer = null; const shown = performance.now();
  const stop = (outcome) => { if (!timer) return; clearInterval(timer); timer = null; btn.textContent = label; for (const e of events) removeEventListener(e, onInput, true); track('auto_next', { outcome, status: res.status }); };
  const onInput = (e) => {
    if (e.repeat || performance.now() - shown < 1000 || e.target.closest?.('[data-again]')) return;
    if (e.type === 'keydown' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); stop('key'); go(); return; }
    stop('cancelled');
  };
  for (const e of events) addEventListener(e, onInput, true);
  btn.onclick = () => { stop('clicked'); go(); };
  btn.textContent = `${label} (${left})`;
  timer = setInterval(() => {
    if (!btn.isConnected) return stop('left');
    if (document.visibilityState !== 'visible') return;
    if (--left <= 0) { stop('started'); go(); } else btn.textContent = `${label} (${left})`;
  }, 1000);
}
function quickResult(tr, res) {
  menuMusic();
  const heading = res.status === 'finished' ? `You finished #${res.place}` : res.status === 'quit' ? 'Race ended' : res.status === 'busted' ? 'Busted!' : 'Wrecked!';
  const time = res.time ? `${Math.floor(res.time/60)}:${(res.time%60).toFixed(2).padStart(5,'0')}` : '';
  let brag = !res.usedCheats && res.status === 'finished' && time ? `I finished #${res.place} on ${tr.name} in ${time} in Road Rash. Think you can beat that?` : 'I’m playing Road Rash on Linux. Come race me!';
  let share = shareLinks(brag, 'https://roadrash.fun/');
  const root = menuScreen(heading, `<p>${esc(tr.name)}${time ? ` · ${time}` : ''}</p>${res.usedCheats ? '<p>CHEATS USED · UNSCORED</p>' : ''}${res.score ? scoreHTML() : ''}
    <div class="home-actions"><button class="primary" data-again>Race Again</button><button data-track>Change Track</button><button data-home>Main Menu</button></div>
    <div class="menu-actions share-actions"><span class="menu-muted">Challenge a friend</span><button class="icon-btn" data-wa>${WA_ICON}WhatsApp</button>${share.native ? `<button class="icon-btn" data-share>${SHARE_ICON}Share…</button>` : ''}<button data-friends>Race with friends</button></div>`);
  root.querySelector('[data-wa]').onclick = () => { window.open(share.wa, '_blank', 'noopener'); track('result_shared', { method: 'whatsapp', status: res.status }); };
  root.querySelector('[data-share]')?.addEventListener('click', () => share.native().then(() => track('result_shared', { method: 'share', status: res.status })).catch(() => {}));
  root.querySelector('[data-friends]').onclick = () => { S.mode = 'mano'; mano(); };
  if (res.score) showScore(root, res.score, (line) => { brag = line; share = shareLinks(brag, 'https://roadrash.fun/?board'); });
  root.querySelector('[data-again]').onclick = () => race(tr,{quick:true});
  root.querySelector('[data-home]').onclick = title;
  root.querySelector('[data-track]').onclick = () => {
    const r = menuScreen('Choose a Track', `<nav class="track-list" aria-label="Tracks">${TRACKS.map(x=>`<button class="${x.id===tr.id?'primary':''}" data-track-id="${x.id}">${esc(x.name)}</button>`).join('')}</nav>`);
    for (const button of r.querySelectorAll('[data-track-id]')) button.onclick = () => race(TRACKS.find(x=>x.id===button.dataset.trackId),{quick:true});
  };
  offerInstall(root.querySelector('.menu-body'), S.raced || 0) || offerPromo(root.querySelector('.menu-body'), S.raced || 0, 'results');
  autoNext(root, res, () => race(tr, {quick: true})); // last: the countdown takes over Race Again (it used to be overwritten)
}
// ---- Leaderboards: every finished race earns points; boards for today and this week, by city, country and world ----
// (/api/board -> the relay's Leaderboard objects). Players are a random id kept in this browser, shown by their name.
const playerId = () => { try { let id = localStorage.getItem('rr-id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('rr-id', id); } return id; } catch { return null; } };
// ISO country code -> flag emoji (regional indicator letters); Windows shows the two letters instead of a flag
const flag = (code) => /^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '';
const countryName = (code) => { try { return new Intl.DisplayNames([navigator.language || 'en'], {type: 'region'}).of(code) || code; } catch { return code; } };
const named = () => S.name && !/^Player \d+$/.test(S.name);
const setName = (value) => { const n = String(value || '').trim().slice(0, 16); if (n) { S.name = n; S.nameAuto = false; persist(); } };
// resolves with a signed race ticket (or null when offline); never throws
function raceTicket(trackId, level) {
  const pid = playerId(); if (!pid) return Promise.resolve(null);
  return fetch('/api/race', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({pid, track: trackId, level}), signal: AbortSignal.timeout(10000)})
    .then((x) => (x.ok ? x.json() : null)).then((x) => x?.ticket || null).catch(() => null);
}
// resolves with the server's answer ({points, day, week}) or null; never throws
function submitScore(r) {
  if (!r.ticket) return Promise.resolve(null);
  const pid = playerId(); if (!pid) return Promise.resolve(null);
  return fetch('/api/board', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({pid, name: named() ? S.name : 'Rider', ...r}), signal: AbortSignal.timeout(10000)})
    .then(async (x) => { if (x.ok) return x.json(); const e = await x.json().catch(() => ({})); track('score_rejected', { status: x.status, error: e.error, why: e.why, mode: r.mode, track: r.track, level: r.level, time_s: Math.round(r.time), samples: r.trace?.length }); return null; }).catch(() => null)
    .then((b) => { track('score_saved', { saved: !!b?.points, points: b?.points, mode: r.mode, rank_day_world: b?.day?.world?.rank ?? undefined, rank_day_city: b?.day?.city?.rank ?? undefined }); return b; });
}
// "+12 points · #3 in Pune today" on a results screen, plus a name box for players still called "Player 1"
const scoreHTML = () => `<div class="score-line"><p class="score-big" data-score>Adding your points…</p>${S.nameAuto ? `<label class="score-name">Your name on the leaderboard<input data-lb-name maxlength="16" autocomplete="nickname" value="${esc(S.name)}"></label>` : ''}</div>`;
function scoreRanks(day) { return day ? [day.city && [day.city.rank, day.city.name], day.country && [day.country.rank, countryName(day.country.code)], [day.world.rank, 'the world']].filter((x) => x && x[0]) : []; }
function showScore(root, pending, onBrag) {
  const input = root.querySelector('[data-lb-name]');
  if (input) input.onchange = () => setName(input.value);
  pending.then((b) => {
    const el = root.querySelector('[data-score]'); if (!el?.isConnected) return;
    if (!b) { el.textContent = 'Couldn’t add your points this time.'; return; }
    const ranks = scoreRanks(b.day);
    el.innerHTML = `+${b.points} points${ranks.length ? ` · ${ranks.map(([n, w]) => `#${n} in ${esc(w)}`).join(' · ')} today` : ''}`;
    if (ranks.length) onBrag?.(`I'm #${ranks[0][0]} in ${ranks[0][1]} on Road Rash today. Race me:`);
  });
}
function boardHTML(b, period) {
  const list = (sec, heading, flags = false) => sec ? `<section class="menu-card"><h2>${esc(heading)}</h2>${sec.top.length ? `<ol class="board-list">${sec.top.map((r) => `<li class="${b.you && r.name === b.you.name && r.points === b.you.points ? 'me' : ''}"><span>${flags && flag(r.country) ? `<span class="flag" title="${esc(countryName(r.country))}">${flag(r.country)}</span> ` : ''}${esc(r.name)}</span><span>${r.points}</span></li>`).join('')}</ol>` : '<p class="menu-muted">No points yet. Be the first.</p>'}
    <p class="menu-muted">${sec.rank ? `You: #${sec.rank} of ${sec.riders}` : `${sec.riders} rider${sec.riders === 1 ? '' : 's'} ${period}`}</p></section>` : '';
  return `<div class="boards">${list(b.city, b.city?.name)}${list(b.country, b.country && countryName(b.country.code))}${list(b.world, 'World', true)}</div>`;
}
async function leaderboard(period = 'day') {
  menuMusic();
  menuScreen('Leaderboard', '<p>Loading the leaderboard…</p>');
  let all; try { const r = await fetch(`/api/board?pid=${encodeURIComponent(playerId() || '')}`, {signal: AbortSignal.timeout(10000)}); if (!r.ok) throw Error(); all = await r.json(); } catch {
    const r = menuScreen('Leaderboard', '<p>Couldn’t load the leaderboard. Check your connection and try again.</p><div class="home-actions"><button class="primary" data-retry>Try Again</button></div>');
    r.querySelector('[data-retry]').onclick = () => leaderboard(period); return; }
  const b = all[period], label = period === 'day' ? 'today' : 'this week';
  const root = menuScreen('Leaderboard', `<div class="board-tabs" role="tablist">${[['day', 'Today'], ['week', 'This Week']].map(([k, n]) => `<button role="tab" aria-selected="${k === period}" class="${k === period ? 'primary' : ''}" data-period="${k}">${n}</button>`).join('')}</div>
    <p class="menu-muted">Every race you finish earns points: Race Now, Career and Play with Friends. Better places and harder levels earn more.</p>
    ${b.you ? `<p class="score-big">You: ${b.you.points} points from ${b.you.races} race${b.you.races === 1 ? '' : 's'} ${label}</p>` : ''}
    <label style="max-width:320px">Your name on the leaderboard<input data-name maxlength="16" autocomplete="nickname" placeholder="Pick a name"></label>
    <div class="home-actions"><button class="primary" data-race>Race Now</button></div>${boardHTML(b, label)}`);
  const name = root.querySelector('[data-name]'); name.value = S.name;
  name.onchange = () => setName(name.value);
  root.classList.add('wide-screen');
  offerPromo(root.querySelector('.menu-body'), S.raced || 0, 'leaderboard');
  for (const t of root.querySelectorAll('[data-period]')) t.onclick = () => leaderboard(t.dataset.period);
  root.querySelector('[data-race]').onclick = () => { S.mode = 'thrash'; persist(); race(TRACKS[0], {quick: true}); };
}
// Invite links are normal product navigation, not development launch hooks.
function boot() {
  const invite = new URL(location.href).searchParams.get('room');
  if (invite) { track('invite_opened', { new_player: !save }); S.mode = 'mano'; mano(invite); }
  else if (['board', 'daily'].some((k) => new URL(location.href).searchParams.has(k))) { track('board_link_opened', {}); leaderboard(); } else title();
}

// Preserve the complete original PC / 3DO roll, including cast, localization and music.
// ENU.DLL prefixes Y/O/G/- select the original text styles; they are not part of the copy.
function credits(back = title) {
  mobileMenuObserver?.disconnect(); mobileMenuObserver = null;
  const roll = Object.entries(T).filter(([id]) => +id >= 1001 && +id <= 1361).map(([, line]) => {
    const text = line.slice(1);
    if (!text.trim()) return '<div class="credits-gap" aria-hidden="true"></div>';
    const tag = line[0] === "Y" ? "h3" : "p";
    return `<${tag}>${esc(text)}</${tag}>`;
  }).join("");
  app.innerHTML = `<section class="credits-screen" aria-labelledby="credits-heading" tabindex="-1">
    <header><h1 id="credits-heading">Credits</h1><button type="button">Back to game</button></header>
    <div class="credits-content">
      <h2>Browser version</h2>
      <p>Browser adaptation by <a href="https://kayode.me" target="_blank" rel="noopener noreferrer">olucurious</a>.</p>
      <p>Rendering powered by <a href="https://threejs.org/" target="_blank" rel="noopener noreferrer">Three.js</a>.</p>
      <h2>Original game</h2>
      <p>Road Rash was created by Electronic Arts. The PC version was developed with Papyrus Design Group, based on Road Rash for 3DO.</p>
      <p>Thank you to the original developers, artists, performers and musicians who made this game. Original artwork, characters, music and other game assets belong to their respective owners.</p>
      <p class="credits-source">The complete credits below are reproduced from the original PC game's English credits, including its 3DO production credits.</p>
      ${roll}
    </div>
  </section>`;
  const screen = app.querySelector(".credits-screen");
  screen.querySelector("button").onclick = back;
  keyHandler = (e) => { if (e.key === "Escape") back(); };
  screen.focus();
}

// Older career call sites still return here.
function gameMode() { title(); }

function trackSelect(back) {
  const big = S.mode === "big"; back ||= big ? klub : gameMode;
  const items = TRACKS.map((tr) => ({ label: tr.name, desc: tr.blurb.split("\n")[0], go: () => race(tr), tr }));
  items.push(big ? { label: t(48), desc: t(49), go: klub } : { label: t(6), desc: t(7), go: () => restroom(() => trackSelect(back)) });
  gridScreen({ bg: `${bgImg(img("postcard"))}<img class="pc" src="${img("postcard/city")}">`, items, rows: 2, status: statusLine(), back,
    foot: "", onMove: (it, i, root) => {
      const card = it.tr ? (big && S.qualified[`${S.level}:${it.tr.id}`] ? `q${it.tr.card}` : it.tr.card) : big ? "klub" : "resta";
      root.querySelector(".pc").src = img(`postcard/${card}`);
      root.querySelector(".foot").textContent = it.tr ? `Length: ${(TRACK_LEN[TRACKS.indexOf(it.tr)][S.level - 1] / 10).toFixed(1)} ${t(27)}` : "";
    } });
}

function charSelect(back = gameMode) {
  const items = CHARS.map((c) => ({ label: c.name, go: () => pick(c), c }));
  const pick = (c) => { Object.assign(S, { char: c.id, cash: c.cash, bike: c.bike, owned: [c.bike], level: 1, qualified: {}, view: S.view || "chase" }); persist(); sfx("m_yeah"); street(); };
  gridScreen({ bg: bgImg(img("chars/axle-n")) + `<div class="stats"></div>`, items, rows: 3, cols: 3, right: true, back, onMove: (it, i, root) => {
    const c = it.c, bike = BIKES[c.bike];
    root.querySelector(".bg").src = img(`chars/${c.id}-n`);
    const ht = `${Math.floor(c.rider.height / 12)}'${c.rider.height % 12}"`, wt = t(4001).replace("%d", c.rider.weight);
    root.querySelector(".stats").textContent = c.bio.replace("%s", ht).replace("%s", wt).replace("%s", bike.full).replace("%d", c.cash);
  } });
}

// The street: Der Panzer Klub, Olley's and home; the lit shopfront swaps with the choice (street/*.jpg at 146,230)
function street() { careerMenu(); }
function klub() { careerMenu(); }

function schmooze() {
  const others = CHARS.filter((c) => c.id !== S.char);
  const c = others[(Math.random() * others.length) | 0], mood = ["n", "h", "f"][(Math.random() * 3) | 0];
  const line = SCHMOOZE[(Math.random() * SCHMOOZE.length) | 0];
  sfx(["sk1_dude", "bkm1_hey", "bsm1_wat", "cm1_heym"][(Math.random() * 4) | 0], 0.5);
  const root = stage(bgImg(img(`chars/${c.id}-${mood}`)), `<div class="desc big">${esc(line)}</div>`);
  const done = () => klub(); root.onclick = done; keyHandler = (e) => { if (["Enter", "Escape", " "].includes(e.key)) done(); };
}

let garageBack = careerMenu;
function openGarage(back) {
  garageBack = back;
  startCareer(olleys);
}
function olleys() {
  menuMusic();
  gridScreen({ bg: bgImg(img("olleys")), status: statusLine(), rows: 2, back: garageBack, items: [
    { label: t(58), desc: t(59), go: () => showroom("rat") },
    { label: t(60), desc: t(61), go: () => showroom("sport") },
    { label: t(62), desc: t(63), go: () => showroom("super") },
    { label: "Back", desc: garageBack === title ? "Return to the main menu." : "Return to your career.", go: garageBack },
  ] });
}

// trade-in: half the current bike's price, rounded down (Swallow $3249 -> $1624, as the original's Cash+Trade shows)
const tradeIn = () => Math.floor(BIKES[S.bike].price / 2);
function showroom(cls, start = 0) {
  const list = BIKES.filter((b) => b.cls === cls), cur = BIKES[S.bike];
  const items = list.map((b) => ({ label: b.brand, title: b.full, desc: "", go: () => bikeDetail(b, cls, list.indexOf(b)), b }));
  items.push({ label: t(90), title: CLASSES.find((c) => c.id === cls).name, desc: "", go: olleys });
  const { root: sr } = gridScreen({ bg: bgImg(img(`showroom/${cls}/bikes`)), right: true, rows: 2, start, foot: "",
    status: `${esc(CHARS.find((c) => c.id === S.char)?.short || "")}&emsp;${t(29)}+${t(30)}: $${S.cash + tradeIn()}&emsp;${t(31)}: ${esc(cur.model)}`, items,
    onMove: (it, i, root) => { root.querySelector(".bg").src = img(it.b ? it.b.floor : `showroom/${cls}/bikes`); root.querySelector(".foot").textContent = it.b ? `Price: $${it.b.price}` : ""; } });
  sr.querySelector(".foot").style.top = "347px";
}

function bikeDetail(b, cls, idx) {
  const show = () => {
    const own = S.bike === b.i;
    const { root } = gridScreen({ bg: bgImg(img(b.pic)), right: true, rows: 1, cols: 2, back: () => showroom(cls, idx),
      status: `${esc(CHARS.find((c) => c.id === S.char)?.short || "")}&emsp;${t(29)}+${t(30)}: $${S.cash + tradeIn()}&emsp;${t(31)}: ${esc(BIKES[S.bike].model)}`,
      items: [{ label: own ? "Riding" : t(217), title: b.full, desc: b.desc.replace("$%d", `$${b.price}`), descRight: true, go: () => buy(), off: own },
        { label: t(218), title: b.full, desc: b.desc.replace("$%d", `$${b.price}`), descRight: true, go: () => showroom(cls, idx) }], start: own ? 1 : 0 });
    app.querySelector(".grid").style.top = "29px";
  };
  const buy = () => {
    const budget = S.cash + tradeIn();
    if (budget < b.price) { alertBox(t(185), t(186), show); return; }
    S.cash = budget - b.price; S.owned = [b.i]; S.bike = b.i; persist(); sfx("engsport", 0.5);
    alertBox(t(189), t(190), show);
  };
  // the showroom spins the bike on video first, then holds on its picture
  video(b.video, show);
}

// ---- Restroom (options), as the original: the list down the left, explanations and choices in boxes on the right ----
function restroom(back = title) {
  const root = menuScreen('Settings', `<div class="menu-stack">
    <label>Player name<input id="player-name" maxlength="16" autocomplete="nickname"></label>
    <div class="menu-columns"><label>Camera<select aria-label="Camera" id="camera"><option value="chase">Chase view</option><option value="fps">Handlebar view</option></select></label>
    <label>Quick race difficulty<select aria-label="Quick race difficulty" id="difficulty">${[1,2,3,4,5].map(n=>`<option value="${n}">Level ${n}${n===1?' · Easy':n>=4?' · Nitro bike':''}</option>`).join('')}</select></label></div>
    <label class="check-label"><input id="traffic" type="checkbox"> Cars in quick races</label>
    <h2>Audio</h2><div class="menu-columns">${[['master','Master volume'],['music','Music'],['sfx','Sound effects'],['engine','Engine']].map(([k,label])=>`<label>${label}<input type="range" data-mix="${k}" min="0" max="1" step="0.1"></label>`).join('')}</div>
    <div class="menu-actions"><button data-music>Choose Music</button><button data-controls>Controls</button></div>
    <p class="menu-muted">Changes and career progress save automatically on your Linux system.</p></div>`, {back,art:'restroom/rest1'});
  const name = root.querySelector('#player-name'); name.value = S.name;
  name.onchange = () => { setName(name.value); name.value = S.name; };
  const camera = root.querySelector('#camera'); camera.value=S.view || 'chase'; camera.onchange=()=>{S.view=camera.value;persist();};
  const level=root.querySelector('#difficulty');level.value=S.quickLevel || 1;level.onchange=()=>{S.quickLevel=+level.value;persist();};
  const cars=root.querySelector('#traffic');cars.checked=S.cars!==false;cars.onchange=()=>{S.cars=cars.checked;persist();};
  for(const slider of root.querySelectorAll('[data-mix]')) {slider.value=S.mix[slider.dataset.mix];slider.oninput=()=>{S.mix[slider.dataset.mix]=+slider.value;persist();if(menuTune)menuTune.volume=Math.min(1,.4*S.mix.music*S.mix.master);};}
  root.querySelector('[data-music]').onclick=()=>jukebox(()=>restroom(back));
  root.querySelector('[data-controls]').onclick=()=>howToPlay(()=>restroom(back));
}

function jukebox(back) {
  const items = BANDS.map((b) => ({ label: b.name, desc: b.blurb, band: b }));
  items.push({ label: "Videos", desc: "Watch a band's video.", vids: true }, { label: t(86), desc: t(87), done: true });
  const root = stage(`${bgImg(img(`restroom/rest${1 + ((Math.random() * 6) | 0)}`))}<div class="rpanel"></div>`, `<div class="tbox"><span class="title">${t(80)}</span></div><ul class="rlist jb"></ul><div class="rdesc"></div><ul class="rsub"></ul><div class="nowp"></div>`);
  const ul = root.querySelector(".rlist"), desc = root.querySelector(".rdesc"), sub = root.querySelector(".rsub"), np = root.querySelector(".nowp");
  dockTouchMenus(ul, sub);
  ul.innerHTML = items.map((it, i) => `<li data-i="${i}">${esc(it.label)}</li>`).join("");
  let sel = 0, subSel = -1, subs = [];
  const subsOf = (it) => it.band ? SONGS.filter((s) => s.bandId === it.band.id).map((s) => ({ label: `“${s.title}”`, on: S.song === s.file, go: () => { S.song = s.file; persist(); menuMusic(true, s); } }))
    : it.vids ? MUSIC_VIDEOS.map((v) => ({ label: v.name, go: () => video(v.file, () => jukebox(back)) })) : [];
  const show = () => {
    ul.querySelectorAll("li").forEach((li, i) => li.classList.toggle("on", i === sel && subSel < 0)); desc.textContent = items[sel].desc;
    subs = subsOf(items[sel]); sub.innerHTML = subSel < 0 ? "" : subs.map((s, i) => `<li data-i="${i}" class="${s.on ? "cur" : ""}${i === subSel ? " on" : ""}">${esc(s.label)}</li>`).join("");
    sub.style.top = `${Math.min(296, 384 - subs.length * 33)}px`;
    np.innerHTML = nowPlaying ? esc(t(11).replace("%s", nowPlaying.band).replace("%s", nowPlaying.title)).replace("\n", "<br>") : "";
  };
  const pick = () => { const it = items[sel]; if (it.done) return back(); if (subs.length) { subSel = 0; show(); } };
  keyHandler = (e) => {
    if (subSel >= 0) { if (e.key === "ArrowUp") subSel = Math.max(0, subSel - 1); else if (e.key === "ArrowDown") subSel = Math.min(subs.length - 1, subSel + 1); else if (e.key === "Enter" || e.key === " ") { subs[subSel].go(); if (items[sel].vids) return; } else if (e.key === "Escape") subSel = -1; show(); return; }
    if (e.key === "ArrowUp") { sel = (sel + items.length - 1) % items.length; show(); } else if (e.key === "ArrowDown") { sel = (sel + 1) % items.length; show(); }
    else if (e.key === "Enter" || e.key === " ") pick(); else if (e.key === "Escape") back();
  };
  ul.onclick = (e) => { const li = e.target.closest("li"); if (li) { sel = +li.dataset.i; subSel = -1; show(); pick(); } };
  sub.onclick = (e) => { const li = e.target.closest("li"); if (li) { subSel = +li.dataset.i; subs[subSel].go(); if (!items[sel].vids) show(); } };
  show();
}

// ---- Mano-a-Mano (mano.js): rooms over the local server's relay ----
function mano(invite, { online = false } = {}) {
  manoLobby({ invite, online, menuScreen, app, stage, gridScreen, dockTouchMenus, alertBox, bgImg, img, t, esc, S, persist, CHARS, TRACKS, TRACK_LEN, BIKES, SPEC, raceBike, riderOpts, raceSong, menuMusic, video, outcomeVideo,
    setKeys: (h) => { keyHandler = h; }, back: gameMode, restroom: (b) => restroom(b),
    // a tournament host only watches: no help level, points or race counting
    runRace: (opts) => opts.spectate ? (track("round_watched", { track: opts.course }), runRace(opts)) : playRace(opts, { mode: opts.publicRace ? "online" : "mano", track: opts.course, level: opts.level, riders: (opts.net?.peers?.length ?? 0) + 1 }) });
}

// ---- Race ----
// every race reports how it started and ended (analytics.js)
// Dynamic help, 0-1 (not in Career, which keeps the original rules): almost half of players left after one race, and a
// quarter of first races ended BUSTED inside two minutes. New players, and anyone whose last races keep ending in a
// crash, bust or quit, get fewer crossing pedestrians and road hazards, slightly slower rivals (race.js opts.assist)
// and, from 0.7, no police. It fades as they finish races and drops faster when they start winning.
function assistLevel() {
  const n = Math.max(0, (S.raced || 0) - (S.cheatedRaces || 0)), recent = (S.recent || []).slice(-4);
  let a = n < 3 ? 1 : n < 6 ? 0.7 : n < 12 ? 0.4 : 0.15;
  if (recent.length >= 3 && recent.filter((r) => r !== "finished" && r !== "win").length >= 3) a += 0.3;
  if (recent.filter((r) => r === "win").length >= 2) a -= 0.3;
  return Math.max(0, Math.min(1, a));
}
async function playRace(opts, meta) {
  let usedCheats = false;
  opts = withQuickRaceCheats(opts, meta.mode);
  opts.onCheat = (cheat) => {
    if (!usedCheats) { usedCheats = true; S.cheatedRaces = (S.cheatedRaces || 0) + 1; persist(); }
    track("cheat_used", { mode: meta.mode, track: opts.course, cheat });
  };
  const t0 = performance.now(), assist = meta.mode === "career" ? 0 : assistLevel();
  if (assist) opts = { ...opts, assist, ...(assist >= 0.7 && { police: false }) };
  S.raced = (S.raced || 0) + 1; persist();
  meta = { ...meta, police: opts.police !== false, assist: +assist.toFixed(2), race_number: S.raced };
  track("race_started", meta);
  const ticket = raceTicket(opts.course, opts.level); // the server's signed start time; results are only scored with it
  setActivity("racing");
  const res = await runRace(opts).finally(() => setActivity("menu"));
  if (usedCheats) res.usedCheats = true;
  if (!res.usedCheats) {
    S.recent = [...(S.recent || []), res?.status === "finished" ? (res.place === 1 ? "win" : "finished") : res?.status || "none"].slice(-6);
    persist();
  }
  // ride: how far along the course, how long into the race, place then, crashes, and how a quit happened (race.js)
  const ride = res?.ride || {};
  track("race_ended", { ...meta, used_cheats: !!res?.usedCheats, status: res?.status ?? "none", place: res?.place, time_s: res?.time ? +res.time.toFixed(2) : undefined, duration_s: Math.round((performance.now() - t0) / 1000),
    progress: ride.progress, race_s: ride.at_s, place_now: ride.place_now, field: ride.field, recovery_stage: ride.recovery_stage, off_bike_s: ride.off_bike_s, crashes: ride.crashes, last_crash: ride.last_crash, crash_recent: ride.crash_recent, mph: ride.mph, quit_how: ride.how, race_id: opts.net?.raceId, interruption_kind: ride.interruption_kind, interruption_reason: ride.interruption_reason, socket_code: ride.socket_code, tab_hidden: ride.tab_hidden });
  // Only races without cheats earn leaderboard points; results show them when the server answers.
  if (canSubmitRaceScore(res)) res.score = ticket.then((t) => submitScore({ track: opts.course, level: opts.level, place: res.place, field: (opts.rivals?.length ?? 0) + (opts.net?.peers?.length ?? 0) + 1, time: res.time, trace: res.trace, ticket: t, mode: meta.mode }));
  return res;
}
async function race(tr, {quick = false} = {}) {
  menuMusic(false);
  if (!quick) await new Promise((ok) => video(`start${1 + ((Math.random() * 6) | 0)}`, ok)); // the original's pre-race clips
  const lvl = quick ? (S.quickLevel || 1) : S.level, mine = S.mode === "big" ? BIKES[S.bike] : BIKES.find((b) => b.id === SPEC.rivals[8][lvl - 1]);
  const ch = CHARS.find((c) => c.id === S.char) || CHARS[0];
  const scheme = S.mode === "big" ? ch.scheme : 1;
  const pool = [...Array(15).keys()].filter((x) => x !== scheme).sort(() => Math.random() - 0.5);
  const names = [...RIVAL_NAMES].sort(() => Math.random() - 0.5);
  // rivals ride the bikes the original assigns them for this level (EXE table: 16 riders x 5 levels)
  // the full field of 16 (EXE 0x4642d4): the other 15 riders, each starting from its own grid slot (rider index into the
  // grid table 0x464218; the player's slot is its rider index too, 0x4b8a10)
  const me = S.mode === "big" ? ch.row : 8;
  const rows = [...SPEC.rivals.keys()].filter((r) => r !== me);
  const rivals = rows.map((row, k) => {
    const b = byId(SPEC.rivals[row][lvl - 1]) || mine;
    return { slot: row, name: names[k % names.length], scheme: pool[k % pool.length], skill: 0.9 + lvl * 0.015 + Math.random() * 0.06, bike: raceBike(b), ...riderOpts(SPEC.riders[row]) };
  });
  const song = raceSong();
  app.innerHTML = `<div id="race"></div>`;
  keyHandler = null;
  const res = await playRace({ container: document.getElementById("race"), quitText: t(316), course: tr.id, scheme, rivals, music: song.url, playerName: S.mode === "big" ? ch.short : S.name,
    cheatNames: quick ? Array.from({ length: 6 }, (_, i) => t(320 + TRACKS.findIndex(x => x.id === tr.id) * 6 + i)) : undefined,
    bike: raceBike(mine), rider: riderOpts(S.mode === "big" ? ch.rider : SPEC.riders[8]), slot: me, level: lvl, brains: SPEC.brains, swing: SPEC.swing, band: SPEC.band, traffic: S.cars !== false, mix: S.mix,
    view: S.view || "chase", onView: (v) => { S.view = v; persist(); } },
    { mode: quick ? "quick" : S.mode === "big" ? "career" : S.mode, track: tr.id, level: lvl, view: S.view || "chase" });
  if (res.status === 'unavailable') return quick ? title() : trackSelect();
  if (quick) return outcomeVideo(res, () => quickResult(tr,res));
  results(tr, res);
}

// a results screen: picture, headline, lines of text, OK
function resultScreen(pic, head, lines, then) {
  menuMusic();
  gridScreen({ bg: bgImg(img(pic)), items: [{ label: t(205), title: head, desc: lines.join("\n"), go: then }] });
  app.querySelector(".desc").classList.add("results");
}

function results(tr, res) {
  if (!res) { S.mode === "big" ? street() : trackSelect(); return; }
  if (res.status === "quit") return penalty(tr, "wrecked"); // quitting a race counts as a wreck in the original (same screens and penalty)
  if (res.status === "busted" || res.status === "wrecked") return penalty(tr, res.status);
  const won = res.place === 1, qualified = res.place <= 3, n = 1 + ((Math.random() * 6) | 0);
  const kind = qualified ? "win" : "lose", vid = qualified ? `win${n}` : `lose${1 + ((Math.random() * 10) | 0)}`;
  let lines = res.place <= 3 ? [t(201 + res.place - 1).replace("%s", S.mode === "big" ? CHARS.find((c) => c.id === S.char)?.short : S.name)] : [`You finished #${res.place}. ${t(199)}`];
  let after = S.mode === "big" ? street : () => trackSelect();
  if (S.mode === "big") {
    const purse = res.place <= PURSE.length ? PURSE[res.place - 1] * S.level : 0;
    S.cash += purse; lines.push(`Purse: $${purse}`);
    if (qualified) S.qualified[`${S.level}:${tr.id}`] = true;
    if (TRACKS.every((x) => S.qualified[`${S.level}:${x.id}`]) && S.level < 5) {
      lines.push(t(200)); const L = S.level; S.level++;
      after = () => video(`level${L}`, () => levelScreen(L));
    } else if (TRACKS.every((x) => S.qualified[`5:${x.id}`])) { lines.push(t(376)); after = () => video("finalwin", gameMode); }
    persist();
  }
  lines.push(`Time: ${Math.floor(res.time / 60)}:${(res.time % 60).toFixed(2).padStart(5, "0")}`);
  video(vid, () => resultScreen(`results/${kind}${n}`, won ? t(178) : qualified ? t(181) : t(179), [tr.name, ...lines], after));
}

// Busted or wrecked (EXE 0x4214e0): the fine is $400 x level ((level0 * 5 + 5) * 80), repairs cost a tenth of the
// bike's price; either costs every qualification on this level, and a rider who can't pay is out of the game.
function penalty(tr, status) {
  const wreck = status === "wrecked", n = 1 + ((Math.random() * 6) | 0);
  const who = CHARS.find((c) => c.id === S.char)?.short || t(191);
  const cost = wreck ? Math.floor(BIKES[S.bike].price / 10) : 400 * S.level;
  const lines = [tr.name, wreck ? t(192) : t(195)];
  const broke = S.mode === "big" && S.cash < cost;
  if (S.mode === "big" && !broke) {
    S.cash -= cost; lines.push(t(wreck ? 194 : 197).replace("%s", who).replace("%d", cost), t(wreck ? 193 : 196).replace(/\n/g, " "));
    for (const x of TRACKS) delete S.qualified[`${S.level}:${x.id}`];
    persist();
  }
  if (broke) lines.push(t(198));
  video(`${wreck ? "wreck" : "busted"}${n}`, () => resultScreen(`results/${wreck ? "wreck" : "bust"}${n}`, t(wreck ? 176 : 177), lines,
    broke ? () => { S.char = null; persist(); gameMode(); } : S.mode === "big" ? street : () => trackSelect()));
}

function levelScreen(L) { resultScreen(`results/level${Math.min(4, L)}`, t(180), [t(200)], street); }

boot();
