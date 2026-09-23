# KABAN ARENA

## Project

- KABAN ARENA: browser-based 3D multiplayer mobile-first arena game.
- FFA (every-man-for-himself), 2-6 players per room; solo players get up to 4 weak bots (`server/src/config.ts:6-10`).
- Guest flow, no auth: pick nick + press Play; empty nick falls back to `Guest-XXXX`; late join mid-match till round end.
- Short rounds: first to 100 points OR 3 min timer, hard cap under 5 min (`server/src/config.ts:23-28`).
- Performance priority over graphics: stable ~60fps target on mid phones (mid Android 2021, iPhones 14/15/16).
- Art: stylized low-poly neon-warehouse arena (dark floor + neon accents, readable in sunlight) + changeable fence/banner ads from `client/assets/ads/`.

## Stack

- Monorepo with root npm workspaces (`client`, `server`; `package.json:7-10`).
- `client/`: Vite + TypeScript + Three.js + Rapier3D WASM (`@dimforge/rapier3d-compat 0.20.0`) + TailwindCSS DOM-overlay HUD (`client/package.json:15-31`).
- `server/`: Node.js + TypeScript + Colyseus authoritative server, room name `arena` (`server/src/index.ts:20`, `client/src/config.ts:108`).
- Netcode: inputs-only upstream at 20 ticks/s (`client/src/config.ts:109`), sim + patches at 20/s (`server/src/config.ts:13-14`), delta state sync via minimal `@type` schema (`server/src/state.ts`).
- Docker for dev/run/test: `Dockerfile.client` (EXPOSE 5173), `Dockerfile.server` (EXPOSE 2567), `docker-compose.yml`.
- Node >= 20 (`package.json:24-26`); shared base tsconfig (`tsconfig.base.json`), per-package `tsconfig.json`.
- Client physics runs Rapier3D WASM decoupled at fixed 60Hz (`client/src/config.ts:48-49`); avatar steering blends (ground accel 24, ice accel 3.0) so knockback/ice slide survive.
- Pre-join spectator: boot connects as spectator (hover cam + plate + counters); Play spawns with 100 HP.

## Run

- `docker compose up --build -d` — client on `:5173`, server on `:2567`; health check `GET /health` returns `{"ok":true}` (`server/src/index.ts:8-14`).
- `npm install` at root (installs all workspaces); Docker images use `npm ci` (`Dockerfile.client:11`, `Dockerfile.server:11`).
- Checks fan out to both workspaces via `--workspaces --if-present` (`package.json:11-17`):
  - `npm run typecheck` — `tsc --noEmit` in client + server.
  - `npm run lint` — `eslint src --ext .ts` in client + server.
  - `npm run test` — `vitest run` in client + server (218 tests green as of 2026-09-17: client 152 + server 66).
  - `npm run build` — client: `sync-ads + tsc + vite build`; server: `tsc -p`.
  - `npm run dev` — client Vite `--host 0.0.0.0 --port 5173`; server `tsx --watch src/index.ts`.
- Local URLs after compose up: client `http://localhost:5173/`, server health `http://localhost:2567/health`.
- After any change: `npm run typecheck` + `lint` + `test` + `build`, then `docker compose up --build -d` and confirm client HTTP 200 + `/health {"ok":true}` (established session cadence, see `LOG.md`).
- Server URL resolution: `VITE_SERVER_URL` env wins, else `ws://<page-host>:2567` (`client/src/config.ts:269-280`); server port from `PORT` env, default 2567 (`server/src/index.ts:79-86`).
- Ads: owner drops `fence-*.png/jpg` + `banner.png/jpg` into `client/assets/ads/`, synced to `public/ads` by `npm run sync-ads`, restart to pick up.

## Production deploy (VPS)

