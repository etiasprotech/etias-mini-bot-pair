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
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

const DB_FILE = path.join(DATA_DIR, "deployed.json");
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, "[]", "utf8");
}

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(ROOT));
app.use("/media", express.static(MEDIA_DIR));

function getDB() {
    try {
        const data = fs.readFileSync(DB_FILE, "utf8");
        const db = JSON.parse(data);
        return Array.isArray(db) ? db : [];
    } catch (error) {
        console.error("[DB READ ERROR]", error.message);
        return [];
    }
}

function saveDB(db) {
    try {
        const temp = DB_FILE + ".tmp";
        fs.writeFileSync(temp, JSON.stringify(db, null, 2), "utf8");
        fs.renameSync(temp, DB_FILE);
    } catch (error) {
        console.error("[DB WRITE ERROR]", error.message);
    }
}

function sendSafe(res, file) {
    const candidates = [file, path.join("public", file), "main.html", "index.html"];
    for (const candidate of candidates) {
        const fullPath = path.join(ROOT, candidate);
        if (fs.existsSync(fullPath)) {
            return res.sendFile(fullPath);
        }
    }
    return res.status(404).send(`Missing ${file} - put it in ${ROOT}`);
}

app.get("/", (req, res) => { sendSafe(res, "index.html"); });
app.get("/pair", (req, res) => { sendSafe(res, "pair.html"); });
app.get("/qr", (req, res) => { sendSafe(res, "qr.html"); });
app.get("/deploy", (req, res) => { sendSafe(res, "deploy.html"); });
app.get("/owner", (req, res) => { sendSafe(res, "deploy.html"); });

app.get("/bot-image", (req, res) => {
    const files = ["bot.jpg", "bot.jpeg", "bot.png", "logo.jpg", "bot_image.jpg", "bot_image.png"];
    for (const filename of files) {
        const filePath = path.join(MEDIA_DIR, filename);
        if (fs.existsSync(filePath)) {
            return res.sendFile(filePath);
        }
    }
    const fallback = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
    res.set("Content-Type", "image/png");
    return res.send(fallback);
});

app.get("/total-users", (req, res) => {
    const db = getDB();
    const now = Date.now();
    const active = db.filter(item => {
        const expiry = new Date(item.expiry).getTime();
        return Number.isFinite(expiry) && expiry > now && item.active !== false;
    }).length;
    const expired = db.filter(item => {
        const expiry = new Date(item.expiry).getTime();
        return Number.isFinite(expiry) && expiry <= now;
    }).length;
    res.json({ total: db.length, realTotal: db.length, online: active, count: db.length, real: db.length, active, expired, updatedAt: new Date().toISOString() });
});

app.get("/deploy-stats", (req, res) => {
    const db = getDB();
    const now = Date.now();
    const active = db.filter(item => {
        const expiry = new Date(item.expiry).getTime();
        return Number.isFinite(expiry) && expiry > now && item.active !== false;
    }).length;
    const expired = db.filter(item => {
        const expiry = new Date(item.expiry).getTime();
        return Number.isFinite(expiry) && expiry <= now;
    }).length;
    const recent = db.filter(item => {
        const deployed = new Date(item.deployedAt).getTime();
        return Number.isFinite(deployed) && now - deployed < 24 * 60 * 60 * 1000;
    }).length;
    res.json({ total: db.length, active, expired, recent, online: active });
});

app.get("/deployed-list", (req, res) => {
    const db = getDB();
    const now = Date.now();
    const list = db.map(item => {
        const expiryMs = new Date(item.expiry).getTime();
        const daysLeft = Number.isFinite(expiryMs) ? Math.max(0, Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000))) : 0;
        const expired = !Number.isFinite(expiryMs) || expiryMs <= now;
        return {
            number: item.number,
            duration: item.duration,
            expiry: item.expiry,
            deployedAt: item.deployedAt,
            daysLeft,
            isExpired: expired,
            active: !expired && item.active !== false
        };
    });
    list.sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));
    res.json(list);
});

