import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ROUND_LIGHTING_TRANSITION_END_S, ROUND_LIGHTING_TRANSITION_START_S } from "../config";

// Two quiet passages in a round, with one reusable plane and one twin trail.
// The distant, low elevation stays in the small sky strip of the follow view.
// A gentle bank preserves a readable wing silhouette during the crossing.
const FLIGHTS = [
  { start: 14, end: 38, x: -38, z: -104, dx: 76, dz: 6, height: 4.1, bank: 0.32 },
  { start: 56, end: 80, x: 41, z: -99, dx: -82, dz: -8, height: 3.7, bank: -0.32 },
] as const;
const TRAIL_LIFE_S = 7;
const TRAIL_SEGMENTS = 8;

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function airplaneGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (geometry: THREE.BufferGeometry, color: number): void => {
    if (geometry.index !== null) {
      const original = geometry;
      geometry = geometry.toNonIndexed();
      original.dispose();
    }
    const tint = new THREE.Color(color);
    const colors = new Float32Array(geometry.getAttribute("position").count * 3);
    for (let index = 0; index < colors.length; index += 3) {
      colors[index] = tint.r;
      colors[index + 1] = tint.g;
      colors[index + 2] = tint.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  };
  const fuselage = new THREE.SphereGeometry(1, 8, 4);
  fuselage.scale(1.65, 0.16, 0.19);
  paint(fuselage, 0x6b7c89);
  // Swept main wings and smaller rear stabilizers are flat extrusions. All
  // parts merge into one mesh; the underside silhouette reads from the arena.
  const wing = (x: number, span: number, length: number, height: number): void => {
    const shape = new THREE.Shape();
    shape.moveTo(length * 0.5, 0);
    shape.lineTo(-length * 0.36, span);
    shape.lineTo(-length * 0.7, span);
    shape.lineTo(-length * 0.5, 0);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.045, bevelEnabled: false });
    geometry.rotateX(Math.PI / 2);
    geometry.translate(x, height, 0);
    paint(geometry, 0x536977);
  };
  wing(0.1, 2.1, 1.5, 0);
  wing(0.1, -2.1, 1.5, 0);
  wing(-1.1, 0.78, 0.62, 0.04);
  wing(-1.1, -0.78, 0.62, 0.04);
  const tail = new THREE.BoxGeometry(0.48, 0.65, 0.05);
  tail.translate(-1.1, 0.29, 0);
  paint(tail, 0x536977);
  const merged = mergeGeometries(parts)!;
  parts.forEach((part) => part.dispose());
  merged.computeBoundingSphere();
  return merged;
}

export class SkyAircraft {
  public readonly object = new THREE.Group();
  private readonly airplane: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly trails: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly trailPositions = new Float32Array(2 * (TRAIL_SEGMENTS + 1) * 2 * 3);
  private readonly trailAges = new Float32Array(2 * (TRAIL_SEGMENTS + 1) * 2);
  private readonly trailOffsets = new Float32Array(2 * (TRAIL_SEGMENTS + 1) * 2);
  private disposed = false;

