// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const pty = require('node-pty');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Xác định shell mặc định của hệ điều hành
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

// Tạo 1 terminal duy nhất chạy liên tục 24/7
let globalTerminal = null;
let terminalHistory = []; // Lưu lịch sử terminal
let isTerminalReady = false;

// Khởi tạo terminal toàn cục
function initGlobalTerminal() {
  if (globalTerminal) return;
  
  globalTerminal = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
  });

  // Lưu tất cả output vào history
  globalTerminal.on('data', (data) => {
    terminalHistory.push(data);
    // Giới hạn history để không tốn RAM
    if (terminalHistory.length > 1000) {
      terminalHistory = terminalHistory.slice(-500);
    }
    // Gửi đến tất cả client đang kết nối
    io.emit('output', data);
  });

  // Nếu terminal bị crash, tự động khởi tạo lại
  globalTerminal.on('exit', (code) => {
    console.log(`🔴 Terminal toàn cục đã thoát với code: ${code}. Đang khởi tạo lại...`);
    globalTerminal = null;
    isTerminalReady = false;
    setTimeout(initGlobalTerminal, 1000); // Khởi tạo lại sau 1 giây
  });

  isTerminalReady = true;
  console.log('🟢 Terminal toàn cục đã sẵn sàng!');
}

// Khởi tạo terminal ngay khi server start
initGlobalTerminal();

// Serve file tĩnh từ thư mục public
app.use(express.static('public'));

// Khi có một client kết nối
io.on('connection', (socket) => {
  console.log(`🟢 Client ${socket.id} đã kết nối.`);

  // Gửi lịch sử terminal cho client mới
  if (isTerminalReady && terminalHistory.length > 0) {
    socket.emit('history', terminalHistory.join(''));
  }

  // Khi client gửi dữ liệu (gõ phím) đến server
  socket.on('input', (data) => {
    if (globalTerminal && isTerminalReady) {
      globalTerminal.write(data);
    }
  });

  // Khi client gửi resize terminal
  socket.on('resize', (data) => {
    if (globalTerminal && isTerminalReady) {
      globalTerminal.resize(data.cols, data.rows);
    }
  });

  // Khi client ngắt kết nối
  socket.on('disconnect', () => {
    console.log(`🔴 Client ${socket.id} đã ngắt kết nối.`);
    // Terminal vẫn chạy liên tục, không bị ảnh hưởng
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
