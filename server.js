/* ================================================================
   BIG SUN WALL: server
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

/* ---------------- placement: the slot grid ----------------
   The wall is divided into a grid of invisible cells and each piece is fitted
   inside one. Because every piece is scaled to sit within its own cell, two
   pieces can never overlap - it is guaranteed by the layout, not left to luck.

   GRID_COLS x GRID_ROWS is the only dial that matters:
     more cells  = smaller pieces, more of them on screen at once
     fewer cells = bigger, bolder pieces that turn over faster
   On a very large projection, raise these. 6 x 4 = 24 pieces at a time.

   When every cell is taken, the oldest piece retires to make room, so the
   wall keeps moving all night instead of freezing once it fills. */
const GRID_COLS = 6;
const GRID_ROWS = 4;
const SLOTS = GRID_COLS * GRID_ROWS;

const CELL_FILL = 0.86;   // fraction of a cell a piece may occupy (leaves gutters)
const WALL_AR = 16 / 9;   // assumed projector shape, for width<->height maths

/* set true only if you turn the on-wall QR panel back on (Q on the wall page) */
const RESERVE_QR_CORNER = false;

function slotIsUsable(i) {
  if (!RESERVE_QR_CORNER) return true;
  return !(i % GRID_COLS === GRID_COLS - 1 && Math.floor(i / GRID_COLS) === GRID_ROWS - 1);
}

/* Choose a cell: prefer an empty one, otherwise retire the oldest piece. */
function pickSlot() {
  const used = new Set(approved.map(t => t.slot));
  const free = [];
  for (let i = 0; i < SLOTS; i++) if (!used.has(i) && slotIsUsable(i)) free.push(i);
  if (free.length) return { slot: free[Math.floor(Math.random() * free.length)], retire: null };
  const oldest = approved[0];
  return { slot: oldest.slot, retire: oldest.id };
}

function assignPlacement(aspect, slot) {
  const a = aspect || 1;
  const cellW = 1 / GRID_COLS;
  const cellH = 1 / GRID_ROWS;

  /* Fit the piece inside its cell: cap by cell width, and by cell height
     once the image's own proportions are taken into account. */
  const byWidth  = CELL_FILL * cellW;
  const byHeight = CELL_FILL * cellH / (a * WALL_AR);
  const wFrac = Math.min(byWidth, byHeight);
  const hFrac = wFrac * a * WALL_AR;

  /* Drift inside whatever room is left over, so the grid never reads as a grid */
  const col = slot % GRID_COLS;
  const row = Math.floor(slot / GRID_COLS);
  const slackX = Math.max(0, cellW - wFrac) * 0.5;
  const slackY = Math.max(0, cellH - hFrac) * 0.5;

  const x = (col + 0.5) * cellW + (Math.random() * 2 - 1) * slackX;
  const y = (row + 0.5) * cellH + (Math.random() * 2 - 1) * slackY;

  return {
    slot: slot,
    x: +x.toFixed(4),
    y: +y.toFixed(4),
    rot: +(Math.random() * 8 - 4).toFixed(2),
    scale: +wFrac.toFixed(4)      // width as a fraction of the wall
  };
}

/* ---------------- submissions ---------------- */
app.post('/api/submit', (req, res) => {
  const b = req.body || {};

  if (typeof b.image !== 'string' || !b.image.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ ok: false, error: 'Bad image data.' });
  }
  if (b.image.length > 2600000) {
    return res.status(413).json({ ok: false, error: 'Drawing too large. Try a simpler piece.' });
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
  if (!autoApprove && pending.length >= MAX_PENDING) {
    return res.status(503).json({ ok: false, error: 'The queue is full. Try again in a minute.' });
  }

  lastSend.set(token, now);
  const w = Math.max(1, +b.w || 1);
  const h = Math.max(1, +b.h || 1);
  const item = { id: nextId++, name, image: b.image, aspect: +(h / w).toFixed(3), ts: now };

  if (autoApprove) {
    placeOnWall(item);
    broadcastCounts();
    return res.json({ ok: true, position: 0, live: true });
  }

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

/* Auto-approve: pieces go straight to the wall with no queue. You watch the
   wall and pull anything you don't want, instead of vetting each one first.
   Set AUTO_APPROVE=false in the environment to start with the queue on, and
   you can flip it either way from the moderation page while the show runs. */
let autoApprove = process.env.AUTO_APPROVE !== 'false';

function broadcastCounts() {
  io.to('mods').emit('counts', {
    pending: pending.length,
    onWall: approved.length,
    auto: autoApprove
  });
}

/* Put a piece on the wall. Used by the approve button and by auto-approve. */
function placeOnWall(item) {
  const { slot, retire } = pickSlot();
  if (retire !== null) {
    approved = approved.filter(t => t.id !== retire);
    io.to('wall').emit('wall:retire', retire);
    io.to('mods').emit('approved:remove', retire);
  }
  const tag = { ...item, ...assignPlacement(item.aspect, slot), approvedAt: Date.now() };
  approved.push(tag);
  if (approved.length > MAX_APPROVED) approved = approved.slice(-MAX_APPROVED);
  io.to('wall').emit('wall:add', tag);
  io.to('mods').emit('approved:add', tag);
  scheduleSave();
  return tag;
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
      placeOnWall(item);
      io.to('mods').emit('pending:remove', id);
      broadcastCounts();
    });

    socket.on('mod:setAuto', on => {
      if (!socket.data.isMod) return;
      autoApprove = !!on;
      /* turning it on clears whatever was already waiting straight to the wall */
      if (autoApprove && pending.length) {
        const queued = pending.splice(0, pending.length);
        queued.forEach(item => {
          placeOnWall(item);
          io.to('mods').emit('pending:remove', item.id);
        });
      }
      broadcastCounts();
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
  console.log('  Big Sun Wall is running');
  console.log(`     Phones paint at:  http://localhost:${PORT}/`);
  console.log(`     Projector page:   http://localhost:${PORT}/wall`);
  console.log(`     Moderation:       http://localhost:${PORT}/mod   (password: ${MOD_PASSWORD})`);
  console.log(`     Auto-approve:     ${autoApprove ? 'ON  (pieces go straight to the wall)' : 'off (queue for approval)'}`);
  console.log(`     Printable QR:     http://localhost:${PORT}/qr`);
  console.log('');
});