  public constructor() {
    this.object.name = "sky-aircraft";
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, fog: false,
      depthWrite: false, toneMapped: false,
    });
    this.airplane = new THREE.Mesh(airplaneGeometry(), material);
    this.airplane.name = "sky-airplane";
    this.airplane.frustumCulled = false;
    this.object.add(this.airplane);

    const geometry = new THREE.BufferGeometry();
    const uv = new Float32Array(this.trailAges.length * 2);
    const indices: number[] = [];
    for (let stream = 0; stream < 2; stream += 1) {
      const first = stream * (TRAIL_SEGMENTS + 1) * 2;
      for (let segment = 0; segment <= TRAIL_SEGMENTS; segment += 1) {
        uv[(first + segment * 2) * 2] = 0;
        uv[(first + segment * 2 + 1) * 2] = 1;
        for (let edge = 0; edge < 2; edge += 1) {
          uv[(first + segment * 2 + edge) * 2 + 1] = segment / TRAIL_SEGMENTS;
        }
        if (segment < TRAIL_SEGMENTS) {
          const base = first + segment * 2;
          indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
    }
    geometry.setIndex(indices);
    geometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("ageFade", new THREE.BufferAttribute(this.trailAges, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("ribbonOffset", new THREE.BufferAttribute(this.trailOffsets, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const trailMaterial = new THREE.ShaderMaterial({
      uniforms: {
        opacity: { value: 0 }, tint: { value: new THREE.Color(0xf7f6ee) },
        heading: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: `
        attribute float ageFade;
        attribute float ribbonOffset;
        uniform vec3 heading;
        varying float vFade;
        varying vec2 vUv;
        void main() {
          vFade = ageFade;
          vUv = uv;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vec3 tangent = (modelViewMatrix * vec4(heading, 0.0)).xyz;
          // Face the active camera: ground-flat ribbons would disappear from
          // this low sky angle, regardless of their world-space width.
          vec3 side = cross(tangent, viewPosition.xyz);
          side = length(side) > 0.00001 ? normalize(side) : vec3(0.0, 1.0, 0.0);
          viewPosition.xyz += side * ribbonOffset;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform float opacity;
        uniform vec3 tint;
        varying float vFade;
        varying vec2 vUv;
        void main() {
          float edge = smoothstep(0.0, 0.28, vUv.x) * smoothstep(0.0, 0.28, 1.0 - vUv.x);
          gl_FragColor = vec4(tint, opacity * vFade * edge);
          #include <colorspace_fragment>
        }
      `,
      transparent: true, depthWrite: false, fog: false, toneMapped: false,
      side: THREE.DoubleSide, forceSinglePass: true,
    });
    this.trails = new THREE.Mesh(geometry, trailMaterial);
    this.trails.name = "airplane-contrails";
    this.trails.frustumCulled = false;
    // The centered trail mesh has its origin at the camera. Paint it before
    // the plane so transparent sorting cannot lay the exhaust over its wings.
    this.trails.renderOrder = -1;
    this.object.add(this.trails);
    // Keep the sky fixed in world direction as the follow camera moves. A
    // mesh callback (groups are not rendered) also works with alternate views.
    const centerOnCamera: THREE.Object3D["onBeforeRender"] = (_renderer, _scene, camera): void => {
      camera.getWorldPosition(this.object.position);
      this.object.parent?.worldToLocal(this.object.position);
      this.object.updateMatrixWorld(true);
    };
    this.airplane.onBeforeRender = centerOnCamera;
    this.trails.onBeforeRender = centerOnCamera;
    this.reset();
  }

  public setElapsed(elapsedSeconds: number): void {
    if (this.disposed) return;
    const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    this.airplane.visible = false;
    this.trails.visible = false;
    this.airplane.material.opacity = 0;
    this.trails.material.uniforms.opacity!.value = 0;
    if (elapsed >= ROUND_LIGHTING_TRANSITION_END_S) return;
    let flight: (typeof FLIGHTS)[number] | undefined;
    for (const candidate of FLIGHTS) {
      if (elapsed >= candidate.start && elapsed < candidate.end + TRAIL_LIFE_S) {
        flight = candidate;
        break;
      }
    }
    if (flight === undefined) return;
    const daylight = 1 - smooth01((elapsed - ROUND_LIGHTING_TRANSITION_START_S)
      / (ROUND_LIGHTING_TRANSITION_END_S - ROUND_LIGHTING_TRANSITION_START_S));
    const duration = flight.end - flight.start;
    const headingLength = Math.hypot(flight.dx, flight.dz);
    const headingX = flight.dx / headingLength;
    const headingZ = flight.dz / headingLength;
    const pathTime = Math.min(elapsed, flight.end);
    const progress = (pathTime - flight.start) / duration;
    this.airplane.position.set(flight.x + flight.dx * progress, flight.height, flight.z + flight.dz * progress);
    this.airplane.rotation.set(flight.bank, -Math.atan2(headingZ, headingX), 0, "YXZ");
    this.airplane.material.opacity = daylight * smooth01((elapsed - flight.start) / 2)
      * smooth01((flight.end - elapsed) / 2);
    this.airplane.visible = this.airplane.material.opacity > 0;
    this.trails.material.uniforms.opacity!.value = 0.42 * daylight;
    (this.trails.material.uniforms.heading!.value as THREE.Vector3).set(headingX, 0, headingZ);
    this.trails.visible = elapsed > flight.start;
    const oldest = Math.max(flight.start, elapsed - TRAIL_LIFE_S);
    for (let stream = 0; stream < 2; stream += 1) {
      const engineOffset = stream === 0 ? -0.7 : 0.7;
      for (let segment = 0; segment <= TRAIL_SEGMENTS; segment += 1) {
        const recordedTime = pathTime - (pathTime - oldest) * segment / TRAIL_SEGMENTS;
        const age = elapsed - recordedTime;
        const recordedProgress = (recordedTime - flight.start) / duration;
        const engineLateral = engineOffset * Math.cos(flight.bank) - 0.03 * Math.sin(flight.bank);
        const engineY = -engineOffset * Math.sin(flight.bank) - 0.03 * Math.cos(flight.bank);
        const centerX = flight.x + flight.dx * recordedProgress - headingX * 0.5 - headingZ * engineLateral;
        const centerZ = flight.z + flight.dz * recordedProgress - headingZ * 0.5 + headingX * engineLateral;
        const halfWidth = 0.15 + 0.18 * age / TRAIL_LIFE_S;
        for (let edge = 0; edge < 2; edge += 1) {
          const vertex = stream * (TRAIL_SEGMENTS + 1) * 2 + segment * 2 + edge;
          const side = edge === 0 ? -halfWidth : halfWidth;
          this.trailPositions[vertex * 3] = centerX;
          this.trailPositions[vertex * 3 + 1] = flight.height + engineY;
          this.trailPositions[vertex * 3 + 2] = centerZ;
          this.trailOffsets[vertex] = side;
          this.trailAges[vertex] = (1 - smooth01(age / TRAIL_LIFE_S)) * smooth01((recordedTime - flight.start) / 2);
        }
      }
    }
    this.trails.geometry.getAttribute("position").needsUpdate = true;
    this.trails.geometry.getAttribute("ageFade").needsUpdate = true;
    this.trails.geometry.getAttribute("ribbonOffset").needsUpdate = true;
  }

  public reset(): void {
    this.setElapsed(0);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.object.removeFromParent();
    this.airplane.geometry.dispose();
    this.airplane.material.dispose();
    this.trails.geometry.dispose();
    this.trails.material.dispose();
    this.object.clear();
  }
}
