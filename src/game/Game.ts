import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { DriverSkill } from '../ai/Driver.ts';
import { computeRacingLine } from '../ai/racingLine.ts';
import type { Input, InputFrame } from '../input/Input.ts';
import { Car, type Assists } from '../physics/Car.ts';
import { GZ26 } from '../physics/carSpec.ts';
import { CameraRig } from '../render/cameraRig.ts';
import { buildCarModel, type CarVisual } from '../render/carModel.ts';
import { Particles } from '../render/effects/particles.ts';
import { Rain } from '../render/effects/rain.ts';
import { SkidMarks } from '../render/effects/skidMarks.ts';
import { createSpeedBlurPass } from '../render/speedBlur.ts';
import { buildTrackside, type Trackside } from '../render/trackside.ts';
import { GhostCar } from '../render/ghostCar.ts';
import { createEnvironment, type Environment } from '../render/environment.ts';
import type { QualitySettings } from '../render/quality.ts';
import { buildScenery } from '../render/scenery.ts';
import { GROUND_DROP, Terrain } from '../render/terrain.ts';
import { buildTrackMeshes } from '../render/trackMesh.ts';
import { applyWetness, collectWettable } from '../render/wet.ts';
import type { Track } from '../track/Track.ts';
import { Field, type FieldCar } from './Field.ts';
import type { GhostPose } from './ghost.ts';
import type { Livery, Team } from './teams.ts';
import { World } from './World.ts';

