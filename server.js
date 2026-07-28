/* ================================================================
   BIG SUN WALL — server
   One small Node server that:
     - serves the four pages (paint / wall / mod / qr)
     - accepts drawings from phones (HTTP POST)
     - holds them in a moderation queue
     - pushes approved pieces to the projector in real time (Socket.IO)
   Run:   npm install   then   npm start
   ================================================================ */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MOD_PASSWORD = process.env.MOD_PASSWORD || 'bigsun';   // <-- change this (see README)
const DATA_FILE = path.join(__dirname, 'data.json');

const COOLDOWN_MS = 45 * 1000;  // minimum gap between sends, per phone
const MAX_PENDING = 200;        // moderation queue cap
const MAX_APPROVED = 350;       // pieces kept in server memory (the wall keeps its own copy too)
const DATA_KEEP = 200;          // how many approved pieces get saved to disk

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- state ---------------- */
let pending = [];   // waiting for the moderator
let approved = [];  // on the wall
let nextId = 1;
const lastSend = new Map(); // phone token -> last submit time

try {
  if (fs.existsSync(DATA_FILE)) {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    approved = Array.isArray(s.approved) ? s.approved : [];
    nextId = s.nextId || approved.length + 1;
    console.log(`Loaded ${approved.length} saved pieces from data.json`);
  }
} catch (e) {
  console.log('Could not load data.json (starting fresh):', e.message);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const slim = { approved: approved.slice(-DATA_KEEP), nextId };
    fs.writeFile(DATA_FILE, JSON.stringify(slim), err => {
      if (err) console.log('Save failed:', err.message);
    });
  }, 4000);
}

// forget stale cooldown entries once an hour
setInterval(() => {
  const cutoff = Date.now() - 2 * COOLDOWN_MS;
  for (const [k, v] of lastSend) if (v < cutoff) lastSend.delete(k);
}, 60 * 60 * 1000);

/* ---------------- placement ----------------
   The server decides where each approved piece lands so the mural spreads
   across the wall instead of piling up. Coordinates are 0..1 fractions of
   the projected area.

   RESERVE_QR_CORNER: set true only if you turn the on-wall QR panel back on
   (the Q key on the wall page). Left false, pieces use the whole wall. */
const RESERVE_QR_CORNER = false;

function assignPlacement(aspect) {
  const scale = 0.12 + Math.random() * 0.10;               // piece width as a fraction of wall width
  const hFrac = Math.min(0.8, scale * (aspect || 1) * (16 / 9));
  const yMin = 0.05 + hFrac / 2;
  const yMax = Math.max(yMin + 0.01, 0.90 - hFrac / 2);
  const recent = approved.slice(-14);
  let best = null, bestScore = -1;
  for (let i = 0; i < 12; i++) {
    const x = 0.06 + Math.random() * 0.88;
    const y = yMin + Math.random() * (yMax - yMin);
    if (RESERVE_QR_CORNER && x > 0.76 && y > 0.62) continue;
    let d = 9;
    for (const r of recent) d = Math.min(d, (x - r.x) ** 2 + (y - r.y) ** 2);
    if (d > bestScore) { bestScore = d; best = { x, y }; }
  }
  if (!best) best = { x: 0.2 + Math.random() * 0.5, y: 0.2 + Math.random() * 0.5 };
  return {
    x: +best.x.toFixed(4),
    y: +best.y.toFixed(4),
    rot: +(Math.random() * 14 - 7).toFixed(2),
    scale: +scale.toFixed(3)
  };
}

/* ---------------- submissions ---------------- */
app.post('/api/submit', (req, res) => {
  const b = req.body || {};

  if (typeof b.image !== 'string' || !b.image.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ ok: false, error: 'Bad image data.' });
  }
  if (b.image.length > 2600000) {
    return res.status(413).json({ ok: false, error: 'Drawing too large — try a simpler piece.' });
  }

  /* The tag is signed in paint, so a typed name is optional. Kept sanitised
     in case a name is ever supplied again; empty means "no caption". */
  const name = String(b.name || '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);

  const token = String(b.token || req.ip || 'x').slice(0, 64);
  const now = Date.now();
  const last = lastSend.get(token) || 0;
  if (now - last < COOLDOWN_MS) {
    return res.status(429).json({ ok: false, wait: Math.ceil((COOLDOWN_MS - (now - last)) / 1000) });
  }
  if (pending.length >= MAX_PENDING) {
    return res.status(503).json({ ok: false, error: 'The queue is full — try again in a minute.' });
  }

  lastSend.set(token, now);
  const w = Math.max(1, +b.w || 1);
  const h = Math.max(1, +b.h || 1);
  const item = { id: nextId++, name, image: b.image, aspect: +(h / w).toFixed(3), ts: now };
  pending.push(item);
  io.to('mods').emit('pending:new', item);
  broadcastCounts();
  res.json({ ok: true, position: pending.length });
});

