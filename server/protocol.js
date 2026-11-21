// The messages between the dashboard and the machines. PROTOCOL.md says the same in prose; keep
// both in step.
//
// State, not messages: each machine has ONE latest report and the dashboard ONE latest approval
// per machine. Newer replaces older, so a lost one is harmless.
//
// Both are Nostr events (NIP-01 ids, BIP340 Schnorr signatures over the id), so a Keykin-signed
// approval verifies unchanged in v2 and both can later ride over relays (the report content then
// NIP-44 encrypted to the dashboard inbox key). v1 carries them over plain HTTP.
//
// A machine applies only what it proposed: an approval names a report hash; the machine
// regenerates its own list, checks the hash, and applies its own list under its own rules. It never
// takes package names or commands from the dashboard. `only` narrows the machine's own list by item
// id; it can never add to it.

import { schnorr } from './vendor/node_modules/@noble/curves/secp256k1.js';
import crypto from 'node:crypto';

export const VERSION = 1;
// Our own addressable kinds (30000-39999; not 30078, not Keykin's kept kinds 30000-30004, 30015, 30030).
export const REPORT_KIND = 31748;
export const APPROVAL_KIND = 31747;
export const APPROVAL_TTL_S = 24 * 3600;
export const MAX_FUTURE_S = 600;

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

// ---- NIP-01 events ----

export function eventId(ev) {
  return sha256hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
}

export function verifyEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!isHex(ev.pubkey, 64) || !isHex(ev.id, 64) || !isHex(ev.sig, 128)) return false;
  if (!Number.isInteger(ev.created_at) || !Number.isInteger(ev.kind) || !Array.isArray(ev.tags) || typeof ev.content !== 'string') return false;
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  if (eventId(ev) !== ev.id) return false;
  try {
    return schnorr.verify(bytes(ev.sig), bytes(ev.id), bytes(ev.pubkey));
  } catch {
    return false;
  }
}

export function newSecretKey() {
  const sk = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey();
  return hex(sk);
}

export function publicKey(skHex) {
  return hex(schnorr.getPublicKey(bytes(skHex)));
}

// Signs a template { kind, created_at, tags, content }. Used by the dev signer and by tests; in v2
// the page signs approvals through Keykin and the machines sign their own reports.
export function signEvent(template, skHex) {
  const ev = { pubkey: publicKey(skHex), created_at: template.created_at, kind: template.kind, tags: template.tags, content: template.content };
  ev.id = eventId(ev);
  ev.sig = hex(schnorr.sign(bytes(ev.id), bytes(skHex)));
  return ev;
}

export const tag = (ev, name) => (ev.tags.find((t) => t[0] === name) || [])[1];
export const tagsAll = (ev, name) => ev.tags.filter((t) => t[0] === name);

// ---- items and report hashes ----

// An item's id: what `only` refers to. The machine computes it from its own list.
export function itemId(channel, name) {
  return sha256hex(`${channel}\u0000${name}`).slice(0, 12);
}

// The hash of what a machine proposes: os and each item's channel, name, current and latest
// version, sorted. Flags that change minute to minute (an app running) are left out on purpose:
// those are the machine's local rules at apply time.
export function reportHash(os, items) {
  const rows = items.map((i) => [String(i.channel), String(i.name), String(i.current ?? ''), String(i.latest ?? '')]);
  rows.sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : a.join('\u0000') > b.join('\u0000') ? 1 : 0));
  return sha256hex(JSON.stringify([VERSION, String(os), rows]));
}

// Report content (JSON in `content`; NIP-44 encrypted in v2):
//   { v, os, host, items: [{ channel, name, title, current, latest, flags }], badges: [...],
//     applied: [{ at, how, channel, name, from, to, status, message }], last_counter, uninstall? }
// Tags: ["d", machine id], ["report", report hash]. Signed by the machine's own key.
export function reportTemplate({ machineId, os, host = '', items = [], badges = [], applied = [], lastCounter = 0, createdAt, uninstall = false }) {
  const body = { v: VERSION, os, host, items, badges, applied, last_counter: lastCounter };
  if (uninstall) body.uninstall = true; // the machine is leaving: take its card off
  const content = JSON.stringify(body);
  return { kind: REPORT_KIND, created_at: createdAt, tags: [['d', machineId], ['report', reportHash(os, items)]], content };
}

