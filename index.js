require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const crypto = require("crypto");
const zlib = require("zlib");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = "263778810589";
const ROOT = __dirname;
const AUTH_DIR = path.join(ROOT, "auth");
const DATA_DIR = path.join(ROOT, "data");
const MEDIA_DIR = path.join(ROOT, "media");

for (const dir of [AUTH_DIR, DATA_DIR, MEDIA_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const DB_FILE = path.join(DATA_DIR, "deployed.json");
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(ROOT));
app.use("/media", express.static(MEDIA_DIR));

function getDB() {
    try {
        const data = fs.readFileSync(DB_FILE, "utf8");
        const db = JSON.parse(data);
        return Array.isArray(db) ? db : [];
    } catch (e) {
        console.error("[DB READ ERROR]", e.message);
        return [];
    }
}
function saveDB(db) {
    try {
        const temp = DB_FILE + ".tmp";
        fs.writeFileSync(temp, JSON.stringify(db, null, 2), "utf8");
        fs.renameSync(temp, DB_FILE);
    } catch (e) {
        console.error("[DB WRITE ERROR]", e.message);
    }
}
function sendSafe(res, file) {
    const candidates = [file, path.join("public", file), "main.html", "index.html"];
    for (const c of candidates) {
        const full = path.join(ROOT, c);
        if (fs.existsSync(full)) return res.sendFile(full);
    }
    return res.status(404).send(`Missing ${file}`);
}

app.get("/", (req, res) => sendSafe(res, "index.html"));
app.get("/pair", (req, res) => sendSafe(res, "pair.html"));
app.get("/qr", (req, res) => sendSafe(res, "qr.html"));
app.get("/deploy", (req, res) => sendSafe(res, "deploy.html"));
app.get("/owner", (req, res) => sendSafe(res, "deploy.html"));

app.get("/bot-image", (req, res) => {
    const files = ["bot.jpg", "bot.jpeg", "bot.png", "logo.jpg", "bot_image.jpg", "bot_image.png"];
    for (const f of files) {
        const fp = path.join(MEDIA_DIR, f);
        if (fs.existsSync(fp)) return res.sendFile(fp);
    }
    const fallback = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
    res.set("Content-Type", "image/png");
    return res.send(fallback);
});

app.get("/total-users", (req, res) => {
    const db = getDB(); const now = Date.now();
    const active = db.filter(i => { const e = new Date(i.expiry).getTime(); return Number.isFinite(e) && e > now && i.active !== false; }).length;
    const expired = db.filter(i => { const e = new Date(i.expiry).getTime(); return Number.isFinite(e) && e <= now; }).length;
    res.json({ total: db.length, realTotal: db.length, online: active, count: db.length, real: db.length, active, expired, updatedAt: new Date().toISOString() });
});
app.get("/deploy-stats", (req, res) => {
    const db = getDB(); const now = Date.now();
    const active = db.filter(i => { const e = new Date(i.expiry).getTime(); return Number.isFinite(e) && e > now && i.active !== false; }).length;
    const expired = db.filter(i => { const e = new Date(i.expiry).getTime(); return Number.isFinite(e) && e <= now; }).length;
    const recent = db.filter(i => { const d = new Date(i.deployedAt).getTime(); return Number.isFinite(d) && now - d < 86400000; }).length;
    res.json({ total: db.length, active, expired, recent, online: active });
});
app.get("/deployed-list", (req, res) => {
    const db = getDB(); const now = Date.now();
    const list = db.map(item => {
        const expiryMs = new Date(item.expiry).getTime();
        const daysLeft = Number.isFinite(expiryMs) ? Math.max(0, Math.ceil((expiryMs - now) / 86400000)) : 0;
        const expired = !Number.isFinite(expiryMs) || expiryMs <= now;
        return { number: item.number, duration: item.duration, expiry: item.expiry, deployedAt: item.deployedAt, daysLeft, isExpired: expired, active: !expired && item.active !== false };
    });
    list.sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));
    res.json(list);
});

