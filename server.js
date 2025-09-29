// server.js
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const pty = require('node-pty')
const os = require('os')
const { randomUUID } = require('crypto')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false,
  cors: { origin: '*' }
})

const SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'bash'
const HISTORY_LIMIT = 1024 * 512  // 512KB

// RingBuffer lưu giữ history output
class RingBuffer {
  constructor(limitBytes) {
    this.buf = Buffer.allocUnsafe(limitBytes)
    this.limit = limitBytes
    this.start = 0
    this.len = 0
  }
  append(input) {
    const b = Buffer.isBuffer(input)
      ? input
      : Buffer.from(String(input), 'utf8')
    if (b.length >= this.limit) {
      b.copy(this.buf, 0, b.length - this.limit)
      this.start = 0
      this.len = this.limit
      return
    }
    const free = this.limit - this.len
    if (b.length > free) {
      this.start = (this.start + (b.length - free)) % this.limit
      this.len = this.limit
    } else {
      this.len += b.length
    }
    const writePos = (this.start + this.len - b.length) % this.limit
    const firstPart = Math.min(b.length, this.limit - writePos)
    b.copy(this.buf, writePos, 0, firstPart)
    if (firstPart < b.length) {
      b.copy(this.buf, 0, firstPart)
    }
  }
  toString(enc = 'utf8') {
    if (this.len === 0) return ''
    if (this.start + this.len <= this.limit) {
      return this.buf.slice(this.start, this.start + this.len).toString(enc)
    }
    const tailLen = this.start + this.len - this.limit
    return Buffer.concat([
      this.buf.slice(this.start, this.limit),
      this.buf.slice(0, tailLen)
    ]).toString(enc)
  }
}

// Token bucket đơn giản để rate-limit mỗi socket
function createBucket(capacity = 4096, refillRate = 4096) {
  let tokens = capacity
  let last = Date.now()
  return {
    take(n = 1) {
      const now = Date.now()
      const delta = now - last
      if (delta > 0) {
        tokens = Math.min(capacity, tokens + (delta / 1000) * refillRate)
        last = now
      }
      if (tokens >= n) {
        tokens -= n
        return true
      }
      return false
    }
  }
}

// Map lưu trữ các PTY session
const sessions = new Map()

app.use(express.static('public'))

io.on('connection', socket => {
  console.log('Client connected', socket.id)
  const bucket = createBucket()

  // Trả về danh sách session hiện có
  socket.on('list-sessions', () => {
    const list = Array.from(sessions.entries()).map(
      ([id, s]) => ({
        id,
        createdAt: s.createdAt,
        cols: s.term.cols,
        rows: s.term.rows,
        clients: io.sockets.adapter.rooms.get(id)?.size || 0
      })
    )
    socket.emit('sessions', list)
  })

  // Tạo session mới
  socket.on('new-session', () => {
    const sessionId = randomUUID()
    const history = new RingBuffer(HISTORY_LIMIT)
    const writeQueue = []
    let writing = false

    function enqueueWrite(chunk) {
      writeQueue.push(chunk)
      if (!writing) drainWrites()
    }
    function drainWrites() {
      if (writing) return
      writing = true
      ;(function loop() {
        if (writeQueue.length === 0) {
          writing = false
          return
        }
        const data = writeQueue.shift()
        try { term.write(data) }
        catch (err) { console.error('PTY write error', err) }
        setImmediate(loop)
      })()
    }

    const term = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME || process.cwd(),
      env: process.env
    })

    term.on('data', d => {
      history.append(d)
      io.to(sessionId).emit('output', d)
    })

    term.on('exit', code => {
      console.log(`Session ${sessionId} exited with code`, code)
      io.to(sessionId).emit('session-closed', sessionId)
      sessions.delete(sessionId)
    })

    sessions.set(sessionId, {
      term,
      history,
      enqueueWrite,
      createdAt: Date.now()
    })

    socket.emit('sessionCreated', sessionId)
  })

  // Join vào session đã có
  socket.on('join', sessionId => {
    const s = sessions.get(sessionId)
    if (!s) return
    socket.join(sessionId)
    const h = s.history.toString()
    if (h.length) socket.emit('history', h)
  })

  // Nhận input cho session
  socket.on('input', ({ sessionId, data }) => {
    const s = sessions.get(sessionId)
    if (!s) return
    const size = Buffer.byteLength(String(data), 'utf8')
    if (!bucket.take(size)) return
    s.enqueueWrite(data)
  })

  // Resize PTY
  socket.on('resize', ({ sessionId, cols, rows }) => {
    const s = sessions.get(sessionId)
    if (!s) return
    cols = Number(cols) || 80
    rows = Number(rows) || 30
    if (cols < 40 || cols > 1000 || rows < 10 || rows > 400) return
    try { s.term.resize(cols, rows) } catch {}
  })

  socket.on('disconnect', reason => {
    console.log('Client disconnected', socket.id, reason)
  })
})

// Bắt lỗi toàn cục & graceful shutdown
process.on('uncaughtException', err => console.error('Uncaught exception', err))
process.on('unhandledRejection', r => console.error('Unhandled rejection', r))
function shutdown() {
  console.log('Shutdown')
  for (const s of sessions.values()) {
    try { s.term.kill() } catch {}
  }
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Start server
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`)
})
