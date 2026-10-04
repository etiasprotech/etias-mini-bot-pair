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
    updatePairing,
    deletePairing
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
const MEDIA_DIR = path.join(ROOT, "media");

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

// ========== MONGODB MODELS ==========
const registrySchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  pairingId: String, jid: String, number: String,
  authFolder: String, status: String,
  connected: Boolean, deployed: Boolean,
  deployedAt: String, days: Number,
  createdAt: String, updatedAt: String, expiresAt: String,
}, { strict: false });

const deployedSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  phone: String, number: String,
  expiry: Date, expireAt: Date,
  deployedAt: { type: Date, default: Date.now },
  duration: Number, liveConnected: Boolean
}, { strict: false });

const Registry = mongoose.models.PairingRegistry || mongoose.model('PairingRegistry', registrySchema);
const DeployedBot = mongoose.models.DeployedBot || mongoose.model('DeployedBot', deployedSchema);

function isMongoConnected(){ return mongoose.connection.readyState === 1; }

async function connectMongo(){
  if(!MONGO_URI){ logger.warn("[MONGO] MONGO_URI not set"); return; }
  try{ await mongoose.connect(MONGO_URI); logger.info("[MONGO] Connected - Dashboard Ready"); }
  catch(e){ logger.error({error:e.message},"[MONGO] Connect failed"); }
}
// ========== END MONGODB ==========

// ========== AUTO DEPLOY MANAGER (MAKES USERS ONLINE) ==========
const activeBotSockets = new Map();
global.ETIAS_BOT_MANAGER = {
  sessions: activeBotSockets,
  getSessions: () => Array.from(activeBotSockets.entries()).map(([sessionId, data])=>({ sessionId, connected:!!data.connected }))
};

function getAuthFolderBySession(sessionId){ return path.join(AUTH_DIR, sessionId); }

async function startBotSession(record){
  const sessionId = record.sessionId;
  const authFolder = record.authFolder || getAuthFolderBySession(sessionId);
  if(activeBotSockets.has(sessionId) && activeBotSockets.get(sessionId).connected) return;
  try{ await fsp.access(path.join(authFolder,"creds.json")); }catch{
    await Registry.findOneAndUpdate({sessionId},{connected:false,status:"auth_missing"}); return;
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
        logger.info({sessionId},"[BOT] ONLINE 24/7");
        const ent = activeBotSockets.get(sessionId); if(ent) ent.connected=true;
        await Registry.findOneAndUpdate({sessionId},{connected:true,status:"online",jid:sock.user?.id,updatedAt:new Date().toISOString()},{upsert:true});
        await DeployedBot.findOneAndUpdate({sessionId},{liveConnected:true},{upsert:true});
      }
      if(connection==="close"){
        const code = lastDisconnect?.error?.output?.statusCode;
        activeBotSockets.delete(sessionId);
        await Registry.findOneAndUpdate({sessionId},{connected:false,status:"offline",updatedAt:new Date().toISOString()});
        await DeployedBot.findOneAndUpdate({sessionId},{liveConnected:false});
        if(code!== DisconnectReason.loggedOut){
          setTimeout(()=> startBotSession(record), 10000);
        }
      }
    });
  }catch(e){ logger.error({sessionId,error:e.message},"[BOT] Failed"); }
}

async function loadAndDeployAll(){
  try{
    if(!isMongoConnected()) return;
    const bots = await Registry.find({});
    const deployed = await DeployedBot.find({});
    const allIds = new Set([...bots.map(b=>b.sessionId),...deployed.map(d=>d.sessionId)]);
    for(const sessionId of allIds){
      const reg = bots.find(b=>b.sessionId===sessionId) || {};
      const dep = deployed.find(d=>d.sessionId===sessionId) || {};
      const record = { sessionId, number: reg.number||dep.number||dep.phone, authFolder: reg.authFolder||getAuthFolderBySession(sessionId), expiry: reg.expiresAt||dep.expiry };
      if(record.expiry && new Date(record.expiry)<new Date()) continue;
      if(!activeBotSockets.has(sessionId)){ await startBotSession(record); await delay(2000); }
    }
  }catch(e){ logger.error({error:e.message},"[DEPLOY] Load failed"); }
}

