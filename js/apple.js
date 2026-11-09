// Apple Maps links (Apple's "unified Maps URLs", iOS 18.4+): https://developer.apple.com/documentation/mapkit/unified-map-urls
// Leaving out `source` makes Apple Maps start from her current location.
const c = ([lon, lat]) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

/** Directions to the destination with the stop added first (multi-stop route). */
export function addStopUrl(stopLL, destLL) {
  return `https://maps.apple.com/directions?destination=${c(destLL)}&waypoint=${c(stopLL)}&mode=driving`;
}

/** Directions straight to one place (used for "Continue to destination" and as the older-iPhone fallback). */
export function directionsUrl(toLL) {
  return `https://maps.apple.com/directions?destination=${c(toLL)}&mode=driving`;
}

/** Older iPhones (before iOS 18.4) only understand the classic link, which has no stops. */
export function legacyDirectionsUrl(toLL) {
  return `https://maps.apple.com/?daddr=${c(toLL)}&dirflg=d`;
}

/** Place card in Apple Maps (shows Apple's photos, ratings and hours when it knows the place). */
export function placeUrl(ll, name) {
  return `https://maps.apple.com/place?coordinate=${c(ll)}&name=${encodeURIComponent(name)}`;
}

/** iOS version from Safari's user agent, e.g. "iPhone OS 18_4" -> 18.4. null if not iOS. */
export function iosVersion(ua) {
  const m = /(?:iPhone|iPad|iPod)[^)]*OS (\d+)[_.](\d+)/.exec(ua || '');
  return m ? Number(m[1]) + Number(m[2]) / 10 : null;
}

/** True when this iPhone understands multi-stop links (iOS 18.4+). Unknown devices get the new link. */
export function supportsStops(ua) {
  const v = iosVersion(ua);
  return v == null || v >= 18.4 - 1e-9;
}
