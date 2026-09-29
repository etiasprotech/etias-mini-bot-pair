// TAR.GZ + BASE64 MULTI-FILE SESSION SYSTEM - FINAL FIXED DM
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const P = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = "*ETIAS-MINI-BOT*";
const PREFIX = process.env.PREFIX || ".";
const MAIN_OWNER = "263778810589";
const OWNER_NUMBER = (process.env.OWNER_NUMBER || MAIN_OWNER).replace(/[^0-9]/g, "");
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "";
const PAIRING_SITE = "https://etias-mini-bot-pair.onrender.com";
const PREFIX_SESSION = "ETIAS-MINI-BOT~";
const ALLOWED_DAYS = [7, 15, 30, 60, 90, 365];
const DEFAULT_DAYS = 30;

const dataPath = path.join(__dirname, "data");
const authBasePath = path.join(__dirname, "auth");
const usersPath = path.join(authBasePath, "users");
const tempAuthPath = path.join(__dirname, "temp_auth");
for (const dir of [dataPath, authBasePath, usersPath, tempAuthPath]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

const sessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true, index: true },
    sessionId: String,
    phone: String,
    connected: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastConnectedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    days: { type: Number, default: DEFAULT_DAYS },
    addedBy: { type: String, default: MAIN_OWNER }
});
const SessionModel = mongoose.models.Session || mongoose.model("Session", sessionSchema);

async function connectMongo() {
    if (!MONGODB_URI) { console.log("[MONGO] No URI"); return false; }
    try {
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
        console.log("[MONGO] ✅ Connected"); return true;
    } catch (e) { console.log("[MONGO] ❌", e.message); return false; }
}

function getDB(filename, fallback = {}) {
    const file = path.join(dataPath, filename);
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { return fallback; }
}
function saveDB(filename, data) {
    const file = path.join(dataPath, filename);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temp, file);
}
function getMultiDB() { return getDB("multi_sessions.json", {}); }
function normalizeNumber(v) { if (!v) return ""; return String(v).split(":")[0].split("@")[0].replace(/[^0-9]/g, ""); }
function isExpired(date) { if (!date) return false; return new Date(date).getTime() <= Date.now(); }

async function saveToMongo(userId, sessionId, days) {
    if (mongoose.connection.readyState!== 1) return;
    try {
        const expiresAt = new Date(Date.now() + days * 86400000);
        await SessionModel.findOneAndUpdate({ userId }, { userId, sessionId, phone: userId, connected: true, lastConnectedAt: new Date(), expiresAt, days, addedBy: MAIN_OWNER }, { upsert: true, new: true });
        console.log(`[MONGO SAVE] ${userId} ${days}d`);
    } catch (e) { console.log("[MONGO SAVE]", e.message); }
}
function saveMultiSession(userId, sessionId, days) {
    const db = getMultiDB();
    db[userId] = { sessionId, days, addedAt: Date.now(), expiresAt: Date.now() + days * 86400000 };
    saveDB("multi_sessions.json", db);
    saveToMongo(userId, sessionId, days);
}

async function getFromMongo() {
    if (mongoose.connection.readyState!== 1) return {};
    const sessions = await SessionModel.find({});
    const result = {};
    for (const s of sessions) {
        if (s.expiresAt && isExpired(s.expiresAt)) {
            console.log(`[EXPIRY] ${s.userId}`);
            try { await SessionModel.deleteOne({ _id: s._id }); } catch {}
            const authPath = s.userId === "main"? authBasePath : path.join(usersPath, normalizeNumber(s.userId));
            try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
            continue;
        }
        if (s.sessionId) result[s.userId] = { sessionId: s.sessionId, days: s.days, expiresAt: s.expiresAt };
    }
    return result;
}

function safeRelativePath(file) {
    const normalized = path.posix.normalize(String(file).replace(/\\/g, "/"));
    if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("\0")) throw new Error("Unsafe archive path");
    return normalized;
}

