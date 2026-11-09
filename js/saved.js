// Saved places (Home, Grandma's…), kept only on this phone. Pure helpers so they can be unit tested.
export const SAVED_KEY = 'rts.saved.v1';
const SAME_PLACE_DEG = 0.0005; // ~50 m

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 60);
const samePlace = (a, b) => Math.abs(a[0] - b[0]) < SAME_PLACE_DEG && Math.abs(a[1] - b[1]) < SAME_PLACE_DEG;

export function loadSaved(storage) {
  try {
    const list = JSON.parse(storage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => p && p.name && Array.isArray(p.ll) && p.ll.length === 2) : [];
  } catch { return []; }
}
export function storeSaved(storage, list) {
  try { storage.setItem(SAVED_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** Add a place, or rename it if the same spot is already saved. Returns a new list (newest first). */
export function addSaved(list, { name, address = '', ll }, now = Date.now()) {
  const nm = clean(name) || clean(address) || 'Saved place';
  const existing = list.find((p) => samePlace(p.ll, ll));
  if (existing) return list.map((p) => (p === existing ? { ...p, name: nm, address: clean(address) || p.address } : p));
  const id = `p${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  return [{ id, name: nm, address: clean(address), ll: [+ll[0], +ll[1]], added: now }, ...list];
}
export function renameSaved(list, id, name) {
  const nm = clean(name);
  if (!nm) return list;
  return list.map((p) => (p.id === id ? { ...p, name: nm } : p));
}
export function removeSaved(list, id) { return list.filter((p) => p.id !== id); }
export function findSavedAt(list, ll) { return list.find((p) => samePlace(p.ll, ll)) || null; }

/** Saved places matching what's typed (all of them when nothing is typed). */
export function matchSaved(list, text) {
  const q = clean(text).toLowerCase();
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q));
}
