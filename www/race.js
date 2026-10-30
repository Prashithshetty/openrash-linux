import { track as recordRaceEvent } from "./analytics.js?v=7ff6fafad2";
import { loadRaceImage } from "./race-images.js?v=7ff6fafad2";
import { createQuickRaceCheats, mountQuickRaceCheats, quickRaceCheatsAllowed } from "./race-cheats.js?v=7ff6fafad2";
import { recoveryLane } from "./race-recovery.js?v=7ff6fafad2";
// Race on a decoded Road Rash course: player + rival riders using the original sprite frames.
// runRace(opts) resolves with { place, time, status } where status is "finished" or "quit".
import * as THREE from "three";
import { courseMap, mountCourseMap } from "./race-map.js?v=7ff6fafad2";
import { isMuted, setMuted, onMute } from "./audio.js?v=7ff6fafad2";
import { angleDelta, decodeBranch, identityChart, alignChart, transformFrame } from "./road-path.js?v=7ff6fafad2";
import { bakeJoinMasks, JOIN_STEPS } from "./road-join.js?v=7ff6fafad2";
import { TiltSteering } from "./tilt-steering.js?v=7ff6fafad2";
import { rememberPose, renderPose, safeCameraLat } from "./race-motion.js?v=7ff6fafad2";
import { withRaceScreen, raceJSON } from "./race-startup.js?v=7ff6fafad2";

// One RPTH step is ~4.85 m: track position advances v>>8 (v in mph*100) per 1/256 step at 60 Hz, which matches the
// lateral units and the track-select mileages. A step turns the heading by atan(a/256)/2 (node 0xb4 = atan table of the
// path byte; the rider's yaw at 0x4394c0 takes half of it per step) and climbs b/256 of its length.
const STEP = 4.85, HALF = 7, KERB = 1.2, GRASS = 80, PX = 0.0135;
const turnOf = (a) => Math.atan(a / 256) / 2, KS = STEP / 256;
const M = (m) => m / STEP; // metres -> steps, for ranges that are about distance on screen
const HORIZON = { city: "city", napa: "napa", hiway: "sierra", canyn: "pch", medly: "penin" };
const SIDE = { city: "SCTSIDWK", napa: "SAND", hiway: "SAND", canyn: "SAND", medly: "SCTSIDWK" };
// Sprite frames (HIBOB.DAT): 0-3 lean levels seen from behind (0 = full lean, 3 = upright, mirrored for the other side),
// punches 41-50, crash/slide 241-247.
const PUNCH = [44, 45, 44], CRASH = [241, 242, 243, 244, 245, 246, 247];
// Off the bike (as in the original): tumble 256-276, lie 282, get up 283-289, walk toward the camera 291-296, away
// 297-302, sideways 303-308 (facing left), pick the bike up and remount 309-313; the bike lying alone 319-322.
const TUMBLE = [256, 257, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276],
  GETUP = [283, 284, 285, 286, 288, 289], WALK_TO = [291, 292, 293, 294, 295, 296], WALK_AWAY = [297, 298, 299, 300, 301, 302],
  WALK_SIDE = [303, 304, 305, 306, 307, 308], REMOUNT = [309, 310, 311, 312, 313], LONE_BIKE = [319, 320, 321, 322];
// Attack animations by kind (HIBOB frame numbers): chain swings 82-84, club swings 105-107. Leg kicks have their own
// frames for each side (no mirroring): chamber then extend, 225-226 / 229-230 kicking left, 227-228 / 231-232 right.
const ATTACK = { punch: PUNCH, chain: [82, 83, 84], club: [105, 106, 107] };
const KICK = { [-1]: [[225, 226, 225], [229, 230, 229]], [1]: [[227, 228, 227], [231, 232, 231]] };
// Which way each animation is drawn (+1 right, -1 left); the sprite is mirrored for the other side.
const ATTACK_SIDE = { punch: 1, kick: 1, chain: -1, club: -1 };

let shared;
async function loadShared() {
  if (shared) return shared;
  const [riderRects, shadowRects, copRects] = await Promise.all(["rider-rects", "shadow-rects", "cop-rects"].map((n) => raceJSON(`./data/${n}.json`)));
  return (shared = { riderRects, shadowRects, copRects, textures: new Map() });
}

export async function runRace(opts) {
  return withRaceScreen(opts, startRace);
}

