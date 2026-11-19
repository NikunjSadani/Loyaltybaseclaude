/* eslint-disable */
// Child process for disposable-postgres.ts (WRE_PG_EMBEDDED=pglite): an in-memory PGlite (Postgres-in-WASM, from
// node_modules via @prisma/dev) behind a localhost socket. Runs outside the jest VM (PGlite needs native dynamic
// import). In-memory only: nothing is written to disk; the database dies with this process.
// Usage: node pglite-server.cjs <port>   → prints "READY <port>" once listening.
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

(async () => {
  const port = Number(process.argv[2]);
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 8 });
  await server.start();
  process.stdout.write(`READY ${port}\n`);
  const stop = async () => {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop); // parent died / closed our stdin
  process.stdin.resume();
})().catch((e) => {
  process.stderr.write(`PGLITE_FAILED ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
