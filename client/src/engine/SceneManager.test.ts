import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdsManager } from "../ads/AdsLoader";
import {
  AIRBORNE_VY_THRESHOLD,
  ARENA_HALF_SIZE,
  AVATAR_CHARGE_OPACITY,
  BLOOD_BURST_COUNT,
  CAMERA_CHARGE_DISTANCE,
  CAMERA_FOLLOW_DISTANCE,
  CAMERA_FOLLOW_HEIGHT,
  CAMERA_LOOK_AT_HEIGHT,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_REST_PITCH,
  CAMERA_SENSITIVITY,
  CAMERA_WALL_MARGIN,
  DEATH_BURST_CHARTREUSE,
  DEATH_BURST_COUNT,
  DEATH_BURST_LIFE_S,
  DEATH_BURST_ORANGE,
  DEATH_BURST_RED,
  DEATH_BURST_SPREAD,
  DEATH_BURST_UP,
  DEATH_BURST_YELLOW,
  FIREFLY_COUNT,
  HIT_FLASH_DURATION_S,
  IDLE_FOLLOW_PITCH,
  MIRROR_PITCH_MAX,
  MIRROR_PITCH_MIN,
  NEBULA_COUNT,
  PARTICLE_BURST_COUNT,
  RECOIL_FULL_M,
  SHADOW_MAP_SIZE,
  WALL_FADE_OPACITY,
  WALL_GLASS_OPACITY,
  WALL_HEIGHT,
} from "../config";
import { mirrorChargeCameraPitch } from "../net/chargeAim";
import {
  ACCENT_DEATH_PALE,
  ACCENT_DEATH_RED,
  ACCENT_DEATH_WHITE,
  BASE_BG,
  HL_CHARTREUSE,
  SCENE_COOL_FILL,
  SCENE_DAWN_FILL,
  SCENE_DAWN_KEY,
  SCENE_DAY_FILL,
  SCENE_DAY_KEY,
  SCENE_SUNSET_FILL,
  SCENE_SUNSET_KEY,
  SCENE_WARM_LIGHT,
  SKY_DAWN_BG,
  SKY_DAWN_FOG,
  SKY_CLOUD_DAY,
  SKY_CLOUD_SUNSET,
  SKY_DAY_BG,
  SKY_DAY_FOG,
  SKY_SUN_DISC,
  SKY_SUNSET_DISC,
  SKY_SUNSET_BG,
  SKY_SUNSET_FOG,
} from "../palette";
import {
  FIREFLY_BLINK,
  FIREFLY_OPACITY,
  FIREFLY_WANDER,
} from "../fx/Fireflies";
import { SceneManager } from "./SceneManager";

const FRAME = 1 / 60;
const NO_MOVE = { x: 0, y: 0 };
const NO_LOOK = { dx: 0, dy: 0 };

const managers: SceneManager[] = [];

function readLightingChannels(scene: THREE.Scene): number[] {
  const ambient = scene.children.find((child): child is THREE.AmbientLight => child instanceof THREE.AmbientLight)!;
  const key = scene.children.find((child): child is THREE.DirectionalLight => child instanceof THREE.DirectionalLight)!;
  return [
    ...(scene.background as THREE.Color).toArray(),
    ...(scene.fog as THREE.Fog).color.toArray(),
    ...ambient.color.toArray(),
    ...key.color.toArray(),
    ambient.intensity, key.intensity,
  ];
}

// Independent reference calculation for the owner's two samples of the old
// palette. THREE.Color interpolates linear RGB, not the encoded hex values.
function originalLightingAt(elapsed: 20 | 167.5, nightGain = 1.06 * 1.15): number[] {
  const day = elapsed === 20;
  const t = day ? (20 / 180) / 0.32 : ((167.5 / 180) - 0.68) / 0.32;
  const blend = 3 * t * t - 2 * t * t * t;
  const pairs = day
    ? [[SKY_DAWN_BG, SKY_DAY_BG], [SKY_DAWN_FOG, SKY_DAY_FOG],
      [SCENE_DAWN_FILL, SCENE_DAY_FILL], [SCENE_DAWN_KEY, SCENE_DAY_KEY]]
    : [[SKY_SUNSET_BG, BASE_BG], [SKY_SUNSET_FOG, BASE_BG],
      [SCENE_SUNSET_FILL, SCENE_COOL_FILL], [SCENE_SUNSET_KEY, SCENE_WARM_LIGHT]];
  const colors = pairs.flatMap(([from, to]) => new THREE.Color(from).lerp(new THREE.Color(to), blend).toArray());
  return [...colors,
    day ? 0.98 - 0.2 * blend : (0.49 - 0.18 * blend) * nightGain,
    day ? 1.28 + 0.35 * blend : (1.28 - 0.8 * blend) * nightGain];
}

function expectLightingClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 12));
}

async function createManager(): Promise<SceneManager> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const manager = new SceneManager(scene, camera);
  manager.build();
  const ready = await manager.initPhysics();
  expect(ready).toBe(true);
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0, managers.length)) {
    manager.dispose();
  }
});

describe("SceneManager camera clamp + wall fade", () => {
  it("clamps the follow camera within HALF+MARGIN", async () => {
    const manager = await createManager();
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    const camera = manager.debugGetCameraPosition();
    const limit = ARENA_HALF_SIZE + CAMERA_WALL_MARGIN;
    expect(Math.abs(camera.x)).toBeLessThanOrEqual(limit + 1e-6);
    expect(Math.abs(camera.z)).toBeLessThanOrEqual(limit + 1e-6);
  });

  it("keeps the camera fade range and reduces it when the enclosure occludes", async () => {
    expect(WALL_GLASS_OPACITY).toBe(0.2);
    expect(WALL_FADE_OPACITY).toBe(0.1);
    expect(WALL_FADE_OPACITY).toBeLessThanOrEqual(WALL_GLASS_OPACITY);
    const manager = await createManager();
    // Open arena center: upper fence at normal visibility.
    manager.teleportSelf(0, 0);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.getWallOpacity()).toBeCloseTo(WALL_GLASS_OPACITY, 10);
    // Corner: the raw follow position sits past the wall line, so the
    // camera clamps and the walls fade to the occlusion opacity. The follow
    // camera eases toward its target (CAMERA_SMOOTH_RATE), so pump frames
    // until the smoothed position converges past the wall line first.
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getWallOpacity()).toBeCloseTo(WALL_FADE_OPACITY, 10);
  });
});

