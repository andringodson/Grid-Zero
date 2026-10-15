# Grid Zero

A realistic open-wheel racing game that runs in the browser on Windows, macOS, Android and iOS. You can install it to your home screen and play it offline.

Everything is generated in code: the circuit, the cars, the textures and the engine sound. The whole game is about 200 KB to download, and it has no asset licences.

## Modes

- **Quick Race:** race 5 to 9 AI rivals over 3, 5 or 10 laps, with start lights, a timing tower, pit stops and a results table. The grid is set by qualifying pace: your place comes from your best Time Trial lap, and without one you start from the back.
- **Time Trial:** set laps on your own, with sector times, a live delta to your best lap, track limits and a ghost of your best lap to race. Your personal best is saved on the device.
- **Weather:** dry, wet, or changing, where cloud builds and a shower arrives part-way through. The track wets and dries gradually, and grip falls most on kerbs, paint and grass.

## What makes it realistic

- **Physics at 240 Hz.** The car model has Pacejka tyre curves, load sensitivity, weight transfer, downforce and drag that grow with the square of speed, an 8-speed gearbox, and a friction circle, so braking or wheelspin costs cornering grip. The GZ-26 does 0–100 km/h in 2.8 s, reaches 337 km/h, and brakes at 5 g.
- **Tyres and strategy:** soft, medium and hard slicks, intermediates and full wets, each with its own grip, wear and temperature window. Fuel burns off, a hybrid system deploys and harvests energy, and DRS opens within a second of the car ahead.
- **Pit stops:** drive onto the pit road and the crew takes over. You run the pit lane at the 80 km/h limit, stop in your team's box, and get tyres for the conditions and a new nose if needed; a stop costs about 23 s. Rivals pit when the weather turns or their wing breaks.
- **AI drivers** follow a minimum-curvature racing line through a speed profile worked out from the car's grip. They overtake on the straights, follow when they can't pass, react to the lights, make the odd mistake, drive to the tyres and the weather, and lap Halden Ring in about 66–72 s, depending on difficulty.
- **The circuit** has 17 m of elevation, crests and banking, gravel traps and asphalt run-off, rubber laid down on the racing line, and a pit lane with team garages.
- **Engine sound** is synthesised live: a turbo V6 from its firing frequency, with turbo whistle, hybrid whine, gear-shift cuts and overrun pops. Tyres, wind, kerbs and impacts react to the physics.
- **Graphics** use a physically based sky that also lights the car's clear-coat paint, real-time sun shadows, rain with spray behind the cars, a track that goes dark and glossy in the wet, tyre smoke and skid marks, visible wing damage, and four quality tiers from low to ultra with dynamic resolution.

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
| `npm test` | Unit and simulation tests: track geometry, vehicle physics against real-world figures, lap timing, collisions, weather and tyres, pit stops, qualifying, a full AI lap, and an 8-car race |
| `npm run build` | Type-checks and builds the production site into `dist/` |
| `npm run preview` | Serves the production build at `/Grid-Zero/`, as GitHub Pages would |
| `node scripts/make-icons.mjs` | Regenerates the app icons |

## Tech

three.js, TypeScript and Vite. See [docs/PLAN.md](docs/PLAN.md) for the plan and progress.
