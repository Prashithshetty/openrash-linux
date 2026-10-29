// Road Rash draws a moving road window, not a closed world map. Each decoded RNOD route keeps
// its original turns and grades. A rigid coordinate transform aligns the next road at a join.
export const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const identityChart = () => ({ x: 0, y: 0, z: 0, h: 0 });
export function transformFrame(p, chart) {
  const c = Math.cos(chart.h), s = Math.sin(chart.h);
  return { ...p, x: c * p.x - s * p.z + chart.x, y: p.y + chart.y,
    z: s * p.x + c * p.z + chart.z, h: p.h + chart.h };
}
export function alignChart(source, target) {
  const h = angleDelta(target.h, source.h), c = Math.cos(h), s = Math.sin(h);
  return { x: target.x - c * source.x + s * source.z, y: target.y - source.y,
    z: target.z - s * source.x - c * source.z, h };
}
export function decodeBranch(main, at, length, steps, stepSize, turnOf) {
  const start = main[at], end = main[at + length];
  let { x, y, z, h } = start;
  const bp = [{ ...start }];
  for (const [a, b] of steps) {
    h += turnOf(a); y += b * stepSize / 256;
    x += Math.sin(h) * stepSize; z -= Math.cos(h) * stepSize;
    bp.push({ x, y, z, h });
  }
  let divergence = 0;
  for (let i = 1; i <= Math.min(20, steps.length, length); i++) divergence += angleDelta(bp[i].h, main[at + i].h);
  const side = Math.sign(divergence) || -1;
  return { bp, side, exit: alignChart(end, bp.at(-1)) };
}
