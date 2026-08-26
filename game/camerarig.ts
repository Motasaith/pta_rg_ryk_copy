import * as THREE from 'three';
import { angleDamp, clamp, damp, fwdX, fwdZ, lerp, rgtX, rgtZ } from './mathx';
import { Physics } from './physics';
import { Settings } from './settings';
import { Vehicle } from './vehicle';

/**
 * Third-person camera.
 *
 * Conventions used everywhere in the game (see mathx.ts):
 *   forward = (sin yaw, 0, cos yaw)     right = forward × up = (−cos yaw, 0, sin yaw)
 *   turning right DECREASES yaw; +pitch lifts the camera and looks down.
 *
 * Movement input is resolved in this basis, which is why W always walks towards the top of
 * the screen instead of drifting sideways. In aim mode the camera also slides over the right
 * shoulder so the centre-screen ray leaves the player's silhouette completely.
 */
export class CameraRig {
  yaw = 0;
  pitch = 0.2;
  dist = 6.2;
  aimW = 0;
  shake = 0;
  private recover = 0;
  private pos = new THREE.Vector3(0, 3, -8);
  private pivot = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private idleMouse = 0;
  private fov = 62;

  applyMouse(dx: number, dy: number, s: Settings, aiming: boolean): void {
    if (dx === 0 && dy === 0) {
      this.idleMouse += 1 / 60;
      return;
    }
    this.idleMouse = 0;
    const scale = 0.0021 * s.sensitivity * (aiming ? s.aimSensitivity : 1);
    // mouse right → look right → yaw decreases (see the basis note in mathx.ts)
    this.yaw -= dx * scale;
    this.pitch += (s.invertY ? -dy : dy) * scale;
    this.pitch = clamp(this.pitch, -0.55, 1.12);
  }

  /** Weapon kick: pushes the aim up, then hands most of it back. */
  addRecoil(pitchKick: number, yawKick: number, shake: number): void {
    this.pitch -= pitchKick;
    this.yaw += yawKick;
    this.recover += pitchKick * 0.62;
    this.shake = Math.min(1.4, this.shake + shake);
  }

  zoomStep(dir: number): void {
    this.dist = clamp(this.dist + dir * 0.7, 3.2, 11);
  }

  forwardX(): number { return fwdX(this.yaw); }
  forwardZ(): number { return fwdZ(this.yaw); }
  rightX(): number { return rgtX(this.yaw); }
  rightZ(): number { return rgtZ(this.yaw); }

  updateOnFoot(
    camera: THREE.PerspectiveCamera, dt: number,
    fx: number, fy: number, fz: number,
    aiming: boolean, zoom: number, phys: Physics, s: Settings,
    crouching = false,
  ): void {
    // recover part of the recoil
    if (this.recover > 0) {
      const step = Math.min(this.recover, 2.6 * dt);
      this.pitch += step;
      this.recover -= step;
      this.pitch = clamp(this.pitch, -0.55, 1.12);
    }
    this.aimW = damp(this.aimW, aiming ? 1 : 0, 11, dt);

    const shoulder = lerp(0.34, 0.78, this.aimW);
    const height = lerp(crouching ? 1.05 : 1.46, 1.52, this.aimW);
    const want = lerp(this.dist, 2.5, this.aimW);

    this.pivot.set(
      fx + this.rightX() * shoulder,
      fy + height,
      fz + this.rightZ() * shoulder,
    );

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.desired.set(
      this.pivot.x - this.forwardX() * cp * want,
      this.pivot.y + sp * want,
      this.pivot.z - this.forwardZ() * cp * want,
    );

    // pull in if a wall is in the way
    const frac = phys.segmentClear(this.pivot.x, this.pivot.y, this.pivot.z, this.desired.x, this.desired.y, this.desired.z, 0.26);
    if (frac < 1) {
      this.desired.lerpVectors(this.pivot, this.desired, Math.max(0.12, frac * 0.96));
    }

    this.pos.lerp(this.desired, 1 - Math.exp(-(aiming ? 22 : 15) * dt));
    camera.position.copy(this.pos);
    this.applyShake(camera, dt, s);

    // Screen centre passes exactly through the shoulder pivot and continues into the world,
    // so the crosshair is never sitting on the player's own head.
    camera.lookAt(this.pivot);

    const targetFov = s.fov * (aiming ? zoom : 1);
    this.fov = damp(this.fov, targetFov, 12, dt);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  updateInVehicle(camera: THREE.PerspectiveCamera, dt: number, v: Vehicle, phys: Physics, s: Settings): void {
    this.aimW = damp(this.aimW, 0, 10, dt);
    // auto-centre behind the car once the player stops moving the mouse
    if (this.idleMouse > 0.9) {
      const behind = v.speed < -1 ? v.yaw + Math.PI : v.yaw;
      this.yaw = angleDamp(this.yaw, behind, 3.2, dt);
      this.pitch = damp(this.pitch, 0.22, 3, dt);
    }
    // Speed sense scaled to the car's OWN top speed, so a flat-out rickshaw feels quick
    // and a hypercar at 60 km/h feels like it is loafing.
    const rel = clamp(Math.abs(v.speed) / v.spec.maxSpeed, 0, 1.3);
    const back = v.spec.camBack + rel * 2.4 + (v.boosting ? 0.9 : 0);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.pivot.set(v.x, v.y + v.spec.camUp * 0.42 + 0.8, v.z);
    this.desired.set(
      this.pivot.x - this.forwardX() * cp * back,
      this.pivot.y + sp * back + v.spec.camUp * 0.5,
      this.pivot.z - this.forwardZ() * cp * back,
    );
    const frac = phys.segmentClear(this.pivot.x, this.pivot.y, this.pivot.z, this.desired.x, this.desired.y, this.desired.z, 0.3);
    if (frac < 1) this.desired.lerpVectors(this.pivot, this.desired, Math.max(0.15, frac * 0.96));

    this.pos.lerp(this.desired, 1 - Math.exp(-9 * dt));
    camera.position.copy(this.pos);
    this.applyShake(camera, dt, s);
    camera.lookAt(v.x + Math.sin(v.yaw) * 4, v.y + 1.1, v.z + Math.cos(v.yaw) * 4);

    const targetFov = s.fov + rel * 13 + (v.boosting ? 7 : 0);
    this.fov = damp(this.fov, targetFov, v.boosting ? 9 : 6, dt);
    // a whisper of shake once you are near the limit — free, and it sells the speed
    if (rel > 0.82 && s.cameraShake) this.shake = Math.max(this.shake, (rel - 0.82) * 0.5);
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
  }

  private applyShake(camera: THREE.PerspectiveCamera, dt: number, s: Settings): void {
    this.shake = Math.max(0, this.shake - dt * 3.4);
    if (!s.cameraShake || this.shake <= 0) return;
    const a = this.shake * 0.09;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
  }

  /** Bullets start here, not at the lens, so geometry behind the player can't block a shot. */
  getPivot(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pivot);
  }

  /** Snap behind a target — used on spawn and respawn. */
  reset(yaw: number, x: number, y: number, z: number): void {
    this.yaw = yaw;
    this.pitch = 0.2;
    this.recover = 0;
    this.shake = 0;
    this.pos.set(x - Math.sin(yaw) * this.dist, y + 3, z - Math.cos(yaw) * this.dist);
  }
}