export const PHYSICS_HZ = 240;
export const PLAYER_ID = 'player';
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
  readonly field: Field;
  paused = false;
  /** Menu backdrop: the camera orbits the parked car. */
  showcase = false;
  /** Cars wait on the grid for the start lights. */
  held = false;

  private readonly player: FieldCar;
  private readonly env: Environment;
  private visual: CarVisual;
  private readonly opponentVisuals = new Map<string, CarVisual>();
  private ghost: GhostCar | null = null;
  private livery: Livery;
  private ghostLivery: Livery | null = null;
  private readonly castShadows: boolean;
  private readonly composer: EffectComposer | null;
  private speedBlur: ReturnType<typeof createSpeedBlurPass> | null = null;
  private readonly skids: SkidMarks;
  private readonly trackside: Trackside;
  readonly terrain: Terrain;
  private readonly particles: Particles;
  private readonly rain: Rain;
  private readonly wettable: THREE.MeshStandardMaterial[];
  private rainAmount = 0;
  private shownSky = { cloud: -1, rain: -1 };
  private shownWetness = -1;
  private readonly input: Input;
  private readonly onFrame?: GameOptions['onFrame'];
  private accumulator = 0;
  private readonly basePixelRatio: number;
  private container!: HTMLElement;
  /** Current render resolution as a fraction of the tier's pixel ratio. */
  renderScale = 1;
  private avgFrame = 0;
  private adaptClock = 0;
  private adaptPaused = 0;
  private lastAdapt: { frame: number; scale: number } | null = null;
  private lastTime = -1;
  private running = false;

  constructor(o: GameOptions) {
    this.track = o.track;
    this.input = o.input;
    this.onFrame = o.onFrame;
    const q = o.quality;

    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(window.devicePixelRatio, q.maxPixelRatio);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(o.container.clientWidth, o.container.clientHeight);
    // Neutral keeps the sky's blue; ACES desaturated it to grey.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    o.container.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(o.container.clientWidth / o.container.clientHeight);
    this.env = createEnvironment(this.renderer, this.scene, q);

    this.car = new Car(GZ26, o.assists);
    const grid = o.track.gridSlot(0);
    this.car.reset(grid.x, grid.z, grid.heading);
    this.world = new World(o.track, this.car);
    this.field = new Field(o.track, computeRacingLine(o.track, GZ26));
    // The racing line tells the track where to lay rubber down.
    this.scene.add(buildTrackMeshes(o.track, q, this.field.line));
    // The land: the heightfield mesh, and a plane beyond it to the horizon.
    this.terrain = new Terrain(o.track, q);
    this.scene.add(this.terrain.mesh);
    const farGeo = new THREE.PlaneGeometry(12000, 12000);
    // Same 40 m grass repeat as the terrain.
    const uv = farGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 300, uv.getY(k) * 300);
    // The terrain material tints by vertex colour; the far plane takes the open countryside's average tint.
    farGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(uv.count * 3).fill(0.95), 3));
    farGeo.setAttribute('farness', new THREE.Float32BufferAttribute(new Array(uv.count).fill(1), 1));
    const far = new THREE.Mesh(farGeo, this.terrain.mesh.material);
    far.rotation.x = -Math.PI / 2;
    far.position.y = this.terrain.horizonHeight - 0.5;
    this.scene.add(far);
    this.scene.add(this.terrain.buildRidge());
    this.scene.add(buildScenery(o.track, q, (x, z) => this.terrain.heightAt(x, z)));
    this.trackside = buildTrackside(o.track, q);
    this.scene.add(this.trackside.group);
    this.skids = new SkidMarks(q);
    this.scene.add(this.skids.mesh);
    this.particles = new Particles(q, this.env.sunDirection);
    this.scene.add(this.particles.mesh);
    this.rain = new Rain(q);
    this.scene.add(this.rain.mesh);
    this.wettable = collectWettable(this.scene);
    this.player = this.field.addPlayer(PLAYER_ID, this.car, this.world);
    this.castShadows = q.shadows;
    this.livery = o.team.livery;
    this.visual = buildCarModel(this.car, o.team.livery, q.shadows);
    this.scene.add(this.visual.root);
    this.visual.update(this.car);
    this.rig.snap(this.car);

    if (q.bloom) {
      // A multisampled target keeps anti-aliasing on the post-processing path; HDR so bloom sees real highlights.
      const pr = this.renderer.getPixelRatio();
      const target = new THREE.WebGLRenderTarget(o.container.clientWidth * pr, o.container.clientHeight * pr, {
        type: THREE.HalfFloatType,
        samples: q.antialias ? 4 : 0,
      });
      this.composer = new EffectComposer(this.renderer, target);
      this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
      const size = new THREE.Vector2(o.container.clientWidth, o.container.clientHeight);
      this.composer.addPass(new UnrealBloomPass(size, 0.18, 0.4, 0.92));
      this.speedBlur = createSpeedBlurPass();
      this.composer.addPass(this.speedBlur);
      this.composer.addPass(new OutputPass());
      // Size the chain in CSS pixels times the pixel ratio, so later resizes and resolution changes keep it sharp.
      this.composer.setPixelRatio(pr);
      this.composer.setSize(o.container.clientWidth, o.container.clientHeight);
    } else {
      this.composer = null;
    }

    this.container = o.container;
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

  /**
   * Off the asphalt, a coarse terrain mesh can sit a little above the ground the physics uses; lift the model so a
   * car on the grass is never drawn sunk into it.
   */
  private keepAboveGround(car: Car, visual: CarVisual): void {
    if (car.wheelSurface.every((k) => k === 'track' || k === 'kerb')) return;
    const ground = this.terrain.meshHeightAt(car.x, car.z) + GROUND_DROP;
    if (ground > visual.root.position.y) visual.root.position.y = ground;
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

  /** Shows the Time Trial ghost at a pose, or hides it (null). Built on first use, in the player's livery. */
  setGhost(pose: GhostPose | null, livery: Livery): void {
    if (!pose && !this.ghost) return;
    if (!this.ghost || this.ghostLivery !== livery) {
      if (this.ghost) this.disposeVisual({ root: this.ghost.root, update: () => {} });
      this.ghost = new GhostCar(this.car, livery);
      this.ghostLivery = livery;
      this.scene.add(this.ghost.root);
    }
    this.ghost.show(pose);
  }

  /**
   * The weather on screen: `cloud` (0..1) sets the sky and light, `rain` (0..1) the falling rain and haze, and
   * `wetness` (0..1) how dark and glossy the track looks and how much spray the cars throw up.
   */
  setWeather(cloud: number, rain: number, wetness: number): void {
    const sky = this.shownSky;
    const moved = (a: number, b: number) => Math.abs(a - b) > 0.002 || (a === 0) !== (b === 0);
    if (moved(cloud, sky.cloud) || moved(rain, sky.rain)) {
      this.env.setWeather(cloud, rain);
      sky.cloud = cloud;
      sky.rain = rain;
    }
    this.rainAmount = rain;
    if (Math.abs(wetness - this.shownWetness) > 0.004) {
      applyWetness(this.wettable, wetness);
      this.shownWetness = wetness;
    }
    this.particles.wetness = wetness;
  }

  /** Lights `count` columns of the start gantry over the grid (0 turns them all off). */
  setStartLights(count: number): void {
    this.trackside.setStartLights(count);
  }

  /** The player's current livery, for the ghost. */
  get playerLivery(): Livery {
    return this.livery;
  }

  setTeam(team: Team): void {
    this.livery = team.livery;
    this.disposeVisual(this.visual);
    this.visual = buildCarModel(this.car, team.livery, this.castShadows);
    this.scene.add(this.visual.root);
    this.visual.update(this.car);
  }

  /** Puts AI opponents on the grid; the player starts from `playerSlot`. */
  setupOpponents(opponents: readonly { id: string; team: Team; skill: DriverSkill; slot: number }[], playerSlot: number): void {
    this.clearOpponents();
    for (const o of opponents) {
      const fc = this.field.addAI(o.id, GZ26, o.skill, o.slot);
      const visual = buildCarModel(fc.car, o.team.livery, this.castShadows);
      this.scene.add(visual.root);
      visual.update(fc.car);
      this.opponentVisuals.set(o.id, visual);
    }
    this.toGrid(playerSlot);
  }

  clearOpponents(): void {
    for (const v of this.opponentVisuals.values()) this.disposeVisual(v);
    this.opponentVisuals.clear();
    this.field.removeAI();
    this.skids.prune(this.field.cars);
  }

  /** Distance along the lap for any car in the field. */
  sOf(id: string): number {
    return this.field.cars.find((fc) => fc.id === id)!.world.projection.s;
  }

  private disposeVisual(v: CarVisual): void {
    this.scene.remove(v.root);
    v.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    // A minimised window or a rotation in progress can report 0 x 0: that would make the camera's aspect NaN and
    // the post-processing targets empty. Keep the last good size until there is a real one.
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  /**
   * Dynamic resolution: if frames take longer than the 60 fps budget, render at a lower resolution (down to 60%) and
   * climb back when there is headroom. If dropping resolution doesn't speed frames up, the device is limited by
   * something else (often a 30 fps battery-saver cap), so full resolution is restored and adapting pauses.
   */
  private adaptResolution(dt: number): void {
    if (dt <= 0 || dt >= MAX_FRAME) return;
    this.avgFrame = this.avgFrame === 0 ? dt : this.avgFrame * 0.95 + dt * 0.05;
    this.adaptClock += dt;
    if (this.adaptClock < 1.5) return;
    this.adaptClock = 0;
    if (this.adaptPaused > 0) {
      this.adaptPaused -= 1.5;
      return;
    }
    const budget = 1 / 60;
    let next = this.renderScale;
    if (this.lastAdapt !== null && this.avgFrame > this.lastAdapt.frame * 0.97 && this.renderScale < this.lastAdapt.scale) {
      // The last cut didn't help: not resolution-bound. Restore and leave it alone for a while.
      next = 1;
      this.adaptPaused = 20;
      this.lastAdapt = null;
    } else if (this.avgFrame > budget * 1.12 && this.renderScale > 0.6) {
      this.lastAdapt = { frame: this.avgFrame, scale: this.renderScale };
      next = Math.max(0.6, this.renderScale - 0.1);
    } else if (this.avgFrame < budget * 1.02 && this.renderScale < 1) {
      this.lastAdapt = null;
      next = Math.min(1, this.renderScale + 0.05);
    }
    if (next === this.renderScale) return;
    this.renderScale = next;
    const pr = this.basePixelRatio * next;
    this.renderer.setPixelRatio(pr);
    this.composer?.setPixelRatio(pr);
    this.resize(this.container);
  }

  private frame(now: number): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(MAX_FRAME, now - this.lastTime);
    this.lastTime = now;
    if (!this.paused) this.adaptResolution(dt);
    const input = this.input.poll(dt);
    if (input.camera && !this.paused) this.rig.next();
    if (input.reset && !this.paused) this.resetCar();

    this.field.beginFrame();
    if (!this.paused) {
      this.field.plan();
      this.accumulator += dt;
      let first = true;
      while (this.accumulator >= STEP) {
        // Gear shifts are edge-triggered, so they apply to the first physics step of the frame only.
        const controls = first ? input : { ...input, shiftUp: false, shiftDown: false };
        this.field.step(STEP, controls, this.held);
        this.accumulator -= STEP;
        first = false;
      }
    }
    const impact = this.player.impact;

    const kerb = this.car.wheelSurface.filter((k) => k === 'kerb').length / 4;
    if (impact > 2) this.rig.bump(Math.min(1, impact / 25));
    this.onFrame?.(this, { dt, input, impact, kerb });

    // Game time, so brake glow and the DRS flap pause with the game.
    const visualDt = this.paused ? 0 : dt;
    this.visual.update(this.car, visualDt);
    this.keepAboveGround(this.car, this.visual);
    for (const fc of this.field.cars) {
      const v = this.opponentVisuals.get(fc.id);
      if (!v) continue;
      v.update(fc.car, visualDt);
      this.keepAboveGround(fc.car, v);
    }
    if (!this.paused) {
      this.skids.update(this.field.cars);
      this.particles.update(dt, this.field.cars, this.rig.camera.position);
    }
    if (this.showcase) this.rig.showcase(this.car, dt);
    else this.rig.update(this.car, dt, Math.abs(this.car.u) > 5 ? kerb : 0);
    this.env.follow(this.visual.root.position);
    this.env.update(dt);
    this.rain.update(this.paused ? 0 : dt, this.rainAmount, this.rig.camera);
    // Speed blur from about 150 km/h, never in the menus or the cockpit-free showcase.
    const speedBlur = this.showcase || this.paused ? 0 : THREE.MathUtils.clamp((Math.abs(this.car.u) - 42) / 50, 0, 1) * 0.035;
    this.speedBlur?.setStrength(speedBlur);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.rig.camera);
  }
}