describe("SceneManager enclosure, nebulae and fireflies", () => {
  async function createManagerWithScene(): Promise<{
    manager: SceneManager; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  }> {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
    const manager = new SceneManager(scene, camera);
    manager.build();
    const ready = await manager.initPhysics();
    expect(ready).toBe(true);
    managers.push(manager);
    return { manager, scene, camera };
  }

  it("starts with the former 2:40 look and one shadow key plus one ambient fill", async () => {
    const { scene } = await createManagerWithScene();
    const directional = scene.children.filter((child): child is THREE.DirectionalLight => child instanceof THREE.DirectionalLight);
    const ambient = scene.children.filter((child): child is THREE.AmbientLight => child instanceof THREE.AmbientLight);
    const spots = scene.children.filter((child): child is THREE.SpotLight => child instanceof THREE.SpotLight);
    expect(directional).toHaveLength(1);
    expect(ambient).toHaveLength(1);
    expect(spots).toHaveLength(0);
    expectLightingClose(readLightingChannels(scene), originalLightingAt(20));
    expect(directional[0]!.shadow.mapSize.x).toBeLessThanOrEqual(SHADOW_MAP_SIZE);
    expect(directional[0]!.shadow.mapSize.y).toBeLessThanOrEqual(SHADOW_MAP_SIZE);
  });

  it("fades the open wire enclosure by the camera while keeping its low board opaque", async () => {
    const { manager, scene } = await createManagerWithScene();
    const boards = scene.getObjectByName("sports-fence-boards") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const frame = scene.getObjectByName("sports-fence-frame") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const net = scene.getObjectByName("sports-fence-diamond-net") as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    expect(boards).toBeInstanceOf(THREE.Mesh);
    expect(frame).toBeInstanceOf(THREE.Mesh);
    expect(net).toBeInstanceOf(THREE.LineSegments);
    manager.teleportSelf(0, 0);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    for (const material of [frame.material, net.material]) {
      expect(material.opacity).toBe(1);
    }
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    for (let i = 0; i < 120; i += 1) manager.update(FRAME, NO_MOVE, NO_LOOK);
    for (const material of [frame.material, net.material]) {
      expect(material.opacity).toBeCloseTo(WALL_FADE_OPACITY / WALL_GLASS_OPACITY, 10);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
    expect(boards.material.transparent).toBe(false);
    expect(boards.material.opacity).toBe(1);
    manager.teleportSelf(0, 0);
    for (let i = 0; i < 120; i += 1) manager.update(FRAME, NO_MOVE, NO_LOOK);
    for (const material of [frame.material, net.material]) expect(material.opacity).toBe(1);
    expect(boards.material.opacity).toBe(1);
  });

  it("hangs 3 additive nebula sprites behind/above the walls (no new lights)", async () => {
    expect(NEBULA_COUNT).toBe(3);
    const { scene } = await createManagerWithScene();
    const nebulae: THREE.Sprite[] = [];
    scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Sprite && child.name.startsWith("nebula-")) {
        nebulae.push(child);
      }
    });
    expect(nebulae).toHaveLength(NEBULA_COUNT);
    for (const sprite of nebulae) {
      const material = sprite.material as THREE.SpriteMaterial;
      expect(material.blending).toBe(THREE.AdditiveBlending);
      expect(material.opacity).toBeLessThanOrEqual(0.22);
      expect(material.depthWrite).toBe(false);
      expect(material.fog).toBe(false);
      // Outside the arena: seen through the open wire enclosure.
      expect(Math.max(Math.abs(sprite.position.x), Math.abs(sprite.position.z))).toBeGreaterThan(
        ARENA_HALF_SIZE,
      );
      expect(sprite.position.y).toBeGreaterThan(WALL_HEIGHT);
      // Cheap procedural textures only (<= 256px, no asset files).
      const map = material.map;
      expect(map).not.toBe(null);
      const width = (map?.image as { width?: number } | undefined)?.width ?? 0;
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(256);
    }
    // One directional and one ambient light throughout the cycle.
    const lights: THREE.Light[] = [];
    scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Light) {
        lights.push(child);
      }
    });
    expect(lights).toHaveLength(2);
  });

  it("holds the former day through 1:15 and the brighter moonlit night from 1:00", async () => {
    const { manager, scene } = await createManagerWithScene();
    const background = scene.background;
    const fog = scene.fog;
    const lights = scene.children.filter((child) => child instanceof THREE.Light);
    const stars = scene.getObjectByName("stars") as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    const dayChannels = readLightingChannels(scene);
    for (const elapsed of [0, 20, 57.6, 90, 104.999, 105]) {
      manager.setDayProgress(elapsed / 180);
      expectLightingClose(readLightingChannels(scene), originalLightingAt(20));
      expect(readLightingChannels(scene)).toEqual(dayChannels);
      expect(stars.material.opacity).toBe(0);
    }

    manager.setDayProgress(112.5 / 180);
    const ambient = lights.find((child): child is THREE.AmbientLight => child instanceof THREE.AmbientLight)!;
    const key = lights.find((child): child is THREE.DirectionalLight => child instanceof THREE.DirectionalLight)!;
    expect((background as THREE.Color).getHex()).toBe(SKY_SUNSET_BG);
    expect((fog as THREE.Fog).color.getHex()).toBe(SKY_SUNSET_FOG);
    expect(ambient.color.getHex()).toBe(SCENE_SUNSET_FILL);
    expect(key.color.getHex()).toBe(SCENE_SUNSET_KEY);
    expect(ambient.intensity).toBe(0.49);
    expect(key.intensity).toBe(1.28);

    manager.setDayProgress(120 / 180);
    const nightChannels = readLightingChannels(scene);
    for (const elapsed of [120, 125, 150, 165, 167.5, 170, 180]) {
      manager.setDayProgress(elapsed / 180);
      expectLightingClose(readLightingChannels(scene), originalLightingAt(167.5));
      expect(readLightingChannels(scene)).toEqual(nightChannels);
      expect(stars.material.opacity).toBeGreaterThan(0.85);
    }
    expect(scene.background).toBe(background);
    expect(scene.fog).toBe(fog);
    expect(scene.children.filter((child) => child instanceof THREE.Light)).toEqual(lights);
    manager.setDayProgress(0);
    expect(readLightingChannels(scene)).toEqual(dayChannels);
    expect(stars.material.opacity).toBe(0);
  });

  it("increases only night illumination by 15% relative to the accepted 6% night lift", async () => {
    const { manager, scene } = await createManagerWithScene();
    const acceptedNight = originalLightingAt(167.5, 1.06);
    for (const elapsed of [120, 150, 180]) {
      manager.setDayProgress(elapsed / 180);
      const current = readLightingChannels(scene);
      expectLightingClose(current.slice(0, 12), acceptedNight.slice(0, 12));
      expect(current[12]! / acceptedNight[12]!).toBeCloseTo(1.15, 12);
      expect(current[13]! / acceptedNight[13]!).toBeCloseTo(1.15, 12);
    }
    for (const elapsed of [0, 60, 105]) {
      manager.setDayProgress(elapsed / 180);
      expectLightingClose(readLightingChannels(scene), originalLightingAt(20));
    }
  });

  it("dims through the 15-second transition without a noon flash and has soft continuous edges", async () => {
    const { manager, scene } = await createManagerWithScene();
    manager.setDayProgress(105 / 180);
    let previous = readLightingChannels(scene);
    let previousBrightness = previous[12]! + previous[13]!;
    let previousSkyBrightness = 0.2126 * previous[0]! + 0.7152 * previous[1]! + 0.0722 * previous[2]!;
    for (let elapsed = 105.25; elapsed <= 120; elapsed += 0.25) {
      manager.setDayProgress(elapsed / 180);
      const current = readLightingChannels(scene);
      const brightness = current[12]! + current[13]!;
      const skyBrightness = 0.2126 * current[0]! + 0.7152 * current[1]! + 0.0722 * current[2]!;
      expect(brightness).toBeLessThan(previousBrightness);
      expect(skyBrightness).toBeLessThan(previousSkyBrightness);
      expect(Math.max(...current.map((value, i) => Math.abs(value - previous[i]!)))).toBeLessThan(0.055);
      previous = current;
      previousBrightness = brightness;
      previousSkyBrightness = skyBrightness;
    }
    const sample = (elapsed: number): number[] => {
      manager.setDayProgress(elapsed / 180);
      return readLightingChannels(scene);
    };
    const distance = (a: number[], b: number[]): number => Math.max(...a.map((value, i) => Math.abs(value - b[i]!)));
    for (const edge of [105, 112.5, 120]) {
      expect(distance(sample(edge - 0.001), sample(edge + 0.001))).toBeLessThan(0.000001);
      // The slope approaches zero at the start, warm-sunset join and end.
      for (const direction of [-1, 1]) {
        const closeChange = distance(sample(edge), sample(edge + direction * 0.01));
        const fartherChange = distance(sample(edge), sample(edge + direction * 0.1));
        expect(closeChange).toBeLessThanOrEqual(fartherChange * 0.02 + 1e-12);
      }
    }
  });

  it("grades one cheap world-up sky from a pale green/blue horizon to a cold blue zenith", async () => {
    const { manager, scene, camera } = await createManagerWithScene();
    const sky = scene.getObjectByName("sky-gradient") as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
    expect(sky.geometry.parameters.radius).toBeLessThan(camera.far);
    expect(sky.geometry.index!.count / 3).toBeLessThanOrEqual(440);
    expect(sky.material.side).toBe(THREE.BackSide);
    expect(sky.material.transparent).toBe(false);
    expect(sky.material.depthTest).toBe(false);
    expect(sky.material.depthWrite).toBe(false);
    expect(sky.material.fog).toBe(false);
    expect(sky.material.toneMapped).toBe(false);
    expect(sky.castShadow).toBe(false);
    expect(sky.receiveShadow).toBe(false);
    expect(sky.frustumCulled).toBe(false);
    expect(sky.renderOrder).toBeLessThan(0);
    expect(scene.children.filter((child) => child instanceof THREE.Light)).toHaveLength(2);
    expect(sky.material.vertexShader).toContain("(modelMatrix * vec4(position, 0.0)).xyz");
    expect(sky.material.fragmentShader).toContain("normalize(vSkyDirection).y");
    expect(sky.material.fragmentShader).toContain("mix(skyHorizon, skyZenith, elevation)");
    expect(sky.material.fragmentShader).toContain("#include <colorspace_fragment>");

    const horizon = sky.material.uniforms.skyHorizon!.value as THREE.Color;
    const zenith = sky.material.uniforms.skyZenith!.value as THREE.Color;
    const expectedHorizon = new THREE.Color().fromArray(originalLightingAt(20).slice(3, 6))
      .lerp(new THREE.Color(0xacdcd2), 0.4);
    expect(horizon.toArray()).toEqual(expectedHorizon.toArray());
    expect(zenith.getHex()).toBe(0x548dce);
    expect(horizon.g).toBeGreaterThan(horizon.r);
    expect(horizon.g / horizon.b).toBeGreaterThan(0.9);
    expect(horizon.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(zenith.getHSL({ h: 0, s: 0, l: 0 }).l);
    expect(zenith.b).toBeGreaterThan(zenith.g);
    expect(zenith.g).toBeGreaterThan(zenith.r);

    const invokeBeforeRender = (activeCamera: THREE.Camera): void => sky.onBeforeRender(
      {} as THREE.WebGLRenderer, scene, activeCamera, sky.geometry, sky.material, new THREE.Group(),
    );
    // The active render camera may be parented or differ from the gameplay
    // camera. Its translated/rotated view must not tilt or shift the horizon.
    const cameraParent = new THREE.Group();
    const activeCamera = new THREE.PerspectiveCamera();
    cameraParent.position.set(15, 6, -9);
    cameraParent.rotation.set(0.1, 0.5, 0.2);
    activeCamera.position.set(2, 3, 4);
    cameraParent.add(activeCamera);
    cameraParent.updateMatrixWorld(true);
    invokeBeforeRender(activeCamera);
    const cameraWorld = activeCamera.getWorldPosition(new THREE.Vector3());
    expect(sky.getWorldPosition(new THREE.Vector3()).distanceTo(cameraWorld)).toBeLessThan(1e-12);
    const zenithDirection = new THREE.Vector3(0, 1, 0).transformDirection(sky.matrixWorld);
    expect(zenithDirection.toArray()).toEqual([0, 1, 0]);
    activeCamera.rotation.set(0.8, -1.1, 0.4);
    activeCamera.position.add(new THREE.Vector3(-30, 7, 16));
    cameraParent.updateMatrixWorld(true);
    invokeBeforeRender(activeCamera);
    expect(sky.getWorldPosition(new THREE.Vector3()).distanceTo(activeCamera.getWorldPosition(cameraWorld))).toBeLessThan(1e-12);
    expect(new THREE.Vector3(0, 1, 0).transformDirection(sky.matrixWorld).toArray()).toEqual(zenithDirection.toArray());
    expect(sky.quaternion.equals(new THREE.Quaternion())).toBe(true);
    manager.setDayProgress(1);
    expect(sky.material.uniforms.skyHorizon!.value).toBe(horizon);
    expect(sky.material.uniforms.skyZenith!.value).toBe(zenith);
    expect(horizon.equals(scene.background as THREE.Color)).toBe(true);
    expect(zenith.equals(scene.background as THREE.Color)).toBe(true);
  });

  it("smoothly blends the gradient through the same sunset/night anchors and resets day", async () => {
    const { manager, scene } = await createManagerWithScene();
    const sky = scene.getObjectByName("sky-gradient") as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
    const sample = (elapsed: number): number[] => {
      manager.setDayProgress(elapsed / 180);
      return [
        ...(sky.material.uniforms.skyHorizon!.value as THREE.Color).toArray(),
        ...(sky.material.uniforms.skyZenith!.value as THREE.Color).toArray(),
      ];
    };
    const day = sample(0);
    for (const elapsed of [20, 90, 105]) expect(sample(elapsed)).toEqual(day);
    const sunset = sample(112.5);
    expectLightingClose(sunset, [
      ...new THREE.Color(SKY_SUNSET_FOG).toArray(),
      ...new THREE.Color(SKY_SUNSET_BG).toArray(),
    ]);
    const night = sample(120);
    for (const elapsed of [123, 150, 180]) expect(sample(elapsed)).toEqual(night);
    const distance = (a: number[], b: number[]): number => Math.max(...a.map((value, i) => Math.abs(value - b[i]!)));
    for (const edge of [105, 112.5, 120]) {
      expect(distance(sample(edge - 0.001), sample(edge + 0.001))).toBeLessThan(1e-6);
      for (const direction of [-1, 1]) {
        const near = distance(sample(edge), sample(edge + direction * 0.01));
        const farther = distance(sample(edge), sample(edge + direction * 0.1));
        expect(near).toBeLessThanOrEqual(farther * 0.02 + 1e-12);
      }
    }
    let previous = sample(105);
    for (let elapsed = 105.25; elapsed <= 120; elapsed += 0.25) {
      const current = sample(elapsed);
      expect(distance(current, previous)).toBeLessThan(0.055);
      previous = current;
    }
    expect(sample(0)).toEqual(day);
  });

  it("orbits above the arena while grading holds, with the moon following the same tilted circle", async () => {
    const { manager, scene } = await createManagerWithScene();
    const sun = scene.getObjectByName("sun") as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
    const moon = scene.getObjectByName("moon") as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
    const key = scene.children.find((child): child is THREE.DirectionalLight => child instanceof THREE.DirectionalLight)!;
    const startSun = sun.position.clone();
    expect(sun.geometry.parameters.radius / 2.8).toBe(0.5);
    expect(moon.geometry.parameters.radius / 3).toBeCloseTo(0.7, 12);
    expect(sun.material.color.getHex()).toBe(SKY_SUN_DISC);
    expect(sun.material.opacity).toBeGreaterThan(0.9);
    expect(startSun.x).toBeLessThan(-50);
    expect(startSun.y).toBeGreaterThan(4);
    expect(startSun.y).toBeLessThan(5);
    expect(moon.visible).toBe(false);
    expect(key.position.x).toBeLessThan(0);

    const dayLighting = readLightingChannels(scene);
    manager.setDayProgress(60 / 180);
    expect(readLightingChannels(scene)).toEqual(dayLighting);
    expect(sun.position.distanceTo(startSun)).toBeGreaterThan(75);
    expect(sun.position.y).toBeGreaterThan(23);
    expect(sun.position.y).toBeLessThan(25);
    expect(Math.hypot(sun.position.x, sun.position.z)).toBeGreaterThan(48);
    expect(sun.material.opacity).toBeGreaterThan(0.9);
    manager.setDayProgress(105 / 180);
    expect(sun.position.x).toBeGreaterThan(50);
    expect(sun.position.y).toBeGreaterThan(7);
    expect(sun.position.y).toBeLessThan(9);
    expect(moon.visible).toBe(false);
    manager.setDayProgress(112.5 / 180);
    expect(sun.material.color.getHex()).toBe(SKY_SUNSET_DISC);
    expect(sun.visible).toBe(true);
    expect(moon.visible).toBe(true);
    expect(key.position.x).toBeGreaterThan(0);

    // The moon reaches precisely the sun's earlier world positions after
    // the same time offset: both use one actual circle, not parallel paths.
    for (const elapsed of [0, 30, 60]) {
      manager.setDayProgress(elapsed / 180);
      const sunPosition = sun.position.clone();
      manager.setDayProgress((elapsed + 112.8) / 180);
      expect(moon.position.distanceTo(sunPosition)).toBeLessThan(1e-12);
    }
    const center = new THREE.Vector3(0, 2, 0);
    for (let elapsed = 0; elapsed <= 180; elapsed += 1) {
      manager.setDayProgress(elapsed / 180);
      for (const disc of [sun, moon]) {
        expect(disc.position.distanceTo(center)).toBeCloseTo(54, 10);
        const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(disc.quaternion);
        const towardArena = center.clone().sub(disc.position).normalize();
        expect(facing.dot(towardArena)).toBeCloseTo(1, 10);
        expect(disc.material.side).toBe(THREE.DoubleSide);
        expect(disc.material.forceSinglePass).toBe(true);
      }
    }

    manager.setDayProgress(120 / 180);
    expect(sun.visible).toBe(false);
    const nightLighting = readLightingChannels(scene);
    const nightMoon = moon.position.clone();
    manager.setDayProgress(150 / 180);
    expect(readLightingChannels(scene)).toEqual(nightLighting);
    expect(moon.position.distanceTo(nightMoon)).toBeGreaterThan(40);
    expect(moon.position.y).toBeGreaterThan(21);
    expect(moon.position.y).toBeLessThan(23);
    const midNightMoon = moon.position.clone();
    manager.setDayProgress(1);
    expect(readLightingChannels(scene)).toEqual(nightLighting);
    expect(moon.position.distanceTo(midNightMoon)).toBeGreaterThan(40);
    expect(moon.position.y).toBeGreaterThan(22);
    expect(moon.position.y).toBeLessThan(24);
    expect(moon.material.opacity).toBeCloseTo(0.92);
    expect(moon.visible).toBe(true);

    expect(scene.children.filter((child) => child instanceof THREE.Light)).toHaveLength(2);
    manager.setDayProgress(0);
    expect(sun.visible).toBe(true);
    expect(moon.visible).toBe(false);
    expect(sun.position.equals(startSun)).toBe(true);
  });

  it("shows the visible sun and final-minute moon through the actual allowed gameplay camera", async () => {
    const { manager, scene, camera } = await createManagerWithScene();
    camera.aspect = 9 / 16;
    camera.updateProjectionMatrix();
    const sun = scene.getObjectByName("sun") as THREE.Mesh;
    const moon = scene.getObjectByName("moon") as THREE.Mesh;
    const observe = (disc: THREE.Mesh, elapsed: number, x: number, z: number): THREE.Vector3 => {
      manager.setDayProgress(elapsed / 180);
      const yaw = Math.atan2(x - disc.position.x, z - disc.position.z);
      manager.setCameraAngles(yaw, CAMERA_PITCH_MIN);
      // The real update owns the camera position, smoothing and avatar look
      // target. No direct lookAt or extra pitch range can bypass its limits.
      for (let frame = 0; frame < 40; frame += 1) manager.update(FRAME, NO_MOVE, NO_LOOK);
      expect(manager.getCameraAngles().pitch).toBe(CAMERA_PITCH_MIN);
      expect(manager.isSpectating()).toBe(false);
      camera.updateMatrixWorld(true);
      return disc.position.clone().project(camera);
    };
    const inView = (p: THREE.Vector3): boolean => Math.abs(p.x) < 1
      && Math.abs(p.y) < 1 && p.z > -1 && p.z < 1;

    manager.teleportSelf(0, 0);
    let visibleSunSamples = 0;
    let visibleMoonSamples = 0;
    for (let elapsed = 0; elapsed <= 180; elapsed += 1) {
      manager.setDayProgress(elapsed / 180);
      for (const disc of [sun, moon]) {
        if (!disc.visible) continue;
        expect(inView(observe(disc, elapsed, 0, 0))).toBe(true);
        if (disc === sun) visibleSunSamples += 1;
        if (disc === moon) visibleMoonSamples += 1;
      }
    }
    expect(visibleSunSamples).toBeGreaterThan(110);
    expect(visibleMoonSamples).toBeGreaterThan(60);

    // Ground views on both sides of the arena still reveal the movement.
    // Near-edge parallax may lift an apex above the allowed view, so these
    // samples require broad coverage without promising every edge frame.
    for (const [x, z] of [[-12, 12], [12, 12], [0, -10]]) {
      manager.teleportSelf(x!, z!);
      let observations = 0;
      for (const [disc, elapsed] of [[sun, 20], [sun, 35], [sun, 50], [sun, 105],
        [moon, 120], [moon, 150], [moon, 180]] as const) {
        if (inView(observe(disc, elapsed, x!, z!))) observations += 1;
      }
      expect(observations).toBeGreaterThanOrEqual(5);
    }
  });

  it("keeps orbital motion continuous across grading boundaries instead of freezing at night", async () => {
    const { manager, scene } = await createManagerWithScene();
    for (const name of ["sun", "moon"]) {
      const disc = scene.getObjectByName(name) as THREE.Mesh;
      for (const edge of [105, 112.5, 120, 150]) {
        manager.setDayProgress((edge - 0.001) / 180);
        const before = disc.position.clone();
        manager.setDayProgress((edge + 0.001) / 180);
        expect(disc.position.distanceTo(before)).toBeLessThan(0.003);
        if (name === "sun" || edge > 108) {
          expect(disc.position.distanceTo(before)).toBeGreaterThan(0.0028);
        }
      }
    }
  });

  it("uses one small batch of diffuse asymmetric cloud patches with uneven spacing and fades it by night", async () => {
    const { manager, scene, camera } = await createManagerWithScene();
    const clouds = scene.getObjectByName("day-clouds") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    expect(clouds).toBeInstanceOf(THREE.InstancedMesh);
    expect(clouds.count).toBeLessThanOrEqual(10);
    expect(clouds.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(clouds.geometry.index?.count).toBe(6);
    expect(clouds.material.side).toBe(THREE.FrontSide);
    const cloudMap = clouds.material.map as THREE.DataTexture;
    expect(cloudMap).toBeInstanceOf(THREE.DataTexture);
    const image = cloudMap.image as { data: Uint8Array; width: number; height: number };
    expect(image.width).toBe(128);
    expect(image.height).toBe(128);
    const alphaAt = (x: number, y: number): number => image.data[(y * image.width + x) * 4 + 3] ?? 0;
    const variants: number[][] = [];
    const thicknesses: number[] = [];
    const peaks: number[] = [];
    for (let variant = 0; variant < 4; variant += 1) {
      const offsetX = (variant % 2) * 64;
      const offsetY = Math.floor(variant / 2) * 64;
      const alphas: number[] = [];
      let mirrorDifference = 0;
      let diffusePixels = 0;
      let occupiedWidth = 0;
      let occupiedHeight = 0;
      for (let y = 0; y < 64; y += 1) {
        if (Array.from({ length: 64 }, (_, x) => alphaAt(offsetX + x, offsetY + y)).some((a) => a > 35)) occupiedHeight += 1;
        for (let x = 0; x < 64; x += 1) {
          const alpha = alphaAt(offsetX + x, offsetY + y);
          alphas.push(alpha);
          if (alpha > 0 && alpha < 80) diffusePixels += 1;
          mirrorDifference += Math.abs(alpha - alphaAt(offsetX + 63 - x, offsetY + y));
          if (x < 2 || x > 61 || y < 2 || y > 61) expect(alpha).toBe(0);
        }
      }
      for (let x = 0; x < 64; x += 1) {
        if (Array.from({ length: 64 }, (_, y) => alphaAt(offsetX + x, offsetY + y)).some((a) => a > 35)) occupiedWidth += 1;
      }
      expect(Math.max(...alphas)).toBeGreaterThan(80);
      expect(Math.max(...alphas)).toBeLessThan(220);
      expect(diffusePixels).toBeGreaterThan(500);
      expect(mirrorDifference / alphas.length).toBeGreaterThan(5);
      expect(occupiedWidth).toBeGreaterThan(occupiedHeight * 1.2);
      variants.push(alphas);
      thicknesses.push(occupiedHeight);
      peaks.push(Math.max(...alphas));
    }
    expect(new Set(variants.map((v) => v.join(","))).size).toBe(4);
    // Both broad banks must differ visibly from both thin wisps, rather
    // than relying on four almost identical textures with different seeds.
    expect(Math.min(thicknesses[1]!, thicknesses[2]!)).toBeGreaterThan(Math.max(thicknesses[0]!, thicknesses[3]!) * 1.4);
    expect(Math.min(peaks[1]!, peaks[2]!)).toBeGreaterThan(Math.max(peaks[0]!, peaks[3]!) * 1.3);
    expect(clouds.material.fog).toBe(false);
    expect(clouds.material.depthWrite).toBe(false);
    expect(clouds.material.color.getHex()).toBe(SKY_CLOUD_DAY);
    const cloudMatrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const positions: THREE.Vector3[] = [];
    for (let i = 0; i < clouds.count; i += 1) {
      clouds.getMatrixAt(i, cloudMatrix);
      cloudMatrix.decompose(position, rotation, scale);
      expect(position.y).toBeGreaterThan(WALL_HEIGHT);
      expect(Math.hypot(position.x, position.z)).toBeGreaterThan(ARENA_HALF_SIZE);
      expect(scale.x / scale.y).toBeGreaterThan(1);
      expect(scale.x / scale.y).toBeLessThan(2.5);
      const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      expect(facing.dot(new THREE.Vector3(0, 2, 0).sub(position).normalize())).toBeCloseTo(1, 6);
      positions.push(position.clone());
    }
    expect(Math.max(...positions.map((p) => p.y)) - Math.min(...positions.map((p) => p.y))).toBeGreaterThan(25);
    expect(Math.max(...positions.map((p) => Math.hypot(p.x, p.z)))
      - Math.min(...positions.map((p) => Math.hypot(p.x, p.z)))).toBeGreaterThan(30);
    expect(positions.some((p) => p.x > 50)).toBe(true);
    expect(positions.some((p) => p.x < -50)).toBe(true);
    expect(positions.some((p) => p.z > 50)).toBe(true);
    expect(positions.some((p) => p.z < -50)).toBe(true);
    const angles = positions.map((p) => Math.atan2(p.x, p.z)).sort((a, b) => a - b);
    const gaps = angles.map((angle, i) => (angles[(i + 1) % angles.length]! - angle + Math.PI * 2) % (Math.PI * 2));
    expect(Math.max(...gaps)).toBeGreaterThan(Math.min(...gaps) * 4);
    const uvOffsets = clouds.geometry.getAttribute("cloudUvOffset") as THREE.InstancedBufferAttribute;
    expect(uvOffsets.isInstancedBufferAttribute).toBe(true);
    expect(uvOffsets.count).toBe(clouds.count);
    expect(new Set(Array.from({ length: clouds.count }, (_, i) => `${uvOffsets.getX(i)},${uvOffsets.getY(i)}`)).size).toBe(4);

    camera.aspect = 9 / 16;
    camera.updateProjectionMatrix();
    // Use the real follow-camera pitch at four yaw directions, then its
    // raised viewing pitch at diagonals. Cloud centers must be in front
    // of the camera as well as inside the portrait viewport.
    let viewsWithClouds = 0;
    for (const [yaw, pitch] of [[0, CAMERA_REST_PITCH], [Math.PI / 2, CAMERA_REST_PITCH],
      [Math.PI, CAMERA_REST_PITCH], [-Math.PI / 2, CAMERA_REST_PITCH],
      [Math.PI / 4, CAMERA_PITCH_MIN], [3 * Math.PI / 4, CAMERA_PITCH_MIN],
      [-Math.PI / 4, CAMERA_PITCH_MIN], [-3 * Math.PI / 4, CAMERA_PITCH_MIN]]) {
      const horizontal = Math.cos(pitch!) * CAMERA_FOLLOW_DISTANCE;
      camera.position.set(Math.sin(yaw!) * horizontal,
        1.1 + CAMERA_FOLLOW_HEIGHT + Math.sin(pitch!) * CAMERA_FOLLOW_DISTANCE,
        Math.cos(yaw!) * horizontal);
      camera.lookAt(0, CAMERA_LOOK_AT_HEIGHT, 0);
      camera.updateMatrixWorld(true);
      const inView = positions.map((p) => p.clone().project(camera))
        .filter((p) => Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z > -1 && p.z < 1);
      if (inView.length > 0) viewsWithClouds += 1;
      if (pitch === CAMERA_REST_PITCH) expect(inView.length).toBeGreaterThan(0);
      if (yaw === 0 && pitch === CAMERA_REST_PITCH) {
        expect(inView.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...inView.map((p) => p.y)) - Math.min(...inView.map((p) => p.y))).toBeGreaterThan(0.1);
      }
    }
    expect(viewsWithClouds).toBeGreaterThanOrEqual(6);
    const dayOpacity = clouds.material.opacity;
    manager.setDayProgress(60 / 180);
    expect(clouds.material.opacity).toBeGreaterThan(dayOpacity);
    manager.setDayProgress(112.5 / 180);
    expect(clouds.material.color.getHex()).toBe(SKY_CLOUD_SUNSET);
    expect(clouds.material.opacity).toBeGreaterThan(0);
    manager.setDayProgress(120 / 180);
    expect(clouds.material.opacity).toBe(0);
    expect(clouds.visible).toBe(false);
    manager.setDayProgress(0);
    expect(clouds.visible).toBe(true);
    expect(clouds.material.opacity).toBeCloseTo(dayOpacity);
  });

  it("maps four deterministic atlas patches through the installed basic shader in one cloud batch", async () => {
    const { manager, scene } = await createManagerWithScene();
    const { scene: secondScene } = await createManagerWithScene();
    const clouds = scene.getObjectByName("day-clouds") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    const second = secondScene.getObjectByName("day-clouds") as typeof clouds;
    const image = (clouds.material.map as THREE.DataTexture).image as { data: Uint8Array };
    const secondImage = (second.material.map as THREE.DataTexture).image as { data: Uint8Array };
    expect(image.data).toEqual(secondImage.data);
    expect(clouds.instanceMatrix.array).toEqual(second.instanceMatrix.array);
    const uvOffsets = clouds.geometry.getAttribute("cloudUvOffset") as THREE.InstancedBufferAttribute;
    expect(uvOffsets.array).toEqual(second.geometry.getAttribute("cloudUvOffset").array);
    for (let i = 0; i < uvOffsets.count; i += 1) {
      expect([0, 0.5]).toContain(uvOffsets.getX(i));
      expect([0, 0.5]).toContain(uvOffsets.getY(i));
    }
    const shader = {
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
    } as Parameters<typeof clouds.material.onBeforeCompile>[0];
    clouds.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const vertex = shader.vertexShader
      .replace("#include <uv_pars_vertex>", THREE.ShaderChunk.uv_pars_vertex)
      .replace("#include <uv_vertex>", THREE.ShaderChunk.uv_vertex);
    expect(vertex).toContain("attribute vec2 cloudUvOffset;");
    expect(vertex).toContain("varying vec2 vMapUv;");
    expect(vertex).toContain("vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;");
    expect(vertex).toContain("vMapUv = vMapUv * 0.5 + cloudUvOffset;");
    expect(shader.fragmentShader).toBe(THREE.ShaderLib.basic.fragmentShader);
    expect(clouds.material.customProgramCacheKey()).toBe("cloud-atlas-v1");
    const instances = Array.from(clouds.instanceMatrix.array);
    manager.setDayProgress(60 / 180);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(Array.from(clouds.instanceMatrix.array)).toEqual(instances);
    expect(clouds.material.map).toBeInstanceOf(THREE.DataTexture);
  });

  it("turns shop porches on by real final-minute time and resets them for day", async () => {
    const porch = vi.spyOn(AdsManager.prototype, "setPorchLighting");
    try {
      const { manager } = await createManagerWithScene();
      expect(porch).toHaveBeenLastCalledWith(0);
      manager.setDayProgress(112.5 / 180);
      expect(porch).toHaveBeenLastCalledWith(0);
      manager.setDayProgress(119.999 / 180);
      expect(porch).toHaveBeenLastCalledWith(0);
      manager.setDayProgress(2 / 3);
      expect(porch).toHaveBeenLastCalledWith(0);
      manager.setDayProgress(0.685);
      const partial = porch.mock.lastCall?.[0] ?? 0;
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(1);
      manager.setDayProgress(0.72);
      expect(porch).toHaveBeenLastCalledWith(1);
      manager.setDayProgress(1);
      expect(porch).toHaveBeenLastCalledWith(1);
      manager.setDayProgress(0);
      expect(porch).toHaveBeenLastCalledWith(0);

      // A late join builds the shops at the already authoritative time.
      const late = new SceneManager(new THREE.Scene(), new THREE.PerspectiveCamera());
      late.setDayProgress(0.8);
      late.build();
      managers.push(late);
      expect(porch).toHaveBeenLastCalledWith(1);
    } finally {
      porch.mockRestore();
    }
  });

  it("restores lighting, sky and real-time firefly fades when time arrives before or after build", () => {
    const porch = vi.spyOn(AdsManager.prototype, "setPorchLighting");
    try {
      for (const elapsed of [0, 20, 105, 110, 112.5, 119, 120, 123, 167.5, 180]) {
        const lateScene = new THREE.Scene();
        const late = new SceneManager(lateScene, new THREE.PerspectiveCamera());
        const readyScene = new THREE.Scene();
        const ready = new SceneManager(readyScene, new THREE.PerspectiveCamera());
        managers.push(late, ready);
        ready.build();
        ready.setDayProgress(elapsed / 180);
        late.setDayProgress(elapsed / 180);
        late.build();
        expect(readLightingChannels(lateScene)).toEqual(readLightingChannels(readyScene));
        const lateSky = lateScene.getObjectByName("sky-gradient") as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
        const readySky = readyScene.getObjectByName("sky-gradient") as typeof lateSky;
        for (const uniform of ["skyHorizon", "skyZenith"]) {
          expect((lateSky.material.uniforms[uniform]!.value as THREE.Color).toArray())
            .toEqual((readySky.material.uniforms[uniform]!.value as THREE.Color).toArray());
        }
        for (const name of ["sun", "moon", "day-clouds", "stars", "fireflies"]) {
          const before = lateScene.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
          const after = readyScene.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
          expect(before.visible).toBe(after.visible);
          expect(before.position.equals(after.position)).toBe(true);
          expect(before.material.opacity).toBe(after.material.opacity);
        }
        // This expected fade is based on actual elapsed time, not sky progress.
        const fadeTime = Math.max(0, Math.min(1, (elapsed - 120) / 6.3));
        const fade = fadeTime * fadeTime * (3 - 2 * fadeTime);
        expect(porch).toHaveBeenLastCalledWith(expect.closeTo(fade, 12));
        const swarm = lateScene.getObjectByName("fireflies") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
        expect(swarm.visible).toBe(elapsed > 120);
        expect(swarm.material.opacity).toBeCloseTo(FIREFLY_OPACITY * fade, 12);
        if (elapsed <= 105) expectLightingClose(readLightingChannels(lateScene), originalLightingAt(20));
        if (elapsed >= 120) expectLightingClose(readLightingChannels(lateScene), originalLightingAt(167.5));

        // A new round restores the same day sample and hides every night effect.
        late.setDayProgress(0);
        expectLightingClose(readLightingChannels(lateScene), originalLightingAt(20));
        expect(swarm.visible).toBe(false);
        expect(swarm.material.opacity).toBe(0);
        expect(porch).toHaveBeenLastCalledWith(0);
        expect((lateScene.getObjectByName("moon") as THREE.Mesh).visible).toBe(false);
        const stars = lateScene.getObjectByName("stars") as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
        expect(stars.material.opacity).toBe(0);
      }
    } finally {
      porch.mockRestore();
    }
  });

  it("clamps out-of-range round time and handles invalid time as a day reset", async () => {
    const { manager, scene } = await createManagerWithScene();
    manager.setDayProgress(2);
    expectLightingClose(readLightingChannels(scene), originalLightingAt(167.5));
    for (const progress of [-1, Number.NaN, Infinity, -Infinity]) {
      manager.setDayProgress(1);
      manager.setDayProgress(progress);
      expectLightingClose(readLightingChannels(scene), originalLightingAt(20));
      expect((scene.getObjectByName("fireflies") as THREE.Mesh).visible).toBe(false);
    }
  });

  it("synchronizes trampoline spill and suburban windows to server time on late build and round reset", () => {
    const batches = [
      ["trampoline-night-rims", 0.92], ["trampoline-ground-spill", 0.14 * 1.30],
      ["trampoline-block-spill", 0.16 * 1.30], ["suburban-window-glow", 0.68],
    ] as const;
    for (const elapsed of [0, 105, 119.999, 120, 121, 123.15, 126.3, 180]) {
      const scene = new THREE.Scene();
      const manager = new SceneManager(scene, new THREE.PerspectiveCamera());
      managers.push(manager);
      manager.setDayProgress(elapsed / 180);
      manager.build();
      const time = Math.max(0, Math.min(1, (elapsed - 120) / 6.3));
      const fade = time * time * (3 - 2 * time);
      for (const [name, maximum] of batches) {
        const mesh = scene.getObjectByName(name) as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
        expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
        expect(mesh.visible).toBe(elapsed > 120);
        expect(mesh.material.opacity).toBeCloseTo(maximum * fade, 10);
      }
      let lights = 0;
      scene.traverse((object) => { if (object instanceof THREE.Light) lights += 1; });
      expect(lights).toBe(2);
      manager.setDayProgress(0);
      for (const [name] of batches) {
        const mesh = scene.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
        expect(mesh.visible).toBe(false);
        expect(mesh.material.opacity).toBe(0);
      }
    }
  });

  it("releases the gradient, both discs, the cloud batch and its shared texture with the scene", async () => {
    const { manager, scene } = await createManagerWithScene();
    const sun = scene.getObjectByName("sun") as THREE.Mesh;
    const clouds = scene.getObjectByName("day-clouds") as THREE.InstancedMesh;
    const moon = scene.getObjectByName("moon") as THREE.Mesh;
    const sky = scene.getObjectByName("sky-gradient") as THREE.Mesh;
    const skyGeometryDispose = vi.spyOn(sky.geometry, "dispose");
    const skyMaterialDispose = vi.spyOn(sky.material as THREE.Material, "dispose");
    const sunGeometryDispose = vi.spyOn(sun.geometry, "dispose");
    const sunMaterialDispose = vi.spyOn(sun.material as THREE.Material, "dispose");
    const cloudGeometryDispose = vi.spyOn(clouds.geometry, "dispose");
    const cloudMaterialDispose = vi.spyOn(clouds.material as THREE.Material, "dispose");
    const cloudBatchDispose = vi.spyOn(clouds, "dispose");
    const cloudTextureDispose = vi.spyOn((clouds.material as THREE.MeshBasicMaterial).map!, "dispose");
    const moonGeometryDispose = vi.spyOn(moon.geometry, "dispose");
    const moonMaterialDispose = vi.spyOn(moon.material as THREE.Material, "dispose");
    manager.dispose();
    expect(skyGeometryDispose).toHaveBeenCalledOnce();
    expect(skyMaterialDispose).toHaveBeenCalledOnce();
    expect(sunGeometryDispose).toHaveBeenCalledOnce();
    expect(sunMaterialDispose).toHaveBeenCalledOnce();
    expect(cloudGeometryDispose).toHaveBeenCalledOnce();
    expect(cloudMaterialDispose).toHaveBeenCalledOnce();
    expect(cloudBatchDispose).toHaveBeenCalledOnce();
    expect(cloudTextureDispose).toHaveBeenCalledOnce();
    expect(moonGeometryDispose).toHaveBeenCalledOnce();
    expect(moonMaterialDispose).toHaveBeenCalledOnce();
    expect(scene.getObjectByName("sun")).toBeUndefined();
    expect(scene.getObjectByName("day-clouds")).toBeUndefined();
    expect(scene.getObjectByName("moon")).toBeUndefined();
    expect(scene.getObjectByName("sky-gradient")).toBeUndefined();
  });

  it("reveals 6 fireflies with the final-minute shop lights, then resets them", async () => {
    // 4d.3 feedback round: 8 -> 6, base glow halved, blink + behaviors.
    expect(FIREFLY_COUNT).toBe(6);
    expect(FIREFLY_OPACITY).toBe(0.45);
    // Blink subset is strictly smaller than the swarm (never all at once);
    // both behavior classes ship (wander + hover).
    const blinkers = FIREFLY_BLINK.filter((capable) => capable === true);
    expect(blinkers.length).toBeGreaterThan(0);
    expect(blinkers.length).toBeLessThan(FIREFLY_COUNT);
    expect(FIREFLY_WANDER).toContain(true);
    expect(FIREFLY_WANDER).toContain(false);
    const { manager, scene } = await createManagerWithScene();
    const swarms: THREE.InstancedMesh[] = [];
    scene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.InstancedMesh && child.name === "fireflies") {
        swarms.push(child);
      }
    });
    expect(swarms).toHaveLength(1);
    const swarm = swarms[0];
    if (swarm === undefined) {
      return;
    }
    expect(swarm.count).toBe(FIREFLY_COUNT);
    expect(swarm.geometry instanceof THREE.PlaneGeometry).toBe(true);
    const material = swarm.material as THREE.MeshBasicMaterial;
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    expect(swarm.visible).toBe(false);
    expect(material.opacity).toBe(0);
    manager.setDayProgress(115 / 180);
    expect((scene.getObjectByName("moon") as THREE.Mesh).visible).toBe(true);
    expect((scene.getObjectByName("stars") as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>).material.opacity).toBeGreaterThan(0);
    expect(swarm.visible).toBe(false);
    manager.setDayProgress(119.999 / 180);
    expect(swarm.visible).toBe(false);
    manager.setDayProgress(2 / 3);
    expect(swarm.visible).toBe(false);
    manager.setDayProgress(0.685);
    expect(swarm.visible).toBe(true);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(FIREFLY_OPACITY);
    manager.setDayProgress(0.72);
    expect(material.opacity).toBeCloseTo(FIREFLY_OPACITY, 10);
    // Run frames so the billboard/bob update writes instance matrices, then
    // verify every firefly hovers above head height (~2.1 capsule top) and
    // inside the arena.
    manager.teleportSelf(0, 0);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      swarm.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(position.y).toBeGreaterThan(2.2);
      expect(position.y).toBeLessThan(4);
      expect(Math.abs(position.x)).toBeLessThan(ARENA_HALF_SIZE);
      expect(Math.abs(position.z)).toBeLessThan(ARENA_HALF_SIZE);
    }
    manager.setDayProgress(0);
    expect(swarm.visible).toBe(false);
    expect(material.opacity).toBe(0);
  });
});