app.post("/deploy", (req, res) => {
    try {
        const { session, userNumber, duration } = req.body;
        if (!session || typeof session !== "string" || !session.startsWith("ETIAS-MINI-BOT~")) return res.json({ success: false, message: "Invalid SESSION_ID" });
        if (!userNumber) return res.json({ success: false, message: "User number required" });
        const number = String(userNumber).replace(/\D/g, "");
        if (number.length < 10) return res.json({ success: false, message: "Invalid WhatsApp number" });
        const days = parseInt(duration, 10) || 30;
        if (days <= 0) return res.json({ success: false, message: "Invalid duration" });
        const expiry = new Date(Date.now() + days * 86400000);
        const db = getDB();
        const filtered = db.filter(item => item.number !== number);
        filtered.push({ number, session: session.substring(0, 60) + "...", fullSession: session, duration: days, expiry: expiry.toISOString(), deployedAt: new Date().toISOString(), active: true });
        saveDB(filtered);
        console.log(`[DEPLOY] ${number} | ${days} days`);
        res.json({ success: true, status: true, expiry: expiry.toISOString(), message: `Deployed ${number} for ${days} days` });
    } catch (e) {
        console.error("[DEPLOY ERROR]", e);
        res.status(500).json({ success: false, message: "Deployment failed" });
    }
});

const activeSockets = new Map();
const pairingStates = new Map();
const qrSockets = new Map();

function cleanNumber(v) { return String(v || "").replace(/\D/g, ""); }
function makePairId(number) { return "ETIAS_" + number + "_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"); }
function getDisconnectCode(error) {
    if (!error) return undefined;
    return error?.output?.statusCode || error?.data?.attrs?.code || error?.statusCode || undefined;
}

function createSessionBundle(authFolder) {
    if (!fs.existsSync(authFolder)) throw new Error("Authentication folder does not exist");
    const files = {};
    function readDir(dir, rel = "") {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const rPath = path.join(rel, entry.name);
            if (entry.isDirectory()) readDir(full, rPath);
            else files[rPath.replace(/\\/g, "/")] = fs.readFileSync(full).toString("base64");
        }
    }
    readDir(authFolder);
    if (!files["creds.json"]) throw new Error("creds.json was not generated");
    const bundle = { format: "ETIAS-MINI-BOT", version: 2, createdAt: new Date().toISOString(), files };
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
    return "ETIAS-MINI-BOT~" + compressed.toString("base64");
}

function savePairedSession(number, session) {
    const db = getDB();
    const filtered = db.filter(i => i.number !== number);
    const expiry = new Date(Date.now() + 30 * 86400000);
    filtered.push({ number, session: session.substring(0, 60) + "...", fullSession: session, duration: 30, expiry: expiry.toISOString(), deployedAt: new Date().toISOString(), active: true });
    saveDB(filtered);
    return expiry;
}

// ===== FIXED DM FUNCTION - WILL SEND SESSION_ID =====
async function sendSessionToWhatsApp(sock, number, session, id) {
    try {
        await new Promise(r => setTimeout(r, 2500)); // Wait for user.id to be ready

        let jid = sock.user?.id;
        if (!jid) {
            console.log(`[DM] user.id missing, using fallback ${number}@s.whatsapp.net`);
            jid = `${number}@s.whatsapp.net`;
        }
        // Normalize LID to PN if needed
        if (jid.includes(":") ) {
            // LID format, try to get lid mapping
            console.log(`[DM] LID detected: ${jid}, still trying to send`);
        }

        console.log(`[DM] Sending SESSION_ID to ${jid} | len=${session.length}`);

        // First message small
        await sock.sendMessage(jid, {
            text: `*ETIAS-MINI-BOT ✅ CONNECTED*\n\n*Number:* ${number}\n*Pair ID:* ${id}\n\nYour bot is now active!`
        });
        await new Promise(r => setTimeout(r, 1000));

        if (session.length <= 60000) {
            await sock.sendMessage(jid, {
                text: `*YOUR SESSION_ID - KEEP SAFE:*\n\n${session}\n\n*Pair ID:* ${id}\n\nUse this to deploy.`
            });
            console.log(`[DM] ✅ Session sent to ${number} to ${jid}`);
            return true;
        }

        // Chunked
        const chunkSize = 55000;
        const total = Math.ceil(session.length / chunkSize);
        for (let i = 0; i < total; i++) {
            const chunk = session.substring(i * chunkSize, (i + 1) * chunkSize);
            await sock.sendMessage(jid, { text: `*SESSION CHUNK ${i+1}/${total}*\n\n${chunk}` });
            await new Promise(r => setTimeout(r, 800));
        }
        await sock.sendMessage(jid, { text: `*✅ All ${total} chunks sent*\nJoin them in order.\nPair ID: ${id}` });
        console.log(`[DM] ✅ Session sent in ${total} chunks to ${number}`);
        return true;

    } catch (e) {
        console.error(`[DM ERROR] Primary DM failed for ${number}:`, e.message);
        try {
            // Fallback: send to own number JID
            const fallback = `${number}@s.whatsapp.net`;
            console.log(`[DM] Trying fallback ${fallback}`);
            await sock.sendMessage(fallback, { text: `*ETIAS-MINI-BOT SESSION*\n\n${session.substring(0, 60000)}\n\nPair ID: ${id}` });
            console.log(`[DM] ✅ Fallback success`);
            return true;
        } catch (e2) {
            console.error(`[DM FALLBACK ERROR] ${e2.message}`);
            return false;
        }
    }
}

