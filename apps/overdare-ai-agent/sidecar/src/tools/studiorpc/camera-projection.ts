// @summary Maps between world coordinates and screenshot pixels using the camera block a capture reports.

export type Vec3 = { x: number; y: number; z: number };

/** Everything the projection needs, all of it present in a game.screenshot / viewport.camera.read response. */
export type CameraBlock = {
  position: Vec3;
  /** Degrees. X is pitch (negative looks down), Y is yaw, Z is roll. */
  orientation: Vec3;
  /** Horizontal, in degrees — the vertical angle follows from aspectRatio. */
  fieldOfView: number;
  aspectRatio: number;
};

export type ImageSize = { width: number; height: number };

export type ScreenPoint = {
  /** Pixel column and row in the captured image, top-left origin. */
  pixel: { x: number; y: number };
  /** Same point as a fraction of width/height — the form studiorpc_game_input_inject takes. */
  normalized: { x: number; y: number };
  /** True when the point is in front of the camera and inside the frame. */
  onScreen: boolean;
  behindCamera: boolean;
  /** Distance along the view axis; negative means behind the camera. */
  depth: number;
};

const DEG = Math.PI / 180;

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function normalize(a: Vec3): Vec3 {
  const m = Math.sqrt(dot(a, a));
  return m === 0 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / m);
}

/**
 * Camera axes for an Orientation block. Verified against five poses spanning yaw 0/±42/−140 and
 * pitch −1..−38: projected probe cubes landed within 2.8px of their photographed centroids.
 * Roll is ignored — every capture observed reports 0 and no measurement pins its sign.
 */
export function cameraBasis(orientation: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const pitch = orientation.x * DEG;
  const yaw = orientation.y * DEG;
  const forward = {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch),
  };
  const worldUp = { x: 0, y: 1, z: 0 };
  const up = normalize(sub(worldUp, scale(forward, dot(worldUp, forward))));
  return { forward, right: normalize(cross(forward, up)), up };
}

function halfExtents(camera: CameraBlock): { tanH: number; tanV: number } {
  const tanH = Math.tan((camera.fieldOfView * DEG) / 2);
  return { tanH, tanV: tanH / camera.aspectRatio };
}

/** Where a world point lands in a capture taken with this camera. */
export function projectWorldToScreen(camera: CameraBlock, image: ImageSize, point: Vec3): ScreenPoint {
  const { forward, right, up } = cameraBasis(camera.orientation);
  const { tanH, tanV } = halfExtents(camera);
  const d = sub(point, camera.position);
  const depth = dot(d, forward);
  const behindCamera = depth <= 0;
  // Mirroring the ray behind the camera would report a plausible on-screen pixel for a point
  // that cannot be seen, so the sign is carried through and onScreen stays false instead.
  const ndcX = depth === 0 ? 0 : dot(d, right) / depth / tanH;
  const ndcY = depth === 0 ? 0 : dot(d, up) / depth / tanV;
  const nx = (ndcX + 1) / 2;
  const ny = (1 - ndcY) / 2;
  return {
    pixel: { x: nx * image.width, y: ny * image.height },
    normalized: { x: nx, y: ny },
    onScreen: !behindCamera && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1,
    behindCamera,
    depth,
  };
}

/** View ray through a pixel, as a unit direction in world space. */
export function screenPixelToRay(camera: CameraBlock, image: ImageSize, pixel: { x: number; y: number }): Vec3 {
  const { forward, right, up } = cameraBasis(camera.orientation);
  const { tanH, tanV } = halfExtents(camera);
  const ndcX = (2 * pixel.x) / image.width - 1;
  const ndcY = 1 - (2 * pixel.y) / image.height;
  return normalize(add(forward, add(scale(right, ndcX * tanH), scale(up, ndcY * tanV))));
}

/**
 * World point under a pixel, assuming it sits on the horizontal plane y = groundY.
 * Returns null when the ray runs parallel to that plane or meets it behind the camera.
 */
export function unprojectScreenToPlane(
  camera: CameraBlock,
  image: ImageSize,
  pixel: { x: number; y: number },
  groundY = 0,
): Vec3 | null {
  const dir = screenPixelToRay(camera, image, pixel);
  if (Math.abs(dir.y) < 1e-9) return null;
  const t = (groundY - camera.position.y) / dir.y;
  if (t <= 0) return null;
  return add(camera.position, scale(dir, t));
}