// ===== FIXED DECODE - HANDLES PARTS =====
function decodeSessionArchive(sessionString) {
    if (!sessionString) throw new Error("Session required");
    let clean = String(sessionString);
    // Remove PART markers and prefix, keep only base64
    clean = clean.replace(/ETIAS-MINI-BOT~PART:\d+\/\d+/g, "");
    clean = clean.replace(/PART:\d+\/\d+/g, "");
    clean = clean.replace(/ETIAS-MINI-BOT~/g, "");
    clean = clean.replace(/\s+/g, "").trim();
    if (!clean) throw new Error("Empty session after cleaning PARTs");
    console.log(`[DECODE] Cleaned len=${clean.length}`);
    const compressed = Buffer.from(clean, "base64");
    if (!compressed.length) throw new Error("Invalid base64");
    let tarBuffer;
    try { tarBuffer = zlib.gunzipSync(compressed); }
    catch (e) { throw new Error(`Invalid GZIP: ${e.message} - Make sure you pasted ALL PARTs together`); }
    if (!tarBuffer.length) throw new Error("Empty TAR");
    return tarBuffer;
}

function restoreSessionArchive(sessionString, destination) {
    const tarBuffer = decodeSessionArchive(sessionString);
    const tempTar = path.join(tempAuthPath, `restore-${crypto.randomBytes(8).toString("hex")}.tar`);
    try {
        fs.writeFileSync(tempTar, tarBuffer);
        const listing = execFileSync("tar", ["-tf", tempTar], { encoding: "utf8" });
        const entries = listing.split("\n").map(x => x.trim()).filter(Boolean);
        let hasCreds = false;
        for (const entry of entries) {
            const safe = safeRelativePath(entry);
            if (safe === "creds.json" || safe.endsWith("/creds.json")) hasCreds = true;
        }
        if (!hasCreds) throw new Error("Archive missing creds.json");
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(destination, { recursive: true });
        execFileSync("tar", ["-xf", tempTar, "-C", destination], { stdio: "ignore" });
        if (!fs.existsSync(path.join(destination, "creds.json"))) throw new Error("Extraction failed");
        return true;
    } finally { try { fs.rmSync(tempTar, { force: true }); } catch {} }
}

function createSessionArchive(authPath) {
    const tempTar = path.join(tempAuthPath, `create-${crypto.randomBytes(8).toString("hex")}.tar`);
    const tempGz = `${tempTar}.gz`;
    try {
        if (!fs.existsSync(authPath)) throw new Error("Auth folder not found");
        if (!fs.existsSync(path.join(authPath, "creds.json"))) throw new Error("creds.json missing");
        execFileSync("tar", ["-cf", tempTar, "-C", authPath, "."], { stdio: "ignore" });
        execFileSync("gzip", ["-f", tempTar], { stdio: "ignore" });
        const data = fs.readFileSync(tempGz);
        return PREFIX_SESSION + data.toString("base64");
    } finally {
        try { fs.rmSync(tempTar, { force: true }); } catch {}
        try { fs.rmSync(tempGz, { force: true }); } catch {}
    }
}

function getSessionAccount(authPath) {
    const credsPath = path.join(authPath, "creds.json");
    if (!fs.existsSync(credsPath)) throw new Error("creds.json not found");
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    return { number: normalizeNumber(creds?.me?.id), registered:!!creds?.registered };
}

const logs = [];
function addLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line); logs.push(line);
    if (logs.length > 300) logs.shift();
}

const messageStore = new Map();
const activeBots = new Map();
const startingBots = new Map();
const reconnectTimers = new Map();
const stoppedBots = new Set();
const sentDM = new Set();
const commands = new Map();

function loadCommands() {
    const commandsPath = path.join(__dirname, "commands");
    if (!fs.existsSync(commandsPath)) { addLog("[COMMANDS] no folder"); return; }
    const files = fs.readdirSync(commandsPath);
    let count = 0;
    for (const file of files) {
        if (!file.endsWith(".js")) continue;
        try {
            const full = path.join(commandsPath, file);
            delete require.cache[require.resolve(full)];
            const cmd = require(full);
            const names = [];
            if (cmd.name) names.push(cmd.name);
            if (Array.isArray(cmd.aliases)) names.push(...cmd.aliases);
            for (const name of names) commands.set(String(name).toLowerCase(), cmd);
            if (names.length) count++;
        } catch (e) { addLog(`[CMD ERR] ${file}: ${e.message}`); }
    }
    addLog(`[COMMANDS] ${count} loaded`);
}

