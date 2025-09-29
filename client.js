// public/client.js

// State management
const state = {
  sessions: new Map(), // sessionId -> { term, element, info }
  currentSessionId: null,
  socket: null
};

// Khởi tạo Socket.IO
const socket = io();
state.socket = socket;

/* -------------------------
   Terminal Management
   ------------------------- */
function createTerminalInstance(sessionId) {
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
    cursorStyle: 'block',
    scrollback: 10000
  });

  // Container cho terminal này
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = `terminal-${sessionId}`;
  container.style.display = 'none';
  document.getElementById('terminals-wrapper').appendChild(container);

  term.open(container);

  // Xử lý input từ user
  term.onData(data => {
    if (state.currentSessionId === sessionId) {
      socket.emit('input', data);
    }
  });

  // Xử lý resize
  term.onResize(({ cols, rows }) => {
    if (state.currentSessionId === sessionId) {
      socket.emit('resize', { cols, rows });
    }
  });

  return { term, element: container };
}

function switchToSession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  // Ẩn tất cả terminals
  state.sessions.forEach((s, id) => {
    s.element.style.display = 'none';
    const tab = document.querySelector(`[data-session-id="${id}"]`);
    if (tab) tab.classList.remove('active');
  });

  // Hiển thị terminal được chọn
  session.element.style.display = 'block';
  const tab = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (tab) tab.classList.add('active');

  state.currentSessionId = sessionId;
  session.term.focus();

  // Join session trên server
  socket.emit('join-session', { sessionId });

  // Resize terminal
  setTimeout(() => {
    session.term.fit && session.term.fit();
    socket.emit('resize', { 
      cols: session.term.cols, 
      rows: session.term.rows 
    });
  }, 50);
}

/* -------------------------
   UI Management
   ------------------------- */
function createSessionTab(sessionInfo) {
  const tabsContainer = document.getElementById('tabs-container');
  
  const tab = document.createElement('div');
  tab.className = 'terminal-tab';
  tab.dataset.sessionId = sessionInfo.sessionId;
  
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = `Terminal ${sessionInfo.sessionId.split('-')[1]}`;
  
  const clientCount = document.createElement('span');
  clientCount.className = 'client-count';
  clientCount.textContent = `👥 ${sessionInfo.clients}`;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-tab';
  closeBtn.textContent = '×';
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    closeSession(sessionInfo.sessionId);
  };
  
  tab.appendChild(title);
  tab.appendChild(clientCount);
  tab.appendChild(closeBtn);
  
  tab.onclick = () => switchToSession(sessionInfo.sessionId);
  
  tabsContainer.appendChild(tab);
  return tab;
}

function updateSessionTab(sessionInfo) {
  const tab = document.querySelector(`[data-session-id="${sessionInfo.sessionId}"]`);
  if (!tab) return;
  
  const clientCount = tab.querySelector('.client-count');
  if (clientCount) {
    clientCount.textContent = `👥 ${sessionInfo.clients}`;
  }
}

function removeSessionTab(sessionId) {
  const tab = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (tab) tab.remove();
}

/* -------------------------
   Session Actions
   ------------------------- */
function newTerminal() {
  socket.emit('create-session');
}