async function startPairing(number, id, authFolder) {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    console.log(`[AUTH] ${number} registered = ${state.creds.registered}`);
    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Chrome"),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });
    activeSockets.set(id, sock);
    let pairingCodeRequested = state.creds.registered;
    let sessionGenerated = false;
    pairingStates.set(id, {
        id, number,
        status: state.creds.registered ? "authenticated" : "connecting",
        code: null, session: null, connected: false,
        restartCount: pairingStates.get(id)?.restartCount || 0,
        createdAt: pairingStates.get(id)?.createdAt || new Date().toISOString()
    });

    sock.ev.on("creds.update", async () => {
        try { await saveCreds(); } catch (e) { console.error("[CREDS ERROR]", e.message); }
    });

    sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        const info = pairingStates.get(id);

        if (connection === "connecting") {
            console.log(`[WA] ${number} connecting...`);
            if (info) info.status = state.creds.registered ? "authenticated" : "connecting";
        }
        if (qr && info) info.hasQR = true;

        if (!state.creds.registered && !pairingCodeRequested && (connection === "connecting" || qr)) {
            pairingCodeRequested = true;
            try {
                await new Promise(r => setTimeout(r, 2500));
                const code = await sock.requestPairingCode(number);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                const current = pairingStates.get(id);
                if (current) { current.code = formatted; current.status = "waiting_for_pairing"; current.rateLimited = false; }
                console.log("\n============================================");
                console.log(`PAIRING CODE: ${formatted} for ${number} | ID ${id}`);
                console.log("============================================\n");
            } catch (error) {
                pairingCodeRequested = false;
                const msg = error?.message || String(error);
                const rateLimited = msg.toLowerCase().includes("429") || msg.toLowerCase().includes("rate-overlimit");
                const current = pairingStates.get(id);
                if (current) { current.status = rateLimited ? "rate_limited" : "pairing_code_error"; current.error = rateLimited ? "Rate limited" : msg; current.rateLimited = rateLimited; }
                console.error(`[PAIR CODE ERROR] ${number}: ${msg}`);
                if (rateLimited) { try { sock.end(undefined); } catch {} activeSockets.delete(id); }
            }
        }

        if (connection === "open") {
            console.log(`\n[CONNECTED] ${number} | newLogin=${isNewLogin}`);
            const current = pairingStates.get(id);
            if (current) { current.connected = true; current.status = "connected"; current.whatsappId = sock.user?.id || null; }

            // CRITICAL: Save creds before bundle
            try { await saveCreds(); } catch {}
            await new Promise(r => setTimeout(r, 3000));

            if (!sessionGenerated) {
                try {
                    // Force write creds.json if missing
                    if (!fs.existsSync(path.join(authFolder, "creds.json"))) {
                        fs.writeFileSync(path.join(authFolder, "creds.json"), JSON.stringify(state.creds, null, 2));
                    }
                    const session = createSessionBundle(authFolder);
                    sessionGenerated = true;
                    const st = pairingStates.get(id);
                    if (st) { st.status = "session_ready"; st.session = session; st.connected = true; st.sessionLength = session.length; }
                    savePairedSession(number, session);
                    console.log(`[SESSION] Generated len=${session.length} for ${number}`);

                    // SEND DM - THIS IS YOUR SESSION_ID
                    const dmOk = await sendSessionToWhatsApp(sock, number, session, id);
                    const st2 = pairingStates.get(id);
                    if (st2) st2.dmSent = dmOk;

                } catch (error) {
                    console.error(`[SESSION ERROR] ${number}`, error.message);
                    const st = pairingStates.get(id);
                    if (st) { st.status = "session_error"; st.error = error.message; }
                }
            }
            return;
        }

        if (connection === "close") {
            const code = getDisconnectCode(lastDisconnect?.error);
            console.log(`[WA CLOSED] ${number} | CODE=${code}`);
            const current = pairingStates.get(id);
            if (current) { current.connected = false; current.disconnectCode = code; }

            if (code === DisconnectReason.restartRequired) {
                console.log(`[WA] 515 restart required: ${number}`);
                const cs = pairingStates.get(id);
                if (cs) { cs.status = "restarting"; cs.restartCount = (cs.restartCount || 0) + 1; }
                activeSockets.delete(id);
                await new Promise(r => setTimeout(r, 1500));
                try { await startPairing(number, id, authFolder); } catch (e) { console.error(`[515 ERROR] ${e.message}`); }
                return;
            }
            if (code === DisconnectReason.loggedOut) { if (current) current.status = "logged_out"; activeSockets.delete(id); return; }
            if (code === DisconnectReason.badSession) { if (current) current.status = "bad_session"; activeSockets.delete(id); return; }
            if (code === 429) { if (current) current.status = "rate_limited"; activeSockets.delete(id); return; }
            if (current) current.status = "disconnected";
            activeSockets.delete(id);
        }
    });
    return sock;
}