function isOwnerMessage(msg, userId) {
    const key = msg?.key || {};
    if (key.fromMe) return true;
    const sender = normalizeNumber(key.participant || key.remoteJid || "");
    if (sender === MAIN_OWNER) return true;
    if (sender === OWNER_NUMBER) return true;
    if (userId!== "main" && sender === normalizeNumber(userId)) return true;
    return false;
}

function getExpiry(userId) { const db = getMultiDB(); const item = db[userId]; if (!item || typeof item === "string") return null; return item.expiresAt; }
function isSessionExpired(userId) { if (userId === "main") return false; const expiry = getExpiry(userId); return expiry && Number(expiry) <= Date.now(); }
function clearReconnect(userId) { const t = reconnectTimers.get(userId); if (t) { clearTimeout(t); reconnectTimers.delete(userId); } }
function scheduleReconnect(userId, delay) {
    if (stoppedBots.has(userId)) return;
    if (isSessionExpired(userId)) { addLog(`[RECONNECT] ${userId} expired`); return; }
    if (reconnectTimers.has(userId)) return;
    addLog(`[RECONNECT] ${userId} in ${delay / 1000}s`);
    const timer = setTimeout(async () => {
        reconnectTimers.delete(userId);
        try { await startBotForUser(userId, null); } catch (e) { addLog(`[RECONNECT ERR] ${userId}: ${e.message}`); scheduleReconnect(userId, 10000); }
    }, delay);
    reconnectTimers.set(userId, timer);
}

// ===== FIXED DM - FORCE SEND =====
async function sendSessionDMOnce(sock, authPath) {
    try {
        const myNumber = normalizeNumber(sock.user?.id || "");
        if (!myNumber) { console.log("[DM] No number"); return; }
        const lock = path.join(dataPath, `sent_${myNumber}.lock`);

        // FORCE CLEAR FOR TESTING - DELETE AFTER FIRST SUCCESS
        try {
            if (fs.existsSync(lock)) {
                console.log(`[DM] Clearing old lock for ${myNumber}`);
                fs.rmSync(lock, { force: true });
                sentDM.delete(myNumber);
            }
        } catch {}

        if (fs.existsSync(lock) && sentDM.has(myNumber)) {
            console.log(`[DM] Already sent for ${myNumber}, skipping`);
            return;
        }

        console.log(`[DM] Preparing session for ${myNumber}`);
        await new Promise(r => setTimeout(r, 2500));

        const session = createSessionArchive(authPath);
        const jid = sock.user?.id || `${myNumber}@s.whatsapp.net`;
        const chunkSize = 35000;
        const total = Math.ceil(session.length / chunkSize);

        console.log(`[DM] Sending to ${jid} total=${total} len=${session.length}`);

        await sock.sendMessage(jid, {
            text: `*ETIAS-MINI-BOT ✅ CONNECTED*\n\n*Number:* ${myNumber}\n*Parts:* ${total}\n*Expires:* Auto\n\nReceiving session in ${total} message(s)...`
        });
        await new Promise(r => setTimeout(r, 1200));

        for (let i = 0; i < total; i++) {
            const chunk = session.slice(i * chunkSize, (i + 1) * chunkSize);
            await sock.sendMessage(jid, { text: `${PREFIX_SESSION}PART:${i + 1}/${total}\n\n${chunk}` });
            console.log(`[DM] Sent ${i + 1}/${total} for ${myNumber}`);
            await new Promise(r => setTimeout(r, 800));
        }

        fs.writeFileSync(lock, Date.now().toString());
        sentDM.add(myNumber);
        addLog(`[SESSION DM] ${myNumber} sent in ${total} parts`);
        console.log(`[DM] ✅ DONE for ${myNumber}`);

    } catch (e) {
        console.log(`[DM ERR] ${e.message}`);
        console.log(e.stack);
        addLog(`[DM ERR] ${e.message}`);
    }
}

