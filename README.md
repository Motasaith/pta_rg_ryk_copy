# LOST & FOUND — Rahim Garden City

An open-world, GTA-style browser game set in Rahim Garden City, R.Y. Khan.
Next.js (static export) + three.js + a purpose-built collision/vehicle engine.
No art assets, no WASM physics library, no server: the entire city is generated
in the browser at load time and the whole deploy is ~1.3 MB (≈380 KB gzipped).

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # headless physics / layout / AI tests (no browser needed)
npm run build      # static export into out/
npm run cf:deploy  # build + wrangler pages deploy out
```

## Deploying to Cloudflare

The whole thing is **one Worker**. It serves the static game for every normal request and
handles the small multiplayer API itself.

> **This replaces the old Pages deployment.** A Pages project *cannot* define a Durable
> Object, and the game rooms and lobby are Durable Objects, so Pages cannot host this.
> Cloudflare's own guidance is to migrate Pages projects to Workers.

### First deploy

```bash
npx wrangler login              # once per machine
npm run cf:deploy               # next build && wrangler deploy
```

That prints a public URL — `https://rahim-garden-city.<your-subdomain>.workers.dev` — which
anybody in the world can open. The Durable Object namespaces are created automatically from
the `migrations` entry on that first deploy.

Then enable the admin dashboard:

```bash
openssl rand -base64 24         # copy the output
npx wrangler secret put ADMIN_TOKEN
```

### Retire the old Pages project

The Pages project keeps serving the **old** build at its own URL until you deal with it, so
you would have two different versions live. In the Cloudflare dashboard:

1. Move any custom domain off the Pages project (Workers & Pages → your Worker →
   Settings → Domains & Routes → Add custom domain).
2. Delete the Pages project, or leave it as an archive if you prefer.

### Day to day

```bash
npm run dev        # game only, fast reloads — NO multiplayer (there is no Worker)
npm run cf:dev     # build + run the real Worker locally, multiplayer works
npm run cf:deploy  # ship it
```

`npm run dev` cannot serve `/api/*`, so the ONLINE tab will never connect there. Use
`cf:dev` to test multiplayer locally, and remember that a local URL is only reachable from
your own machine — friends need the deployed one.

If `cf:dev` fails to start, run `npm approve-scripts` once: npm defers `workerd`'s
installer, and `wrangler dev` needs that binary.

### Cost

Free plan throughout. Durable Objects have been on the Workers Free plan since April 2025,
**with the SQLite storage backend only** — which is why `wrangler.jsonc` uses
`new_sqlite_classes`. There is no database and nothing is stored.

## Controls

