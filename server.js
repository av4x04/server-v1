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

// Khởi tạo một pseudo-terminal và chạy shell trong đó
// Đây là tiến trình shell duy nhất, tất cả người dùng sẽ dùng chung
const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

// Serve file tĩnh từ thư mục public
app.use(express.static('public'));

// Khi có một client kết nối
io.on('connection', (socket) => {
  console.log('Một client đã kết nối.');

  // Khi client gửi dữ liệu (gõ phím) đến server
  socket.on('input', (data) => {
    // Ghi dữ liệu đó vào tiến trình shell
    ptyProcess.write(data);
  });

  // Khi client ngắt kết nối
  socket.on('disconnect', () => {
    console.log('Một client đã ngắt kết nối.');
  });
});

// Khi tiến trình shell có dữ liệu output (kết quả lệnh)
ptyProcess.on('data', function (data) {
  // Gửi dữ liệu đó đến TẤT CẢ các client đang kết nối
  io.emit('output', data);
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
