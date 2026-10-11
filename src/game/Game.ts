import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Input, InputFrame } from '../input/Input.ts';
import { Car, type Assists } from '../physics/Car.ts';
import { GZ26 } from '../physics/carSpec.ts';
import { CameraRig } from '../render/cameraRig.ts';
import { buildCarModel, type CarVisual } from '../render/carModel.ts';
import { createEnvironment, type Environment } from '../render/environment.ts';
import type { QualitySettings } from '../render/quality.ts';
import { buildScenery } from '../render/scenery.ts';
import { buildTrackMeshes } from '../render/trackMesh.ts';
import type { Track } from '../track/Track.ts';
import type { Team } from './teams.ts';
import { World } from './World.ts';

export const PHYSICS_HZ = 240;
const STEP = 1 / PHYSICS_HZ;
/** Longest frame the simulation will catch up on; beyond this (a background tab, a stall) it slows down instead. */
const MAX_FRAME = 0.1;

export interface FrameInfo {
  dt: number;
  input: InputFrame;
  impact: number;
  kerb: number;
}

export interface GameOptions {
  container: HTMLElement;
  track: Track;
  team: Team;
  quality: QualitySettings;
  assists: Assists;
  input: Input;
  /** Called after physics each frame, before rendering; for timing, HUD and audio. */
  onFrame?: (game: Game, info: FrameInfo) => void;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly car: Car;
  readonly world: World;
  readonly track: Track;
  paused = false;
  /** Menu backdrop: the camera orbits the parked car. */
  showcase = false;

  private readonly env: Environment;
  private visual: CarVisual;
  private readonly castShadows: boolean;
  private readonly composer: EffectComposer | null;
  private readonly input: Input;
  private readonly onFrame?: GameOptions['onFrame'];
  private accumulator = 0;
  private lastTime = -1;
  private running = false;

  constructor(o: GameOptions) {
    this.track = o.track;
    this.input = o.input;
    this.onFrame = o.onFrame;
    const q = o.quality;

    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio));
    this.renderer.setSize(o.container.clientWidth, o.container.clientHeight);
    // Neutral keeps the sky's blue; ACES desaturated it to grey.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    o.container.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(o.container.clientWidth / o.container.clientHeight);
    this.env = createEnvironment(this.renderer, this.scene, q);
    this.scene.add(buildTrackMeshes(o.track, q));
    this.scene.add(buildScenery(o.track, q));

    this.car = new Car(GZ26, o.assists);
    const grid = o.track.gridSlot(0);
    this.car.reset(grid.x, grid.z, grid.heading);
    this.world = new World(o.track, this.car);
    this.castShadows = q.shadows;
    this.visual = buildCarModel(this.car, o.team.livery, q.shadows);
    this.scene.add(this.visual.root);
    this.visual.update(this.car);
    this.rig.snap(this.car);

    if (q.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
      const size = new THREE.Vector2(o.container.clientWidth, o.container.clientHeight);
      this.composer.addPass(new UnrealBloomPass(size, 0.18, 0.4, 0.92));
      this.composer.addPass(new OutputPass());
    } else {
      this.composer = null;
    }

    window.addEventListener('resize', () => this.resize(o.container));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = -1;
    this.renderer.setAnimationLoop((t) => this.frame(t / 1000));
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  resetCar(): void {
    this.world.resetCar(this.car);
    this.rig.snap(this.car);
  }

  /** Puts the car back in its grid slot, stopped. */
  toGrid(slot = 0): void {
    const g = this.track.gridSlot(slot);
    this.car.reset(g.x, g.z, g.heading);
    this.world.forgetPosition();
    this.world.projection = this.track.project(this.car.x, this.car.z);
    this.accumulator = 0;
    this.visual.update(this.car);
    this.rig.snap(this.car);
  }

  setTeam(team: Team): void {
    this.scene.remove(this.visual.root);
    this.visual.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.visual = buildCarModel(this.car, team.livery, this.castShadows);
    this.scene.add(this.visual.root);
    this.visual.update(this.car);
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  private frame(now: number): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(MAX_FRAME, now - this.lastTime);
    this.lastTime = now;
    const input = this.input.poll(dt);
    if (input.camera && !this.paused) this.rig.next();
    if (input.reset && !this.paused) this.resetCar();

    let impact = 0;
    if (!this.paused) {
      this.accumulator += dt;
      let first = true;
      while (this.accumulator >= STEP) {
        // Gear shifts are edge-triggered, so they apply to the first physics step of the frame only.
        const controls = first ? input : { ...input, shiftUp: false, shiftDown: false };
        this.car.step(STEP, controls, this.world.probe);
        impact = Math.max(impact, this.world.constrain(this.car).impact);
        this.accumulator -= STEP;
        first = false;
      }
    }

    const kerb = this.car.wheelSurface.filter((k) => k === 'kerb').length / 4;
    if (impact > 2) this.rig.bump(Math.min(1, impact / 25));
    this.onFrame?.(this, { dt, input, impact, kerb });

    this.visual.update(this.car);
    if (this.showcase) this.rig.showcase(this.car, dt);
    else this.rig.update(this.car, dt, Math.abs(this.car.u) > 5 ? kerb : 0);
    this.env.follow(this.visual.root.position);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.rig.camera);
  }
}