function initAutoDeploy(){
  loadAndDeployAll();
  setInterval(loadAndDeployAll, 30000);
  logger.info("[DEPLOY] Auto-deploy 24/7 started");
}
// ========== END AUTO DEPLOY ==========

async function ensureDirectories() {
    await fsp.mkdir(AUTH_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(MEDIA_DIR, { recursive: true });
    try { await fsp.access(PAIRING_REGISTRY_FILE); }
    catch { await fsp.writeFile(PAIRING_REGISTRY_FILE, "{}", "utf8"); }
    await connectMongo();
}

function cleanNumber(value) { return String(value || "").replace(/[^\d]/g, ""); }
function normalizeJid(jid) { if (!jid) return null; return String(jid).trim().replace(/^jid:/i, ""); }
function normalizeSessionId(value) { if (!value) return null; return String(value).trim().toUpperCase(); }
function isValidSessionId(value) { return SESSION_REGEX.test(normalizeSessionId(value) || ""); }
function getDisconnectCode(lastDisconnect) { return lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.data?.statusCode || lastDisconnect?.statusCode || null; }
function isLoggedOut(code) { return code === DisconnectReason.loggedOut; }
function isConflict(code) { return code === DisconnectReason.connectionReplaced || code === 440; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function readSessionRegistry() {
    try {
        if(isMongoConnected()){
          const docs = await Registry.find({});
          const obj = {}; docs.forEach(d=>{ obj[d.sessionId]=d.toObject(); }); return obj;
        }
        const raw = await fsp.readFile(PAIRING_REGISTRY_FILE, "utf8");
        if (!raw.trim()) return {}; const parsed = JSON.parse(raw); return parsed||{};
    } catch { return {}; }
}

function writeSessionRegistry(registry) {
    registryWriteQueue = registryWriteQueue.then(async () => {
            try{ const tmp = `${PAIRING_REGISTRY_FILE}.tmp`; await fsp.writeFile(tmp, JSON.stringify(registry, null, 2), "utf8"); await fsp.rename(tmp, PAIRING_REGISTRY_FILE); }catch(e){}
            if(isMongoConnected()){
              try{ for(const [sid, rec] of Object.entries(registry)){ await Registry.findOneAndUpdate({sessionId:sid}, rec, {upsert:true}); } }catch(e){}
            }
        }).catch(()=>{});
    return registryWriteQueue;
}

async function savePairingRegistryRecord(sessionId, record) {
    if (!sessionId) return;
    const registry = await readSessionRegistry();
    registry[sessionId] = {...registry[sessionId],...record, sessionId, updatedAt: new Date().toISOString() };
    await writeSessionRegistry(registry);
    if(isMongoConnected() && record.number){
      try{ await DeployedBot.findOneAndUpdate({sessionId},{sessionId,phone:record.number,number:record.number,liveConnected:!!record.connected,deployedAt:new Date()},{upsert:true}); }catch{}
    }
}

async function getPairingRegistryRecord(sessionId) {
    const registry = await readSessionRegistry();
    return registry[normalizeSessionId(sessionId)] || null;
}

async function findSessionEverywhere(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!isValidSessionId(normalized)) return null;
    let sessionRecord = null; let pairingRecord = null; let registryRecord = null;
    try { sessionRecord = await Promise.resolve(getSessionById(normalized)); } catch {}
    try {
        const pairings = await Promise.resolve(getAllPairings());
        if (Array.isArray(pairings)) pairingRecord = pairings.find(item => normalizeSessionId(item?.sessionId) === normalized) || null;
        else if (pairings && typeof pairings === "object") pairingRecord = Object.values(pairings).find(item => normalizeSessionId(item?.sessionId) === normalized) || null;
    } catch {}
    registryRecord = await getPairingRegistryRecord(normalized);
    if (!sessionRecord &&!pairingRecord &&!registryRecord) return null;
    return {...(registryRecord||{}),...(pairingRecord||{}),...(sessionRecord||{}), sessionId: normalized,
        pairingId: sessionRecord?.pairingId||pairingRecord?.pairingId||registryRecord?.pairingId||null,
        jid: sessionRecord?.jid||pairingRecord?.jid||registryRecord?.jid||null,
        number: sessionRecord?.number||pairingRecord?.number||registryRecord?.number||null,
        authFolder: sessionRecord?.authFolder||pairingRecord?.authFolder||registryRecord?.authFolder||null
    };
}

async function authExists(authFolder) {
    if (!authFolder) return false;
    try { await fsp.access(path.join(authFolder, "creds.json")); return true; } catch { return false; }
}

async function readAuthFiles(directory) {
    const files = [];
    async function walk(current) {
        let entries; try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { await walk(full); continue; }
            if (!entry.isFile()) continue;
            const relative = path.relative(directory, full);
            const data = await fsp.readFile(full);
            files.push({ path: relative, data: data.toString("base64") });
        }
    }
    await walk(directory); return files;
}

