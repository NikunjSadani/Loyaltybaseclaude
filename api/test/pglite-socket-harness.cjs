/* eslint-disable */
/**
 * Test-only: a real (WASM) Postgres served over the Postgres WIRE PROTOCOL, so a spec can drive it with the REAL
 * PrismaClient (@prisma/adapter-pg → pg) — interactive transactions, SAVEPOINT / ROLLBACK TO SAVEPOINT, unique /
 * partial unique indexes, row locks are all genuine Postgres behaviour. Forked as a child process for the same
 * reason as pglite-harness.cjs (PGlite's dynamic import() vs Jest's CJS VM). Parent sends { op: 'start', port };
 * child answers { ok: true, port } once listening; { op: 'stop' } shuts it down.
 * Use the pg Pool with max: 1 (PGlite is a single backend; the socket server queues per query).
 */
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

let db, server;
process.on('message', async (msg) => {
  try {
    if (msg.op === 'start') {
      db = await PGlite.create();
      server = new PGLiteSocketServer({ db, port: msg.port, host: '127.0.0.1', maxConnections: 4 });
      await server.start();
      process.send({ ok: true, port: msg.port });
    } else if (msg.op === 'stop') {
      if (server) await server.stop();
      if (db) await db.close();
      process.send({ ok: true }, () => process.exit(0));
    }
  } catch (e) {
    process.send({ ok: false, error: (e && e.message) || String(e) });
  }
});