async function startBotForUser(userId, sessionString = null) {
    if (startingBots.has(userId)) return startingBots.get(userId);
    const existing = activeBots.get(userId);
    if (existing && existing.user) return existing;
    stoppedBots.delete(userId);
    const promise = (async () => {
        const isMain = userId === "main";
        const authPath = isMain? authBasePath : path.join(usersPath, normalizeNumber(userId));
        if (sessionString) {
            addLog(`[SESSION] Restoring for ${userId}`);
            restoreSessionArchive(sessionString, authPath);
            const account = getSessionAccount(authPath);
            if (!account.registered) throw new Error("Not registered");
            addLog(`[SESSION] Restored ${account.number}`);
        } else if (isMain && process.env.SESSION_ID) {
            restoreSessionArchive(process.env.SESSION_ID, authPath);
        }
        if (!fs.existsSync(path.join(authPath, "creds.json"))) throw new Error("No session available");
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const sock = makeWASocket({
            auth: state,
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            browser: ["ETIAS-MINI-BOT", "Chrome", "1.0.0"],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            getMessage: async key => messageStore.get(key.id)?.msg || undefined
        });
        activeBots.set(userId, sock);
        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", async update => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                const current = activeBots.get(userId);
                if (current!== sock) { try { sock.ws?.close(); } catch {} return; }
                clearReconnect(userId);
                addLog(`[CONNECTED] ${userId} ${sock.user?.id}`);
                try {
                    const existingDB = getMultiDB();
                    const existing = existingDB[normalizeNumber(sock.user?.id || userId)];
                    let days = existing?.days || DEFAULT_DAYS;
                    const freshSession = createSessionArchive(authPath);
                    const saveId = normalizeNumber(sock.user?.id || userId);
                    saveMultiSession(saveId, freshSession, days);
                    addLog(`[SESSION SAVED] ${saveId} len=${freshSession.length}`);
                } catch (e) { addLog(`[SAVE ERR] ${e.message}`); }
                addLog(`[READY] ${userId} OWNER:${MAIN_OWNER}`);
                await sendSessionDMOnce(sock, authPath);
                return;
            }
            if (connection === "close") {
                const code = lastDisconnect?.error?.output?.statusCode;
                addLog(`[DISC] ${userId} code=${code}`);
                const current = activeBots.get(userId);
                if (current!== sock) return;
                activeBots.delete(userId);
                if (code === DisconnectReason.loggedOut) { stoppedBots.add(userId); clearReconnect(userId); addLog(`[LOGGED OUT] ${userId}`); return; }
                if (isSessionExpired(userId)) { addLog(`[EXPIRED] ${userId}`); stoppedBots.add(userId); return; }
                if (!stoppedBots.has(userId)) scheduleReconnect(userId, 5000);
            }
        });
        sock.ev.on("messages.upsert", async ({ messages }) => {
            for (const msg of messages) {
                if (!msg?.message) continue;
                const id = msg.key?.id;
                if (id) messageStore.set(id, { msg: msg.message, timestamp: Date.now() });
                if (messageStore.size > 5000) { const first = messageStore.keys().next().value; messageStore.delete(first); }
                await handleMessage(sock, msg, userId, authPath);
            }
        });
        return sock;
    })();
    startingBots.set(userId, promise);
    try { return await promise; } finally { startingBots.delete(userId); }
}

