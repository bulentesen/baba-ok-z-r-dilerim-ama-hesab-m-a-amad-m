const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

// ====================== CONFIG ======================
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const ACCESS_KEY = process.env.ACCESS_KEY || ""; // sadece senin bildiğin anahtar
const OWNER_KEY  = process.env.OWNER_KEY  || ""; // room create/delete için ayrı anahtar

// ====================== APP/SERVER ======================
const app = express();
app.set("trust proxy", 1); // Render/proxy arkasında gerçek IP için

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ====================== HELPERS ======================
function safeStr(s, max = 64) { return (s || "").toString().slice(0, max); }

function normalizeTR(input = "") {
  let s = String(input).toLowerCase();
  s = s
    .replaceAll("ç","c").replaceAll("ğ","g").replaceAll("ı","i")
    .replaceAll("ö","o").replaceAll("ş","s").replaceAll("ü","u");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/([a-z])\1{2,}/g, "$1$1");
  return s;
}
function squish(input = "") { return normalizeTR(input).replace(/\s+/g, ""); }

function getClientIp(socket) {
  const xff = socket.handshake.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return socket.handshake.address;
}

function rndToken(len=40){
  const chars="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let t="";
  for(let i=0;i<len;i++) t+=chars[Math.floor(Math.random()*chars.length)];
  return t;
}

// Rate limit
const lastMsgAt = new Map();
function canSend(socketId) {
  const now = Date.now();
  const prev = lastMsgAt.get(socketId) || 0;
  if (now - prev < 700) return false;
  lastMsgAt.set(socketId, now);
  return true;
}

// ====================== MODERATION ======================
// Illegal sale -> hard ban
const DRUG_HINTS = ["uyusturucu","esrar","kenevir","kokain","eroin","mdma","bonzai","met","meth"];
const SALE_HINTS = ["satis","satilik","fiyat","teslimat","kargo","elden","dm","telegram","whatsapp"];

function shouldBlockIllegalSale(text) {
  const n = normalizeTR(text);
  const q = squish(text);
  const hasDrug = DRUG_HINTS.some(w => n.includes(w) || q.includes(w));
  const hasSale = SALE_HINTS.some(w => n.includes(w) || q.includes(w));
  if (hasDrug && hasSale) return true;
  if (/(telegram|whatsapp|dm)\s*(ver|yaz|gel)/i.test(n) && hasDrug) return true;
  return false;
}

// General anti-abuse (BM/Avrupa uyumlu: grup hedeflemeyen, genel yaklaşım)
const PROFANITY_HINTS = ["salak","aptal","geri zekali","mal","serefsiz","haysiyetsiz"];
const HARASSMENT_HINTS = ["oldur","gebert","intihar et","seni bulucam","adres ver","tehdit"];
const HATE_PATTERNS = [
  /\b(hepsi|tum)\s+\w+\s+(pis|igrenc|asagilik)\b/i,
  /\b(\w+)\s+(yok\s+olmali|olmesin|defolsun)\b/i
];

function shouldBlockAbuse(text) {
  const n = normalizeTR(text);
  const q = squish(text);
  const prof = PROFANITY_HINTS.some(w => n.includes(w) || q.includes(squish(w)));
  const har  = HARASSMENT_HINTS.some(w => n.includes(w) || q.includes(squish(w)));
  const hate = HATE_PATTERNS.some(r => r.test(n));
  return { prof, har, hate, block: (prof || har || hate) };
}

// ====================== DB MODELS ======================
const messageSchema = new mongoose.Schema({
  room: { type: String, index: true },
  userId: { type: String, index: true },
  name: String,
  text: String,
  ts: { type: Number, index: true }
},{versionKey:false});
const Message = mongoose.model("Message", messageSchema);

const roomSchema = new mongoose.Schema({
  room: { type: String, unique: true },
  inviteToken: String,
  ownerUserId: String,
  createdAt: { type: Date, default: Date.now }
},{versionKey:false});
const Room = mongoose.model("Room", roomSchema);

