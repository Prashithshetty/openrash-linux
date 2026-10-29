export const JOIN_STEPS = 16; // Only the junction apron of the unselected road belongs in this road window.

// A road's signed lateral distances, projected onto its nearest segment. Keep the end planes:
// a joining route stops at its last node; extending its mask past that node cuts a hole in the exit.
export function projectRoad(points, x, z, from = 0, to = points.length - 1) {
  let best = Infinity, result;
  const first = Math.max(0, Math.floor(from)), last = Math.min(points.length - 2, Math.ceil(to) - 1);
  for (let i = first; i <= last; i++) {
    const a = points[i], b = points[i + 1], dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
    const u = ((x - a.x) * dx + (z - a.z) * dz) / length2, v = Math.max(0, Math.min(1, u));
    const ex = x - a.x - v * dx, ez = z - a.z - v * dz, distance = ex * ex + ez * ez;
    if (distance >= best) continue;
    best = distance;
    result = { step: i + v, y: a.y + v * (b.y - a.y), lat: ((x - a.x) * -dz + (z - a.z) * dx) / Math.sqrt(length2),
      cap: Math.min(i === first ? u : 1, i === last ? 1 - u : 1) * Math.sqrt(length2) };
  }
  return result;
}

// Bake the other road's footprint into the mesh, once. Shader interpolation clips individual
// fragments at the carriageway edge instead of dropping entire five-metre quads at a merge.
export function bakeJoinMasks({ THREE, chunks, main, branches, edgeL, edgeR, shL, shR, shoulderForks, chunkSize, transformFrame }) {
  const selected = { value: -1 }, viewerStep = { value: 0 }, mainWindow = { value: new THREE.Vector2(-1e6,1e6) }, materials = new Map();
  const roads = branches.map(B => ({
    inMain: B.bp.map(p => transformFrame(p, B.toMain)),
    mainInBranch: main.map(p => transformFrame(p, B.exit)),
  }));
  for (const [c, mesh, span = 1] of chunks) {
    const route = mesh.userData.route ?? -1, B = branches[route], positions = mesh.geometry.getAttribute('position');
    const steps = mesh.geometry.getAttribute('roadStep'), ownPath = B ? B.bp : main;
    const lo = mesh.userData.roadRange?.[0] ?? c * chunkSize, hi = mesh.userData.roadRange?.[1] ?? (c+span) * chunkSize;
    const start = B ? (lo-B.at) * B.LB / B.LA : lo;
    const end = B ? (hi-B.at) * B.LB / B.LA : hi;
    const overlaps = (a,b) => start < b && end > a;
    // Whole chunks away from the apron use the ordinary material. The CPU visibility gate
    // excludes them on the other route; running the merge shader over distant scenery wastes fill rate.
    const candidates = B ? (start < JOIN_STEPS+4 || end > B.LB-JOIN_STEPS-4 ? [B] : []) : branches.filter(b =>
      overlaps(b.at-2,b.at+JOIN_STEPS+2) || overlaps(b.J-JOIN_STEPS-2,b.J+2));
    if (!candidates.length) continue;
    const mask = [], shoulders = [], heights = [], progress = [], otherSpan = [];
    for (let v = 0; v < positions.count; v++) {
      const x = positions.getX(v), z = positions.getZ(v);
      const own = steps ? steps.getX(v) : (() => {
        const p = projectRoad(ownPath, x, z, start - 2, end + 2);
        return p ? (B ? B.at + p.step * B.LA / B.LB : p.step) : start;
      })();
      progress.push(own);
      const other = candidates.reduce((best, b) => !best || Math.min(Math.abs(own-b.at),Math.abs(own-b.J)) < Math.min(Math.abs(own-best.at),Math.abs(own-best.J)) ? b : best, null);
      const atEnd = own > (other.at + other.J) / 2, k = branches.indexOf(other);
      const near = Math.abs(own - (atEnd ? other.J : other.at)) < 110;
      const path = B ? (atEnd ? roads[k].mainInBranch : main) : (atEnd ? roads[k].inMain : other.bp);
      const from = B ? (atEnd ? other.J : other.at) - 100 : (atEnd ? other.LB - 100 : 0);
      const to = B ? (atEnd ? other.J : other.at) + 100 : (atEnd ? other.LB : 100);
      const q = near ? projectRoad(path, x, z, from, to) : null;
      if (!q) { mask.push(-1,-1,-1,-99); shoulders.push(0,0); heights.push(0); otherSpan.push(1e6); continue; }
      const i = Math.max(0, Math.min(path.length - 1, Math.round(q.step)));
      const L = B ? edgeL[i] : other.edgeL[i], R = B ? edgeR[i] : other.edgeR[i];
      const sh = B ? [shL[i], shR[i]] : (shoulderForks[other.fi]?.[i] || [0,0]).map(n=>n*.069/4);
      mask.push(q.lat-L,R-q.lat,q.cap,B ? -1 : k); shoulders.push(...sh);
      otherSpan.push(B ? (atEnd ? B.J-q.step : q.step-B.at) : (atEnd ? other.LB-q.step : q.step));
      const s = Math.max(0,Math.min(ownPath.length-1,B ? (own-B.at)*B.LB/B.LA : own)), j=Math.min(ownPath.length-2,Math.floor(s));
      heights.push(q.y - (ownPath[j].y+(ownPath[j+1].y-ownPath[j].y)*(s-j)));
    }
    mesh.geometry.setAttribute('joinRoad',new THREE.Float32BufferAttribute(mask,4));
    mesh.geometry.setAttribute('joinShoulder',new THREE.Float32BufferAttribute(shoulders,2));
    mesh.geometry.setAttribute('joinHeight',new THREE.Float32BufferAttribute(heights,1));
    mesh.geometry.setAttribute('joinProgress',new THREE.Float32BufferAttribute(progress,1));
    mesh.geometry.setAttribute('joinOtherSpan',new THREE.Float32BufferAttribute(otherSpan,1));
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.boundingSphere.radius += heights.reduce((m,h)=>Math.max(m,Math.abs(h)),0);
    const base = mesh.material, tarmac = !!mesh.userData.tarmac, key = `${base.uuid}:${route}:${tarmac}`;
    if (!materials.has(key)) {
      const mat = base.clone(), before = base.onBeforeCompile, cache = base.customProgramCacheKey();
      mat.onBeforeCompile = (sh, renderer) => {
        before.call(mat, sh, renderer); sh.uniforms.uSelectedRoad = selected; sh.uniforms.uJoinViewerStep = viewerStep; sh.uniforms.uJoinMainWindow = mainWindow;
        const active = `abs(uSelectedRoad - float(${route})) < .1`;
        // Only the selected route supplies the moving road window's grade. The other route's
        // short junction apron follows that grade too; otherwise its independent hills hang in the sky.
        sh.vertexShader = 'uniform float uSelectedRoad; attribute vec4 joinRoad; attribute vec2 joinShoulder; attribute float joinHeight; attribute float joinProgress; attribute float joinOtherSpan; varying float vJoinOtherSpan; varying float vJoinProgress; varying vec4 vJoinRoad; varying vec2 vJoinShoulder;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>\nvJoinOtherSpan=joinOtherSpan; vJoinProgress=joinProgress; vJoinRoad=joinRoad; vJoinShoulder=joinShoulder; if (!(${active}) && joinRoad.w > -2.0) transformed.y += joinHeight * smoothstep(-2.0,0.0,joinRoad.z);`);
        const test = tarmac ? `!(${active})` : 'true';
        const pad = tarmac ? 'vec2(0.0)' : `((${active}) ? vec2(0.0) : vJoinShoulder)`;
        const windowGap = B ? `${JOIN_STEPS.toFixed(1)} - (uJoinViewerStep > float(${(B.at+B.J)/2}) ? (float(${B.J})-vJoinProgress) : (vJoinProgress-float(${B.at}))) * float(${B.LB/B.LA})` : 'min(vJoinProgress-uJoinMainWindow.x,uJoinMainWindow.y-vJoinProgress)';
        sh.fragmentShader = 'uniform float uSelectedRoad; uniform float uJoinViewerStep; uniform vec2 uJoinMainWindow; varying float vJoinOtherSpan; varying float vJoinProgress; varying vec4 vJoinRoad; varying vec2 vJoinShoulder;\n'+sh.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
float joinNoise = fract(dot(floor(gl_FragCoord.xy),vec2(.754877666,.569840296)));
if (!(${active})) { float joinKeep = clamp((${windowGap})/4.0,0.0,1.0); if (joinKeep < .999 && joinKeep <= joinNoise) discard; }
if (${test} && (!(${active}) || clamp((float(${JOIN_STEPS})-vJoinOtherSpan)/4.0,0.0,1.0) > joinNoise) && vJoinRoad.w > -2.0 && vJoinRoad.z >= 0.0) { vec2 gap = vJoinRoad.xy + ${pad}; if (gap.x > .025 && gap.y > .025) discard; }`);
      };
      mat.customProgramCacheKey = () => `${cache}:join:${route}:${tarmac}`;
      materials.set(key, mat);
    }
    mesh.material = materials.get(key);
    if (tarmac) { mesh.userData.joinBase = base; mesh.userData.joinMask = mesh.material; }
  }
  return { selected, viewerStep, mainWindow };
}