async function handleMessage(sock, msg, userId, authPath) {
    try {
        const jid = msg.key?.remoteJid; if (!jid) return;
        const owner = isOwnerMessage(msg, userId);
        let message = msg.message;
        let actualMessage = message;
        const viewOnce = message?.viewOnceMessageV2 || message?.viewOnceMessage || message?.viewOnceMessageV2Extension;
        if (viewOnce) {
            const db = getDB("settings.json", {});
            if (db[userId]?.antiviewonce) { try { actualMessage = viewOnce.message; } catch {} }
        }
        const text = actualMessage?.conversation || actualMessage?.extendedTextMessage?.text || actualMessage?.imageMessage?.caption || actualMessage?.videoMessage?.caption || "";
        if (!text) return;
        const settings = getDB("settings.json", {});
        if (settings[userId]?.antilink && /https?:\/\/|www\./i.test(text) &&!owner) {
            try { await sock.sendMessage(jid, { text: "🚫 Links not allowed." }, { quoted: msg }); } catch {} return;
        }
        if (!text.startsWith(PREFIX)) return;
        const body = text.slice(PREFIX.length).trim(); if (!body) return;
        const parts = body.split(/\s+/);
        const commandName = parts.shift().toLowerCase();
        const args = parts;

        if (commandName === "session") {
            if (!owner) return;
            try {
                const session = createSessionArchive(authPath);
                const chunkSize = 35000;
                const total = Math.ceil(session.length / chunkSize);
                for (let i = 0; i < total; i++) {
                    const chunk = session.slice(i * chunkSize, (i + 1) * chunkSize);
                    await sock.sendMessage(jid, { text: `${PREFIX_SESSION}PART:${i + 1}/${total}\n\n${chunk}` }, { quoted: i === 0? msg : undefined });
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }, { quoted: msg }); }
            return;
        }
        if (commandName === "antilink") {
            if (!owner) return;
            const mode = (args[0] || "").toLowerCase();
            const db = getDB("settings.json", {});
            if (!db[userId]) db[userId] = {};
            if (mode === "on") db[userId].antilink = true;
            else if (mode === "off") db[userId].antilink = false;
            else { await sock.sendMessage(jid, { text: `${BOT_NAME}\nUse:\n.antilink on\n.antilink off` }, { quoted: msg }); return; }
            saveDB("settings.json", db);
            await sock.sendMessage(jid, { text: `Antilink ${db[userId].antilink? "enabled" : "disabled"}` }, { quoted: msg });
            return;
        }
        if (commandName === "antidelete") {
            if (!owner) return;
            const mode = (args[0] || "").toLowerCase();
            const db = getDB("settings.json", {});
            if (!db[userId]) db[userId] = {};
            if (mode === "on") db[userId].antidelete = true;
            else if (mode === "off") db[userId].antidelete = false;
            else { await sock.sendMessage(jid, { text: ".antidelete on\n.antidelete off" }, { quoted: msg }); return; }
            saveDB("settings.json", db);
            await sock.sendMessage(jid, { text: `Antidelete ${db[userId].antidelete? "enabled" : "disabled"}` }, { quoted: msg });
            return;
        }
        if (commandName === "antiviewonce" || commandName === "viewonce") {
            if (!owner) return;
            const mode = (args[0] || "").toLowerCase();
            const db = getDB("settings.json", {});
            if (!db[userId]) db[userId] = {};
            if (mode === "on") db[userId].antiviewonce = true;
            else if (mode === "off") db[userId].antiviewonce = false;
            else { await sock.sendMessage(jid, { text: ".antiviewonce on\n.antiviewonce off" }, { quoted: msg }); return; }
            saveDB("settings.json", db);
            await sock.sendMessage(jid, { text: `Anti-viewonce ${db[userId].antiviewonce? "enabled" : "disabled"}` }, { quoted: msg });
            return;
        }
        if (commandName === "mode") {
            if (!owner) return;
            await sock.sendMessage(jid, { text: `${BOT_NAME}\nMode: public\nOwner: ${MAIN_OWNER}\nPrefix: ${PREFIX}` }, { quoted: msg });
            return;
        }
        const command = commands.get(commandName);
        if (!command) return;
        try {
            if (typeof command.execute === "function") await command.execute({ sock, msg, args, text, userId, owner, prefix: PREFIX });
            else if (typeof command.run === "function") await command.run(sock, msg, args);
            else if (typeof command === "function") await command(sock, msg, args);
        } catch (e) { addLog(`[CMD ${commandName}] ${e.message}`); }
    } catch (e) { addLog(`[MSG ERR] ${e.message}`); }
}

