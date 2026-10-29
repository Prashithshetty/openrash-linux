// Keep the 60 Hz simulation authoritative. The camera and moving art sample the
// same point between its last two ticks, including on 90/120/144 Hz displays.
const fields = ['s', 'bs', 'lat', 'yb', 'v', 'lean', 'punchT', 'crashT', 'x', 'at'];
export function safeCameraLat(section, lat, ceiling) {
  // A descending road can itself be above the proposed clearance. Moving
  // sideways cannot fix that; only a rise beside the road warrants a side move.
  ceiling = Math.max(ceiling,section.ground(0));
  if (section.ground(lat) <= ceiling) return lat;
  const sign = Math.sign(lat); let lo = 0, hi = Math.abs(lat);
  for (let k = 0; k < 16; k++) {
    const mid = (lo + hi) / 2;
    if (section.ground(sign * mid) <= ceiling) lo = mid; else hi = mid;
  }
  return sign * lo;
}
export function rememberPose(r) {
  const p = r.renderPrevious || (r.renderPrevious = {});
  for (const k of fields) p[k] = r[k];
  p.br = r.br; p.active = r.active; p.attack = r.attack; p.punchSide = r.punchSide; p.state = r.state;
  p.down = r.down ? { ...r.down } : null;
}
export function renderPose(r, alpha, branches) {
  const p = r.renderPrevious;
  if (!p || p.active !== r.active) return r;
  alpha = Math.max(0, Math.min(1, alpha));
  let s = p.s, bs = p.bs, yb = p.yb;
  if (p.br !== r.br) {
    if (p.br < 0 && r.br >= 0) { const b = branches[r.br]; bs = p.s - b.at; }
    else if (p.br >= 0 && r.br < 0) {
      const b = branches[p.br]; s = b.J + p.bs - b.LB;
      // A branch's end height is expressed in its local road coordinates.
      yb += b.mainEndY - b.bp.at(-1).y;
    } else return r;
  }
  // Re-spawns, teleports and collision corrections must not sweep through the
  // intervening scenery. Normal joins, airborne motion and crashes still blend.
  if (Math.abs((r.br >= 0 ? r.bs - bs : r.s - s)) > 2 || Math.abs(r.lat - p.lat) > 4 || Math.abs(r.yb - yb) > 4) return r;
  const q = r.renderCurrent || (r.renderCurrent = Object.create(r));
  for (const k of fields) q[k] = Number.isFinite(r[k]) && Number.isFinite(p[k]) ? p[k] + (r[k] - p[k]) * alpha : r[k];
  if (r.br >= 0) { const b = branches[r.br]; q.bs = bs + (r.bs - bs) * alpha; q.s = b.at + q.bs * b.LA / b.LB; }
  else q.s = s + (r.s - s) * alpha;
  q.yb = Number.isFinite(yb) && Number.isFinite(r.yb) ? yb + (r.yb - yb) * alpha : r.yb;
  if (r.attack !== p.attack || r.punchSide !== p.punchSide || r.punchT > p.punchT) q.punchT = r.punchT;
  // Crash/remount is an animation-state boundary, not a numeric crossfade.
  // Blending 3.2 down to zero after remount briefly draws a tumbling pose again.
  if ((r.crashT > 0) !== (p.crashT > 0)) q.crashT = r.crashT;
  if (r.state !== p.state) q.at = r.at;
  q.down = r.down;
  if (r.down && p.down && r.down.ph === p.down.ph) {
    q.down = { ...r.down };
    for (const k of ['t', 'd', 'bl', 'bv']) if (Number.isFinite(p.down[k]) && Number.isFinite(r.down[k])) q.down[k] = p.down[k] + (r.down[k] - p.down[k]) * alpha;
  }
  return q;
}