describe("SceneManager local run trail", () => {
  it("keeps ordinary movement free of speed wind and stays hidden when spectating", async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
    const manager = new SceneManager(scene, camera);
    manager.build();
    expect(await manager.initPhysics()).toBe(true);
    managers.push(manager);
    manager.teleportSelf(0, 0);
    const trail = scene.getObjectByName("run-wind-trail");
    expect(trail?.visible).toBe(false);
    for (let frame = 0; frame < 20; frame += 1) {
      manager.update(FRAME, { x: 0, y: 1 }, NO_LOOK);
    }
    expect(trail?.visible).toBe(false);
    manager.setSpectating(true);
    expect(trail?.visible).toBe(false);
  });
});

describe("SceneManager death burst (80, palette + identity + chartreuse)", () => {
  it("spawns 80 pooled particles with the white/pale/red/identity/chartreuse split", async () => {
    expect(DEATH_BURST_COUNT).toBe(80);
    expect(DEATH_BURST_YELLOW).toBe(ACCENT_DEATH_WHITE);
    expect(DEATH_BURST_ORANGE).toBe(ACCENT_DEATH_PALE);
    expect(DEATH_BURST_RED).toBe(ACCENT_DEATH_RED);
    expect(DEATH_BURST_CHARTREUSE).toBe(HL_CHARTREUSE);
    expect(DEATH_BURST_SPREAD).toBe(4.5);
    expect(DEATH_BURST_UP).toBe(4.5);
    expect(DEATH_BURST_LIFE_S).toBe(0.9);
    // 10% cream / 30% pale amber / 15% identity / 5% lime of the
    // 80-burst, warm coral remainder.
    expect(Math.round(DEATH_BURST_COUNT * 0.1)).toBe(8);
    expect(Math.round(DEATH_BURST_COUNT * 0.3)).toBe(24);
    expect(Math.round(DEATH_BURST_COUNT * 0.15)).toBe(12);
    expect(Math.round(DEATH_BURST_COUNT * 0.05)).toBe(4);
    expect(DEATH_BURST_COUNT - 8 - 24 - 12 - 4).toBe(32);
    const manager = await createManager();
    expect(manager.getAliveParticleCount()).toBe(0);
    manager.spawnDeathBurst(0, 1.2, 0);
    expect(manager.getAliveParticleCount()).toBe(80);
  });

  it("tints the identity chunk with the victim color, stays unconfusable with hit blood", async () => {
    // A custom victim color still pops the full 80-burst (identity chunk
    // tinted, not resized), and the burst dwarfs the 16-particle all-red
    // hit-blood burst it must never read as.
    expect(BLOOD_BURST_COUNT).toBe(16);
    expect(DEATH_BURST_COUNT).toBeGreaterThan(BLOOD_BURST_COUNT * 2);
    const manager = await createManager();
    expect(manager.getAliveParticleCount()).toBe(0);
    manager.spawnDeathBurst(0, 1.2, 0, 0x9a5fd0);
    expect(manager.getAliveParticleCount()).toBe(80);
  });

  it("ignores non-finite death positions (no phantom bursts)", async () => {
    const manager = await createManager();
    expect(manager.getAliveParticleCount()).toBe(0);
    manager.spawnDeathBurst(Number.NaN, 1.2, 0);
    manager.spawnDeathBurst(0, Number.NaN, 0);
    manager.spawnDeathBurst(0, 1.2, Number.POSITIVE_INFINITY);
    expect(manager.getAliveParticleCount()).toBe(0);
  });
});

