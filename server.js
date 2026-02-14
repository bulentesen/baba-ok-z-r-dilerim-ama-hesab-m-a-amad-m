const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MONGODB_URI = process.env.MONGODB_URI;

// ----- MongoDB -----
const messageSchema = new mongoose.Schema(
  {
    room: { type: String, index: true },
    name: String,
    text: String,
    ts: { type: Number, index: true }
  },
  { versionKey: false }
);
const Message = mongoose.model("Message", messageSchema);

async function connectDb() {
  if (!MONGODB_URI) {
    console.warn("MONGODB_URI yok. DB kapalı çalışacağım (mesajlar kaydolmaz).");
    return;
  }
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000
  });
  console.log("MongoDB connected");
}

// ----- Tek sayfa HTML -----
const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Mini Chat</title>
<style>
body{font-family:system-ui,Arial;margin:0;background:#111;color:#eee}
.wrap{max-width:900px;margin:0 auto;padding:16px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px;padding:14px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input,button{padding:10px 12px;border-radius:10px;border:1px solid #333;background:#101010;color:#eee}
button{cursor:pointer}
#chat{height:55vh;overflow:auto;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:14px;padding:12px}
.msg{margin:8px 0}
.name{color:#9be7ff}
.sys{color:#aaa;font-style:italic}
.pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#222;border:1px solid #333;color:#bbb;margin-right:6px}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.typing{color:#bbb;margin-top:8px;height:18px}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="top">
    <div><span class="pill">Mini Chat</span><span class="pill" id="roomPill">room: -</span></div>
    <div id="members" class="pill">online: -</div>
  </div>

  <div class="row" style="margin-top:10px">
    <input id="name" placeholder="Adın"/>
    <input id="room" placeholder="Oda (ör: kuzen)"/>
    <button id="joinBtn">Bağlan</button>
  </div>

  <div style="margin-top:12px" id="chat"></div>
  <div class="typing" id="typing"></div>

  <div class="row" style="margin-top:10px">
    <input id="text" placeholder="Mesaj yaz..." style="flex:1;min-width:240px" disabled/>
    <button id="sendBtn" disabled>Gönder</button>
  </div>
</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const elChat = document.getElementById("chat");
const elName = document.getElementById("name");
const elRoom = document.getElementById("room");
const elJoin = document.getElementById("joinBtn");
const elText = document.getElementById("text");
const elSend = document.getElementById("sendBtn");
const elTyping = document.getElementById("typing");
const elMembers = document.getElementById("members");
const elRoomPill = document.getElementById("roomPill");

let joined=false, currentRoom="", typingTimer=null;

function addLine(html){
  const div=document.createElement("div");
  div.className="msg";
  div.innerHTML=html;
  elChat.appendChild(div);
  elChat.scrollTop=elChat.scrollHeight;
}
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

elJoin.onclick=()=>{
  const name=elName.value.trim()||"Anon";
  const room=elRoom.value.trim()||"lobby";
  currentRoom=room;
  elRoomPill.textContent="room: "+room;
  socket.emit("join",{name,room});
  joined=true;
  elText.disabled=false; elSend.disabled=false;
  addLine('<span class="sys">Bağlandın: <b>'+esc(name)+'</b> (room: <b>'+esc(room)+'</b>)</span>');
};

function send(){
  if(!joined) return;
  const name=elName.value.trim()||"Anon";
  const text=elText.value.trim();
  if(!text) return;
  socket.emit("chat",{room:currentRoom,name,text});
  elText.value="";
  socket.emit("typing",{room:currentRoom,name,isTyping:false});
}
elSend.onclick=send;
elText.addEventListener("keydown",(e)=>{ if(e.key==="Enter") send(); });

elText.addEventListener("input",()=>{
  if(!joined) return;
  const name=elName.value.trim()||"Anon";
  socket.emit("typing",{room:currentRoom,name,isTyping:true});
  clearTimeout(typingTimer);
  typingTimer=setTimeout(()=>socket.emit("typing",{room:currentRoom,name,isTyping:false}),700);
});

socket.on("history",(items)=>{
  for(const m of items){
    addLine('<span class="name"><b>'+esc(m.name)+':</b></span> '+esc(m.text));
  }
});

socket.on("chat",(m)=>{
  addLine('<span class="name"><b>'+esc(m.name)+':</b></span> '+esc(m.text));
});
socket.on("system",(m)=> addLine('<span class="sys">'+esc(m.text)+'</span>'));
socket.on("presence",({members})=> elMembers.textContent="online: "+members.length+" | "+members.join(", "));
socket.on("typing",({name,isTyping})=> elTyping.textContent = isTyping ? (name+" yazıyor...") : "");
</script>
</body></html>`;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ----- Realtime -----
const onlineUsers = new Map(); // socketId -> { name, room }

io.on("connection", (socket) => {
  socket.on("join", async ({ name, room }) => {
    const safeName = (name || "Anon").toString().slice(0, 24);
    const safeRoom = (room || "lobby").toString().slice(0, 24);

    onlineUsers.set(socket.id, { name: safeName, room: safeRoom });
    socket.join(safeRoom);

    // Son 30 mesajı gönder (DB varsa)
    if (MONGODB_URI) {
      try {
        const items = await Message.find({ room: safeRoom })
          .sort({ ts: -1 })
          .limit(30)
          .lean();
        socket.emit("history", items.reverse());
      } catch (e) {
        console.error("history error:", e.message);
      }
    }

    io.to(safeRoom).emit("system", { text: `${safeName} katıldı.`, ts: Date.now() });

    const members = [...onlineUsers.values()].filter(u => u.room === safeRoom).map(u => u.name);
    io.to(safeRoom).emit("presence", { members });
  });

  socket.on("typing", ({ room, name, isTyping }) => {
    const safeRoom = (room || "lobby").toString().slice(0, 24);
    const safeName = (name || "Anon").toString().slice(0, 24);
    socket.to(safeRoom).emit("typing", { name: safeName, isTyping: !!isTyping });
  });

  socket.on("chat", async ({ room, name, text }) => {
    const safeRoom = (room || "lobby").toString().slice(0, 24);
    const safeName = (name || "Anon").toString().slice(0, 24);
    const msg = (text || "").toString().trim().slice(0, 500);
    if (!msg) return;

    const ts = Date.now();

    // DB’ye yaz (varsa)
    if (MONGODB_URI) {
      try {
        await Message.create({ room: safeRoom, name: safeName, text: msg, ts });
      } catch (e) {
        console.error("insert error:", e.message);
      }
    }

    io.to(safeRoom).emit("chat", { name: safeName, text: msg, ts });
  });

  socket.on("disconnect", () => {
    const info = onlineUsers.get(socket.id);
    if (!info) return;

    onlineUsers.delete(socket.id);
    io.to(info.room).emit("system", { text: `${info.name} ayrıldı.`, ts: Date.now() });

    const members = [...onlineUsers.values()].filter(u => u.room === info.room).map(u => u.name);
    io.to(info.room).emit("presence", { members });
  });
});

// ----- Start -----
const PORT = process.env.PORT || 3000;

connectDb()
  .catch((e) => {
    console.error("MongoDB connect failed:", e.message);
    // DB olmasa da servis açılsın istiyorsan process.exit(1) yapma:
    // process.exit(1);
  })
  .finally(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Running: http://localhost:${PORT}`);
    });
  });
