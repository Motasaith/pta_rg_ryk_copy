# Assets: what is downloaded, what is built, and why

Everything the game draws is either **procedural** (generated in code at load) or a
**CC0 download** cached under `.asset-cache/` and shipped from `public/assets/`. Every
procedural generator is still there behind every download, so the game — and the headless
test suite, which has no network — never breaks when a file is missing.

## Downloaded, in use

| What | Source | Licence |
| --- | --- | --- |
| `models/character.glb` | Quaternius — Universal Base Character | CC0 |
| `models/{sedan,hatch,suv,police,sports,muscle,hyper}.glb` | Quaternius — car packs | CC0 |
| `textures/*` | Poly Haven | CC0 |
| `hdri/urban_street_01_2k.hdr` | Poly Haven | CC0 |
| `audio/*` | OpenGameArt / Kenney | CC0 and CC-BY 3.0 (see `.asset-cache/audio/`) |

## The three vehicles that were asked for, and what is actually available

The request was for a **Suzuki Bolan ("Carry Daba")**, a **Pakistani auto rickshaw** and a
**Bedford truck**. All three were searched for. None of them exists as a free, shippable
model, and the reason is the same in each case: the models that exist are either of the
wrong thing, or under a licence that does not permit shipping them in a game.

### Suzuki Bolan / Carry Daba

| Where | What is there | Why not |
| --- | --- | --- |
| [CGTrader](https://www.cgtrader.com/free-3d-models/car/car/suzuki-carry), [TurboSquid](https://www.turbosquid.com/3d-models/3d-suzuki-carry-minivan-1377802) | Suzuki Carry minivans, free to download | "Royalty Free" / editorial terms, not redistribution. Free *to download*, not free *to ship*. Account required. |
| [Sketchfab](https://sketchfab.com/3d-models/suzuki-carry-minivan-5c0007c0c6ed4d298b8c80646efa09d2) | Suzuki Carry Minivan by ProPolyModels | Login required to download; licence is per-model and not CC0. |
| [poly.pizza](https://poly.pizza/search/van) | Generic vans, CC-BY 3.0, direct GLB download | Downloadable and usable — but they are generic western box vans. A Bolan is a 3.37m kei microvan with no bonnet. Substituting one makes the street *less* Pakistani, not more. |

**Built instead.** `carry` in `game/vehicle.ts`, to the real vehicle's measurements: 3.38m
long, 1.40m wide, 1.84m tall, 1.84m wheelbase, 12-inch wheels, driver over the front axle,
roof rack. It is in the civilian traffic mix and on the wire (`VEH_KINDS`, protocol v4).

### Pakistani auto rickshaw

| Where | What is there | Why not |
| --- | --- | --- |
| [Sketchfab — rSquare](https://sketchfab.com/3d-models/auto-rickshaw-44776bcb34e04c1a8b9c18a70376304e) | **CC-BY 4.0**, 12.6k triangles, genuinely an auto rickshaw | The best option found. Sketchfab requires an account to download, so it could not be fetched here. |
| [poly.pizza](https://poly.pizza/search/tuk%20tuk) | 27 "tuk tuk" results | None of them is one. The two closest are children's tricycles. |

**Built instead**, as it already was — `rickshaw` in `game/vehicle.ts`.

### Bedford truck

Nothing free exists with Pakistani truck art on it, which is the entire point of a Bedford
in this setting. There is a CC0 Quaternius `truck.glb` sitting unused in
`.asset-cache/models/` — a generic western box truck. Wiring it in would *lose* the
procedural truck art (the carved crown, the painted side panels, the chain fringe), so it
stays unused deliberately.

## Dropping a model in later

`OPTIONAL_MODEL_FILES` in `game/assets.ts` already looks for these:

```
public/assets/models/carry.glb
public/assets/models/rickshaw.glb
public/assets/models/truck.glb
public/assets/models/van.glb
```

Drop any of them in and it is used automatically; leave them out and the procedural body is
used. They are deliberately **not** counted by `AssetBank.report()` — a missing optional
model is not a broken install, and telling a player their assets failed because they have
not hand-sourced a rickshaw would be a lie.

If you download the CC-BY rickshaw above, credit is required. Add it here and in the
in-game credits.