function closeSession(sessionId) {
  // Nếu chỉ còn 1 session thì không cho đóng
  if (state.sessions.size <= 1) {
    alert('Không thể đóng session cuối cùng!');
    return;
  }

  const confirm = window.confirm(`Đóng terminal ${sessionId}?`);
  if (!confirm) return;

  socket.emit('delete-session', { sessionId });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

/* -------------------------
   Socket Event Handlers
   ------------------------- */

// Khi kết nối thành công
socket.on('connect', () => {
  console.log('🟢 Đã kết nối đến server');
  updateStatus('Đã kết nối', 'connected');
});

// Khi mất kết nối
socket.on('disconnect', () => {
  console.log('🔴 Mất kết nối với server');
  updateStatus('Mất kết nối', 'disconnected');
  
  // Hiển thị thông báo trên tất cả terminals
  state.sessions.forEach(session => {
    session.term.write('\x1b[31m⚠️  Mất kết nối với server. Đang thử kết nối lại...\x1b[0m\r\n');
  });
});

// Nhận danh sách sessions
socket.on('sessions-list', (sessions) => {
  console.log('📋 Danh sách sessions:', sessions);
  
  sessions.forEach(sessionInfo => {
    if (!state.sessions.has(sessionInfo.sessionId)) {
      // Tạo terminal mới cho session này
      const { term, element } = createTerminalInstance(sessionInfo.sessionId);
      state.sessions.set(sessionInfo.sessionId, {
        term,
        element,
        info: sessionInfo
      });
      createSessionTab(sessionInfo);
    }
  });

  // Nếu chưa có session nào được chọn, chọn session đầu tiên
  if (!state.currentSessionId && sessions.length > 0) {
    switchToSession(sessions[0].sessionId);
  }
});

// Session mới được tạo
socket.on('session-created', (sessionInfo) => {
  console.log('✨ Session mới:', sessionInfo);
  
  const { term, element } = createTerminalInstance(sessionInfo.sessionId);
  state.sessions.set(sessionInfo.sessionId, {
    term,
    element,
    info: sessionInfo
  });
  createSessionTab(sessionInfo);
  
  // Tự động switch sang session mới
  switchToSession(sessionInfo.sessionId);
});

// Đã join vào session
socket.on('joined-session', (data) => {
  console.log('✅ Đã join session:', data.sessionId);
  const session = state.sessions.get(data.sessionId);
  if (session) {
    session.info = data.info;
    updateSessionTab(data.info);
  }
});

// Nhận history khi join session
socket.on('history', (history) => {
  const session = state.sessions.get(state.currentSessionId);
  if (session) {
    session.term.write(history);
  }
});

// Nhận output realtime
socket.on('output', (data) => {
  const session = state.sessions.get(state.currentSessionId);
  if (session) {
    session.term.write(data);
  }
});

// Session bị xóa
socket.on('session-deleted', ({ sessionId }) => {
  console.log('🗑️  Session bị xóa:', sessionId);
  
  const session = state.sessions.get(sessionId);
  if (session) {
    // Xóa terminal element
    session.term.dispose();
    session.element.remove();
    state.sessions.delete(sessionId);
    removeSessionTab(sessionId);

    // Nếu đang xem session bị xóa, switch sang session khác
    if (state.currentSessionId === sessionId) {
      const remainingSessions = Array.from(state.sessions.keys());
      if (remainingSessions.length > 0) {
        switchToSession(remainingSessions[0]);
      } else {
        state.currentSessionId = null;
      }
    }
  }
});

// Session updated (số clients thay đổi)
socket.on('session-updated', (sessionInfo) => {
  const session = state.sessions.get(sessionInfo.sessionId);
  if (session) {
    session.info = sessionInfo;
    updateSessionTab(sessionInfo);
  }
});

// Session exited
socket.on('session-exited', ({ sessionId, code }) => {
  console.log(`⚠️  Session ${sessionId} exited with code ${code}`);
  const session = state.sessions.get(sessionId);
  if (session) {
    session.term.write(`\r\n\x1b[33m⚠️  Process exited with code ${code}\x1b[0m\r\n`);
  }
});

// Resized
socket.on('resized', ({ cols, rows }) => {
  const session = state.sessions.get(state.currentSessionId);
  if (session && session.term.cols !== cols || session.term.rows !== rows) {
    session.term.resize(cols, rows);
  }
});

// Error
socket.on('error', ({ message }) => {
  console.error('❌ Error:', message);
  alert(`Error: ${message}`);
});

// Success
socket.on('success', ({ message }) => {
  console.log('✅ Success:', message);
});

/* -------------------------
   Utility Functions
   ------------------------- */
function updateStatus(text, status) {
  const statusEl = document.getElementById('status-text');
  const indicatorEl = document.getElementById('status-indicator');
  
  if (statusEl) statusEl.textContent = text;
  if (indicatorEl) {
    indicatorEl.className = 'status-indicator';
    if (status) indicatorEl.classList.add(status);
  }
}

/* -------------------------
   Window Events
   ------------------------- */
window.addEventListener('resize', () => {
  const session = state.sessions.get(state.currentSessionId);
  if (session && session.term.fit) {
    session.term.fit();
    socket.emit('resize', {
      cols: session.term.cols,
      rows: session.term.rows
    });
  }
});

// Xử lý khi đóng trang
window.addEventListener('beforeunload', () => {
  // Socket.IO sẽ tự động disconnect
  console.log('👋 Đang đóng trang...');
});

// Fit addon cho xterm.js (nếu có)
if (typeof FitAddon !== 'undefined') {
  // Thêm fit addon cho mỗi terminal khi tạo
  const originalCreate = createTerminalInstance;
  createTerminalInstance = function(sessionId) {
    const result = originalCreate(sessionId);
    const fitAddon = new FitAddon.FitAddon();
    result.term.loadAddon(fitAddon);
    result.term.fit = () => fitAddon.fit();
    return result;
  };
}

console.log('🚀 Client initialized');
