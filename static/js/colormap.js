// Viridis, sampled at 9 stops and linearly interpolated.
const STOPS = [
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141],
  [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
];

export function viridis(v) {
  const x = Math.min(Math.max(v, 0), 1) * (STOPS.length - 1);
  const i = Math.min(Math.floor(x), STOPS.length - 2);
  const f = x - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Plotly colorscale form of the same map.
export const VIRIDIS_SCALE = STOPS.map((c, i) => [i / (STOPS.length - 1), `rgb(${c.join(",")})`]);

// Maps fitness to [0, 1]; log mode spreads the low end, where the optimum lives.
export function normaliser(zMin, zMax, log) {
  const span = zMax - zMin || 1;
  if (!log) return (z) => (z - zMin) / span;
  const d = Math.log1p(span);
  return (z) => Math.log1p(Math.max(z - zMin, 0)) / d;
}