- Single container serves the game client (static `client/dist`) + the Colyseus server on one express port (2567); bundle dir is configurable via `KABAN_CLIENT_DIST` (default `/app/client/dist`, `server/src/index.ts`).
- `Dockerfile.prod` (multi-stage: client build → server build → `node:20-alpine` runtime with prod deps only) and `docker-compose.prod.yml` (service `kaban-arena`, host ports `80:2567` + `2567:2567`, `restart: always`, no volumes) are the only deploy files; dev `docker-compose.yml` / `Dockerfile.client` / `Dockerfile.server` are untouched.
- Build the image locally (the VPS is too small to build on): `docker build -f Dockerfile.prod -t kaban-arena:prod .`
- Transfer + load on the server: `docker save kaban-arena:prod | gzip > kaban-arena-prod.tgz`, copy over, `docker load < kaban-arena-prod.tgz`.
- Start: `docker compose -f docker-compose.prod.yml up -d --no-build` (`--no-build` fails loudly if the `kaban-arena:prod` image was not loaded — compose must use the prebuilt image, never silently build a different one on the VPS).
- Verify: `http://<server-IP>/` serves the game, `http://<server-IP>/health` returns `{"ok":true}`; the client auto-connects to `ws://<server-IP>:2567`.

## Repo map

- `client/src/engine/Engine.ts` — renderer/scene/loop owner, pixel-ratio clamp on init + resize (`:29,:51`), full cleanup on dispose.
- `client/src/engine/SceneManager.ts` — follow camera (FOV 75, 5m distance: `client/src/config.ts:7-8`), spectator hover cam, fog (`:173`), moon + 100-point starfield (`:891-934`), aim angles, combat FX wiring (death burst, hit flash, camera shake).
- `client/src/engine/InputController.ts` — keyboard via `e.code` (layout-independent WASD, `:8-25`), right-mouse camera deltas, typing-focus guard, clean attach/detach.
- `client/src/ui/joystick.ts` — transparent look-through stick (`JOYSTICK_OPACITY 0.4`, `client/src/config.ts:20`); dual-stick: left move 140px + right aim 160px with expo (`client/src/config.ts:241-243`), plus floating right-half aim zone.
- `client/src/arena/Arena.ts` — low-poly neon-warehouse arena; 8 obstacle blocks, 4 asymmetric platform hills with one-sided ramps (1.8-2.6m).
- 2 slippery ice zones + 2 center-lane trampolines (`Arena.ts:164-178`); all repeated shapes as `InstancedMesh`.
- `client/src/fx/AvatarVisuals.ts` — hand-held ball in anatomical right hand, 7 Mii-style face decals (128px canvas cache, session-id hash pick), two-tone clothing (shirt = identity color, pants = hash palette), South-Park hop (2.5-4 hops/s, mulberry32 lean/drift/yaw).
- `client/src/fx/Balls.ts` — pooled ball rendering (`MAX_LIVE_BALLS 12`, per-slot trail sprites, shared glow texture) + exponential interpolation (`BALL_LERP_RATE 20`, snap >6m).
- `client/src/net/NetworkManager.ts` — Colyseus client, `decodeSnapshot` (`:121`), room-full forwarding, spectator/ready flow.
- `client/src/net/protocol.ts` — wire helpers mirroring the server: `buildFirePayload` (`:207`), `muzzleForShot` (`:305`), `directionFromYawPitch` (`:279`), `worldMoveFromYaw` (`:120`), `halvesForHp` (`:148`).
- `client/src/net/protocol.ts` — wire helpers mirroring the server: `buildFirePayload` (`:207`), `muzzleForShot` (`:305`), `directionFromYawPitch` (`:279`), `worldMoveFromYaw` (`:120`), `halvesForHp` (`:148`).
- `client/src/net/interpolation.ts` — remote-avatar lerp/slerp smoothing (`LERP_SMOOTHING 10`, snap >6m).
- `client/src/net/RemoteAvatars.ts` — remote bodies (shared capsule geometry, per-player color/face/hop via `AvatarVisuals`).
- `client/src/net/aimAssist.ts` — subtle deterministic aim pull (18m, 12-degree cone, 0.5 blend; server hit radius unchanged).
- `client/src/physics/World.ts` — Rapier world wrapper (fixed-step accumulator, colliders mirror `Arena` visuals, slippery/trampoline hooks).
- `client/src/arena/PowerUps.ts` — pickup visuals/respawn client-side mirror of server state.
- `client/src/fx/Particles.ts`, `client/src/fx/CameraShake.ts` — pooled hit particles (pool 128, burst 24) + hit flash (0.18s) + light camera shake.
- `client/src/ui/aim.ts`, `client/src/ui/hud.ts` — dotted trajectory preview + Worms-style power bar; DOM HUD (timer, score, 4 hearts as 0-8 halves, killfeed, super badge, reload bar).
- `server/src/rooms/ArenaRoom.ts` — authoritative movement, ball ballistics, damage, round FSM (lobby/countdown/playing/ended), respawns, rematch, super-core lifecycle.
- `server/src/bots.ts` — server-side weak-bot AI (charge 0.3-1.0s, 2.5s cooldown, zero spray).
- `server/src/hits.ts` — muzzle/damage math: `muzzleForShot`, `chargeToPower01`, `powerToSpeed`, `damageForPower`, thrower-Y derive/clamp, hitscan validation.
- `server/src/state.ts` — `@type` schema: `PlayerState` (pos/rot/hp/score/alive/bot/ready/spectator/superBuff/reloadUntil), `BallState`, `ArenaState` (phase, balls map, super-core fields).
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
- Power-ups (set A1): speed x1.3 (6s), shield (1 hit), impulse knockback; respawn 8s.
- Trampolines: impulse 10, trigger band y 1.7, cooldown 0.5s. Ice: friction 0.07, sticky slow (`ICE_SPEED_MULT 0.5`, ice accel 3.0).
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
- Stage 3 done: neon-warehouse arena + Rapier physics + power-ups + beauty-perf compromise + fence/banner ads (`client/assets/ads/`).
- Stage 4a done (2026-09-12): pre-join spectator (hover cam, plate, Players/Watching counters, bots only for ready fighters).
- Stage 4b done (2026-09-12): cannon combat (charge/release, halves HUD, super core, dual-stick, reload).
- Stage 4c done (2026-09-12): throw polish (trajectory dots + Worms bar, two-tone cores, no spray, 140 tests).
- Stage 4d.1 done (2026-09-17): avatar hand-ball + Mii faces + two-tone clothing + South-Park hop; torso-height throw (spawn y 1.4 ground), 218 tests green.
- Note: Stage 4 boxes (rooms/round/bots/interp) in `MAP.md` stay open pending owner live-playtest sign-off (2-6 clients, late join, <5min round, rematch).
- Perf budgets enforced in Stage 5: draws <=60, textures <=512 single atlas, build <15MB, audio <300KB, 20 ticks/s (`MAP.md` Stage 1/5).
- Current next: Stage 4d.2 — camera 4m default + charge zoom ~3.2m held until shot; avatar translucent from charge start until actual shot; dedicated reload bar under power bar (remove `hud-reload` duplicate); ice 1.5x stronger slow (`ICE_SPEED_MULT` 0.5 -> ~0.33); fix flickering top faces of vertical platforms.
- Then 4d.3: central 4 cubes x2 higher, trampoline-only access; glass walls + space (stars + 2-3 cheap nebula sprites); 8 sprite-glow fireflies in groups 1-3, no new lights.
- Then 4d.4: ricochet visual-only after first damaging hit; one previous shot rests on ground (despawn on thrower's next shot OR timeout); victim knockback + pixel blood burst + quick red-orange flash; cores fully tinted in thrower color.
- Then Stage 5: polish + mobile perf pass (60fps on iPhones 14/15/16 + mid Android, build <15MB, audio <300KB via `assets/audio/`) + bugfix/coverage + owner playability sign-off.

## Agent memory note

- This repo is developed with AI agents. If `AGENTS.md` / `MAP.md` / `LOG.md` / `LOG-ARCHIVE.md` exist next to the repo (gitignored by design, `.gitignore:1-4`), read them first.
- `AGENTS.md` = binding rules (permissions, secrets, perf, stages, git). `MAP.md` = repo map + stage plan (section 0 every session; code wins on conflict). `LOG.md` = session log with Current state (Last step / Next). `LOG-ARCHIVE.md` = compressed old history, read only on doubt.
- One stage at a time, owner go-ahead before each; update `LOG.md` Current after every stage; 2 consecutive launch failures -> stop and ask for reviewer.

## License and owner

- Owner: @jadykov; private repo, deploy via deploy key (read-write).
- Key value is never stored in the repo/files/LOG: passed via SSH file outside the repo or env/Docker mount; git URL pending owner (`MAP.md` decisions).
