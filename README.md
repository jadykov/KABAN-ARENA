# KABAN ARENA

## Project

- KABAN ARENA: browser-based 3D multiplayer mobile-first arena game.
- FFA (every-man-for-himself), 2-6 players per room; solo players get up to 4 weak bots (`server/src/config.ts:6-10`).
- Guest flow, no auth: pick nick + press Play; empty nick falls back to `Guest-XXXX`; late join mid-match till round end.
- Every round lasts 3 minutes; the highest score at the end wins (`server/src/config.ts`, `server/src/rooms/ArenaRoom.ts`).
- Performance priority over graphics: stable ~60fps target on mid phones (mid Android 2021, iPhones 14/15/16).
- Art: stylized arena with softened cover edges, worn floor tiles, smooth bog pools, four distinct small platform shopfronts, a shared slanted sun/moon arc and sparse soft daytime clouds. The floating center banner has been removed.

## Stack

- Monorepo with root npm workspaces (`client`, `server`; `package.json:7-10`).
- `client/`: Vite + TypeScript + Three.js + Rapier3D WASM (`@dimforge/rapier3d-compat 0.20.0`) + TailwindCSS DOM-overlay HUD (`client/package.json:15-31`).
- `server/`: Node.js + TypeScript + Colyseus authoritative server, room name `arena` (`server/src/index.ts:20`, `client/src/config.ts:108`).
- Netcode: inputs-only upstream at 20 ticks/s (`client/src/config.ts:109`), sim + patches at 20/s (`server/src/config.ts:13-14`), delta state sync via minimal `@type` schema (`server/src/state.ts`).
- Docker for dev/run/test: `Dockerfile.client` (EXPOSE 5173), `Dockerfile.server` (EXPOSE 2567), `docker-compose.yml`.
- Node >= 20 (`package.json:24-26`); shared base tsconfig (`tsconfig.base.json`), per-package `tsconfig.json`.
- Client physics runs Rapier3D WASM decoupled at fixed 60Hz; avatar steering blends (ground accel 24, ice input accel 10, ice coast accel 2) so knockback and ice sliding survive.
- Pre-join spectator: boot connects as spectator (hover cam + plate + counters); Play spawns with 100 HP.

## Run

- `docker compose up --build -d` — client on `:5173`, server on `:2567`; health check `GET /health` returns `{"ok":true}` (`server/src/index.ts:8-14`).
- `npm install` at root (installs all workspaces); Docker images use `npm ci` (`Dockerfile.client:11`, `Dockerfile.server:11`).
- Checks fan out to both workspaces via `--workspaces --if-present` (`package.json:11-17`):
  - `npm run typecheck` — `tsc --noEmit` in client + server.
  - `npm run lint` — `eslint src --ext .ts` in client + server.
  - `npm run test` — `vitest run` in client + server.
  - `npm run build` — client: `sync-ads + tsc + vite build`; server: `tsc -p`.
  - `npm run dev` — client Vite `--host 0.0.0.0 --port 5173`; server `tsx --watch src/index.ts`.
- Local URLs after compose up: client `http://localhost:5173/`, server health `http://localhost:2567/health`.
- After any change: `npm run typecheck` + `lint` + `test` + `build`, then `docker compose up --build -d` and confirm client HTTP 200 + `/health {"ok":true}` (established session cadence, see `LOG.md`).
- Server URL resolution: `VITE_SERVER_URL` env wins, else derived from the page URL — proxied pages (no port / :80 / :443) use the same origin with no port (`wss://` on https, `ws://` on http), pages on `:2567` keep `:2567`, dev `:5173` targets `ws://<page-host>:2567` (`client/src/config.ts` `getServerUrl`); server port from `PORT` env, default 2567 (`server/src/index.ts` `getPort`).
- Shop signs: `fence-2` is used on the two diagonally opposite «Красное & Белое» platforms, `fence-3` for «Магнит», and `fence-1` for «Пятёрочка». The source files stay in `client/assets/ads/`; `npm run sync-ads` copies them to `public/ads`. A replacement PNG takes priority over JPG. No perimeter or floating center ad is rendered.

## Map editor