app.get("/code", async (req, res) => {
    const number = cleanNumber(req.query.number);
    if (!number || number.length < 10 || number.length > 15) return res.status(400).json({ success: false, error: "Enter valid number ex: 2637XXXXXXX" });
    for (const [existingId, info] of pairingStates.entries()) {
        if (info.number === number) {
            if (info.status === "rate_limited") return res.status(429).json({ success: false, error: "Rate limited, wait", id: existingId, status: info.status });
            if (["connecting", "waiting_for_pairing", "restarting", "authenticated"].includes(info.status)) {
                return res.json({ success: true, existing: true, id: existingId, sessionId: existingId, status: info.status, code: info.code || null, connected: info.connected || false });
            }
        }
    }
    const id = makePairId(number);
    const authFolder = path.join(AUTH_DIR, id);
    try {
        fs.mkdirSync(authFolder, { recursive: true });
        console.log(`\n[PAIR START] ${number} | ${id}`);
        await startPairing(number, id, authFolder);
        const start = Date.now();
        while (Date.now() - start < 30000) {
            const info = pairingStates.get(id);
            if (info?.code) return res.json({ success: true, status: "waiting_for_pairing", code: info.code, sessionId: id, id, number });
            if (info?.status === "rate_limited") return res.status(429).json({ success: false, status: "rate_limited", error: info.error, id, sessionId: id });
            if (info?.status === "pairing_code_error") return res.status(500).json({ success: false, error: info.error || "Pairing failed", id });
            await new Promise(r => setTimeout(r, 250));
        }
        return res.status(504).json({ success: false, error: "No code from WhatsApp in time", id, sessionId: id });
    } catch (e) {
        console.error(`[PAIR ERROR] ${number}`, e);
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
        pairingStates.delete(id);
        return res.status(500).json({ success: false, error: e?.message || "Failed" });
    }
});

app.get("/status/:id", (req, res) => {
    const id = req.params.id; const st = pairingStates.get(id);
    if (!st) return res.json({ success: false, status: "not_found", id });
    return res.json({ success: true, id, number: st.number, status: st.status, connected: st.connected || false, code: st.code || null, hasSession: !!st.session, sessionLength: st.sessionLength || 0, dmSent: st.dmSent || false, restartCount: st.restartCount || 0, error: st.error || null });
});

