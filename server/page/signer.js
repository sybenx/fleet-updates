'use strict';
// The page's approval signer: one interface, { mode, getPublicKey(), signEvent(template) }.
//
// v1: the dashboard's own test key, asked over /api/dev/sign (only when FLEET_DEV_SIGNER=1).
// v2: the shared Keykin sign-in (a Keykin child key, NIP-46 to the phone) goes here instead, and
//     the server holds no approval key at all. Nothing else on the page changes.
window.FleetSigner = {
  mode: 'dev',
  async getPublicKey() {
    const r = await fetch('/api/state');
    return (await r.json()).signer.pubkey;
  },
  async signEvent(template) {
    const r = await fetch('/api/dev/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: template }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'no signer');
    return (await r.json()).event;
  },
};