- Open `http://localhost:5173/editor.html` while the development containers are running. The editor shows a 2D top-down plan; drag blocks, platforms with ramps, swamp/ice zones, trampolines, six spawn points, and power-up points. Select an object to edit exact coordinates, size, height, radius, or ramp side. The fixed center SUPER core and boundary walls are shown for context.
- **Save map** validates and writes `shared/arena-layout.json` directly when the local editor is opened at `localhost:5173`. The separate save service is bound to host loopback on `127.0.0.1:5174`; the game port has no write endpoint. **Download JSON** always exports the same file; in the production/static editor, Save downloads it because a public web page cannot write server source files. To apply a downloaded map, replace `shared/arena-layout.json` in the project.
- This JSON is the common source for client visuals and Rapier colliders, server collision/surface/spawn calculations, and editor coordinates. The validator rejects out-of-bounds objects, invalid ramps, blocked spawns/trampolines, and pickup markers buried in tall solids or ramps. It allows at most three pickup markers with distinct coordinates and requires at least six distinct spawn points for a full room. Test access to each object manually: the validator cannot prove that every route is playable.
- The four shopfronts follow the first four platform entries in the map. They are decorative and add no colliders. Fighters can run under the raised part of a ramp where their capsule fits; the low part of the ramp and the platform block remain solid.
- The three neutral pickup positions are shared. The server chooses shield, speed or fast charge with equal chances on collection and replicates availability and effect deadlines to all clients. The separate timed center SUPER core keeps its x2 next-shot effect.
- After saving in development, run `docker compose restart server` and reload the game page. Running rooms do not change their map in place. For production, rebuild the client/server image from the updated JSON and redeploy it before the new map appears online.

## Production deploy (VPS)

- Topology: Caddy (`caddy:2-alpine`, service `caddy`, container `kaban-caddy`) listens on host ports 80/443 (+443/udp for HTTP/3) and reverse-proxies to the game container (`kaban-arena:2567`) on the default compose network; the game container also keeps host port `2567:2567` as a direct legacy path (page + ws). WebSocket upgrade (Colyseus) is forwarded automatically by Caddy's `reverse_proxy`.
- `https://kaban.wpgg.ru/` (A record → VPS IP): auto-HTTPS via Let's Encrypt with built-in auto-renew (no email configured — Caddy default ACME registration); plain-http on :80 redirects to https automatically. Raw-IP access `http://185.188.182.46/` keeps working through a scheme-only `http://` catch-all (port 80, any host, no TLS) in `Caddyfile`.
- Files: `Dockerfile.prod` (multi-stage: client build → server build → `node:20-alpine` runtime with prod deps only), `docker-compose.prod.yml` (services `kaban-arena` + `caddy`, named volumes `caddy_data`/`caddy_config` persist certs across recreation), `Caddyfile` (mounted read-only into the proxy); dev `docker-compose.yml` / `Dockerfile.client` / `Dockerfile.server` are untouched.
- Build the image locally (the VPS is too small to build on): `docker build -f Dockerfile.prod -t kaban-arena:prod .`
- Transfer + load on the server: `docker save kaban-arena:prod -o kaban-arena-prod.tar` (pipe-free; gzip separately if wanted), copy over, `docker load -i kaban-arena-prod.tar`.
- Start: `docker compose -f docker-compose.prod.yml up -d --no-build` (also pulls `caddy:2-alpine`, ~50MB, fine on the 709MB-RAM VPS; `--no-build` fails loudly if the `kaban-arena:prod` image was not loaded — compose must use the prebuilt image, never silently build a different one on the VPS).
- Verify: `https://kaban.wpgg.ru/` serves the game (browser must show `wss://` socket, no mixed-content block), `https://kaban.wpgg.ru/health` returns `{"ok":true}`, `http://185.188.182.46/` + `http://185.188.182.46/health` still work; the client auto-connects same-origin with no port on proxied pages (`wss://` on https, `ws://` on http).

## Repo map

