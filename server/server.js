import http from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 7480);
const host = process.env.HOST || '0.0.0.0';
const app = createApp({
  dataDir: process.env.DATA_DIR || './data',
  agentsDir: process.env.AGENTS_DIR || undefined,
  distDir: process.env.DIST_DIR || undefined,
  publicUrl: process.env.FLEET_URL || '',
  // v1: a test approval key held here. v2: the page signs through Keykin; set FLEET_APPROVER instead.
  devSigner: process.env.FLEET_DEV_SIGNER === '1',
  approverPubkey: process.env.FLEET_APPROVER || '',
});
// Umbrels have no agent: the server checks them every 30 minutes.
const timer = setInterval(() => app.checkAllUmbrels().catch(() => {}), 30 * 60 * 1000);
timer.unref();
app.checkAllUmbrels().catch(() => {});
// Umbrels on the tailnet that are not cards yet: every 30 minutes, and when a report brings a
// changed tailnet.
const finder = setInterval(() => app.findUmbrels().catch(() => {}), 30 * 60 * 1000);
finder.unref();
app.findUmbrels().catch(() => {});
const server = http.createServer(app.handle);
server.listen(port, host, () => console.log(`fleet-updates listening on ${host}:${server.address().port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
