/**
 * Local Web Push dry-run — proves the BACKEND send path end-to-end with the REAL
 * `web-push` library (the same version PushSenderService uses), without any vendor
 * push service. A tiny local HTTP server stands in for the browser's push endpoint
 * (FCM / Mozilla autopush). We assert the request web-push actually puts on the wire
 * is a correctly VAPID-signed, encrypted Web Push request, and that a 410 surfaces as
 * statusCode 410 (which drives PushSenderService's dead-endpoint prune branch).
 *
 * Run:  node api/scripts/push-dryrun.mjs
 */
import webpush from 'web-push';
import https from 'node:https';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real push endpoints are always HTTPS, so web-push speaks TLS. Stand up a local
// HTTPS mock with a self-signed cert and accept it (this is a throwaway local mock).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pushdry-'));
const keyPath = path.join(tmp, 'key.pem');
const certPath = path.join(tmp, 'cert.pem');
execSync(
  `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 1 -subj "/CN=localhost"`,
  { stdio: 'ignore' },
);

let failures = 0;
function check(ok, msg) {
  console.log(`${ok ? '  ✅ PASS' : '  ❌ FAIL'} — ${msg}`);
  if (!ok) failures += 1;
}

// 1) Generate a platform-wide VAPID keypair (what the owner will do for prod).
const vapid = webpush.generateVAPIDKeys();
webpush.setVapidDetails('mailto:ops@gifsy.in', vapid.publicKey, vapid.privateKey);

// 2) Fake a browser PushSubscription keypair (P-256). web-push encrypts TO this.
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const p256dh = ecdh.getPublicKey().toString('base64url');
const auth = crypto.randomBytes(16).toString('base64url');

// 3) Local HTTPS server standing in for the vendor push endpoint.
let received = null;
let responseStatus = 201;
const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
  (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { method: req.method, headers: req.headers, bodyLen: Buffer.concat(chunks).length };
      res.writeHead(responseStatus);
      res.end();
    });
  },
);
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const origin = `https://localhost:${port}`;
const subscription = { endpoint: `${origin}/push/endpoint-abc`, keys: { p256dh, auth } };

console.log('\n— Test 1: a real VAPID-signed, encrypted push reaches the subscription endpoint —');
responseStatus = 201;
await webpush.sendNotification(
  subscription,
  JSON.stringify({ title: 'Deoleo India', body: 'You earned 500 points', url: '/sales' }),
);

check(!!received, 'web-push delivered a request to the subscription endpoint');
check(received?.method === 'POST', `request method is POST (${received?.method})`);
const enc = received?.headers['content-encoding'];
check(enc === 'aes128gcm', `payload is encrypted (Content-Encoding: ${enc})`);
check((received?.bodyLen ?? 0) > 0, `encrypted body present (${received?.bodyLen} bytes)`);
check(received?.headers['ttl'] !== undefined, `TTL header present (${received?.headers['ttl']})`);

const authz = received?.headers['authorization'] ?? '';
check(/^vapid\s+t=.+,\s*k=.+/i.test(authz), 'VAPID Authorization header present (signed JWT + key)');
const kMatch = authz.match(/k=([A-Za-z0-9_-]+)/);
check(kMatch?.[1] === vapid.publicKey, 'VAPID Authorization `k` matches our generated public key');

const tMatch = authz.match(/t=([A-Za-z0-9_.-]+)/);
const jwt = tMatch?.[1];
let claims = {};
try {
  claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
} catch {
  /* ignore */
}
check(claims.aud === origin, `VAPID JWT aud = endpoint origin (${claims.aud})`);
check(typeof claims.exp === 'number' && claims.exp * 1000 > Date.now(), 'VAPID JWT not expired');

console.log('\n— Test 2: a 410 Gone surfaces as statusCode 410 (drives the prune branch) —');
responseStatus = 410;
let pruneStatus = null;
try {
  await webpush.sendNotification(subscription, JSON.stringify({ title: 'x', body: 'y' }));
} catch (e) {
  pruneStatus = e?.statusCode;
}
check(pruneStatus === 410, `410 → statusCode 410, so PushSenderService deletes the dead sub (got ${pruneStatus})`);

server.close();

console.log(
  '\nNote: the vendor relay (FCM/Mozilla) → real-device notification display is standard\n' +
    'web-push behaviour and is the cutover smoke. This dry-run proves OUR send path\n' +
    '(VAPID signing + ECE encryption + transport + 410 handling) with the real library.',
);
console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