- `client/src/engine/Engine.ts` — renderer/scene/loop owner, pixel-ratio clamp on init + resize (`:29,:51`), full cleanup on dispose.
- `client/src/engine/SceneManager.ts` — follow camera (FOV 75, 5m distance: `client/src/config.ts:7-8`), spectator hover cam, fog (`:173`), moon + 100-point starfield (`:891-934`), aim angles, combat FX wiring (death burst, hit flash, camera shake).
- `client/src/engine/InputController.ts` — keyboard via `e.code` (layout-independent WASD, `:8-25`), right-mouse camera deltas, typing-focus guard, clean attach/detach.
- `client/src/ui/joystick.ts` — transparent look-through stick (`JOYSTICK_OPACITY 0.4`, `client/src/config.ts:20`); dual-stick: left move 140px + right aim 160px with expo (`client/src/config.ts:241-243`), plus floating right-half aim zone.
- `client/src/arena/Arena.ts` — low-poly neon-warehouse arena; 8 obstacle blocks, 4 asymmetric platform hills with one-sided ramps (1.8-2.6m).
- 2 swamp zones, 2 ice zones on the opposite diagonal, and 2 center-lane trampolines (`client/src/arena/Arena.ts`); repeated shapes use `InstancedMesh`.
- `client/src/fx/AvatarVisuals.ts` — hand-held ball in anatomical right hand, 7 Mii-style face decals (128px canvas cache, session-id hash pick), two-tone clothing (shirt = identity color, pants = hash palette), South-Park hop (2.5-4 hops/s, mulberry32 lean/drift/yaw).
- `client/src/fx/Balls.ts` — pooled ball rendering (`MAX_LIVE_BALLS 12`, per-slot trail sprites, shared glow texture) + exponential interpolation (`BALL_LERP_RATE 20`, snap >6m).
- `client/src/net/NetworkManager.ts` — Colyseus client, `decodeSnapshot` (`:121`), room-full forwarding, spectator/ready flow.
- `client/src/net/protocol.ts` — wire helpers mirroring the server: `buildFirePayload` (`:207`), `muzzleForShot` (`:305`), `directionFromYawPitch` (`:279`), `worldMoveFromYaw` (`:120`), `halvesForHp` (`:148`).
- `client/src/net/protocol.ts` — wire helpers mirroring the server: `buildFirePayload` (`:207`), `muzzleForShot` (`:305`), `directionFromYawPitch` (`:279`), `worldMoveFromYaw` (`:120`), `halvesForHp` (`:148`).
- `client/src/net/interpolation.ts` — remote-avatar lerp/slerp smoothing (`LERP_SMOOTHING 10`, snap >6m).
- `client/src/net/RemoteAvatars.ts` — remote bodies (shared capsule geometry, per-player color/face/hop via `AvatarVisuals`).
- `client/src/net/aimAssist.ts` — subtle deterministic aim pull (18m, 12-degree cone, 0.5 blend; server hit radius unchanged).
- `client/src/physics/World.ts` — Rapier world wrapper (fixed-step accumulator, colliders mirror `Arena` visuals, slippery/trampoline hooks).
- `client/src/arena/PowerUps.ts` — neutral pickup visuals and client prediction mirror of server-selected effects.
- `client/src/fx/Particles.ts`, `client/src/fx/CameraShake.ts` — pooled hit particles (pool 128, burst 24) + hit flash (0.18s) + light camera shake.
- `client/src/ui/aim.ts`, `client/src/ui/hud.ts` — dotted trajectory preview + Worms-style power bar; DOM HUD (timer, score, 4 hearts as 0-8 halves, separate shield heart, active bonus icons/timers, killfeed, super badge, reload bar).
- `server/src/rooms/ArenaRoom.ts` — authoritative movement, ball ballistics, damage, round FSM (lobby/countdown/playing/ended), respawns, rematch, super-core lifecycle.
- `server/src/bots.ts` — server-side weak-bot AI (charge 0.3-1.0s, 2.5s cooldown, zero spray).
- `server/src/hits.ts` — muzzle/damage math: `muzzleForShot`, `chargeToPower01`, `powerToSpeed`, `damageForPower`, thrower-Y derive/clamp, hitscan validation.
- `server/src/state.ts` — `@type` schema: `PlayerState` (pos/rot/hp/score/alive/bot/ready/spectator/superBuff/reloadUntil/shield/speed/charge), `BallState`, `PickupState`, `ArenaState` (phase, balls/pickups maps, super-core fields, server clock).
- `client/src/main.ts` — wiring: Engine + SceneManager + InputController + NetworkManager + joystick/HUD/aim; nick focus guard, Play/spectator flow, charge/fire/reload loop.
- Tuning lives in `client/src/config.ts` (display mirrors) and `server/src/config.ts` (authoritative); charge/speed/gravity/muzzle numbers must stay identical on both sides.
- Tests live next to sources (`*.test.ts`, vitest): client 17 files / server 5 files; perf-critical invariants are pinned (pixelRatio clamp, charge/damage mapping, muzzle sync, ice friction band).
- Combat flow: client charges locally -> release builds fire payload (power01/yaw/pitch/super/throwerY) -> server validates reload gate + spawns authoritative ball -> `stepBalls` integrates, checks platform tops, ground, victims -> `applyHit` scores.
- Thrower elevation: server movement is XZ-kinematic; body-center y is derived from platform tops + clamped client `throwerY` (`hits.ts:146-189`).
- Self-hit arming: newborn balls ignore their owner within 1.0m / 0.3s (`server/src/config.ts:76-77`); max 12 live balls.
- Death: victim keeps corpse hidden, respawns after 3s with full HP + 2s invuln at a spawn slot (`hits.ts:286-295`); 6 spawn points (4 corners + 2 mid-lane).
- Kill feedback: 30-particle death burst (yellow/orange/red) + hit flash + light camera shake (QD4-A).