function getTemporaryAuthFolder(pairingId) { return path.join(AUTH_DIR, `PAIR_${pairingId}`); }

async function saveSessionMapping(pairing, session) {
    if (!session?.sessionId) return;
    await savePairingRegistryRecord(session.sessionId, {
        pairingId: session.pairingId||pairing?.pairingId||pairing?.id||null,
        sessionId: session.sessionId, jid: session.jid||pairing?.jid||null,
        number: session.number||pairing?.number||null,
        authFolder: session.authFolder||pairing?.authFolder||null,
        status: session.status||"connected", connected: session.connected!==false,
        authAvailable:true, createdAt: session.createdAt||pairing?.createdAt||new Date().toISOString(), expiresAt: session.expiresAt||null
    });
}

async function closePairingSocket(pairingId, reason="SESSION_READY_FOR_DEPLOYMENT") {
    const socket = sockets.get(pairingId); if (!socket) return;
    try{ socket.__etiasIntentionalClose=true; if (typeof socket.ws?.close==="function") socket.ws.close(); else if (typeof socket.end==="function") socket.end(undefined); }catch{}
    sockets.delete(pairingId); reconnecting.delete(pairingId);
}

async function startPairing(number, pairingId, existingAuthFolder=null, existingSessionId=null) {
    const clean = cleanNumber(number); if (!clean) throw new Error("Invalid WhatsApp number");
    const authFolder = existingAuthFolder||getTemporaryAuthFolder(pairingId);
    await fsp.mkdir(authFolder,{recursive:true});
    let pairing = await Promise.resolve(getPairing(pairingId));
    if (!pairing) pairing = { pairingId, id: pairingId, number: clean, phone: clean, authFolder, sessionId: existingSessionId||null, status: "connecting", connected: false, createdAt: new Date().toISOString() };
    pairing.authFolder=authFolder; pairing.number=clean; pairing.phone=clean;
    if (existingSessionId) pairing.sessionId=existingSessionId;
    pairing.status="connecting"; pairing.connected=false;
    try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const socket = makeWASocket({ auth: state, browser: Browsers.macOS("Chrome"), printQRInTerminal:false, logger: pino({level:"silent"}), markOnlineOnConnect:false, syncFullHistory:false, generateHighQualityLinkPreview:false, connectTimeoutMs:60000, defaultQueryTimeoutMs:60000, keepAliveIntervalMs:25000 });
    sockets.set(pairingId, socket);
    socket.ev.on("creds.update", async()=>{ try{ await saveCreds(); }catch{} });
    socket.ev.on("connection.update", async update=>{
        const { connection, lastDisconnect, qr } = update;
        if (qr){ pairing.qr=qr; pairing.status="qr_ready"; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
        if (connection==="connecting"){ pairing.status="connecting"; pairing.connected=false; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
        if (connection==="open"){
            try{
                const userJid = normalizeJid(socket.user?.id);
                pairing.jid=userJid; pairing.connected=true; pairing.status="connected"; pairing.qr=null;
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                await sleep(1500);
                const result = await generateAndSendSession(socket, authFolder, userJid, pairingId, userJid);
                if (!result||!result.sessionId) throw new Error("Session ID was not generated");
                const finalSessionId = normalizeSessionId(result.sessionId);
                pairing.sessionId=finalSessionId; pairing.jid=result.jid||userJid; pairing.number=result.number||clean;
                pairing.authFolder=result.authFolder||authFolder; pairing.connected=true; pairing.status="session_sent";
                pairing.sessionSent=true; pairing.sessionSentAt=new Date().toISOString();
                await saveSessionMapping(pairing, {...result, sessionId: finalSessionId, pairingId, authFolder, number: result.number||clean, jid: result.jid||userJid, status:"session_sent", connected:true});
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                const hasAuth = await authExists(authFolder); if (!hasAuth) return;
                await sleep(1000); await closePairingSocket(pairingId, "SESSION_SENT_AUTH_SAVED");
                pairing.connected=false; pairing.status="ready_for_deployment";
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                // START BOT IMMEDIATELY AFTER PAIRING
                const finalAuthFolder = result.authFolder||authFolder;
                await fsp.mkdir(getAuthFolderBySession(finalSessionId),{recursive:true});
                // Copy auth files to final session folder for deploy manager
                try{
                  const files = await fsp.readdir(finalAuthFolder);
                  for(const f of files){
                    try{ await fsp.copyFile(path.join(finalAuthFolder,f), path.join(getAuthFolderBySession(finalSessionId),f)); }catch{}
                  }
                }catch{}
                await startBotSession({sessionId:finalSessionId, number:clean, authFolder:getAuthFolderBySession(finalSessionId)});
                return;
            }catch(error){ pairing.status="session_error"; pairing.error=error.message; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
        }
        if (connection==="close"){
            const code = getDisconnectCode(lastDisconnect); const intentional = socket.__etiasIntentionalClose===true;
            sockets.delete(pairingId);
            if (intentional||pairing.sessionSent||pairing.status==="session_sent"||pairing.status==="ready_for_deployment"){ pairing.connected=false; pairing.status="ready_for_deployment"; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} return; }
            if (isLoggedOut(code)){ pairing.connected=false; pairing.status="logged_out"; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} return; }
            if (!reconnecting.has(pairingId)){
                reconnecting.add(pairingId); pairing.connected=false; pairing.status="reconnecting";
                try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
                setTimeout(async()=>{ reconnecting.delete(pairingId); try{ await startPairing(clean, pairingId, authFolder, pairing.sessionId||null); }catch{} },5000);
            }
        }
    });
    if (!state.creds.registered){
        try{
            await delay(1500); pairing.status="requesting_pairing_code";
            try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
            const code = await socket.requestPairingCode(clean);
            pairing.pairingCode=String(code||"").replace(/[^A-Z0-9]/gi,"").toUpperCase(); pairing.status="pairing_code";
            try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{}
        }catch(error){ pairing.status="pairing_code_error"; pairing.error=error.message; try{ await Promise.resolve(updatePairing(pairingId, pairing)); }catch{} }
    }
    return { pairingId, authFolder };
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(ROOT));

app.get("/", (req, res) => {
    res.sendFile(path.join(ROOT, "index.html"), error => {
        if (error) res.json({ success: true, name: BOT_NAME+" Pairing Server", status: "online", service: "pairing", sessionPrefix: SESSION_PREFIX, time: new Date().toISOString() });
    });
});

app.get("/pair", (req, res) => { res.sendFile(path.join(ROOT, "pair.html")); });
app.get("/qr", (req, res) => { res.sendFile(path.join(ROOT, "qr.html")); });
app.get("/active", (req, res) => { res.sendFile(path.join(ROOT, "active.html")); });
app.get("/ping", (req, res) => { res.json({ success: true, pong: true, time: new Date().toISOString() }); });

app.get("/health", async (req, res) => {
    const sessions = await Promise.resolve(getAllSessions()).catch(()=>[]);
    res.json({ success: true, status: "online", service: "pairing", name: BOT_NAME, pairingSockets: sockets.size, botSockets: activeBotSockets.size, sessions: Array.isArray(sessions)?sessions.length:0, mongo: isMongoConnected(), time: new Date().toISOString() });
});

app.get("/deployments", async (req,res)=>{
  try{
    if(!isMongoConnected()) return res.json([]);
    const bots = await DeployedBot.find().sort({deployedAt:-1});
    const regs = await Registry.find({}); const regMap={}; regs.forEach(r=>regMap[r.sessionId]=r);
    res.json(bots.map(b=>{
      const reg=regMap[b.sessionId]; const isOnline = activeBotSockets.has(b.sessionId) && activeBotSockets.get(b.sessionId).connected;
      return { sessionId:b.sessionId, phone:b.phone, number:b.number||b.phone, expiry:b.expiry||b.expireAt, deployedAt:b.deployedAt, duration:b.duration||30, liveConnected: isOnline ||!!reg?.connected, connected: isOnline ||!!reg?.connected, status: isOnline?"online":(reg?.status||'deployed') };
    }));
  }catch(e){ res.json([]); }
});

app.get("/dashboard", (req,res)=>{
  res.sendFile(path.join(ROOT, "dashboard.html"), err=>{
    if(err) res.send(`<h2>dashboard.html missing - upload file</h2>`);
  });
});

app.post("/delete", async(req,res)=>{
  const {adminKey, sessionId} = req.body;
  if(process.env.ADMIN_KEY && adminKey!==process.env.ADMIN_KEY) return res.status(401).json({error:'Invalid Admin Key'});
  try{
    if(isMongoConnected()){ await DeployedBot.deleteOne({sessionId}); await Registry.deleteOne({sessionId}); }
    const reg = await readSessionRegistry(); delete reg[sessionId]; await writeSessionRegistry(reg);
    if(activeBotSockets.has(sessionId)){ try{ activeBotSockets.get(sessionId).sock.ws.close(); }catch{} activeBotSockets.delete(sessionId); }
    try{ await fsp.rm(getAuthFolderBySession(sessionId),{recursive:true,force:true}); }catch{}
    res.json({success:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/renew", async(req,res)=>{
  const {adminKey, sessionId, duration} = req.body;
  if(process.env.ADMIN_KEY && adminKey!==process.env.ADMIN_KEY) return res.status(401).json({error:'Invalid Admin Key'});
  try{
    const days=parseInt(duration)||30; const expiry=new Date(Date.now()+days*24*60*60*1000);
    if(isMongoConnected()){ await DeployedBot.findOneAndUpdate({sessionId},{expiry,expireAt:expiry,duration:days},{upsert:true}); await Registry.findOneAndUpdate({sessionId},{expiresAt:expiry.toISOString()}); }
    res.json({success:true, expiry});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/code", async (req, res) => {
    try {
        const number = cleanNumber(req.query.number);
        if (!number||number.length<8) return res.status(400).json({ success: false, error: "Valid WhatsApp number required" });
        const created = await Promise.resolve(createPairing(number));
        const pairingId = created?.pairingId||created?.id||created;
        if (!pairingId) throw new Error("Could not create pairing");
        startPairing(number, pairingId).catch(()=>{});
        const timeout=Date.now()+30000;
        while(Date.now()<timeout){
            await sleep(500);
            const pairing = await Promise.resolve(getPairing(pairingId));
            if (pairing?.pairingCode) return res.json({ success: true, pairingId, sessionId: pairing.sessionId||null, number, status: pairing.status||"pairing_code", pairingCode: pairing.pairingCode });
            if (pairing?.status==="error"||pairing?.status==="pairing_code_error") return res.status(500).json({ success: false, pairingId, error: pairing.error||"Pairing code generation failed" });
        }
        const finalPairing = await Promise.resolve(getPairing(pairingId));
        return res.json({ success: true, pairingId, sessionId: finalPairing?.sessionId||null, number, status: finalPairing?.status||"connecting", pairingCode: finalPairing?.pairingCode||null });
    } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
});

app.get("/status/:id", async (req, res) => {
    try {
        const id=req.params.id; const pairing = await Promise.resolve(getPairing(id));
        if (!pairing) return res.status(404).json({ success: false, error: "Pairing ID not found" });
        return res.json({ success: true, pairingId:id, sessionId:pairing.sessionId||null, number:pairing.number||pairing.phone||null, status:pairing.status||"unknown", connected:Boolean(pairing.connected), pairingCode:pairing.pairingCode||null, qr:pairing.qr||null, authAvailable:await authExists(pairing.authFolder) });
    } catch (error){ return res.status(500).json({ success: false, error: error.message }); }
});

async function sendSessionDetails(req,res){
    try{
        const sessionId=normalizeSessionId(req.params.sessionId);
        if (!isValidSessionId(sessionId)) return res.status(400).json({ success: false, error: "Invalid Session ID" });
        const record = await findSessionEverywhere(sessionId); if (!record) return res.status(404).json({ success: false, error: "Session ID not found" });
        const authAvailable = await authExists(record.authFolder);
        return res.json({ success: true, sessionId, pairingId:record.pairingId||null, number:record.number||null, phone:record.number||null, jid:record.jid||null, authFolder:record.authFolder||null, authAvailable, status:record.status||(authAvailable?"ready_for_deployment":"unknown"), connected:Boolean(record.connected), deployed:Boolean(record.deployed) });
    }catch(error){ return res.status(500).json({ success: false, error: error.message }); }
}
app.get("/session/:sessionId", sendSessionDetails);
app.get("/api/session/:sessionId", sendSessionDetails);
app.get("/session/:sessionId/auth", async (req,res)=>{
    try{
        if (!SESSION_TRANSFER_SECRET) return res.status(503).json({ success: false, error: "Session auth transfer is not configured" });
        const suppliedSecret = String(req.headers["x-session-transfer-secret"]||req.query.secret||"");
        if (suppliedSecret!==SESSION_TRANSFER_SECRET) return res.status(401).json({ success: false, error: "Invalid session transfer secret" });
        const sessionId=normalizeSessionId(req.params.sessionId);
        if (!isValidSessionId(sessionId)) return res.status(400).json({ success: false, error: "Invalid Session ID" });
        const record = await findSessionEverywhere(sessionId); if (!record) return res.status(404).json({ success: false, error: "Session ID not found" });
        if (!record.authFolder) return res.status(404).json({ success: false, error: "Auth folder not available" });
        const authAvailable = await authExists(record.authFolder); if (!authAvailable) return res.status(404).json({ success: false, error: "creds.json not found" });
        const files = await readAuthFiles(record.authFolder); if (!files.length) return res.status(404).json({ success: false, error: "No authentication files found" });
        return res.json({ success: true, sessionId, pairingId:record.pairingId||null, number:record.number||null, jid:record.jid||null, files, fileCount:files.length, transferredAt:new Date().toISOString() });
    }catch(error){ return res.status(500).json({ success: false, error: error.message }); }
});
app.get("/qr-image", async (req,res)=>{
    try{
        const id=req.query.id; if (!id) return res.status(400).json({ success: false, error: "Pairing ID required" });
        const pairing = await Promise.resolve(getPairing(id)); if (!pairing||!pairing.qr) return res.status(404).json({ success: false, error: "QR not available" });
        const png = await QRCode.toBuffer(pairing.qr, { type: "png", width: 500, margin: 2 });
        res.setHeader("Content-Type","image/png"); return res.send(png);
    }catch(error){ return res.status(500).json({ success: false, error: error.message }); }
});

app.use((req,res)=>{ res.status(404).json({ success: false, error: "Route not found", path: req.originalUrl }); });

async function startServer() {
    await ensureDirectories();
    app.listen(PORT, "0.0.0.0", () => {
        logger.info({ port: PORT, bot: BOT_NAME, mongo: isMongoConnected() }, "[SERVER] Pairing + Deploy server running");
        logger.info("[SERVER] Dashboard: /dashboard | Pairing: /pair | Health: /health");
        // START AUTO DEPLOY - makes users ONLINE
        initAutoDeploy();
    });
}

if (require.main===module){
    startServer().catch(error=>{ logger.error({error:error.message},"[SERVER] Startup failed"); process.exit(1); });
}
module.exports = app;
