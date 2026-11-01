# Overhead

Every active satellite in orbit, in the place it is right now, on a 3D Earth you can turn. Pick a city to see what passes over it next.

**Try it: [https://mithulpranav24012008.github.io/overhead/](https://mithulpranav24012008.github.io/overhead/)**

Built with Three.js, Vite and [satellite.js](https://github.com/shashwatak/satellite-js).

## What you can do

- **Turn the Earth** and click any dot to see what it is: its fleet, height, speed, what it is over, how long one orbit takes, when it was launched and whether it is in sunlight.
- **Pick a city** (or use your location) for a map of the sky above it, and the next passes you could look for. A pass counts as one you could see when the satellite is sunlit at its highest and your sky is dark.
- **Find a satellite** by name, such as ISS, Hubble or Starlink-1007.
- **Light up a fleet**, and move a ceiling to see how many fly lower than a given height.
- **Speed up time** to one or ten minutes a second, and go back to now.
- **Use the keyboard.** Every control is a real button or field.

## How it works

- **Positions** come from the SGP4 orbit model, run in your browser for the current second, from the public orbit data published by [CelesTrak](https://celestrak.org). Typically they are within a few kilometres for a fresh orbit, and the error grows by a kilometre or more a day.
- **The catalogue** in `public/catalogue.json` is a snapshot of 16,847 active objects fetched on 2026-11-01. The page works out whether it is older than a day and, if so, tries to fetch a newer one once a day.
- **The worker.** `src/worker.js` computes two positions for every object, and the GPU blends between them in a shader on a `THREE.Points` object, so thousands of points move smoothly without being recomputed every frame. If workers aren't available, the same work runs on the main thread.
- **Day and night** on the globe, and which satellites are in Earth's shadow, come from the Sun's real position.
- **Render on demand.** An idle page draws about 12 frames a second.
- **The logic is kept apart from the 3D.** `src/orbit.js` has no Three.js in it, and `test/orbit.test.mjs` covers it.

## Run it

You need [Node.js](https://nodejs.org) 18 or later.

```bash
npm install
npm run dev       # the site, with live reload
npm test          # the orbit maths
npm run build     # the production site, written to dist/
npm run data      # fetch a new orbit catalogue from CelesTrak
```

Please don't run `npm run data` more than once every two hours, because CelesTrak updates that often and blocks heavy use. It writes `data/active.json` and `public/catalogue.json`. The tests read `data/active.json`, which in this repository is the snapshot from 2026-11-01.

## What hasn't been checked

I tested it on the production build in a real browser at desktop and phone widths. I haven't tried it on real phones, watched the motion at full speed, or tested the daily refresh or `npm run data` against CelesTrak.

"Active" leaves out rocket bodies, dead satellites and debris, and some classified satellites aren't in the public list.

## Credits

- Orbit data: [CelesTrak](https://celestrak.org).
- Coastlines: [Natural Earth](https://www.naturalearthdata.com), through the `world-atlas` package.
- Orbit model: [satellite.js](https://github.com/shashwatak/satellite-js).

The photographs belong to their authors and keep their own licences. The Sputnik replica is share-alike.

| File | Work | By | Licence |
|---|---|---|---|
| `assets/view-of-hubble-after-being-released-from.jpg` | [View of Hubble after Being Released from the Shuttle Atlantis (28223588012)](https://commons.wikimedia.org/wiki/File:View_of_Hubble_after_Being_Released_from_the_Shuttle_Atlantis_(28223588012).jpg) | NASA Hubble Space Telescope | [public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| `assets/sts-134-international-space-station-after-undocking.jpg` | [STS-134 International Space Station after undocking](https://commons.wikimedia.org/wiki/File:STS-134_International_Space_Station_after_undocking.jpg) | NASA | [public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| `assets/starlink-uber-dem-rathaus-in-tubingen.jpg` | [Starlink über dem Rathaus in Tübingen](https://commons.wikimedia.org/wiki/File:Starlink_%C3%BCber_dem_Rathaus_in_T%C3%BCbingen.jpg) | Dktue | [CC0](https://creativecommons.org/publicdomain/zero/1.0/deed.en) |
| `assets/replica-of-sputnik-1-world-museum-liverpool.jpg` | [Replica of Sputnik 1, World Museum Liverpool (4)](https://commons.wikimedia.org/wiki/File:Replica_of_Sputnik_1,_World_Museum_Liverpool_(4).JPG) | Rept0n1x | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0) |

## Licence

[MIT](LICENSE) for the code. The photographs above and the CelesTrak data are not covered by it.