const presenceSchema = new mongoose.Schema({
  room: { type: String, index: true },
  userId: { type: String, index: true },
  name: String,
  isOnline: Boolean,
  lastSeen: Number
},{versionKey:false});
presenceSchema.index({ room: 1, userId: 1 }, { unique: true });
const Presence = mongoose.model("Presence", presenceSchema);

const userBanSchema = new mongoose.Schema({
  room: String,
  userId: { type: String, index: true },
  reason: String,
  until: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
},{versionKey:false});
const UserBan = mongoose.model("UserBan", userBanSchema);

const ipBanSchema = new mongoose.Schema({
  ip: { type: String, unique: true, index: true },
  reason: String,
  until: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
},{versionKey:false});
const IPBan = mongoose.model("IPBan", ipBanSchema);

const strikeSchema = new mongoose.Schema({
  room: String,
  userId: { type: String, index: true },
  strikes: { type: Number, default: 0 },
  updatedAt: { type: Number, default: () => Date.now() }
},{versionKey:false});
strikeSchema.index({ room: 1, userId: 1 }, { unique: true });
const Strike = mongoose.model("Strike", strikeSchema);

// ====================== DB CONNECT ======================
let DB_OK = false;
async function connectDb() {
  if (!MONGODB_URI) { DB_OK = false; return; }
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 20000
  });
  DB_OK = true;
  console.log("MongoDB connected");
}

// ====================== PAGES ======================
function mustHaveAccessKey(req, res) {
  if (!ACCESS_KEY) return true; // dev ortamı
  if (req.query.k !== ACCESS_KEY) {
    res.status(403).send("Forbidden. Go to /login");
    return false;
  }
  return true;
}

const loginHtml = `<!doctype html><html lang="tr">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Giriş</title>
<style>
body{font-family:system-ui;margin:0;background:#111;color:#eee}
.wrap{max-width:520px;margin:70px auto;padding:18px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px;padding:16px}
input,button{padding:10px 12px;border-radius:10px;border:1px solid #333;background:#101010;color:#eee;width:100%}
button{cursor:pointer;margin-top:10px}
.small{font-size:12px;color:#bbb;margin-top:10px;line-height:1.4}
a{color:#9be7ff}
</style></head>
<body><div class="wrap"><div class="card">
<h2>Safe Chat - Giriş</h2>
<p class="small">Bu uygulama yalnızca gizli erişim anahtarı ile açılır.</p>
<input id="k" placeholder="Erişim Anahtarı (ACCESS KEY)"/>
<button id="go">Giriş</button>
<div class="small">
<a href="/privacy" target="_blank">Gizlilik Politikası</a> ·
<a href="/terms" target="_blank">Kullanım Şartları</a>
</div>
<div class="small" id="err"></div>
</div></div>
<script>
document.getElementById("go").onclick=()=>{
  const k=document.getElementById("k").value.trim();
  if(!k){document.getElementById("err").textContent="Anahtar gerekli.";return;}
  localStorage.setItem("access_key", k);
  location.href="/chat?k="+encodeURIComponent(k)+location.hash;
};
</script>
</body></html>`;

