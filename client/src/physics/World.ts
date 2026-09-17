import RAPIER from "@dimforge/rapier3d-compat";
import {
  ARENA_HALF_SIZE,
  ICE_FRICTION,
  ICE_LINEAR_DAMPING,
  PHYSICS_FIXED_DT,
  PHYSICS_GRAVITY_Y,
  PHYSICS_MAX_ACCUMULATOR,
  PLAYER_FRICTION,
  PLAYER_LINEAR_DAMPING,
  PLAYER_RESTITUTION,
  TRAMPOLINE_IMPULSE,
  WALL_THICKNESS,
} from "../config";

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface PlayerSpawn {
  x: number;
  y: number;
  z: number;
}

// Thin Rapier3D WASM wrapper (compat build, WASM inlined — no extra assets).
// Fixed 60Hz stepping decoupled from render delta (QT3-A). Owns exactly one
// dynamic capsule body (the player) plus static boxes for floor/walls/
// obstacles. Slippery zones and trampolines are resolved geometrically by
// the caller (Arena layout) — Rapier only integrates the body. Call
// dispose() to free the WASM world (room leave / scene reset safe).
export class PhysicsWorld {
  private world: RAPIER.World;
  private readonly playerBody: RAPIER.RigidBody;
  private readonly playerCollider: RAPIER.Collider;
  private accumulator = 0;
  private disposed = false;

  private constructor(world: RAPIER.World, playerBody: RAPIER.RigidBody, playerCollider: RAPIER.Collider) {
    this.world = world;
    this.playerBody = playerBody;
    this.playerCollider = playerCollider;
  }

  public static async create(spawn: PlayerSpawn): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: PHYSICS_GRAVITY_Y, z: 0 });
    world.timestep = PHYSICS_FIXED_DT;

    // Floor slab slightly below y=0 so its top face matches the visual plane.
    const floorBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25, 0),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        ARENA_HALF_SIZE + WALL_THICKNESS,
        0.25,
        ARENA_HALF_SIZE + WALL_THICKNESS,
      ).setFriction(PLAYER_FRICTION),
      floorBody,
    );

    // Player capsule mirrors the visual CapsuleGeometry(0.5, 1.0):
    // rapier capsule(halfHeight, radius) with halfHeight 0.5, radius 0.5.
    const playerBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinearDamping(PLAYER_LINEAR_DAMPING)
        .lockRotations()
        .setCcdEnabled(true),
    );
    const playerCollider = world.createCollider(
      RAPIER.ColliderDesc.capsule(0.5, 0.5)
        .setFriction(PLAYER_FRICTION)
        .setRestitution(PLAYER_RESTITUTION)
        // Min combine so the slippery switch actually governs on ice:
        // pair friction becomes min(floor, player) = ICE_FRICTION on ice
        // (real sliding) while ground stays min(0.7, 0.7) = full grip.
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      playerBody,
    );
    return new PhysicsWorld(world, playerBody, playerCollider);
  }

  // Static axis-aligned box collider (walls, obstacle blocks). hx/hy/hz are
  // half extents; x/y/z is the center. Must match the visual mesh transform.
  public addStaticBox(
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    friction: number = PLAYER_FRICTION,
  ): void {
    this.throwIfDisposed();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction),
      body,
    );
  }

  // Static rotated box collider (walk-up ramp slabs). hx/hy/hz are half
  // extents in the slab's local frame; rotation is a THREE quaternion
  // (passed as a plain {x,y,z,w} so the wrapper stays three-typed but
  // three-independent at the Rapier call site). Must match the visual mesh.
  public addStaticRotatedBox(
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    rotation: { x: number; y: number; z: number; w: number },
    friction: number = PLAYER_FRICTION,
  ): void {
    this.throwIfDisposed();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction),
      body,
    );
  }

  // Fixed-step integration with an accumulator; render-rate independent.
  public step(deltaSeconds: number): void {
    this.throwIfDisposed();
    if (!(deltaSeconds > 0)) {
      return;
    }
    this.accumulator = Math.min(this.accumulator + deltaSeconds, PHYSICS_MAX_ACCUMULATOR);
    while (this.accumulator >= PHYSICS_FIXED_DT) {
      this.world.step();
      this.accumulator -= PHYSICS_FIXED_DT;
    }
    // Safety net: walls should already stop the body, never let it escape.
    const translation = this.playerBody.translation();
    const limit = ARENA_HALF_SIZE + WALL_THICKNESS;
    const clampedX = Math.max(-limit, Math.min(limit, translation.x));
    const clampedZ = Math.max(-limit, Math.min(limit, translation.z));
    if (clampedX !== translation.x || clampedZ !== translation.z) {
      this.playerBody.setTranslation({ x: clampedX, y: translation.y, z: clampedZ }, true);
    }
  }

  public setPlayerVelocity(x: number, y: number, z: number): void {
    this.throwIfDisposed();
    this.playerBody.setLinvel({ x, y, z }, true);
  }

  public getPlayerVelocity(): Vector3Like {
    this.throwIfDisposed();
    const linvel = this.playerBody.linvel();
    return { x: linvel.x, y: linvel.y, z: linvel.z };
  }

  public getPlayerPosition(): Vector3Like {
    this.throwIfDisposed();
    const translation = this.playerBody.translation();
    return { x: translation.x, y: translation.y, z: translation.z };
  }

  // True Rapier impulse (mass-dependent velocity change) for knockback.
  public applyPlayerImpulse(x: number, y: number, z: number): void {
    this.throwIfDisposed();
    this.playerBody.applyImpulse({ x, y, z }, true);
  }

  // Deterministic trampoline launch: keep horizontal velocity, force the
  // vertical component to the tuned impulse (QT3-A 8-12 band).
  public launchTrampoline(): void {
    this.throwIfDisposed();
    const linvel = this.playerBody.linvel();
    this.playerBody.setLinvel({ x: linvel.x, y: TRAMPOLINE_IMPULSE, z: linvel.z }, true);
  }

  // Slippery modifier: on ice the body keeps momentum (low damping +
  // QT3-A ice friction), elsewhere normal grip. Cheap per-frame switch.
  public setSlippery(onIce: boolean): void {
    this.throwIfDisposed();
    this.playerBody.setLinearDamping(onIce ? ICE_LINEAR_DAMPING : PLAYER_LINEAR_DAMPING);
    this.playerCollider.setFriction(onIce ? ICE_FRICTION : PLAYER_FRICTION);
  }

  // Gentle reposition preserving velocity (self reconciliation lerp):
  // shifts the body translation without zeroing momentum, unlike reset().
  public setPlayerPosition(x: number, y: number, z: number): void {
    this.throwIfDisposed();
    this.playerBody.setTranslation({ x, y, z }, true);
  }

  public reset(spawn: PlayerSpawn): void {
    this.throwIfDisposed();
    this.playerBody.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.accumulator = 0;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.world.free();
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error("PhysicsWorld used after dispose");
    }
  }
}