| Input          | Action                                        |
| -------------- | --------------------------------------------- |
| `W A S D`      | move, relative to where the camera is looking |
| `SHIFT`        | sprint                                        |
| `SPACE`        | jump · handbrake in a vehicle                 |
| mouse          | look (pointer lock)                           |
| RMB (hold)     | aim down sights                               |
| LMB            | fire · punch                                  |
| `1 2 3 4`      | fists · pistol · SMG · shotgun                |
| `R`            | reload                                        |
| `E`            | enter/exit vehicle, buy from a shop           |
| `H`            | horn                                          |
| `TAB` / `M`    | full map                                      |
| `J`            | start / end a side job (in a taxi, cruiser or van) |
| `` ` ``        | cheat console                                 |
| `ESC`          | pause (also releases the mouse)               |

Every key is rebindable in Pause → Controls, along with mouse sensitivity,
separate aim sensitivity and invert-Y.

### Cheats

The backtick key opens a prompt; type a code and press `ENTER`, or click one of
the suggestions. Cheats deliberately do **not** work by typing them blind into
the world: on a keyboard every letter of HESOYAM is already a gameplay bind, so
spelling one out mid-game emptied a magazine into a wall instead of granting
anything. While the prompt is open the world keeps rendering but every gameplay
bind is dead and the mouse is free.

`HESOYAM` health, armour and Rs.250,000 · `BAGUVIX` unlimited health · `FULLCLIP` max ammo ·
`LEAVEMEALONE` clear the wanted level · `BRINGITON` five stars · `SPEEDFREAK` run
twice as fast · `PANZER` spawn a cruiser · `GETTHEREFAST` spawn a hypercar ·
`ROCKETMAN` launch yourself · `BIGBANG` detonate nearby traffic · `TIMEFLIES` skip
six hours · `WALKONWATER` stop drowning · `TAKEMETOTHEPUL` warp to the big bridge ·
`TAKEMEHOME` warp to your front door · `TAKEMETOSPRAY` warp to a respray bay ·
`SCATTERSTORM` bring the monsoon · `ANDYELLOWSKY` bring a dust storm · `BLUESKIES`
clear it up.

> `J` rather than `2` for side jobs: you can shoot from a car, so the number row stays
> the weapon wheel. It is rebindable in Pause → Controls like everything else.

## Multiplayer and builds

Two rules, both enforced on the wire:

- **A room has one map, chosen by the first player through the door.** It goes out in the
  Hello frame and comes back in every Welcome; a joiner adopts it whatever they picked on
  the title screen, and the online panel shows which map the room is on. Join a room after
  your own world is already built and the map disagrees, and you are disconnected with an
  explanation rather than dropped into a different city with everyone else's cars driving
  through your buildings.
- **Everyone must be on the same build.** `PROTOCOL_VERSION` was bumped to 3 when maps
  became selectable, so a client running the older single-map build is rejected on
  connect with *"this build is out of date - reload the page"* instead of joining
  successfully and quietly playing a different game.

> The map index on the wire is the position in `THEMES`. **Append new maps; never reorder
> them**, or two clients on different builds will agree on a number and disagree on a city.

If two players say the game looks different on their two screens, the title screen now
carries a build stamp: the asset tally (`14/15 textures - 8/8 models - HDRI ok`) and the
wire version. Downloaded assets fall back to the procedural textures silently when a
fetch fails or times out, so a machine on a slow connection can end up with a flatter
looking city through no fault of the code - and that badge is how you tell.

## Playing on a phone

The game is **landscape-only on mobile**, and it says so out loud, because a browser
page is not allowed to rotate a phone by itself:

- `screen.orientation.lock()` throws unless the document is already **fullscreen**, and
- **iOS Safari does not implement it at all.**

So `game/device.ts` does the only honest thing. Tapping PLAY — a real user gesture,
which both APIs require — requests fullscreen and *tries* to lock to landscape. On
Android that works. On an iPhone it does not, and a **rotate-your-device gate** covers
the screen until you turn the phone, pausing the game behind it so nobody is shot while
reading a notice. Turning back resumes exactly where you were. Installed to a home
screen, the web manifest's `"orientation": "landscape"` handles it properly.

The on-screen pad (`components/TouchControls.tsx`) owns no game state. Every control
writes into the same `Input` the keyboard writes into — a virtual key set plus an analog
stick — so walking, driving, aiming and shooting run the identical code paths they do on
a desktop. Two details worth knowing:

- **The stick floats.** Its centre is wherever your thumb first lands in the bottom-left
  zone, not a painted circle you have to find without being able to see your thumb.
- **Sprint is automatic** past 85% deflection, so there is no sprint button competing for
  the thumb that is already steering. In a car that same deflection does *not* fire the
  nitrous — it has its own button.
- Drags and button holds are tracked on `window`, not with `setPointerCapture`, which
  throws `InvalidStateError` on touch often enough to jam a trigger down.

The HUD rearranges itself around two thumbs: the radar moves to the top-left because the
stick lives bottom-left, the weapon panel moves to the bottom-centre because the buttons
live bottom-right, and safe-area insets keep everything clear of a notch. First run on a
coarse-pointer device also defaults to the **Low** quality preset and a gentler look
sensitivity; both are still yours to change in Pause → Display.

## What is in the game

- **Four maps, one at a time.** The title screen picks the world; only the one you
  chose is ever generated, so nothing you are not playing costs any memory. All
  four run the same generator (`city.ts`) driven by a `Theme` (`theme.ts`) — the
  ground, the trees, the block mix, the building heights and the water:

  | Map | Where | The channel |
  | --- | --- | --- |
  | **Rahim Garden City** | Rahim Yar Khan | the Grand Canal, crossed by the Big Pul |
  | **Thal Desert Outpost** | Thal Desert | a dry wadi you can drive down into |
  | **Murree Pine Valley** | Murree Hills | a cold river through a conifer town |
  | **Karachi Metro** | Karachi | a shipping channel through downtown at night |

  Changing map means restarting, which is what the restart button already does.

- **Weather** — clear, dust haze and heavy monsoon, crossfading over about fifteen
  seconds and cycling on its own. Rain is one `LineSegments` of 2,400 streaks whose fall
  happens entirely in the vertex shader, so the CPU writes one uniform a frame and never
  touches a particle; dust is one `Points` of 900. Wet roads are not a shader or a
  reflection pass — they are a roughness and albedo write on eight ground materials,
  which is enough because the scene already has a real HDRI to reflect. The sun dims, the
  dome goes overcast, the fog closes in, thunder rolls, and **tarmac loses a third of its
  grip**, for the player and the traffic alike. Two draw calls, ~70 KB of vertex data.
  Switch it off in Pause → Game.

- **Five-star police escalation** — beat cops on foot, then cruisers, then **roadblocks**
  (striped barriers, beacons and a spike strip that shreds your tyres and caps you at 42%
  of top speed), then **SWAT enforcers** in black vans with AK-47s and 260 hp, then the
  **search helicopter**: a real aircraft with spinning rotors, an orbiting searchlight
  beam and a pool of light that follows you along the ground. The roadblocks and the
  helicopter are pooled and built once at boot, and the blockade colliders ride the same
  per-frame dynamic list as the traffic, so going from one star to five allocates nothing.
  Break line of sight and **the stars flash** while the level ticks down.

- **Pay 'n' Spray** — a three-walled bay on every car park. Drive in and the car comes out
  repaired, resprayed a new colour and off the police computer. The trigger is a distance
  test against a handful of bays; the whole feature is geometry plus about thirty lines.

- **Street life** — pedestrians drop glowing cash bundles when they go down (police carry
  more), shout at you when you shove them, and *get out of the car you just rammed* to
  square up and swing. Nobody is spawned to do it: the angry driver is a pedestrian
  borrowed from far enough away that nobody saw them leave, so the crowd size never grows.

- **Side jobs** — press `J` in a rickshaw for **fares**, a cruiser for **vigilante** work
  or a van as a **paramedic**. All three are the same two-beat loop — go to the pickup,
  then the drop-off, before the clock runs out — with a tip for hurrying and a rising
  multiplier for keeping the shift going. Nothing is spawned: a fare is a pedestrian who
  already exists and a bust is a traffic car that is already driving around.

- **The Grand Canal and the Big Pul** — every map is cut in two by a 56 m channel
  dug 3–4 m into the world (`Physics.addPit`, so the terrain has a real hole in it,
  not a blue quad laid on the grass), lined with concrete retaining walls and railed
  towpaths, and spanned by four bridges. The boulevard carries the Big Pul: portal
  towers, a fan of stay cables, and a deck at exactly `ROAD_Y` — the same height as
  the road feeding it, one unbroken `Ground` collider bank to bank, so a car rolls
  straight on at speed with nothing to catch a wheel. `tests/world.test.mjs` walks
  the ground height down both lanes of every crossing and fails on any step over
  3 cm. Fall in a wet one and you drown.

- **The map** — two districts joined by the canal, ~440 m x 900 m in total.

  **Rahim Garden Housing Scheme** (south) is the real society, built from its own
  layout plan, at 1:1 in metres: 50' x 103' plots, 30'/40'/50' road hierarchy, the
  70'-wide central park with the masjid on its east end and the community hall and
  parking on its west, the 50' entrance boulevard with the scheme's gate and
  "near Gulshan-e-Iqbal Scheme No. 3" board, and Link Rd along the east edge.
  132 plots, each with a boundary wall, gate posts carrying its **plot number**,
  driveway, courtyard and flat-roofed house with a rooftop water tank. Roughly one
  plot in seven is still vacant with a PLOT AVAILABLE board — encircled plots are
  available, as the banner says. You live on plot 34.

  Both districts are dressed as Pakistani streets, not American ones: overhead power
  lines sagging between timber poles with transformer drums, flat roofs with water
  tanks, satellite dishes and washing out to dry, charpais in the courtyards,
  tandoors and chai stalls on the corners, handcarts, boundary walls with gate
  pillars and sunshades over every window, and bazaar signage that reads
  ZAM ZAM KIRYANA STORE and QUETTA CHAI HOTEL rather than generic shopfronts.

  **Rahim Garden City** (north) is invented, and supplies what a plot scheme has
  no room for: 5x5 blocks of downtown towers, shop rows with signage, a
  supermarket, a police station, a mosque, parks with a pond and a cricket pitch,
  car parks, and a plaza with a clock tower and fountain — plus the wide roads
  that make driving fun.
- **Traffic** — left-hand traffic (as in Pakistan) on a proper lane graph. AI
  cars run the *same* physics as the player, so they understeer, queue, get
  shunted and recover their lane. Jams break themselves up after 5 s.
- **People** — 8–26 pedestrians (quality dependent) with an 11-joint skeleton,
  procedural walk/run/idle/aim/death animation, hit reactions, headshots, blood
  particles and pools, and corpses that persist. The population streams to stay
  near the player instead of spreading thin over 25 blocks.
- **Police** — 5-star wanted level. Firing in public, hitting people or running
  them over raises heat; foot officers and cruisers spawn out of sight and
  pursue. Break line of sight for ~15 s to lose them. Standing next to an
  officer unarmed gets you **BUSTED** (fine + drop-off at the station); dying
  gets you **WASTED** (clinic fee).
- **Vehicles** — nine classes on a real performance ladder, from a 76 km/h
  rickshaw to a 338 km/h hypercar:

  | | rickshaw | truck | van | hatch | SUV | sedan | police | muscle | sports | hyper |
  |---|---|---|---|---|---|---|---|---|---|---|
  | top km/h | 76 | 86 | 130 | 155 | 166 | 180 | 205 | 223 | 256 | **338** |
  | 0–100 | — | — | 9.2s | 6.6s | 5.8s | 4.8s | 3.7s | 3.0s | 2.3s | **1.6s** |

  The truck is a **Bedford jingle truck** — six wheels, a carved crown over the cab,
  mudflaps, a chain fringe along the tailgate, and painted panels using a procedural
  truck-art texture (colour bands, mirrored rosettes, teardrop petal borders and
  mirror chips). It is 8.6 m long and handles like it.

  Hold **Shift** for nitrous — a few seconds of extra pull that also lifts the rev
  limit (sports 256 → 294, hyper 338 → 408 km/h), then recharges. Aero drag is
  derived from each class's top speed, so the quoted number is the real terminal
  velocity, and a tyre cornering limit caps the turn rate with speed: a hypercar
  at 330 km/h cannot pivot like a shopping trolley, but parking is still sharp.
  Parked cars can be stolen; the driver is animated at the wheel and leans with
  the suspension. Police burn nitrous to close a gap, so a hypercar is fast but
  not a free pass.
- **Economy & missions** — Mom's list of 8 objectives with map beacons; cash,
  ammo, health and armour pickups; shops selling food (health) and ammo (which
  also unlock the SMG and shotgun).
- **Presentation** — shader sky dome with day/night cycle, sun-following soft
  shadows, procedural PBR textures with world-space-constant tiling, lit windows
  and street lamps after dark, rotating radar plus a full map. Plus a visual pass
  that is deliberately **free at runtime** — no post-processing chain, no second
  scene render, nothing that a laptop on battery will notice:

  - **Baked ambient occlusion.** The collision boxes are voxelised at load and
    per-vertex occlusion is written into the merged geometry's vertex colours:
    inside corners darken, undersides of eaves and balconies darken, and
    everything gets a contact shadow where it meets the ground. Cost at runtime:
    zero. It is just vertex colours.
  - **Derived normal maps.** A Sobel filter over each canvas texture's luminance
    becomes its normal map, so brick, plaster, kerbs and asphalt catch grazing
    light. One extra texture sample per pixel.
  - **Water** — two scrolling samples of a procedural ripple normal map, Fresnel
    (near-transparent looking down, mirror-like at grazing angles), the live sky
    colour as its reflection, a tight sun glint and a wide sheen. One pass.
  - **Wind.** A vertex-shader hook on the already-merged foliage mesh sways
    canopies and leaves trunks still. One uniform write a frame for every tree in
    the world.

## Architecture

```
app/                Next.js App Router shell (one static page)
components/         React HUD, menus, settings — DOM only, no game logic
game/
  engine.ts         orchestrator: player controller, weapons, heat, missions, frame loop
  physics.ts        AABB world + spatial hash: ground query, cylinder resolve, raycast
  layout.ts         geometry batcher, street furniture, road-graph types, plot-number atlas
  theme.ts          what makes one map look like a different place from another
  weather.ts        rain, dust, wet roads and thunder — two draw calls, no extra passes
  police.ts         roadblocks, spike strips and the pooled search helicopter
  jobs.ts           taxi / vigilante / paramedic shifts on one shared state machine
  device.ts         touch detection, fullscreen and the landscape lock (and why it fails)
  input.ts          keyboard + mouse + the virtual/analog layer the on-screen pad writes
  maps.ts           the map roster; builds only the one the player picked
  city.ts           the grid districts, the canal and its bridges — driven by a theme
  scheme.ts         the real Rahim Garden housing scheme, authored from its layout plan
  humanoid.ts       11-joint character rig + procedural animation
  vehicle.ts        bicycle-model arcade vehicle physics + car models
  traffic.ts        lane-graph vehicle AI (drives the same physics as the player)
  peds.ts           pedestrian/police AI, damage, death, population streaming
  combat.ts         authoritative bullet raycast, blood, decals, tracers (all pooled)
  camerarig.ts      third-person spring arm, over-shoulder aim, recoil, shake
  materials.ts      canvas-generated textures and the shared material set
  sky.ts audio.ts minimap.ts settings.ts hudstore.ts
