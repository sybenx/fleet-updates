// Writes test/fixtures/protocol/vectors.json: events signed by the Node side (the dashboard's
// test signer), with the hashes the Go agent must compute the same way. Run: node test/make-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalTemplate, eventId, itemId, publicKey, reportHash, signEvent } from '../server/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Fixed test keys. Never used for anything real.
const approverSk = '0000000000000000000000000000000000000000000000000000000000000003';
const otherSk = '0000000000000000000000000000000000000000000000000000000000000007';
const items = [
  { channel: 'brew-formula', name: 'jq', current: '1.7', latest: '1.7.1' },
  { channel: 'brew-cask', name: 'firefox', current: '120.0', latest: '121.0' },
  { channel: 'winget', name: '7zip.7zip', current: '< 23.01', latest: '24.08' },
  { channel: 'flatpak-user', name: 'org.mozilla.firefox//stable', current: '', latest: '121.0' },
];
const hash = reportHash('mac', items);
const now = 1795000000;
const approval = signEvent(approvalTemplate({ machineId: 'abcd1234', reportHash: hash, counter: 5, now, ttl: 3600, only: [itemId('brew-formula', 'jq')], overrides: { dozzle: 'compare' }, askFirst: ['Valve.Steam'] }), approverSk);
const byOther = signEvent(approvalTemplate({ machineId: 'abcd1234', reportHash: hash, counter: 6, now, ttl: 3600 }), otherSk);
const odd = { pubkey: publicKey(approverSk), created_at: now, kind: 1, tags: [['t', 'a "b" \\ c']], content: 'line\nnext\ttab \u0001 é ü 😀 </script>' };
const out = {
  approver: publicKey(approverSk),
  other: publicKey(otherSk),
  now,
  items,
  report_hash: hash,
  item_ids: Object.fromEntries(items.map((i) => [`${i.channel}|${i.name}`, itemId(i.channel, i.name)])),
  approval,
  approval_by_other: byOther,
  odd_event: { ...odd, id: eventId(odd) },
};
fs.writeFileSync(path.join(here, 'fixtures', 'protocol', 'vectors.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote vectors.json');