async function checkExpiredSessions() {
    const db = getMultiDB(); let changed = false;
    for (const [userId, data] of Object.entries(db)) {
        if (userId === "main") continue;
        if (typeof data === "string") continue;
        if (!data?.expiresAt) continue;
        if (Number(data.expiresAt) > Date.now()) continue;
        addLog(`[EXPIRY] ${userId}`);
        stoppedBots.add(userId); clearReconnect(userId);
        const sock = activeBots.get(userId); activeBots.delete(userId);
        try { sock?.ws?.close(); } catch {}
        const authPath = path.join(usersPath, normalizeNumber(userId));
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
        delete db[userId]; changed = true;
        if (mongoose.connection.readyState === 1) { try { await SessionModel.deleteOne({ userId }); } catch {} }
    }
    if (changed) saveDB("multi_sessions.json", db);
}

async function startAll() {
    await connectMongo();
    loadCommands();
    let multiDB = {};
    if (mongoose.connection.readyState === 1) {
        multiDB = await getFromMongo();
        saveDB("multi_sessions.json", multiDB);
        addLog(`[MULTI] ${Object.keys(multiDB).length} valid sessions`);
    } else {
        multiDB = getMultiDB();
        addLog(`[MULTI] ${Object.keys(multiDB).length} local sessions`);
    }
    const ids = Object.keys(multiDB);
    if (ids.length) {
        for (const id of ids) {
            try {
                const data = multiDB[id];
                const session = typeof data === "string"? data : data.sessionId;
                if (!session) { addLog(`[MULTI] ${id} no session`); continue; }
                if (data.expiresAt && isExpired(data.expiresAt)) continue;
                addLog(`[MULTI] Starting ${id}`);
                await startBotForUser(id, session);
            } catch (e) { addLog(`[START ERR] ${id}: ${e.message}`); }
            await new Promise(r => setTimeout(r, 2000));
        }
        addLog("[MULTI] Startup complete"); return;
    }
    if (process.env.SESSION_ID) {
        addLog("[MAIN] Starting SESSION_ID");
        try { await startBotForUser("main", process.env.SESSION_ID); } catch (e) { addLog(`[MAIN ERR] ${e.message}`); }
        return;
    }
    addLog(`[MAIN] No session - Use ${PAIRING_SITE} to pair`);
}

