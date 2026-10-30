const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data");
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

app.use(express.json({limit:"2mb"}));
app.use("/uploads", express.static(UPLOADS));
app.use(express.static(path.join(__dirname,"public")));

const db = new Database(path.join(DATA,"telegram2.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, phone TEXT UNIQUE, name TEXT, avatar TEXT DEFAULT '🙂', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, title TEXT, kind TEXT DEFAULT 'private', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS members(chat_id TEXT, user_id TEXT, PRIMARY KEY(chat_id,user_id));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, text TEXT, attachment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, title TEXT, description TEXT, emoji TEXT, price INTEGER, currency TEXT, category TEXT, kind TEXT DEFAULT 'gift');
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, status TEXT DEFAULT 'demo_pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
const count = db.prepare("SELECT COUNT(*) n FROM products").get().n;
if (!count) {
 const seed = [
  ["rose","Роза","Цифровой подарок","🌹",15,"⭐","Подарки","gift"],
  ["cake","Торт","Праздничный подарок","🎂",50,"⭐","Подарки","gift"],
  ["rocket","Ракета","Коллекционный подарок","🚀",100,"⭐","Подарки","gift"],
  ["bear","Мишка","Милый подарок","🧸",75,"⭐","Подарки","gift"],
  ["crystal","Crystal","NFT-коллекция • Legendary","💎",250,"TON","NFT","nft"],
  ["dragon","Dragon","NFT-коллекция • Epic","🐉",120,"TON","NFT","nft"],
  ["crown","Golden Crown","NFT-коллекция • Legendary","👑",500,"TON","NFT","nft"],
  ["headphones","Наушники","Аксессуары","🎧",45,"⭐","Маркет","market"],
  ["watch","Smart Watch","Гаджеты","⌚",120,"⭐","Маркет","market"],
  ["art","Digital Art","Цифровое искусство","🖼️",75,"⭐","Маркет","market"]
 ];
 const insert=db.prepare("INSERT INTO products VALUES(?,?,?,?,?,?,?,?)");
 const tx=db.transaction(rows=>rows.forEach(r=>insert.run(...r)));
 tx(seed);
}
const sessions = new Map();
function userFrom(req) {
 const token = req.headers.authorization?.replace(/^Bearer\s+/i,"");
 const uid = token && sessions.get(token);
 return uid ? db.prepare("SELECT id,phone,name,avatar FROM users WHERE id=?").get(uid) : null;
}
function auth(req,res,next) {
 const user=userFrom(req); if(!user) return res.status(401).json({error:"Нужен вход"});
 req.user=user; next();
}
const demoCodes = new Map();
app.post("/api/auth/request-code",(req,res)=>{
 const phone=String(req.body.phone||"").trim();
 if(!/^\+?[0-9 ()-]{7,20}$/.test(phone)) return res.status(400).json({error:"Введите корректный номер"});
 const code=String(Math.floor(100000+Math.random()*900000));
 demoCodes.set(phone,code);
 console.log(`[DEMO LOGIN] ${phone}: ${code}`);
 res.json({ok:true, demoCode: process.env.NODE_ENV==="production" ? undefined : code, message:"Демо-код создан. В реальном запуске подключите SMS-провайдера."});
});
app.post("/api/auth/verify",(req,res)=>{
 const phone=String(req.body.phone||"").trim(), code=String(req.body.code||"");
 if(!phone || demoCodes.get(phone)!==code) return res.status(400).json({error:"Неверный код"});
 demoCodes.delete(phone);
 let user=db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
 if(!user){const id=crypto.randomUUID();db.prepare("INSERT INTO users(id,phone,name) VALUES(?,?,?)").run(id,phone,"Пользователь");user=db.prepare("SELECT * FROM users WHERE id=?").get(id);}
 const token=crypto.randomBytes(32).toString("hex"); sessions.set(token,user.id);
 res.json({token,user:{id:user.id,phone:user.phone,name:user.name,avatar:user.avatar}});
});
app.get("/api/me",auth,(req,res)=>res.json(req.user));
app.patch("/api/me",auth,(req,res)=>{
 const name=String(req.body.name||"").trim().slice(0,40);
 if(!name) return res.status(400).json({error:"Имя не может быть пустым"});
 db.prepare("UPDATE users SET name=? WHERE id=?").run(name,req.user.id);
 res.json({ok:true,name});
});
app.get("/api/chats",auth,(req,res)=>{
 const rows=db.prepare(`SELECT c.id,c.title,c.kind,
 (SELECT text FROM messages m WHERE m.chat_id=c.id ORDER BY created_at DESC LIMIT 1) preview
 FROM chats c JOIN members mm ON mm.chat_id=c.id WHERE mm.user_id=? ORDER BY c.created_at DESC`).all(req.user.id);
 res.json(rows);
});
app.post("/api/chats",auth,(req,res)=>{
 const title=String(req.body.title||"").trim().slice(0,60);
 if(!title) return res.status(400).json({error:"Укажите название чата"});
 const id=crypto.randomUUID();
 db.prepare("INSERT INTO chats(id,title,kind) VALUES(?,?,?)").run(id,title,"group");
 db.prepare("INSERT INTO members(chat_id,user_id) VALUES(?,?)").run(id,req.user.id);
 res.json({id,title,kind:"group"});
});
app.get("/api/chats/:id/messages",auth,(req,res)=>{
 const member=db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").get(req.params.id,req.user.id);
 if(!member) return res.status(403).json({error:"Нет доступа к чату"});
 res.json(db.prepare(`SELECT m.id,m.text,m.attachment,m.created_at,u.name,u.avatar,u.id user_id
 FROM messages m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? ORDER BY m.created_at ASC LIMIT 300`).all(req.params.id));
});
const storage=multer.diskStorage({
 destination:(req,file,cb)=>cb(null,UPLOADS),
 filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).slice(0,10))
});
const upload=multer({storage,limits:{fileSize:15*1024*1024}});
app.post("/api/upload",auth,upload.single("file"),(req,res)=>{
 if(!req.file) return res.status(400).json({error:"Файл не получен"});
 res.json({url:"/uploads/"+req.file.filename,name:req.file.originalname,mime:req.file.mimetype});
});
app.get("/api/catalog",auth,(req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY category,price").all()));
app.post("/api/orders",auth,(req,res)=>{
 const product=db.prepare("SELECT * FROM products WHERE id=?").get(req.body.productId);
 if(!product) return res.status(404).json({error:"Товар не найден"});
 const id=crypto.randomUUID();
 db.prepare("INSERT INTO orders(id,user_id,product_id,status) VALUES(?,?,?,'demo_pending')").run(id,req.user.id,product.id);
 res.json({ok:true,orderId:id,status:"demo_pending",message:"Демо-заказ создан. Реальная оплата не списывается."});
});
io.use((socket,next)=>{
 const token=socket.handshake.auth?.token, uid=token&&sessions.get(token);
 if(!uid) return next(new Error("Не авторизован"));
 socket.userId=uid; next();
});
io.on("connection",socket=>{
 socket.on("join-chat",chatId=>{
  const member=db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").get(chatId,socket.userId);
  if(member) socket.join(chatId);
 });
 socket.on("send-message",data=>{
  const chatId=String(data.chatId||"");
  const member=db.prepare("SELECT 1 FROM members WHERE chat_id=? AND user_id=?").get(chatId,socket.userId);
  if(!member) return;
  const text=String(data.text||"").slice(0,5000);
  const attachment=data.attachment ? String(data.attachment).slice(0,500) : null;
  if(!text&&!attachment) return;
  const id=crypto.randomUUID();
  db.prepare("INSERT INTO messages(id,chat_id,user_id,text,attachment) VALUES(?,?,?,?,?)").run(id,chatId,socket.userId,text,attachment);
  const user=db.prepare("SELECT name,avatar FROM users WHERE id=?").get(socket.userId);
  io.to(chatId).emit("new-message",{id,chat_id:chatId,user_id:socket.userId,name:user.name,avatar:user.avatar,text,attachment,created_at:new Date().toISOString()});
 });
 // WebRTC signaling relay. Production deployments should add rate limits and call authorization.
 socket.on("rtc-signal",data=>{
  const target=io.sockets.sockets.get(data.to);
  if(target) target.emit("rtc-signal",{from:socket.id,signal:data.signal});
 });
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`Telegram 2.0 PRO: http://localhost:${PORT}`));
