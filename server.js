const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const app = express();
app.set("trust proxy", 1); // Render/proxy arkasında IP için

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || ""; // istersen boş bırak

// -------------------- Moderation Helpers --------------------
function normalizeTR(input = "") {
  let s = String(input).toLowerCase();
  s = s
    .replaceAll("ç", "c").replaceAll("ğ", "g").replaceAll("ı", "i")
    .replaceAll("ö", "o").replaceAll("ş", "s").replaceAll("ü", "u");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/([a-z])\1{2,}/g, "$1$1"); // uzatmaları azalt
  return s;
}
function squish(input = "") {
  return normalizeTR(input).replace(/\s+/g, "");
}

// İstersen bu listeleri kendin genişlet (kısa tuttum; ağır küfürleri burada yazmana gerek yok)
const PROFANITY_HINTS = [
  "salak", "aptal", "geri zekali", "mal", "danglak", "serefsiz", "haysiyetsiz"
];

const HARASSMENT_HINTS = [
  "oldur", "gebert", "intihar et", "seni bulucam", "adres ver", "tehdit"
];

// Nefret söylemini “genel” yakalamak için: hedef + hakaret kalıbı gibi çalışır.
// (Spesifik grup isimleri vermiyorum; bu yaklaşım her grubu eşit korur.)
const HATE_PATTERNS = [
  /\b(hepsi|tum)\s+\w+\s+(pis|igrenc|asagilik)\b/i,
  /\b(\w+)\s+(yok\s+olmali|olmesin|defolsun)\b/i
];

// Illegal sale: uyuşturucu + satış niyeti birlikteyse
const DRUG_HINTS = ["uyusturucu", "esrar", "kenevir", "kokain", "eroin", "mdma", "bonzai", "met", "meth"];
const SALE_HINTS = ["satis", "satilik", "fiyat", "teslimat", "kargo", "elden", "dm", "telegram", "whatsapp"];

function shouldBlockIllegalSale(text) {
  const n = normalizeTR(text);
  const q = squish(text);
  const hasDrug = DRUG_HINTS.some(w => n.includes(w) || q.includes(w));
  const hasSale = SALE_HINTS.some(w => n.includes(w) || q.includes(w));
  if (hasDrug && hasSale) return true;
  if (/(telegram|whatsapp|dm)\s*(ver|yaz|gel)/i.test(n) && hasDrug) return true;
  return false;
}

function shouldBlockProfanityOrHarassment(text) {
  const n = normalizeTR(text);
  const q = squish(text);

  const prof = PROFANITY_HINTS.some(w => n.includes(w) || q.includes(squish(w)));
  const har = HARASSMENT_HINTS.some(w => n.includes(w) || q.includes(squish(w)));
  const hate = HATE_PATTERNS.some(r => r.test(n));

  return { prof, har, hate, block: (prof || har || hate) };
}

function getClientIp(socket) {
  const xff = socket.handshake.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return socket.handshake.address;
}

// Basit spam limiti
const lastMsgAt = new Map(); // socket.id -> ts
function canSend(socketId) {
  const now = Date.now();
  const prev = lastMsgAt.get(socketId) || 0;
  if (now - prev < 700) return false; // 0.7sn
  lastMsgAt.set(socketId, now);
  return true;
}

// -------------------- DB Models --------------------
const messageSchema = new mongoose.Schema({
  room: { type: String, index: true },
  userId: { type: String, index: true },
  name: String,
  text: String,
  ts: { type: Number, index: true }
}, { versionKey: false });
const Message = mongoose.model("Message", messageSchema);