app.post("/deploy", (req, res) => {
    try {
        const { session, userNumber, duration } = req.body;
        if (!session || typeof session !== "string" || !session.startsWith("ETIAS-MINI-BOT~")) {
            return res.json({ success: false, message: "Invalid SESSION_ID" });
        }
        if (!userNumber) {
            return res.json({ success: false, message: "User number required" });
        }
        const number = String(userNumber).replace(/\D/g, "");
        if (number.length < 10) {
            return res.json({ success: false, message: "Invalid WhatsApp number" });
        }
        const days = Number.parseInt(duration, 10) || 30;
        if (days <= 0) {
            return res.json({ success: false, message: "Invalid duration" });
        }
        const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        const db = getDB();
        const filtered = db.filter(item => item.number !== number);
        filtered.push({
            number,
            session: session.substring(0, 60) + "...",
            fullSession: session,
            duration: days,
            expiry: expiry.toISOString(),
            deployedAt: new Date().toISOString(),
            active: true
        });
        saveDB(filtered);
        console.log(`[DEPLOY] ${number} | ${days} days`);
        res.json({ success: true, status: true, expiry: expiry.toISOString(), message: `Deployed ${number} for ${days} days` });
    } catch (error) {
        console.error("[DEPLOY ERROR]", error);
        res.status(500).json({ success: false, message: "Deployment failed" });
    }
});

const activeSockets = new Map();
const pairingStates = new Map();
const qrSockets = new Map();

function cleanNumber(value) {
    return String(value || "").replace(/\D/g, "");
}
function makePairId(number) {
    return "ETIAS_" + number + "_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
}
function getDisconnectCode(error) {
    if (!error) return undefined;
    return error?.output?.statusCode || error?.data?.attrs?.code || error?.statusCode || undefined;
}

function createSessionBundle(authFolder) {
    if (!fs.existsSync(authFolder)) throw new Error("Authentication folder does not exist");
    const files = {};
    function readDirectory(directory, relative = "") {
        if (!fs.existsSync(directory)) return;
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            const relativePath = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                readDirectory(fullPath, relativePath);
            } else {
                files[relativePath.replace(/\\/g, "/")] = fs.readFileSync(fullPath).toString("base64");
            }
        }
    }
    readDirectory(authFolder);
    if (!files["creds.json"]) throw new Error("creds.json was not generated");
    const bundle = { format: "ETIAS-MINI-BOT", version: 2, createdAt: new Date().toISOString(), files };
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
    return "ETIAS-MINI-BOT~" + compressed.toString("base64");
}

function savePairedSession(number, session) {
    const db = getDB();
    const filtered = db.filter(item => item.number !== number);
    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    filtered.push({
        number,
        session: session.substring(0, 60) + "...",
        fullSession: session,
        duration: 30,
        expiry: expiry.toISOString(),
        deployedAt: new Date().toISOString(),
        active: true
    });
    saveDB(filtered);
    return expiry;
}