describe("SceneManager ball-hit blood burst (red only on player damage)", () => {
  it("notifyBallHit pops BLOOD_BURST_COUNT red particles (SUPER: full burst)", async () => {
    expect(BLOOD_BURST_COUNT).toBe(16);
    const manager = await createManager();
    expect(manager.getAliveParticleCount()).toBe(0);
    manager.notifyBallHit("b1", 0, 1.2, 0, false);
    expect(manager.getAliveParticleCount()).toBe(BLOOD_BURST_COUNT);
    manager.notifyBallHit("b2", 1, 1.4, 2, true);
    expect(manager.getAliveParticleCount()).toBe(BLOOD_BURST_COUNT + PARTICLE_BURST_COUNT);
  });

  it("ignores non-finite hit positions (no phantom bursts)", async () => {
    const manager = await createManager();
    expect(manager.getAliveParticleCount()).toBe(0);
    manager.notifyBallHit("b1", Number.NaN, 1.2, 0, false);
    manager.notifyBallHit("b2", 0, Number.NaN, 0, false);
    manager.notifyBallHit("b3", 0, 1.2, Number.POSITIVE_INFINITY, true);
    expect(manager.getAliveParticleCount()).toBe(0);
  });
});

describe("SceneManager recoil kick (opposite fire dir, clamped)", () => {
  it("nudges the avatar opposite the fire dir by the full 0.8m", async () => {
    expect(RECOIL_FULL_M).toBe(0.8);
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    // yaw 0 fires toward -Z, so the kick must push +Z with x unchanged.
    manager.setAimAngles(0, 0.25);
    manager.applyRecoilKick(1.0);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(0, 5);
    expect(after.z).toBeCloseTo(RECOIL_FULL_M, 4);
  });

  it("clamps the kick to the arena bounds", async () => {
    const manager = await createManager();
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    manager.setAimAngles(0, 0.25);
    manager.applyRecoilKick(1.0);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeLessThanOrEqual(ARENA_HALF_SIZE + 1e-6);
    expect(after.z).toBeLessThanOrEqual(ARENA_HALF_SIZE + 1e-6);
  });
});

