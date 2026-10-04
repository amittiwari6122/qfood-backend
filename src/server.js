import http from 'http';
import env from './config/env.js';
import { connectDB } from './config/db.js';
import app from './app.js';
import { initSocket } from './services/socket.js';
import { startJobs } from './jobs/expiry.js';
import { quantumHealth } from './services/quantum.js';

await connectDB();
const server = http.createServer(app);
initSocket(server);
startJobs();
server.listen(env.port, async () => {
  console.log(`API on http://localhost:${env.port}`);
  const q = await quantumHealth();
  console.log(q.reachable ? `Quantum service OK (${q.executionMode}, ${q.backend})` : `⚠ ${q.error} — matching will fail until it's running`);
});