const roomSchema = new mongoose.Schema({
  room: { type: String, unique: true },
  inviteToken: String,
  ownerUserId: String,
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const Room = mongoose.model("Room", roomSchema);

const presenceSchema = new mongoose.Schema({
  room: { type: String, index: true },
  userId: { type: String, index: true },
  name: String,
  isOnline: Boolean,
  lastSeen: Number
}, { versionKey: false });
presenceSchema.index({ room: 1, userId: 1 }, { unique: true });
const Presence = mongoose.model("Presence", presenceSchema);

const userBanSchema = new mongoose.Schema({
  room: String,
  userId: { type: String, index: true },
  reason: String,
  until: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const UserBan = mongoose.model("UserBan", userBanSchema);

const ipBanSchema = new mongoose.Schema({
  ip: { type: String, unique: true, index: true },
  reason: String,
  until: { type: Number, default: 0 }, // 0 = kalıcı
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const IPBan = mongoose.model("IPBan", ipBanSchema);

const reportSchema = new mongoose.Schema({
  room: String,
  reporterUserId: String,
  targetUserId: String,
  text: String,
  ts: { type: Number, default: () => Date.now() }
}, { versionKey: false });
const Report = mongoose.model("Report", reportSchema);

const strikeSchema = new mongoose.Schema({
  room: String,
  userId: { type: String, index: true },
  strikes: { type: Number, default: 0 },
  updatedAt: { type: Number, default: () => Date.now() }
}, { versionKey: false });
strikeSchema.index({ room: 1, userId: 1 }, { unique: true });
const Strike = mongoose.model("Strike", strikeSchema);

// -------------------- HTML (single page) --------------------
const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Safe Chat</title>
<style>
body{font-family:system-ui,Arial;margin:0;background:#111;color:#eee}
.wrap{max-width:980px;margin:0 auto;padding:16px}
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
.small{font-size:12px;color:#bbb}
.list{margin-top:10px;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:14px;padding:10px}
.user{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid #222}
.user:last-child{border-bottom:none}
.badge{padding:2px 8px;border-radius:999px;border:1px solid #333;background:#141414;color:#bbb;font-size:12px}
.ok{color:#7CFC00}
.off{color:#aaa}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="top">
    <div>
      <span class="pill">Safe Chat</span>
      <span class="pill" id="roomPill">room: -</span>
      <span class="pill" id="dbPill">db: -</span>
    </div>
    <div class="pill" id="members">online: -</div>
  </div>

  <div class="row" style="margin-top:10px">
    <input id="name" placeholder="Adın"/>
    <input id="room" placeholder="Oda (ör: kuzen)"/>
    <input id="token" placeholder="Davet Token (invite-only)"/>
    <button id="joinBtn">Bağlan</button>
  </div>

  <div class="row" style="margin-top:6px">
    <label class="small"><input type="checkbox" id="ageOk"/> 13+ olduğumu onaylıyorum</label>
    <span class="small">• Küfür / taciz / nefret / illegal satış otomatik engellenir.</span>
  </div>

  <div style="margin-top:12px" id="chat"></div>
  <div class="typing" id="typing"></div>

  <div class="row" style="margin-top:10px">
    <input id="text" placeholder="Mesaj yaz..." style="flex:1;min-width:240px" disabled/>
    <button id="sendBtn" disabled>Gönder</button>
    <button id="reportBtn" disabled>Son mesajı şikayet et</button>
  </div>

  <div class="list">
    <div class="small">Kullanıcılar (online/offline)</div>
    <div id="presenceList"></div>
  </div>
</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const elChat = document.getElementById("chat");
const elName = document.getElementById("name");
const elRoom = document.getElementById("room");
const elToken = document.getElementById("token");
const elJoin = document.getElementById("joinBtn");
const elText = document.getElementById("text");
const elSend = document.getElementById("sendBtn");
const elReport = document.getElementById("reportBtn");
const elTyping = document.getElementById("typing");
const elMembers = document.getElementById("members");
const elRoomPill = document.getElementById("roomPill");
const elPresence = document.getElementById("presenceList");
const elAgeOk = document.getElementById("ageOk");
const elDbPill = document.getElementById("dbPill");

let joined=false, currentRoom="", lastReceived=null;

function uid(){
  let id = localStorage.getItem("uid");
  if(!id){
    id = (crypto?.randomUUID?.() || (Date.now()+"-"+Math.random()));
    localStorage.setItem("uid", id);
  }
  return id;
}
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
  const name=(elName.value.trim()||"Anon").slice(0,24);
  const room=(elRoom.value.trim()||"lobby").slice(0,24);
  const inviteToken=(elToken.value.trim()||"").slice(0,64);
  const ageOk = !!elAgeOk.checked;

  currentRoom=room;
  elRoomPill.textContent="room: "+room;
  socket.emit("join",{ userId: uid(), name, room, inviteToken, ageOk });

  joined=true;
  elText.disabled=false; elSend.disabled=false; elReport.disabled=false;
  addLine('<span class="sys">Bağlandın: <b>'+esc(name)+'</b> (room: <b>'+esc(room)+'</b>)</span>');
};

function send(){
  if(!joined) return;
  const name=(elName.value.trim()||"Anon").slice(0,24);
  const text=elText.value.trim();
  if(!text) return;
  socket.emit("chat",{ room: currentRoom, userId: uid(), name, text });
  elText.value="";
  socket.emit("typing",{ room: currentRoom, name, isTyping:false });
}
elSend.onclick=send;
elText.addEventListener("keydown",(e)=>{ if(e.key==="Enter") send(); });

let typingTimer=null;
elText.addEventListener("input",()=>{
  if(!joined) return;
  const name=(elName.value.trim()||"Anon").slice(0,24);
  socket.emit("typing",{ room: currentRoom, name, isTyping:true });
  clearTimeout(typingTimer);
  typingTimer=setTimeout(()=>socket.emit("typing",{ room: currentRoom, name, isTyping:false }),700);
});

elReport.onclick=()=>{
  if(!lastReceived) return;
  socket.emit("report", {
    room: currentRoom,
    reporterUserId: uid(),
    targetUserId: lastReceived.userId || "",
    text: lastReceived.text || ""
  });
  addLine('<span class="sys">Şikayet gönderildi.</span>');
};

socket.on("db_status",(x)=>{ elDbPill.textContent = "db: " + (x?.ok ? "ok" : "off"); });

socket.on("history",(items)=>{
  for(const m of items){
    lastReceived = m;
    addLine('<span class="name"><b>'+esc(m.name)+':</b></span> '+esc(m.text));
  }
});

socket.on("chat",(m)=>{
  lastReceived = m;
  addLine('<span class="name"><b>'+esc(m.name)+':</b></span> '+esc(m.text));
});

socket.on("system",(m)=> addLine('<span class="sys">'+esc(m.text)+'</span>'));

socket.on("presence_full",({list})=>{
  // list: [{name,isOnline,lastSeen,userId}]
  elMembers.textContent = "online: " + list.filter(x=>x.isOnline).length + " / " + list.length;
  elPresence.innerHTML = list.map(u=>{
    const st = u.isOnline ? '<span class="badge ok">online</span>' : '<span class="badge off">offline</span>';
    const ls = u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "-";
    return '<div class="user"><div><b>'+esc(u.name||"Anon")+'</b> <span class="small">('+esc(u.userId||"")+')</span></div><div>'+st+' <span class="small">'+esc(ls)+'</span></div></div>';
  }).join("");
});

socket.on("typing",({name,isTyping})=> elTyping.textContent = isTyping ? (name+" yazıyor...") : "");

socket.on("blocked",(x)=> addLine('<span class="sys">Engellendi: '+esc(x?.reason||"")+'</span>'));

socket.on("connect_error",(err)=>{
  addLine('<span class="sys">Bağlantı hatası: '+esc(err?.message||"")+'</span>');
});
</script>
</body></html>`;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// -------------------- DB Connect --------------------
let DB_OK = false;

async function connectDb() {
  if (!MONGODB_URI) {
    console.warn("MONGODB_URI yok -> DB OFF");
    DB_OK = false;
    return;
  }
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 20000
  });
  DB_OK = true;
  console.log("MongoDB connected");
}

// -------------------- Security Gate: IP ban before connect --------------------
io.use(async (socket, next) => {
  if (!DB_OK) return next(); // DB yoksa ban kontrol yok
  try {
    const ip = getClientIp(socket);
    const ban = await IPBan.findOne({ ip }).lean();
    if (ban && (ban.until === 0 || ban.until > Date.now())) return next(new Error("IP_BANNED"));
  } catch {}
  next();
});

// -------------------- Realtime State --------------------
const onlineSockets = new Map(); // socket.id -> { room, userId, name }

// presence publish helper
async function publishPresence(room) {
  if (!DB_OK) return;
  const list = await Presence.find({ room })
    .sort({ isOnline: -1, lastSeen: -1 })
    .limit(100)
    .lean();
  io.to(room).emit("presence_full", { list });
}

function safeStr(s, max = 24) {
  return (s || "").toString().slice(0, max);
}

io.on("connection", (socket) => {
  socket.emit("db_status", { ok: DB_OK });

  socket.on("join", async ({ userId, name, room, inviteToken, ageOk }) => {
    const safeRoom = safeStr(room, 24) || "lobby";
    const safeName = safeStr(name, 24) || "Anon";
    const safeUserId = safeStr(userId, 80);

    if (!ageOk) {
      socket.emit("blocked", { reason: "Age gate failed" });
      socket.disconnect(true);
      return;
    }

    const ip = getClientIp(socket);

    // DB varsa: invite-only + bans
    if (DB_OK) {
      // IP ban kontrol (ek güvenlik)
      const ipBan = await IPBan.findOne({ ip }).lean();
      if (ipBan && (ipBan.until === 0 || ipBan.until > Date.now())) {
        socket.emit("blocked", { reason: "IP banned" });
        socket.disconnect(true);
        return;
      }

      const ub = await UserBan.findOne({ room: safeRoom, userId: safeUserId }).lean();
      if (ub && (ub.until === 0 || ub.until > Date.now())) {
        socket.emit("blocked", { reason: "User banned" });
        socket.disconnect(true);
        return;
      }

      // Room invite kontrol
      const r = await Room.findOne({ room: safeRoom }).lean();
      if (r) {
        if (r.inviteToken && inviteToken !== r.inviteToken) {
          socket.emit("blocked", { reason: "Invite required / token invalid" });
          socket.disconnect(true);
          return;
        }
      } else {
        // oda ilk kez oluşuyorsa: owner yap, token boşsa invite-only yapma
        await Room.create({
          room: safeRoom,
          inviteToken: safeStr(inviteToken, 64) || "",
          ownerUserId: safeUserId
        });
      }

      // Presence online
      await Presence.updateOne(
        { room: safeRoom, userId: safeUserId },
        { $set: { name: safeName, isOnline: true, lastSeen: Date.now() } },
        { upsert: true }
      );
    }

    onlineSockets.set(socket.id, { room: safeRoom, userId: safeUserId, name: safeName });
    socket.join(safeRoom);

    // history
    if (DB_OK) {
      try {
        const items = await Message.find({ room: safeRoom }).sort({ ts: -1 }).limit(30).lean();
        socket.emit("history", items.reverse());
      } catch {}
    }

    io.to(safeRoom).emit("system", { text: `${safeName} katıldı.` });

    if (DB_OK) await publishPresence(safeRoom);
  });

  socket.on("typing", ({ room, name, isTyping }) => {
    const safeRoom = safeStr(room, 24) || "lobby";
    const safeName = safeStr(name, 24) || "Anon";
    socket.to(safeRoom).emit("typing", { name: safeName, isTyping: !!isTyping });
  });

  socket.on("report", async ({ room, reporterUserId, targetUserId, text }) => {
    if (!DB_OK) return;
    const safeRoom = safeStr(room, 24) || "lobby";
    await Report.create({
      room: safeRoom,
      reporterUserId: safeStr(reporterUserId, 80),
      targetUserId: safeStr(targetUserId, 80),
      text: safeStr(text, 500),
      ts: Date.now()
    });
  });

  socket.on("chat", async ({ room, userId, name, text }) => {
    const safeRoom = safeStr(room, 24) || "lobby";
    const safeName = safeStr(name, 24) || "Anon";
    const safeUserId = safeStr(userId, 80);
    const msg = (text || "").toString().trim().slice(0, 500);
    if (!msg) return;
    if (!canSend(socket.id)) return;

    const ip = getClientIp(socket);

    // 1) Illegal sale => anında IP + user ban + disconnect
    if (shouldBlockIllegalSale(msg) && DB_OK) {
      await IPBan.updateOne(
        { ip },
        { $set: { reason: "Illegal sale content (auto-ban)", until: 0 } },
        { upsert: true }
      );
      await UserBan.updateOne(
        { room: safeRoom, userId: safeUserId },
        { $set: { reason: "Illegal sale content (auto-ban)", until: 0 } },
        { upsert: true }
      );
      socket.emit("blocked", { reason: "Illegal sale -> banned" });
      socket.disconnect(true);
      return;
    }

    // 2) Profanity/Harassment/Hate => strike sistemi
    const chk = shouldBlockProfanityOrHarassment(msg);
    if (chk.block) {
      if (DB_OK) {
        const up = await Strike.findOneAndUpdate(
          { room: safeRoom, userId: safeUserId },
          { $inc: { strikes: 1 }, $set: { updatedAt: Date.now() } },
          { upsert: true, new: true }
        );

        const strikes = up?.strikes || 1;

        // Politikayı sert tuttum:
        // 1 = blok + uyarı, 2 = kick, 3 = ban (user+ip)
        if (strikes >= 3) {
          await UserBan.updateOne(
            { room: safeRoom, userId: safeUserId },
            { $set: { reason: "Repeated abusive content", until: 0 } },
            { upsert: true }
          );
          await IPBan.updateOne(
            { ip },
            { $set: { reason: "Repeated abusive content", until: 0 } },
            { upsert: true }
          );
          socket.emit("blocked", { reason: "Abuse -> banned" });
          socket.disconnect(true);
          return;
        }

        if (strikes === 2) {
          socket.emit("blocked", { reason: "Abuse -> kicked (2/3)" });
          socket.disconnect(true);
          return;
        }

        socket.emit("blocked", { reason: "Message blocked (1/3)" });
        return;
      } else {
        socket.emit("blocked", { reason: "Message blocked" });
        return;
      }
    }

    const ts = Date.now();

    // Save + broadcast
    if (DB_OK) {
      try {
        await Message.create({ room: safeRoom, userId: safeUserId, name: safeName, text: msg, ts });
      } catch {}
    }
    io.to(safeRoom).emit("chat", { userId: safeUserId, name: safeName, text: msg, ts });
  });

  socket.on("disconnect", async () => {
    const info = onlineSockets.get(socket.id);
    onlineSockets.delete(socket.id);
    if (!info) return;

    if (DB_OK) {
      try {
        await Presence.updateOne(
          { room: info.room, userId: info.userId },
          { $set: { isOnline: false, lastSeen: Date.now() } }
        );
        await publishPresence(info.room);
      } catch {}
    }

    io.to(info.room).emit("system", { text: `${info.name} ayrıldı.` });
  });
});

// -------------------- Start --------------------
connectDb()
  .catch(e => {
    console.error("Mongo connect failed:", e.message);
    DB_OK = false; // DB olmadan da çalışsın
  })
  .finally(() => {
    server.listen(PORT, () => console.log(`Running on :${PORT}`));
  });