describe("SceneManager charge zoom (4m default, ~3.2m held until shot)", () => {
  it("defaults to 4m, eases to ~3.2m at full charge, back to 4m after", async () => {
    expect(CAMERA_FOLLOW_DISTANCE).toBe(4);
    expect(CAMERA_CHARGE_DISTANCE).toBe(3.2);
    const manager = await createManager();
    expect(manager.getCameraDistance()).toBe(4);
    manager.setChargeZoom01(1);
    for (let i = 0; i < 240; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getCameraDistance()).toBeCloseTo(CAMERA_CHARGE_DISTANCE, 2);
    // Held until the shot: aim/camera moves mid-charge never reset it.
    manager.setCameraAngles(1.2, 0.4);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.getCameraDistance()).toBeCloseTo(CAMERA_CHARGE_DISTANCE, 2);
    // After the actual shot (or cancel) it eases back to default.
    manager.setChargeZoom01(0);
    for (let i = 0; i < 240; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getCameraDistance()).toBeCloseTo(CAMERA_FOLLOW_DISTANCE, 2);
  });
});

describe("SceneManager charge translucency (local avatar only)", () => {  it("fades body + hand ball to ~0.3 while active, restores to 1 after", async () => {
    expect(AVATAR_CHARGE_OPACITY).toBe(0.3);
    const manager = await createManager();
    expect(manager.getAvatarOpacity()).toBe(1);
    expect(manager.getHandBallOpacity()).toBe(1);
    manager.setChargeTranslucent(true);
    expect(manager.getAvatarOpacity()).toBeCloseTo(AVATAR_CHARGE_OPACITY, 10);
    expect(manager.getHandBallOpacity()).toBeCloseTo(AVATAR_CHARGE_OPACITY, 10);
    manager.setChargeTranslucent(false);
    expect(manager.getAvatarOpacity()).toBe(1);
    expect(manager.getHandBallOpacity()).toBe(1);
  });

  it("keeps hit-flash emissive working while translucent", async () => {
    const manager = await createManager();
    manager.setChargeTranslucent(true);
    manager.applyTestHit();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    // Flash writes emissiveIntensity — independent of the opacity fade.
    expect(manager.debugGetAvatarEmissive()).toBeGreaterThan(0);
    expect(manager.getAvatarOpacity()).toBeCloseTo(AVATAR_CHARGE_OPACITY, 10);
    manager.setChargeTranslucent(false);
    expect(manager.getAvatarOpacity()).toBe(1);
  });
});

