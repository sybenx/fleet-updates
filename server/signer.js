// The approval signer, behind one interface: { mode, pubkey, sign(template) }.
//
// v1: a test key kept in DATA_DIR, only with FLEET_DEV_SIGNER=1. The page asks the server to sign.
// v2: the page signs in the browser through the shared Keykin sign-in (a Keykin child key, NIP-46
//     to Aaron's phone). The server then holds no approval key at all: it only knows the
//     approver's public key (FLEET_APPROVER) to check what it stores, and `sign` is gone.
import fs from 'node:fs';
import path from 'node:path';
import { newSecretKey, publicKey, signEvent } from './protocol.js';

export function createSigner({ dataDir, dev = false, approverPubkey = '' }) {
  if (dev) {
    const file = path.join(dataDir, 'dev-signer.key');
    let sk;
    if (fs.existsSync(file)) sk = fs.readFileSync(file, 'utf8').trim();
    else {
      sk = newSecretKey();
      fs.writeFileSync(file, sk + '\n', { mode: 0o600 });
    }
    return { mode: 'dev', pubkey: publicKey(sk), sign: (template) => signEvent(template, sk) };
  }
  return { mode: approverPubkey ? 'external' : 'none', pubkey: approverPubkey, sign: null };
}
