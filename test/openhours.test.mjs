import test from 'node:test';
import assert from 'node:assert/strict';
import { statusAtArrival, groupByHours, wallClock, placeTimeZone, fmtClock } from '../js/openhours.js';

const WV = [-80.3, 39.2];          // Eastern time
const TN = [-86.78, 36.16];        // Nashville, Central time
// 2026-11-10 is a Tuesday. EST = UTC-5, CST = UTC-6.
const et = (h, m = 0, day = 10) => Date.UTC(2026, 10, day, h + 5, m);
const opt = (arriveMs, ll = WV, extra = {}) => ({ ll, state: 'West Virginia', arriveMs, ...extra });

test('time zone comes from the place', () => {
  assert.equal(placeTimeZone(WV), 'America/New_York');
  assert.equal(placeTimeZone(TN), 'America/Chicago');
  const w = wallClock(et(20, 30), 'America/Chicago');
  assert.equal(w.getHours(), 19); assert.equal(w.getMinutes(), 30);
});

test('open, closing soon, closed at arrival', () => {
  const h = 'Mo-Sa 06:00-21:00; Su off';
  assert.deepEqual(statusAtArrival(h, opt(et(12))).status, 'open');
  assert.equal(statusAtArrival(h, opt(et(12))).text, 'Open until 9:00 PM');
  const soon = statusAtArrival(h, opt(et(20, 15)));
  assert.equal(soon.status, 'closing-soon');
  assert.equal(soon.text, 'Closes soon — closes 9:00 PM');
  assert.equal(soon.minutesOpen, 45);
  assert.equal(statusAtArrival(h, opt(et(19, 59))).status, 'open', '61 minutes left is not "soon"');
  const closed = statusAtArrival(h, opt(et(21, 30)));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.text, "Closed when you'd get there · opens Wed 6:00 AM");
  assert.equal(statusAtArrival(h, opt(et(12, 0, 8))).status, 'closed', 'Sunday off');
});

test('arrival time matters, not the time right now', () => {
  // it's 8:00 PM now and open, but she'd get there at 9:10 PM -> closed
  const h = 'Mo-Su 06:00-21:00';
  const [s] = groupByHours([{ id: 'a', hours: h, ll: WV, state: 'West Virginia', arriveS: 70 * 60 }], { nowMs: et(20) }).closed;
  assert.equal(s.hoursStatus.status, 'closed');
  const [o] = groupByHours([{ id: 'b', hours: h, ll: WV, arriveS: 10 * 60 }], { nowMs: et(20) }).open;
  assert.equal(o.hoursStatus.status, 'closing-soon');
});

test('overnight hours and 24/7', () => {
  assert.equal(statusAtArrival('Mo-Su 18:00-02:00', opt(et(1, 30, 11))).text, 'Closes soon — closes 2:00 AM');
  assert.equal(statusAtArrival('Mo-Su 18:00-02:00', opt(et(23))).text, 'Open until 2:00 AM');
  assert.equal(statusAtArrival('Mo-Su 18:00-02:00', opt(et(3, 0, 11))).status, 'closed');
  assert.deepEqual(statusAtArrival('24/7', opt(et(3))), { status: 'open', text: 'Open 24 hours' });
});

test('holidays (PH) are understood', () => {
  const h = 'Mo-Fr 08:00-17:00; PH off';
  assert.equal(statusAtArrival(h, opt(et(10, 0, 25))).status, 'open', 'Wednesday before Thanksgiving');
  assert.equal(statusAtArrival(h, opt(et(10, 0, 26))).status, 'closed', 'Thanksgiving Day');
});

test('the place\'s own time zone is used', () => {
  // 9:30 PM Eastern is 8:30 PM in Nashville: a 6am-9pm place there is closing soon, not closed
  const s = statusAtArrival('Mo-Su 06:00-21:00', { ll: TN, state: 'Tennessee', arriveMs: et(21, 30) });
  assert.equal(s.status, 'closing-soon');
  assert.equal(s.text, 'Closes soon — closes 9:00 PM');
});

test('missing or unreadable hours are "unknown", never guessed', () => {
  assert.deepEqual(statusAtArrival('', opt(et(12))), { status: 'unknown', text: 'Hours not listed' });
  assert.equal(statusAtArrival('call us!!', opt(et(12))).status, 'unknown');
  assert.equal(statusAtArrival('Mo-Fr 08:00-17:00 unknown', opt(et(12))).status, 'unknown');
});

test('grouping: open first (in ranked order), then hours unknown, closed only when asked', () => {
  const nowMs = et(20, 30);
  const stops = [
    { id: '1', hours: '', ll: WV },                          // unknown
    { id: '2', hours: 'Mo-Su 06:00-21:00', ll: WV },         // closing soon
    { id: '3', hours: 'Mo-Su 06:00-20:00', ll: WV },         // closed
    { id: '4', hours: '24/7', ll: WV },                      // open
  ].map((s) => ({ ...s, arriveS: 300 }));
  const g = groupByHours(stops, { nowMs });
  assert.deepEqual(g.shown.map((s) => s.id), ['2', '4', '1']);
  assert.deepEqual(g.shown.map((s) => s.section), ['open', 'open', 'unknown']);
  assert.deepEqual(groupByHours(stops, { nowMs, showClosed: true }).shown.map((s) => s.id), ['2', '4', '1', '3']);
});

test('clock formatting', () => {
  const ref = new Date(2026, 10, 10, 20, 0);
  assert.equal(fmtClock(new Date(2026, 10, 10, 21, 0), ref), '9:00 PM');
  assert.equal(fmtClock(new Date(2026, 10, 11, 0, 0), ref, { closing: true }), 'midnight');
  assert.equal(fmtClock(new Date(2026, 10, 11, 0, 30), ref), 'Wed 12:30 AM');
  assert.equal(fmtClock(new Date(2026, 10, 11, 0, 30), ref, { closing: true }), '12:30 AM');
});

test('chain hints for places without hours (hint only)', async () => {
  const { chainHint } = await import('../js/openhours.js');
  assert.equal(chainHint({ name: 'Sheetz' }), 'This chain is usually open 24 hours');
  assert.equal(chainHint({ name: 'Gas', brand: "Love's" }), 'This chain is usually open 24 hours');
  assert.equal(chainHint({ name: 'Chick-fil-A' }), 'Chick-fil-A is closed on Sundays');
  assert.equal(chainHint({ name: 'Betty\'s Diner' }), '');
  assert.equal(chainHint({ name: 'Tasty Diner' }), '', 'no partial-word matches');
});
