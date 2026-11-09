"""Layout test: is every control reachable on iPhone sizes with Safari's bottom toolbar (in-browser) or the
home indicator (Home Screen app) covering the bottom of the screen? Network is mocked so this runs offline."""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8811/index.html")
SHOTS = os.environ.get("SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(SHOTS, exist_ok=True)
SIZES = [(390, 844), (375, 667), (430, 932)]
# What covers the bottom of the screen: Safari's toolbar (~84px incl. home bar) or just the home bar (34px).
MODES = {"safari": 84, "homescreen": 34}
KEYBOARD = 336
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)

# a short saved trip so the app opens with a route (straight road north->south)
coords = [[-80.3, 39.4 - i * 0.002] for i in range(400)]
TRIP = json.dumps({"dest": {"label": "Myrtle Beach", "ll": [-78.8867, 33.6891]}, "from": None, "filters": {"maxDetour": 10, "lookAhead": 50, "sort": "best"},
                   "route": {"coords": coords, "durs": [7.4] * 399, "startLabel": "your location"}})
SAVED = json.dumps([{"id": "p1", "name": "Home", "address": "Carmichaels, PA", "ll": [-79.97, 39.89], "added": 1},
                    {"id": "p2", "name": "Grandma's", "address": "Myrtle Beach, SC", "ll": [-78.88, 33.69], "added": 2}])
FAKE = [{"id": f"node/{i}", "name": n, "kind": "Gas", "address": "Exit Rd, WV", "ll": [-80.3005, 39.3 - i * 0.03], "aheadM": 8000 * (i + 1),
         "detourS": 60 + 30 * i, "offRouteM": 150, "hours": "24/7", "exit": {"ref": "", "signs": "US 50: Clarksburg", "road": "US 50"}}
        for i, n in enumerate(["Sheetz", "GoMart", "Exxon", "Circle K", "BP", "Speedway"])]

OVERLAY = """([h, mode]) => {
  const d = document.createElement('div'); d.id = '__bar';
  d.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${h}px;z-index:2147483647;pointer-events:auto;` +
    (mode === 'safari' ? 'background:rgba(246,246,248,.92);border-top:1px solid #ccc;backdrop-filter:blur(8px);' : 'background:transparent;');
  d.innerHTML = mode === 'safari'
    ? '<div style="margin:8px 12px;height:40px;border-radius:20px;background:#e4e4e8;display:flex;align-items:center;justify-content:center;font:15px -apple-system,sans-serif;color:#333">aA&nbsp;&nbsp;&nbsp;tri8602-del.github.io&nbsp;&nbsp;&nbsp;↻</div>'
    : '<div style="position:absolute;bottom:8px;left:50%;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:#111"></div>';
  document.body.appendChild(d);
}"""

def hittable(page, sel_or_handle):
    el = page.query_selector(sel_or_handle) if isinstance(sel_or_handle, str) else sel_or_handle
    el.evaluate("e => e.scrollIntoView({block: 'center'})")
    page.wait_for_timeout(120)
    return el.evaluate("""e => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y); return !!hit && (hit === e || e.contains(hit)); }""")

def fully_visible(page, sel, cover):
    return page.evaluate("""([s, cover]) => { const r = document.querySelector(s).getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight - cover; }""", [sel, cover])

