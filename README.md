# Grid Zero

A realistic open-wheel racing game that runs in the browser on Windows, macOS, Android and iOS. You can install it to your home screen and play it offline.

## Status

In development. See [docs/PLAN.md](docs/PLAN.md) for the plan and schedule.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints. To try it on a phone on the same Wi-Fi network, run `npm run dev -- --host` and open the network URL it shows.

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Throttle | W or Up | Right trigger | Right pedal |
| Brake | S or Down | Left trigger | Left pedal |
| Steer | A/D or Left/Right | Left stick | Tilt or on-screen wheel |
| Shift up / down | E / Q | A / X | Paddles |
| Change camera | C | Y | Camera button |
| Reset car to track | R | B | Reset button |

## Tech

three.js, TypeScript and Vite. Everything is generated in code: the track, the car, the textures and the engine sound. That keeps the project free of asset licences.
