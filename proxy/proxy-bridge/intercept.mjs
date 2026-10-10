// proxy-bridge/intercept.mjs
//
// A TLS-intercepting forward proxy that rides on an existing http.Server (its
// 'connect' event), for agents that cannot be pointed at a base URL without losing
// their own login — copilot's GitHub session, opencode's github-copilot OAuth,
// pi's providers. The agent gets HTTPS_PROXY=http://<user>:<session>@host:port
// plus NODE_EXTRA_CA_CERTS=<ca.pem>; it keeps its own credentials, model
// catalogue and routing, and every call to a listed model host is decrypted here,
// handed to `onRequest` (which forwards + measures it), and re-encrypted.
//
//   - Only hosts on the list are decrypted; every other CONNECT is a blind
//     tunnel. Both chain through the daemon's own upstream proxy (corporate
//     egress) unless NO_PROXY exempts the host.
//   - The CA is persistent (ca.pem + ca.key, key 0600) so an agent's
//     NODE_EXTRA_CA_CERTS stays valid across daemon restarts. It is never added
//     to any OS trust store: only processes given NODE_EXTRA_CA_CERTS trust it.
//   - Each CA has a subject of its own and the leaves name it by key identifier:
//     a bundle may hold two of these CAs (the user's NODE_EXTRA_CA_CERTS plus
//     ours), and OpenSSL 3.0 (Node 22) checks a leaf against the first CA with a
//     matching name only — same-named CAs fail with "certificate signature failure".
//   - The session credential in Proxy-Authorization is the binding: it names the
//     wrapper session (and so the task) the decrypted requests belong to.
//
// Captured traffic includes the agent's own bearer tokens in transit — it is
// forwarded, never stored by this module.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { shouldBypassProxy } from './no-proxy.mjs';

const { pki, md } = forge;
const CA_SUBJECT = 'glass local interception CA';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function rsaKeyPair() {
  // Node's native keygen (fast); node-forge only builds and signs the X.509 cert.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const key = pki.privateKeyFromPem(keyPem);
  return { key, publicKey: pki.setRsaPublicKey(key.n, key.e), keyPem };
}

/** Key identifier of an RSA public key (SHA-1 of RSAPublicKey, as forge computes the SKI). */
const keyIdOf = (publicKey) => pki.getPublicKeyFingerprint(publicKey, { type: 'RSAPublicKey' }).getBytes();

function buildCert({ cn, days, issuer, issuerKeyId, signKey, publicKey, isCa }) {
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = crypto.randomBytes(9).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer(issuer || [{ name: 'commonName', value: cn }]);
  cert.setExtensions(isCa
    ? [{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' }]
    : [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: cn }] },
      { name: 'authorityKeyIdentifier', keyIdentifier: issuerKeyId }]);
  cert.sign(signKey, md.sha256.create());
  return cert;
}

/**
 * The persistent interception CA in `dir` — created on first use.
 * @returns {{ caPath: string, cert: object, key: object, certPem: string }}
 */