const privacyHtml = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gizlilik Politikası</title>
<style>body{font-family:system-ui;max-width:900px;margin:40px auto;line-height:1.6;padding:0 14px}</style>
</head><body>
<h1>Gizlilik Politikası</h1>
<p><b>Yürürlük Tarihi:</b> 14 Şubat 2026</p>
<p>Bu uygulama yalnızca davet bağlantısı ve erişim anahtarı ile kullanılabilen özel bir sohbet servisidir.</p>
<h2>Toplanan Veriler</h2>
<ul>
<li>Kullanıcı adı (nickname)</li>
<li>Tarayıcıda üretilen userId (telefon numarası yok)</li>
<li>Mesaj içerikleri (opsiyonel olarak kalıcı saklama)</li>
<li>Oda/Grup bilgisi, bağlantı zamanları, last seen</li>
<li>Güvenlik amaçlı IP adresi (kötüye kullanım ve ban için)</li>
</ul>
<h2>İşleme Amaçları</h2>
<ul>
<li>Mesajlaşma hizmetini sağlamak</li>
<li>Küfür/taciz/nefret/illegal satış gibi içerikleri engellemek ve ban uygulamak</li>
<li>Online/offline durumu göstermek</li>
</ul>
<h2>Paylaşım</h2>
<p>Veriler reklam/pazarlama amacıyla satılmaz. Altyapı sağlayıcıları (barındırma/veritabanı) üzerinde saklanabilir.</p>
<h2>Saklama</h2>
<p>Oda sahibi/uygulama sahibi odaları ve mesajları silebilir (purge). Ban kayıtları güvenlik için kalıcı veya süreli tutulabilir.</p>
</body></html>`;

const termsHtml = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kullanım Şartları</title>
<style>body{font-family:system-ui;max-width:900px;margin:40px auto;line-height:1.6;padding:0 14px}</style>
</head><body>
<h1>Kullanım Şartları</h1>
<p><b>Yürürlük Tarihi:</b> 14 Şubat 2026</p>
<p>Bu uygulama özel davet ile kullanılan bir sohbet servisidir.</p>
<h2>Yasak İçerikler</h2>
<ul>
<li>Yasal olmayan ürün/hizmet satışı (özellikle uyuşturucu satışı) — <b>anında ban</b></li>
<li>Taciz, tehdit, zorbalık</li>
<li>Nefret söylemi ve hedef gösterme</li>
<li>Aşırı küfür/rahatsız edici içerik</li>
</ul>
<h2>Yaptırımlar</h2>
<p>Kurallar ihlal edilirse mesaj engellenebilir, kullanıcı atılabilir veya IP/userId bazlı ban uygulanabilir.</p>
</body></html>`;

const chatHtml = `<!doctype html>
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
#chat{height:52vh;overflow:auto;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:14px;padding:12px}
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
a{color:#9be7ff}
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

  <div class="row" style="margin-top:8px">
    <a class="small" href="/privacy" target="_blank">Gizlilik</a>
    <a class="small" href="/terms" target="_blank">Şartlar</a>
    <a class="small" href="/login">Çıkış / Giriş</a>
  </div>

  <div class="row" style="margin-top:10px">
    <input id="name" placeholder="Adın"/>
    <input id="room" placeholder="Oda (ör: kuzen)"/>
    <input id="token" placeholder="Davet Token (invite-only)"/>
    <button id="joinBtn">Bağlan</button>
  </div>

  <div class="row" style="margin-top:6px">
    <label class="small"><input type="checkbox" id="ageOk"/> 13+ olduğumu onaylıyorum</label>
    <label class="small"><input type="checkbox" id="showHistory"/> Geçmişi göster (varsayılan kapalı)</label>
  </div>

  <div style="margin-top:12px" id="chat"></div>
  <div class="typing" id="typing"></div>

  <div class="row" style="margin-top:10px">
    <input id="text" placeholder="Mesaj yaz..." style="flex:1;min-width:240px" disabled/>
    <button id="sendBtn" disabled>Gönder</button>
  </div>

  <div class="list">
    <div class="small">Kullanıcılar (online/offline)</div>
    <div id="presenceList"></div>
  </div>
</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
function getAccessKey(){
  const url = new URL(location.href);
  let k = url.searchParams.get("k");
  if(!k) k = localStorage.getItem("access_key") || "";
  return k;
}
function uid(){
  let id = localStorage.getItem("uid");
  if(!id){
    id = (crypto?.randomUUID?.() || (Date.now()+"-"+Math.random()));
    localStorage.setItem("uid", id);
  }
  return id;
}
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

const accessKey = getAccessKey();
if(!accessKey){ location.href="/login"; }

const socket = io({ query: { k: accessKey } });

const elChat = document.getElementById("chat");
const elName = document.getElementById("name");
const elRoom = document.getElementById("room");
const elToken = document.getElementById("token");
const elJoin = document.getElementById("joinBtn");
const elText = document.getElementById("text");
const elSend = document.getElementById("sendBtn");
const elTyping = document.getElementById("typing");
const elMembers = document.getElementById("members");
const elRoomPill = document.getElementById("roomPill");
const elPresence = document.getElementById("presenceList");
const elAgeOk = document.getElementById("ageOk");
const elShowHistory = document.getElementById("showHistory");
const elDbPill = document.getElementById("dbPill");

let joined=false, currentRoom="";

function addLine(html){
  const div=document.createElement("div");
  div.className="msg";
  div.innerHTML=html;
  elChat.appendChild(div);
  elChat.scrollTop=elChat.scrollHeight;
}

elJoin.onclick=()=>{
  const name=(elName.value.trim()||"Anon").slice(0,24);
  const room=(elRoom.value.trim()||"lobby").slice(0,24);
  const inviteToken=(elToken.value.trim()||"").slice(0,64);
  const ageOk = !!elAgeOk.checked;
  const showHistory = !!elShowHistory.checked;

  currentRoom=room;
  elRoomPill.textContent="room: "+room;

  socket.emit("join",{ userId: uid(), name, room, inviteToken, ageOk, showHistory });

  joined=true;
  elText.disabled=false; elSend.disabled=false;
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

socket.on("db_status",(x)=>{ elDbPill.textContent="db: "+(x?.ok?"ok":"off"); });

socket.on("history",(items)=>{
  for(const m of items){
    addLine('<span class="name"><b>'+esc(m.name)+':</b></span> '+esc(m.text));
  }
});
socket.on("chat",(m)=>{
  addLine('<span class="name"><b>'+esc(m.name)+':</b></span> '+esc(m.text));
});
socket.on("system",(m)=> addLine('<span class="sys">'+esc(m.text)+'</span>'));

socket.on("presence_full",({list})=>{
  elMembers.textContent="online: "+list.filter(x=>x.isOnline).length+" / "+list.length;
  elPresence.innerHTML=list.map(u=>{
    const st = u.isOnline ? '<span class="badge ok">online</span>' : '<span class="badge off">offline</span>';
    const ls = u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "-";
    return '<div class="user"><div><b>'+esc(u.name||"Anon")+'</b></div><div>'+st+' <span class="small">'+esc(ls)+'</span></div></div>';
  }).join("");
});

socket.on("typing",({name,isTyping})=> elTyping.textContent = isTyping ? (name+" yazıyor...") : "");

socket.on("blocked",(x)=> addLine('<span class="sys">Engellendi: '+esc(x?.reason||"")+'</span>'));

socket.on("connect_error",(err)=>{
  addLine('<span class="sys">Bağlantı hatası: '+esc(err?.message||"")+'</span>');
  if((err?.message||"").includes("FORBIDDEN")) location.href="/login";
});
</script>
</body></html>`;