## Gameplay model

- Server-authoritative; client prediction-lite: world-space move intents + `reconcileSelf` XZ easing toward snapshot (`SELF_RECONCILE_MIN_M 0.7 / SNAP 6m / RATE 8`, `client/src/config.ts:125-127`).
- Damage: 100 HP / FULL 25 / WEAK 12.5 = 4 hearts shown as 0-8 halves (`server/src/config.ts:30-37`); hit +1 point, kill +10.
- Charge throw: hold to charge, `CHARGE_MAX_S 1.0` -> power01 [0.5, 1.0]; `RELOAD_MS 2500`; FULL threshold 0.8; tap <0.08s never fires (`server/src/config.ts:40,50-51`, `client/src/config.ts:234`).
- Ballistics: speed 11-20 by power, gravity 3.5 lob, chest-exit muzzle 0.7m along aim dir, torso offset +0.3 (ground spawn y 1.4); zero spray; recoil kick 0.4-0.8m.
- Super core: center spawn every 45s, 15s life, blink last 3s, 1.7m pickup; buffs NEXT shot x2 (consumed even on miss).
- Three neutral pickup points: each awards speed x1.25 for 5s, a shield that absorbs 25 damage for up to 10s, or fast charge for 10s (the next valid shot reaches full power in 0.5s instead of 1s); each point respawns 30s after collection. The server owns grants, deadlines and next-shot consumption. A compact overhead SVG badge announces the effect for 1.5s; the HUD shows each active bonus and its remaining time. A short curved wind wake appears only while a grounded fighter runs with the speed bonus; ordinary running and standing with a bonus show no wind.
- Scene light follows the server's three-minute round clock. Daytime light colors and brightness retain the former 2:40 sample through 1:15 remaining; the new sky backdrop grades from a pale blue-green horizon to a colder blue zenith along world up. A smooth 15-second transition passes through red-gold sunset and reaches the accepted night at 1:00 remaining, holding it through round end. Night light intensities retain the Stage 11 gain of 1.06 × 1.15 over the former 0:12.5 sample. The sun and moon follow their accepted tilted orbit; their visible diameters are now 50% and 70% of Stage 11, and the moon keeps moving throughout the final minute. Two thick/dense and two wispy asymmetric cloud variants share a 128×128 atlas across ten irregularly placed planes in one batch, fading by night. Shop porches and fireflies appear during the final minute without adding light sources. Porch emission and glow are a further 20% stronger than Stage 11, with compact luminous fixture cores and the accepted halo reach and soft floor falloff. A new round restores daytime. The player-facing interface is Russian.
- Trampolines: trigger band y 1.7, cooldown 0.5s. Swamp: 0.22 movement speed, no glide, 15% smaller radius than the old ice circles. Ice: 0.65 movement speed, low friction (0.07), quick input acceleration, gentle coast, and a 0.06 input deadzone for touch-stick drift.
- Round loop C2: lobby countdown 3s, respawn 3s, invuln 2s; late join till round end; rematch reset 5s after end.
- Room guards: human-entry-counted capacity (bots ignored), explicit `room-full` reject, `ensureBots` capped by `players.size < MAX_PLAYERS`.
- Controls: left stick moves, right thumb/floating zone aims (camera follows aim while charging); desktop WASD + hold-right-mouse camera; Space/FIRE hold also charges.

## Hard constraints