const WEBP = typeof document !== "undefined" && document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp");
const webp = (url) => (WEBP && url.startsWith("./data/") && url.endsWith(".png") ? url.slice(0, -4) + ".webp" : url);
async function startRace(opts, startup) {
  const { container, course = "city", scheme = 0, bike = { top: 62, accel: 11, grip: 1, cls: "sport" }, rivals = [], music } = opts;
  const sh = await loadShared();
  const data = await raceJSON(`./data/${course}.json`);
  // Every texture goes through one cache: one download and one GPU upload per image (clones share the source),
  // all awaited and uploaded before the countdown so nothing loads mid-race.
  const baseLoader = new THREE.TextureLoader(), texBase = new Map(), allTex = [];
  let loadedImages = 0;
  const loader = { load(url, cb) {
    if (!texBase.has(url)) {
      const e = {}; texBase.set(url, e);
      e.base = new THREE.Texture();
      e.done = loadRaceImage({ urls: [webp(url), url], defer: startup.defer,
        load: (src, ok, fail) => baseLoader.load(src, t => { ok(t.image); t.dispose(); }, undefined, fail),
        onImage: image => { e.base.image = image; e.base.needsUpdate = true; },
        onAttempt: detail => recordRaceEvent("race_image_retry", { ...detail, course, stage: "course_art" }),
      }).then(error => {
        e.error = error;
        startup.status(`Loading course art… ${++loadedImages} / ${texBase.size}`);
      });
    }
    const e = texBase.get(url), t = e.base.clone(); allTex.push(t);
    if (cb) e.done.then(() => { if (!e.error) cb(t); });
    return t;
  } };

  // ---- Track ----
  // Tracks open with a steep lead-in (slope bytes up to 127). The game never shows it: its starting grid (EXE 0x464218)
  // puts the riders at steps 50 and 51, past the rise, so we keep the data as is and start there too.
  const pts = []; { let x = 0, y = 0, z = 0, h = 0; for (const [a, b] of data.steps) { h += turnOf(a); y += b * KS; x += Math.sin(h) * STEP; z -= Math.cos(h) * STEP; pts.push({ x, y, z, h }); } }
  const END = pts.length - 2;
  const sections = await fetch(`./data/${course}-sections.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  // Each level races to its own finish line: RSEC records with flags (level << 8) | 6 (levels 1-5 at increasing steps;
  // the track-select lengths, EXE 0x468f58 in tenths of a mile, match them at ~4.85 m per step).
  const FIN = (() => { let at = 0, pick = END - 1; for (let L = 1; L <= Math.max(1, Math.min(5, opts.level ?? 1)); L++) { const m = sections.find((x) => (x[2] & 0xffff) === ((L << 8) | 6) && x[0] > at); if (m) { at = m[0]; pick = m[0]; } }
    return Math.min(END - 1, (opts.level ?? 0) >= 1 ? pick : END - 1); })();
  const track = (s) => { const i = Math.max(0, Math.min(END - 1, Math.floor(s))), u = Math.max(0, Math.min(1, s - i)), a = pts[i], b = pts[i + 1], c = pts[i + 2];
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, h: a.h + angleDelta(b.h, a.h) * u, curv: (angleDelta(c.h, b.h) * u + angleDelta(b.h, a.h) * (1 - u)) / STEP, slope: ((c.y - b.y) * u + (b.y - a.y) * (1 - u)) / STEP }; };
  let mainChart = identityChart();
  const branchCharts = [];
  const chartOf = (route = -1) => route < 0 ? mainChart : branchCharts[route] || mainChart;
  const toWorld = (t, lat, up = 0) => {
    const p = transformFrame({ ...t, x: t.x + Math.cos(t.h) * lat, y: t.y + up, z: t.z + Math.sin(t.h) * lat }, chartOf(t.route));
    return new THREE.Vector3(p.x, p.y, p.z);
  };
  const routeCut = { value: new THREE.Vector2(-1, -1) };
  const clipRoadside = (mat) => {
    const before = mat.onBeforeCompile, key = mat.customProgramCacheKey();
    mat.onBeforeCompile = (sh, renderer) => {
      before.call(mat, sh, renderer); sh.uniforms.uRouteCut = routeCut;
      sh.vertexShader = "attribute float roadStep; varying float vRoadStep;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoadStep = roadStep;");
      sh.fragmentShader = "uniform vec2 uRouteCut; varying float vRoadStep;\n" + sh.fragmentShader.replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vRoadStep >= uRouteCut.x && vRoadStep <= uRouteCut.y) discard;");
    };
    mat.customProgramCacheKey = () => key + ":route-cut"; return mat;
  };
  // ---- Fork branches (RNOD): retain the alternative's exact path data in its own coordinate space.
  // The original streams a local road window; forcing both paths into one closed map distorted the bends.
  const trackP = (P, s) => { const n = P.length, i = Math.max(0, Math.min(n - 2, Math.floor(s))), u = Math.max(0, Math.min(1, s - i)), a = P[i], b = P[i + 1], c = P[Math.min(n - 1, i + 2)];
    const ab = Math.max(0.1, Math.hypot(b.x - a.x, b.z - a.z)), bc = Math.max(0.1, Math.hypot(c.x - b.x, c.z - b.z));
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, h: a.h + angleDelta(b.h, a.h) * u,
      curv: angleDelta(c.h, b.h) / bc * u + angleDelta(b.h, a.h) / ab * (1 - u), slope: (c.y - b.y) / bc * u + (b.y - a.y) / ab * (1 - u) }; };
  const sideOf = (P, x, z, i0, i1) => { let best = Infinity, k = -1;
    for (let i = Math.max(0, i0 | 0); i <= Math.min(P.length - 1, i1 | 0); i++) { const d = (x - P[i].x) ** 2 + (z - P[i].z) ** 2; if (d < best) { best = d; k = i; } }
    if (k < 0) return null; const p = P[k], dx = x - p.x, dz = z - p.z;
    return Math.abs(dx * Math.sin(p.h) - dz * Math.cos(p.h)) > STEP * 0.75 ? null : { i: k, lat: dx * Math.cos(p.h) + dz * Math.sin(p.h) }; };
  const branches = (data.forks || []).filter((f) => f.mainLen && f.at + f.mainLen < pts.length - 2 && f.steps.length > 4).map((f) => {
    const J = f.at + f.mainLen;
    const { bp, side, exit } = decodeBranch(pts, f.at, f.mainLen, f.steps, STEP, turnOf);
    return { metresPerStep: STEP, at: f.at, J, mainEndY: pts[J].y, LA: f.mainLen, LB: bp.length - 1, bp, side, exit, fi: data.forks.indexOf(f) };
  });
  branches.forEach(() => branchCharts.push(identityChart()));
  // Before/after an alternative, express the main road in the alternative's coordinates too, so the
  // trailing camera and look-ahead never jump to an unrelated point at a mouth.
  const branchTrack = (B, s) => s < 0 ? track(B.at + s) : s > B.LB ? transformFrame(track(B.J + s - B.LB), B.exit) : trackP(B.bp, s);
  const T = (r, ds = 0) => ({ ...(r.br >= 0 ? branchTrack(branches[r.br], r.bs + ds) : track(r.s + ds)), route: r.br });

  const along = (o) => (o.br >= 0 ? o.bs : o.s); // position along whichever road it's on (main steps or branch steps)
  const EA = (r, side, ds = 0) => { if (r.br >= 0) { const B = branches[r.br], q = r.bs + ds; if (q >= 0 && q <= B.LB) return (side < 0 ? B.edgeL : B.edgeR)[Math.max(0, Math.min(B.LB, Math.round(q)))]; return edgeAt(q < 0 ? B.at + q : B.J + q - B.LB, side); } return edgeAt(r.s + ds, side); };
  // at a fork the player takes the branch by being on its side of the road; rivals take it now and then
  const enterBranch = (r, k) => (r === me ? Math.sign(r.lat) === branches[k].side && Math.abs(r.lat) > 1 : r.brPick?.[k] ?? false);

  const tex = (name) => { const t = loader.load(`./data/tex/${name}.png`); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = matchMedia("(pointer: coarse)").matches ? 2 : 4; t.magFilter = THREE.NearestFilter; return t; };
  // Lane counts per step (RLAN): [left, right]; 0+0 runs are treated as a two-lane road.
  const laneData = await fetch(`./data/${course}-lanes.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const LANE_W = 3.5;
  const edgeL = new Float32Array(pts.length), edgeR = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i++) { let [l, r] = laneData[i] || [2, 2]; if (l + r < 1) { l = 1; r = 1; } edgeL[i] = -Math.max(l, 0) * LANE_W; edgeR[i] = Math.max(r, 0) * LANE_W; }
  const forkLaneData = await fetch(`./data/${course}-lanes-forks.json`).then((r) => r.ok ? r.json() : []).catch(() => []);
  for (const B of branches) {
    const lanes = forkLaneData[B.fi] || []; B.edgeL = new Float32Array(B.LB + 1); B.edgeR = new Float32Array(B.LB + 1);
    for (let i = 0; i <= B.LB; i++) { let [l, r] = lanes[Math.min(i, lanes.length - 1)] || [2, 2]; if (l + r < 1) l = r = 1;
      B.edgeL[i] = -Math.max(0, l) * LANE_W; B.edgeR[i] = Math.max(0, r) * LANE_W;
    }
  }
  // shoulder (verge) width per step and side from RSLD (tools/hills.js -> <course>-shoulder.json, sideways units):
  // the verge's outer edge, where hills, rails and building fronts start, is the tarmac edge plus this width
  const shoulder = await fetch(`./data/${course}-shoulder.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const shL = new Float32Array(pts.length).fill(KERB * 3), shR = new Float32Array(pts.length).fill(KERB * 3);
  for (let i = 0; i < pts.length; i++) if (shoulder[i]) { shL[i] = shoulder[i][0] * 0.069 / 4; shR[i] = shoulder[i][1] * 0.069 / 4; }
  const swAt = (i, sgn) => { i = Math.max(0, Math.min(pts.length - 1, Math.round(i))); return sgn < 0 ? shL[i] : shR[i]; };
  const edgeAt = (s, side) => { const i = Math.max(0, Math.min(pts.length - 1, Math.round(s))); return side < 0 ? edgeL[i] : edgeR[i]; };
  const at = (v, i) => (typeof v === "function" ? v(i) : v);
  // Where a fork's two roads overlap (after the split and before the join), neither road's roadside - grass, verge,
  // walls, props - may stand on the other's tarmac or pavement. sideOf: a world point's sideways offset from road P,
  // searching steps i0..i1; null unless the point is abreast of a step (not off either end of the window).
  const branchInMain = (B, x, z, step) => step > (B.at + B.J) / 2 ? transformFrame({x,y:0,z,h:0}, B.toMain) : {x,z};
  for (const B of branches) B.toMain = alignChart(B.bp.at(-1), pts[B.J]);
  const onMain = (x, z, guess, pad = 0, B = null) => { const p = B ? branchInMain(B, x, z, guess) : {x,z}; const q = sideOf(pts, p.x, p.z, guess - 60, guess + 60); return !!q && q.lat > edgeL[q.i] - shL[q.i] - pad && q.lat < edgeR[q.i] + shR[q.i] + pad; };
  const onBranches = (x, z, step) => branches.some((B) => { if (Math.abs(step - B.at) > 20 && Math.abs(step - B.J) > 20) return false;
    const p = step > (B.at + B.J) / 2 ? transformFrame({x,y:0,z,h:0}, B.exit) : {x,z};
    const g = ((step - B.at) * B.LB) / B.LA, q = sideOf(B.bp, p.x, p.z, g - 60, g + 60); return !!q && q.lat > B.edgeL[q.i] - KERB * 3 && q.lat < B.edgeR[q.i] + KERB * 3; });
  // Road surfaces are built per CHUNK steps (one shared material), so far stretches of road are culled with the scenery:
  // the course isn't one consistent map (the original only draws near the rider), so distant road can hang in the sky.
  // Polygon offsets settle coplanar edges. The join masks below handle overlapping roads and
  // scenery at different elevations; depth bias alone cannot keep a verge out of the ridden road.
  const behind = (n) => (n ? { polygonOffset: true, polygonOffsetFactor: n, polygonOffsetUnits: n * 2 } : {});
  function ribbon(inner, outer, map, uScale, vScale, uOff = 0, po = 0) {
    const mat = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, ...behind(po) });
    for (let c = 0; c * CHUNK < pts.length - 1; c += 3) {
      const pos = [], uv = [], idx = [], steps = [], i0 = c * CHUNK, i1 = Math.min(pts.length - 1, i0 + CHUNK * 3);
      for (let i = i0; i <= i1; i++) { const p = pts[i], rx = Math.cos(p.h), rz = Math.sin(p.h);
        for (const off of [at(inner, i), at(outer, i)]) { pos.push(p.x + rx * off, p.y, p.z + rz * off); uv.push(off / uScale + at(uOff, i), (i * STEP) / vScale); steps.push(i); }
        if (i > i0) { const k = (i - i0) * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); } }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute("roadStep", new THREE.Float32BufferAttribute(steps, 1)); g.setIndex(idx);
      const mesh = new THREE.Mesh(g, mat); mesh.userData.tarmac = true; scene.add(mesh); chunks.push([c, mesh, 3]); // three chunks per piece
    }
  }
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x9fb4e8, 200, 700);
  startup.defer(() => {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    scene.traverse(o => { if (o.geometry) geometries.add(o.geometry); for (const m of [o.material,o.userData.joinBase,o.userData.joinMask].flat()) if(m) materials.add(m); });
    for (const m of materials) for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
    allTex.forEach(t => textures.add(t)); texBase.forEach(e => textures.add(e.base));
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t?.dispose());
    sh.textures.clear(); sh.copTex = null;
  });
  const SW = KERB * 3, L = (i) => edgeL[i], R = (i) => edgeR[i];
  // Static scenery is built in chunks of CHUNK road steps so only the chunks around the rider are drawn.
  const CHUNK = 40, chunks = [];
  // Lane tiles (128 px = one lane) carry their line in pixels 0-6 (WHITE) or a double line in 0-15 (YELLOW): centre the
  // lines on the lane boundaries. The centre gets the YELLOW tile, as the original draws it; the other boundaries WHITE.
  const LU = 3 / 128, YU = 8 / 128;
  const yellowL = (i) => Math.max(L(i), Math.min(R(i), -LANE_W / 2)), yellowR = (i) => Math.max(L(i), Math.min(R(i), LANE_W / 2));
  ribbon(L, yellowL, tex("WHITE"), LANE_W, LANE_W / 4, LU); ribbon(yellowL, yellowR, tex("YELLOW"), LANE_W, LANE_W / 4, YU); ribbon(yellowR, R, tex("WHITE"), LANE_W, LANE_W / 4, LU);
  // verge tiles (SAND, SCTSIDWK) run from the tarmac edge outward (SAND's first 28 px are the road's crumbling edge)
  // Each stretch uses its family's verge tile (tools/hills.js, list 5: SANDL with the solid edge line on Pacific Highway's
  // cliffs, DARK2 dirt on Sierra, SANDLX on Napa...); the City keeps its sidewalk.
  const shoulderForks = await fetch(`./data/${course}-shoulder-forks.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []); // per fork: per branch step [left, right] verge width
  const forkRails = await fetch(`./data/${course}-rails-forks.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []); // per fork: [start, end, sides, texL, texR, offset] in branch steps
  const shoulderAt = (r, sgn) => {
    if (r.br < 0) return swAt(r.s, sgn);
    const v = shoulderForks[branches[r.br].fi]?.[Math.max(0, Math.round(r.bs))];
    return v ? v[sgn < 0 ? 0 : 1] * 0.069 / 4 : SW;
  };
  const branchRails = branches.map((B) => {
    const mask = new Uint8Array(B.LB + 1), offset = new Float32Array(B.LB + 1);
    for (const [a, b, sides, , , off] of forkRails[B.fi] || []) for (let i = a; i < b && i <= B.LB; i++) {
      mask[i] |= sides; offset[i] = (off || 0) * 0.069 / 4;
    }
    return { mask, offset };
  });
  const vergeRuns = course === "city" ? null : await fetch(`./data/${course}-verge.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const vergeAt = (side, i) => { const runs = vergeRuns?.[side]; if (!runs) return SIDE[course]; let lo = 0, hi = runs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (runs[m][0] <= i) lo = m; else hi = m - 1; } return runs[lo]?.[1] || SIDE[course]; };
  const coverMat = new THREE.MeshBasicMaterial({ map: tex("PLAIN"), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const vergeMats = new Map(), vergeMat = (n) => { if (!vergeMats.has(n)) vergeMats.set(n, new THREE.MeshBasicMaterial({ map: tex(n), side: THREE.DoubleSide, ...behind(4) })); return vergeMats.get(n); };
  for (const side of [0, 1]) {
    const inner = side ? R : L, outer = side ? (i) => edgeR[i] + shR[i] : (i) => edgeL[i] - shL[i], uS = side ? SW : -SW, uO = side ? (i) => -edgeR[i] / SW : (i) => edgeL[i] / SW;
    const groups = new Map();
    for (let i = 0; i < pts.length - 1; i++) {
      const name = vergeAt(side, i), c = ((i / CHUNK) | 0) - (((i / CHUNK) | 0) % 3), key = c + ":" + name;
      if (!groups.has(key)) groups.set(key, { c, name, pos: [], uv: [] }); const g = groups.get(key);
      const v = (j, off) => { const p = pts[j]; return [p.x + Math.cos(p.h) * off, p.y, p.z + Math.sin(p.h) * off, off / uS + uO(j), (j * STEP) / (KERB * 1.5)]; };
      const a0 = v(i, inner(i)), a1 = v(i, outer(i)), b0 = v(i + 1, inner(i + 1)), b1 = v(i + 1, outer(i + 1));
      for (const q of [a0, b0, a1, a1, b0, b1]) { g.pos.push(q[0], q[1], q[2]); g.uv.push(q[3], q[4]); }
      // a verge tile with its own solid edge line (SANDL): cover the lane tile's dash that falls on the tarmac edge
      if (name === "SANDL") { const k2 = c + ":cover"; if (!groups.has(k2)) groups.set(k2, { c, name: "PLAIN", cover: true, pos: [], uv: [] }); const h = groups.get(k2), d = side ? -0.35 : 0.35;
        const c0 = v(i, inner(i) + d), c1 = v(i + 1, inner(i + 1) + d); for (const q of [a0, b0, c0, c0, b0, c1]) { h.pos.push(q[0], q[1] + 0.005, q[2]); h.uv.push(q[3], q[4]); } }
    }
    for (const g of groups.values()) { const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
      const m = new THREE.Mesh(geo, g.cover ? coverMat : vergeMat(g.name)); scene.add(m); chunks.push([g.c, m, 3]); }
  }
  // ---- Roadside terrain (RHIL): per stretch of road, a 4-point cross-section each side (distance out, height), picked
  // at random inside the stored ranges like the game does on load. Unit: 1/58 m both ways (the hazard sideways unit).
  // Where a course has no profile the ground stays flat; profiles blend in and out over 8 steps.
  const hillRecs = await fetch(`./data/${course}-hills.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const HU = 0.069 / 4, FAR = 180, NP = 6;
  const profL = new Array(pts.length).fill(null), profR = new Array(pts.length).fill(null);
  // ground textures per step and side, near to far (the RHIL side code's hill object, tools/hills.js); water codes
  // export as WATER128
  const styleL = new Array(pts.length).fill(null), styleR = new Array(pts.length).fill(null);
  // Guardrails are their own sections (RSEC kind 4, tools/hills.js -> <course>-rails.json): [start, end, sides (1 left,
  // 2 right), left texture, right texture, offset]. The game draws them at the verge's outer edge plus the offset
  // (0x41c200) in sideways units: on Napa (offsets 4-6) the original's rail posts stand right at the verge's edge.
  const railL = new Array(pts.length).fill(null), railR = new Array(pts.length).fill(null), railOff = new Float32Array(pts.length);
  for (const [a, b, mask, tl, tr, off] of await fetch(`./data/${course}-rails.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []))
    for (let i = a; i < b && i < pts.length; i++) { if (mask & 1) railL[i] = tl || tr; if (mask & 2) railR[i] = tr || tl; railOff[i] = off * 0.069 / 4; }
  for (const [a, b, sideA, sideB, st] of hillRecs) if (st) for (let i = a; i < b && i < pts.length; i++) { styleL[i] = st[0]; styleR[i] = st[1]; }
  const hillPicks = [];
  for (const [a, b, sideA, sideB] of hillRecs) {
    const pick = (side) => side.map(([dlo, dhi, hlo, hhi]) => [(dlo + Math.random() * (dhi - dlo)) * HU, (hlo + Math.random() * (hhi - hlo)) * HU]);
    hillPicks.push([a, b, pick(sideA), pick(sideB)]);
  }
  // the game moves each node's hill points from one record's values to the next's step by step (0x4515a0/0x4517e0), so
  // the ground never jumps; blend each record's picked profile into the next record's across its steps
  hillPicks.sort((x, y) => x[0] - y[0]);
  for (let k = 0; k < hillPicks.length; k++) {
    const [a, b, L0, R0] = hillPicks[k], nx = hillPicks[k + 1], joined = nx && nx[0] <= b + 1;
    for (let i = a; i < b && i < pts.length; i++) {
      const f = joined ? (i - a) / Math.max(1, nx[0] - a) : 0;
      const mix = (P, Q) => P.map(([d, h], j) => [d + ((Q?.[j]?.[0] ?? d) - d) * f, h + ((Q?.[j]?.[1] ?? h) - h) * f]);
      profL[i] = joined ? mix(L0, nx[2]) : L0; profR[i] = joined ? mix(R0, nx[3]) : R0;
    }
  }
  // Mountain roadsides (RMTN, see tools/hills.js): per step and side, three random walks shape a flat shoulder, then a
  // run up to a rock wall or down a drop - sheer when twice the height is at least the run. mtn[i] marks terrain type 1,
  // where a hard landing totals the bike; wallL/wallR hold where a sheer rock face starts (riders stop against it).
  const tunnels = await fetch(`./data/${course}-tunnels.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const mtnRecs = await fetch(`./data/${course}-mtn.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const mtn = new Uint8Array(pts.length), wallL = new Float32Array(pts.length), wallR = new Float32Array(pts.length);
  const randAmp = (a) => Math.floor(Math.random() * (2 * a + 1)) - a, clampW = (v, hi) => Math.max(0, Math.min(hi, v));
  const faceL = [], faceR = []; // rock face texture per step (from the object bytes after the records)
  for (const [base, n, listA, listB, faces, rails] of mtnRecs) [listA, listB].forEach((list, side) => {
    const prof = side ? profR : profL, wall = side ? wallR : wallL, face = side ? faceR : faceL; let k = 0, w1 = 0, w2 = 0, w3 = 0;
    faces?.[side]?.forEach((t, i) => { if (t) face[base + i] = t; });
    for (let i = 0; i < n && base + i < pts.length; i++) {
      while (k + 1 < list.length && list[k + 1][0] <= i) k++;
      const r = list[k]; if (!r || r[0] > i) continue; const [, b5, b6, b7, b8, b9, b10, b11, h] = r;
      w1 = clampW(w1 + randAmp(b5), 2 * b6); w2 = clampW(w2 + randAmp(b10), 4 * b11); w3 = clampW(w3 + randAmp(b7), 4 * b8);
      const p0 = w1 * HU, p1 = (w3 + 2 * b6 + 4 * b9) * HU, ht = (h + w2) * HU, sheer = 2 * Math.abs(h + w2) >= (w3 + 2 * b6 + 4 * b9) - w1;
      const top = sheer ? p0 + 0.3 : p1;
      prof[base + i] = [[p0, 0], [top, ht], [top + 1, ht], [top + 2, ht]]; mtn[base + i] = 1;
      // sand shoulder; up top the ground goes on as hillside, at the bottom of a drop it is the sea (foam where it meets
      // the rock)
      (side ? styleR : styleL)[base + i] = ht < -3 ? ["SANDLX", "", "WATER128", "SEA128"] : ["SANDLX", "", "HILL12A", "HILL13A"]; // [1] is the rock face
      if (sheer && ht > 1.5) wall[base + i] = p0;
    }
  });
  // a tunnel bores through rock: over its steps both sides rise straight from the wall to the rock above it
  const ROCK = 9.5;
  for (const [a, b] of tunnels) for (let i = a; i <= b && i < pts.length; i++) {
    const fc = faceL[i] || faceR[i] || "CLIFF3A";
    for (const [prof, style, face, rail] of [[profL, styleL, faceL, railL], [profR, styleR, faceR, railR]]) {
      const old = prof[i], last = old ? old[old.length - 1] : [40, 0]; face[i] ||= fc; rail[i] = null; mtn[i] = 1;
      // above the road side the rock rises; where the ground beyond drops away (the sea side) it is a ridge that
      // falls back down as cliff to the old level
      if (last[1] < 0) { prof[i] = [[0, 0], [0.3, ROCK], [5, ROCK], [Math.max(8, last[0]), last[1]]]; style[i] = ["SANDLX", "", "HILL13A", fc, "SEA128"]; }
      else { prof[i] = [[0, 0], [0.3, ROCK], [1.3, ROCK], [2.3, ROCK]]; style[i] = ["SANDLX", "", "HILL12A", "HILL13A"]; }
    }
  }
  // where a sheer rock face starts on one side of a step (0 = none)
  const faceAt = (s, sgn) => { const i = Math.max(0, Math.min(pts.length - 1, Math.round(s))), wl = (sgn < 0 ? wallL : wallR)[i]; return wl ? Math.max(wl, (Math.abs(sgn < 0 ? edgeL[i] : edgeR[i]) + swAt(i, sgn))) + 0.3 : 0; };
  // height of the ground at a sideways offset (0 on the road and pavement)
  const profileAt = (arr, i) => {
    const p = arr[i]; if (!p) {
      // blend toward a neighbouring profile within 8 steps
      for (let k = 1; k <= 8; k++) { const q = arr[i - k] || arr[i + k]; if (q) return q.map(([d, h]) => [d, h * (1 - k / 9)]); }
      return null;
    }
    return p;
  };
  const ringY = (ring, d) => { for (let k = 1; k < ring.length; k++) if (d <= ring[k][0]) return ring[k - 1][1] + ((ring[k][1] - ring[k - 1][1]) * (d - ring[k - 1][0])) / Math.max(1e-6, ring[k][0] - ring[k - 1][0]); return ring[ring.length - 1][1]; };
  // Physics and rendering share the same cached cross-sections. Sampling at fractional road positions
  // prevents the ground and camera jumping whenever Math.round(s) changes to the next node.
  const terrainRings = [-1, 1].map((sgn) => pts.map((p, j) => {
    const edge = Math.abs(sgn < 0 ? edgeL[j] : edgeR[j]) + swAt(j, sgn), pr = profileAt(sgn < 0 ? profL : profR, j);
    const ring = [[edge, 0]]; let last = edge;
    for (let k = 0; k < 4; k++) { const q = pr?.[k] || [edge + 10 * (k + 1), 0], d = Math.max(q[0], last + (mtn[j] ? 0.3 : 2)); ring.push([d, q[1]]); last = d; }
    ring.push([Math.max(FAR, last + 10), ring[4][1]]);
    return ring;
  }));
  const terrainY = (s, lat) => {
    s = Math.max(0, Math.min(pts.length - 1, s)); const i = Math.floor(s), f = s - i, d = Math.abs(lat), rings = terrainRings[lat < 0 ? 0 : 1];
    const height = (r) => d <= r[0][0] ? 0 : ringY(r, d);
    return height(rings[i]) * (1 - f) + height(rings[Math.min(i + 1, pts.length - 1)]) * f;
  };
  {
    const cliffMats = new Map(), groundMats = new Map();
    const railMats = new Map(), railMat = (name) => { if (!railMats.has(name)) { const t = tex(name); t.wrapT = THREE.ClampToEdgeWrapping; railMats.set(name, clipRoadside(new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, alphaTest: 0.5 }))); } return railMats.get(name); };
    const groundMat = (name) => { if (!groundMats.has(name)) groundMats.set(name, clipRoadside(new THREE.MeshBasicMaterial({ map: tex(name), side: THREE.DoubleSide, ...behind(4) }))); return groundMats.get(name); };
    const cliffMat = (name) => { if (!cliffMats.has(name)) cliffMats.set(name, clipRoadside(new THREE.MeshBasicMaterial({ map: tex(name), side: THREE.DoubleSide, ...behind(4) }))); return cliffMats.get(name); };
    for (const sgn of [-1, 1]) {
      const arr = sgn < 0 ? profL : profR, face = sgn < 0 ? faceL : faceR, style = sgn < 0 ? styleL : styleR, rail = sgn < 0 ? railL : railR, byChunk = new Map(), cliffs = new Map();
      const styleAt = (i) => { for (let k = 0; k <= 8; k++) { const q = style[i - k] || style[i + k]; if (q) return q; } return ["HILL12A", "HILL12A", "HILL13A"]; };
      for (let i = 0; i < pts.length - 1; i++) {
        const c = Math.floor(i / (CHUNK * 3)) * 3, rings = [], st = styleAt(i);
        for (const j of [i, i + 1]) {
          const p = pts[j], ring = terrainRings[sgn < 0 ? 0 : 1][j];
          const rx = Math.cos(p.h) * sgn, rz = Math.sin(p.h) * sgn;
          let slant = ring[0][0]; rings.push(ring.map(([d, h], k) => { if (k) slant += Math.hypot(d - ring[k - 1][0], h - ring[k - 1][1]); return [p.x + rx * d, p.y + h, p.z + rz * d, slant, h]; }));
        }
        // mountain steps: the rock face (ring points 1 -> 2) is drawn with the step's cliff texture, one tile per step
        // (64 px wide, 128 tall: 2 steps of height); the ground either side keeps the hill texture
        const fname = mtn[i] && mtn[i + 1] && face[i];
        for (let k = 0; k < NP - 1; k++) {
          if (fname && k === 1) {
            const key = c + ":" + fname; if (!cliffs.has(key)) cliffs.set(key, { name: fname, c, pos: [], uv: [], steps: [] });
            const q = cliffs.get(key), [a0, a1] = [rings[0][1], rings[0][2]], [b0, b1] = [rings[1][1], rings[1][2]], vs = 2 * STEP;
            for (const [v, u] of [[a0, 0], [b0, 1], [a1, 0], [a1, 0], [b0, 1], [b1, 1]]) { q.pos.push(v[0], v[1], v[2]); q.uv.push(u, v[4] / vs); q.steps.push(i + u); }
            continue;
          }
          const name = st[Math.min(st.length - 1, k)] || "HILL12A", key = c + ":" + name;
          if (!byChunk.has(key)) byChunk.set(key, { c, name, pos: [], uv: [], steps: [] });
          const g = byChunk.get(key), w = /WATER|SEA/.test(name) ? 8 : 16;
          for (const [v, j] of [[rings[0][k], i], [rings[1][k], i + 1], [rings[0][k + 1], i], [rings[0][k + 1], i], [rings[1][k], i + 1], [rings[1][k + 1], i + 1]]) {
            g.pos.push(v[0], v[1], v[2]); g.steps.push(j); g.uv.push((v[3] * sgn) / w, (j * STEP) / (w === 8 ? 8 : 2)); }
        }
        // guardrail: a 0.9 m rail on posts at the verge's outer edge, one texture tile per step
        if (rail[i] && rail[i + 1]) {
          const key = c + ":rail:" + rail[i]; if (!byChunk.has(key)) byChunk.set(key, { c, name: rail[i], rail: true, pos: [], uv: [], steps: [] });
          const out = (v, j) => { const o = railOff[j], h = pts[j].h; return o ? [v[0] + Math.cos(h) * sgn * o, v[1], v[2] + Math.sin(h) * sgn * o] : v; };
          const g = byChunk.get(key), e0 = out(rings[0][0], i), e1 = out(rings[1][0], i + 1), H = 0.9;
          for (const [v, u, up] of [[e0, 0, 0], [e1, 1, 0], [e0, 0, 1], [e0, 0, 1], [e1, 1, 0], [e1, 1, 1]]) { g.pos.push(v[0], v[1] + up * H, v[2]); g.uv.push(u, up); g.steps.push(i + u); }
        }
      }
      for (const g of byChunk.values()) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2)); geo.setAttribute("roadStep", new THREE.Float32BufferAttribute(g.steps, 1));
        const mat = g.rail ? railMat(g.name) : groundMat(g.name);
        const mesh = new THREE.Mesh(geo, mat); scene.add(mesh); chunks.push([g.c, mesh, 3]);
      }
      for (const q of cliffs.values()) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(q.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(q.uv, 2)); geo.setAttribute("roadStep", new THREE.Float32BufferAttribute(q.steps, 1));
        const mesh = new THREE.Mesh(geo, cliffMat(q.name)); scene.add(mesh); chunks.push([q.c, mesh, 3]);
      }
    }
  }
  // ---- Tunnels (tools/hills.js: RSEC sections with flag byte 3, textures from the family's list 3): walls with a
  // railing at the verge's outer edge, sloping ceiling sides, a lit ceiling (lamp every other step, as the original's
  // per-step object bytes alternate 0/1) and a portal face at each mouth.
  const tunAt = new Float32Array(pts.length); // half-width to the wall where a step is inside a tunnel (0 = none)
  {
    const WH = 2.6, CH = 6.2, CW = 2.2, mats = new Map();
    const mat = (name, flip) => { const k = name + flip; if (!mats.has(k)) { const t = tex(name); t.wrapS = t.wrapT = THREE.RepeatWrapping; mats.set(k, new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide })); } return mats.get(k); };
    const groups = new Map(), quad = (c, name, a, b, cc, d) => { const k = c + ":" + name; if (!groups.has(k)) groups.set(k, { c, name, pos: [], uv: [] }); const g = groups.get(k);
      for (const [v, u, w] of [[a, 0, 0], [b, 1, 0], [d, 0, 1], [d, 0, 1], [b, 1, 0], [cc, 1, 1]]) { g.pos.push(...v); g.uv.push(u, w); } };
    const at = (i, off, y) => { const p = pts[i]; return [p.x + Math.cos(p.h) * off, p.y + y, p.z + Math.sin(p.h) * off]; };
    for (const [a, b, t] of tunnels) {
      const [CC, RC, RW, CC2, , LIP] = t;
      for (let i = a; i < b && i < pts.length - 1; i++) {
        const c = (i / CHUNK) | 0, wl = Math.abs(edgeL[i]) + shL[i], wr = Math.abs(edgeR[i]) + shR[i], wl1 = Math.abs(edgeL[i + 1]) + shL[i + 1], wr1 = Math.abs(edgeR[i + 1]) + shR[i + 1];
        tunAt[i] = Math.min(wl, wr);
        quad(c, "HILL13A", at(i, -wl - 0.3, ROCK), at(i + 1, -wl1 - 0.3, ROCK), at(i + 1, wr1 + 0.3, ROCK), at(i, wr + 0.3, ROCK)); // rock over the top
        for (const [sg, w0, w1] of [[-1, wl, wl1], [1, wr, wr1]]) {
          quad(c, RW, at(i, sg * w0, 0), at(i + 1, sg * w1, 0), at(i + 1, sg * w1, WH), at(i, sg * w0, WH)); // wall
          quad(c, RC, at(i, sg * w0, WH), at(i + 1, sg * w1, WH), at(i + 1, sg * CW, CH), at(i, sg * CW, CH)); // ceiling side
        }
        // ceiling: the tile is half the vault (lamp on its inner edge), drawn twice and mirrored so the lamp is centred
        const cn = i % 2 ? CC2 || CC : CC;
        quad(c, cn, at(i, -CW, CH), at(i + 1, -CW, CH), at(i + 1, 0, CH), at(i, 0, CH)); quad(c, cn, at(i, CW, CH), at(i + 1, CW, CH), at(i + 1, 0, CH), at(i, 0, CH));
      }
      // portal faces: a band over the mouth and a pillar either side, in the lip texture, standing in the hillside
      for (const i of [a, Math.min(b, pts.length - 1)]) {
        const c = (i / CHUNK) | 0, wl = Math.abs(edgeL[i]) + shL[i], wr = Math.abs(edgeR[i]) + shR[i], X = 1.5;
        quad(c, LIP, at(i, -wl - X, CH), at(i, wr + X, CH), at(i, wr + X, CH + 1.5), at(i, -wl - X, CH + 1.5));
        const fc = faceL[i] || "CLIFF3A"; quad(c, fc, at(i, -wl - X, CH + 1.5), at(i, wr + X, CH + 1.5), at(i, wr + X, ROCK), at(i, -wl - X, ROCK)); // rock above the mouth
        for (const [sg, w] of [[-1, wl], [1, wr]]) quad(c, LIP, at(i, sg * w, 0), at(i, sg * (w + X), 0), at(i, sg * (w + X), CH), at(i, sg * w, CH));
        for (const [sg, w] of [[-1, wl], [1, wr]]) quad(c, LIP, at(i, sg * w, WH), at(i, sg * CW, CH), at(i, sg * CW, CH + 0.01), at(i, sg * w, CH)); // fill above the sloped ceiling side
      }
    }
    for (const g of groups.values()) { const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
      const m = new THREE.Mesh(geo, mat(g.name)); scene.add(m); chunks.push([g.c, m]); }
  }
  // ---- Forks: draw each decoded alternative and its roadside in its own coordinate space
  for (const B of branches) {
    const firstChunk = chunks.length;
    const ap = B.bp, BL = (i) => B.edgeL[i], BR = (i) => B.edgeR[i];
    const n = ap.length, step = CHUNK * 3; // branch points -> main-road chunk by progress along the branch
    // the main road's step abreast of branch point i, and whether a branch point (i, sideways off) lies on the main road
    const mainAt = (i) => B.at + (i * B.LA) / B.LB;
    const hitsMain = (i, off, pad) => { if (i > 40 && i < B.LB - 40) return false; const p = ap[i]; return onMain(p.x + Math.cos(p.h) * off, p.z + Math.sin(p.h) * off, mainAt(i), pad, B); };
    // Keep full strips. The join shader trims overlapping fragments in the aligned road coordinates;
    // dropping whole quads here left holes and floating wedges of verge at the merge.
    const strip = (inner, outer, map, uS, vS, lift, po, uOff = 0, tarmac = false, keep = null) => {
      const mat = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, ...behind(po) }); // see the depth order above
      for (let i0 = 0; i0 < n - 1; i0 += step) {
        const pos = [], uv = [], idx = [], steps = [], i1 = Math.min(n - 1, i0 + step);
        const nearMouth = i0 < 110 || i1 > B.LB - 110;
        const divisions = nearMouth ? Math.max(1, Math.ceil(Math.max(...ap.slice(i0,i1+1).map((_,j)=>Math.abs(at(outer,i0+j)-at(inner,i0+j))))/2)) : 1, cols = divisions + 1;
        for (let i = i0; i <= i1; i++) { const p = ap[i], rx = Math.cos(p.h), rz = Math.sin(p.h); for (let j=0;j<=divisions;j++) { const o=at(inner,i)+(at(outer,i)-at(inner,i))*j/divisions; pos.push(p.x + rx * o, p.y + lift, p.z + rz * o); uv.push(o / uS + at(uOff, i), (i * STEP) / vS); steps.push(mainAt(i)); }
          if (i > i0 && (!keep || keep(i - 1))) for(let j=0;j<divisions;j++) { const k = (i-i0)*cols+j; idx.push(k-cols,k,k-cols+1,k-cols+1,k,k+1); } }
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute("roadStep", new THREE.Float32BufferAttribute(steps, 1)); g.setIndex(idx);
        const mesh = new THREE.Mesh(g, mat); mesh.userData.tarmac = tarmac; mesh.userData.roadRange = [mainAt(i0),mainAt(i1)]; scene.add(mesh); const first = Math.floor((B.at + i0 * B.LA / B.LB) / CHUNK), last = Math.ceil((B.at + i1 * B.LA / B.LB) / CHUNK); chunks.push([first, mesh, Math.max(1, last - first)]);
      }
    };
    // lane markings and verges laid out as the main road's
    // this branch's own verge widths (RSLD on its segments), sideways units -> m
    const bsh = shoulderForks[B.fi] || [], bsw = (i, sg) => { const v = bsh[Math.max(0, Math.min(bsh.length - 1, i))]; return v ? (v[sg < 0 ? 0 : 1] * 0.069) / 4 : SW; };
    const YL = (i) => Math.max(BL(i), Math.min(BR(i), -LANE_W / 2)), YR = (i) => Math.max(BL(i), Math.min(BR(i), LANE_W / 2));
    strip(BL, YL, tex("WHITE"), LANE_W, LANE_W / 4, 0, 2, LU, true); strip(YL, YR, tex("YELLOW"), LANE_W, LANE_W / 4, 0, 2, YU, true); strip(YR, BR, tex("WHITE"), LANE_W, LANE_W / 4, 0, 2, LU, true);
    // verge per stretch of the branch: the city sidewalk through a town (tools/hills.js), the course's verge elsewhere
    const runs = vergeRuns?.[2]?.[B.fi] || [[0, null]], vergeOfBranch = (i) => { let v = null; for (const [from, name] of runs) if (from <= i) v = name; return v || SIDE[course]; };
    for (const name of new Set(runs.map((r) => r[1] || SIDE[course]))) {
      const keep = (i) => vergeOfBranch(i) === name;
      strip((i) => BL(i) - bsw(i, -1), BL, tex(name), -SW, KERB * 1.5, 0.02, 3, (i) => BL(i) / SW, false, keep); strip(BR, (i) => BR(i) + bsw(i, 1), tex(name), SW, KERB * 1.5, 0.02, 3, (i) => -BR(i) / SW, false, keep);
    }
    strip(-60, (i) => BL(i) - bsw(i, -1), tex("HILL12A"), 16, 2, -0.05, 6); strip((i) => BR(i) + bsw(i, 1), 60, tex("HILL12A"), 16, 2, -0.05, 6);
    // guardrails along the branch (its own RSEC kind-4 sections), at the verge's outer edge, left out over the main road
    for (const sgn of [-1, 1]) {
      const has = new Uint8Array(n), texs = new Map(); for (const [a0, b0, mask, tl, tr] of forkRails[B.fi] || []) for (let i = a0; i < b0 && i < n; i++) if (mask & (sgn < 0 ? 1 : 2)) { has[i] = 1; texs.set(i, sgn < 0 ? tl : tr); }
      const byTex = new Map(), H = 0.9;
      for (let i = 0; i < n - 1; i++) { const o = (sgn < 0 ? BL(i) : BR(i)) + sgn * bsw(i, sgn), o1 = (sgn < 0 ? BL(i + 1) : BR(i + 1)) + sgn * bsw(i + 1, sgn); if (!has[i] || !has[i + 1] || hitsMain(i, o, 0) || hitsMain(i + 1, o1, 0)) continue;
        const name = texs.get(i) || "RRRAIL1", c = ((B.at + (i * B.LA) / B.LB) / CHUNK) | 0, key = c + ":" + name; if (!byTex.has(key)) byTex.set(key, { c, name, pos: [], uv: [] }); const g = byTex.get(key);
        const at = (j, up) => { const p = ap[j], oo = j === i ? o : o1; return [p.x + Math.cos(p.h) * oo, p.y + up * H, p.z + Math.sin(p.h) * oo]; };
        for (const [j, u, up] of [[i, 0, 0], [i + 1, 1, 0], [i, 0, 1], [i, 0, 1], [i + 1, 1, 0], [i + 1, 1, 1]]) { g.pos.push(...at(j, up)); g.uv.push(u, up); } }
      for (const g of byTex.values()) { const t = tex(g.name); t.wrapT = THREE.ClampToEdgeWrapping;
        const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2));
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, alphaTest: 0.5 })); scene.add(mesh); chunks.push([g.c, mesh]); }
    }
    for (let i = firstChunk; i < chunks.length; i++) chunks[i][1].userData.route = branches.indexOf(B);
  }
  // ---- Scenery atlas (tools/atlas.js): every static scenery texture of the course packed into 2048px pages, so all
  // facades / props / road patches of a road chunk draw with one material per page instead of one per texture.
  const atlas = await fetch(`./data/atlas/${course}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const atlasTex = atlas ? [...Array(atlas.pages)].map((_, i) => { const t = loader.load(`./data/atlas/${course}-${i}.png`); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.magFilter = THREE.NearestFilter; return t; }) : [];
  // normalized rect in GL uv space: [page, u0, v0, du, dv]
  const arect = (name) => { const r = atlas?.rects[name]; if (!r) return null; const [pg, x, y, w, h] = r, S = atlas.size; return [pg, x / S, 1 - (y + h) / S, w / S, h / S]; };
  const atlasMats = new Map();
  const atlasMat = (kind, pg) => {
    const key = kind + pg; if (atlasMats.has(key)) return atlasMats.get(key);
    const m = new THREE.MeshBasicMaterial({ map: atlasTex[pg], alphaTest: 0.5, side: THREE.DoubleSide, ...(kind === "flat" ? { polygonOffset: true, polygonOffsetFactor: -2 } : {}) });
    m.onBeforeCompile = (sh) => {
      // billboards: the trailing chase camera can pass right through a roadside tree; anything nearer than 3 m to the eye
      // isn't drawn (the original draws objects only well in front of its camera)
      if (kind === "bill") { sh.vertexShader = "attribute vec2 corner;\nvarying float vEyeZ;\n" + sh.vertexShader.replace("#include <project_vertex>", "vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 ); vEyeZ = -mvPosition.z; mvPosition.xy += corner; gl_Position = projectionMatrix * mvPosition;");
        sh.fragmentShader = "varying float vEyeZ;\n" + sh.fragmentShader.replace("void main() {", "void main() {\n  if (vEyeZ < 3.0) discard;"); }
      if (kind === "wall") {
        // facades repeat: wrap inside the atlas rect, with gradients from the unwrapped coordinate so mips don't seam
        sh.vertexShader = "attribute vec4 rect;\nvarying vec4 vRect;\n" + sh.vertexShader.replace("#include <uv_vertex>", "#include <uv_vertex>\nvRect = rect;");
        sh.fragmentShader = "varying vec4 vRect;\n" + sh.fragmentShader.replace("#include <map_fragment>",
          "vec2 g_ = vMapUv * vRect.zw; vec4 sampledDiffuseColor = textureGrad( map, vRect.xy + fract( vMapUv ) * vRect.zw, dFdx( g_ ), dFdy( g_ ) ); diffuseColor *= sampledDiffuseColor;");
      }
    };
    m.customProgramCacheKey = () => "atlas-" + kind;
    clipRoadside(m); atlasMats.set(key, m); return m;
  };
  // ---- Roadside buildings: per-step facade object from RBLD/RRSM, drawn as the original's rows of pieces ----
  const scen = await fetch(`./data/${course}-scenery.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (scen) {
    const groups = new Map(); // texture name -> {pos, uv, idx}
    // The facade draw (0x40c450) lays a row of pieces at each road step, facing along the road, outward from the verge's
    // edge in 256-sideways-unit (4.4 m) steps (8 or 16 of them): the first four are the step's own object, then pairs
    // alternate object 0 and the own object (its picker's random call 0x441730 returns 0). A gap object (height <= 1)
    // draws the object before it instead. Each piece is its object's height (height byte << 4 sideways units). We draw
    // the first 4 pieces (2 on phones): the rest stand behind nearer rows and cost fill rate.
    const PW = (256 * 0.069) / 4, PIECES = matchMedia("(pointer: coarse)").matches ? 2 : 4, U = (v) => (v * 0.069) / 4;
    const pieceIdx = (own, k) => (k < 4 || own === 0 ? own : ((k - 4) >> 1) % 2 ? own : 0);
    for (const [sideArr, sgn] of [[scen.left, -1], [scen.right, 1]]) {
      for (let i = 0; i < Math.min(sideArr.length, pts.length - 1); i++) {
        const cell = sideArr[i]; if (!cell) continue;
        const list = scen.fams[cell[0]]; if (!list) continue;
        const a = pts[i], e = Math.abs(sgn < 0 ? edgeL[i] : edgeR[i]) + swAt(i, sgn);
        if (branches.length && onBranches(a.x + Math.cos(a.h) * sgn * e, a.z + Math.sin(a.h) * sgn * e, i)) continue;
        const rx = Math.cos(a.h) * sgn, rz = Math.sin(a.h) * sgn;
        // runs of the same object become one quad with the texture repeated (the atlas shader wraps u)
        const objAt = (k) => { const idx = pieceIdx(cell[1], k); return list[idx] || (idx > 0 ? list[idx - 1] : null); };
        for (let k = 0; k < PIECES; ) {
          const obj = objAt(k); let n2 = 1; while (k + n2 < PIECES && objAt(k + n2) === obj) n2++;
          if (obj) {
            const [name, ht] = obj, H = U(ht * 16), ar = arect(name), gk = (ar ? "A" + ar[0] : name) + "@" + ((i / CHUNK) | 0);
            if (!groups.has(gk)) groups.set(gk, { name, page: ar ? ar[0] : -1, chunk: (i / CHUNK) | 0, pos: [], uv: [], rect: [], idx: [], steps: [] });
            const g = groups.get(gk), base = g.pos.length / 3, d0 = e + k * PW, d1 = d0 + n2 * PW;
            if (ar) for (let q = 0; q < 4; q++) g.rect.push(ar[1], ar[2], ar[3], ar[4]);
            for (const [d, u] of [[d0, 0], [d1, n2]]) { const uu = sgn < 0 ? n2 - u : u; g.pos.push(a.x + rx * d, a.y, a.z + rz * d, a.x + rx * d, a.y + H, a.z + rz * d); g.uv.push(uu, 0, uu, 1); g.steps.push(i, i); }
            g.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          }
          k += n2;
        }
      }
    }
    const facadeMats = new Map();
    for (const g of groups.values()) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2)); geo.setAttribute("roadStep", new THREE.Float32BufferAttribute(g.steps, 1)); geo.setIndex(g.idx);
      let mat;
      if (g.page >= 0) { geo.setAttribute("rect", new THREE.Float32BufferAttribute(g.rect, 4)); mat = atlasMat("wall", g.page); }
      else { if (!facadeMats.has(g.name)) { const map = tex(g.name); facadeMats.set(g.name, clipRoadside(new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }))); } mat = facadeMats.get(g.name); }
      const mesh = new THREE.Mesh(geo, mat); scene.add(mesh); chunks.push([g.chunk, mesh]);
    }
  }
  // ---- Roadside props (RROB): trees, lamps, signs, hydrants... ----
  // Static props are baked once per course into one billboard mesh per texture (a few dozen draw calls in total, no
  // per-frame work); the vertex shader turns each quad to face the camera like a sprite. Only animated props
  // (pedestrian walk cycles in RROB) use a small pool of sprites near the player.
  const props = await fetch(`./data/${course}-props.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  // RROB places objects outward from the road edge of their own step (0x451cb0): turn that into a lateral position
  for (const p of props) { const i = Math.max(0, Math.min(pts.length - 1, p[0])); p[1] = p[6] < 0 ? edgeL[i] - p[1] : edgeR[i] + p[1]; }
  const PROP_PX = 0.055, propMats = new Map(), pool = [];
  const propMat = (name, mirror) => {
    const key = name + (mirror ? "~" : "");
    if (!propMats.has(key)) { const t = tex(name); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; if (mirror) { t.repeat.x = -1; t.offset.x = 1; } propMats.set(key, new THREE.SpriteMaterial({ map: t, alphaTest: 0.5 })); }
    return propMats.get(key);
  };
  const propSpot = (step, l) => { const p = pts[step]; return [p.x + Math.cos(p.h) * l, p.y + terrainY(step, l), p.z + Math.sin(p.h) * l]; };
  // Road-surface objects (RHZD records without the spawn bit; list[4] of the family): kept with the same level odds
  // as the game's load pass and baked into the static batches below. Effects are ours, chosen by object name.
  const LV = Math.max(0, Math.min(4, (opts.level ?? 1) - 1)), rand = (n) => (Math.random() * n) | 0;
  // Spectating (a tournament host, mano.js): no bike of their own. "me" becomes an invisible rider that shadows the racer
  // being watched, so the camera, scenery, traffic and HUD follow them; it is left out of every collision and of the field.
  const SPECTATE = !!opts.spectate;
  // opts.assist (0-1, app.js assistLevel): help for new or struggling players. Fewer pedestrians who cross the road
  // (keep chance f + level - 6 at full help, about half as many) and road hazards, rivals up to 4% slower.
  const ASSIST = Math.max(0, Math.min(1, opts.assist || 0)), ASSIST_PEDS = Math.round(ASSIST * 6), ASSIST_ROAD = Math.round(ASSIST * 3);
  const crosses = (h) => h.b >= 5 && h.b <= 7;
  // with help on, the player crashes less and is back on the bike sooner (about half of quits came right after a crash):
  // roadside props under 6 + 8x m/s just stop the bike, getting up and remounting take up to 40% less time, and the rider
  // walks back to the bike by itself, up to twice as fast (holding throttle used to walk them away from it)
  const propCrash = (r) => (r === me ? 6 + 8 * ASSIST : 6), quick = (r) => (r === me ? 1 - 0.4 * ASSIST : 1);
  const roadRaw = opts.peds === false ? [] : await fetch(`./data/${course}-road.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const ROAD_FX = [[/^(OIL|ICEP)/, "slick"], [/^(WATP|WTRP)/, "wet"], [/^(SNDP|GRVP|GRAVP|PILE)/, "loose"], [/^(CRITP|NEWSP)/, "bump"]];
  const roadObjs = roadRaw.filter((h) => (!h.l || h.l - 1 === LV) && rand(10) <= h.f + LV - ASSIST_ROAD)
    .map((h) => ({ ...h, s: h.s + (h.j ? rand(2 * h.j + 1) - h.j : 0), x: h.x + (h.w ? (Math.random() * 2 - 1) * h.w : 0), fx: ROAD_FX.find(([re]) => re.test(h.t))?.[1] || "solid", heavy: /^(COPCAR|COW|BRRICD|BIGFN)/.test(h.t) }))
    .filter((h) => h.s > 12 && h.s < pts.length - 2).sort((a, b) => a.s - b.s);
  // solid obstacles stand up like props; patches (oil, water, sand...) lie flat on the tarmac, their pre-squashed
  // pictures stretched back out along the road (x4)
  const flats = new Map();
  for (const o of roadObjs) {
    o.hw = (o.tw * PROP_PX) / 2;
    if (o.fx === "solid") { props.push([Math.round(o.s), o.x, o.t, o.tw, o.th, 0, 0, 0]); continue; }
    const si = Math.min(pts.length - 2, Math.round(o.s)), p = pts[si], len = o.th * PROP_PX * 4, c = Math.cos(p.h), sn = Math.sin(p.h);
    const fw = Math.sin(p.h), fz = -Math.cos(p.h); // forward along the road
    const cx = p.x + c * o.x, cz = p.z + sn * o.x, y = p.y + 0.03;
    const ar = arect(o.t), key = (ar ? "A" + ar[0] : o.t) + "@" + ((si / CHUNK) | 0);
    if (!flats.has(key)) flats.set(key, { name: o.t, page: ar ? ar[0] : -1, chunk: (si / CHUNK) | 0, pos: [], uv: [], idx: [], steps: [] });
    const g = flats.get(key), n = g.pos.length / 3;
    for (const [a, f, u, v] of [[-o.hw, -len / 2, 0, 0], [o.hw, -len / 2, 1, 0], [o.hw, len / 2, 1, 1], [-o.hw, len / 2, 0, 1]]) { g.pos.push(cx + c * a + fw * f, y, cz + sn * a + fz * f); g.steps.push(si); g.uv.push(ar ? ar[1] + u * ar[3] : u, ar ? ar[2] + v * ar[4] : v); }
    g.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  const flatMats = new Map();
  for (const g of flats.values()) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2)); geo.setAttribute("roadStep", new THREE.Float32BufferAttribute(g.steps, 1)); geo.setIndex(g.idx);
    if (g.page < 0 && !flatMats.has(g.name)) { const t = tex(g.name); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; flatMats.set(g.name, new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })); }
    const mesh = new THREE.Mesh(geo, g.page >= 0 ? atlasMat("flat", g.page) : flatMats.get(g.name)); mesh.frustumCulled = false; scene.add(mesh); chunks.push([g.chunk, mesh]);
  }
  // right after a fork both roads overlap, and props lining the other branch would stand on our tarmac: drop those
  const forkZones = (data.forks || []).map((f) => [f.at, f.at + 80]);
  const onTarmac = (step, lat) => forkZones.some(([a, b]) => step >= a && step < b) && lat > edgeL[step] - 0.5 && lat < edgeR[step] + 0.5;
  const animProps = [], batches = new Map();
  for (const pr of props) {
    const [step, lat, name, w, h, mirror, , frames] = pr;
    if (step >= pts.length - 1) continue;
    if (onTarmac(step, lat)) continue;
    if (branches.length) { const p = pts[step]; if (onBranches(p.x + Math.cos(p.h) * lat, p.z + Math.sin(p.h) * lat, step)) continue; }
    if (frames) { animProps.push(pr); continue; }
    const ar = arect(name), bk = (ar ? "A" + ar[0] : name) + "@" + ((step / CHUNK) | 0);
    if (!batches.has(bk)) batches.set(bk, { name, page: ar ? ar[0] : -1, chunk: (step / CHUNK) | 0, pos: [], corner: [], uv: [], idx: [], steps: [] });
    const g = batches.get(bk), [x, y, z] = propSpot(step, lat), hw = (w * PROP_PX) / 2, hh = h * PROP_PX, n = g.pos.length / 3;
    const u0 = mirror ? 1 : 0, u1 = mirror ? 0 : 1;
    for (const [cx, cy, u, v] of [[-hw, 0, u0, 0], [hw, 0, u1, 0], [hw, hh, u1, 1], [-hw, hh, u0, 1]]) { g.pos.push(x, y, z); g.steps.push(step); g.corner.push(cx, cy); g.uv.push(ar ? ar[1] + u * ar[3] : u, ar ? ar[2] + v * ar[4] : v); }
    g.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  const billboard = (sh) => {
    sh.vertexShader = "attribute vec2 corner;\n" + sh.vertexShader.replace("#include <project_vertex>",
      "vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 ); mvPosition.xy += corner; gl_Position = projectionMatrix * mvPosition;");
  };
  const batchMats = new Map();
  for (const g of batches.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("corner", new THREE.Float32BufferAttribute(g.corner, 2));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2)); geo.setAttribute("roadStep", new THREE.Float32BufferAttribute(g.steps, 1)); geo.setIndex(g.idx);
    if (g.page < 0 && !batchMats.has(g.name)) { const t = tex(g.name); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; const m = new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide }); m.onBeforeCompile = billboard; clipRoadside(m); batchMats.set(g.name, m); }
    const mesh = new THREE.Mesh(geo, g.page >= 0 ? atlasMat("bill", g.page) : batchMats.get(g.name)); mesh.frustumCulled = false; scene.add(mesh); chunks.push([g.chunk, mesh]);
  }
  // ---- Branch scenery: props and building fronts of the segments on each fork's other branch, placed along the decoded
  // branch path, with its own decoded lane counts. Chunked by the equivalent main-road progress.
  const forkProps = await fetch(`./data/${course}-props-forks.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const branchSolids = branches.map(() => []);
  branches.forEach((B, k) => {
    const firstChunk = chunks.length;
    const list = forkProps[B.fi] || [], P = B.bp, chunkOf = (st) => (((B.at + (st * B.LA) / B.LB) / CHUNK) | 0);
    const spot = (st, l) => { const p = P[Math.min(P.length - 1, st)]; return [p.x + Math.cos(p.h) * l, p.y, p.z + Math.sin(p.h) * l]; };
    const bb = new Map();
    for (const [st, off, name, w, h, mirror, side, frames] of list) {
      if (frames || st >= P.length) continue;
      const lat = (side < 0 ? B.edgeL[st] : B.edgeR[st]) + side * off;
      { const p = P[Math.min(P.length - 1, st)]; if (onMain(p.x + Math.cos(p.h) * lat, p.z + Math.sin(p.h) * lat, B.at + (st * B.LA) / B.LB, 0, B)) continue; }
      const ar = arect(name), key = (ar ? "A" + ar[0] : name) + "@" + chunkOf(st);
      if (!bb.has(key)) bb.set(key, { name, page: ar ? ar[0] : -1, chunk: chunkOf(st), pos: [], corner: [], uv: [], idx: [] });
      const g = bb.get(key), [x, y, z] = spot(st, lat), hw = (w * PROP_PX) / 2, hh = h * PROP_PX, n = g.pos.length / 3, u0 = mirror ? 1 : 0, u1 = mirror ? 0 : 1;
      for (const [cx, cy, u, v] of [[-hw, 0, u0, 0], [hw, 0, u1, 0], [hw, hh, u1, 1], [-hw, hh, u0, 1]]) { g.pos.push(x, y, z); g.corner.push(cx, cy); g.uv.push(ar ? ar[1] + u * ar[3] : u, ar ? ar[2] + v * ar[4] : v); }
      g.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
      branchSolids[k].push({ s: st, lat, hw: Math.max(0.25, w * PROP_PX * 0.18) });
    }
    for (const g of bb.values()) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("corner", new THREE.Float32BufferAttribute(g.corner, 2)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2)); geo.setIndex(g.idx);
      let mat; if (g.page >= 0) mat = atlasMat("bill", g.page); else { const t = tex(g.name); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; mat = new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide }); mat.onBeforeCompile = billboard; }
      const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; scene.add(mesh); chunks.push([g.chunk, mesh]);
    }
    // building fronts on the branch
    for (let i = firstChunk; i < chunks.length; i++) chunks[i][1].userData.route = k;
    const sides = scen?.forks?.[B.fi]; if (!sides) return;
    const walls = new Map();
    for (const [sideArr, sgn] of [[sides.left, -1], [sides.right, 1]]) for (let i = 0; i < Math.min(sideArr.length, P.length - 1); i++) {
      const cell = sideArr[i]; if (!cell) continue;
      const list = scen.fams[cell[0]]; if (!list) continue;
      // rows of facade pieces facing along the branch, as on the main road (0x40c450)
      const shv = (shoulderForks[B.fi] || [])[i], edge = Math.abs(sgn < 0 ? B.edgeL[i] : B.edgeR[i]) + (shv ? (shv[sgn < 0 ? 0 : 1] * 0.069) / 4 : KERB * 3), p = P[i], rx = Math.cos(p.h) * sgn, rz = Math.sin(p.h) * sgn;
      if (onMain(p.x + rx * edge, p.z + rz * edge, B.at + (i * B.LA) / B.LB, 0, B)) continue;
      const PW = (256 * 0.069) / 4, NP = matchMedia("(pointer: coarse)").matches ? 2 : 4;
      const objAt = (k) => { const idx = k < 4 || cell[1] === 0 ? cell[1] : ((k - 4) >> 1) % 2 ? cell[1] : 0; return list[idx] || (idx > 0 ? list[idx - 1] : null); };
      for (let k = 0; k < NP; ) {
        const obj = objAt(k); let n2 = 1; while (k + n2 < NP && objAt(k + n2) === obj) n2++;
        if (obj) {
          const [name, ht] = obj, H = (ht * 16 * 0.069) / 4, ar = arect(name), key = (ar ? "A" + ar[0] : name) + "@" + chunkOf(i);
          if (!walls.has(key)) walls.set(key, { name, page: ar ? ar[0] : -1, chunk: chunkOf(i), pos: [], uv: [], rect: [], idx: [] });
          const g = walls.get(key), base = g.pos.length / 3, d0 = edge + k * PW, d1 = d0 + n2 * PW;
          for (const [d, u] of [[d0, 0], [d1, n2]]) { const uu = sgn < 0 ? n2 - u : u; g.pos.push(p.x + rx * d, p.y, p.z + rz * d, p.x + rx * d, p.y + H, p.z + rz * d); g.uv.push(uu, 0, uu, 1); }
          if (ar) for (let q = 0; q < 4; q++) g.rect.push(ar[1], ar[2], ar[3], ar[4]);
          g.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
        k += n2;
      }
    }
    for (const g of walls.values()) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(g.pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(g.uv, 2)); geo.setIndex(g.idx);
      let mat; if (g.page >= 0) { geo.setAttribute("rect", new THREE.Float32BufferAttribute(g.rect, 4)); mat = atlasMat("wall", g.page); } else mat = new THREE.MeshBasicMaterial({ map: tex(g.name), side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat); scene.add(mesh); chunks.push([g.chunk, mesh]);
    }
    for (let i = firstChunk; i < chunks.length; i++) chunks[i][1].userData.route = k;
  });
  for (let k = 0; k < 40; k++) { const sp = new THREE.Sprite(); sp.center.set(0.5, 0); sp.visible = false; scene.add(sp); pool.push(sp); }
  let propLo = 0;
  function placeProps(atStep) {
    while (propLo < animProps.length && animProps[propLo][0] < atStep - 15) propLo++;
    while (propLo > 0 && animProps[propLo - 1][0] >= atStep - 15) propLo--;
    let k = 0;
    for (let j = propLo; j < animProps.length && k < pool.length; j++) {
      const [step, lat, , w, h, mirror, , frames] = animProps[j];
      if (step > atStep + 320) break;
      const sp = pool[k++];
      sp.material = propMat(frames[((Math.max(0, clock) * 8) | 0) % frames.length], mirror); // walk cycle
      sp.position.set(...propSpot(step, lat)).applyMatrix4(chartMatrix(mainChart)); sp.scale.set(w * PROP_PX, h * PROP_PX, 1); sp.visible = sp.position.distanceTo(camera.position) > 3;
    }
    for (; k < pool.length; k++) pool[k].visible = false;
  }

  // Start line and finish line use the original START160 / FINISH road textures.
  for (const [s, name] of [[52, "START160"], [FIN, "FINISH"]]) {
    const t = track(s), m = new THREE.Mesh(new THREE.PlaneGeometry(edgeAt(s, 1) - edgeAt(s, -1), 3), new THREE.MeshBasicMaterial({ map: tex(name), transparent: true }));
    m.material.map.wrapS = THREE.RepeatWrapping; m.material.map.repeat.set(2, 1);
    m.geometry.rotateX(-Math.PI / 2); m.rotation.y = -t.h; m.position.copy(toWorld(t, (edgeAt(s, -1) + edgeAt(s, 1)) / 2, 0.03)); m.updateMatrix(); m.userData.localMatrix = m.matrix.clone(); scene.add(m);
  }
  const skyTex = loader.load(`./data/horizon-${HORIZON[course]}.png`, (tx) => {
    // match the clear colour to the top of the horizon art so the backdrop's upper edge disappears
    const c = document.createElement("canvas"); c.width = tx.image.width; c.height = 6; const g = c.getContext("2d"); g.drawImage(tx.image, 0, 0);
    const px = g.getImageData(0, 0, c.width, 6).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4; scene.background = new THREE.Color(`rgb(${(r / n) | 0},${(gg / n) | 0},${(b / n) | 0})`);
  }); skyTex.colorSpace = THREE.SRGBColorSpace; skyTex.wrapS = THREE.RepeatWrapping; skyTex.repeat.x = 3;
  const sky = new THREE.Mesh(new THREE.CylinderGeometry(1500, 1500, 1200, 48, 1, true), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1;
  scene.add(sky); scene.background = new THREE.Color(0x87a8f0);

  // ---- Riders ----
  function riderTexture(sc) { if (!sh.textures.has(sc)) { const t = loader.load(`./data/rider${sc}.png`); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; sh.textures.set(sc, t); } return sh.textures.get(sc); }
  const shadowBase = loader.load("./data/shadow.png"); shadowBase.magFilter = THREE.NearestFilter; shadowBase.minFilter = THREE.LinearFilter; shadowBase.generateMipmaps = false;
  function makeRider(sc, cop = false) {
    const base = cop ? (sh.copTex ||= Object.assign(loader.load("./data/cop.png"), { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.NearestFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true })) : riderTexture(sc);
    const t = base.clone(); t.needsUpdate = !!base.image;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.5 })); sp.center.set(0.5, 0);
    const st = shadowBase.clone(); st.needsUpdate = !!shadowBase.image;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: st, color: 0, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 })); shadow.rotation.order = "YXZ";
    scene.add(sp, shadow);
    const R = cop ? sh.copRects : sh.riderRects, S = sh.shadowRects;
    // The cop only exists as a LOCOP (low-detail) sprite, about half the resolution of HIBOB (the game ships no high-detail
    // cop). Scale it so the upright riding frame (3) stands exactly as tall as a rider's.
    const px = cop ? PX * sh.riderRects.rects[3].h / sh.copRects.rects[3].h : PX;
    return { sp, shadow, show(i, mirror) {
      const r = R.rects[i]; if (r) { t.repeat.set((mirror ? -r.w : r.w) / R.W, r.h / R.H); t.offset.set((mirror ? r.x + r.w : r.x) / R.W, 1 - (r.y + r.h) / R.H); sp.scale.set(r.w * px, r.h * px, 1); const anchor = r.anchorX ?? .5; sp.center.set(mirror ? 1 - anchor : anchor, 0); }
      const q = S.rects[Math.min(i, 3)]; if (q) { st.repeat.set((mirror ? -q.w : q.w) / S.W, q.h / S.H); st.offset.set((mirror ? q.x + q.w : q.x) / S.W, 1 - (q.y + q.h) / S.H); shadow.scale.set(q.w * PX, q.h * PX * 2.2, 1); }
    } };
  }
  const newState = (s, lat) => ({ s, br: -1, bs: 0, brPick: branches.map(() => Math.random() < 0.25), lat, v: 0, yb: track(s).y, vy: 0, air: false, lean: 0, health: 5, punchT: 0, punchSide: 0, crashT: 0, wobble: 0, cool: 1 + Math.random() * 2, finished: 0 });
  // Starting positions from the EXE: {sideways, road position} in 1/256 units. The player starts from the grid table
  // 0x464218 by rider index (0x4b8a10); the other 15 take field positions 1-15 of 0x464088 (levels 1-4) or 0x464108
  // (level 5), which put about half the field up the road (steps 83-123) rather than on the grid. Each rider starts in a
  // random lane on its side (0x405990: sideways = lane edge + 25 + x, lanes 250 units wide = LANE_W).
  const GRID = [[16384, 12800], [-3616, 12800], [-23616, 12800], [-43616, 12800], [16384, 13056], [-3616, 13056], [-23616, 13056], [-43616, 13056],
    [16384, 13056], [-3616, 13056], [-23616, 13056], [-43616, 13056], [16384, 12800], [-3616, 12800], [-23616, 12800], [-43616, 12800]];
  const FIELD_GRID = (opts.level ?? 1) >= 5
    ? [[64, 50], [64, 118], [64, 68], [64, 78], [160, 54], [64, 103], [32, 108], [144, 113], [80, 93], [160, 52], [160, 56], [160, 73], [160, 83], [64, 88], [160, 98], [0, 88]]
    : [[64, 50], [64, 123], [64, 54], [64, 56], [160, 52], [64, 98], [32, 108], [144, 118], [80, 88], [160, 51], [160, 53], [160, 55], [160, 57], [64, 83], [160, 93], [0, 88]];
  const startAt = ([x, s]) => { const lanes = Math.max(1, Math.round(edgeAt(s, 1) / LANE_W)), k = Math.floor(Math.random() * lanes);
    return [s, ((k * 250 + 25 + x) / 250) * LANE_W]; };
  const me = { ...newState(...startAt(GRID[opts.slot ?? 0].map((v) => v / 256))), name: opts.playerName || "Player", sprite: makeRider(scheme), bike, nitros: bike.nitro ? 3 : 0, ...(opts.rider || {}) };
  me.bikeSprite = makeRider(scheme); me.bikeSprite.sp.visible = me.bikeSprite.shadow.visible = false;
  const field = rivals.map((r, i) => ({ ...newState(...startAt(FIELD_GRID[(i % 15) + 1])), ...r, sprite: makeRider(r.scheme),
    lane: [1.2, 2.4, 3.6, 4.8, 6, 7.2][i % 6], skill: (r.skill ?? 0.9 + Math.random() * 0.12) * (1 - 0.04 * ASSIST), bike: r.bike ?? bike, // lanes on our own side (cars come the other way on the left)
    weapon: r.weaponKind !== undefined ? r.weaponKind : Math.random() < 0.3 ? (Math.random() < 0.5 ? "chain" : "club") : null })); // weapon from the rider record
  // Mano-a-Mano (opts.net, see mano.js): riders steered by the other players come in as remote riders, drawn where their
  // state messages put them; the host also runs the A.I. bikers and sends theirs. Hits on a remote rider are sent to
  // whoever owns it, which applies the damage.
  const net = opts.net || null, remote = new Map();
  if (net) {
    for (const p of net.peers) { const r = { ...newState(...startAt(GRID[p.slot % 16].map((v) => v / 256))), ...p, sprite: makeRider(p.scheme), remote: p.id, lane: 3, skill: 1 }; field.push(r); remote.set(p.id, r); }
    field.forEach((r, k) => { if (!r.remote && r.botId) { if (!net.host) { r.remote = r.botId; remote.set(r.botId, r); } } });
  }
  const all = SPECTATE ? [...field] : [me, ...field];
  for (const r of field) { r.bikeSprite = makeRider(r.scheme); r.bikeSprite.sp.visible = r.bikeSprite.shadow.visible = false; }
  // Grudges (EXE brains 0x464558, see tools/bikes.js): rider index 0-8 rides brain k and is personality k to the others;
  // 9-14 copy brain 0 and nobody has a grudge against them; 15 rides brain 9. grudge(r, o) = b - a + c of r's triple for
  // o's personality, each part easing back to rest once a second; being hit and hitting shift them (events 2 and 4).
  const brainOf = (row) => (row < 9 ? row : row === 15 ? 9 : 0), persOf = (row) => (row < 9 ? row : row === 15 ? 9 : -1);
  for (const r of all) { const row = r === me ? opts.slot ?? 8 : r.slot ?? 0, B = opts.brains?.[brainOf(row)];
    r.pers = persOf(row); if (B) r.brain = { B, cur: B.cur.map((t) => [...t]) };
    if (B && r !== me) r.cruise = (B.cruise?.[LV] ?? 0) + (row >= 9 && row <= 14 ? rand(13) - 6 : 0); }
  const grudge = (r, o) => { if (!r.brain || !(o.pers >= 0)) return 0; const [a, b, c] = r.brain.cur[o.pers]; return b - a + c; };
  const grudgeEvent = (r, o, e) => { if (!r.brain || !(o.pers >= 0)) return; const t = r.brain.cur[o.pers], d = r.brain.B.events[e];
    for (let i = 0; i < 3; i++) t[i] = Math.max(-0x100000, Math.min(0x100000, t[i] + d[i])); };
  const condMax = (r) => r.bike?.spec?.condition || 160; // BIKESPEC int 81, see Bike condition below
  for (const r of all) r.cond = condMax(r);

  // ---- Traffic: original car sprites from DATA/CARS/<course>.CAR. Names ending G00 are rear views of cars going our
  // way (right-hand lanes); names ending C00 are front views of cars coming the other way (left-hand lanes) ----
  const carIndex = await fetch("./data/cars.json").then((r) => r.json()).catch(() => ({}));
  const carKinds = (carIndex[course]?.moving || []).filter((k) => !/C00$/.test(k.name)), comingKinds = (carIndex[course]?.moving || []).filter((k) => /C00$/.test(k.name));
  const CAR_PX = 0.058; // metres per car-sprite pixel (a 32px rear view is ~1.85 m wide)
  const traffic = [];
  // 18 cars spread over the race; each fork's other branch gets its share at the same density, driving along it (br/bs)
  const carSlots = []; if (opts.traffic !== false && carKinds.length) {
    for (let k = 0; k < 18; k++) carSlots.push({ br: -1, s: 60 + k * (FIN - 120) / 18 + Math.random() * 40 });
    branches.forEach((B, b) => { for (let k = 0, n = Math.max(1, Math.round((B.LB * 18) / FIN)); k < n; k++) { const bs = ((k + Math.random() * 0.5) * B.LB) / n; carSlots.push({ br: b, bs, s: B.at + (bs * B.LA) / B.LB }); } });
  }
  for (const [k, slot] of carSlots.entries()) {
    const kind = carKinds[k % carKinds.length];
    const t = loader.load(`./data/cars/${kind.name}.png`); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.5 })); sp.center.set(0.5, 0);
    // the 00 frame is the straight-behind view, cropped to the drawn size, so one scale fits every car
    const px = CAR_PX;
    sp.scale.set(kind.w * px, kind.h * px, 1);
    scene.add(sp);
    traffic.push({ sp, ...slot, lat: 1.75, lane: k % 3, v: 12 + Math.random() * 8, w: kind.w * px });
  }
  // oncoming cars stay on the main road and are recycled ahead of the player once they've gone by
  // somewhere in [from, from + span) that isn't just ahead of a rider (riders start strung up the road), so a car never
  // appears on top of someone with no time to get out of its way
  const comingSpot = (from, span) => { let s = from; for (let n = 0; n < 8; n++) { s = from + Math.random() * span;
    if (!all.some((r) => r.br < 0 && s - r.s > -2 && s - r.s < M(90))) break; } return Math.min(END - 5, s); };
  if (opts.traffic !== false) for (let k = 0; k < (comingKinds.length ? 7 : 0); k++) {
    const kind = comingKinds[k % comingKinds.length];
    const t = loader.load(`./data/cars/${kind.name}.png`); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.5 })); sp.center.set(0.5, 0);
    sp.scale.set(kind.w * CAR_PX, kind.h * CAR_PX, 1); scene.add(sp);
    traffic.push({ sp, br: -1, s: comingSpot(80 + k * M(140), M(60)), lat: -1.75, lane: k % 2, v: -(12 + Math.random() * 8), w: kind.w * CAR_PX, coming: true });
  }

  // ---- Intersections (RSEC): traffic lights on city corners and cross traffic using the side-view car sprites ----
  // a cross street is section kind 0 with bit 0x200; finish lines ((level << 8) | 6) and other kinds can carry that bit too
  const crossings = sections.filter((x) => (x[2] & 0xff) === 0 && x[2] & 0x200 && x[0] > 20 && x[1] < END - 5).map(([a, b]) => ({ s: (a + b) / 2, a, b, phase: Math.random() * 12 }));
  const lights = [];
  if (course === "city" || course === "medly") {
    // STOP3E is the pole with dark lamps; STOP3G/Y/R hold only the lit lamp in the same frame, so composite them.
    const loadImg = (n) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = `./data/tex/${n}.png`; });
    const [pole, ...lamps] = await Promise.all(["STOP3E", "STOP3G", "STOP3Y", "STOP3R"].map(loadImg));
    const lightMats = {};
    ["STOP3G", "STOP3Y", "STOP3R"].forEach((n, i) => {
      const c = document.createElement("canvas"); c.width = 128; c.height = 159; const g = c.getContext("2d");
      if (pole) g.drawImage(pole, 0, 0); if (lamps[i]) g.drawImage(lamps[i], 0, 0);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
      lightMats[n] = new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.5 });
    });
    for (const c of crossings) for (const sgn of [-1, 1]) {
      const sp = new THREE.Sprite(lightMats.STOP3G); sp.center.set(0.5, 0); sp.scale.set(128 * 0.04, 159 * 0.04, 1);
      sp.position.copy(toWorld(track(c.a), (sgn < 0 ? edgeAt(c.a, -1) : edgeAt(c.a, 1)) + sgn * KERB * 2)); scene.add(sp); lights.push({ sp, c, mats: lightMats });
    }
  }
  const sideKinds = carIndex[course]?.parked || [];
  const cross = [];
  for (let k = 0; k < 4 && sideKinds.length; k++) {
    const kind = sideKinds[k % sideKinds.length];
    const t = loader.load(`./data/cars/${kind.name}.png`); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.5 })); sp.center.set(0.5, 0); sp.visible = false;
    sp.scale.set(kind.w * CAR_PX, kind.h * CAR_PX, 1); scene.add(sp);
    cross.push({ sp, t, s: 0, lat: 0, dir: 1, v: 11, active: false, w: kind.w * CAR_PX });
  }

  // ---- Pedestrians (RHZD + family character lists), as the EXE handles them (0x451ee0, 0x4520d0, 0x440dd0):
  // each record is kept with probability (f + level + 1)/10 (police records: f + level - 3), its step jittered by ±j.
  // Behaviours 5/6/7 wait at the kerb and cross when a rider approaches (5 earliest, 7 at the last moment),
  // turn around on the far side and wait again; 10 waves a flag; the rest stand. Riders knock them down.
  const pedIndex = await fetch("./data/peds.json").then((r) => r.json()).catch(() => ({}));
  const hzRaw = opts.peds === false ? [] : await fetch(`./data/${course}-hazards.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const spawns = hzRaw.filter((h) => (!h.l || h.l - 1 === LV) && rand(10) <= h.f + LV - (h.cop ? 4 : 0) - (crosses(h) ? ASSIST_PEDS : 0))
    .map((h) => ({ ...h, s: h.s + (h.j ? rand(2 * h.j + 1) - h.j : 0), x: h.x + (h.w ? (Math.random() * 2 - 1) * h.w : 0) })).sort((a, b) => a.s - b.s);
  // each fork's other branch has its own records (steps from the split); they spawn by their main-road equivalent
  const hzForks = opts.peds === false ? [] : await fetch(`./data/${course}-hazards-forks.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const branchSpawns = branches.flatMap((B, br) => (hzForks[B.fi] || []).filter((h) => !h.cop && (!h.l || h.l - 1 === LV) && rand(10) <= h.f + LV - (crosses(h) ? ASSIST_PEDS : 0))
    .map((h) => { const bs = Math.max(0, Math.min(B.LB, h.s + (h.j ? rand(2 * h.j + 1) - h.j : 0))); return { ...h, br, bs, s: B.at + (bs * B.LA) / B.LB, x: h.x + (h.w ? (Math.random() * 2 - 1) * h.w : 0) }; }));
  const copSpawns = spawns.filter((h) => h.cop), pedSpawns = [...spawns, ...branchSpawns].filter((h) => !h.cop && pedIndex[h.p]).sort((a, b) => a.s - b.s);
  const pedTex = new Map(), peds = []; let pedNext = 0;
  // walking speed: 4*100 position units (1/256 of a sideways unit) per 60 Hz tick = 1.6 m/s; 8 when running
  const PED_VOICE = [[/^BKM/, ["bkm1_hey", "bkm1_huh", "bkm2_hld"]], [/^BKW/, ["bkw1_don", "bkw2_bit", "bkw3_stp"]], [/^(BUSM|BSM)/, ["bsm1_wat", "bsm2_woa", "bsm3_wha"]],
    [/^(BUSW|BSW)/, ["bsw1_no", "bsw2_aaa", "bsw3_hey"]], [/^OLD/, ["ol_aaa", "ol_make"]], [/^SK/, ["sk1_dude", "sk1_eatt"]], [/^TRST/, ["tour_aaa", "tour_bac"]],
    [/^MJOG/, ["jm_aiie"]], [/^JGW/, ["jf_no"]], [/^FLG/, ["fg1_watc", "fg2_eek"]], [/^CT/, ["cm1_heym", "cm3_arrg"]], [/^(AVGW|BCHW|FEM)/, ["af1_eek", "hf_help"]], [/^(DAVE|DVR|HHM)/, ["dm_holys", "dm_usob"]]];
  const voice = (name) => { const v = PED_VOICE.find(([re]) => re.test(name)); return v ? v[1][rand(v[1].length)] : null; };
  const pedFree = new Map(); // ped key -> idle sprites to reuse (no material churn or texture re-uploads mid-race)
  function spawnPed(h) {
    const P = pedIndex[h.p];
    let sp, t;
    const free = pedFree.get(h.p);
    if (free?.length) { ({ sp, t } = free.pop()); sp.visible = true; }
    else {
      if (!pedTex.has(h.p)) { const b = loader.load(`./data/peds/${h.p}.png`); b.colorSpace = THREE.SRGBColorSpace; b.magFilter = THREE.NearestFilter; b.generateMipmaps = false; b.minFilter = THREE.LinearFilter; pedTex.set(h.p, b); }
      t = pedTex.get(h.p).clone(); allTex.push(t);
      sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.5 })); scene.add(sp);
    }
    const W = P.rects.reduce((a, r) => a + r[1], 0), idleH = P.rects[P.idle[0][0]]?.[2] || P.H;
    // the idle pose is a standing adult (~1.75 m); the cow is shorter and longer
    const m = (/^COW/.test(P.name) ? 1.5 : 1.75) / idleH;
    const crosser = h.b >= 5 && h.b <= 7 && P.walk;
    const fast = /JOG|JGW|SK/.test(P.name);
    // a spot inside a hillside or over a drop (the port's terrain is an approximation): walk it toward the road until
    // the ground is near road level, the way riders are pushed out of rock, so the ped stands where it can be seen
    let x = h.x;
    if ((h.br ?? -1) < 0) for (let k = 0; k < 120 && Math.abs(terrainY(h.s, x)) > 0.5 && Math.abs(x) > Math.abs(edgeAt(h.s, Math.sign(x) || 1)) - 0.5; k++) x -= Math.sign(x) * 0.5;
    // records that land on our tarmac (the port's roads run wider than the original's in places): stand on the kerb
    // instead; crossers still cross from there. Flag wavers (roadworks flagmen) keep their spot.
    if ((h.br ?? -1) < 0 && h.b !== 10 && h.s > 60) { const side = Math.sign(x) || (Math.random() < 0.5 ? -1 : 1), edge = Math.abs(edgeAt(h.s, side)); if (Math.abs(x) < edge + 0.3) x = side * (edge + 0.8); }
    peds.push({ h, P, sp, t, W, m, s: h.s, br: h.br ?? -1, bs: h.bs, x, state: "idle", anim: P.idle, at: 0, dir: x < 0 ? 1 : -1, crosser, speed: fast ? 3.2 : 1.6, wait: 0, from: x,
      trigger: h.b === 5 ? 2.6 : h.b === 6 ? 1.3 : 0.15, wave: h.b === 10 ? waveOf(P, idleH) : null });
  }
  // Flag wavers (behaviour 10) have no wave of their own: their only other animation is being knocked over, and looping
  // all of it made the start-line flag girl throw her flag and sit down on the road over and over. Standing, they sway
  // between the idle pose and that animation's first upright frames (at most two); the rest plays when they're hit.
  function waveOf(P, idleH) {
    const idle = P.idle?.[0]?.[0] ?? 0, lead = [];
    for (const [f] of P.fall || []) { if (lead.length >= 2 || (P.rects[f]?.[2] ?? 0) < 0.9 * idleH) break; if (f !== idle && !lead.includes(f)) lead.push(f); }
    return lead.length ? [[idle, 420], ...lead.map((f) => [f, 240]), ...lead.slice(0, -1).reverse().map((f) => [f, 240])] : null;
  }
  function setPed(p, state, anim) { p.state = state; p.anim = anim; p.at = 0; }
  // countdown: the start-line crowd is already standing there (the flag girl waves); nobody moves until the GO
  function stepPeds(dt, countdown = false) {
    while (pedNext < pedSpawns.length && pedSpawns[pedNext].s < me.s + M(520)) { if (pedSpawns[pedNext].s > me.s - M(10)) spawnPed(pedSpawns[pedNext]); pedNext++; }
    if (countdown) { for (const p of peds) p.at += dt * 1000; return; }
    for (let k = peds.length - 1; k >= 0; k--) {
      const p = peds[k]; p.at += dt * 1000;
      if (p.s < me.s - M(50)) { p.sp.visible = false; if (!pedFree.has(p.h.p)) pedFree.set(p.h.p, []); pedFree.get(p.h.p).push({ sp: p.sp, t: p.t }); peds.splice(k, 1); continue; }
      if (p.state === "idle" && p.crosser) {
        p.wait -= dt;
        // the EXE starts the crossing while the nearest rider is still at least speed x margin away
        let r = null; for (const o of all) if (o.br === p.br && along(o) < along(p) && o.crashT <= 0 && (!r || along(o) > along(r))) r = o;
        const gap = r ? (along(p) - along(r)) * STEP : Infinity;
        if (p.wait <= 0 && gap < 150 && gap > r.v * p.trigger) { setPed(p, "cross", p.P.walk); p.from = p.x; if (Math.abs(gap) < 60) { const v = voice(p.P.name); if (v) sfx(v, 0.5); } }
      } else if (p.state === "cross") {
        p.x += p.dir * p.speed * dt;
        // on the far kerb: stop, turn round and wait (the EXE adds 160 to its wait position)
        if (Math.sign(p.x) === p.dir && Math.abs(p.x) >= Math.max(Math.abs(p.from), Math.abs(EA(p, p.dir)) + KERB)) { setPed(p, "idle", p.P.idle); p.dir = -p.dir; p.wait = 6; }
      }
      // the start-line crowd and flag girl stand among the grid (steps 50-56): riders pass through them
      if (p.state !== "down" && p.s > 57) for (const r of all) {
        // swept along the road from where the rider was last frame, so a long frame (slow phone) can't skip past them
        const a1 = along(r), a0 = r.prevAlong ?? a1, lo = Math.min(a0, a1) * STEP - 1.2, hi = Math.max(a0, a1) * STEP + 1.2, ps = along(p) * STEP;
        if (r.remote || r.crashT > 0 || r.s < 0 || r.br !== p.br || ps < lo || ps > hi || Math.abs(a1 - a0) > 3 || Math.abs(r.lat - p.x) > 0.7) continue;
        setPed(p, "down", p.P.fall || p.P.idle);
        const v = voice(p.P.name); if (v) sfx(v, r === me ? 0.8 : 0.3);
        sfx("crashlit", r === me ? 0.7 : 0.25);
        if (r.v > 20) crash(r, "pedestrian"); else { r.wobble = 0.6; r.v *= 0.6; }
        break;
      }
    }
  }
  let roadLo = 0;
  // Roadside obstacles: static props (trees, poles, signs, hydrants...) and building fronts knock you off, as in the
  // original (its roadside collision is 0x43a610); with the skid model this is how a slide ends in a crash.
  const solidProps = props.filter((p) => !p[7] && p[0] < pts.length - 1).map((p) => ({ s: p[0], lat: p[1], hw: Math.max(0.25, p[3] * PROP_PX * 0.18) }))
    .sort((a, b) => a.s - b.s);
  let solidLo = 0;
  // solid objects on (or at the edge of) the tarmac, which rivals steer round; blockLo trails the pack
  const roadBlocks = solidProps.filter((o) => o.lat > edgeAt(o.s, -1) - 0.6 && o.lat < edgeAt(o.s, 1) + 0.6); let blockLo = 0;
  // A low-speed contact must leave room to steer away. Keeping the rider inside the obstacle while resetting
  // speed to zero every tick made restarting impossible, especially after the bike slid into a sign or barricade.
  function clearObstacle(r, x, half) {
    const left = x - half - 0.45, right = x + half + 0.45;
    r.lat = Math.abs(r.lat - left) < Math.abs(r.lat - right) ? left : right;
    r.vlat = 0;
  }
  function recoverBike(r) {
    const s = along(r), sg = Math.sign(r.lat) || 1;
    if (r.br < 0) {
      const i = Math.round(r.s), wall = faceAt(r.s, sg), buildings = sg < 0 ? scen?.left : scen?.right;
      const limit = Math.min(wall ? wall - 0.8 : Infinity, tunAt[i] ? tunAt[i] - 0.6 : Infinity,
        buildings?.[i] ? Math.abs(edgeAt(r.s, sg)) + swAt(r.s, sg) - 0.8 : Infinity);
      if (Math.abs(r.lat) > limit || Math.abs(terrainY(r.s, r.lat)) > 1.2) r.lat = sg * Math.min(limit, Math.abs(edgeAt(r.s, sg)) - 1);
    } else {
      const B = branches[r.br], i = Math.max(0, Math.min(B.LB, Math.round(r.bs))), walls = scen?.forks?.[B.fi]?.[sg < 0 ? "left" : "right"];
      if (walls?.[i] || branchRails[r.br].mask[i] & (sg < 0 ? 1 : 2)) r.lat = sg * Math.min(Math.abs(r.lat), Math.abs(EA(r, sg)) + shoulderAt(r, sg) - 0.8);
    }
    for (const o of r.br >= 0 ? branchSolids[r.br] : solidProps) {
      if (o.s > s + M(2)) break;
      if (Math.abs(o.s - s) < M(2) && Math.abs(r.lat - o.lat) < o.hw + 0.4) clearObstacle(r, o.lat, o.hw);
    }
    if (r.br < 0) for (const o of roadObjs) {
      if (o.s > s + M(2)) break;
      if (o.fx === "solid" && Math.abs(o.s - s) < M(2) && Math.abs(r.lat - o.x) < o.hw + 0.4) clearObstacle(r, o.x, o.hw);
    }
    if (r === me && ASSIST >= 0.4) {
      const obstacles = (r.br >= 0 ? branchSolids[r.br] : solidProps).filter(o => Math.abs(o.s - s) < M(2));
      if (r.br < 0) for (const o of roadObjs) if (o.fx === "solid" && Math.abs(o.s - s) < M(2)) obstacles.push({lat:o.x, hw:o.hw});
      r.lat = recoveryLane(r.lat, EA(r, -1), EA(r, 1), obstacles);
    }
    r.yb = T(r).y + (r.br >= 0 ? 0 : terrainY(r.s, r.lat)); r.vy = 0; r.air = false;
    r.turn = r.skid = r.vlat = r.tick = r.thr = r.brk = r.gi = 0; r.gear = 1;
  }
  function settleBike(r, D) {
    const q = { ...r, lat: D.bl };
    if (r.br >= 0) { const B = branches[r.br]; q.bs = Math.max(0, Math.min(B.LB - 0.01, r.bs + D.d)); q.s = B.at + q.bs * B.LA / B.LB; }
    else q.s = Math.max(0, Math.min(END - 1, r.s + D.d));
    recoverBike(q);
    // The walk-back target must be reachable. A random bike offset behind a rock face made the walker
    // fight the terrain correction forever, so the remount phase could never begin.
    if (q.br < 0 && terrainY(q.s, q.lat) > 1.2) q.lat = Math.max(EA(q, -1) + 0.8, Math.min(EA(q, 1) - 0.8, q.lat));
    D.bl = q.lat; D.d = along(q) - along(r);
  }
  function roadside(r) {
    if (r.crashT > 0 || r.air || r.s < 0) return;
    if (r.br >= 0) { // on a branch: its own barriers and props, using the same widths as the visible verge
      const B = branches[r.br], i = Math.max(0, Math.min(B.LB, Math.round(r.bs))), sg = Math.sign(r.lat) || 1;
      const walls = scen?.forks?.[B.fi]?.[sg < 0 ? "left" : "right"], rails = branchRails[r.br];
      const wall = walls?.[i], rail = rails.mask[i] & (sg < 0 ? 1 : 2);
      if (wall || rail) {
        const limit = Math.abs(EA(r, sg)) + shoulderAt(r, sg) + (rail && !wall ? rails.offset[i] : 0) - 0.4;
        if (Math.abs(r.lat) > limit) { r.lat = sg * limit; r.v *= 0.985; r.vlat = 0; }
      }
      for (const o of branchSolids[r.br]) if (Math.abs(o.s - r.bs) < M(1.2) && Math.abs(r.lat - o.lat) < o.hw + 0.3) { if (r.v > propCrash(r)) { impact(r, r.v, 2, "hard"); crash(r, "prop"); if (r === me) sfx("crashhar", 0.9); } else { r.v = 0; clearObstacle(r, o.lat, o.hw); } return; }
      return;
    }
    // building fronts: walls stand at the pavement's outer edge wherever RBLD has frontage
    const i = Math.round(r.s), sideArr = r.lat < 0 ? scen?.left : scen?.right;
    // mountain roadsides: a sheer rock face stops the bike like a wall (no damage from the wall itself, 0x43a1b0)
    // tunnel walls: the bike scrapes along them (the original's roadside walls do no damage)
    // guardrails: a barrier at the verge's outer edge (plus its offset) that the bike scrapes along and can't pass
    // through, from either side (roadside walls do no damage, 0x43a1b0)
    { const ri = Math.round(r.s), sg = r.lat < 0 ? -1 : 1, rl = (sg < 0 ? railL : railR)[ri];
      if (rl) { const at = Math.abs(edgeAt(r.s, sg)) + swAt(ri, sg) + railOff[ri], d = Math.abs(r.lat), was = Math.abs(r.prevLat ?? r.lat);
        if (was <= at && d > at - 0.4) { r.lat = sg * (at - 0.4); r.v *= 0.985; r.vlat = 0; }
        else if (was > at && d < at + 0.4) { r.lat = sg * (at + 0.4); r.vlat = 0; } } }
    const tw = tunAt[Math.round(r.s)]; if (tw && Math.abs(r.lat) > tw - 0.5) { r.lat = Math.sign(r.lat) * (tw - 0.5); r.v *= 0.985; r.vlat = 0; }
    const face = faceAt(r.s, Math.sign(r.lat));
    if (face) {
      if (Math.abs(r.lat) > face - 0.4) { r.lat = Math.sign(r.lat) * (face - 0.8); if (r.v > 8) { crash(r, "wall"); if (r === me) sfx("crashhar", 0.9); } else r.v *= 0.5; return; } }
    if (sideArr?.[i] && Math.abs(r.lat) > Math.abs(edgeAt(r.s, Math.sign(r.lat))) + swAt(r.s, r.lat) - 0.4) {
      r.lat = Math.sign(r.lat) * (Math.abs(edgeAt(r.s, Math.sign(r.lat))) + swAt(r.s, r.lat) - 0.8);
      if (r.v > 8) { crash(r, "wall"); if (r === me) sfx("crashhar", 0.9); } else r.v *= 0.5;
      return;
    }
    const s0 = r.prevAlong !== undefined && Math.abs(r.prevAlong - r.s) < 3 ? Math.min(r.prevAlong, r.s) : r.s; // swept from last frame
    for (let k = solidLo; k < solidProps.length && solidProps[k].s <= r.s + M(1.2); k++) {
      const o = solidProps[k]; if (o.s < s0 - M(1.2)) continue;
      if (Math.abs(r.lat - o.lat) < o.hw + 0.3) { if (r.v > propCrash(r)) { impact(r, r.v, 2, "hard"); crash(r, "prop"); if (r === me) sfx("crashhar", 0.9); } else { r.v = 0; clearObstacle(r, o.lat, o.hw); } return; }
    }
  }
  function stepRoad() {
    while (solidLo < solidProps.length && solidProps[solidLo].s < me.s - M(120)) solidLo++;
    while (blockLo < roadBlocks.length && roadBlocks[blockLo].s < me.s - M(150)) blockLo++;
    for (const r of all) if (!r.remote && r.s > me.s - M(110)) roadside(r);
    while (roadLo < roadObjs.length && roadObjs[roadLo].s < me.s - M(60)) roadLo++;
    for (let k = roadLo; k < roadObjs.length && roadObjs[k].s < me.s + M(80); k++) {
      const o = roadObjs[k];
      for (const r of all) {
        if (r.crashT > 0 || r.air || r.s < 0 || r.br >= 0 || Math.abs((r.s - o.s) * STEP) > 1.2 || Math.abs(r.lat - o.x) > o.hw + 0.35) continue;
        if (o.fx === "slick") { r.slick = 0.7; if (r === me && !o.heard) { o.heard = true; sfx("skidonnr", 0.6); } }
        else if (o.fx === "wet") r.wetT = 0.4;
        else if (o.fx === "loose") { r.looseT = 0.5; if (r === me && !o.heard) { o.heard = true; sfx("skidoffr", 0.5); } }
        else if (o.fx === "bump") { if (r.v > 8) { r.wobble = 0.4; r.vy = Math.max(r.vy, 1.5); } }
        else { // solid: every rider can hit it; a previous rival's contact does not disable the obstacle
          if (r.v > 9) { impact(r, r.v, o.heavy ? 2 : 0.5, o.heavy ? "hard" : "rider"); crash(r, "obstacle"); if (r === me) sfx("crashhar", 0.9); } else { r.v = 0; r.wobble = 0.5; clearObstacle(r, o.x, o.hw); }
        }
      }
    }
  }
  function drawPeds(alpha = 1) {
    for (const state of peds) {
      const p = renderPose(state, alpha, branches);
      p.sp.visible = p.br === me.br; if (!p.sp.visible) continue;
      const seq = p.state === "idle" && p.wave ? p.wave : p.anim; let tt = p.at, i = 0;
      const total = seq.reduce((a, q) => a + q[1], 0);
      if (p.state === "down") tt = Math.min(tt, total - 1); else tt %= total;
      while (i < seq.length - 1 && tt >= seq[i][1]) { tt -= seq[i][1]; i++; }
      const [x, w, h, ax = 0.5] = p.P.rects[seq[i][0]] || p.P.rects[0]; // ax: body anchor (tools/ped-anchors.py)
      // the character frames face left (screen-left = negative lat): mirror when walking right; standing peds face the road
      const mirror = p.state === "cross" ? p.dir > 0 : p.state === "idle" ? p.x < 0 : false;
      p.t.repeat.set((mirror ? -w : w) / p.W, h / p.P.H); p.t.offset.set((mirror ? x + w : x) / p.W, 0);
      p.sp.center.set(mirror ? 1 - ax : ax, 0);
      p.sp.scale.set(w * p.m, h * p.m, 1);
      const side = Math.abs(p.x) > 7 ? Math.sign(p.x) * Math.max(0, Math.abs(EA(p, Math.sign(p.x))) - 7) : 0;
      // stand on the ground under them (verges, kerbs and hillsides aren't at road height), as riders and props do
      p.sp.position.copy(toWorld(T(p), p.x + side, p.br < 0 ? terrainY(p.s, p.x + side) : 0));
    }
  }

  // ---- Police: one cop on the original LOCOP sprites, rides up from behind with the siren on ----
  const cop = { ...newState(-999, 0), name: opts.copName || "Officer", isCop: true, active: false, due: 25 + Math.random() * 35,
    sprite: makeRider(0, true), bike: { ...bike, top: bike.top * 1.06, grip: 1, spec: bike.spec && { ...bike.spec, power: Math.round(bike.spec.power * 1.12) } }, skill: 1 };
  cop.sprite.sp.visible = cop.sprite.shadow.visible = false;
  if (opts.police !== false && !SPECTATE) all.push(cop);
  let siren = null;

  // ---- Audio ----
  // Sound effects through Web Audio: each sample is fetched and decoded once (kept across races) and played from
  // memory; a new <audio> element per effect stalls phones. Engine and siren are looping buffer sources.
  const AC = (sh.ac ||= window.AudioContext || window.webkitAudioContext ? new (window.AudioContext || window.webkitAudioContext)() : null);
  AC?.resume?.().catch(() => {});
  const bufs = (sh.bufs ||= new Map());
  // decodeAudioData both calls back and returns a promise; a failed decode must be caught on the promise too
  const sample = (n) => { if (!bufs.has(n)) bufs.set(n, fetch(`./assets/sfx/${n}.wav`).then((r) => r.arrayBuffer()).then((b) => new Promise((ok) => { AC.decodeAudioData(b, ok, () => ok(null))?.catch?.(() => ok(null)); })).catch(() => null)); return bufs.get(n); };
  // Sound Mix (Restroom): master, sound effects, player's engine, other engines, police siren, game music (0..1 each)
  const mix = { master: 1, sfx: 1, engine: 1, others: 1, siren: 1, music: 1, ...(opts.mix || {}) };
  const play = (n, vol, loop) => {
    if (!AC) return null;
    const ch = n.startsWith("eng") ? mix.engine : n.startsWith("siren") ? mix.siren : mix.sfx;
    const g = AC.createGain(); g.gain.value = vol * ch * mix.master; g.connect(masterOut());
    const h = { g, src: null, rate: 1, stopped: false, pause() { this.stopped = true; try { this.src?.stop(); } catch {} this.g.disconnect(); } };
    sample(n).then((buf) => { if (!buf || h.stopped) return; const src = AC.createBufferSource(); src.buffer = buf; src.loop = !!loop; src.playbackRate.value = h.rate; src.connect(g); src.onended = () => { src.disconnect(); g.disconnect(); }; src.start(); h.src = src; });
    return h;
  };
  const sfx = (n, vol = 0.7) => { play(n, vol, false); };
  const engineName = `eng${bike.cls === "rat" ? "rat" : bike.cls === "super" ? "super" : "sport"}`;
  let engine = null, raceReady = false;
  const setEngineRate = (r) => { if (!engine) return; engine.rate = r; engine.src?.playbackRate.setTargetAtTime(r, AC.currentTime, 0.05); };
  const tune = music ? new Audio(music) : null; if (tune) { tune.loop = true; tune.volume = Math.min(1, 0.55 * mix.music * mix.master); tune.muted = isMuted(); }
  // every sound passes one master gain, so muting (audio.js) silences the race at once, mid-sound
  function masterOut() { if (!sh.out) { sh.out = AC.createGain(); sh.out.connect(AC.destination); } sh.out.gain.value = isMuted() ? 0 : 1; return sh.out; }
  const offMute = onMute((m) => { if (sh.out) sh.out.gain.value = m ? 0 : 1; if (tune) tune.muted = m; container.querySelectorAll(".sound-toggle").forEach((b) => { b.textContent = m ? "SOUND: OFF" : "SOUND: ON"; }); });
  startup.defer(offMute);
  const wakeAudio = () => { if (!raceReady) return; AC?.resume?.().catch(() => {}); if (tune?.paused) tune.play()?.catch(() => {}); };
  // warm the cache with the effects a race uses
  for (const n of ["crashmed", "crashhar", "crashlit", "jm_aiie", "punchlig", "punchhea", "swishgen", "swishcha", "chainimp", "clubimpa", "kick_mw4", "m_yeah", "siren", "sirenfst", "engnitro", "gruntm1_", "gruntm2_", "gruntm3_", "gruntm4_", "gruntm5_"]) if (AC) sample(n);
  startup.defer(() => { engine?.pause(); tune?.pause(); siren?.pause(); });

  // ---- Input ----
  const keys = {}; let quit = false, paused = false;
  let cheatMenu = null, nitroTouchButton = null;
  let view = opts.view === "fps" ? "fps" : "chase";
  // Escape pauses with the original's warning (text 316); Escape again quits (a lost race), any other key carries on
  const kd = (e) => { if (typeof e.key !== "string") return; const k = e.key.toLowerCase();
    if (!raceReady || cheatMenu?.isOpen) return;
    if (paused && !net && ["ArrowUp", "ArrowDown"].includes(e.key)) {
      const buttons = [...hud.querySelectorAll(".pause-panel button:not(:disabled)")];
      if (buttons.length) { e.preventDefault(); const i = buttons.indexOf(document.activeElement); buttons[(i + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length].focus(); return; }
    }
    if (k !== "escape" && e.target.closest?.(".paused")) return;
    if (e.repeat && (k === "escape" || k === "v")) { e.preventDefault(); return; }
    if (k === "escape") { if (paused) { quit = true; ride.how = "escape"; } else { paused = true; releaseInput(); } e.preventDefault(); return; }
    if (k === "m") { setMuted(!isMuted()); e.preventDefault(); return; }
    if (paused) { paused = false; e.preventDefault(); return; }
    if (SPECTATE) {
      if (k === "c" || k === "v") setCam({ chase: "pov", pov: "above", above: "free", free: "chase" }[camMode]);
      else if (camMode === "free" || (camMode === "above" && ["q", "e", "pageup", "pagedown"].includes(k))) keys[k] = true;
      else if (k === "arrowright" || k === "arrowleft" || k === " ") watchNext(k === "arrowleft" ? -1 : 1);
      if (k.startsWith("arrow") || k === " ") e.preventDefault();
      return;
    }
    keys[k] = true; if (k === "v") { view = view === "chase" ? "fps" : "chase"; camInit = false; opts.onView?.(view); } if ([" ", "control", "x", "z"].includes(k)) punch(me, k === "z" ? -1 : 1); if (k === "k" || k === "c") punch(me, k === "c" ? -1 : 1, "kick"); if (k === "n" && clock >= 0 && me.bike.nitro && me.nitros > 0 && !(me.nitroT > 0)) { me.nitros--; me.nitroT = me.bike.spec?.nitro ? me.bike.spec.nitro.c / 60 : 3; sfx("engnitro", 0.8); }
    // only Super bikes carry nitro (and a few shots of it): say so instead of doing nothing
    else if (k === "n" && clock >= 0) hint(!me.bike.nitro ? "No nitro on this bike" : me.nitros > 0 ? "" : "Out of nitro", 2); if (k.startsWith("arrow") || k === " ") e.preventDefault(); };
  const ku = (e) => { if (typeof e.key === "string") keys[e.key.toLowerCase()] = false; };
  addEventListener("keydown", kd); addEventListener("keyup", ku);
  const touch = { on: false, steer: 0, travel: 0, brake: false, id: null, origin: 0, held: new Set() };
  let touchHintDismissed = false;
  let updateTiltUI = () => {};
  const tilt = new TiltSteering(() => updateTiltUI());
  let paintTouch = () => {}, clearTouchButtons = () => {};
  // One thumb owns steering until it lifts. Combat fingers never replace that owner,
  // and crossing the screen centre never applies an invisible brake.
  const rt = (e) => {
    if (!raceReady) return;
    if (e.target.closest?.(".touch-control, .paused")) return;
    e.preventDefault();
    if (paused) return;
    const fingers = [...e.touches].filter(t => !t.target?.closest?.(".touch-control, .paused"));
    if (touch.id === null && e.type === "touchstart") {
      const first = [...e.changedTouches].find(t => !t.target?.closest?.(".touch-control, .paused"));
      if (first) { touch.id = first.identifier; touch.origin = first.clientX; }
    }
    const finger = fingers.find(t => t.identifier === touch.id);
    touch.on = !!finger;
    const dx = finger ? finger.clientX - touch.origin : 0;
    touch.travel = Math.max(-1, Math.min(1, dx / 64));
    // A few pixels of thumb wobble should not swerve the bike. Use a progressive
    // curve for fine corrections, retaining full lock at a comfortable 64px drag.
    // Apply it directly on the input event: no smoothing delay on direction changes.
    touch.steer = Math.sign(dx) * Math.pow(Math.max(0, Math.min(1, (Math.abs(dx) - 4) / 60)), 1.6);
    if (!finger) touch.id = null;
    paintTouch();
    wakeAudio();
  };
  for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) container.addEventListener(ev, rt, { passive: false });

  const releaseInput = () => { for (const k in keys) keys[k] = false; touch.on = false; touch.steer = 0; touch.travel = 0; touch.brake = false; touch.id = null; touch.held.clear(); clearTouchButtons(); paintTouch(); };
  const visibility = () => { if (document.hidden) { releaseInput(); tilt.recentreNext(); if (!net) paused = true; } };
  addEventListener("blur", releaseInput); document.addEventListener("visibilitychange", visibility);
  startup.defer(() => {
    removeEventListener("keydown", kd); removeEventListener("keyup", ku);
    removeEventListener("blur", releaseInput); document.removeEventListener("visibilitychange", visibility);
    for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) container.removeEventListener(ev, rt);
    tilt.dispose(); if (net) net.onMessage = null;
  });

  // ---- Combat ----
  function punch(r, side, kind) {
    if (r.punchT > 0 || r.crashT > 0 || clock < 0) return;
    kind = kind || (r.isCop ? "club" : r.weapon || "punch");
    r.punchT = 0.35; r.punchSide = side; r.attack = kind; r.kickVar = Math.random() < 0.5 ? 0 : 1;
    const reach = kind === "chain" ? 3.0 : kind === "club" ? 2.7 : 2.4;
    const tgt = all.filter((o) => o !== r && o.br === r.br && o.crashT <= 0 && o.s > 0 && Math.abs((o.s - r.s) * STEP) < 2.2 && Math.sign(o.lat - r.lat) === side && Math.abs(o.lat - r.lat) < reach)[0];
    if (!tgt) { if (r === me) sfx(kind === "chain" ? "swishcha" : "swishgen", 0.5); return; }
    // EXE fight model (0x409ae2, 0x4050c0): damage = strength x long-term stamina share (at least half) x weapon factor
    // (fists 1, club 1.25, chain 1.5, police stick 0.25 - table 0x465a00); each point takes 64 from current stamina and 4
    // from long-term stamina (which never drops below half). Zero current stamina knocks the rider off.
    const W = { punch: 1, kick: 1, club: 1.25, chain: 1.5 }[kind] ?? 1, str = r.strength || 5;
    const share = Math.max(0.5, (r.stamLong ?? r.stamina ?? 2500) / (r.stamina || 2500));
    const pts = str * share * (r.isCop ? 0.25 : W); // police stick: weapon type 3, x0.25; it also dents the bike (below)
    if (tgt.remote) { // another player's rider (or the host's bot): they apply the damage; we just see the blow land
      net.send({ t: "hit", to: tgt.remote, by: r === me ? net.id : r.botId, pts, kind, side, cop: !!r.isCop }); tgt.wobble = 0.5;
      sfx(kind === "chain" ? "chainimp" : kind === "club" ? "clubimpa" : kind === "kick" ? "kick_mw4" : "punchlig", r === me ? 0.8 : 0.3); return; }
    applyHit(tgt, r, pts, kind, side);
  }
  function applyHit(tgt, r, pts, kind, side) {
    tgt.stamLong = Math.max((tgt.stamina || 2500) / 2, (tgt.stamLong ?? tgt.stamina ?? 2500) - 4 * pts);
    tgt.stamCur = (tgt.stamCur ?? tgt.stamLong) - 64 * pts;
    if (r.isCop) dent(tgt, (Math.floor(pts) >> 2) + 1);
    grudgeEvent(tgt, r, 2); grudgeEvent(r, tgt, 4); // the victim bears a grudge, the attacker's cools (0x409916)
    tgt.health = Math.max(0, (5 * tgt.stamCur) / (tgt.stamina || 2500)); tgt.wobble = 0.5;
    if (kind === "kick") tgt.lat += side * 1.6; // kicks shove the target sideways
    const near = r === me || tgt === me;
    sfx(kind === "chain" ? "chainimp" : kind === "club" ? "clubimpa" : kind === "kick" ? "kick_mw4" : tgt.health > 0 ? "punchlig" : "punchhea", near ? 0.8 : 0.3);
    if (tgt.health <= 0) {
      // whoever knocks a weapon-carrier off takes the weapon
      if (tgt.weapon && !r.isCop) { r.weapon = tgt.weapon; tgt.weapon = null; if (r === me) sfx("m_yeah", 0.6); }
      crash(tgt, "ko");
    } else if (Math.random() < 0.5) sfx(`gruntm${1 + ((Math.random() * 5) | 0)}_`, near ? 0.5 : 0.2);
  }
  // ---- Bike condition (EXE 0x4052c0 -> 0x4051e0, rider 0x2ec/0x2f0) ----
  // Every bike starts with BIKESPEC int 81 (90-396). A collision's points are the velocity change it causes, in mph*100
  // summed over the axes, >> 10 (0x4049c0; the change is 2*m_other/(m_self+m_other) x the closing speed). Head-on into
  // something hard costs x7/4, another rider x1, a glancing blow /8, soft things (people) nothing. The same points come
  // off stamina (64 each from current, 4 from long-term). The police stick also dents the bike by hit/4+1 (0x409b8a).
  // Roadside walls do no damage (0x43a1b0). At zero the player stays down and the race ends WRECKED three seconds later
  // (0x40a923 -> 0x416010(5, 180)); a rival gets a quarter of its condition back and rides on (0x40a96e).
  const RIDER_W = 0.75, BIKE_L = 1.8; // m: closest two bikes ride side by side; a bike's length (for rear-ending)
  const HEAVY = 1.7; // 2*m_car/(m_car+m_bike) for a ~1.4 t car against ~260 kg of bike and rider
  const dent = (r, pts) => { if (pts > 0 && r.cond !== undefined) r.cond = Math.max(0, r.cond - Math.floor(pts)); };
  function impact(r, closing, mass, kind) {
    const raw = Math.floor((Math.abs(closing) * 223.7 * mass) / 1024);
    const pts = kind === "hard" ? (raw * 7) >> 2 : kind === "side" ? raw >> 3 : kind === "soft" ? 0 : raw;
    if (pts <= 0) return;
    r.stamLong = Math.max((r.stamina || 2500) / 2, (r.stamLong ?? r.stamina ?? 2500) - 4 * pts);
    dent(r, pts);
  }
  function crash(r, why, bikeSpeed) { r.crashWhy = why || "unknown"; r.crashT = 3.2;
    if (r === me) { ride.crashes++; ride.lastCrash = r.crashWhy; ride.lastCrashAt = clock; }
    // rider and bike part company: the rider is thrown on ahead, the bike slides to a stop on its own (see steerOf)
    if (!r.isCop) r.down = { ph: 0, t: 0, d: 0, bv: bikeSpeed ?? (["prop", "obstacle", "wall", "rock", "headon"].includes(why) ? 0 : r.v * 0.6), bl: r.lat + (Math.random() - 0.5) * 2 }; r.stamCur = r.stamLong ?? r.stamina ?? 2500; r.health = (5 * r.stamCur) / (r.stamina || 2500); r.v *= 0.3; sfx("crashmed", r === me ? 0.9 : 0.4); if (r === me) sfx("jm_aiie", 0.7); }

  // ---- Physics ----
  let clock = -3, done = false, result = null, bump = 0, wreckAt = 0, ledLit = -1;
  const trace = { s0: null, d: [] };
  let hintText = "", hintT = 0; const hint = (text, s) => { if (text) { hintText = text; hintT = clock + s; } }; // short HUD notes
  // how the ride went, sent with every result (app.js race_ended): where and how players stop, to find why they quit
  const ride = { crashes: 0, lastCrash: null, lastCrashAt: null, how: null };
  const rideReport = () => { const s0 = trace.s0 ?? me.s;
    return { progress: +Math.max(0, Math.min(1, (me.s - s0) / Math.max(1, FIN - s0))).toFixed(3), at_s: +Math.max(0, clock).toFixed(1),
      place_now: 1 + field.filter((r) => (r.finished && (!me.finished || r.finished < me.finished)) || (!r.finished && r.s > me.s)).length, field: field.length + 1,
      recovery_stage: me.down ? (["tumbling", "lying", "standing", "walking", "remounting"][me.down.ph] || "wrecked") : me.crashT > 0 ? "recovering" : "riding", off_bike_s: me.crashT > 0 && ride.lastCrashAt != null ? +(clock - ride.lastCrashAt).toFixed(1) : 0, crashes: ride.crashes, last_crash: ride.lastCrash ?? undefined, crash_recent: ride.lastCrashAt != null && clock - ride.lastCrashAt < 8, mph: Math.round(me.v * 2.237), how: ride.how ?? (net?.interruption ? "disconnected" : undefined), ...(net?.interruption || {}) }; };
  // Surfaces as the EXE sees them (0x43a0c0): 0 road, 1 kerb/pavement, 2 dirt shoulder, 3 grass.
  // Per surface: tyre grip /256 (0x46dce8), rolling drag *|v|/16384 (0x46dce4), skid speed loss per tick (0x46dd18).
  const GRIP = [256, 240, 128, 100], ROLL = [0, 2, 20, 30], SKID_LOSS = [12, 12, 0, 0];
  // Sideways motion (0x4395e0, 0x40af50, 0x4394c0): there is no heading. While the tyres grip, the sideways speed
  // relative to the road is the turn value itself, (turn >> 8) * steer divisor (spec 66) in 1/256 lateral units per tick,
  // which comes to v*sin(lock). The bend pushes the bike out by a * (v >> 8) * 400 >> 8 per tick (a = the step's path
  // byte; 800 for a player sliding past severity 50, 600 for a sliding rival). Lateral unit = the hazard records' 0.069/4 m.
  const LAT_U = 0.069 / 4 / 256, aOf = (t) => 256 * Math.tan(2 * t.curv * STEP); // path byte back from the curvature
  const surfaceOf = (r) => {
    const L = EA(r, -1), R = EA(r, 1);
    if (r.lat >= L - 0.3 && r.lat <= R + 0.3) return 0;
    const sg = r.lat < L ? -1 : 1;
    if ((sg < 0 ? L - r.lat : r.lat - R) > shoulderAt(r, sg)) return 3;
    let verge = vergeAt(sg < 0 ? 0 : 1, Math.round(r.s));
    if (r.br >= 0) { const runs = vergeRuns?.[2]?.[branches[r.br].fi] || []; verge = SIDE[course]; for (const [from, name] of runs) if (from <= r.bs) verge = name || SIDE[course]; }
    return /SIDWK|SIDEWALK/.test(verge) ? 1 : 2;
  };
  const steerOf = (r, c, dt) => {
    const t = T(r), off = r.lat < EA(r, -1) - KERB || r.lat > EA(r, 1) + KERB;
    const steer = r.crashT > 0 ? 0 : c.steer;
    if (r.crashT > 0 && r.down) {
      // Off the bike: tumble until rider and bike have both stopped, lie still, get up, walk to the bike at the
      // original's on-foot speed (456 = 4.56 mph, ~2 m/s, read from its rider record) and remount where it lies.
      const D = r.down; D.t += dt; r.turn = 0; r.skid = 0; r.vlat = 0;
      const move = (steps) => { if (r.br >= 0) { const B = branches[r.br]; r.bs = Math.max(0, Math.min(B.LB - 0.01, r.bs + steps)); r.s = B.at + (r.bs * B.LA) / B.LB; } else r.s = Math.max(0, Math.min(END - 1, r.s + steps)); };
      if (D.ph === 0) {
        r.v = Math.max(0, r.v - 9 * dt); D.d += ((D.bv - r.v) * dt) / STEP; D.bv = Math.max(0, D.bv - 12 * dt);
        if (!r.v && !D.bv && D.t > 1) { settleBike(r, D); D.ph = 1; D.t = 0; if (r.cond <= 0 && r === me) { D.ph = 9; r.crashT = 1e9; r.wrecked = true; wreckAt = clock + 3; } }
      } else if (D.ph === 1) { if (D.t > 0.6 * quick(r)) { D.ph = 2; D.t = 0; } }
      else if (D.ph === 2) { if (D.t > 1.1 * quick(r)) { D.ph = 3; D.t = 0; } }
      else if (D.ph === 3) {
        const ds = D.d * STEP, dl = D.bl - r.lat, dist = Math.hypot(ds, dl), m = (r === me ? 2 + 2 * ASSIST : 2) * dt, f = Math.min(1, m / Math.max(dist, 1e-6));
        const forward = (keys.arrowup || keys.w ? 1 : 0) - (keys.arrowdown || keys.s ? 1 : 0), sideways = (keys.arrowright || keys.d ? 1 : 0) - (keys.arrowleft || keys.a ? 1 : 0);
        // The original's arrows move the rider's body while the bike stays put; with no input the rider walks back.
        // Holding throttle also walks back to the bike: it used to walk the rider along the road, and the bike usually
        // lands behind them, so players holding throttle (or the phone's drive pad) walked away and never remounted.
        // With help on, the rider always just walks back.
        if (r === me && ASSIST < 0.4 && forward <= 0 && (forward || sideways)) {
          const scale = m / Math.max(1, Math.hypot(forward, sideways)), before = along(r);
          move(forward * scale / STEP); D.d -= along(r) - before; r.lat += sideways * scale;
          D.dir = Math.abs(forward) >= Math.abs(sideways) ? forward < 0 ? "to" : "away" : sideways > 0 ? "right" : "left";
        } else {
          D.dir = Math.abs(ds) >= Math.abs(dl) ? (ds < 0 ? "to" : "away") : dl > 0 ? "right" : "left";
          const before = along(r); move((ds * f) / STEP); D.d -= along(r) - before; r.lat += dl * f;
        }
        if (Math.hypot(D.d * STEP, D.bl - r.lat) < 0.08) { D.ph = 4; D.t = 0; }
      } else if (D.ph === 4 && D.t > 1.2 * quick(r)) {
        r.crashT = 0; r.down = null; r.v = 0;
        if (r.cond <= 0) r.cond = condMax(r) >> 2;
        recoverBike(r);
      }
    }
    else if (r.crashT > 0) { r.crashT -= dt; r.v = Math.max(0, r.v - 30 * dt); r.turn = 0; r.skid = 0; r.vlat = 0; if (r.crashT <= 0) { if (r.cond <= 0 && r === me) { r.crashT = 1e9; r.wrecked = true; wreckAt = clock + 3; } else { if (r.cond <= 0) r.cond = condMax(r) >> 2; r.v = 5; recoverBike(r); } } } // a rival down a drop is put back on the road
    else if (!r.air) {
      const sp = r.bike.spec;
      if (sp) {
        // Original model (EXE 0x40acd0/0x40adb0/0x40aea0/0x4390c0/0x4391d0), integrated in 60 Hz ticks (the main loop paces on QPC frequency / 60), speed in mph*100:
        // throttle ramps to power*256 over ramp[0] ticks (back over ramp[1]); force = gear ratio * throttle >> 16
        // (x nitro/256 while it burns); brake ramps to brake*256 and adds brake*256>>8; drag = 130|v|/65536 + 8
        // + surface*|v|/16384 + |turn|/4096; gears shift up above `up` and down below `down`.
        // Steering (0x40af50, 0x438c70): the turn value heads for sin(lock)*256*v/120 (lock up to 45°), capped at 11776,
        // growing by 11776/steer[1] per tick and easing back by 11776/steer[2]. Grip limit = ((300*tyre>>8)*surface grip>>8)*37>>8
        // (256 instead of 300 once sliding); a skid starts when (v>>11)*(turn>>8) exceeds it, and past 40 it bleeds speed.
        r.tick = (r.tick || 0) + dt * 60;
        for (; r.tick >= 1; r.tick--) {
          // rider weight as the spec loader applies it (param = weight/2): power and brake x (W+75)/(W+75+(w/2-75)/8),
          // steering divisors x (W+75)/(W+w/4) where W is the bike's weight field
          const wh = (r.weight || 180) / 2, W = sp.weight, pScale = (W + 75) / (W + 75 + (wh - 75) / 8), sScale = (W + 75) / (W + wh / 4);
          const maxT = sp.power * 256 * pScale, maxB = sp.brake * 256 * pScale;
          let v100 = r.v * 223.7;
          const g = sp.gears[r.gi ?? 0] || sp.gears[0];
          if (c.brake) { r.thr = 0; r.brk = Math.max(maxB, (r.brk || 0) + maxB / sp.ramp[2]); }
          else { r.brk = Math.min(0, (r.brk || 0) - maxB / sp.ramp[3]); r.thr = c.throttle ? Math.min(maxT * c.throttle * (r === me ? 1 : r.skill), (r.thr || 0) + maxT / sp.ramp[0]) : Math.max(0, (r.thr || 0) - maxT / sp.ramp[1]); }
          // steering
          const cap = sp.steer[0], turn = r.turn || 0;
          const want = v100 > 0 ? Math.max(-cap, Math.min(cap, (steer * 0.7071 * 256 * v100) / sp.steer[3])) : 0;
          const rate = cap / ((Math.abs(want) > Math.abs(turn) ? sp.steer[1] : sp.steer[2]) * sScale);
          r.turn = Math.abs(want - turn) <= rate ? want : turn + Math.sign(want - turn) * rate;
          const surf = surfaceOf(r);
          // road patches: oil/ice leave a fifth of the grip, water most of it, sand/gravel ride like a dirt shoulder
          const patch = r.slick > 0 ? 0.2 : r.looseT > 0 ? 0.5 : r.wetT > 0 ? 0.75 : 1;
          const limit = Math.floor((Math.floor((Math.floor(((r.skid ? 256 : 300) * sp.tyre) / 256) * GRIP[surf] * patch) / 256) * 37) / 256);
          const demand = Math.floor(v100 / 2048) * Math.floor(Math.abs(r.turn) / 256);
          r.skid = demand > limit ? demand - limit : 0; r.grip = demand > limit ? limit / demand : 1;
          // sideways: a gripping tyre takes the steered speed; a sliding one only part of the way (0x160 traction)
          const vs = (r.turn / 256) * sp.steer[3];
          r.vlat = r.air ? r.vlat || 0 : (r.vlat || 0) + (vs - (r.vlat || 0)) * r.grip;
          const push = r.skid > 50 ? (r === me ? 800 : 600) : 400;
          r.lat += (r.vlat - (aOf(t) * (v100 / 256) * push) / 256) * LAT_U;
          let F = (g.ratio * r.thr) / 65536;
          if (r.nitroT > 0 && sp.nitro) F *= sp.nitro.b / 256;
          F += r.brk / 256;
          const drag = (130 * v100) / 65536 + (v100 > 0 ? 8 : 0) + ((r.looseT > 0 ? Math.max(ROLL[surf], 20) : ROLL[surf]) * v100) / 16384 + Math.abs(r.turn) / 4096; // no grade term: the original's integrator (0x4390c0) ignores slope, measured in the emulator on City's hilly start
          v100 = Math.max(0, v100 + F - drag - (r.skid > 40 ? SKID_LOSS[surf] : 0));
          let gi = r.gi ?? 0; if (v100 > g.up * 100 && gi < sp.gears.length - 1) gi++; else if (v100 < g.down * 100 && gi > 0) gi--; r.gi = gi;
          r.v = v100 / 223.7;
        }
        r.slick = (r.slick || 0) - dt; r.wetT = (r.wetT || 0) - dt; r.looseT = (r.looseT || 0) - dt;
        r.gear = (r.gi ?? 0) + 1;
        r.nitroT = (r.nitroT || 0) - dt;
      } else {
        const top = (off ? 22 : r.bike.top) * (r === me ? 1 : r.skill);
        if (r.v < top) r.v += c.throttle * 5 * dt;
        r.v -= (c.brake * 30 + 1.2 + (off ? 2.5 : 0) + (r.v > top ? 8 : 0)) * dt + t.slope * 6 * dt;
      }
    }
    r.v = Math.max(0, r.v);
    if (r.air && r.bike.spec) r.lat += (r.vlat || 0) * LAT_U * 60 * dt; // airborne: carries its sideways speed
    if (r.bike.spec) {
      // Lean (0x439025): atan2(turn/256, 74), halved below 40 mph and +1/8 above 80 mph; 31.9° at full turn.
      const mph = r.v * 2.237, tl = (r.turn || 0) * (mph < 40 ? 0.5 : mph > 80 ? 1.125 : 1);
      r.lean = Math.atan2(tl / 256, 74) / 0.557;
      r.h = Math.atan2((r.vlat || 0) * LAT_U * 60, Math.max(1, r.v)); // the bike's angle to the road, for the AI
      if (r.wobble > 0) r.lat += Math.sin(clock * 30) * 3 * dt;
    } else {
      r.lean += ((steer * Math.min(1, r.v / 25)) - r.lean) * Math.min(1, dt * 6);
      r.lat += ((r.air ? 0.3 : 1) * steer * (3 + r.v * 0.22) * r.bike.grip - r.v * r.v * t.curv * 0.55 + (r.wobble > 0 ? Math.sin(clock * 30) * 3 : 0)) * dt;
    }
    r.lat = Math.max(-GRASS + 4, Math.min(GRASS - 4, r.lat)); r.wobble -= dt; r.punchT -= dt;
    const metric = r.br >= 0 ? branches[r.br].metresPerStep : STEP;
    const adv = (r.v * dt) / metric;
    if (r.br >= 0) {
      const B = branches[r.br]; r.bs += adv;
      if (r.bs >= B.LB) { const oldY = branchTrack(B, r.bs).y; r.s = B.J + (r.bs - B.LB); r.br = -1; r.prevAlong = B.J; r.yb += track(r.s).y - oldY; } else r.s = B.at + (r.bs * B.LA) / B.LB; // progress in main-road steps
    } else {
      const prev = r.s; r.s = Math.min(END - 1, r.s + adv);
      branches.forEach((B, k) => { if (prev < B.at && r.s >= B.at && enterBranch(r, k)) { const oldY = track(r.s).y; r.br = k; r.bs = r.s - B.at; r.prevAlong = 0; r.s = B.at + r.bs * B.LA / B.LB; r.yb += branchTrack(B, r.bs).y - oldY; } });
    }
    let tY = r.br >= 0 ? 0 : terrainY(r.s, r.lat);
    if (r.br < 0 && tY > r.yb - T(r).y + 1.2) { // solid rock: back out of the face (or, without a face record, step back toward the road until the ground is climbable)
      const f = faceAt(r.s, Math.sign(r.lat)); if (f) { r.lat = Math.sign(r.lat) * (f - 0.8); tY = terrainY(r.s, r.lat); }
      for (let k = 0; k < 40 && tY > r.yb - T(r).y + 1.2 && Math.abs(r.lat) > 0.5; k++) { r.lat -= Math.sign(r.lat) * 0.5; tY = terrainY(r.s, r.lat); r.vlat = 0; } }
    const ground = T(r).y + tY; r.vy -= 22 * dt; r.yb += r.vy * dt;
    // landing hard on mountain ground off the road (terrain type 1: RMTN) totals the bike, as falling into a ravine
    // does in the original (0x43a422: condition -= 0x2000000, then the race ends WRECKED for the player); our threshold
    // is a landing faster than 12 m/s (about a 7 m fall at our gravity) down in a drop, not on the road
    if (r.yb <= ground && r.air && r.br < 0 && r.vy < -12 && mtn[Math.round(r.s)] && tY < -1 && r.crashT <= 0) { r.cond = 0; crash(r, "fall"); if (r === me) sfx("crashhar", 0.9); }
    if (r.yb <= ground) { if (r === me && r.air) bump = 0.3; r.yb = ground; r.vy = Math.max(r.vy, r.v * T(r).slope); r.air = false; } else if (r.yb > ground + 0.15) r.air = true;
    if (!r.finished && r.s >= FIN) r.finished = clock;
  };
  function aiControls(r, dt) {
    const ahead = T(r, M(50)), t = T(r);
    // hold a lane, counter-steer the curve, slow for sharp bends
    const lo = EA(r, -1, M(50)) + 1.2, hi = EA(r, 1, M(50)) - 1.2;
    // hold a lane on our own side, leaning a little into bends (at most 1.5 m, never over the centre line)
    let want = Math.max(Math.min(hi, 0.6), Math.min(hi, r.lane - Math.max(-1.5, Math.min(1.5, ahead.curv * 600))));
    const near = all.find((o) => o !== r && Math.abs((o.s - r.s) * STEP) < 3 && Math.abs(o.lat - r.lat) < 1.6);
    if (r.foe && Math.abs((r.foe.s - r.s) * STEP) < 40) want = r.foe.lat; // chasing someone it hates (mode 4)
    else if (near) want += near.lat > r.lat ? -2 : 2;
    want = Math.max(lo, Math.min(hi, want)); // dodging never takes a rider off the tarmac
    // traffic: look about 2.5 s ahead at the closing speed; pass a car in our path on whichever side has room, and if it
    // can't be passed in time, sit behind it
    let stuck = null, urgent = false, car = null, cd = 1e9;
    for (const c of traffic) {
      if (c.br !== r.br) continue; const d = (along(c) - along(r)) * STEP, close = r.v - c.v; if (d <= 0 || d > Math.max(20, close * 2.5) || d >= cd) continue;
      const half = c.w / 2 + 1.1; if (Math.abs(want - c.lat) >= half && Math.abs(r.lat - c.lat) >= half) continue;
      car = c; cd = d;
    }
    if (car) {
      // pass the nearest car in our path on whichever side has room - with a margin if it's free, else squeezing past
      // (a bike fits between two cars) - but not into a car coming the other way
      const c = car, clear = (x) => !traffic.some((o) => o !== c && o.coming && o.br === r.br && Math.abs(o.lat - x) < o.w / 2 + 0.6 && (along(o) - along(r)) * STEP > -4 && (along(o) - along(r)) * STEP < Math.max(20, (r.v - o.v) * 2));
      const ok = (m) => [c.lat - c.w / 2 - m, c.lat + c.w / 2 + m].filter((x) => x > lo - 0.6 && x < hi + 0.6 && clear(x)).sort((a, b) => Math.abs(r.lat - a) - Math.abs(r.lat - b));
      const pick = ok(1.1)[0] ?? ok(0.7)[0];
      want = pick ?? (c.coming ? want : Math.max(lo, Math.min(hi, c.lat)));
      if (!c.coming && (pick === undefined || Math.abs(r.lat - c.lat) < c.w / 2 + 0.5) && cd < Math.max(8, (r.v - c.v) * 1.3)) stuck = c;
      urgent = c.coming;
    }
    // the same for solid objects standing on the tarmac (roadworks cones and barricades, kerbside signs)
    if (r.br < 0) for (let k = blockLo; k < roadBlocks.length; k++) {
      const c = roadBlocks[k], d = (c.s - r.s) * STEP; if (d <= 0) continue; if (d > Math.max(20, r.v * 2.5)) break;
      const half = c.hw + 1.1; if (Math.abs(want - c.lat) >= half && Math.abs(r.lat - c.lat) >= half) continue;
      const L = c.lat - half, R = c.lat + half, okL = L > lo, okR = R < hi;
      want = okL && (!okR || Math.abs(r.lat - L) < Math.abs(r.lat - R)) ? Math.max(lo, L) : okR ? Math.min(hi, R) : want;
      if (!stuck && Math.abs(r.lat - c.lat) < half - 0.5 && d < Math.max(8, r.v * 1.3)) stuck = { v: 0 };
      break;
    }
    // Cruising speed (0x408897): each rider holds a speed cap by level (mph). When the player is its nearest rider ahead
    // or behind, the cap changes by the band table (+15% far behind the player, +10% alongside, -1% 9+ steps ahead);
    // chasing someone it hates adds 1/8; while the player is down, riders more than 10 steps away ease off (half on
    // levels 1-3, 3/4 on level 4).
    let cap = r.cruise || 999; const lead = r.s - me.s;
    if (r.cruise) {
      let nearest = null, nd = 10; for (const q of all) { if (q === r || q.br !== r.br) continue; const d = Math.abs(q.s - r.s); if (d < nd) { nd = d; nearest = q; } }
      if (nearest === me) cap = (cap * (100 + (opts.band?.[Math.max(-9, Math.min(10, Math.trunc(lead))) + 9] ?? 0))) / 100;
      else if (r.foe) cap += cap / 8;
      if (me.crashT > 0 && Math.abs(lead) > 10) cap = LV === 4 ? cap : LV === 3 ? cap * 0.75 : cap / 2;
    }
    const rub = r.v * 2.237 > cap ? 0 : 1;
    // Picking a fight (0x4082f0, 0x408ad0): the nearest rider ahead and behind within ~10 steps are rated by grudge
    // against thresholds that drop with the level and when the player runs in the top four (T1 = 1000*(16-x) - 1500*level,
    // T2 = twice that, x = 4 - player's place); below T1 the rival leaves them be, between T1 and T2 it attacks only from
    // the tarmac, above T2 it chases them. In reach (0x4092e0) it swings with a per-tick chance by level (0x465a10).
    r.cool -= dt;
    if (r.brain && r.crashT <= 0) {
      const place = all.filter((o) => o !== me && o.s > me.s).length, x = place < 4 ? 4 - place : 0;
      const T1 = 1000 * (16 - x) - 1500 * LV, T2 = 2000 * (16 - x) - 3000 * LV;
      let best = null, bestH = 1, bestD = 1e9;
      for (const dir of [1, -1]) {
        let o = null, od = 1e9; for (const q of all) { if (q === r || q.br !== r.br || q.crashT > 0 || q.finished) continue; const d = (q.s - r.s) * dir; if (d > 0 && d < 10 && d < od) { o = q; od = d; } }
        if (!o) continue; const g = grudge(r, o), h = g < T1 ? 1 : g < T2 ? 2 : 3;
        if (h > bestH || (h === bestH && best && od < bestD)) { best = o; bestH = h; bestD = od; }
      }
      r.foe = bestH === 3 ? best : null;
      const reach = (r.brain.B.reach || 3) * 16 / 256, lr = ((r.brain.B.reach || 3) << 13) * LAT_U * 1.6;
      const onRoad = r.lat > EA(r, -1) && r.lat < EA(r, 1);
      if (best && bestH >= 2 && (bestH === 3 || onRoad) && r.cool <= 0 && Math.abs(best.s + (best.v - r.v) * dt / STEP - r.s) < reach + 0.3 && Math.abs(best.lat - r.lat) < lr) {
        const p = Math.min(1, (opts.swing?.[LV] ?? 4) / 256), ticks = Math.max(1, Math.round(dt * 60));
        if (Math.random() < 1 - Math.pow(1 - p, ticks)) { punch(r, Math.sign(best.lat - r.lat) || 1); r.cool = 0.6; }
      }
    }
    // corner speed from the tightest bend in the next ~60 m (lateral grip ~9 m/s²): lift off above it, brake well above
    // holding a bend of path byte a takes turn = a*v100/76.8, and the grip test (v100>>11)*(turn>>8) <= limit then
    // caps the speed at sqrt(limit * 4.03e7 / a) (mph*100); ride a tenth under it
    let amax = 0; for (let k = 2; k <= 14; k += 2) amax = Math.max(amax, Math.abs(aOf(T(r, k))));
    const L = r.bike.spec ? Math.floor((Math.floor((300 * r.bike.spec.tyre) / 256) * 37) / 256) : 54;
    const vmax = (0.9 * Math.sqrt((L * 4.03e7) / Math.max(0.5, amax))) / 223.7;
    let steer = Math.max(-1, Math.min(1, (want - r.lat) * 0.35));
    const sp = r.bike.spec;
    if (sp && r.v > 1) {
      // aim for a sideways speed, turn it into a heading and the yaw rate that holds it on this bend, then the lock
      // that asks for that turn value, kept under the tyre's grip limit
      // aim for a sideways speed toward the line, plus whatever cancels the bend's push, as a turn value
      const u = Math.max(-6, Math.min(6, (want - r.lat) * (urgent ? 2 : 0.8))), v100 = r.v * 223.7;
      let turn = ((u / 60 / LAT_U + (aOf(t) * (v100 / 256) * 400) / 256) * 256) / sp.steer[3];
      const limit = Math.floor((Math.floor((300 * sp.tyre) / 256) * 37) / 256), vq = Math.floor(v100 / 2048);
      if (vq > 0) { const m = ((limit + 0.5) / vq) * 256; turn = Math.max(-m, Math.min(m, turn)); }
      steer = Math.max(-1, Math.min(1, (turn * sp.steer[3]) / (0.7071 * 256 * v100)));
    }
    if (stuck && r.v > stuck.v) return { throttle: 0, brake: 1, steer };
    return { throttle: r.v > vmax ? 0 : rub, brake: r.v > vmax + 6 ? 1 : 0, steer };
  }
  function playerControls() {
    if (touch.on || me.v > 1) touchHintDismissed = true;
    if (touch.held.has("hit")) punch(me, touchSide());
    else if (touch.held.has("kick")) punch(me, touchSide(), "kick");
    const throttle = keys.arrowup || keys.w || (touch.on && !touch.brake) ? 1 : 0, brake = keys.arrowdown || keys.s || touch.brake ? 1 : 0;
    const tiltValue = tilt.value();
    const steer = (keys.arrowright || keys.d ? 1 : 0) - (keys.arrowleft || keys.a ? 1 : 0) || (tilt.enabled ? !paused && (touch.on || touch.brake) ? tiltValue : 0 : touch.steer);
    return { throttle, brake, steer };
  }
  let grudgeT = 0;
  // ---- Mano-a-Mano: follow remote riders, take hits, send ours ----
  const ATK = ["punch", "kick", "club", "chain"];
  const pack = (r) => [+r.s.toFixed(3), +r.lat.toFixed(2), +r.v.toFixed(2), r.br, +(r.bs || 0).toFixed(3), +r.crashT.toFixed(2), r.down ? [r.down.ph, +r.down.t.toFixed(2), +r.down.d.toFixed(3), +r.down.bl.toFixed(2), r.down.dir || ""] : 0,
    +(r.punchT || 0).toFixed(2), r.punchSide || 0, ATK.indexOf(r.attack), r.kickVar || 0, +(r.lean || 0).toFixed(3), r.finished || 0, +(r.health ?? 5).toFixed(2), r.weapon || ""];
  function netFollow(r, dt) {
    const q = r.net; if (!q) return;
    const age = Math.min(0.3, (performance.now() - q.at) / 1000), [s, lat, v, br, bs, crashT, down, punchT, side, atk, kv, lean, fin, health, weapon] = q.d;
    const ts = s + (crashT > 0 ? 0 : (v * age) / STEP); // extrapolate a little, then ease toward it
    if (br !== r.br || Math.abs(ts - r.s) > 3) { r.s = ts; r.lat = lat; } else { r.s += (ts - r.s) * Math.min(1, dt * 10); r.lat += (lat - r.lat) * Math.min(1, dt * 10); }
    r.br = br; if (br >= 0) { const B = branches[br]; r.bs = bs + (crashT > 0 ? 0 : (v * age) / STEP); r.s = B.at + (r.bs * B.LA) / B.LB; }
    r.v = v; r.lean = lean; r.crashT = crashT; r.down = down ? { ph: down[0], t: down[1], d: down[2], bl: down[3], dir: down[4] || undefined, bv: 0 } : null;
    if (punchT > (r.punchT || 0) + 0.05) { r.attack = ATK[atk] || "punch"; r.punchSide = side; r.kickVar = kv; } r.punchT = punchT;
    r.finished = fin; r.health = health; r.weapon = weapon || null; r.yb = T(r).y + (r.br >= 0 ? 0 : terrainY(r.s, r.lat)); r.air = false;
  }
  if (net) net.onMessage = (m) => {
    if (m.t === "state") for (const [id, d] of m.s) { const r = remote.get(id); if (r && Array.isArray(d) && Number.isInteger(d[3]) && d[3] >= -1 && d[3] < branches.length) r.net = { d, at: performance.now() }; }
    else if (m.t === "hit") { const tgt = m.to === net.id ? me : field.find((r) => !r.remote && r.botId === m.to); if (!tgt || tgt.crashT > 0) return;
      const by = remote.get(m.by) || me; applyHit(tgt, m.cop ? { ...by, isCop: true } : by, m.pts, m.kind, m.side); }
    else if (m.t === "left") { const r = remote.get(m.id); if (r) { r.net = null; r.s = -999; } }
    else if (m.t === "closed") { net.disconnected = m.text || "Disconnected"; quit = true; ride.how = "disconnected"; netGo = false; }
    else if (m.t === "go") netGo = true;
  };
  let netGo = !net, netSent = 0;
  if (net?.disconnected) quit = true;
  // ---- Spectating ----
  let watchId = null; // null: follow whoever leads
  // camera: "chase" behind the watched rider, "pov" from their seat, "above" overhead following them (height adjustable),
  // "free" flown by the spectator anywhere along the road and up to 200 m above it
  let camMode = "chase", freeV = 0, freeH = 25; const fly = { on: false, x: 0, y: 0, f: 0, sd: 0, up: 0 };
  function setCam(m) {
    camMode = m; view = m === "pov" ? "fps" : "chase"; camInit = false; freeV = 0;
    if (m === "free") { me.br = -1; me.bs = 0; freeH = 25; }
    if (m === "above") freeH = 30;
    container.querySelectorAll(".spectate-modes button[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    container.querySelector(".spectate-modes")?.classList.toggle("free", m === "free" || m === "above");
  }
  const placeOf = (t) => 1 + field.filter((r) => r !== t && ((r.finished && (!t.finished || r.finished < t.finished)) || (!r.finished && !t.finished && r.s > t.s))).length;
  const racing = () => field.filter((r) => r.s > -900);
  function watched() {
    const list = racing(); if (!list.length) return null;
    const pick = watchId && list.find((r) => (r.remote || r.botId || r.name) === watchId);
    return pick || list.slice().sort((a, b) => placeOf(a) - placeOf(b))[0];
  }
  function watchNext(d) {
    const list = racing().sort((a, b) => placeOf(a) - placeOf(b)); if (!list.length) return;
    const cur = watched(), i = Math.max(0, list.indexOf(cur)), next = list[(i + d + list.length) % list.length];
    watchId = next.remote || next.botId || next.name; camInit = false;
  }
  function follow(dt) {
    if (camMode === "above") { const up = Math.max(-1, Math.min(1, (keys.q || keys.pageup ? 1 : 0) - (keys.e || keys.pagedown ? 1 : 0) + fly.up)); freeH = Math.max(3, Math.min(200, freeH + up * 30 * dt)); }
    if (camMode === "free") { // the spectator flies the camera: forward/back along the main road, sideways across it
      const f = Math.max(-1, Math.min(1, (keys.arrowup || keys.w ? 1 : 0) - (keys.arrowdown || keys.s ? 1 : 0) + fly.f));
      const sd = Math.max(-1, Math.min(1, (keys.arrowright || keys.d ? 1 : 0) - (keys.arrowleft || keys.a ? 1 : 0) + fly.sd));
      const up = Math.max(-1, Math.min(1, (keys.q || keys.pageup ? 1 : 0) - (keys.e || keys.pagedown ? 1 : 0) + fly.up));
      freeH = Math.max(0, Math.min(200, freeH + up * 30 * dt)); // up to 200 m above the road: watch the race from the sky
      freeV += (f * (60 + freeH * 1.5) - freeV) * Math.min(1, dt * 2);
      me.br = -1; me.s = Math.max(30, Math.min(END - 2, me.s + (freeV * dt) / STEP));
      me.lat = Math.max(EA(me, -1) - 6, Math.min(EA(me, 1) + 6, me.lat + sd * 10 * dt));
      Object.assign(me, { v: Math.abs(freeV), yb: T(me).y + terrainY(me.s, me.lat), lean: -sd * 0.2, crashT: 0, down: null, air: false, finished: 0 });
      return;
    }
    const t = watched(); if (!t) return;
    Object.assign(me, { s: t.s, br: t.br, bs: t.bs, lat: t.lat, v: t.v, yb: t.yb, lean: t.lean || 0, crashT: 0, down: null, air: false, finished: 0 });
  }
  function netSend() { if (!net || performance.now() - netSent < 66) return; netSent = performance.now();
    net.send({ t: "state", s: [...(SPECTATE ? [] : [[net.id, pack(me)]]), ...(net.host ? field.filter((r) => r.botId && !r.remote).map((r) => [r.botId, pack(r)]) : [])] }); }
  function step(dt) {
    clock += dt;
    if (clock < 0) return;
    // ride trace for the leaderboard's check (functions/api/board.js): metres along the road every 2 s of race time
    if (trace.s0 == null) trace.s0 = me.s;
    if (!me.finished && clock >= trace.d.length * 2) trace.d.push(Math.round((me.s - trace.s0) * STEP));
    // once a second every grudge eases back toward its resting value (0x408326, rates at brain 0x12c-0x134)
    for (grudgeT += dt; grudgeT >= 1; grudgeT -= 1) for (const r of all) if (r.brain) for (let p = 0; p < 10; p++) for (let i = 0; i < 3; i++) {
      const t = r.brain.cur[p], rest = r.brain.B.rest[p][i], k = r.brain.B.rates[i]; t[i] = t[i] > rest ? Math.max(rest, t[i] - k) : Math.min(rest, t[i] + k); }
    for (const x of cross) {
      if (!x.active) {
        // send a car across an intersection the player will reach in a few seconds
        const ahead = crossings.find((c) => c.s > me.s + M(80) && c.s < me.s + M(320) && !c.used);
        if (ahead && Math.random() < dt * 0.6) {
          ahead.used = true; Object.assign(x, { active: true, s: ahead.s, dir: Math.random() < 0.5 ? 1 : -1, v: 10 + Math.random() * 6 });
          x.lat = -x.dir * (HALF + 26); x.t.repeat.x = x.dir > 0 ? 1 : -1; x.t.offset.x = x.dir > 0 ? 0 : 1; x.sp.visible = true;
        }
        continue;
      }
      x.lat += x.dir * x.v * dt;
      if (Math.abs(x.lat) > HALF + 30 || x.s < me.s - M(60)) { x.active = false; x.sp.visible = false; continue; }
      for (const r of all) {
        if (r.remote || r.crashT > 0 || r.s < 0 || r.br >= 0) continue;
        if (Math.abs((r.s - x.s) * STEP) < 2 && Math.abs(r.lat - x.lat) < x.w / 2 + 0.3) { impact(r, Math.hypot(x.v, r.v), HEAVY, "hard"); crash(r, "cross_traffic"); r.v *= 0.2; if (r === me) sfx("crashhar", 0.9); }
      }
    }
    for (const c of traffic) {
      c.prevAlong = along(c);
      if (c.br >= 0) { const B = branches[c.br]; c.bs += (c.v * dt) / STEP; if (c.bs >= B.LB) { c.bs -= B.LB; c.prevAlong = c.bs; } c.s = B.at + (c.bs * B.LA) / B.LB; } // loops on its branch
      else if (c.coming) { c.s += (c.v * dt) / STEP; if (c.s < me.s - M(40) || c.s < 30) { c.s = comingSpot(me.s + M(150), M(300)); c.lat = -1.75; c.prevAlong = c.s; } }
      else { c.s += (c.v * dt) / STEP; if (c.s > END - 2) { c.s = 30; c.prevAlong = c.s; } }
      if (c.coming) { const ll = Math.max(1, Math.round(-EA(c, -1) / LANE_W)); let to = -(Math.min(c.lane ?? 0, ll - 1) + 0.5) * LANE_W;
        // a rider stopped or down in the car's way (after a crash, remounting): steer round them rather than through them
        const stuckR = all.find((r) => r.br < 0 && r.v < 8 && Math.abs(r.lat - to) < c.w / 2 + 1 && (c.s - r.s) * STEP > 0 && (c.s - r.s) * STEP < 45);
        if (stuckR) { const out = stuckR.lat - c.w / 2 - 1.2, inn = stuckR.lat + c.w / 2 + 1.2; to = out - c.w / 2 > EA(c, -1) ? out : inn; }
        c.lat += (to - c.lat) * Math.min(1, dt * (stuckR ? 2 : 0.8)); }
      else { const right = EA(c, 1), left = EA(c, -1), sg = right >= LANE_W ? 1 : -1, count = Math.max(1, Math.round((sg > 0 ? right : -left) / LANE_W));
        const to = sg * (Math.min(c.lane ?? 0, count - 1) + 0.5) * LANE_W; c.lat += (to - c.lat) * Math.min(1, dt * 0.8); }

    }
    if (wreckAt && clock >= wreckAt && !done) { done = true; result = { status: "wrecked", place: 0, time: clock }; }
    if (!SPECTATE) steerOf(me, me.finished ? { throttle: 0, brake: 1, steer: 0 } : playerControls(), dt);
    for (const r of field) if (r.remote) netFollow(r, dt); else steerOf(r, r.finished ? { throttle: 0, brake: 1, steer: 0 } : aiControls(r, dt), dt);
    if (SPECTATE) follow(dt);
    for (const c of traffic) for (const r of all) {
      if (r.remote || r.crashT > 0 || r.br !== c.br || r.s < 0 || (c.coming && EA(c, -1) > -LANE_W)) continue;
      const ds = (along(r) - along(c)) * STEP, was = ((r.prevAlong ?? along(r)) - (c.prevAlong ?? along(c))) * STEP;
      const crossing = Math.min(ds, was) < 1.2 && Math.max(ds, was) > -2.6;
      if (crossing && Math.abs(r.lat - c.lat) < c.w / 2 + 0.4 && r.v > c.v + 2) {
        impact(r, r.v - c.v, HEAVY, "hard"); crash(r, c.coming ? "headon" : "car", c.coming ? 0 : Math.max(0, c.v * 0.5));
        if (r.br >= 0) r.bs = Math.max(0, c.bs - 2 / STEP); else r.s = Math.max(0, c.s - 2 / STEP);
        if (r === me) sfx("crashhar", 0.9);
      }
    }
    // Riders collide (the original counts another rider as mass x1, see impact). Riding into the back of someone at
    // least 9 m/s (20 mph) slower puts you down and shoves them on; anything gentler pushes the two bikes apart, so
    // nobody rides through anybody. A.I. bikers only ever bump each other (crashing them made the opening pack a
    // pile-up). Each machine moves only the riders it steers (itself, and the host's A.I. bikers).
    if (clock > 1) for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.isCop || b.isCop || (a.remote && b.remote) || a.br !== b.br || a.crashT > 0 || b.crashT > 0 || a.s < 0 || b.s < 0 || a.finished || b.finished) continue;
      const dl = b.lat - a.lat; if (Math.abs(dl) >= RIDER_W) continue;
      const ds = (along(a) - along(b)) * STEP, was = ((a.prevAlong ?? along(a)) - (b.prevAlong ?? along(b))) * STEP;
      if (Math.min(ds, was) > BIKE_L || Math.max(ds, was) < -BIKE_L || Math.abs(ds - was) > 6) continue;
      const [back, front] = (Math.abs(was) > 0.05 ? was : ds) < 0 ? [a, b] : [b, a], closing = back.v - front.v;
      if (closing > (back === me ? 9 + 5 * ASSIST : 9) && (back === me || front === me || back.remote || front.remote)) {
        if (!back.remote) { impact(back, closing, 1, "rider"); crash(back, "rider", front.v * 0.8); if (back === me) sfx("crashhar", 0.9); }
        if (!front.remote) { front.wobble = 0.6; front.v += closing * 0.25; }
        continue;
      }
      const push = (RIDER_W - Math.abs(dl)) * (Math.sign(dl) || 1);
      if (!a.remote) a.lat -= push * (b.remote ? 1 : 0.5);
      if (!b.remote) b.lat += push * (a.remote ? 1 : 0.5);
      if (closing > 1 && !back.remote) { back.v -= closing * 0.5; back.wobble = Math.max(back.wobble || 0, 0.3); }
    }
    if (opts.police !== false && !SPECTATE && !done) {
      // the course's police records (RHZD behaviour 11+) call the law in where the original does
      const callIn = !cop.active && copSpawns.find((h) => !h.used && me.s >= h.s);
      if (callIn) copSpawns.forEach((h) => { if (h.s <= me.s) h.used = true; });
      if (!cop.active && (callIn || (!copSpawns.length && clock > cop.due)) && me.s > 30 && me.s < FIN - M(300)) {
        Object.assign(cop, newState(Math.max(10, me.s - M(70)), me.lat + 3), { active: true, v: me.v });
        cop.sprite.sp.visible = cop.sprite.shadow.visible = true;
        siren = play("siren", 0.5, true);
      }
      if (cop.active) {
        if (me.br >= 0) cop.brPick[me.br] = true;
        const gap = (me.s - cop.s) * STEP;
        steerOf(cop, cop.crashT > 0 ? { throttle: 0, brake: 1, steer: 0 } : {
          throttle: gap > 1 ? 1 : 0.4, brake: gap < -3 ? 1 : 0, steer: Math.max(-1, Math.min(1, (me.lat + (cop.lat > me.lat ? 1.6 : -1.6) - cop.lat) * 0.5)) }, dt);
        cop.cool -= dt;
        if (cop.crashT <= 0 && cop.cool <= 0 && cop.br === me.br && Math.abs(gap) < 2 && Math.abs(cop.lat - me.lat) < 2.3) { punch(cop, Math.sign(me.lat - cop.lat) || 1); cop.cool = 1.4 + Math.random(); }
        if (siren) siren.g.gain.value = Math.max(0.05, Math.min(0.6, 0.6 - Math.abs(gap) / 400)) * mix.siren * mix.master;
        // knocked down near the law = busted; leave the cop far behind (or knock him off) to lose him
        if (me.crashT > 0 && cop.crashT <= 0 && cop.br === me.br && Math.abs(gap) < 40) { done = true; result = { status: "busted", place: 0, time: clock }; sfx("sirenfst", 0.8); }
        if (gap > 400 || (cop.crashT > 0 && cop.crashT < 0.1)) { cop.active = false; cop.due = clock + 30 + Math.random() * 30; cop.sprite.sp.visible = cop.sprite.shadow.visible = false; siren?.pause(); siren = null; }
      }
    }
    if (me.finished && !done) {
      done = true;
      const place = 1 + field.filter((r) => r.finished && r.finished < me.finished).length;
      trace.d.push(Math.round((me.s - trace.s0) * STEP));
      result = { place, time: me.finished, status: "finished", trace: trace.d };
    }
  }

  // ---- Render & HUD ----
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000);
  // The decoded art is low resolution. A Retina canvas at 2x was shading millions of extra pixels without
  // adding asset detail; cap the drawing buffer and leave the crisp DOM HUD at the screen's native resolution.
  const touchDevice = matchMedia("(pointer: coarse)").matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" }); }
  catch { renderer = new THREE.WebGLRenderer({ antialias: false }); }
  startup.defer(() => { renderer.dispose(); renderer.forceContextLoss(); });
  renderer.debug.onShaderError = () => { throw new Error('The browser could not prepare the game graphics.'); };
  const pixelBudget = touchDevice ? 640 * 480 : 960 * 720;
  const desiredRatio = () => Math.min(devicePixelRatio, 1, Math.sqrt(pixelBudget / Math.max(1, container.clientWidth * container.clientHeight)));
  let maxRatio = desiredRatio(), ratio = maxRatio;
  renderer.setPixelRatio(ratio); container.appendChild(renderer.domElement);
  let needsDraw = true;
  const resize = () => { needsDraw = true; const w = container.clientWidth, h = container.clientHeight; maxRatio = desiredRatio(); if (ratio > maxRatio) { ratio = maxRatio; renderer.setPixelRatio(ratio); } renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  resize(); addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize);
  startup.defer(() => { removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); });
  const hud = document.createElement("div"); hud.className = "race-hud";
  hud.innerHTML = `<div class="race-top"><span class="pos"></span><span class="time"></span><span class="msg"></span></div><div class="paused" hidden>${(opts.quitText || "Hit Escape again to quit, any other key to continue.").replace(/</g, "&lt;").replace(/\n/g, "<br>")}<br><small>M: sound on/off</small></div>
    <div class="dash"><img src="./assets/img/dash/${bike.cls}.png"><div class="needle speed"></div><div class="needle rpm"></div></div>
    <div class="meters"><div class="leds">${"<i></i>".repeat(10)}</div><div class="bar me"><i></i></div><div class="bar foe"><i></i></div><span class="foe-name"></span></div>
    <div class="mph"></div><div class="weapon"></div><div class="viewhint">${touchDevice ? "Left thumb: drive + steer · Right thumb: fight + brake" : "↑ accelerate · ← → steer · Space punch · K kick · Esc pause"}</div>`;
  container.appendChild(hud);
  const touchSide = () => { let best = null; for (const o of all) if (o !== me && o.br === me.br && o.s > 0 && o.crashT <= 0 && Math.abs((o.s - me.s) * STEP) < 4 && (!best || Math.abs(o.lat - me.lat) < Math.abs(best.lat - me.lat))) best = o; return best ? Math.sign(best.lat - me.lat) || 1 : 1; };
  // Left thumb: hold to accelerate, drag to steer. Right thumb: brake and combat.
  if (SPECTATE) {
    container.classList.add("spectating");
    const stop = document.createElement("button"); stop.className = "spectate-stop"; stop.textContent = "Stop watching";
    stop.addEventListener("pointerdown", (e) => { e.stopPropagation(); quit = true; ride.how = "button"; });
    container.appendChild(stop);
    const modes = document.createElement("div"); modes.className = "spectate-modes";
    modes.innerHTML = '<button data-m="chase" class="on">Chase</button><button data-m="pov">POV</button><button data-m="above">Above</button><button data-m="free">Free</button><button data-h="1" class="height" aria-label="Higher">▲</button><button data-h="-1" class="height" aria-label="Lower">▼</button>';
    for (const btn of modes.querySelectorAll("[data-h]")) {
      btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); fly.up = +btn.dataset.h; });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, () => { fly.up = 0; });
    }
    modes.addEventListener("pointerdown", (e) => { e.stopPropagation(); const m = e.target.closest("button")?.dataset.m; if (m) setCam(m); });
    modes.classList.add("chase");
    container.appendChild(modes);
    container.addEventListener("pointerdown", (e) => { if (camMode !== "free") return watchNext(1); Object.assign(fly, { on: true, x: e.clientX, y: e.clientY, f: 0, sd: 0 }); });
    container.addEventListener("pointermove", (e) => { if (!fly.on) return; fly.f = Math.max(-1, Math.min(1, (fly.y - e.clientY) / 80)); fly.sd = Math.max(-1, Math.min(1, (e.clientX - fly.x) / 80)); });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) container.addEventListener(ev, () => Object.assign(fly, { on: false, f: 0, sd: 0 }));
  } else if (touchDevice || opts.touchButtons) {
    container.classList.add("touch-race");
    const steering = document.createElement("div"); steering.className = "steer-pad";
    steering.innerHTML = '<span class="steer-knob"></span><span class="steer-label">HOLD TO DRIVE<br>DRAG TO STEER</span>';
    container.appendChild(steering);
    paintTouch = () => { steering.classList.toggle("on", touch.on); steering.firstElementChild.style.transform = `translateX(${touch.travel * 36}px)`; };
    const pad = document.createElement("div"); pad.className = "tpad";
    const activeButtons = new Map();
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.className = "tbtn touch-control " + cls; b.textContent = label; b.type = "button";
      const ids = new Set(); activeButtons.set(b, ids);
      b.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); if (paused) return; b.setPointerCapture(e.pointerId); ids.add(e.pointerId); touch.held.add(cls); if (cls === "brake") touch.brake = true; fn(); b.classList.add("on"); wakeAudio(); }, { passive: false });
      const up = e => { ids.delete(e.pointerId); if (ids.size) return; touch.held.delete(cls); if (cls === "brake") touch.brake = false; b.classList.remove("on"); };
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(name, up);
      b.addEventListener("click", e => { if (e.detail === 0 && !paused) fn(); }); pad.appendChild(b); return b; };
    clearTouchButtons = () => { for (const [b, ids] of activeButtons) { ids.clear(); b.classList.remove("on"); } };
    btn("HIT", "hit", () => punch(me, touchSide()));
    btn("KICK", "kick", () => punch(me, touchSide(), "kick"));
    btn("BRAKE", "brake", () => {});
    if (bike.nitro || quickRaceCheatsAllowed(opts)) nitroTouchButton = btn("NITRO", "nitro", () => { if (clock >= 0 && me.nitros > 0 && !(me.nitroT > 0)) { me.nitros--; me.nitroT = me.bike.spec?.nitro ? me.bike.spec.nitro.c / 60 : 3; sfx("engnitro", 0.8); } });
    container.appendChild(pad);
    const pauseButton = document.createElement("button"); pauseButton.className = "race-pause touch-control"; pauseButton.textContent = "PAUSE";
    pauseButton.onclick = () => { releaseInput(); paused = true; }; container.appendChild(pauseButton);
    const overlay = hud.querySelector(".paused");
    overlay.innerHTML = `<div class="pause-panel"><strong>PAUSED</strong><button class="resume touch-control">CONTINUE</button>
      <div class="tilt-settings"><label>Steering</label><div class="steering-choices"><button class="use-thumb touch-control" aria-pressed="true">THUMB</button><button class="use-tilt touch-control" aria-pressed="false">TILT</button></div>
      <p class="tilt-status" role="status"></p><label for="tilt-sensitivity">Tilt sensitivity</label><select id="tilt-sensitivity" class="tilt-sensitivity"><option value="gentle">Gentle</option><option value="normal">Normal</option><option value="quick">Quick</option></select>
      <button class="tilt-centre touch-control" disabled>SET CENTRE</button></div><button class="sound-toggle touch-control">${isMuted() ? "SOUND: OFF" : "SOUND: ON"}</button><button class="quit touch-control">QUIT RACE</button></div>`;
    overlay.querySelector(".sound-toggle").addEventListener("click", () => setMuted(!isMuted()));
    const thumbButton = overlay.querySelector(".use-thumb"), tiltButton = overlay.querySelector(".use-tilt"), centreButton = overlay.querySelector(".tilt-centre"), sensitivity = overlay.querySelector(".tilt-sensitivity");
    updateTiltUI = () => {
      thumbButton.setAttribute("aria-pressed", String(!tilt.enabled)); tiltButton.setAttribute("aria-pressed", String(tilt.enabled));
      tiltButton.disabled = tilt.waiting; centreButton.disabled = !tilt.enabled;
      overlay.querySelector(".tilt-status").textContent = tilt.message;
      steering.classList.toggle("tilt-drive", tilt.enabled);
      steering.querySelector(".steer-label").innerHTML = tilt.enabled ? "HOLD TO DRIVE<br>TILT TO STEER" : "HOLD TO DRIVE<br>DRAG TO STEER";
    };
    thumbButton.onclick = () => { releaseInput(); tilt.disable(); };
    tiltButton.onclick = () => { releaseInput(); tilt.enable(); };
    centreButton.onclick = () => { releaseInput(); tilt.calibrate(); };
    sensitivity.value = tilt.sensitivity; sensitivity.onchange = () => tilt.setSensitivity(sensitivity.value);
    updateTiltUI();
    overlay.querySelector(".resume").onclick = () => { releaseInput(); paused = false; document.activeElement?.blur(); wakeAudio(); };
    overlay.querySelector(".quit").onclick = () => { releaseInput(); quit = true; ride.how = "button"; };
  }
  const cheats = createQuickRaceCheats({ opts, player: me, rivals: field,
    canUse: () => raceReady && !done && !quit,
    dismissPolice() {
      cop.active = false; cop.due = clock + 30;
      cop.sprite.sp.visible = cop.sprite.shadow.visible = false;
      copSpawns.forEach(h => { if (h.s <= me.s) h.used = true; });
      siren?.pause(); siren = null;
    },
    onUse(message, id) {
      releaseInput(); needsDraw = true; hint(message, 3); opts.onCheat?.(id);
      if (nitroTouchButton) nitroTouchButton.hidden = !me.bike.nitro;
    },
  });
  if (nitroTouchButton) nitroTouchButton.hidden = !me.bike.nitro;
  if (cheats) {
    const overlay = hud.querySelector(".paused");
    if (!overlay.querySelector(".pause-panel")) {
      overlay.innerHTML = '<div class="pause-panel"><strong>PAUSED</strong><button class="resume touch-control">CONTINUE</button><button class="quit touch-control">QUIT RACE</button></div>';
      overlay.querySelector(".resume").onclick = () => { releaseInput(); paused = false; document.activeElement?.blur(); wakeAudio(); };
      overlay.querySelector(".quit").onclick = () => { releaseInput(); quit = true; ride.how = "button"; };
    }
    cheatMenu = mountQuickRaceCheats({ container, pausePanel: overlay.querySelector(".pause-panel"), cheats,
      onOpen() { releaseInput(); paused = true; }, onClose() { needsDraw = true; } });
    startup.defer(() => cheatMenu.dispose());
  }
  const mapSelfId = net?.id || "player";
  const liveMap = mountCourseMap(hud, courseMap(data, sections, opts.level || 1), {live:true,name:data.name || course,legend:SPECTATE ? '■ FINISH' : undefined});
  const $els = new Map(), $ = (s) => { if (!$els.has(s)) $els.set(s, hud.querySelector(s)); return $els.get(s); };
  // HUD writes only when the value changes (DOM writes every frame cost layout/paint time on phones)
  const txt = (s, v) => { const e = $(s); if (e._t !== v) { e._t = v; e.textContent = v; } };
  const css = (s, k, v) => { const e = $(s), key = "_" + k; if (e[key] !== v) { e[key] = v; e.style[k] = v; } };
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), safeLook = new THREE.Vector3(), camOffset = new THREE.Vector3(); let camInit = false, cameraSpeed = 0, cameraBump = 0;

  function drawRider(r) {
    const t = T(r), p = toWorld(t, r.lat, r.yb - t.y);
    r.sprite.sp.position.copy(p);
    let i, mirror;
    const crashSet = r.isCop ? [33, 36, 37, 38, 39, 40, 41] : CRASH, swingSet = r.isCop ? [5, 7, 9] : ATTACK[r.attack] || PUNCH;
    const D = r.down;
    if (r.crashT > 0 && D) {
      mirror = false;
      if (D.ph === 0) i = r.v > 2 ? TUMBLE[((D.t * 12) | 0) % TUMBLE.length] : 282;
      else if (D.ph === 1 || D.ph === 9) i = 282;
      else if (D.ph === 2) i = GETUP[Math.min(GETUP.length - 1, ((D.t / 1.1) * GETUP.length) | 0)];
      else if (D.ph === 3) { const set = D.dir === "to" ? WALK_TO : D.dir === "away" ? WALK_AWAY : WALK_SIDE; i = set[((D.t * 8) | 0) % set.length]; mirror = D.dir === "right"; }
      else i = REMOUNT[Math.min(REMOUNT.length - 1, ((D.t / 1.2) * REMOUNT.length) | 0)];
    }
    else if (r.crashT > 0) { i = crashSet[Math.min(crashSet.length - 1, ((3.2 - r.crashT) * 4) | 0)]; mirror = false; }
    else if (r.punchT > 0 && r.attack === "kick" && !r.isCop) { i = KICK[r.punchSide < 0 ? -1 : 1][r.kickVar || 0][Math.min(2, ((0.35 - r.punchT) / 0.12) | 0)]; mirror = false; }
    else if (r.punchT > 0) { i = swingSet[Math.min(2, ((0.35 - r.punchT) / 0.12) | 0)]; mirror = r.punchSide !== (r.isCop ? 1 : ATTACK_SIDE[r.attack] ?? 1); }
    else {
      // Tiny corrections must not chatter between two poses or mirror the
      // asymmetric upright drawing. The wheel stays at the physics anchor.
      const amount = Math.min(3, Math.abs(r.lean) * 3.4), last = r.sprite.leanLevel ?? 0;
      const a = amount > last + .62 || amount < last - .62 ? Math.round(amount) : last;
      r.sprite.leanLevel = a; i = 3 - a; mirror = a > 0 && r.lean > 0;
    }
    r.sprite.show(i, mirror);
    // the bike lying where it slid to while its rider is off it
    const lone = r.crashT > 0 && D && D.ph !== 4;
    if (lone && !r.bikeSprite) r.bikeSprite = makeRider(r === me ? scheme : r.scheme);
    if (r.bikeSprite) {
      r.bikeSprite.sp.visible = r.bikeSprite.shadow.visible = lone && r.sprite.sp.visible;
      if (lone) { const bt = T(r, D.d); r.bikeSprite.sp.position.copy(toWorld(bt, D.bl)); r.bikeSprite.show(LONE_BIKE[D.bv > 1 ? ((D.t * 10) | 0) % 4 : 2], false); const bg = toWorld(bt, D.bl); r.bikeSprite.shadow.position.set(bg.x, bg.y + 0.04, bg.z); r.bikeSprite.shadow.rotation.set(-Math.PI / 2, -bt.h - chartOf(r.br).h, 0); }
    }
    const g = toWorld(t, r.lat); r.sprite.shadow.position.set(g.x, g.y + 0.04, g.z); r.sprite.shadow.rotation.set(-Math.PI / 2 + Math.atan(t.slope), -t.h - chartOf(r.br).h, 0);
  }
  const chartMatrix = (chart) => new THREE.Matrix4().makeRotationY(-chart.h).setPosition(chart.x, chart.y, chart.z);
  const applyChart = (mesh, chart) => {
    if (mesh.userData.appliedChart === chart) return;
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(chartMatrix(chart));
    if (mesh.userData.localMatrix) mesh.matrix.multiply(mesh.userData.localMatrix);
    mesh.matrixWorldNeedsUpdate = true; mesh.userData.appliedChart = chart;
  };
  let activeChartRoute = -1, entranceChart = null, exitChart = null;
  function syncCharts() {
    if (me.br !== activeChartRoute) {
      if (me.br >= 0) {
        entranceChart = mainChart; branchCharts[me.br] = entranceChart;
        const B = branches[me.br], end = transformFrame(B.bp.at(-1), entranceChart);
        exitChart = alignChart(pts[B.J], end);
      } else if (activeChartRoute >= 0 && exitChart) mainChart = exitChart;
      activeChartRoute = me.br;
    }
    if (me.br >= 0) mainChart = me.bs > branches[me.br].LB / 2 ? exitChart : entranceChart;
    // Other alternatives share the currently visible main-road coordinates at their entrance.
    for (let k = 0; k < branchCharts.length; k++) if (k !== me.br) {
      const B = branches[k];
      if (me.s > (B.at + B.J) / 2) {
        if (B.joinMainChart !== mainChart) { B.joinMainChart = mainChart; B.joinChart = alignChart(B.bp.at(-1), transformFrame(pts[B.J], mainChart)); }
        branchCharts[k] = B.joinChart;
      } else branchCharts[k] = mainChart;
    }
  }
  function cameraSection(ds, me = player) {
    const B = branches[me.br], q = B ? me.bs + ds : me.s + ds;
    const branch = B && q >= 0 && q <= B.LB;
    const s = B ? q < 0 ? B.at + q : q > B.LB ? B.J + q - B.LB : me.s + ds * B.LA / B.LB : q;
    const i = Math.max(0, Math.round(branch ? q : s)), t = T(me, ds);
    const sides = branch ? scen?.forks?.[B.fi] : scen;
    const ground = (lat) => t.y + (branch ? 0 : terrainY(s, lat));
    const clipLat = (lat) => {
      const sg = Math.sign(lat) || 1, arr = sg < 0 ? sides?.left : sides?.right;
      if (arr?.[i] || arr?.[i-1] || arr?.[i+1]) {
        const edge = branch ? (sg < 0 ? B.edgeL : B.edgeR)[Math.min(B.LB,i)] : edgeAt(s,sg);
        const width = branch ? shoulderForks[B.fi]?.[i]?.[sg<0?0:1] : null;
        const sh = branch ? width == null ? SW : width*.069/4 : swAt(s,sg);
        lat = sg * Math.min(Math.abs(lat),Math.max(.05,Math.abs(edge)+sh-.7));
      }
      const tw = !branch && tunAt[i]; if (tw) lat = Math.max(-tw+.6,Math.min(tw-.6,lat));
      return lat;
    };
    return { t, ground, clipLat };
  }
  function guardCameraPosition(me) {
    // Validate the interpolated position, not only the desired position: easing can carry the
    // eye through a narrowing frontage or a cliff even when both endpoints are clear.
    const chart = chartOf(me.br), c = Math.cos(chart.h), sn = Math.sin(chart.h);
    const wx = camPos.x-chart.x, wz = camPos.z-chart.z, x=c*wx+sn*wz, z=-sn*wx+c*wz;
    let distance=Infinity, ds=0;
    for(let j=-8;j<3;j++){
      const a=T(me,j),b=T(me,j+1),dx=b.x-a.x,dz=b.z-a.z,den=dx*dx+dz*dz;
      if(den<1e-6)continue;
      const u=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/den)),d=(x-a.x-u*dx)**2+(z-a.z-u*dz)**2;
      if(d<distance){distance=d;ds=j+u;}
    }
    const section=cameraSection(ds,me),t=section.t,rx=Math.cos(t.h),rz=Math.sin(t.h),lat=(x-t.x)*rx+(z-t.z)*rz;
    const safeLat=safeCameraLat(section,section.clipLat(lat),camPos.y-chart.y-.6);
    const delta=safeLat-lat;
    camPos.x+=(c*rx-sn*rz)*delta;camPos.z+=(sn*rx+c*rz)*delta;
    camPos.y=Math.max(camPos.y,section.ground(safeLat)+chart.y+.6);
  }
  const player = me;
  function draw(dt = 1 / 60, alpha = 1) {
    liveMap.update([...(SPECTATE ? [] : [{id:mapSelfId,name:opts.playerName,s:player.s,slot:opts.slot,finished:player.finished}]),...field.map((r,i)=>({id:r.remote || r.botId || `ai:${i}`,name:r.name,s:r.s,slot:r.slot ?? i,finished:r.finished}))],mapSelfId);
    const me = renderPose(player, alpha, branches);
    syncCharts();
    joinView.selected.value = me.br; joinView.viewerStep.value = me.s;
    if (me.br >= 0) { const B = branches[me.br]; joinView.mainWindow.value.set(me.bs > B.LB/2 ? B.J-JOIN_STEPS : -1e6, me.bs > B.LB/2 ? 1e6 : B.at+JOIN_STEPS); }
    else joinView.mainWindow.value.set(-1e6,1e6);
    if (me.br >= 0) { const B = branches[me.br]; routeCut.value.set(B.at - 1, B.J + 1); } else routeCut.value.set(-1, -1);
    const viewY = chartOf(me.br).y;
    const ease = (k) => 1 - Math.pow(1 - k, Math.min(0.1, dt) * 60);
    const seat = SPECTATE && camMode === "pov" ? watched() : null; // the watched rider's own seat: don't draw them over the camera
    for (const state of field) { const r = renderPose(state, alpha, branches); r.sprite.sp.visible = r.sprite.shadow.visible = state !== seat && r.br === me.br && r.s > me.s - M(40) && r.s < me.s + M(660); if (r.sprite.sp.visible) { drawRider(r); if (Math.abs(r.s - me.s) > M(150)) r.sprite.shadow.visible = false; } else if (r.bikeSprite) r.bikeSprite.sp.visible = r.bikeSprite.shadow.visible = false; }
    if (cop.active) { const r = renderPose(cop, alpha, branches); r.sprite.sp.visible = r.sprite.shadow.visible = r.br === me.br; if (r.sprite.sp.visible) drawRider(r); }
    // anything beyond the fog (or well behind the camera) is skipped entirely: no draw call, no position update
    const near = (sIdx) => sIdx > me.s - M(40) && sIdx < me.s + M(660);
    for (const [c, mesh, span = 1] of chunks) {
      const route = mesh.userData.route ?? -1;
      const lo = mesh.userData.roadRange?.[0] ?? c*CHUNK, hi = mesh.userData.roadRange?.[1] ?? (c+span)*CHUNK;
      if (mesh.userData.joinBase) mesh.material = route === me.br ? mesh.userData.joinBase : mesh.userData.joinMask;
      applyChart(mesh, chartOf(route));
      // The original streams the road being ridden. Drawing the other route's hillside over a town alternative
      // buried the road and rider in rock; retain the other route only where it is visible at a split or join.
      const B = branches[me.br >= 0 ? me.br : route];
      const apron = B && (me.s > (B.at+B.J)/2 ? hi > B.J-JOIN_STEPS*B.LA/B.LB : lo < B.at+JOIN_STEPS*B.LA/B.LB);
      const mouth = B && apron && (Math.abs(me.s - B.at) < M(220) || Math.abs(me.s - B.J) < M(220));
      const mainMouth = route < 0 && hi > joinView.mainWindow.value.x && lo < joinView.mainWindow.value.y;
      const sameRoad = route === me.br || (me.br >= 0 ? mainMouth : mouth);
      mesh.visible = sameRoad && hi > me.s - M(40) && lo < me.s + M(660);
    }
    for (const o of scene.children) if (o.userData.localMatrix) applyChart(o, mainChart);
    for (const state of traffic) { const c = renderPose(state, alpha, branches); c.sp.visible = c.br === me.br && near(c.s) && (!c.coming || EA(c, -1) <= -LANE_W); if (c.sp.visible) c.sp.position.copy(toWorld(T(c), c.lat)); }
    placeProps(me.br < 0 ? me.s : -1000);
    drawPeds(alpha);
    for (const state of cross) { const x = renderPose(state, alpha, branches); x.sp.visible = x.active && me.br < 0 && near(x.s); if (x.sp.visible) x.sp.position.copy(toWorld(track(x.s), x.lat)); }
    for (const L of lights) { L.sp.visible = me.br < 0 && near(L.c.a); if (!L.sp.visible) continue; const ph = (clock + L.c.phase) % 12; L.sp.material = L.mats[ph < 7 ? "STOP3G" : ph < 9 ? "STOP3Y" : "STOP3R"]; }
    const chase = view === "chase";
    me.sprite.sp.visible = me.sprite.shadow.visible = chase && !SPECTATE; if (me.bikeSprite && !chase) me.bikeSprite.sp.visible = me.bikeSprite.shadow.visible = false;
    css(".dash", "display", chase && touchDevice ? "none" : "");
    css(".mph", "display", chase ? "" : "none");
    let cameraRoll = 0;
    if (chase) {
      // Chase view, the original's own view: measured from its frames (640x480, own rider ~135 px tall at its native
      // sprite size, lane lines at 1.67 x eye height apart, horizon 30% down), the eye is ~2.2 m up and ~5.3 m behind the
      // bike, looking level along the road; the horizon is raised by an off-centre lens below, not by pitching down.
      drawRider(me);
      const tallK = Math.max(0, Math.min(1, (container.clientHeight / container.clientWidth - 1) / 1.1));
      const back = T(me, -M(5.3 + 1.5 * tallK)), ahead = T(me, M(60)), eye = 2.2 + 0.3 * tallK;
      // the camera trails the rider, so on a bend along a pavement it would end up behind the building fronts: keep it
      // inside the building line (or tunnel wall) at its own step
      const section = cameraSection(-M(5.3 + 1.5*tallK),me);
      const upcoming = cameraSection(M(8 - 1.5*tallK),me);
      let camLat = section.clipLat(upcoming.clipLat(me.lat * .95));
      // keep the camera out of the ground: on mountain roads rock rises sheer beside the road, and on a bend the trailing
      // camera can swing over it - pull it in toward the road until the ground under it is below the rider's eye
      camLat = safeCameraLat(section,camLat,me.yb+eye);
      const camGround = section.ground(camLat);
      // Anchor the eye to the rider's height. Anchoring it to the trailing road instead makes
      // the bike drift up/down the screen as the road behind crests or falls away.
      const wantPos = toWorld(back, camLat).setY(Math.max(me.yb + eye + .6, camGround + .6) + viewY), wantLook = toWorld(ahead, me.lat * 0.8).setY(ahead.y + eye + viewY);
      const here = T(me), rider = toWorld(here, me.lat, me.yb-here.y), wantOffset = wantPos.clone().sub(rider);
      if (!camInit) { camOffset.copy(wantOffset); camLook.copy(wantLook); cameraSpeed=me.v; cameraBump=0; camInit = true; }
      // Ease the trailing offset, not the rider's forward travel. World-position
      // easing adds a speed-dependent delay; centring on a nearby rider then
      // magnifies that lag into yaw kicks at bends and changes of gradient.
      camOffset.lerp(wantOffset, ease(0.18)); camPos.copy(rider).add(camOffset); camLook.lerp(wantLook, ease(0.2));
      if (me.down) {
        // A wall can clamp the rider across several lane widths in one tick. An
        // easing camera left outside the pavement then looks sideways across the
        // whole road. Keep recovery close to the safe trailing camera position.
        const dx = camPos.x - wantPos.x, dz = camPos.z - wantPos.z, gap = Math.hypot(dx, dz);
        if (gap > 1.25) { camPos.x = wantPos.x + dx * 1.25 / gap; camPos.z = wantPos.z + dz * 1.25 / gap; }
      }
      if (me.wobble > 0) cameraRoll=Math.sin(clock*30)*.02;
    } else {
      // First-person view from the rider's helmet; our own sprite is hidden.
      const here = T(me), ahead = T(me, 10);
      const wantPos = toWorld(here, me.lat).setY(me.yb + 1.55 + viewY), wantLook = toWorld(ahead, me.lat + me.lean * 1.5).setY(Math.max(ahead.y, me.yb) + 1.1 + viewY);
      if (!camInit) { camPos.copy(wantPos); camLook.copy(wantLook); cameraSpeed=me.v; camInit = true; }
      camPos.lerp(wantPos, ease(0.5)); camLook.lerp(wantLook, ease(0.3));
      cameraRoll=-me.lean*.18+(me.wobble>0?Math.sin(clock*30)*.03:0);
    }
    guardCameraPosition(me);
    if (chase) { const t=T(me); camOffset.copy(camPos).sub(toWorld(t,me.lat,me.yb-t.y)); }
    cameraBump+=(bump-cameraBump)*ease(.3);
    camera.position.copy(camPos);camera.position.y+=cameraBump;bump*=Math.pow(.85,dt*60);
    const w = container.clientWidth, hgt = container.clientHeight, tall = Math.max(0, Math.min(1, (hgt / w - 1) / 1.1));
    cameraSpeed+=(me.v-cameraSpeed)*ease(.08);
    const k = (chase ? 0.4 : 0) + 0.2 * tall, base = 58 + cameraSpeed * 0.12;
    const lookDistance=Math.max(.1,Math.hypot(camLook.x-camera.position.x,camLook.z-camera.position.z)),pitchLimit=Math.tan((chase?8:12)*Math.PI/180)*lookDistance;
    safeLook.copy(camLook);safeLook.y=camera.position.y+Math.max(-pitchLimit,Math.min(pitchLimit,camLook.y-camera.position.y));
    if (chase) {
      // A sixty-metre look-ahead can swing the view across a bend.
      // Keep the bike near the centre, rather than merely somewhere in the frame:
      // an edge-framed, rear-facing sprite makes the road's direction hard to read.
      const here = T(me), rider = toWorld(here, me.lat, me.yb - here.y);
      const roadYaw = Math.atan2(safeLook.x - camera.position.x, camera.position.z - safeLook.z);
      const riderYaw = Math.atan2(rider.x - camera.position.x, camera.position.z - rider.z);
      const delta = Math.atan2(Math.sin(roadYaw - riderYaw), Math.cos(roadYaw - riderYaw));
      const lens = Math.tan(base * Math.PI / 360), margin = Math.atan(lens * w / hgt * .12);
      // Preview the bend gently: taking the full distant-road angle can whip
      // from one side of this small centre band to the other through an S-bend.
      const yaw = riderYaw + Math.max(-margin, Math.min(margin, delta * .2));
      safeLook.x = camera.position.x + Math.sin(yaw) * lookDistance;
      safeLook.z = camera.position.z - Math.cos(yaw) * lookDistance;
      // Hills can pull the distant look-at up/down while the bike is right beside
      // us, moving its tyres from the top half of the screen into the controls.
      // Keep its ground anchor in the lower middle of the cropped phone lens.
      // A band preserves natural movement; the existing 8-degree limit still applies.
      const depth = (rider.x - camera.position.x) * Math.sin(yaw) - (rider.z - camera.position.z) * Math.cos(yaw);
      if (depth > .1) {
        const elevation = Math.atan2(rider.y - camera.position.y, depth);
        const pitch = Math.atan2(safeLook.y - camera.position.y, lookDistance);
        const foot = k + Math.tan(elevation - pitch) / lens;
        const framed = elevation - Math.atan((Math.max(-.55, Math.min(-.15, foot)) - k) * lens);
        safeLook.y = camera.position.y + Math.tan(Math.max(-8 * Math.PI / 180, Math.min(8 * Math.PI / 180, framed))) * lookDistance;
      }
    }
    if (SPECTATE && (camMode === "free" || camMode === "above") && freeH > 1) {
      // behind and above the point being flown, looking down at it: what is under the camera's point stays in view
      const back = T(me, -M(freeH * 0.7)), focus = T(me, M(8));
      camera.position.copy(toWorld(back, me.lat)).setY(me.yb + 2 + freeH);
      safeLook.copy(toWorld(focus, me.lat)).setY(focus.y + 1); cameraRoll = 0;
    }
    camera.lookAt(safeLook);camera.rotateZ(cameraRoll);
    // Tall (portrait) screens: an off-centre lens like the Geng runner. The frustum is taller than the screen and we show
    // its lower part, so the horizon sits ~1/3 down and the extra height goes to road ahead instead of empty sky.
    // chase view: the frustum is taller than the screen and we show its lower part, putting the horizon 30% down
    // (k = 0.4) with the same focal length; the fov is the taller frustum's
    camera.fov = (2 * Math.atan((1 + k) * Math.tan((base * Math.PI) / 360)) * 180) / Math.PI;
    if (k > 0.01) camera.setViewOffset(w, hgt * (1 + k), 0, hgt * k, w, hgt); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    sky.position.set(camPos.x, camPos.y + 60, camPos.z);
    renderer.render(scene, camera);
    if (renderer.getContext().isContextLost()) throw new Error('The graphics context was lost.');
    startup.ready();
    if (!raceReady) { raceReady = true; engine = play(engineName, 0.35, true); wakeAudio(); }
    // HUD
    const place = 1 + field.filter((r) => (r.finished && (!me.finished || r.finished < me.finished)) || (!r.finished && r.s > me.s)).length;
    if (SPECTATE) { const t = watched(); txt(".pos", camMode === "free" ? `FREE CAMERA · ${Math.round(freeH)} M UP` : t ? `${camMode === "pov" ? "POV" : camMode === "above" ? "ABOVE" : "WATCHING"} ${t.name} · ${placeOf(t)}/${field.length}${camMode === "above" ? ` · ${Math.round(freeH)} M UP` : ""}` : "WATCHING"); }
    else txt(".pos", `${place}/${field.length + 1}`);
    txt(".time", fmt(Math.max(0, clock)));
    txt(".msg", !netGo ? "Waiting for players..." : clock < 0 ? String(Math.ceil(-clock)) : clock < 1.5 ? "GO!" : result?.status === "busted" ? "BUSTED!" : me.wrecked ? "WRECKED!" : done && net?.host && !net.roundEnded ? "Finished — waiting for riders…" : done ? (result.place === 1 ? "WINNER!" : result.place <= 3 ? "QUALIFIED" : "LOSER!") : hintT > clock ? hintText : "");
    if (SPECTATE) txt(".viewhint", camMode === "free" ? (touchDevice ? "Drag to fly · ▲ ▼ height" : "↑ ↓ fly · ← → sideways · Q E height · C camera") : camMode === "above" ? (touchDevice ? "Tap: another rider · ▲ ▼ height" : "← → another rider · Q E height · C camera") : touchDevice ? "Tap to watch another rider" : "← → another rider · C camera");
    else txt(".viewhint", me.down ? (touchDevice || ASSIST >= 0.4 ? "Returning to your bike…" : "↑ or release keys: return to bike · ← ↓ →: walk") : (touchDevice ? touchHintDismissed ? "" : tilt.enabled ? "Hold DRIVE · Tilt to steer · Right thumb: fight + brake" : "Left thumb: drive + steer · Right thumb: fight + brake" : "↑ accelerate · ← → steer · Space punch · K kick · Esc pause"));
    txt(".weapon", [me.weapon ? me.weapon.toUpperCase() : "", me.bike.nitro ? `NITRO ${"●".repeat(me.nitros)}` : "", me.gear ? `GEAR ${me.gear}` : ""].filter(Boolean).join("  "));
    const mph = me.v * 2.237; txt(".mph", `${Math.round(mph)} MPH`); css(".speed", "transform", `rotate(${Math.round(-230 + Math.min(200, mph) * 2.3) / 2}deg)`);
    const gs = me.bike.gears || [], gi = Math.max(0, (me.gear || 1) - 1), lo = Math.max(0, gs[gi]?.down ?? 0), hi = gs[gi]?.up ?? 100;
    const rpm = 3 + 9 * Math.max(0, Math.min(1, (mph - lo) / Math.max(1, Math.min(hi, me.bike.topMph || hi) - lo))); css(".rpm", "transform", `rotate(${Math.round(-230 + rpm * 38) / 2}deg)`);
    const foe = field.filter((r) => Math.abs((r.s - me.s) * STEP) < 6).sort((a, b) => Math.abs(a.s - me.s) - Math.abs(b.s - me.s))[0];
    { const lit = Math.ceil((10 * me.cond) / condMax(me)); if (lit !== ledLit) { ledLit = lit; hud.querySelectorAll(".leds i").forEach((e, k) => e.classList.toggle("on", k < lit)); } }
    css(".me i", "width", `${me.health * 20}%`); css(".foe i", "width", foe ? `${foe.health * 20}%` : "0"); txt(".foe-name", foe ? foe.name : "");
    const er = 0.6 + Math.min(1.6, me.v / me.bike.top * 1.4); if (Math.abs(er - (engine?.rate ?? 0)) > 0.01) setEngineRate(er);
  }

  const joinView = bakeJoinMasks({ THREE, chunks, main: pts, branches, edgeL, edgeR, shL, shR, shoulderForks, chunkSize: CHUNK, transformFrame });
  let frameCount = 0;
  const gov = { t: 0, n: 0, slow: 0, fast: 0, changes: 0, next: 0 }; let last0 = 0;
  // ---- Preload: build every prop material and pedestrian texture now, wait for all images, upload them to the GPU
  // and compile the shaders, so the race itself never stops to load anything.
  for (const pr of animProps) for (const f of pr[7]) propMat(f, pr[5]);
  for (const k of new Set(pedSpawns.map((h) => h.p))) if (!pedTex.has(k)) { const b = loader.load(`./data/peds/${k}.png`); b.colorSpace = THREE.SRGBColorSpace; b.magFilter = THREE.NearestFilter; b.generateMipmaps = false; b.minFilter = THREE.LinearFilter; pedTex.set(k, b); }
  if (AC) for (const [, names] of PED_VOICE) for (const n of names) sample(n);
  await Promise.all([...texBase.values()].map((e) => e.done));
  for (const e of texBase.values()) if (e.error) throw e.error;
  startup.status('Preparing graphics…');
  await new Promise(resolve => setTimeout(resolve, 0));
  const seen = new Set();
  const upload = (t) => { if (t && t.image && !seen.has(t.source)) { seen.add(t.source); renderer.initTexture(t); } };
  allTex.forEach(upload); for (const m of propMats.values()) upload(m.map);
  scene.traverse((o) => upload(o.material?.map));
  // The ridden tarmac needs no join masking. Warm its plain material as well as the other road's
  // clipped material, so changing routes saves fragment work without compiling a shader mid-race.
  const roadMaterials = []; scene.traverse((o) => { if (o.userData.joinBase) { roadMaterials.push([o,o.material]); o.material=o.userData.joinBase; } });
  renderer.compile(scene, camera);
  for (const [o,m] of roadMaterials) o.material=m;
  renderer.compile(scene, camera);
  // draw everything once (all chunks, every sprite) into a tiny target so all vertex buffers are on the GPU too
  { const rt = new THREE.WebGLRenderTarget(64, 64), vis = []; scene.traverse((o) => { vis.push([o, o.visible]); o.visible = true; });
    const cam = camera.clone(); cam.far = 1e6; cam.updateProjectionMatrix(); const fc = []; scene.traverse((o) => { fc.push([o, o.frustumCulled]); o.frustumCulled = false; });
    renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(null); rt.dispose();
    for (const [o, v] of vis) o.visible = v; for (const [o, f] of fc) o.frustumCulled = f; }
  last0 = performance.now();
  return new Promise((resolve, reject) => {
    let last = last0, endT = 0, raf, accumulator = 0;
    const contextLost = event => { event.preventDefault(); reject(new Error('The graphics context was lost.')); };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    startup.defer(() => renderer.domElement.removeEventListener('webglcontextlost', contextLost));
    startup.defer(() => cancelAnimationFrame(raf));
    const frame = (now) => {
      try {
      const gap = now - last;
      let dt = (paused && !net) || !netGo ? 0 : Math.min(0.1, gap / 1000); last = now; netSend();
      css(".paused", "display", paused ? "flex" : "none");
      container.classList.toggle("race-paused", paused);
      // apply a pending resolution change before drawing, so the cleared canvas is redrawn in this same frame
      if (gov.next && Math.abs(gov.next - ratio) > 0.01) { ratio = gov.next; renderer.setPixelRatio(ratio); resize(); } gov.next = 0;
      const fdt = dt;
      accumulator += dt;
      while (accumulator >= 1 / 60) {
        for (const r of all) rememberPose(r);
        for (const c of traffic) rememberPose(c);
        for (const x of cross) rememberPose(x);
        for (const p of peds) rememberPose(p);
        for (const r of all) { r.prevAlong = along(r); r.prevLat = r.lat; }
        step(1 / 60);
        if (clock >= 0) { stepPeds(1 / 60); stepRoad(); } else stepPeds(1 / 60, true);
        accumulator -= 1 / 60;
      }
      if (fdt > 0 || needsDraw || frameCount === 0) { draw(fdt, accumulator * 60); needsDraw = false; }
      // resolution governor: average frame gap over ~1 s; drop pixel ratio when slow, raise it back when there's headroom
      // Not during the countdown (textures are still uploading then), only after 3 slow seconds in a row (or 6 with
      // headroom), and at most 6 changes a race: every change resizes the canvas, which flickers and shifts sharpness.
      if (clock > 1 && !paused) { gov.t += gap; gov.n++; }
      if (gov.t > 1000) { const avg = gov.t / gov.n; gov.t = gov.n = 0;
        gov.slow = avg > 24 ? gov.slow + 1 : 0; gov.fast = avg < 14 ? gov.fast + 1 : 0;
        if (gov.changes < 6 && gov.slow >= 3 && ratio > 0.6) { gov.next = Math.max(0.6, ratio - 0.15); gov.slow = 0; gov.changes++; }
        else if (gov.changes < 6 && gov.fast >= 6 && ratio < maxRatio) { gov.next = Math.min(maxRatio, ratio + 0.1); gov.fast = 0; gov.changes++; }
      }
      frameCount++;
      if (done && !endT) { endT = now; net?.send({ t: "fin", time: result.time, status: result.status }); }
      if (quit || (done && now - endT > 3000 && (!net?.host || net.roundEnded)) || (SPECTATE && net?.roundEnded)) {
        resolve(SPECTATE ? { status: "spectated" } : { ...(quit && (!done || net?.host) ? { status: "quit" } : result), ride: rideReport(), ...(cheats && { usedCheats: cheats.used }) });
        return;
      }
      raf = requestAnimationFrame(frame);
      } catch (error) { reject(error); }
    };
    raf = requestAnimationFrame(frame); net?.ready();
  });
}
