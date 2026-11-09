# Road Trip Stops

A small iPhone web app for road trips: type where you're headed, then search for anything ("Chick-fil-A", "gas",
"restroom", "Walmart"). It only looks **ahead of you on your route** and lists places by **how much time the stop adds**,
so a place right off an exit 20 miles up comes before one 2 miles up that's 5 miles off the highway.
Tap **Add this stop** and Apple Maps opens with the stop added, then your destination.

Save it to the Home Screen from Safari (Share → Add to Home Screen).

**Saved places:** tap ☆ next to any address suggestion, on a search result, or on your destination, or use
**★ Saved places → Add a place** to type an address and give it a name (Home, Grandma's…). Saved places show as
one-tap destination buttons and at the top of the From / To lists. Rename or delete them under ★ Saved places.
They're kept only on this phone (no account).

## How it works
- **Route:** Apple doesn't let other apps read the route planned in Apple Maps, so the app works out the same driving
  route itself from your location (or a typed start) to the destination.
- **Ahead only:** each place is matched to the nearest point of the route. Anything whose nearest point is behind the car is left out.
- **Extra time:** for each place, the app asks the router for: a point on the route a little before the place → the place →
  a point a little after, compared to just staying on the road. Route points are pinned to your direction of travel, so
  "right across the highway" doesn't count as close.
- **Order:** extra minutes + 1 minute for every 20 miles ahead (least first). "Soonest" in Options sorts by distance instead.
- **Exits:** for the first six results, the turn-by-turn directions give the exit (number when OpenStreetMap has it, and the signs).
- **Open now:** from OpenStreetMap opening hours when listed. Ratings aren't in this free data; "See it in Apple Maps" shows Apple's.

## Apple Maps links
Uses Apple's unified Maps URLs (iOS 18.4+): `https://maps.apple.com/directions?destination=LAT,LON&waypoint=LAT,LON&mode=driving`
(no `source` = start from current location). On older iOS the app opens directions to the stop and shows a
**Continue to destination** button for afterwards.

## Free services used (no keys, no accounts)
| What | Service | Limits |
|---|---|---|
| Driving route, detour times, exits | [OSRM public server](https://project-osrm.org/) | Demo server, fair use, car only |
| Destination autocomplete | [Photon](https://photon.komoot.io/) by Komoot | Fair use |
| Places along the route | [Nominatim](https://nominatim.org/) (OpenStreetMap) | Max 1 request/second — the app waits its turn; up to 40 results per section of road |
| Map tiles | [OpenStreetMap](https://www.openstreetmap.org/copyright) | Light use, attribution shown |

Map data © OpenStreetMap contributors.

## Tests
```
npm test                                   # unit tests (ranking, ahead-only, detours, hours, Apple links)
python3 -m http.server 8811 &              # serve this folder
python3 e2e/e2e.py                         # Chromium, iPhone size, simulated GPS on Carmichaels PA → Myrtle Beach SC
python3 e2e/layout.py                      # every control tappable at 375/390/430 widths with Safari's toolbar or the home bar
```
The end-to-end test uses the live free services.
