// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');

const app = express();
const server = http.createServer(app);

// Socket.IO tối ưu cho realtime terminal (giữ 1 session)
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6, // 1 MB
  perMessageDeflate: false,
  cors: { origin: '*' }
});

const SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

/* -------------------------
   RingBuffer (fixed bytes) để lưu history
   ------------------------- */
class RingBuffer {
  constructor(limitBytes) {
    this.buf = Buffer.allocUnsafe(limitBytes);
    this.limit = limitBytes;
    this.start = 0;
    this.len = 0;
  }
  append(input) {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    if (b.length >= this.limit) {
      b.copy(this.buf, 0, b.length - this.limit);
      this.start = 0;
      this.len = this.limit;
      return;
    }
    const free = this.limit - this.len;
    if (b.length > free) {
      this.start = (this.start + (b.length - free)) % this.limit;
      this.len = this.limit;
    } else {
      this.len += b.length;
    }
    const writePos = (this.start + this.len - b.length) % this.limit;
    const firstPart = Math.min(b.length, this.limit - writePos);
    b.copy(this.buf, writePos, 0, firstPart);
    if (firstPart < b.length) {
      b.copy(this.buf, 0, firstPart);
    }
  }
  toString(enc = 'utf8') {
    if (this.len === 0) return '';
    if (this.start + this.len <= this.limit) {
      return this.buf.slice(this.start, this.start + this.len).toString(enc);
    } else {
      const tailLen = (this.start + this.len) - this.limit;
      return Buffer.concat([
        this.buf.slice(this.start, this.limit),
        this.buf.slice(0, tailLen)
      ]).toString(enc);
    }
  }
  bytes() { return this.len; }
}

/* -------------------------
   Global state (1 session)
   ------------------------- */
const HISTORY_LIMIT = 1024 * 512; // 512KB
const history = new RingBuffer(HISTORY_LIMIT);

let globalTerm = null;
let termReady = false;

/* -------------------------
   Single write queue (single writer)
   ------------------------- */
const writeQueue = [];
let writing = false;
function enqueueWrite(chunk) {
  writeQueue.push(chunk);
  if (!writing) drainWrites();
}
function drainWrites() {
  if (writing) return;
  writing = true;
  (function loop() {
    if (!globalTerm || writeQueue.length === 0) {
      writing = false;
      return;
    }
    const data = writeQueue.shift();
    try { globalTerm.write(data); } catch (err) { console.error('PTY write error', err); }
    setImmediate(loop);
  })();
}

/* -------------------------
   PTY restart backoff
   ------------------------- */
let restartAttempts = 0;
function scheduleRestart() {
  const delay = Math.min(30000, 500 * Math.pow(2, restartAttempts));
  restartAttempts += 1;
  setTimeout(initGlobalTerm, delay);
}

/* -------------------------
   Init global PTY
   ------------------------- */
function initGlobalTerm() {
  if (globalTerm) return;
  restartAttempts = 0;
  try {
    globalTerm = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME || process.cwd(),
      env: process.env
    });
  } catch (err) {
    console.error('Failed to spawn PTY:', err);
    scheduleRestart();
    return;
  }

  globalTerm.on('data', (d) => {
    try {
      history.append(d);
      io.emit('output', d); // realtime broadcast giữ nguyên
    } catch (err) {
      console.error('Error on PTY data:', err);
    }
  });

  globalTerm.on('error', (err) => {
    console.error('PTY error:', err);
  });

  globalTerm.on('exit', (code) => {
    console.error('Global PTY exited code', code);
    try { globalTerm = null; } catch (e) {}
    termReady = false;
    scheduleRestart();
  });

  termReady = true;
  console.log('Global PTY ready');
}
initGlobalTerm();

app.use(express.static('public'));

/* -------------------------
   Token bucket per socket (rate-limit)
   ------------------------- */
function createBucket(capacity = 4096, refillRate = 4096) {
  let tokens = capacity;
  let last = Date.now();
  return {
    take(n = 1) {
      const now = Date.now();
      const delta = now - last;
      if (delta > 0) {
        tokens = Math.min(capacity, tokens + (delta / 1000) * refillRate);
        last = now;
      }
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    }
  };
}

/* -------------------------
   Socket handlers
   ------------------------- */
io.on('connection', (socket) => {
  console.log('Client connected', socket.id);

  // gửi history 1 lần cho client mới
  if (termReady) {
    const h = history.toString();
    if (h.length) socket.emit('history', h);
  }

  const bucket = createBucket(4096, 4096); // 4KB burst, refill 4KB/s

  socket.on('input', (data) => {
    if (!termReady || !globalTerm) return;
    const bytes = Buffer.byteLength(String(data), 'utf8');
    if (!bucket.take(bytes)) return; // drop nếu spam
    enqueueWrite(String(data));
  });

  // KHÔNG khuyến khích resize per-client; vẫn cho phép theo 1 policy
  socket.on('resize', (d) => {
    if (!termReady || !globalTerm) return;
    const cols = Number(d.cols) || 80;
    const rows = Number(d.rows) || 30;
    if (cols < 40 || cols > 1000 || rows < 10 || rows > 400) return;
    try { globalTerm.resize(cols, rows); } catch (e) { /* ignore */ }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected', socket.id, reason);
  });
});

/* -------------------------
   Global error handlers & graceful shutdown
   ------------------------- */
process.on('uncaughtException', (err) => { console.error('Uncaught exception', err); });
process.on('unhandledRejection', (r) => { console.error('Unhandled rejection', r); });

function shutdown() {
  console.log('Shutdown');
  try { if (globalTerm) globalTerm.kill(); } catch (e) {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* -------------------------
   Start server
   ------------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