with sync_playwright() as p:
    b = p.chromium.launch()
    for (w, h) in SIZES:
        for mode, cover in MODES.items():
            tag = f"{w}x{h} {mode}"
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=3, is_mobile=True, has_touch=True,
                user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
                geolocation={"latitude": 39.39, "longitude": -80.3}, permissions=["geolocation"])
            init = f"localStorage.setItem('rts.v1', {json.dumps(TRIP)}); localStorage.setItem('rts.saved.v1', {json.dumps(SAVED)});"
            if mode == "homescreen":
                # Home Screen app: navigator.standalone is true and the home bar safe area is 34px
                init += "Object.defineProperty(navigator, 'standalone', {get: () => true});" \
                        "document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--safe-bottom', 'max(34px, var(--browser-bar))'));"
            ctx.add_init_script(init)
            searches = []
            def handle(r):
                u = r.request.url
                if u.startswith(BASE.rsplit('/', 1)[0]): return r.continue_()
                if "nominatim" in u: searches.append(u); return r.fulfill(status=200, content_type="application/json", body="[]")
                if "photon" in u: return r.fulfill(status=200, content_type="application/json", body='{"features":[]}')
                return r.abort()
            ctx.route("**/*", handle)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(BASE)
            page.wait_for_timeout(800)
            page.evaluate(OVERLAY, [cover, mode])
            page.wait_for_timeout(200)
            bar_h = page.evaluate("() => document.getElementById('__bar').getBoundingClientRect().height")
            check(f"{tag}: simulated bottom bar is {cover}px tall", abs(bar_h - cover) < 1, f"{bar_h}")
            check(f"{tag}: Search button fully visible above the bottom bar on opening", fully_visible(page, "#searchBtn", cover))
            check(f"{tag}: Search box fully visible on opening", fully_visible(page, "#searchInput", cover))
            if (w, h) in [(390, 844), (375, 667)]:
                page.screenshot(path=f"{SHOTS}/1-search-clear-of-bar-{mode}-{w}x{h}.png")
            # every control in the page can be tapped (not under the bar)
            page.click("#filters summary")
            page.evaluate("window.__rts.results = " + json.dumps(FAKE) + "; window.__rtsHooks.renderResults();")
            page.wait_for_timeout(200)
            sels = ["#searchInput", "#searchBtn", "#rerouteBtn", "#changeTrip", "#starDestCompact"] + \
                   [f"#quickChips .chip:nth-child({i})" for i in range(1, 5)] + \
                   [f".seg[data-name={n}] button:nth-child({i})" for n in ("maxDetour", "lookAhead") for i in range(1, 5)] + \
                   [".seg[data-name=sort] button:nth-child(1)", ".seg[data-name=sort] button:nth-child(2)", ".seg[data-name=openOnly] button:nth-child(1)", ".seg[data-name=openOnly] button:nth-child(2)"]
            bad = [s for s in sels if not hittable(page, s)]
            stop_btns = page.query_selector_all(".result [data-act=stop]")
            bad += [f"result {i+1} button" for i, e in enumerate(stop_btns) if not hittable(page, e)]
            check(f"{tag}: all {len(sels) + len(stop_btns)} page controls tappable (incl. last result)", not bad, ", ".join(bad))
            # scrolled all the way down, the last result's button sits above the bar
            page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
            page.wait_for_timeout(150)
            last = page.evaluate(f"() => {{ const r = [...document.querySelectorAll('.result [data-act=stop]')].pop().getBoundingClientRect(); return [r.bottom, window.innerHeight - {cover}]; }}")
            check(f"{tag}: at the very bottom, last button clears the bar", last[0] <= last[1], f"bottom {last[0]:.0f} ≤ {last[1]:.0f}")
            # stop sheet buttons
            page.evaluate("window.__rtsHooks.openSheet(window.__rts.results[0])")
            page.wait_for_timeout(200)
            sheet_bad = [s for s in ["#addStopBtn", "#stopOnlyBtn", "#saveStopBtn", "#placeBtn", "#sheetClose"] if not hittable(page, s)]
            check(f"{tag}: stop sheet buttons all tappable", not sheet_bad, ", ".join(sheet_bad))
            if (w, h) == (375, 667): page.screenshot(path=f"{SHOTS}/2-stop-sheet-clear-of-bar-{mode}-{w}x{h}.png")
            page.click("#sheetClose")
            # saved places sheet
            page.evaluate("window.scrollTo(0,0)"); page.click("#changeTrip"); page.click("#manageSaved"); page.wait_for_timeout(200)
            sv_bad = [s for s in ["#savedList .saved-item:nth-child(2) [data-act=delete]", "#addSavedBtn", "#savedClose"] if not hittable(page, s)]
            check(f"{tag}: saved places sheet buttons tappable", not sv_bad, ", ".join(sv_bad))
            page.click("#savedClose")
            # keyboard open: shrink the visible area like the iPhone keyboard does, focus search, press the keyboard's Search key
            page.set_viewport_size({"width": w, "height": h - KEYBOARD})
            page.evaluate("document.getElementById('__bar').remove()")
            page.focus("#searchInput"); page.wait_for_timeout(700)
            check(f"{tag}: keyboard open — Search box and button visible above keyboard",
                  fully_visible(page, "#searchInput", 0) and fully_visible(page, "#searchBtn", 0))
            if (w, h) == (390, 844) and mode == "safari": page.screenshot(path=f"{SHOTS}/3-keyboard-open-{w}x{h}.png")
            page.fill("#searchInput", "gas"); n0 = len(searches)
            page.keyboard.press("Enter"); page.wait_for_timeout(2500)
            check(f"{tag}: keyboard Search key starts the search", len(searches) > n0, f"{len(searches) - n0} place lookups")
            check(f"{tag}: no JavaScript errors", not errors, "; ".join(errors[:2]))
            ctx.close()
    b.close()
fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
