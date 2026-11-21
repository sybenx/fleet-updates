// One JSON file under DATA_DIR. Written whole, through a temp file and a rename.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ASK_FIRST } from './policy.js';

export function emptyState() {
  return { version: 1, machines: {}, jobs: [], log: [], caskSeen: {}, askFirst: [...DEFAULT_ASK_FIRST] };
}

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'state.json');
  let state = emptyState();
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { ...emptyState(), ...loaded };
  }
  return {
    file,
    get state() {
      return state;
    },
    save() {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