app.get("/deploy", (req, res) => {
    const db = getMultiDB();
    const rows = Object.entries(db).map(([id, data]) => {
        const days = typeof data === "string"? "?" : data.days;
        const expiry = typeof data === "string"? "?" : new Date(data.expiresAt).toLocaleString();
        return `<tr><td>${id}</td><td>${days}</td><td>${expiry}</td><td><button onclick="deleteBot('${id}')">Delete</button></td></tr>`;
    }).join("");
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETIAS Deploy</title><style>body{margin:0;background:#050816;color:#fff;font-family:Arial;padding:20px}.container{max-width:900px;margin:auto}.card{background:#10172a;padding:25px;border-radius:18px;margin-bottom:20px}input,select,textarea,button{width:100%;box-sizing:border-box;padding:13px;margin-top:10px;border-radius:10px;border:0}textarea{height:220px;resize:vertical}button{background:#00e5ff;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{padding:10px;border-bottom:1px solid #26304a;text-align:left}.status{margin-top:15px;white-space:pre-wrap;word-break:break-word}</style></head><body><div class="container"><div class="card"><h1>ETIAS-MINI-BOT</h1><p>Multi-session deployment</p><h3>Deploy Session</h3><input id="number" placeholder="2637..."><select id="days"><option value="7">7 Days</option><option value="15">15 Days</option><option value="30" selected>30 Days</option><option value="60">60 Days</option><option value="90">90 Days</option><option value="365">365 Days</option></select><textarea id="session" placeholder="Paste complete ETIAS-MINI-BOT~ session (all PARTs combined)"></textarea><button onclick="deploy()">DEPLOY BOT</button><div id="status" class="status"></div></div><div class="card"><h2>Deployed Bots</h2><table><thead><tr><th>Number</th><th>Days</th><th>Expires</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></div><script>async function deploy(){const number=document.getElementById("number").value.trim();const days=Number(document.getElementById("days").value);const session=document.getElementById("session").value.trim();const status=document.getElementById("status");if(!session){status.textContent="❌ Session required";return;}status.textContent="Deploying...";try{const res=await fetch("/api/deploy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number,session,days})});const data=await res.json();if(!data.success){status.textContent="❌ "+data.error;return;}status.textContent=data.message;setTimeout(()=>location.reload(),1500);}catch(e){status.textContent="❌ "+e.message;}}async function deleteBot(number){if(!confirm("Delete "+number+"?"))return;const res=await fetch("/api/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number})});const data=await res.json();alert(data.success?data.message:data.error);location.reload();}</script></body></html>`);
});

app.post("/api/deploy", async (req, res) => {
    try {
        const { number, session, days } = req.body;
        if (!session) return res.json({ success: false, error: "Session required" });
        const daysNum = Number.parseInt(days, 10);
        if (!ALLOWED_DAYS.includes(daysNum)) return res.json({ success: false, error: "Invalid duration. Choose 7,15,30,60,90,365" });

        const tempDestination = path.join(tempAuthPath, `deploy-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
        try {
            let fullSession = session;
            // Auto-join PARTs
            if (session.includes("PART:")) {
                fullSession = PREFIX_SESSION + session.replace(/ETIAS-MINI-BOT~PART:\d+\/\d+/g, "").replace(/PART:\d+\/\d+/g, "").replace(/ETIAS-MINI-BOT~/g, "").replace(/\s+/g, "");
            }
            console.log(`[DEPLOY] Attempting restore len=${fullSession.length}`);
            restoreSessionArchive(fullSession, tempDestination);
            const account = getSessionAccount(tempDestination);
            if (!account.registered) throw new Error("Session not registered");
            const sessionNumber = account.number;
            const submittedNumber = normalizeNumber(number);
            if (submittedNumber && submittedNumber!== sessionNumber) throw new Error(`Number mismatch. Session belongs to ${sessionNumber}`);
            if (activeBots.has(sessionNumber)) throw new Error(`Bot ${sessionNumber} already active`);
            saveMultiSession(sessionNumber, fullSession, daysNum);
            fs.rmSync(tempDestination, { recursive: true, force: true });
            await startBotForUser(sessionNumber, fullSession);
            addLog(`[DEPLOY] ${sessionNumber} for ${daysNum}d`);
            return res.json({ success: true, message: `✅ Bot ${sessionNumber} deployed for ${daysNum} days`, number: sessionNumber, days: daysNum });
        } finally { try { fs.rmSync(tempDestination, { recursive: true, force: true }); } catch {} }
    } catch (e) {
        addLog(`[DEPLOY ERROR] ${e.message}`);
        return res.json({ success: false, error: e.message });
    }
});

app.post("/api/delete", async (req, res) => {
    try {
        const number = normalizeNumber(req.body.number);
        if (!number) return res.json({ success: false, error: "Number required" });
        stoppedBots.add(number); clearReconnect(number);
        const sock = activeBots.get(number); activeBots.delete(number);
        try { sock?.ws?.close(); } catch {}
        const authPath = path.join(usersPath, number);
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
        const db = getMultiDB(); delete db[number]; saveDB("multi_sessions.json", db);
        if (mongoose.connection.readyState === 1) { try { await SessionModel.deleteOne({ userId: number }); } catch {} }
        addLog(`[DELETE] ${number}`);
        return res.json({ success: true, message: `Bot ${number} deleted` });
    } catch (e) { return res.json({ success: false, error: e.message }); }
});

app.get("/", (req, res) => res.redirect("/deploy"));
app.get("/logs", (req, res) => res.json({ logs: logs.slice(-100) }));
app.get("/health", (req, res) => res.json({ status: "ok", bots: activeBots.size, uptime: process.uptime() }));

setInterval(checkExpiredSessions, 60000);
loadCommands();
startAll();

app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n=== ETIAS DEPLOYMENT ONLINE :${PORT} ===\n`);
});
