# Grid Zero

A realistic open-wheel racing game that runs in the browser on Windows, macOS, Android and iOS. You can install it to your home screen and play it offline.

Everything is generated in code: the circuit, the cars, the textures and the engine sound. The whole game is about 170 KB to download, and it has no asset licences.

## Modes

- **Quick Race:** start mid-pack against 5 to 9 AI rivals over 3, 5 or 10 laps, with start lights, a timing tower and a results table.
- **Time Trial:** set laps on your own, with sector times, a live delta to your best lap, and track limits. Your personal best is saved on the device.

## What makes it realistic

- **Physics at 240 Hz.** The car model has Pacejka tyre curves, load sensitivity, weight transfer, downforce and drag that grow with the square of speed, an 8-speed gearbox, and a friction circle, so braking or wheelspin costs cornering grip. The GZ-26 does 0–100 km/h in 2.8 s, reaches 337 km/h, and brakes at 5 g.
- **AI drivers** follow a minimum-curvature racing line through a speed profile worked out from the car's grip. They overtake on the straights, follow when they can't pass, and lap Halden Ring in about 66–72 s, depending on difficulty.
- **Engine sound** is synthesised live: a turbo V6 from its firing frequency, with turbo whistle, hybrid whine, gear-shift cuts and overrun pops. Tyres, wind, kerbs and impacts react to the physics.
- **Graphics** use a physically based sky that also lights the car's clear-coat paint, real-time sun shadows, and four quality tiers from low to ultra.

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Throttle | W or Up | Right trigger | Right pedal |
| Brake / reverse | S or Down | Left trigger | Left pedal |
| Steer | A/D or Left/Right | Left stick | Drag on the left half, or tilt |
| Shift up / down (manual gears) | E / Q | A / X | + / − paddles |
| Change camera | C | Y | CAM |
| Reset car to track | R | B | RESET |
| Pause | Esc or P | Start | II |

Hold the brake at a standstill to engage reverse. Driving assists (steering, automatic gears, traction control, ABS) can each be turned off in Settings.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints. To try it on a phone on the same Wi-Fi network, run `npm run dev -- --host` and open the network URL it shows.

| Command | What it does |
|---|---|
| `npm test` | Unit and simulation tests: track geometry, vehicle physics against real-world figures, lap timing, collisions, a full AI lap, and an 8-car race |
| `npm run build` | Type-checks and builds the production site into `dist/` |
| `npm run preview` | Serves the production build at `/Grid-Zero/`, as GitHub Pages would |
| `node scripts/make-icons.mjs` | Regenerates the app icons |

## Tech

three.js, TypeScript and Vite. See [docs/PLAN.md](docs/PLAN.md) for the plan and progress.