describe("SceneManager local victim hit-flash (Stage 4d.4 ball-hit-player routing)", () => {
  it("flashLocalHit spikes the avatar emissive, fading over ~0.18s", async () => {
    expect(HIT_FLASH_DURATION_S).toBe(0.18);
    const manager = await createManager();
    expect(manager.debugGetAvatarEmissive()).toBe(0);
    manager.flashLocalHit();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.debugGetAvatarEmissive()).toBeGreaterThan(0);
    const frames = Math.ceil(HIT_FLASH_DURATION_S / FRAME) + 5;
    for (let i = 0; i < frames; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.debugGetAvatarEmissive()).toBe(0);
  });
});

describe("SceneManager post-shot body turn (owner fix round 2)", () => {
  it("arms on a real shot and eases the body toward the shot facing when stopped", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    expect(manager.getAvatarFacing()).toBeCloseTo(0, 10);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    // Shot yaw 0 flies toward -Z: the body must turn to facing PI.
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    // Converges fast: a PI flip is under 0.15 rad residual after ~0.3s.
    for (let i = 0; i < 18; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const mid = manager.getAvatarFacing();
    const wrapGap = (angle: number): number => {
      const twoPi = Math.PI * 2;
      let wrapped = angle % twoPi;
      if (wrapped > Math.PI) {
        wrapped -= twoPi;
      } else if (wrapped < -Math.PI) {
        wrapped += twoPi;
      }
      return wrapped;
    };
    expect(Math.abs(wrapGap(Math.PI - mid))).toBeLessThan(0.15);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    // Settles exactly and deactivates (snap inside the DONE band).
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getAvatarFacing()).toBeCloseTo(Math.PI, 2);
    expect(manager.isShotBodyTurnActive()).toBe(false);
  });

  it("resumed movement cancels the turn and the movement writer owns yaw", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    // Camera yaw is 0, so pushing forward gives worldMove (0, 0, -1) and the
    // movement writer sets facing atan2(0, -1) = PI while killing the turn.
    manager.update(FRAME, { x: 0, y: 1 }, NO_LOOK);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    expect(manager.getAvatarFacing()).toBeCloseTo(Math.PI, 5);
  });

  it("teleport / reset / spectate transitions cancel a pending turn", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.teleportSelf(3, -2);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.reset();
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.setSpectating(true);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setSpectating(false);
  });

  it("explicit cancel drops the turn and non-finite yaw never arms it", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.cancelShotBodyTurn();
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setShotTurnTarget(Number.NaN);
    expect(manager.isShotBodyTurnActive()).toBe(false);
  });
});

