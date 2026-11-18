/* eslint-disable */
/**
 * Test-only helper: a real (in-process, WASM) Postgres for specs that must prove SQL semantics — e.g. the
 * Usage Report's atomic activity upsert (src/activity/activity-tracking.service.spec.ts).
 *
 * PGlite loads its WASM/data bundle with dynamic `import()`, which Jest's CommonJS VM refuses without
 * --experimental-vm-modules. So the spec FORKS this file as a plain Node child process and talks to it over IPC:
 *   → { id, op: 'exec', sql }               ← { id, ok: true }
 *   → { id, op: 'query', sql, params }      ← { id, ok: true, rows }
 *   → { id, op: 'close' }                   ← { id, ok: true }   (then exits)
 *   any failure                             ← { id, ok: false, error }
 * PGlite ships with Prisma 7's toolchain (@electric-sql/pglite via @prisma/dev), so no extra dependency.
 * Requests are handled strictly in arrival order (PGlite is a single connection).
 */
const { PGlite } = require('@electric-sql/pglite');

const db = new PGlite();
let chain = Promise.resolve();

process.on('message', (msg) => {
  chain = chain.then(async () => {
    try {
      if (msg.op === 'exec') {
        await db.exec(msg.sql);
        process.send({ id: msg.id, ok: true });
      } else if (msg.op === 'query') {
        const r = await db.query(msg.sql, msg.params || []);
        process.send({ id: msg.id, ok: true, rows: r.rows });
      } else if (msg.op === 'close') {
        await db.close();
        process.send({ id: msg.id, ok: true }, () => process.exit(0));
      } else {
        process.send({ id: msg.id, ok: false, error: `unknown op ${msg.op}` });
      }
    } catch (e) {
      process.send({ id: msg.id, ok: false, error: (e && e.message) || String(e) });
    }
  });
});
