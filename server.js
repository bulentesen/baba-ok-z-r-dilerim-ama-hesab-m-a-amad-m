const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const onlineUsers = new Map(); // socketId -> { name, room }

io.on("connection", (socket) => {
  socket.on("join", ({ name, room }) => {
    const safeName = (name || "Anon").toString().slice(0, 24);
    const safeRoom = (room || "lobby").toString().slice(0, 24);

    onlineUsers.set(socket.id, { name: safeName, room: safeRoom });
    socket.join(safeRoom);

    io.to(safeRoom).emit("system", {
      text: `${safeName} katıldı.`,
      ts: Date.now()
    });

    // Room’daki kullanıcı listesini güncelle
    const members = [...onlineUsers.values()].filter(u => u.room === safeRoom).map(u => u.name);
    io.to(safeRoom).emit("presence", { members });
  });

  socket.on("typing", ({ room, name, isTyping }) => {
    const safeRoom = (room || "lobby").toString().slice(0, 24);
    const safeName = (name || "Anon").toString().slice(0, 24);
    socket.to(safeRoom).emit("typing", { name: safeName, isTyping: !!isTyping });
  });

  socket.on("chat", ({ room, name, text }) => {
    const safeRoom = (room || "lobby").toString().slice(0, 24);
    const safeName = (name || "Anon").toString().slice(0, 24);
    const msg = (text || "").toString().trim().slice(0, 500);
    if (!msg) return;

    io.to(safeRoom).emit("chat", {
      name: safeName,
      text: msg,
      ts: Date.now()
    });
  });

  socket.on("disconnect", () => {
    const info = onlineUsers.get(socket.id);
    if (!info) return;

    onlineUsers.delete(socket.id);
    io.to(info.room).emit("system", {
      text: `${info.name} ayrıldı.`,
      ts: Date.now()
    });

    const members = [...onlineUsers.values()].filter(u => u.room === info.room).map(u => u.name);
    io.to(info.room).emit("presence", { members });
  });
});

// Render/Platform uyumlu
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
