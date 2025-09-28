// public/client.js
const term = new Terminal();
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
