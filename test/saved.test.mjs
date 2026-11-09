import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSaved, storeSaved, addSaved, renameSaved, removeSaved, findSavedAt, matchSaved, SAVED_KEY } from '../js/saved.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };

test('save, rename, delete places', () => {
  let list = [];
  list = addSaved(list, { name: ' Home ', address: '123 Main St, Carmichaels, PA', ll: [-79.97, 39.89] }, 1000);
  list = addSaved(list, { name: "Grandma's", address: '9 Ocean Blvd, Myrtle Beach, SC', ll: [-78.88, 33.69] }, 2000);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "Grandma's", 'newest first');
  assert.equal(list[1].name, 'Home', 'names are trimmed');
  const id = list[1].id;
  list = renameSaved(list, id, 'Our house');
  assert.equal(list.find((p) => p.id === id).name, 'Our house');
  assert.equal(renameSaved(list, id, '   ').find((p) => p.id === id).name, 'Our house', 'blank rename ignored');
  list = removeSaved(list, id);
  assert.deepEqual(list.map((p) => p.name), ["Grandma's"]);
});

test('saving the same spot again renames instead of duplicating', () => {
  let list = addSaved([], { name: 'Chick-fil-A', address: 'Mount Airy', ll: [-80.6145, 36.4811] });
  list = addSaved(list, { name: 'Lunch stop', ll: [-80.61452, 36.48113] });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Lunch stop');
  assert.equal(list[0].address, 'Mount Airy', 'keeps the address');
  assert.ok(findSavedAt(list, [-80.6145, 36.4811]));
  assert.equal(findSavedAt(list, [-80.7, 36.4811]), null);
});

test('unnamed places fall back to the address', () => {
  const list = addSaved([], { name: '', address: '1 Beach Dr', ll: [0, 0] });
  assert.equal(list[0].name, '1 Beach Dr');
});

test('matching saved places while typing', () => {
  let list = addSaved([], { name: 'Home', address: 'Carmichaels, PA', ll: [1, 1] });
  list = addSaved(list, { name: "Grandma's", address: 'Myrtle Beach, SC', ll: [2, 2] });
  assert.equal(matchSaved(list, '').length, 2);
  assert.deepEqual(matchSaved(list, 'gran').map((p) => p.name), ["Grandma's"]);
  assert.deepEqual(matchSaved(list, 'myrtle').map((p) => p.name), ["Grandma's"]);
  assert.deepEqual(matchSaved(list, 'zzz'), []);
});

test('stored on the device and survives bad data', () => {
  const s = mem();
  assert.deepEqual(loadSaved(s), []);
  const list = addSaved([], { name: 'Home', ll: [1, 2] });
  assert.ok(storeSaved(s, list));
  assert.deepEqual(loadSaved(s), list);
  s.setItem(SAVED_KEY, '{not json');
  assert.deepEqual(loadSaved(s), []);
  s.setItem(SAVED_KEY, JSON.stringify([{ name: 'ok', ll: [1, 2] }, { name: 'bad' }, null]));
  assert.equal(loadSaved(s).length, 1);
});