app.get('/api/stats', (req, res) => {
  res.json({ pending: pending.length, onWall: approved.length });
});

app.get('/healthz', (req, res) => res.send('ok'));

/* ---------------- pages ---------------- */
const pub = f => path.join(__dirname, 'public', f);
app.get('/', (req, res) => res.sendFile(pub('paint.html')));
app.get('/wall', (req, res) => res.sendFile(pub('wall.html')));
app.get('/mod', (req, res) => res.sendFile(pub('mod.html')));
app.get('/qr', (req, res) => res.sendFile(pub('qr.html')));

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  return `${req.protocol}://${req.get('host')}`;
}

app.get('/url', (req, res) => res.type('text').send(baseUrl(req)));

app.get('/qr.png', async (req, res) => {
  try {
    const size = Math.min(parseInt(req.query.size, 10) || 900, 2000);
    const png = await QRCode.toBuffer(baseUrl(req), {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    res.set('Cache-Control', 'public, max-age=300').type('png').send(png);
  } catch (e) {
    res.status(500).send('QR failed');
  }
});

/* ---------------- realtime ---------------- */
// Big payloads are sent to clients in small batches so a full wall
// (hundreds of images) streams in smoothly instead of one giant message.
function sendBatched(socket, event, items, doneEvent, size = 8) {
  let i = 0;
  (function next() {
    if (!socket.connected) return;
    if (i >= items.length) { if (doneEvent) socket.emit(doneEvent); return; }
    socket.emit(event, items.slice(i, i + size));
    i += size;
    setTimeout(next, 30);
  })();
}

function broadcastCounts() {
  io.to('mods').emit('counts', { pending: pending.length, onWall: approved.length });
}

io.on('connection', socket => {
  const auth = socket.handshake.auth || {};

  /* ---- projector display ---- */
  if (auth.role === 'wall') {
    socket.join('wall');
    socket.emit('wall:meta', { count: approved.length });
    sendBatched(socket, 'wall:batch', approved, 'wall:done');
    return;
  }

  /* ---- moderator ---- */
  if (auth.role === 'mod') {
    if (auth.password !== MOD_PASSWORD) {
      socket.emit('mod:denied');
      socket.disconnect(true);
      return;
    }
    socket.data.isMod = true;
    socket.join('mods');
    broadcastCounts();
    sendBatched(socket, 'mod:pendingBatch', pending, 'mod:pendingDone');
    sendBatched(socket, 'mod:approvedBatch', approved.slice(-24), null);

    socket.on('mod:approve', id => {
      if (!socket.data.isMod) return;
      const i = pending.findIndex(p => p.id === id);
      if (i === -1) return;
      const item = pending.splice(i, 1)[0];
      const tag = { ...item, ...assignPlacement(item.aspect), approvedAt: Date.now() };
      approved.push(tag);
      if (approved.length > MAX_APPROVED) approved = approved.slice(-MAX_APPROVED);
      io.to('wall').emit('wall:add', tag);
      io.to('mods').emit('pending:remove', id);
      io.to('mods').emit('approved:add', tag);
      broadcastCounts();
      scheduleSave();
    });

    socket.on('mod:reject', id => {
      if (!socket.data.isMod) return;
      const i = pending.findIndex(p => p.id === id);
      if (i === -1) return;
      pending.splice(i, 1);
      io.to('mods').emit('pending:remove', id);
      broadcastCounts();
    });

    // yank a piece that already made it onto the wall
    socket.on('mod:remove', id => {
      if (!socket.data.isMod) return;
      const i = approved.findIndex(a => a.id === id);
      if (i === -1) return;
      approved.splice(i, 1);
      io.to('wall').emit('wall:remove', id);
      io.to('mods').emit('approved:remove', id);
      broadcastCounts();
      scheduleSave();
    });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  \u{1F31E} Big Sun Wall is running');
  console.log(`     Phones paint at:  http://localhost:${PORT}/`);
  console.log(`     Projector page:   http://localhost:${PORT}/wall`);
  console.log(`     Moderation:       http://localhost:${PORT}/mod   (password: ${MOD_PASSWORD})`);
  console.log(`     Printable QR:     http://localhost:${PORT}/qr`);
  console.log('');
});
