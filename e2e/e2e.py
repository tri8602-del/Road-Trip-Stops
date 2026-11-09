"""End-to-end test: Chromium, iPhone-size, simulated GPS on the real Carmichaels PA -> Myrtle Beach SC route.
Uses the live free services (OSRM, Photon, Nominatim). Prints PASS/FAIL lines and saves screenshots."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8811/index.html")  # serve the repo folder: python3 -m http.server 8811
SHOTS = os.environ.get("SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(SHOTS, exist_ok=True)
CARMICHAELS = (39.8973, -79.9767)
I79 = (39.43792, -80.17846)    # I-79 southbound between Fairmont and Clarksburg WV (route mile 45)
I79_PAST = (39.2563, -80.2861) # I-79 just past Bridgeport WV (route mile 60)
I77 = (36.9986, -81.0860)      # I-77 southbound near Wytheville VA (route mile ~260)
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)

def stops(page):
    return page.evaluate("""() => window.__rts.results.map(s => ({name: s.name, lat: s.ll[1], lon: s.ll[0],
        aheadMi: s.aheadM/1609.344, detourMin: s.detourS/60, offMi: s.offRouteM/1609.344, exit: s.exit || null, hours: s.hours}))""")

def wait_search(page, timeout=90000):
    page.wait_for_function("() => !document.getElementById('searchBtn').disabled", timeout=timeout)

def search(page, text):
    page.fill("#searchInput", text)
    page.click("#searchBtn")
    page.wait_for_timeout(300)
    wait_search(page)
    page.wait_for_timeout(500)
    return stops(page)

def car_lat(page):
    return page.evaluate("() => window.__rts.gps && window.__rts.gps[1]")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
        geolocation={"latitude": CARMICHAELS[0], "longitude": CARMICHAELS[1]}, permissions=["geolocation"], timezone_id="America/New_York", locale="en-US")
    popups = []
    # never actually leave for Apple Maps during the test; record where it would go
    ctx.route("https://maps.apple.com/**", lambda r: (popups.append(r.request.url), r.fulfill(status=200, body="apple maps")))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_timeout(1500)

    # 0. saved places: star a suggestion, add one by typing an address with a custom name, rename, pick one
    page.click("#destInput")
    page.type("#destInput", "Myrtle Beach", delay=40)
    page.wait_for_selector("#destSuggest li .sg-star", timeout=15000)
    page.click("#destSuggest li .sg-star")
    page.wait_for_selector("#saveSheet:not([hidden])")
    check("star on a suggestion opens Save with its name filled in", page.input_value("#saveName") == "Myrtle Beach", page.input_value("#saveName"))
    page.fill("#saveName", "Beach trip")
    page.screenshot(path=f"{SHOTS}/4-save-place-from-autocomplete.png")
    page.click("#saveConfirm")
    page.wait_for_selector("#saveSheet", state="hidden")
    page.fill("#destInput", "")
    page.keyboard.press("Escape"); page.evaluate("document.activeElement.blur()")
    page.click("#manageSaved")
    page.click("#addSavedBtn")
    page.wait_for_selector("#saveSheet:not([hidden]) #saveAddrField:not([hidden])")
    page.fill("#saveName", "Home")
    page.click("#saveAddr"); page.type("#saveAddr", "Carmichaels", delay=40)
    page.wait_for_selector("#saveSuggest li", timeout=15000)
    check("typed-address suggestions have no star buttons inside the Save sheet", page.locator("#saveSuggest .sg-star").count() == 0)
    page.click("#saveSuggest li")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/5-add-place-by-typing-address.png")
    page.click("#saveConfirm")
    page.wait_for_selector("#saveSheet", state="hidden")
    names = page.evaluate("() => window.__rts.saved.map(p => p.name)")
    check("two places saved (custom names)", names == ["Home", "Beach trip"], str(names))
    page.click("#savedList .saved-item:nth-child(1) [data-act=rename]")
    page.fill("#saveName", "Our house"); page.click("#saveConfirm"); page.wait_for_timeout(300)
    check("rename a saved place", page.evaluate("() => window.__rts.saved.map(p => p.name)") == ["Our house", "Beach trip"])
    page.screenshot(path=f"{SHOTS}/6-saved-places-list.png")
    page.click("#savedClose")
    stored = page.evaluate("() => JSON.parse(localStorage.getItem('rts.saved.v1')).length")
    check("saved places stored on the phone (localStorage)", stored == 2)
    page.click("#fromInput"); page.wait_for_timeout(300)
    check("saved places offered as quick picks for the start", page.locator("#fromSuggest li.is-saved").count() == 2)
    page.keyboard.press("Escape"); page.click("body", position={"x": 5, "y": 5})
    chips = page.locator("#savedChips .chip").all_inner_texts()
    check("saved places shown as one-tap destination chips", chips == ["★ Our house", "★ Beach trip"], str(chips))
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path=f"{SHOTS}/7-saved-place-chips.png")
    page.click("#savedChips .chip:has-text('Beach trip')")
    page.wait_for_selector("#tripCompact:not([hidden])", timeout=30000)
    page.wait_for_timeout(2500)
    check("one tap on a saved place sets it as destination and routes", page.inner_text("#compactDest") == "Beach trip" and page.inner_text("#starDestCompact") == "★")
    page.screenshot(path=f"{SHOTS}/8-saved-place-as-destination.png")

    # 1. destination with autocomplete (typed, the v1.0 way)
    page.click("#changeTrip")
    page.click("#destInput")
    page.fill("#destInput", "")
    page.type("#destInput", "Myrtle Beach", delay=40)
    page.wait_for_selector("#destSuggest li:not(.is-saved)", timeout=15000)
    first = page.inner_text("#destSuggest li:not(.is-saved)")
    check("autocomplete suggests Myrtle Beach", "Myrtle Beach" in first, first.replace("\n", " / "))
    page.screenshot(path=f"{SHOTS}/1a-destination-autocomplete.png")
    page.click("#destSuggest li:not(.is-saved)")
    page.wait_for_selector("#tripCompact:not([hidden])", timeout=30000)
    page.wait_for_timeout(2500)  # tiles
    r = page.evaluate("() => ({mi: window.__rts.route.length/1609.344, pts: window.__rts.route.coords.length})")
    check("driving route drawn from current location", 450 < r["mi"] < 650 and page.locator(".leaflet-overlay-pane path").count() >= 1, f"{r['mi']:.0f} mi, {r['pts']} points")
    page.screenshot(path=f"{SHOTS}/1b-route.png")

    # 2. drive to I-79 near Clarksburg
    ctx.set_geolocation({"latitude": I79[0], "longitude": I79[1]})
    page.wait_for_function(f"() => window.__rts.gps && Math.abs(window.__rts.gps[1] - {I79[0]}) < 0.001", timeout=20000)
    page.wait_for_timeout(500)
    where = page.inner_text("#sumWhere")
    check("app knows the car is on the route", "on the route" in where, where)

    # 2a. Chick-fil-A, 100 miles ahead, 15 min max
    page.click("#filters summary")
    page.click(".seg[data-name=maxDetour] button[data-v='15']")
    page.click(".seg[data-name=lookAhead] button[data-v='100']")
    page.click("#filters summary")
    s = search(page, "Chick-fil-A")
    print(json.dumps(s, indent=1)[:3000])
    check("Chick-fil-A results found ahead on I-79", len(s) >= 1, f"{len(s)} results")
    check("every Chick-fil-A result is ahead (south of the car)", all(x["lat"] < I79[0] + 0.01 and x["aheadMi"] > 0 for x in s))
    check("all names really are Chick-fil-A", all("chick" in x["name"].lower() for x in s))
    # Independent check: there ARE Chick-fil-As behind (Morgantown) that the app left out
    import urllib.request, urllib.parse
    q = urllib.parse.urlencode({"format": "jsonv2", "q": "Chick-fil-A", "bounded": 1, "viewbox": "-80.1,39.75,-79.8,39.5", "limit": 10})
    behind = json.load(urllib.request.urlopen(urllib.request.Request(f"https://nominatim.openstreetmap.org/search?{q}", headers={"User-Agent": "RoadTripStops-e2e/1.0"})))
    behind_ll = [(float(x["lat"]), float(x["lon"])) for x in behind if "chick" in (x.get("name") or "").lower()]
    shown = [(x["lat"], x["lon"]) for x in s]
    check("Chick-fil-As behind the car (Morgantown) exist and are excluded", len(behind_ll) >= 1 and not any(abs(a - c) < 0.002 and abs(b2 - d) < 0.002 for a, b2 in behind_ll for c, d in shown), f"{len(behind_ll)} behind")
    page.wait_for_timeout(6000)  # exits fill in
    page.evaluate("window.scrollTo(0, document.getElementById('searchCard').offsetTop - 8)")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{SHOTS}/2a-results-chick-fil-a-I79.png")
    cfa_i79 = stops(page)
    # drive 15 miles on, past the Bridgeport Chick-fil-As: they are now behind and must disappear
    ctx.set_geolocation({"latitude": I79_PAST[0], "longitude": I79_PAST[1]})
    page.wait_for_function(f"() => window.__rts.gps && Math.abs(window.__rts.gps[1] - {I79_PAST[0]}) < 0.001", timeout=20000)
    page.wait_for_timeout(500)
    s_past = search(page, "Chick-fil-A")
    gone = [x for x in cfa_i79 if x["lat"] > I79_PAST[0]]
    check("after driving past Bridgeport, those Chick-fil-As are dropped", len(gone) >= 1 and not any(abs(g["lat"] - y["lat"]) < 1e-6 for g in gone for y in s_past),
          f"{len(gone)} were ahead at mile 45; now {len(s_past)} results; message: {page.inner_text('#searchMsg')}")
    ctx.set_geolocation({"latitude": I79[0], "longitude": I79[1]})
    page.wait_for_function(f"() => window.__rts.gps && Math.abs(window.__rts.gps[1] - {I79[0]}) < 0.001", timeout=20000)
    page.wait_for_timeout(500)

    # 2b. gas on I-79, 50 mi, 10 min
    page.click("#filters summary")
    page.click(".seg[data-name=maxDetour] button[data-v='10']")
    page.click(".seg[data-name=lookAhead] button[data-v='50']")
    wait_search(page)  # changing options re-runs the search
    page.click("#filters summary")
    s = search(page, "gas")
    check("gas results on I-79", len(s) >= 3, f"{len(s)} results")
    check("every gas result is ahead", all(x["aheadMi"] > 0 and x["lat"] < I79[0] + 0.01 for x in s))
    check("gas results all within 10 min detour and 50 mi", all(x["detourMin"] <= 10 and x["aheadMi"] <= 50 for x in s))
    scores = [x["detourMin"] + x["aheadMi"] / 20 for x in s]
    check("ranked by least extra time (then distance ahead)", scores == sorted(scores))
    inv = [(a, c) for i, a in enumerate(s) for c in s[i+1:] if a["aheadMi"] > c["aheadMi"] + 3 and c["detourMin"] > a["detourMin"] + 3]
    check("a farther place right off the road outranks a closer one far off the highway", len(inv) >= 1,
          (f"{inv[0][0]['name']} {inv[0][0]['aheadMi']:.1f} mi/+{inv[0][0]['detourMin']:.1f} min ranks above {inv[0][1]['name']} {inv[0][1]['aheadMi']:.1f} mi/+{inv[0][1]['detourMin']:.1f} min") if inv else "no such pair in live data")
    page.wait_for_timeout(6000)
    page.evaluate("window.scrollTo(0, document.getElementById('searchCard').offsetTop - 8)")
    page.screenshot(path=f"{SHOTS}/2b-results-gas-I79.png")
    gas_i79 = stops(page)

    # 3. drive on to I-77 near Wytheville
    ctx.set_geolocation({"latitude": I77[0], "longitude": I77[1]})
    page.wait_for_function(f"() => window.__rts.gps && Math.abs(window.__rts.gps[1] - {I77[0]}) < 0.001", timeout=20000)
    page.wait_for_timeout(500)
    s = search(page, "gas")
    check("gas results on I-77", len(s) >= 3, f"{len(s)} results")
    check("every I-77 gas result is ahead (south of the car)", all(x["lat"] < I77[0] + 0.01 for x in s))
    scores = [x["detourMin"] + x["aheadMi"] / 20 for x in s]
    check("I-77 gas ranked by least extra time", scores == sorted(scores))
    inv77 = [(a, c) for i, a in enumerate(s) for c in s[i+1:] if a["aheadMi"] > c["aheadMi"] + 3 and c["detourMin"] > a["detourMin"] + 3]
    check("I-77: farther right-off-the-road place outranks closer far-off one", len(inv77) >= 1,
          (f"{inv77[0][0]['name']} {inv77[0][0]['aheadMi']:.1f} mi/+{inv77[0][0]['detourMin']:.1f} min above {inv77[0][1]['name']} {inv77[0][1]['aheadMi']:.1f} mi/+{inv77[0][1]['detourMin']:.1f} min") if inv77 else "no such pair")
    gas_i77 = s
    page.click("#filters summary")
    page.click(".seg[data-name=maxDetour] button[data-v='15']")
    page.click(".seg[data-name=lookAhead] button[data-v='100']")
    wait_search(page)
    page.click("#filters summary")
    s = search(page, "Chick-fil-A")
    check("Chick-fil-A results on I-77", len(s) >= 1, f"{len(s)} results")
    check("every I-77 Chick-fil-A is ahead", all(x["lat"] < I77[0] + 0.01 for x in s))
    page.wait_for_timeout(6000)
    page.evaluate("window.scrollTo(0, document.getElementById('searchCard').offsetTop - 8)")
    page.screenshot(path=f"{SHOTS}/3a-results-chick-fil-a-I77.png")
    cfa_i77 = stops(page)

    # 4. pick a stop
    page.locator(".result [data-act=stop]").first.click()
    page.wait_for_selector("#sheet:not([hidden])")
    href = page.get_attribute("#addStopBtn", "href")
    dest = page.evaluate("() => window.__rts.dest.ll")
    first = cfa_i77[0]
    want = f"https://maps.apple.com/directions?destination={dest[1]:.6f},{dest[0]:.6f}&waypoint={first['lat']:.6f},{first['lon']:.6f}&mode=driving"
    check("Add stop link = Apple Maps multi-stop (stop as waypoint, then destination)", href == want, href)
    page.screenshot(path=f"{SHOTS}/4a-stop-sheet.png")
    page.click("#saveStopBtn")
    page.wait_for_selector("#saveSheet:not([hidden])")
    check("save a search result from the stop sheet", page.input_value("#saveName") == first["name"])
    page.fill("#saveName", "Lunch stop"); page.click("#saveConfirm"); page.wait_for_timeout(300)
    check("result saved", "Lunch stop" in page.evaluate("() => window.__rts.saved.map(p => p.name)"))
    page.locator(".result [data-act=stop]").first.click()
    page.wait_for_selector("#sheet:not([hidden])")
    check("stop sheet now shows it as saved", page.inner_text("#saveStopBtn").startswith("★"))
    with page.expect_popup() as pop:
        page.click("#addStopBtn")
    pop.value.close()
    page.wait_for_selector("#nextBanner:not([hidden])")
    page.wait_for_timeout(600)
    cont = page.get_attribute("#continueBtn", "href")
    check("after the stop, Continue goes to the destination", cont == f"https://maps.apple.com/directions?destination={dest[1]:.6f},{dest[0]:.6f}&mode=driving", cont)
    check("Apple Maps was opened with the multi-stop link", any("waypoint=" in u for u in popups), popups[-1] if popups else "")
    page.evaluate("window.scrollTo(0,0)")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/4b-continue-banner.png")

    # 5. older iPhone fallback
    ctx2 = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        geolocation={"latitude": I77[0], "longitude": I77[1]}, permissions=["geolocation"])
    state = page.evaluate("() => localStorage.getItem('rts.v1')")
    pg2 = ctx2.new_page()
    pg2.goto(BASE); pg2.evaluate("s => localStorage.setItem('rts.v1', s)", state); pg2.reload(); pg2.wait_for_timeout(1200)
    check("saved trip reloads (route + destination kept)", pg2.evaluate("() => !!window.__rts.route && window.__rts.dest.label") == "Myrtle Beach")
    pg2.evaluate("""() => { const s = {id:'node/x', name:'Test stop', ll:[-81.09,36.95], aheadM: 5000, detourS: 120, offRouteM: 100, hours:''};
        window.__rts.results=[s]; }""")
    # open the sheet the same way a tap does
    s2 = search(pg2, "gas")
    pg2.locator(".result [data-act=stop]").first.click()
    h2 = pg2.get_attribute("#addStopBtn", "href")
    check("iOS 17 fallback: opens directions to the stop (classic link) + Continue later", h2.startswith("https://maps.apple.com/?daddr=") and "Go to this stop" in pg2.inner_text("#addStopBtn"), h2)

    # delete a saved place (two taps so it can't happen by accident)
    page.evaluate("window.scrollTo(0,0)")
    page.click("#changeTrip"); page.click("#manageSaved")
    btn = page.locator("#savedList .saved-item:has-text('Our house') [data-act=delete]")
    btn.click()
    check("first Delete tap only asks to confirm", "Our house" in page.evaluate("() => window.__rts.saved.map(p => p.name).join()") and "Tap again" in btn.inner_text())
    btn.click(); page.wait_for_timeout(200)
    check("second tap deletes it", page.evaluate("() => window.__rts.saved.map(p => p.name)") == ["Lunch stop", "Beach trip"])
    page.click("#savedClose")
    check("no JavaScript errors", not errors, "; ".join(errors[:3]))
    json.dump({"cfa_i79": cfa_i79, "gas_i79": gas_i79, "gas_i77": gas_i77, "cfa_i77": cfa_i77}, open(os.path.join(SHOTS, "last-results.json"), "w"), indent=1)
    b.close()

fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
