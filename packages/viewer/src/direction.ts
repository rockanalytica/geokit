// Directions in the world as azimuth and plunge — a Section's convention and
// a Line's: clockwise from north, plunge below the horizontal, down
// positive — and a plane's attitude as dip direction and dip. Z up, Y north.

type Vec3 = [number, number, number];

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** The unit vector a Section is looked along. */
export function sectionDirection(azimuth: number, plunge: number): Vec3 {
  const a = rad(azimuth);
  const p = rad(plunge);
  return [Math.sin(a) * Math.cos(p), Math.cos(a) * Math.cos(p), -Math.sin(p)];
}

/** The azimuth and plunge of a direction; a vertical one is given azimuth 0. */
export function directionAngles(d: Vec3): { azimuth: number; plunge: number } {
  const [x, y, z] = unit(d);
  const plunge = deg(Math.asin(Math.max(-1, Math.min(1, -z))));
  const flat = Math.hypot(x, y) < 1e-9;
  const azimuth = flat ? 0 : (deg(Math.atan2(x, y)) + 360) % 360;
  return { azimuth, plunge };
}

/** The upward unit normal of a plane of that dip direction and dip. */
export function planeNormal(dipDirection: number, dip: number): Vec3 {
  const d = rad(dipDirection);
  const p = rad(dip);
  return [Math.sin(d) * Math.sin(p), Math.cos(d) * Math.sin(p), Math.cos(p)];
}

/**
 * A plane's attitude from either of its normals: the dip direction, the
 * azimuth of its steepest descent as `directionAngles` gives azimuths, and
 * the dip; a level plane has dip direction 0. Its steepest line is then
 * `sectionDirection(dipDirection, dip)`.
 */
export function planeAttitude(normal: Vec3): { dipDirection: number; dip: number } {
  let n = unit(normal);
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  const dip = deg(Math.acos(Math.max(-1, Math.min(1, n[2]))));
  // the upward normal leans toward the side the plane goes down to
  const dipDirection =
    Math.hypot(n[0], n[1]) < 1e-12 ? 0 : directionAngles([n[0], n[1], 0]).azimuth;
  return { dipDirection, dip };
}
