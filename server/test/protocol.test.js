import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_KIND,
  REPORT_KIND,
  acceptApproval,
  approvalTemplate,
  checkApproval,
  eventId,
  itemId,
  newSecretKey,
  publicKey,
  readReport,
  reportHash,
  reportTemplate,
  signEvent,
  verifyEvent,
} from '../protocol.js';

const vectors = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'protocol', 'vectors.json'), 'utf8'));
const approverSk = newSecretKey();
const approver = publicKey(approverSk);
const now = 1795000000;
const items = [
  { channel: 'brew-formula', name: 'jq', current: '1.7', latest: '1.7.1' },
  { channel: 'brew-cask', name: 'firefox', current: '120.0', latest: '121.0' },
];
const hash = reportHash('mac', items);
const approval = (o = {}) => signEvent(approvalTemplate({ machineId: 'm1', reportHash: hash, counter: 10, now, ttl: 3600, ...o }), o.sk || approverSk);
const check = (ev, o = {}) => checkApproval(ev, { approver, machineId: 'm1', lastCounter: 9, localHash: hash, now, ...o });

test('kinds are addressable and ours', () => {
  for (const k of [REPORT_KIND, APPROVAL_KIND]) {
    assert.ok(k >= 30000 && k < 40000 && k !== 30078);
    assert.ok(![30000, 30001, 30002, 30003, 30004, 30015, 30030].includes(k));
  }
});

test('the vectors still match this code (regenerate with node test/make-vectors.mjs)', () => {
  assert.equal(reportHash('mac', vectors.items), vectors.report_hash);
  assert.equal(eventId(vectors.odd_event), vectors.odd_event.id);
  assert.ok(verifyEvent(vectors.approval));
  for (const i of vectors.items) assert.equal(itemId(i.channel, i.name), vectors.item_ids[`${i.channel}|${i.name}`]);
});

test('report hash ignores order and running flags, not versions', () => {
  assert.equal(reportHash('mac', [...items].reverse()), hash);
  assert.equal(reportHash('mac', items.map((i) => ({ ...i, flags: { running: true } }))), hash);
  assert.notEqual(reportHash('mac', [{ ...items[0], latest: '1.8' }, items[1]]), hash);
  assert.notEqual(reportHash('linux', items), hash);
});

test('approval: a good one passes', () => {
  const r = check(approval({ only: ['abc'] }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.only, ['abc']);
});

test('approval: replayed (old counter) is refused', () => {
  assert.equal(check(approval(), { lastCounter: 10 }).reason, 'old counter');
  assert.equal(check(approval(), { lastCounter: 11 }).reason, 'old counter');
});

test('approval: expired is refused', () => {
  assert.equal(check(approval(), { now: now + 3600 }).reason, 'expired');
});

test('approval: hash that does not match the current report is refused', () => {
  assert.equal(check(approval(), { localHash: reportHash('mac', items.slice(1)) }).reason, 'report changed');
});

test('approval: signed by an unknown key is refused', () => {
  assert.equal(check(approval({ sk: newSecretKey() })).reason, 'unknown signer');
});

test('approval: tampered, for another machine, from the future', () => {
  const ev = approval();
  const tampered = { ...ev, tags: ev.tags.map((t) => (t[0] === 'counter' ? ['counter', '99'] : t)) };
  assert.equal(check(tampered).reason, 'bad signature');
  assert.equal(check(approval({ machineId: 'm2' })).reason, 'for another machine');
  assert.equal(check(signEvent({ ...approvalTemplate({ machineId: 'm1', reportHash: hash, counter: 10, now: now + 700, ttl: 3600 }) }, approverSk)).reason, 'from the future');
  assert.equal(check(null).ok, false);
});

test('the dashboard stores only newer approvals from the approver', () => {
  const o = { approver, machineId: 'm1', storedCounter: 9, now };
  assert.equal(acceptApproval(approval(), o).ok, true);
  assert.equal(acceptApproval(approval(), { ...o, storedCounter: 10 }).reason, 'old counter');
  assert.equal(acceptApproval(approval({ sk: newSecretKey() }), o).reason, 'unknown signer');
  assert.equal(acceptApproval(approval(), { ...o, now: now + 4000 }).reason, 'expired');
});

test('reports: signed, hash checked against the items', () => {
  const sk = newSecretKey();
  const ev = signEvent(reportTemplate({ machineId: 'm1', os: 'mac', items, createdAt: now }), sk);
  const r = readReport(ev, { now });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.machineId, 'm1');
  // Items changed after signing: the signature breaks.
  const changed = { ...ev, content: ev.content.replace('1.7.1', '9.9') };
  assert.equal(readReport(changed, { now }).reason, 'bad signature');
  // Signed, but the hash tag lies about the items.
  const lying = signEvent({ ...reportTemplate({ machineId: 'm1', os: 'mac', items, createdAt: now }), tags: [['d', 'm1'], ['report', 'f'.repeat(64)]] }, sk);
  assert.equal(readReport(lying, { now }).reason, 'hash does not match items');
});
