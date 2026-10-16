// Local terminal: DNS-rebinding guard. The server binds loopback only, but a
// hostile page can still reach it through a rebound hostname. Every route must
// refuse a Host header that is not this exact loopback origin.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { createTerminalServer, SCENARIOS_PATH, VIEW_PATH } from '../scripts/serve_terminal_local.mjs';

const server = await createTerminalServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

function get(pathname, host, method = 'GET') {
  return new Promise((resolve, reject) => {
    const headers = host === undefined ? {} : { host };
    const req = request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const paths = ['/', '/index.html', VIEW_PATH, `${VIEW_PATH}?scenario=golden`, SCENARIOS_PATH, '/js/dashboard.js'];

// Legitimate loopback origins stay served.
for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
  for (const pathname of paths) {
    const res = await get(pathname, host);
    assert.equal(res.status, 200, `${host} ${pathname} must be served`);
  }
}

// Rebound, foreign, wrong-port or missing hosts are refused everywhere, with
// no terminal data in the body.
const hostile = [
  'attacker.example', `attacker.example:${port}`, `127.0.0.1.attacker.example:${port}`,
  `localhost.attacker.example:${port}`, '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`,
  `127.0.0.1:${port}@attacker.example`, `attacker.example#127.0.0.1:${port}`, ' ',
  `LOCALHOST.:${port}`, `0.0.0.0:${port}`, `[::1]:${port}`,
];
for (const host of hostile) {
  for (const pathname of paths) {
    const res = await get(pathname, host);
    assert.equal(res.status, 403, `Host ${JSON.stringify(host)} ${pathname} must be refused`);
    assert.doesNotMatch(res.body, /chainState|schemaVersion|V2_VIEW_URL/, 'refusal leaks no view data');
    assert.equal(res.headers['cache-control'], 'no-store');
  }
}
const head = await get(VIEW_PATH, 'attacker.example', 'HEAD');
assert.equal(head.status, 403);

// HTTP/1.0 without any Host header (the client above always supplies one).
const raw = await new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port }, () => socket.write(`GET ${VIEW_PATH} HTTP/1.0\r\n\r\n`));
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { data += chunk; });
  socket.on('end', () => resolve(data));
  socket.on('error', reject);
});
assert.match(raw, /^HTTP\/1\.1 403 /, 'a request without Host is refused');
assert.doesNotMatch(raw, /chainState|schemaVersion/, 'refusal leaks no view data');

await new Promise((resolve) => server.close(resolve));
console.log('PASS terminal local refuses non-loopback Host headers on every route (DNS-rebinding guard)');