scripts/smoke.mjs   compiles game/ to ESM and runs tests/ in Node
tests/              headless assertions (see below)
_archive/           previous versions, kept for reference
```

Choices worth knowing about:

- **React never touches the render loop.** The engine writes to a tiny external
  store (`hudstore.ts`) which shallow-diffs before notifying, so a 60 Hz game
  loop does not cause 60 React renders a second.
- **The game logic imports no WebGL.** That is why `npm test` can build the whole
  city, run a minute of traffic and AI, and fire bullets in plain Node.
- **Everything static is merged.** The entire city is ~14 draw calls; a character
  is 11 (one shared vertex-coloured material for every human in the scene).
  Bullets, blood, dust, tracers and decals are pooled — nothing is allocated per
  shot.
- **Movement is sub-stepped.** Steps are subdivided by distance travelled, so
  nothing tunnels through a wall at any frame rate, and every smoothing call is
  exponential (frame-rate independent).
- **Pretty is not the same as expensive.** Every visual upgrade above is either
  baked at load time (AO), authored into a texture (normal maps), or a handful of
  instructions in a shader that was already running (water, wind). There is no
  EffectComposer, no SSAO pass, no planar reflection and no shadow cascade,
  because the target is an ordinary laptop during a coffee break, not a GPU
  benchmark.
- **Quoted numbers have to be true.** A vehicle's `maxSpeed` is calibrated
  against its own aero drag so it is the actual terminal velocity — the tests
  drive every class flat out for 90 seconds and check. This started as a bug:
  rolling resistance grew linearly with speed and swamped the engine, so *every*
  car in the game topped out at 39 km/h regardless of its spec.
- **Nothing is scattered at random.** Both districts place props against an
  explicit zoning rule — the city against its road/pavement/lot bands, the scheme
  against its plan-derived plot rows — and the tests assert that no building,
  tree, lamp, vendor, spawn point or pedestrian waypoint ever overlaps a
  carriageway. That is checked against the generator's own road data, so it covers
  the scheme's 9 m streets as well as the city's 16 m ones.
- **One road graph, no grid assumptions.** Traffic picks its next turn
  geometrically rather than from grid indices, and each edge carries its own
  carriageway width, so cars keep left correctly on a 30' scheme street and on a
  city arterial alike.
- **One key press fires one action.** Handlers run in sequence within a frame and
  all read the same key edge, so acting on a press consumes it. Without that,
  tapping E in a car exits the vehicle and the interaction pass immediately puts
  you back in — a bug that looks like "E doesn't work".
- **The camera and the character are coupled.** The head and chest track where the
  camera is looking (split between neck and spine, because turning the head alone
  past ~70° looks like an owl), and standing still with the camera swung round
  behind you makes the character shuffle to face it. GTA does not auto-rotate the
  on-foot camera either — what was actually missing was the character *looking*
  where you look.
- **Aiming is analytic.** Bullets come from a hand-written ray against the
  collision grid and character spheres — the player is never a candidate, and the
  camera sits over the right shoulder, so the crosshair cannot land on your own
  head.

## Performance

Three presets (Pause → Display) change pixel ratio, shadows, draw distance, crowd
size and prop density. Adaptive resolution then protects the frame budget: if the
average frame goes over ~19 ms the render scale drops (never below 0.66) and
recovers when there is headroom. Turn on Show Performance for a live
FPS / draw-call / triangle readout.

Medium preset, measured: ~141 k static triangles, ~1000 colliders, city generated
in ~270 ms, 261 kB of JS on first load.

## Tests

`npm test` compiles the game modules and runs two headless suites:

- **`tests/world.test.mjs`** — collision primitives (push-out, step-up, ground
  snapping, ray hits, line of sight), model integrity (every rig/vehicle/weapon
  merges correctly, muzzles sit in front of grips) and **layout invariants**: all
  ~1000 buildings/trees/lamps/walls are proven not to overlap any road, and no
  pedestrian route, shop, objective, pickup or parking bay sits on tarmac.
- **`tests/gameplay.test.mjs`** — vehicle handling (cannot pivot on the spot,
  drives straight, steer sign, wall crashes, handbrake slides), a full minute of
  traffic and pedestrian simulation (cars stay on the road, nobody walks into a
  building, no NaN), headshot vs body-shot detection, death and panic
  propagation, and police pursuit + fire.

## Not included

Being explicit about the gaps rather than pretending:

- **No building interiors.** Buildings are solid; there is no enterable house
  like the single interior in the original prototype.
- **No train, plane, bus or bicycle.** The original had them as set pieces; this
  version has seven road vehicles instead. The vehicle system is data-driven
  (`SPECS` in `game/vehicle.ts`), so adding more is mostly a spec entry plus a
  mesh builder.
- **Desktop only.** The HUD is responsive, but there are no touch controls or
  gamepad support and the game needs pointer lock.
- **Death is procedural, not ragdoll.** Bodies collapse convincingly but do not
  tumble down stairs.