describe("SceneManager pitch clamp (4d.3 feedback: down to -0.41, up capped 0.36)", () => {
  it("clamps setCameraAngles pitch to the shared [MIN, MAX] band", async () => {
    expect(CAMERA_PITCH_MAX).toBeCloseTo(0.36, 12);
    expect(CAMERA_PITCH_MIN).toBeCloseTo(-0.41, 12);
    const manager = await createManager();
    manager.setCameraAngles(0, 1.0);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MAX, 10);
    manager.setCameraAngles(0, -1.0);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
  });

  it("keeps the plain [-0.41, 0.36] band by default (non-charge look paths unchanged)", async () => {
    expect(CAMERA_PITCH_MIN).toBeCloseTo(-0.41, 12);
    const manager = await createManager();
    // -0.2 now aims down freely inside the widened band (was MIN-adjacent).
    manager.setCameraAngles(0, -0.2);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.2, 10);
    // Just below the new MIN still pins to MIN without an override — the
    // mirror band must never leak into normal look.
    manager.setCameraAngles(0, -0.5);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
  });

  it("accepts the asymmetric mirror band only via the min/max override", async () => {
    const manager = await createManager();
    // Mirror edges (-0.36 / +0.41) survive with the explicit override ...
    manager.setCameraAngles(0, MIRROR_PITCH_MIN, MIRROR_PITCH_MIN, MIRROR_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(MIRROR_PITCH_MIN, 10);
    manager.setCameraAngles(0, MIRROR_PITCH_MAX, MIRROR_PITCH_MIN, MIRROR_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(MIRROR_PITCH_MAX, 10);
    // ... but through the default path the high edge pins to MAX and the
    // low edge pins to MIN.
    manager.setCameraAngles(0, MIRROR_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MAX, 10);
    manager.setCameraAngles(0, MIRROR_PITCH_MIN);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(MIRROR_PITCH_MIN, 10);
  });
});