export function loadOrCreateCa(dir) {
  const caPath = path.join(dir, 'ca.pem');
  const keyPath = path.join(dir, 'ca.key');
  if (fs.existsSync(caPath) && fs.existsSync(keyPath)) {
    const certPem = fs.readFileSync(caPath, 'utf8');
    return { caPath, cert: pki.certificateFromPem(certPem), key: pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8')), certPem };
  }
  fs.mkdirSync(dir, { recursive: true });
  const { key, publicKey, keyPem } = rsaKeyPair();
  const cert = buildCert({ cn: `${CA_SUBJECT} ${crypto.randomBytes(4).toString('hex')}`, days: 3650, signKey: key, publicKey, isCa: true });
  const certPem = pki.certificateToPem(cert);
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(caPath, certPem);
  return { caPath, cert, key, certPem };
}

/** Host patterns (`*` = one DNS label) → one matcher. */
export function hostMatcher(patterns) {
  const res = patterns.map((p) => (p instanceof RegExp ? p
    : new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+')}$`, 'i')));
  return (host) => res.some((re) => re.test(host));
}

/** The session credential (password half) of a `Proxy-Authorization: Basic …` header. */
export function bindingOf(header) {
  const m = /^Basic\s+(\S+)$/i.exec(header || '');
  if (!m) return '';
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i === -1 ? '' : decoded.slice(i + 1);
}

/** A raw TCP socket to host:port — through a CONNECT on the upstream proxy when there is one. */
export function dial(upstream, host, port) {
  return new Promise((resolve, reject) => {
    if (!upstream) {
      const s = net.connect(port, host, () => resolve(s));
      s.once('error', reject);
      return;
    }
    const req = http.request({
      host: upstream.hostname, port: upstream.port || 80, method: 'CONNECT', path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    });
    req.once('connect', (res, socket) => (res.statusCode === 200
      ? resolve(socket) : (socket.destroy(), reject(new Error(`upstream CONNECT ${host} → ${res.statusCode}`)))));
    req.once('error', reject);
    req.end();
  });
}

/**
 * Add TLS interception to `server`.
 *
 * @param {import('node:http').Server} server  the daemon's server (its normal routes stay)
 * @param {object} o
 * @param {string} o.caDir
 * @param {Array<string|RegExp>} o.hosts       hosts to decrypt
 * @param {string|null} [o.upstreamProxy]     the daemon's own egress proxy (http://h:p)
 * @param {string} [o.noProxy]                hosts that bypass it (NO_PROXY syntax)
 * @param {(req, res, ctx: {host: string, binding: string}) => void} o.onRequest
 * @param {(msg: string) => void} [o.logErr]
 * @returns {{ caPath: string, close: () => void }}  close also destroys every open tunnel
 */
export function attachIntercept(server, { caDir, hosts, upstreamProxy = null, noProxy = '', onRequest, logErr = () => {} }) {
  const ca = loadOrCreateCa(caDir);
  const isIntercepted = hostMatcher(hosts);
  const up = upstreamProxy ? new URL(upstreamProxy) : null;
  const leaves = new Map();
  const leafFor = (host) => {
    if (!leaves.has(host)) {
      const { key, publicKey, keyPem } = rsaKeyPair();
      const cert = buildCert({ cn: host, days: 30, issuer: ca.cert.subject.attributes, issuerKeyId: keyIdOf(ca.cert.publicKey), signKey: ca.key, publicKey });
      leaves.set(host, tls.createSecureContext({ key: keyPem, cert: pki.certificateToPem(cert) }));
    }
    return leaves.get(host);
  };

  // Plain HTTP over sockets this module has already decrypted.
  const decrypted = http.createServer((req, res) => {
    const host = (req.headers.host || req.socket.glassHost || '').split(':')[0];
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `request body over ${MAX_BODY_BYTES} bytes` }));
      return;
    }
    Promise.resolve(onRequest(req, res, { host, binding: req.socket.glassBinding || '' })).catch((err) => {
      logErr(`intercept ${host}${req.url} failed: ${err?.message || err}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  decrypted.on('clientError', (err, s) => { logErr(`intercept client error: ${err.code || err.message}`); s.destroy(); });

  const viaUpstream = (host) => (up && !shouldBypassProxy(`https://${host}`, noProxy) ? up : null);

  // A CONNECT socket leaves the server's bookkeeping: closeAllConnections() skips
  // it, yet server.close() still waits for it. Track them so close() can end them.
  const open = new Set();
  let closed = false;
  const track = (s) => { open.add(s); s.once('close', () => open.delete(s)); };

  const onConnect = async (req, client, head) => {
    client.on('error', (err) => logErr(`intercept socket: ${err.code || err.message}`));
    track(client);
    const [host, portStr] = (req.url || '').split(':');
    const port = Number(portStr) || 443;
    if (isIntercepted(host)) {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) client.unshift(head);
      const tlsSock = new tls.TLSSocket(client, {
        isServer: true, ALPNProtocols: ['http/1.1'], SNICallback: (sn, cb) => cb(null, leafFor(sn || host)),
      });
      tlsSock.glassBinding = bindingOf(req.headers['proxy-authorization']);
      tlsSock.glassHost = host;
      tlsSock.on('error', (err) => logErr(`intercept tls ${host}: ${err.code || err.message}`));
      decrypted.emit('connection', tlsSock);
      return;
    }
    let sock;
    try { sock = await dial(viaUpstream(host), host, port); } catch (err) {
      logErr(`tunnel ${host}: ${err.message}`);
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    if (closed || client.destroyed) { sock.destroy(); client.destroy(); return; }
    track(sock);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) sock.write(head);
    sock.pipe(client); client.pipe(sock);
    sock.on('error', () => client.destroy()); client.on('close', () => sock.destroy());
  };
  server.on('connect', onConnect);

  return {
    caPath: ca.caPath,
    close: () => {
      closed = true;
      server.off('connect', onConnect);
      decrypted.close();
      for (const s of open) s.destroy();
    },
  };
}