// ====================== ROUTES ======================
// Fix: Cannot GET /
app.get("/", (req,res) => {
  return res.redirect("/login");
});

app.get("/login", (req,res)=> {
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(loginHtml);
});

app.get("/privacy", (req,res)=> {
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(privacyHtml);
});

app.get("/terms", (req,res)=> {
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(termsHtml);
});

app.get("/chat", (req,res)=> {
  if (!mustHaveAccessKey(req, res)) return;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(chatHtml);
});

// Owner endpoints: oda yönetimi (mesaj görmeden)
app.get("/owner/create-room", async (req,res)=>{
  if (!OWNER_KEY || req.query.ok !== OWNER_KEY) return res.status(403).send("Forbidden");
  if (!ACCESS_KEY) return res.status(400).send("ACCESS_KEY required");
  const room = safeStr(req.query.room, 24);
  if(!room) return res.status(400).send("room required");

  const token = rndToken(40);
  await Room.updateOne(
    { room },
    { $set: { room, inviteToken: token, createdAt: new Date() } },
    { upsert: true }
  );

  const base = `${req.protocol}://${req.get("host")}`;
  const invite = `${base}/chat?k=${encodeURIComponent(ACCESS_KEY)}#room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
  res.json({ room, token, invite });
});

app.get("/owner/delete-room", async (req,res)=>{
  if (!OWNER_KEY || req.query.ok !== OWNER_KEY) return res.status(403).send("Forbidden");
  const room = safeStr(req.query.room, 24);
  if(!room) return res.status(400).send("room required");

  await Promise.all([
    Room.deleteOne({ room }),
    Message.deleteMany({ room }),
    Presence.deleteMany({ room }),
    Strike.deleteMany({ room }),
    UserBan.deleteMany({ room })
  ]);

  res.json({ ok:true, deletedRoom: room });
});

// ====================== SOCKET SECURITY GATE ======================
io.use(async (socket, next) => {
  // ACCESS KEY kontrolü (socket tarafı)
  if (ACCESS_KEY) {
    const k = socket.handshake.query?.k;
    if (k !== ACCESS_KEY) return next(new Error("FORBIDDEN"));
  }

  // IP ban kontrol
  if (DB_OK) {
    try {
      const ip = getClientIp(socket);
      const ban = await IPBan.findOne({ ip }).lean();
      if (ban && (ban.until === 0 || ban.until > Date.now())) return next(new Error("IP_BANNED"));
    } catch {}
  }
  next();
});

// ====================== PRESENCE ======================
async function publishPresence(room) {
  if (!DB_OK) return;
  const list = await Presence.find({ room })
    .sort({ isOnline: -1, lastSeen: -1 })
    .limit(200)
    .lean();
  io.to(room).emit("presence_full", { list });
}

// ====================== REALTIME ======================
const onlineSockets = new Map(); // socket.id -> { room, userId, name }

io.on("connection", (socket) => {
  socket.emit("db_status", { ok: DB_OK });

  socket.on("join", async ({ userId, name, room, inviteToken, ageOk, showHistory }) => {
    const safeRoom = safeStr(room, 24) || "lobby";
    const safeName = safeStr(name, 24) || "Anon";
    const safeUserId = safeStr(userId, 80);
    const token = safeStr(inviteToken, 64);

    if (!ageOk) { socket.emit("blocked",{reason:"Age gate failed"}); socket.disconnect(true); return; }

    if (DB_OK) {
      // user ban
      const ub = await UserBan.findOne({ room: safeRoom, userId: safeUserId }).lean();
      if (ub && (ub.until === 0 || ub.until > Date.now())) {
        socket.emit("blocked",{reason:"User banned"}); socket.disconnect(true); return;
      }

      // invite-only kontrol
      const r = await Room.findOne({ room: safeRoom }).lean();
      if (r) {
        if (r.inviteToken && token !== r.inviteToken) {
          socket.emit("blocked",{reason:"Invite required / token invalid"}); socket.disconnect(true); return;
        }
      } else {
        // room yoksa: token verilirse invite-only olur, token boşsa açık olur
        await Room.create({ room: safeRoom, inviteToken: token || "", ownerUserId: safeUserId });
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

    // history default OFF
    if (DB_OK && showHistory) {
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

  socket.on("chat", async ({ room, userId, name, text }) => {
    const safeRoom = safeStr(room, 24) || "lobby";
    const safeName = safeStr(name, 24) || "Anon";
    const safeUserId = safeStr(userId, 80);
    const msg = (text || "").toString().trim().slice(0, 500);
    if (!msg) return;
    if (!canSend(socket.id)) return;

    const ip = getClientIp(socket);

    // Illegal sale => anında ban
    if (DB_OK && shouldBlockIllegalSale(msg)) {
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

    // Abuse => strike (3. ihlalde ban)
    const chk = shouldBlockAbuse(msg);
    if (chk.block) {
      if (DB_OK) {
        const up = await Strike.findOneAndUpdate(
          { room: safeRoom, userId: safeUserId },
          { $inc: { strikes: 1 }, $set: { updatedAt: Date.now() } },
          { upsert: true, new: true }
        );
        const strikes = up?.strikes || 1;

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
      }

      socket.emit("blocked", { reason: "Message blocked" });
      return;
    }

    const ts = Date.now();
    if (DB_OK) {
      try { await Message.create({ room: safeRoom, userId: safeUserId, name: safeName, text: msg, ts }); } catch {}
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

// ====================== START ======================
connectDb()
  .catch(e => { console.error("Mongo connect failed:", e.message); DB_OK = false; })
  .finally(() => {
    server.listen(PORT, () => console.log(`Running on :${PORT}`));
  });
