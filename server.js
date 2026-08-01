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
const ARCHIVE_FILE = path.join(__dirname, 'archive.json');

const COOLDOWN_MS = 45 * 1000;  // minimum gap between sends, per phone
const MAX_PENDING = 200;        // moderation queue cap
const MAX_APPROVED = 350;       // pieces kept in server memory (the wall keeps its own copy too)
const DATA_KEEP = 200;          // how many approved pieces get saved to disk
const ARCHIVE_MAX = 3000;       // every piece ever sent, kept for the archive

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- state ---------------- */
let pending = [];   // waiting for the moderator
let approved = [];  // on the wall
let archive = [];   // never pruned by the grid: this is the record
let nextId = 1;
const lastSend = new Map(); // phone token -> last submit time

try {
  if (fs.existsSync(DATA_FILE)) {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    approved = Array.isArray(s.approved) ? s.approved : [];
    nextId = s.nextId || approved.length + 1;
    // an archive written by an older build still lives in data.json
    if (Array.isArray(s.archive)) archive = s.archive;
    console.log(`Loaded ${approved.length} saved pieces from data.json`);
  }
} catch (e) {
  console.log('Could not load data.json (starting fresh):', e.message);
}

try {
  if (fs.existsSync(ARCHIVE_FILE)) {
    const a = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    if (Array.isArray(a.archive) && a.archive.length >= archive.length) archive = a.archive;
    console.log(`Loaded ${archive.length} archived pieces from archive.json`);
  }
} catch (e) {
  console.log('Could not load archive.json (starting fresh):', e.message);
}

/* The live file stays small and quick: it is written 4s after each approval,
   so it must not carry the archive. JSON.stringify is synchronous and blocks
   the event loop, which stalls socket.io and stutters the wall. */
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

/* The archive is big and does not need to be current. Written on its own slow
   timer, and only when something new has landed, so a quiet room costs nothing.
   Worst case on a crash is losing the last two minutes of pieces, and the wall
   browser keeps its own IndexedDB copy regardless. */
let archiveDirty = false;
function saveArchive() {
  if (!archiveDirty) return;
  archiveDirty = false;
  fs.writeFile(ARCHIVE_FILE, JSON.stringify({ archive: archive.slice(-ARCHIVE_MAX) }), err => {
    if (err) { console.log('Archive save failed:', err.message); archiveDirty = true; }
  });
}
setInterval(saveArchive, 120000);

/* On the way out the write must be synchronous. An async write does not finish
   before process.exit, which leaves a truncated, empty archive.json. */
function shutdown() {
  try {
    if (archiveDirty) {
      fs.writeFileSync(ARCHIVE_FILE, JSON.stringify({ archive: archive.slice(-ARCHIVE_MAX) }));
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify({ approved: approved.slice(-DATA_KEEP), nextId }));
    console.log(`Saved ${archive.length} archived pieces on shutdown.`);
  } catch (e) {
    console.log('Shutdown save failed:', e.message);
  }
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

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

/* The wall is the only thing that knows its own shape: the canvas is the inner
   stage, inset inside the window chrome with the toolbox down one side, and it
   changes again when the toolbox or status bar is toggled. Guessing it here was
   the bug. So this hands the wall a slot and two jitter values and lets it do
   the fitting against its real dimensions.

   x, y and scale are still written for older wall pages and for anything
   already sitting in data.json. Current wall pages ignore them. */
function assignPlacement(aspect, slot) {
  const a = aspect || 1;
  const cellW = 1 / GRID_COLS;
  const cellH = 1 / GRID_ROWS;

  const jx = +(Math.random() * 2 - 1).toFixed(4);
  const jy = +(Math.random() * 2 - 1).toFixed(4);

  // legacy fallback maths, using the old assumed aspect
  const byWidth  = CELL_FILL * cellW;
  const byHeight = CELL_FILL * cellH / (a * WALL_AR);
  const wFrac = Math.min(byWidth, byHeight);
  const hFrac = wFrac * a * WALL_AR;
  const col = slot % GRID_COLS;
  const row = Math.floor(slot / GRID_COLS);
  const slackX = Math.max(0, cellW - wFrac) * 0.5;
  const slackY = Math.max(0, cellH - hFrac) * 0.5;

  return {
    slot: slot,
    jx: jx,
    jy: jy,
    rot: +(Math.random() * 8 - 4).toFixed(2),
    x: +((col + 0.5) * cellW + jx * slackX).toFixed(4),
    y: +((row + 0.5) * cellH + jy * slackY).toFixed(4),
    scale: +wFrac.toFixed(4)
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
  res.json({ pending: pending.length, onWall: approved.length, archived: archive.length });
});

/* ---------------- the archive ----------------
   Everything that ever went on the wall, including pieces the grid has
   since cycled off. Open /archive in a browser to view and download. */
app.get('/api/archive', (req, res) => {
  res.json({
    count: archive.length,
    pieces: archive.map(t => ({ id: t.id, ts: t.ts, approvedAt: t.approvedAt, image: t.image }))
  });
});

app.get('/healthz', (req, res) => res.send('ok'));

/* ---------------- pages ---------------- */
const pub = f => path.join(__dirname, 'public', f);
app.get('/', (req, res) => res.sendFile(pub('paint.html')));
app.get('/wall', (req, res) => res.sendFile(pub('wall.html')));
app.get('/mod', (req, res) => res.sendFile(pub('mod.html')));
app.get('/qr', (req, res) => res.sendFile(pub('qr.html')));
app.get('/archive', (req, res) => res.sendFile(pub('archive.html')));

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

  /* The grid cycles pieces off the wall to make room. The archive does not:
     it is the permanent record of everything that went up tonight. */
  archive.push(tag);
  archiveDirty = true;
  if (archive.length > ARCHIVE_MAX) archive = archive.slice(-ARCHIVE_MAX);
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
    socket.emit('wall:meta', {
      count: approved.length,
      grid: { cols: GRID_COLS, rows: GRID_ROWS, fill: CELL_FILL }
    });
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
