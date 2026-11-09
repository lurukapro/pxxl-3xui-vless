// pxxl-3xui launcher: bind $PORT (Pxxl edge -> TLS) and proxy both
//   /<PANEL_PATH>/*  -> 127.0.0.1:PANEL_PORT (3x-ui panel)
//   /*               -> 127.0.0.1:VLESS_PORT (Xray VLESS+WS inbound, path /<WS_PATH>)
// Pxxl terminates TLS at the edge; WS upgrade is forwarded transparently.
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PANEL_PORT = 54321;
const VLESS_PORT = 54322;
const PANEL_PATH = process.env.PANEL_PATH || 'paneladmin8x7';
const WS_PATH = process.env.WS_PATH || 'customwspath';
const UUID = process.env.VLESS_UUID || 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function startProcess(cmd, args, env, name) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => process.stdout.write(`[${name}] ` + d));
  p.stderr.on('data', d => process.stderr.write(`[${name}] ` + d));
  p.on('exit', (code) => { console.log(`[${name}] exited ${code}, restarting in 3s`); setTimeout(() => startProcess(cmd, args, env, name), 3000); });
  return p;
}

// 1) xray-core: VLESS + WS inbound on 127.0.0.1:VLESS_PORT
const xrayConfig = {
  log: { loglevel: 'warning' },
  inbounds: [{
    listen: '127.0.0.1', port: VLESS_PORT, protocol: 'vless',
    settings: { clients: [{ id: UUID, level: 0 }], decryption: 'none' },
    streamSettings: { network: 'ws', wsSettings: { path: '/' + WS_PATH } },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] }
  }],
  outbounds: [
    { protocol: 'freedom', tag: 'direct' },
    { protocol: 'blackhole', tag: 'block' }
  ]
};
fs.mkdirSync('/tmp', { recursive: true });
fs.writeFileSync('/tmp/xray-config.json', JSON.stringify(xrayConfig, null, 2));
startProcess(process.env.XRAY_PATH || '/app/xray/xray', ['run', '-c', '/tmp/xray-config.json'], {}, 'xray');

// 2) 3x-ui panel (optional control plane; port internal only)
startProcess(process.env.XUI_PATH || '/app/x-ui/x-ui', [], { XUI_ENABLE: 'true' }, 'x-ui');

// 3) edge-facing router
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const targetPort = urlPath.startsWith('/' + PANEL_PATH) ? PANEL_PORT : VLESS_PORT;

  const upstream = http.request({
    hostname: '127.0.0.1', port: targetPort,
    path: urlPath, method: req.method, headers: req.headers
  }, (upRes) => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); });
  upstream.on('error', () => { res.writeHead(502); res.end('upstream error'); });
  req.pipe(upstream);
});

// WebSocket upgrade: forward raw TCP to the right internal port
server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '/').split('?')[0];
  const targetPort = urlPath.startsWith('/' + PANEL_PATH) ? PANEL_PORT : VLESS_PORT;
  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    const headerLines = [`${req.method} ${urlPath} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
    upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => { socket.end(); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`edge router listening on 0.0.0.0:${PORT}`);
  console.log(`panel: https://<your-pxxl-domain>/${PANEL_PATH}`);
  console.log(`vless ws path: /${WS_PATH}`);
});