async function sendSessionToWhatsApp(sock, number, session, id) {
    if (!sock?.user?.id) {
        console.log(`[DM] No WhatsApp user available for ${number}`);
        return false;
    }
    const jid = sock.user.id;
    if (session.length <= 60000) {
        await sock.sendMessage(jid, { text: `ETIAS-MINI-BOT SESSION\n\nSESSION_ID:\n\n${session}\n\nPAIRING ID: ${id}` });
        console.log(`[DM] Session sent to ${number}`);
        return true;
    }
    const chunkSize = 50000;
    const total = Math.ceil(session.length / chunkSize);
    for (let i = 0; i < total; i++) {
        const chunk = session.substring(i * chunkSize, (i + 1) * chunkSize);
        await sock.sendMessage(jid, { text: `ETIAS-MINI-BOT SESSION CHUNK ${i + 1}/${total}\n\n${chunk}` });
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    console.log(`[DM] Session sent in ${total} chunks to ${number}`);
    return true;
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
        generateHighQualityLinkPreview: false
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
        try { await saveCreds(); } catch (error) { console.error("[CREDS ERROR]", error.message); }
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
                await new Promise(resolve => setTimeout(resolve, 1500));
                const code = await sock.requestPairingCode(number);
                const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                const current = pairingStates.get(id);
                if (current) {
                    current.code = formatted;
                    current.status = "waiting_for_pairing";
                    current.rateLimited = false;
                }
                console.log("\n============================================");
                console.log(`PAIRING CODE: ${formatted}`);
                console.log(`PHONE: ${number}`);
                console.log(`SESSION ID: ${id}`);
                console.log("============================================\n");
            } catch (error) {
                pairingCodeRequested = false;
                const message = error?.message || String(error);
                const rateLimited = message.toLowerCase().includes("429") || message.toLowerCase().includes("rate-overlimit");
                const current = pairingStates.get(id);
                if (current) {
                    current.status = rateLimited ? "rate_limited" : "pairing_code_error";
                    current.error = rateLimited ? "WhatsApp rate limit reached. Wait before requesting another code." : message;
                    current.rateLimited = rateLimited;
                }
                console.error(`[PAIR CODE ERROR] ${number}: ${message}`);
                if (rateLimited) {
                    console.log(`[WA] Pairing rate limited for ${number}. Stopping this attempt.`);
                    try { sock.end(undefined); } catch {}
                    activeSockets.delete(id);
                }
            }
        }

        if (connection === "open") {
            console.log(`\n[CONNECTED] ${number}`);
            console.log(`[NEW LOGIN] ${isNewLogin ? "YES" : "NO"}`);
            const current = pairingStates.get(id);
            if (current) {
                current.connected = true;
                current.status = "connected";
                current.whatsappId = sock.user?.id || null;
            }
            try { await saveCreds(); } catch {}
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (!sessionGenerated) {
                try {
                    const session = createSessionBundle(authFolder);
                    sessionGenerated = true;
                    const currentState = pairingStates.get(id);
                    if (currentState) {
                        currentState.status = "session_ready";
                        currentState.session = session;
                        currentState.connected = true;
                        currentState.sessionLength = session.length;
                    }
                    savePairedSession(number, session);
                    console.log(`[SESSION] Complete session generated`);
                    console.log(`[SESSION] Length: ${session.length}`);
                    try { await sendSessionToWhatsApp(sock, number, session, id); }
                    catch (dmError) {
                        console.error("[DM SESSION ERROR]", dmError.message);
                        const currentState = pairingStates.get(id);
                        if (currentState) currentState.dmError = dmError.message;
                    }
                } catch (error) {
                    console.error(`[SESSION ERROR] ${number}`, error.message);
                    const currentState = pairingStates.get(id);
                    if (currentState) {
                        currentState.status = "session_error";
                        currentState.error = error.message;
                    }
                }
            }
            return;
        }

        if (connection === "close") {
            const code = getDisconnectCode(lastDisconnect?.error);
            console.log(`[WA CLOSED] ${number} | CODE=${code}`);
            const current = pairingStates.get(id);
            if (current) {
                current.connected = false;
                current.disconnectCode = code;
            }
            if (code === DisconnectReason.restartRequired) {
                console.log(`[WA] 515 restart required: ${number}`);
                const currentState = pairingStates.get(id);
                if (currentState) {
                    currentState.status = "restarting";
                    currentState.restartCount = (currentState.restartCount || 0) + 1;
                }
                activeSockets.delete(id);
                await new Promise(resolve => setTimeout(resolve, 1500));
                try { await startPairing(number, id, authFolder); }
                catch (error) {
                    console.error(`[515 RESTART ERROR] ${number}`, error.message);
                    const stateNow = pairingStates.get(id);
                    if (stateNow) { stateNow.status = "restart_failed"; stateNow.error = error.message; }
                }
                return;
            }
            if (code === DisconnectReason.loggedOut) {
                console.log(`[WA] Logged out: ${number}`);
                if (current) current.status = "logged_out";
                activeSockets.delete(id);
                return;
            }
            if (code === DisconnectReason.badSession) {
                console.log(`[WA] Bad session: ${number}`);
                if (current) current.status = "bad_session";
                activeSockets.delete(id);
                return;
            }
            if (code === 429) {
                console.log(`[WA] Rate limited: ${number}`);
                if (current) current.status = "rate_limited";
                activeSockets.delete(id);
                return;
            }
            if (current) current.status = "disconnected";
            activeSockets.delete(id);
        }
    });
    return sock;
}

