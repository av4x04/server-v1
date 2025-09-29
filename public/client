// public/client.js
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
});

term.open(document.getElementById('terminal'));

const socket = io();

// Khi người dùng gõ phím trong terminal trên trình duyệt
term.onData(data => {
  // Gửi dữ liệu đó đến server
  socket.emit('input', data);
});

// Khi server gửi dữ liệu output về
socket.on('output', data => {
  // Ghi dữ liệu đó vào terminal trên trình duyệt
  term.write(data);
});

// Khi nhận lịch sử terminal từ server
socket.on('history', history => {
  term.write(history);
});

// Xử lý resize terminal
function resizeTerminal() {
  const cols = term.cols;
  const rows = term.rows;
  socket.emit('resize', { cols, rows });
}

// Resize khi thay đổi kích thước cửa sổ
window.addEventListener('resize', resizeTerminal);

// Resize ban đầu
resizeTerminal();

// Khi kết nối thành công
socket.on('connect', () => {
  console.log('🟢 Đã kết nối đến server');
  document.getElementById('status-text').textContent = 'Đã kết nối';
  // Không hiển thị thông báo "Terminal đã sẵn sàng" vì có thể có lịch sử
});

// Khi mất kết nối
socket.on('disconnect', () => {
  console.log('🔴 Mất kết nối với server');
  document.getElementById('status-text').textContent = 'Mất kết nối';
  term.write('\x1b[31m⚠️  Mất kết nối với server. Đang thử kết nối lại...\x1b[0m\r\n');
});

// Các hàm cho UI
function newTerminal() {
  // Mở tab mới với cùng terminal (vì chỉ có 1 terminal toàn cục)
  window.open(window.location.href, '_blank');
}

function closeTerminal(terminalId) {
  // Chỉ đóng tab hiện tại
  window.close();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}
