# Grid Zero: Project Plan (v1.0)

## Constraints

- **Budget:** zero.
- **Time:** one month, from 2026-10-11 to 2026-11-10.
- **Platforms:** Windows and macOS laptops, Android, and iOS.

## Why the browser, not Unity

The draft plan recommended Unity 6 and the app stores. Those constraints rule that out:

- iOS App Store publishing costs $99 a year and Google Play costs $25, so neither fits a zero budget.
- A Unity project of the scope described is an 18–24 month effort for a team.

One codebase that runs in the browser reaches all four platforms for free:

| Platform | How players get it |
|---|---|
| Windows, macOS | Any modern browser (Chrome, Edge, Safari, Firefox) |
| Android | Chrome, with "Install app" to add it to the home screen as a full-screen app |
| iOS | Safari, with "Add to Home Screen" for a full-screen app |

The game is a Progressive Web App (PWA), so once it is installed it works offline. If money becomes available later, the same code can be wrapped in Capacitor and submitted to both app stores without a rewrite.

## Stack (all free and open source)

| Concern | Choice |
|---|---|
| Rendering | three.js (WebGL 2), physically based materials, real-time shadows, procedural sky |
| Language and build | TypeScript, Vite |
| Vehicle physics | Custom: Pacejka-style tyre curves, load transfer, downforce and drag, 8-speed gearbox, brake bias |
| Audio | Web Audio API: engine sound synthesised from RPM and throttle (no paid samples) |
| Art | Procedural: track, car, kerbs and textures are generated in code, so there are no asset licences to pay for |
| Input | Keyboard, gamepad (Gamepad API), touch with on-screen controls and optional tilt steering |
| Hosting | GitHub Pages, deployed by GitHub Actions (free for public repositories) |

## What "realistic" means at zero budget

- **Handling:** the main focus. Grip falls off past peak slip, downforce grows with the square of speed, braking load shifts weight forward, and wheelspin happens out of slow corners.
- **Visuals:** physically based lighting, a sun with real-time shadows, tone mapping, kerbs and run-off, speed effects. They are generated in code rather than photo-scanned.
- **Sound:** a layered synthetic engine, tyre scrub and wind noise, all driven by the physics.
- **Quality tiers:** Low, Medium, High and Ultra, picked automatically from the device and adjustable in settings.

## Scope for the one-month release

- 1 car class and 10 fictional teams (no real team, driver or championship names, so no trademark problems)
- 1 circuit at launch; a second if time allows
- Modes: Time Trial with a ghost car, and a Quick Race against AI opponents
- Lap timing with sector splits and a personal best saved on the device
- Assists: steering, braking line, automatic gears, traction control
- Settings: quality tier, controls, audio volume

### Out of scope for this release

Online multiplayer, career mode, weather, livery editor and app-store builds.

## Schedule

| Week | Dates | Deliverable |
|---|---|---|
| 1 | Oct 11–17 | Project setup, rendering, track, car, physics, keyboard driving, chase camera |
| 2 | Oct 18–24 | Engine audio, HUD, lap timing, touch and gamepad controls, quality tiers |
| 3 | Oct 25–31 | AI opponents, Quick Race, ghost car, menus, settings |
| 4 | Nov 1–10 | Tuning, mobile performance, PWA offline install, testing on real devices, launch |

## Working rules

- Every change is committed and pushed to `andringodson/Grid-Zero` as soon as it is made.
- `main` must build at all times; CI runs a type check and a production build on every push.
