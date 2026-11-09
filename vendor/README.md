# Vendored libraries (unmodified)

| File | Library | Version | License |
|---|---|---|---|
| `leaflet.js`, `leaflet.css` | [Leaflet](https://leafletjs.com/) | 1.9.4 | BSD-2-Clause |
| `hours-libs.mjs` | [opening_hours](https://github.com/opening-hours/opening_hours.js) (OpenStreetMap hours parser) | 3.15.0 | LGPL-3.0-only |
| | with its dependencies [i18next](https://www.i18next.com/) 26.7.2 and [suncalc](https://github.com/mourner/suncalc) 2.1.3 | | MIT / BSD-2-Clause |
| | [tz-lookup](https://github.com/darkskyapp/tz-lookup-oss) (time zone from coordinates) | 6.1.25 | CC0-1.0 |

`hours-libs.mjs` is a plain esbuild bundle of the published npm packages, so it can be swapped for any other build:

```
npm i opening_hours@3.15.0 tz-lookup@6.1.25 esbuild
echo "export { default as OpeningHours } from 'opening_hours'; export { default as tzlookup } from 'tz-lookup';" > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --minify --legal-comments=inline --outfile=hours-libs.mjs
```
