"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const pino = require("pino");
const QRCode = require("qrcode");
const mongoose = require("mongoose");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    delay
} = require("@whiskeysockets/baileys");
const {
    createPairing,
    getPairing,
    getAllPairings,
    updatePairing
} = require("./id");
const {
    generateAndSendSession,
    getSessionById,
    getAllSessions,
    markSessionDeployed
} = require("./session");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const AUTH_DIR = path.join(ROOT, "auth");
const DATA_DIR = path.join(ROOT, "data");
const PAIRING_REGISTRY_FILE = path.join(DATA_DIR, "pairing-registry.json");
const BOT_NAME = process.env.BOT_NAME || "ETIAS-MINI-BOT";
const SESSION_TRANSFER_SECRET = process.env.SESSION_TRANSFER_SECRET || "";
const SESSION_PREFIX = "ETIAS-MINI-BOT~";
const SESSION_REGEX = /^ETIAS-MINI-BOT~\d{8}$/;
const MONGO_URI = process.env.MONGO_URI;
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const sockets = new Map();
const reconnecting = new Set();
let registryWriteQueue = Promise.resolve();

// ========== MONGODB ==========
const registrySchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  pairingId: String, jid: String, number: String,
  authFolder: String, status: String, connected: Boolean,
  deployed: Boolean, deployedAt: String, days: Number,
  createdAt: String, updatedAt: String, expiresAt: String,
}, { strict: false });
const deployedSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  phone: String, number: String, expiry: Date, expireAt: Date,
  deployedAt: { type: Date, default: Date.now },
  duration: Number, liveConnected: Boolean
}, { strict: false });
const Registry = mongoose.models.PairingRegistry || mongoose.model('PairingRegistry', registrySchema);
const DeployedBot = mongoose.models.DeployedBot || mongoose.model('DeployedBot', deployedSchema);
function isMongoConnected(){ return mongoose.connection.readyState === 1; }
async function connectMongo(){
  if(!MONGO_URI){ logger.warn("[MONGO] MONGO_URI not set"); return; }
  try{ await mongoose.connect(MONGO_URI); logger.info("[MONGO] Connected"); }
  catch(e){ logger.error({error:e.message},"[MONGO] Failed"); }
}
// ========== BOT MANAGER - MANUAL ONLY ==========
const activeBotSockets = new Map();
global.ETIAS_BOT_MANAGER = { sessions: activeBotSockets, getSessions: ()=> Array.from(activeBotSockets.entries()).map(([id,d])=>({sessionId:id, connected:!!d.connected})) };
function getAuthFolderBySession(sessionId){ return path.join(AUTH_DIR, sessionId); }
async function startBotSession(record){
  const sessionId = record.sessionId;
  const authFolder = record.authFolder || getAuthFolderBySession(sessionId);
  if(activeBotSockets.has(sessionId) && activeBotSockets.get(sessionId).connected) return {success:true, already:true};
  try{ await fsp.access(path.join(authFolder,"creds.json")); }catch{
    await Registry.findOneAndUpdate({sessionId},{connected:false,status:"auth_missing"});
    return {success:false, error:"creds.json missing"};
  }
  try{
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({
      auth: state, browser: Browsers.macOS("Chrome"),
      logger: pino({level:"silent"}), markOnlineOnConnect:true,
      syncFullHistory:false, connectTimeoutMs:60000, keepAliveIntervalMs:15000
    });
    activeBotSockets.set(sessionId,{ sock, connected:false, phone:record.number });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async(update)=>{
      const {connection, lastDisconnect} = update;
      if(connection==="open"){
        logger.info({sessionId},"[BOT] ONLINE");
        const ent = activeBotSockets.get(sessionId); if(ent) ent.connected=true;
        await Registry.findOneAndUpdate({sessionId},{connected:true,status:"online",jid:sock.user?.id,updatedAt:new Date().toISOString()},{upsert:true});
        await DeployedBot.findOneAndUpdate({sessionId},{liveConnected:true},{upsert:true});
      }
      if(connection==="close"){
        const code = lastDisconnect?.error?.output?.statusCode;
        activeBotSockets.delete(sessionId);
        await Registry.findOneAndUpdate({sessionId},{connected:false,status:"offline",updatedAt:new Date().toISOString()});
        await DeployedBot.findOneAndUpdate({sessionId},{liveConnected:false});
        if(code!==DisconnectReason.loggedOut){
          setTimeout(()=> startBotSession(record), 10000);
        }
      }
    });
    return {success:true};
  }catch(e){ return {success:false, error:e.message}; }
}
async function loadDeployedOnStartup(){
  if(!isMongoConnected()) return;
  const deployed = await DeployedBot.find({}).catch(()=>[]);
  logger.info({count:deployed.length},"[DEPLOY] Loading already deployed bots");
  for(const bot of deployed){
    const rec = {sessionId:bot.sessionId, number:bot.number||bot.phone, authFolder:getAuthFolderBySession(bot.sessionId)};
    await startBotSession(rec); await delay(2000);
  }
}
// ========== REGISTRY ==========
async function ensureDirectories() {
    await fsp.mkdir(AUTH_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    try { await fsp.access(PAIRING_REGISTRY_FILE); }
    catch { await fsp.writeFile(PAIRING_REGISTRY_FILE, "{}", "utf8"); }
    await connectMongo();
}
function cleanNumber(v){ return String(v||"").replace(/[^\d]/g,""); }
function normalizeJid(jid){ if(!jid) return null; return String(jid).trim().replace(/^jid:/i,""); }
function normalizeSessionId(v){ if(!v) return null; return String(v).trim().toUpperCase(); }
function isValidSessionId(v){ return SESSION_REGEX.test(normalizeSessionId(v)||""); }
function getDisconnectCode(d){ return d?.error?.output?.statusCode || d?.error?.data?.statusCode || d?.statusCode || null; }
function isLoggedOut(c){ return c===DisconnectReason.loggedOut; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function readSessionRegistry(){
    try{
        if(isMongoConnected()){ const docs=await Registry.find({}); const o={}; docs.forEach(d=>{ o[d.sessionId]=d.toObject(); }); return o; }
        const raw=await fsp.readFile(PAIRING_REGISTRY_FILE,"utf8"); if(!raw.trim()) return {}; return JSON.parse(raw)||{};
    }catch{ return {}; }
}
function writeSessionRegistry(registry){
    registryWriteQueue = registryWriteQueue.then(async()=>{
        try{ const tmp=`${PAIRING_REGISTRY_FILE}.tmp`; await fsp.writeFile(tmp, JSON.stringify(registry,null,2),"utf8"); await fsp.rename(tmp, PAIRING_REGISTRY_FILE); }catch{}
        if(isMongoConnected()){ try{ for(const [sid,rec] of Object.entries(registry)){ await Registry.findOneAndUpdate({sessionId:sid}, rec, {upsert:true}); } }catch{} }
    }).catch(()=>{}); return registryWriteQueue;
}
async function savePairingRegistryRecord(sessionId, record){
    if(!sessionId) return; const registry=await readSessionRegistry();
    registry[sessionId]={...registry[sessionId],...record, sessionId, updatedAt:new Date().toISOString()};
    await writeSessionRegistry(registry);
    if(isMongoConnected() && record.number){
      try{ await DeployedBot.findOneAndUpdate({sessionId},{sessionId,phone:record.number,number:record.number,liveConnected:!!record.connected,deployedAt:new Date()},{upsert:true}); }catch{}
    }
}
async function getPairingRegistryRecord(sessionId){ const r=await readSessionRegistry(); return r[normalizeSessionId(sessionId)]||null; }
async function findSessionEverywhere(sessionId){
    const norm=normalizeSessionId(sessionId); if(!isValidSessionId(norm)) return null;
    let sRec=null,pRec=null,rRec=null;
    try{ sRec=await Promise.resolve(getSessionById(norm)); }catch{}
    try{
        const pairings=await Promise.resolve(getAllPairings());
        if(Array.isArray(pairings)) pRec=pairings.find(i=>normalizeSessionId(i?.sessionId)===norm)||null;
        else if(pairings && typeof pairings==="object") pRec=Object.values(pairings).find(i=>normalizeSessionId(i?.sessionId)===norm)||null;
    }catch{}
    rRec=await getPairingRegistryRecord(norm);
    if(!sRec&&!pRec&&!rRec) return null;
    return {...(rRec||{}),...(pRec||{}),...(sRec||{}), sessionId:norm,
        pairingId:sRec?.pairingId||pRec?.pairingId||rRec?.pairingId||null,
        jid:sRec?.jid||pRec?.jid||rRec?.jid||null,
        number:sRec?.number||pRec?.number||rRec?.number||null,
        authFolder:sRec?.authFolder||pRec?.authFolder||rRec?.authFolder||null
    };
}
async function authExists(f){ if(!f) return false; try{ await fsp.access(path.join(f,"creds.json")); return true; }catch{ return false; } }
async function readAuthFiles(dir){
    const files=[]; async function walk(c){
        let e; try{ e=await fsp.readdir(c,{withFileTypes:true}); }catch{ return; }
        for(const entry of e){ const full=path.join(c,entry.name); if(entry.isSymbolicLink()) continue; if(entry.isDirectory()){ await walk(full); continue; } if(!entry.isFile()) continue; const rel=path.relative(dir,full); const data=await fsp.readFile(full); files.push({path:rel,data:data.toString("base64")}); }
    } await walk(dir); return files;
}
function getTemporaryAuthFolder(id){ return path.join(AUTH_DIR, `PAIR_${id}`); }
async function saveSessionMapping(pairing, session){
    if(!session?.sessionId) return;
    await savePairingRegistryRecord(session.sessionId,{
        pairingId:session.pairingId||pairing?.pairingId||pairing?.id||null,
        sessionId:session.sessionId, jid:session.jid||pairing?.jid||null,
        number:session.number||pairing?.number||null,
        authFolder:session.authFolder||pairing?.authFolder||null,
        status:session.status||"connected", connected:session.connected!==false, authAvailable:true,
        createdAt:session.createdAt||pairing?.createdAt||new Date().toISOString(), expiresAt:session.expiresAt||null
    });
}
async function closePairingSocket(pairingId){
    const socket=sockets.get(pairingId); if(!socket) return;
    try{ socket.__etiasIntentionalClose=true; if(typeof socket.ws?.close==="function") socket.ws.close(); else if(typeof socket.end==="function") socket.end(undefined); }catch{}
    sockets.delete(pairingId); reconnecting.delete(pairingId);
}
async function startPairing(number, pairingId, existingAuthFolder=null, existingSessionId=null){
    const clean=cleanNumber(number); if(!clean) throw new Error("Invalid number");
    const authFolder=existingAuthFolder||getTemporaryAuthFolder(pairingId);
    await fsp.mkdir(authFolder,{recursive:true});
    let pairing=await Promise.resolve(getPairing(pairingId));
    if(!pairing) pairing={ pairingId, id:pairingId, number:clean, phone:clean, authFolder, sessionId:existingSessionId||null, status:"connecting", connected:false, createdAt:new Date().toISOString() };
    pairing.authFolder=authFolder; pairing.number=clean; pairing.phone=clean; if(existingSessionId) pairing.sessionId=existingSessionId;
    pairing.status="connecting"; pairing.connected=false;
    try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const socket=makeWASocket({ auth:state, browser:Browsers.macOS("Chrome"), printQRInTerminal:false, logger:pino({level:"silent"}), markOnlineOnConnect:false, syncFullHistory:false, connectTimeoutMs:60000 });
    sockets.set(pairingId, socket);
    socket.ev.on("creds.update", async()=>{ try{ await saveCreds(); }catch{} });
    socket.ev.on("connection.update", async update=>{
        const { connection, lastDisconnect, qr } = update;
        if(qr){ pairing.qr=qr; pairing.status="qr_ready"; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
        if(connection==="connecting"){ pairing.status="connecting"; pairing.connected=false; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
        if(connection==="open"){
            try{
                const userJid=normalizeJid(socket.user?.id);
                pairing.jid=userJid; pairing.connected=true; pairing.status="connected"; pairing.qr=null;
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                await sleep(1500);
                const result=await generateAndSendSession(socket, authFolder, userJid, pairingId, userJid);
                if(!result||!result.sessionId) throw new Error("Session ID not generated");
                const finalSessionId=normalizeSessionId(result.sessionId);
                pairing.sessionId=finalSessionId; pairing.jid=result.jid||userJid; pairing.number=result.number||clean;
                pairing.authFolder=result.authFolder||authFolder; pairing.connected=true; pairing.status="session_sent";
                pairing.sessionSent=true; pairing.sessionSentAt=new Date().toISOString();
                await saveSessionMapping(pairing, {...result, sessionId:finalSessionId, pairingId, authFolder, number:result.number||clean, jid:result.jid||userJid, status:"session_sent", connected:true});
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                await sleep(1000); await closePairingSocket(pairingId);
                pairing.connected=false; pairing.status="ready_for_deployment";
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                // NO AUTO DEPLOY - stays OFFLINE until manual deploy panel
                return;
            }catch(e){ pairing.status="session_error"; pairing.error=e.message; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
        }
        if(connection==="close"){
            const code=getDisconnectCode(lastDisconnect); const intentional=socket.__etiasIntentionalClose===true;
            sockets.delete(pairingId);
            if(intentional||pairing.sessionSent||pairing.status==="session_sent"||pairing.status==="ready_for_deployment"){ pairing.connected=false; pairing.status="ready_for_deployment"; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} return; }
            if(isLoggedOut(code)){ pairing.connected=false; pairing.status="logged_out"; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} return; }
            if(!reconnecting.has(pairingId)){
                reconnecting.add(pairingId); pairing.connected=false; pairing.status="reconnecting";
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                setTimeout(async()=>{ reconnecting.delete(pairingId); try{ await startPairing(clean, pairingId, authFolder, pairing.sessionId||null); }catch{} },5000);
            }
        }
    });
    if(!state.creds.registered){
        try{
            await delay(1500); const code=await socket.requestPairingCode(clean);
            pairing.pairingCode=String(code||"").replace(/[^A-Z0-9]/gi,"").toUpperCase(); pairing.status="pairing_code";
            try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
        }catch(e){ pairing.status="pairing_code_error"; pairing.error=e.message; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
    }
    return { pairingId, authFolder };
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(ROOT));

app.get("/", (req,res)=>{ res.sendFile(path.join(ROOT,"index.html"), err=>{ if(err) res.json({success:true, name:BOT_NAME, deployPanel:"/", dashboard:"/dashboard", pair:"/pair"}); }); });
app.get("/pair", (req,res)=>{ res.sendFile(path.join(ROOT,"pair.html")); });
app.get("/qr", (req,res)=>{ res.sendFile(path.join(ROOT,"qr.html")); });
app.get("/ping", (req,res)=>{ res.json({success:true, pong:true, time:new Date().toISOString()}); });
app.get("/health", async (req,res)=>{
    const sessions=await Promise.resolve(getAllSessions()).catch(()=>[]);
    res.json({success:true, status:"online", pairingSockets:sockets.size, botSockets:activeBotSockets.size, sessions:Array.isArray(sessions)?sessions.length:0, mongo:isMongoConnected(), time:new Date().toISOString()});
});
app.get("/deployments", async (req,res)=>{
  try{
    if(!isMongoConnected()) return res.json([]);
    const bots=await DeployedBot.find().sort({deployedAt:-1});
    const regs=await Registry.find({}); const regMap={}; regs.forEach(r=>regMap[r.sessionId]=r);
    res.json(bots.map(b=>{
      const isOnline=activeBotSockets.has(b.sessionId) && activeBotSockets.get(b.sessionId).connected;
      return { sessionId:b.sessionId, phone:b.phone, number:b.number||b.phone, expiry:b.expiry||b.expireAt, expireAt:b.expireAt||b.expiry, deployedAt:b.deployedAt, duration:b.duration||30, liveConnected:isOnline, connected:isOnline, status:isOnline?"online":(regMap[b.sessionId]?.status||'offline') };
    }));
  }catch{ res.json([]); }
});
app.get("/dashboard", (req,res)=>{ res.sendFile(path.join(ROOT,"dashboard.html"), err=>{ if(err) res.send("dashboard.html missing"); }); });
app.get("/deploy", (req,res)=>{ res.sendFile(path.join(ROOT,"deploy.html"), err=>{ if(err) res.sendFile(path.join(ROOT,"index.html")); }); });

// ========== MANUAL DEPLOY ENDPOINTS - USED BY YOUR DEPLOY PANEL ==========
app.post("/deploy", async(req,res)=>{
  try{
    const {sessionId, duration, number} = req.body;
    const sid=normalizeSessionId(sessionId); if(!isValidSessionId(sid)) return res.status(400).json({success:false, error:"Invalid Session ID"});
    const record=await findSessionEverywhere(sid); if(!record||!record.authFolder) return res.status(404).json({success:false, error:"Session not found - pair again"});
    const finalFolder=getAuthFolderBySession(sid);
    await fsp.mkdir(finalFolder,{recursive:true}).catch(()=>{});
    try{ const files=await fsp.readdir(record.authFolder); for(const f of files){ try{ await fsp.copyFile(path.join(record.authFolder,f), path.join(finalFolder,f)); }catch{} } }catch{}
    const days=parseInt(duration)||90; const expiry=new Date(Date.now()+days*24*60*60*1000);
    const result=await startBotSession({sessionId:sid, number:record.number||number, authFolder:finalFolder});
    if(!result.success) return res.status(500).json({success:false, error:result.error});
    if(isMongoConnected()){
      await DeployedBot.findOneAndUpdate({sessionId:sid}, {sessionId:sid, phone:record.number||number, number:record.number||number, expiry, expireAt:expiry, duration:days, deployedAt:new Date(), liveConnected:true}, {upsert:true});
      await Registry.findOneAndUpdate({sessionId:sid}, {deployed:true, connected:true, status:"online", expiresAt:expiry.toISOString()}, {upsert:true});
    }
    res.json({success:true, message:"Bot deployed ONLINE", sessionId:sid});
  }catch(e){ res.status(500).json({success:false, error:e.message}); }
});
app.post("/api/deploy-manual", async(req,res)=>{
  const {adminKey, sessionId, duration}=req.body;
  if(process.env.ADMIN_KEY && adminKey!==process.env.ADMIN_KEY) return res.status(401).json({error:'Invalid Admin Key'});
  req.body.number=req.body.number||req.body.phone; return app._router.handle(Object.assign(req,{url:"/deploy", method:"POST"}), res);
});
app.post("/delete", async(req,res)=>{
  const {adminKey, sessionId}=req.body; if(process.env.ADMIN_KEY && adminKey!==process.env.ADMIN_KEY) return res.status(401).json({error:'Invalid Admin Key'});
  try{
    if(isMongoConnected()){ await DeployedBot.deleteOne({sessionId}); await Registry.deleteOne({sessionId}); }
    const reg=await readSessionRegistry(); delete reg[sessionId]; await writeSessionRegistry(reg);
    if(activeBotSockets.has(sessionId)){ try{ activeBotSockets.get(sessionId).sock.ws.close(); }catch{} activeBotSockets.delete(sessionId); }
    try{ await fsp.rm(getAuthFolderBySession(sessionId),{recursive:true,force:true}); }catch{}
    res.json({success:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post("/renew", async(req,res)=>{
  const {adminKey, sessionId, duration}=req.body; if(process.env.ADMIN_KEY && adminKey!==process.env.ADMIN_KEY) return res.status(401).json({error:'Invalid Admin Key'});
  try{
    const days=parseInt(duration)||30; const expiry=new Date(Date.now()+days*24*60*60*1000);
    if(isMongoConnected()){ await DeployedBot.findOneAndUpdate({sessionId},{expiry,expireAt:expiry,duration:days},{upsert:true}); await Registry.findOneAndUpdate({sessionId},{expiresAt:expiry.toISOString()}); }
    res.json({success:true, expiry});
  }catch(e){ res.status(500).json({error:e.message}); }
});
// ========== PAIRING ROUTES ==========
app.get("/code", async (req,res)=>{
    try{
        const number=cleanNumber(req.query.number); if(!number||number.length<8) return res.status(400).json({success:false, error:"Valid number required"});
        const created=await Promise.resolve(createPairing(number)); const pairingId=created?.pairingId||created?.id||created; if(!pairingId) throw new Error("Could not create pairing");
        startPairing(number, pairingId).catch(()=>{});
        const timeout=Date.now()+30000;
        while(Date.now()<timeout){
            await sleep(500); const pairing=await Promise.resolve(getPairing(pairingId));
            if(pairing?.pairingCode) return res.json({success:true, pairingId, sessionId:pairing.sessionId||null, number, status:pairing.status||"pairing_code", pairingCode:pairing.pairingCode});
            if(pairing?.status==="error"||pairing?.status==="pairing_code_error") return res.status(500).json({success:false, pairingId, error:pairing.error||"Failed"});
        }
        const finalPairing=await Promise.resolve(getPairing(pairingId));
        return res.json({success:true, pairingId, sessionId:finalPairing?.sessionId||null, number, status:finalPairing?.status||"connecting", pairingCode:finalPairing?.pairingCode||null});
    }catch(e){ return res.status(500).json({success:false, error:e.message}); }
});
app.get("/status/:id", async (req,res)=>{
    try{
        const id=req.params.id; const pairing=await Promise.resolve(getPairing(id));
        if(!pairing) return res.status(404).json({success:false, error:"Not found"});
        return res.json({success:true, pairingId:id, sessionId:pairing.sessionId||null, number:pairing.number||null, status:pairing.status||"unknown", connected:Boolean(pairing.connected), pairingCode:pairing.pairingCode||null, qr:pairing.qr||null, authAvailable:await authExists(pairing.authFolder)});
    }catch(e){ return res.status(500).json({success:false, error:e.message}); }
});
app.get("/session/:sessionId", async (req,res)=>{
    try{
        const sid=normalizeSessionId(req.params.sessionId); if(!isValidSessionId(sid)) return res.status(400).json({success:false, error:"Invalid Session ID"});
        const rec=await findSessionEverywhere(sid); if(!rec) return res.status(404).json({success:false, error:"Session not found"});
        return res.json({success:true, sessionId:sid, number:rec.number||null, jid:rec.jid||null, authAvailable:await authExists(rec.authFolder), status:rec.status||"ready", connected:Boolean(rec.connected)});
    }catch(e){ return res.status(500).json({success:false, error:e.message}); }
});
app.get("/session/:sessionId/auth", async (req,res)=>{
    try{
        if(!SESSION_TRANSFER_SECRET) return res.status(503).json({success:false, error:"Not configured"});
        const secret=String(req.headers["x-session-transfer-secret"]||req.query.secret||""); if(secret!==SESSION_TRANSFER_SECRET) return res.status(401).json({success:false, error:"Invalid secret"});
        const sid=normalizeSessionId(req.params.sessionId); if(!isValidSessionId(sid)) return res.status(400).json({success:false, error:"Invalid Session ID"});
        const rec=await findSessionEverywhere(sid); if(!rec||!rec.authFolder) return res.status(404).json({success:false, error:"Not found"});
        if(!await authExists(rec.authFolder)) return res.status(404).json({success:false, error:"creds.json not found"});
        const files=await readAuthFiles(rec.authFolder); return res.json({success:true, sessionId:sid, files, fileCount:files.length});
    }catch(e){ return res.status(500).json({success:false, error:e.message}); }
});
app.get("/qr-image", async (req,res)=>{
    try{ const id=req.query.id; if(!id) return res.status(400).json({success:false, error:"ID required"}); const pairing=await Promise.resolve(getPairing(id)); if(!pairing||!pairing.qr) return res.status(404).json({success:false, error:"QR not available"}); const png=await QRCode.toBuffer(pairing.qr,{type:"png",width:500,margin:2}); res.setHeader("Content-Type","image/png"); return res.send(png); }catch(e){ return res.status(500).json({success:false, error:e.message}); }
});
app.use((req,res)=>{ res.status(404).json({success:false, error:"Route not found"}); });

async function startServer(){
    await ensureDirectories();
    app.listen(PORT, "0.0.0.0", ()=>{
        logger.info({port:PORT, mongo:isMongoConnected()}, "[SERVER] Pairing + Manual Deploy running");
        logger.info("[SERVER] Deploy Panel: / | Dashboard: /dashboard | Pair: /pair");
        // Load already deployed bots to stay ONLINE after restart, but NOT new pairings
        if(isMongoConnected()) loadDeployedOnStartup();
    });
}
if(require.main===module){ startServer().catch(e=>{ logger.error(e); process.exit(1); }); }
module.exports=app;