app.get("/code", async (req, res) => {
    const number = cleanNumber(req.query.number);
    if (!number || number.length < 10 || number.length > 15) {
        return res.status(400).json({ success: false, error: "Enter a valid international number, example: 2637XXXXXXX" });
    }
    for (const [existingId, info] of pairingStates.entries()) {
        if (info.number === number) {
            if (info.status === "rate_limited") {
                return res.status(429).json({ success: false, error: "WhatsApp has temporarily rate-limited pairing for this number. Wait before trying again.", id: existingId, status: info.status });
            }
            if (["connecting", "waiting_for_pairing", "restarting", "authenticated"].includes(info.status)) {
                return res.json({ success: true, existing: true, id: existingId, sessionId: existingId, status: info.status, code: info.code || null, connected: info.connected || false });
            }
        }
    }
    const id = makePairId(number);
    const authFolder = path.join(AUTH_DIR, id);
    try {
        fs.mkdirSync(authFolder, { recursive: true });
        console.log(`\n[PAIR START] ${number}`);
        console.log(`[PAIR ID] ${id}`);
        await startPairing(number, id, authFolder);
        const start = Date.now();
        while (Date.now() - start < 30000) {
            const info = pairingStates.get(id);
            if (info?.code) {
                return res.json({ success: true, status: "waiting_for_pairing", code: info.code, sessionId: id, id, number });
            }
            if (info?.status === "rate_limited") {
                return res.status(429).json({ success: false, status: "rate_limited", error: info.error, id, sessionId: id });
            }
            if (info?.status === "pairing_code_error") {
                return res.status(500).json({ success: false, error: info.error || "Pairing code failed", id });
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return res.status(504).json({ success: false, error: "WhatsApp did not provide a pairing code in time", id, sessionId: id });
    } catch (error) {
        console.error(`[PAIR ERROR] ${number}`, error);
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
        pairingStates.delete(id);
        return res.status(500).json({ success: false, error: error?.message || "Failed to create pairing session" });
    }
});

app.get("/status/:id", (req, res) => {
    const id = req.params.id;
    const state = pairingStates.get(id);
    if (!state) return res.json({ success: false, status: "not_found", id });
    return res.json({ success: true, id, number: state.number, status: state.status, connected: state.connected || false, code: state.code || null, hasSession: !!state.session, sessionLength: state.sessionLength || 0, restartCount: state.restartCount || 0, error: state.error || null });
});

app.get("/check/:id", (req, res) => {
    const id = req.params.id;
    const state = pairingStates.get(id);
    if (state) {
        return res.json({ connected: state.connected || false, status: state.status, code: state.code || null, session: state.session || null, number: state.number, id });
    }
    const authFolder = path.join(AUTH_DIR, id);
    if (!fs.existsSync(authFolder)) return res.json({ connected: false, status: "not_found", id });
    try {
        const session = createSessionBundle(authFolder);
        return res.json({ connected: true, status: "session_ready", session, id });
    } catch (error) {
        return res.json({ connected: false, status: "waiting", id, error: error.message });
    }
});

app.get("/session/:id", (req, res) => {
    const id = req.params.id;
    const state = pairingStates.get(id);
    if (state?.session) return res.json({ success: true, connected: true, session: state.session, id });
    const authFolder = path.join(AUTH_DIR, id);
    try {
        const session = createSessionBundle(authFolder);
        return res.json({ success: true, connected: true, session, id });
    } catch (error) {
        return res.status(404).json({ success: false, error: "Session not ready yet" });
    }
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
                    try {
                        const image = await qrcode.toDataURL(update.qr);
                        finished = true; clearTimeout(timer); resolve(image);
                    } catch (error) { finished = true; clearTimeout(timer); reject(error); }
                }
                if (update.connection === "close" && !finished) {
                    finished = true; clearTimeout(timer); reject(new Error("WhatsApp connection closed"));
                }
            });
        });
        return res.json({ success: true, id, qr: qrData });
    } catch (error) {
        console.error("[QR ERROR]", error.message);
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
        return res.status(500).json({ success: false, error: "QR failed - refresh and try again" });
    }
});

setInterval(() => {
    for (const [id, sock] of qrSockets.entries()) {
        try { sock.end(undefined); } catch {}
        qrSockets.delete(id);
        try { fs.rmSync(path.join(AUTH_DIR, id), { recursive: true, force: true }); } catch {}
    }
}, 2 * 60 * 1000);

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
}, 60 * 1000);

app.get("/ping", (req, res) => { res.send("ETIAS-PAIR alive " + new Date().toISOString()); });
app.get("/health", (req, res) => {
    res.json({ status: "alive", total: getDB().length, activeSockets: activeSockets.size, pairingSessions: pairingStates.size, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("\n============================================");
    console.log("       ETIAS PAIR SERVER ONLINE");
    console.log("============================================");
    console.log(`PORT: ${PORT}`);
    console.log(`OWNER: ${OWNER_NUMBER}`);
    console.log("PAIRING: ENABLED");
    console.log("MULTI-SESSION: ENABLED");
    console.log("MULTI-FILE AUTH: ENABLED");
    console.log("515 RESTART: ENABLED");
    console.log("COMPLETE SESSION: ENABLED");
    console.log("============================================\n");
});

process.on("unhandledRejection", error => { console.error("[UNHANDLED REJECTION]", error); });
process.on("uncaughtException", error => { console.error("[UNCAUGHT EXCEPTION]", error); });