describe("SceneManager resting pitch (fix round 3: 0.15 resting, 0.05 follow pitch)", () => {
  it("pins the resting constants above MIN", () => {
    expect(CAMERA_REST_PITCH).toBeCloseTo(0.15, 12);
    expect(IDLE_FOLLOW_PITCH).toBeCloseTo(0.05, 12);
    expect(CAMERA_PITCH_MIN).toBeCloseTo(-0.41, 12);
    expect(IDLE_FOLLOW_PITCH).toBeGreaterThan(CAMERA_PITCH_MIN);
    expect(CAMERA_REST_PITCH).toBeGreaterThan(CAMERA_PITCH_MIN);
  });

  it("spawns and resets at CAMERA_REST_PITCH", async () => {
    const manager = await createManager();
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_REST_PITCH, 10);
    manager.setCameraAngles(0.7, 0.3);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(0.3, 10);
    manager.reset();
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_REST_PITCH, 10);
  });
});

describe("SceneManager aim-mirror camera (fix round 3, charge path)", () => {
  // Camera-behind convention (updateCameraTransform): camera sits at
  // avatar + (sin c, cos c)*d with y = avatar.y + 2.1 + sin(p)*d and looks
  // at avatar.y + (CAMERA_LOOK_AT_HEIGHT - 1.1). View pitch from the live
  // camera position to that look target.
  function viewPitchToAvatar(manager: SceneManager): number {
    const cam = manager.debugGetCameraPosition();
    const avatar = manager.getAvatarPosition();
    const lookY = avatar.y + (CAMERA_LOOK_AT_HEIGHT - 1.1);
    const horizontal = Math.hypot(cam.x - avatar.x, cam.z - avatar.z);
    return Math.atan2(lookY - cam.y, Math.max(0.0001, horizontal));
  }

  async function convergedAtChargeZoom(manager: SceneManager): Promise<void> {
    manager.teleportSelf(0, 0);
    manager.setChargeZoom01(1);
    for (let i = 0; i < 240; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
  }

  it("routes aim-up through the mirror: camera pitch goes NEGATIVE (drops)", async () => {
    const manager = await createManager();
    await convergedAtChargeZoom(manager);
    // The exact main.ts charge call shape: mirrored pitch + mirror band.
    manager.setCameraAngles(
      0,
      mirrorChargeCameraPitch(0.3),
      MIRROR_PITCH_MIN,
      MIRROR_PITCH_MAX,
    );
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.3, 10);
    expect(manager.getCameraAngles().pitch).toBeLessThan(0);
  });

  it("tilts the view UP along the trajectory vs the direct copy (acceptance)", async () => {
    const manager = await createManager();
    await convergedAtChargeZoom(manager);
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(
        0,
        mirrorChargeCameraPitch(0.3),
        MIRROR_PITCH_MIN,
        MIRROR_PITCH_MAX,
      );
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const mirroredView = viewPitchToAvatar(manager);
    // Control: the old direct-copy wiring at the same aim pitch.
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(0, 0.3);
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const directView = viewPitchToAvatar(manager);
    // Honest form of the acceptance: the camera lookAts the avatar, so the
    // absolute view pitch can never equal the aim pitch — but the mirror
    // must tilt the view UP relative to the direct copy (and to neutral),
    // by a substantial fraction of the aim deflection.
    expect(mirroredView).toBeGreaterThan(directView);
    expect(mirroredView - directView).toBeGreaterThan(0.3);
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(0, 0);
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(mirroredView).toBeGreaterThan(viewPitchToAvatar(manager));
  });

  it("stays above ground at the widest mirror (charge zoom 3.2m)", async () => {
    const manager = await createManager();
    await convergedAtChargeZoom(manager);
    // Widest LOW mirror: full-up aim (MAX) -> camera pitch -MAX.
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(
        0,
        mirrorChargeCameraPitch(CAMERA_PITCH_MAX),
        MIRROR_PITCH_MIN,
        MIRROR_PITCH_MAX,
      );
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const cam = manager.debugGetCameraPosition();
    const avatar = manager.getAvatarPosition();
    // camera y = avatar.y + 2.1 + sin(-0.36)*3.2 ~= avatar.y + 0.97.
    expect(cam.y - avatar.y).toBeCloseTo(
      CAMERA_FOLLOW_HEIGHT + Math.sin(-CAMERA_PITCH_MAX) * CAMERA_CHARGE_DISTANCE,
      1,
    );
    expect(cam.y).toBeGreaterThan(1.0);
  });
});

describe("SceneManager airborne flight gate (glide, no bounce mid-air)", () => {
  it("flags airborne from physics vertical speed, clears at rest", async () => {
    expect(AIRBORNE_VY_THRESHOLD).toBe(2.0);
    const manager = await createManager();
    expect(manager.isAirborne()).toBe(false);
    // Rising fast (trampoline-class vy): airborne from the next tick.
    manager.debugSetPlayerState({ x: 0, y: 3, z: 0 }, { x: 0, y: 5, z: 0 });
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.isAirborne()).toBe(true);
    // Back to rest on the ground: the exit hold keeps the flag briefly,
    // then sustained rest clears it (no apex-style flutter on landing).
    // ~30 frames: the 0.1m spawn drop + Rapier settle consume the first
    // ~8, the 0.25s hold needs 15 more (probe-verified, gate code untouched).
    manager.debugSetPlayerState({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: 0 });
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.isAirborne()).toBe(true);
    for (let i = 0; i < 30; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.isAirborne()).toBe(false);
  });

  it("a trampoline launch trips the gate naturally", async () => {
    const manager = await createManager();
    // Pad at (0, 4.2): teleporting over it auto-launches (vy = 12).
    manager.teleportSelf(0, 4.2);
    expect(manager.isAirborne()).toBe(false);
    // The gate reads post-step velocity but the launch fires after the
    // measurement, so the flag trips on the second tick — honest ordering,
    // one frame of lag, then solidly airborne.
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.isAirborne()).toBe(true);
  });
});

describe("SceneManager aim clamp (F2 fix: stored aim always in-band)", () => {
  it("clamps setAimAngles pitch to [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX]", async () => {
    const manager = await createManager();
    // A stale mirrored pitch must never lodge in the stored aim (it feeds
    // recoil/spark/muzzle math); the old unclamped setter kept it verbatim.
    // -0.5 is out of the widened band, so it pins to the new MIN (-0.41).
    manager.setAimAngles(0.5, -0.5);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
    manager.setAimAngles(0.5, 0.5);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(CAMERA_PITCH_MAX, 10);
    manager.setAimAngles(0.5, 0.2);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(0.2, 10);
    expect(manager.debugGetAimAngles().yaw).toBeCloseTo(0.5, 10);
    // Non-finite input is ignored (previous aim survives).
    manager.setAimAngles(Number.NaN, Number.NaN);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(0.2, 10);
    expect(manager.debugGetAimAngles().yaw).toBeCloseTo(0.5, 10);
  });
});

describe("SceneManager out-of-band RMB tolerance (F3 fix)", () => {
  it("an upward drag from out-of-band glides back, never snaps", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    // Synthetic out-of-band start below the widened MIN (shipped mirror
    // starts bottom out at -0.36, now in-band — the tolerance backstops
    // deeper starts, so the test drives one explicitly via the override).
    manager.setCameraAngles(0, -0.5, -0.5, CAMERA_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.5, 10);
    // Honest guarantee: the clamp provides CONTINUITY (no clamp-induced
    // jump), so each frame moves by at most the input step |dy| * SENS.
    const step = 10 * CAMERA_SENSITIVITY;
    expect(step).toBeLessThan(0.05);
    let previous = manager.getCameraAngles().pitch;
    for (let i = 0; i < 10; i += 1) {
      manager.update(FRAME, NO_MOVE, { dx: 0, dy: 10 });
      const pitch = manager.getCameraAngles().pitch;
      expect(pitch).toBeGreaterThan(previous);
      expect(pitch - previous).toBeLessThanOrEqual(step + 1e-9);
      expect(pitch - previous).toBeLessThan(0.05);
      previous = pitch;
    }
    // Still gliding monotonically — never jumped to the band edge.
    expect(previous).toBeGreaterThan(-CAMERA_PITCH_MAX);
  });

  it("a downward drag from out-of-band holds instead of escaping further", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0, -0.5, -0.5, CAMERA_PITCH_MAX);
    manager.update(FRAME, NO_MOVE, { dx: 0, dy: -10 });
    // The old plain clamp snapped an out-of-band start to CAMERA_PITCH_MIN
    // in one frame; the tolerant bound holds the pitch (lower bound =
    // current).
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.5, 10);
  });

  it("in-band RMB drags behave exactly as before (sign/rate/band untouched)", async () => {
    expect(CAMERA_SENSITIVITY).toBeCloseTo(0.0045, 12);
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0, 0);
    manager.update(FRAME, NO_MOVE, { dx: 0, dy: 10 });
    expect(manager.getCameraAngles().pitch).toBeCloseTo(10 * CAMERA_SENSITIVITY, 10);
    manager.update(FRAME, NO_MOVE, { dx: -20, dy: 0 });
    expect(manager.getCameraAngles().yaw).toBeCloseTo(20 * CAMERA_SENSITIVITY, 10);
  });
});
