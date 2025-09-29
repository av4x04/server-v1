// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false,
  cors: { origin: '*' }
});

const SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
const HISTORY_LIMIT = 1024 * 512; // 512KB

/* -------------------------
   RingBuffer cho history
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
  clear() {
    this.start = 0;
    this.len = 0;
  }
}

/* -------------------------
   Terminal Session (persistent)
   ------------------------- */
class TerminalSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.history = new RingBuffer(HISTORY_LIMIT);
    this.term = null;
    this.ready = false;
    this.writeQueue = [];
    this.writing = false;
    this.clients = new Set(); // tracking clients đang xem session này
    this.cols = 80;
    this.rows = 30;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  spawn() {
    if (this.term) return;
    try {
      this.term = pty.spawn(SHELL, [], {
        name: 'xterm-color',
        cols: this.cols,
        rows: this.rows,
        cwd: process.env.HOME || process.cwd(),
        env: process.env
      });

      this.term.on('data', (data) => {
        try {
          this.history.append(data);
          this.lastActivity = Date.now();
          // Broadcast tới tất cả clients đang xem session này
          io.to(this.sessionId).emit('output', data);
        } catch (err) {
          console.error(`Session ${this.sessionId} data error:`, err);
        }
      });

      this.term.on('error', (err) => {
        console.error(`Session ${this.sessionId} error:`, err);
      });

      this.term.on('exit', (code) => {
        console.log(`Session ${this.sessionId} exited with code ${code}`);
        this.ready = false;
        // Thông báo cho clients
        io.to(this.sessionId).emit('session-exited', { sessionId: this.sessionId, code });
        // Có thể auto-restart hoặc giữ nguyên để user restart manual
      });

      this.ready = true;
      console.log(`Session ${this.sessionId} spawned successfully`);
    } catch (err) {
      console.error(`Failed to spawn session ${this.sessionId}:`, err);
      throw err;
    }
  }

  write(data) {
    if (!this.ready || !this.term) return;
    this.lastActivity = Date.now();
    this.writeQueue.push(data);
    if (!this.writing) this._drainWrites();
  }

  _drainWrites() {
    if (this.writing) return;
    this.writing = true;
    const loop = () => {
      if (!this.term || this.writeQueue.length === 0) {
        this.writing = false;
        return;
      }
      const data = this.writeQueue.shift();
      try {
        this.term.write(data);
      } catch (err) {
        console.error(`Session ${this.sessionId} write error:`, err);
      }
      setImmediate(loop);
    };
    loop();
  }

  resize(cols, rows) {
    if (!this.ready || !this.term) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.term.resize(cols, rows);
    } catch (err) {
      console.error(`Session ${this.sessionId} resize error:`, err);
    }
  }

  addClient(socketId) {
    this.clients.add(socketId);
    this.lastActivity = Date.now();
  }

  removeClient(socketId) {
    this.clients.delete(socketId);
  }

  getClientCount() {
    return this.clients.size;
  }

  kill() {
    if (this.term) {
      try {
        this.term.kill();
      } catch (err) {
        console.error(`Error killing session ${this.sessionId}:`, err);
      }
      this.term = null;
    }
    this.ready = false;
  }

  getInfo() {
    return {
      sessionId: this.sessionId,
      ready: this.ready,
      clients: this.clients.size,
      historySize: this.history.bytes(),
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      uptime: this.ready ? Date.now() - this.createdAt : 0
    };
  }
}

/* -------------------------
   Session Manager - quản lý tất cả sessions
   ------------------------- */
const sessions = new Map(); // sessionId -> TerminalSession
let sessionCounter = 0;

function createSession() {
  sessionCounter++;
  const sessionId = `session-${sessionCounter}`;
  const session = new TerminalSession(sessionId);
  sessions.set(sessionId, session);
  session.spawn();
  console.log(`Created new session: ${sessionId}`);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function getAllSessions() {
  return Array.from(sessions.values()).map(s => s.getInfo());
}

function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.kill();
    sessions.delete(sessionId);
    console.log(`Deleted session: ${sessionId}`);
    // Thông báo tới tất cả clients
    io.emit('session-deleted', { sessionId });
    return true;
  }
  return false;
}