app.get("/check/:id", (req, res) => {
    const id = req.params.id; const st = pairingStates.get(id);
    if (st) return res.json({ connected: st.connected || false, status: st.status, code: st.code || null, session: st.session || null, number: st.number, id, dmSent: st.dmSent || false });
    const authFolder = path.join(AUTH_DIR, id);
    if (!fs.existsSync(authFolder)) return res.json({ connected: false, status: "not_found", id });
    try { const session = createSessionBundle(authFolder); return res.json({ connected: true, status: "session_ready", session, id }); }
    catch (e) { return res.json({ connected: false, status: "waiting", id, error: e.message }); }
});

app.get("/session/:id", (req, res) => {
    const id = req.params.id; const st = pairingStates.get(id);
    if (st?.session) return res.json({ success: true, connected: true, session: st.session, id });
    const authFolder = path.join(AUTH_DIR, id);
    try { const session = createSessionBundle(authFolder); return res.json({ success: true, connected: true, session, id }); }
    catch (e) { return res.status(404).json({ success: false, error: "Session not ready yet" }); }
});

app.get("/qr-image", async (req, res) => {
    const id = "QR_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
    const authFolder = path.join(AUTH_DIR, id);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS("Chrome"),
            printQRInTerminal: false
        });
        qrSockets.set(id, sock);
        sock.ev.on("creds.update", saveCreds);
        const qrData = await new Promise((resolve, reject) => {
            let finished = false;
            const timer = setTimeout(() => { if (!finished) { finished = true; reject(new Error("QR timeout")); } }, 60000);
            sock.ev.on("connection.update", async update => {
                if (update.qr && !finished) {
                    try { const image = await qrcode.toDataURL(update.qr); finished = true; clearTimeout(timer); resolve(image); }
                    catch (e) { finished = true; clearTimeout(timer); reject(e); }
                }
                if (update.connection === "close" && !finished) { finished = true; clearTimeout(timer); reject(new Error("Closed")); }
            });
        });
        return res.json({ success: true, id, qr: qrData });
    } catch (e) {
        console.error("[QR ERROR]", e.message);
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
        return res.status(500).json({ success: false, error: "QR failed" });
    }
});

setInterval(() => {
    for (const [id, sock] of qrSockets.entries()) {
        try { sock.end(undefined); } catch {}
        qrSockets.delete(id);
        try { fs.rmSync(path.join(AUTH_DIR, id), { recursive: true, force: true }); } catch {}
    }
}, 120000);

setInterval(() => {
    const now = Date.now();
    for (const [id, state] of pairingStates.entries()) {
        const created = new Date(state.createdAt).getTime();
        if (!Number.isFinite(created)) continue;
        const age = now - created;
        if (state.connected || state.status === "session_ready") continue;
        if (age > 10 * 60 * 1000) {
            console.log(`[CLEANUP] ${id}`);
            const sock = activeSockets.get(id);
            try { sock?.end(undefined); } catch {}
            activeSockets.delete(id);
            try { fs.rmSync(path.join(AUTH_DIR, id), { recursive: true, force: true }); } catch {}
            pairingStates.delete(id);
        }
    }
}, 60000);

app.get("/ping", (req, res) => res.send("ETIAS-PAIR alive " + new Date().toISOString()));
app.get("/health", (req, res) => res.json({ status: "alive", total: getDB().length, activeSockets: activeSockets.size, pairingSessions: pairingStates.size, uptime: process.uptime(), timestamp: new Date().toISOString() }));

app.listen(PORT, "0.0.0.0", () => {
    console.log("\n============================================");
    console.log("       ETIAS PAIR SERVER ONLINE - FIXED DM");
    console.log("============================================");
    console.log(`PORT: ${PORT} | OWNER: ${OWNER_NUMBER}`);
    console.log("============================================\n");
});
process.on("unhandledRejection", e => console.error("[UNHANDLED]", e));
process.on("uncaughtException", e => console.error("[UNCAUGHT]", e));