// -> { ok, reason, payload }
export function readReport(ev, { now }) {
  if (!verifyEvent(ev)) return { ok: false, reason: 'bad signature' };
  if (ev.kind !== REPORT_KIND) return { ok: false, reason: 'wrong kind' };
  if (ev.created_at > now + MAX_FUTURE_S) return { ok: false, reason: 'from the future' };
  let payload;
  try {
    payload = JSON.parse(ev.content);
  } catch {
    return { ok: false, reason: 'bad content' };
  }
  if (!payload || !Array.isArray(payload.items)) return { ok: false, reason: 'bad content' };
  if (reportHash(payload.os, payload.items) !== tag(ev, 'report')) return { ok: false, reason: 'hash does not match items' };
  return { ok: true, payload, hash: tag(ev, 'report'), machineId: tag(ev, 'd') };
}

// ---- approvals ----

// The unsigned approval the page hands to its signer.
// Tags: ["d", machine id], ["report", hash], ["counter", n], ["expiration", unix] (NIP-40),
// optional ["only", item id, ...], ["override", stack, pinned|compare] (Dockge),
// ["ask_first", winget id, ...] (Windows overnight policy).
export function approvalTemplate({ machineId, reportHash: h, counter, now, ttl = APPROVAL_TTL_S, only = [], overrides = {}, askFirst = [] }) {
  const tags = [
    ['d', machineId],
    ['report', h],
    ['counter', String(counter)],
    ['expiration', String(now + ttl)],
  ];
  if (only.length) tags.push(['only', ...only]);
  for (const [stack, mode] of Object.entries(overrides)) tags.push(['override', stack, mode]);
  if (askFirst.length) tags.push(['ask_first', ...askFirst]);
  return { kind: APPROVAL_KIND, created_at: now, tags, content: '' };
}

function approvalFields(ev) {
  const counter = Number(tag(ev, 'counter'));
  const expiration = Number(tag(ev, 'expiration'));
  const only = (ev.tags.find((t) => t[0] === 'only') || []).slice(1);
  const overrides = Object.fromEntries(tagsAll(ev, 'override').map((t) => [t[1], t[2]]));
  const askFirst = (ev.tags.find((t) => t[0] === 'ask_first') || []).slice(1);
  return { counter, expiration, only, overrides, askFirst, report: tag(ev, 'report'), machine: tag(ev, 'd') };
}

// What a MACHINE checks before applying anything (reference implementation; every agent does the
// same). Any failure means: do nothing, report fresh.
// -> { ok, reason, ...fields }
export function checkApproval(ev, { approver, machineId, lastCounter, localHash, now }) {
  if (!ev) return { ok: false, reason: 'no approval' };
  if (!verifyEvent(ev)) return { ok: false, reason: 'bad signature' };
  if (ev.pubkey !== approver) return { ok: false, reason: 'unknown signer' };
  if (ev.kind !== APPROVAL_KIND) return { ok: false, reason: 'wrong kind' };
  const f = approvalFields(ev);
  if (f.machine !== machineId) return { ok: false, reason: 'for another machine' };
  if (!Number.isSafeInteger(f.counter) || f.counter <= lastCounter) return { ok: false, reason: 'old counter', ...f };
  if (!Number.isFinite(f.expiration) || now >= f.expiration) return { ok: false, reason: 'expired', ...f };
  if (ev.created_at > now + MAX_FUTURE_S) return { ok: false, reason: 'from the future', ...f };
  if (f.report !== localHash) return { ok: false, reason: 'report changed', ...f };
  return { ok: true, reason: '', ...f };
}

// What the DASHBOARD checks before it stores an approval to hand out: right signer, right
// machine, counter above the last one, not expired. The hash may already be stale; the machine
// decides that.
export function acceptApproval(ev, { approver, machineId, storedCounter, now }) {
  if (!verifyEvent(ev)) return { ok: false, reason: 'bad signature' };
  if (ev.pubkey !== approver) return { ok: false, reason: 'unknown signer' };
  if (ev.kind !== APPROVAL_KIND) return { ok: false, reason: 'wrong kind' };
  const f = approvalFields(ev);
  if (f.machine !== machineId) return { ok: false, reason: 'for another machine' };
  if (!Number.isSafeInteger(f.counter) || f.counter <= storedCounter) return { ok: false, reason: 'old counter' };
  if (!Number.isFinite(f.expiration) || now >= f.expiration) return { ok: false, reason: 'expired' };
  if (ev.created_at > now + MAX_FUTURE_S) return { ok: false, reason: 'from the future' };
  return { ok: true, ...f };
}

export { approvalFields };