// Tạo session mặc định khi khởi động
createSession();

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
   Socket.IO handlers
   ------------------------- */
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  let currentSession = null; // session hiện tại mà client đang xem
  const bucket = createBucket(4096, 4096);

  // Gửi danh sách sessions cho client mới
  socket.emit('sessions-list', getAllSessions());

  // Join vào một session
  socket.on('join-session', (data) => {
    const sessionId = data?.sessionId;
    const session = getSession(sessionId);
    
    if (!session) {
      socket.emit('error', { message: `Session ${sessionId} not found` });
      return;
    }

    // Leave session cũ nếu có
    if (currentSession) {
      socket.leave(currentSession.sessionId);
      currentSession.removeClient(socket.id);
    }

    // Join session mới
    socket.join(sessionId);
    session.addClient(socket.id);
    currentSession = session;

    // Gửi history cho client
    const history = session.history.toString();
    if (history.length) {
      socket.emit('history', history);
    }

    socket.emit('joined-session', {
      sessionId: session.sessionId,
      info: session.getInfo()
    });

    // Broadcast cập nhật số clients
    io.to(sessionId).emit('session-updated', session.getInfo());
    
    console.log(`Client ${socket.id} joined session ${sessionId}`);
  });

  // Tạo session mới
  socket.on('create-session', () => {
    try {
      const session = createSession();
      // Broadcast tới tất cả clients về session mới
      io.emit('session-created', session.getInfo());
      
      // Tự động join vào session vừa tạo
      socket.join(session.sessionId);
      session.addClient(socket.id);
      currentSession = session;
      
      socket.emit('joined-session', {
        sessionId: session.sessionId,
        info: session.getInfo()
      });
    } catch (err) {
      socket.emit('error', { message: 'Failed to create session' });
    }
  });

  // Xóa session
  socket.on('delete-session', (data) => {
    const sessionId = data?.sessionId;
    if (deleteSession(sessionId)) {
      socket.emit('success', { message: `Session ${sessionId} deleted` });
    } else {
      socket.emit('error', { message: `Session ${sessionId} not found` });
    }
  });

  // Gửi input tới session hiện tại
  socket.on('input', (data) => {
    if (!currentSession || !currentSession.ready) {
      return;
    }
    const bytes = Buffer.byteLength(String(data), 'utf8');
    if (!bucket.take(bytes)) return; // rate limit
    currentSession.write(String(data));
  });

  // Resize terminal
  socket.on('resize', (data) => {
    if (!currentSession || !currentSession.ready) return;
    const cols = Number(data.cols) || 80;
    const rows = Number(data.rows) || 30;
    if (cols < 40 || cols > 1000 || rows < 10 || rows > 400) return;
    currentSession.resize(cols, rows);
    // Broadcast resize tới tất cả clients trong session
    io.to(currentSession.sessionId).emit('resized', { cols, rows });
  });

  // Get danh sách sessions
  socket.on('list-sessions', () => {
    socket.emit('sessions-list', getAllSessions());
  });

  // Disconnect
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    if (currentSession) {
      currentSession.removeClient(socket.id);
      // Broadcast cập nhật số clients
      io.to(currentSession.sessionId).emit('session-updated', currentSession.getInfo());
    }
  });
});

/* -------------------------
   Cleanup inactive sessions (optional)
   ------------------------- */
const INACTIVE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    // Nếu không có client nào và không hoạt động > 24h thì xóa
    if (session.getClientCount() === 0 && 
        (now - session.lastActivity) > INACTIVE_TIMEOUT) {
      console.log(`Cleaning up inactive session: ${sessionId}`);
      deleteSession(sessionId);
    }
  }
}, 60 * 60 * 1000); // Check mỗi 1 giờ

/* -------------------------
   Express routes
   ------------------------- */
app.use(express.static('public'));

// API để xem thông tin sessions
app.get('/api/sessions', (req, res) => {
  res.json(getAllSessions());
});

/* -------------------------
   Global error handlers & graceful shutdown
   ------------------------- */
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

function shutdown() {
  console.log('Shutting down...');
  // Kill tất cả sessions
  for (const [sessionId, session] of sessions.entries()) {
    console.log(`Killing session: ${sessionId}`);
    session.kill();
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* -------------------------
   Start server
   ------------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Sessions API: http://localhost:${PORT}/api/sessions`);
});
