// public/client.js

// Cấu trúc DOM cần có trong index.html:
// <div id="controls">
//   <button id="new-session-btn">New Terminal</button>
//   <span id="status-text">Đang kết nối...</span>
// </div>
// <div id="tab-bar"></div>
// <div id="terminals"></div>
// <script src="/socket.io/socket.io.js"></script>
// <script src="https://unpkg.com/xterm/lib/xterm.js"></script>
// <link rel="stylesheet" href="https://unpkg.com/xterm/css/xterm.css"/>

const socket = io()
const sessions = {}       // { sessionId: { term, container, tabBtn } }
let currentSession = null

// Khởi tạo UI controls
const newBtn = document.getElementById('new-session-btn')
const statusText = document.getElementById('status-text')
const tabBar = document.getElementById('tab-bar')
const terminalsRoot = document.getElementById('terminals')

newBtn.addEventListener('click', () => {
  socket.emit('new-session')
})

// Khi server trả về danh sách session có sẵn
socket.on('sessions', list => {
  list.forEach(({ id }) => {
    if (!sessions[id]) createSessionTab(id)
  })
})

// Khi server confirm đã tạo session mới
socket.on('sessionCreated', sessionId => {
  createSessionTab(sessionId)
})

// Tạo tab và terminal instance cho session
function createSessionTab(sessionId) {
  // Tab button
  const btn = document.createElement('button')
  btn.textContent = sessionId.slice(0, 8)
  btn.addEventListener('click', () => selectSession(sessionId))
  tabBar.appendChild(btn)

  // Container div cho term
  const container = document.createElement('div')
  container.id = `term-${sessionId}`
  container.style.display = 'none'
  terminalsRoot.appendChild(container)

  // Khởi tạo xterm
  const term = new Terminal({
    theme: {
      background: '#1a1a1a',
      foreground: '#ffffff',
      cursor: '#00ff00',
      selection: '#404040'
    },
    fontSize: 14,
    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
    cursorBlink: true,
    cursorStyle: 'block'
  })
  term.open(container)
  term.onData(data => {
    socket.emit('input', { sessionId, data })
  })

  // Lưu vào sessions map và join room
  sessions[sessionId] = { term, container, tabBtn: btn }
  socket.emit('join', sessionId)
  selectSession(sessionId)
}

// Chuyển tab
function selectSession(sessionId) {
  Object.entries(sessions).forEach(([id, s]) => {
    const active = id === sessionId
    s.container.style.display = active ? 'block' : 'none'
    s.tabBtn.classList.toggle('active', active)
  })
  currentSession = sessionId
  resizeCurrent()
}

// Xử lý history khi join hoặc reconnect
socket.on('history', payload => {
  const { sessionId, history } = payload
  const s = sessions[sessionId]
  if (s) s.term.write(history)
})

// Xử lý output realtime
socket.on('output', payload => {
  const { sessionId, data } = payload
  const s = sessions[sessionId]
  if (s) s.term.write(data)
})

// Thông báo session đóng
socket.on('session-closed', sessionId => {
  const s = sessions[sessionId]
  if (!s) return
  s.term.writeln('\r\n\x1b[31m[Session closed]\x1b[0m')
  s.tabBtn.disabled = true
})

// Kết nối / mất kết nối
socket.on('connect', () => {
  statusText.textContent = 'Đã kết nối'
  socket.emit('list-sessions')
})
socket.on('disconnect', () => {
  statusText.textContent = 'Mất kết nối'
})

// Resize terminal khi kích thước cửa sổ thay đổi
window.addEventListener('resize', resizeCurrent)
function resizeCurrent() {
  if (!currentSession) return
  const s = sessions[currentSession]
  const cols = s.term.cols
  const rows = s.term.rows
  socket.emit('resize', { sessionId: currentSession, cols, rows })
}