- Always `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))` via `getClampedPixelRatio` (`client/src/perf.ts:3-8`, used in `Engine.ts:29,51`); fallback to 1.0 planned under sustained <45fps.
- `InstancedMesh` for all repeated objects (walls, strips, blocks, platform tops, puddles, trampolines, spawns, ad frames).
- Max 1 directional + 1 ambient light (`SceneManager.ts:175,178`), no heavy post-processing; sky/fog cheap (`MeshBasicMaterial`, `THREE.Points`, `THREE.Fog`).
- HUD as DOM overlay (`client/src/ui/hud.ts`), never WebGL text; keep draw calls low (target <=60).
- No secrets committed: `.env`, `*.key`/`*.pem`, tokens gitignored (`.gitignore:6-12`); never paste values into code, logs, or prompts.
- Strict TypeScript: `@typescript-eslint/no-explicit-any` is an error (`.eslintrc.json:19`); no `any`, no placeholder imports; named constants in `config.ts`, not literals.
- Cleanup discipline: listeners, geometries, materials disposed on room leave / scene reset (`Engine.dispose`, `SceneManager` disposables).
- Shadow map <= 1024 (`SHADOW_MAP_SIZE`, `client/src/config.ts:44`); no per-frame allocations in hot paths (pooled balls/trails/particles, scalar-only anim math).

## Status and roadmap

- Stage 1 done: Docker infra + monorepo skeleton + CI checks (typecheck/lint/test/build green).
- Stage 2 done: Engine / SceneManager / InputController + transparent joystick + `e.code` WASD + right-mouse camera + DOM HUD.
- Stage 3 done: neon-warehouse arena + Rapier physics + power-ups + beauty-perf compromise + shopfront ads (`client/assets/ads/`).
- Stage 4a done (2026-09-12): pre-join spectator (hover cam, plate, Players/Watching counters, bots only for ready fighters).
- Stage 4b done (2026-09-12): cannon combat (charge/release, halves HUD, super core, dual-stick, reload).
- Stage 4c done (2026-09-12): throw polish (trajectory dots + Worms bar, two-tone cores, no spray, 140 tests).
- Stage 4d.1 done (2026-09-17): avatar hand-ball + Mii faces + two-tone clothing + South-Park hop; torso-height throw (spawn y 1.4 ground), 218 tests green.
- Note: Stage 4 boxes (rooms/round/bots/interp) in `MAP.md` stay open pending owner live-playtest sign-off (2-6 clients, late join, <5min round, rematch).
- Perf budgets enforced in Stage 5: draws <=60, textures <=512 single atlas, build <15MB, audio <300KB, 20 ticks/s (`MAP.md` Stage 1/5).
- Current stage (2026-09-30): the owner approved Stage 12 after manual playtesting and authorized committing and pushing the combined Stage 10–12 changes. Stage 12 adds another 20% porch-light intensity increase with luminous fixture cores, thick/dense and wispy irregular clouds, sun/moon diameters reduced by 50%/30% and a world-up daytime sky gradient (`plan.md`, `map.md`). Both typechecks, linters and builds, 488 client and 198 server tests, local Docker HTTP checks and four independent scene/shader/geometry/lifecycle scenarios passed. The approved lighting intensities, orbit and 1:15–1:00 transition schedule are retained. All three local services are running. Device-specific playtesting and FPS/draw-call measurements were not separately reported; the VPS was not updated.
- Product direction: this is the foundation of a casual PvP arena for friends. The owner plans to design roughly 10–15 active items inspired by Worms in addition to the central super core; those items are outside Stage 10.

## Agent memory note

- This repo is developed with AI agents. If `AGENTS.md` / `MAP.md` / `LOG.md` / `LOG-ARCHIVE.md` exist next to the repo (gitignored by design, `.gitignore:1-4`), read them first.
- `AGENTS.md` = binding rules (permissions, secrets, perf, stages, git). `MAP.md` = repo map + stage plan (section 0 every session; code wins on conflict). `LOG.md` = session log with Current state (Last step / Next). `LOG-ARCHIVE.md` = compressed old history, read only on doubt.
- One stage at a time, owner go-ahead before each; update `LOG.md` Current after every stage; 2 consecutive launch failures -> stop and ask for reviewer.

## License and owner

- Owner: @jadykov; private repo, deploy via deploy key (read-write).
- Key value is never stored in the repo/files/LOG: passed via SSH file outside the repo or env/Docker mount; git URL pending owner (`MAP.md` decisions).
