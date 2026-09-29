require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

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

/* ============================================================
   EXPRESS
============================================================ */

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({
    extended: true,
    limit: "50mb"
}));

app.use(express.static(ROOT));
app.use("/media", express.static(MEDIA_DIR));

/* ============================================================
   DATABASE
============================================================ */

function getDB() {
    try {
        const data = JSON.parse(
            fs.readFileSync(DB_FILE, "utf8")
        );

        return Array.isArray(data) ? data : [];

    } catch {
        return [];
    }
}

function saveDB(db) {
    try {

        const tempFile = DB_FILE + ".tmp";

        fs.writeFileSync(
            tempFile,
            JSON.stringify(db, null, 2),
            "utf8"
        );

        fs.renameSync(tempFile, DB_FILE);

    } catch (error) {

        console.error(
            "[DB ERROR]",
            error.message
        );
    }
}

/* ============================================================
   PAGE ROUTES
   Existing UI is preserved
============================================================ */

function sendSafe(res, file) {

    const candidates = [
        file,
        path.join("public", file),
        "main.html",
        "index.html"
    ];

    for (const candidate of candidates) {

        const fullPath = path.join(
            ROOT,
            candidate
        );

        if (fs.existsSync(fullPath)) {
            return res.sendFile(fullPath);
        }
    }

    return res
        .status(404)
        .send(`Missing ${file}`);
}

app.get("/", (req, res) => {
    sendSafe(res, "index.html");
});

app.get("/pair", (req, res) => {
    sendSafe(res, "pair.html");
});

app.get("/qr", (req, res) => {
    sendSafe(res, "qr.html");
});

app.get("/deploy", (req, res) => {
    sendSafe(res, "deploy.html");
});

app.get("/owner", (req, res) => {
    sendSafe(res, "deploy.html");
});

/* ============================================================
   BOT IMAGE
============================================================ */

app.get("/bot-image", (req, res) => {

    const files = [
        "bot.jpg",
        "bot.jpeg",
        "bot.png",
        "logo.jpg",
        "bot_image.jpg",
        "bot_image.png"
    ];

    for (const file of files) {

        const fullPath = path.join(
            MEDIA_DIR,
            file
        );

        if (fs.existsSync(fullPath)) {
            return res.sendFile(fullPath);
        }
    }

    const fallback = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        "base64"
    );

    res.set(
        "Content-Type",
        "image/png"
    );

    return res.send(fallback);
});

/* ============================================================
   USER STATISTICS
============================================================ */

app.get("/total-users", (req, res) => {

    const db = getDB();
    const now = Date.now();

    const active = db.filter(item => {

        const expiry =
            new Date(item.expiry).getTime();

        return (
            Number.isFinite(expiry) &&
            expiry > now &&
            item.active !== false
        );

    }).length;

    const expired = db.filter(item => {

        const expiry =
            new Date(item.expiry).getTime();

        return (
            Number.isFinite(expiry) &&
            expiry <= now
        );

    }).length;

    res.json({
        total: db.length,
        realTotal: db.length,
        online: active,
        count: db.length,
        real: db.length,
        active,
        expired,
        updatedAt: new Date().toISOString()
    });
});

/* ============================================================
   DEPLOY STATISTICS
============================================================ */

app.get("/deploy-stats", (req, res) => {

    const db = getDB();
    const now = Date.now();

    const active = db.filter(item => {

        const expiry =
            new Date(item.expiry).getTime();

        return (
            Number.isFinite(expiry) &&
            expiry > now &&
            item.active !== false
        );

    }).length;

    const expired = db.filter(item => {

        const expiry =
            new Date(item.expiry).getTime();

        return (
            Number.isFinite(expiry) &&
            expiry <= now
        );

    }).length;

    const recent = db.filter(item => {

        const deployed =
            new Date(item.deployedAt).getTime();

        return (
            Number.isFinite(deployed) &&
            now - deployed < 86400000
        );

    }).length;

    res.json({
        total: db.length,
        active,
        expired,
        recent,
        online: active
    });
});

/* ============================================================
   DEPLOYED LIST
============================================================ */

app.get("/deployed-list", (req, res) => {

    const db = getDB();
    const now = Date.now();

    const list = db.map(item => {

        const expiryMs =
            new Date(item.expiry).getTime();

        const daysLeft =
            Number.isFinite(expiryMs)
                ? Math.max(
                    0,
                    Math.ceil(
                        (expiryMs - now) /
                        86400000
                    )
                )
                : 0;

        const expired =
            !Number.isFinite(expiryMs) ||
            expiryMs <= now;

        return {
            number: item.number,
            duration: item.duration,
            expiry: item.expiry,
            deployedAt: item.deployedAt,
            daysLeft,
            isExpired: expired,
            active:
                !expired &&
                item.active !== false
        };
    });

    list.sort(
        (a, b) =>
            new Date(b.deployedAt) -
            new Date(a.deployedAt)
    );

    res.json(list);
});

/* ============================================================
   DEPLOY SESSION
============================================================ */

app.post("/deploy", (req, res) => {

    try {

        const {
            session,
            userNumber,
            duration
        } = req.body;

        if (
            !session ||
            typeof session !== "string"
        ) {
            return res.json({
                success: false,
                message: "Invalid SESSION_ID"
            });
        }

        if (
            !session.startsWith(
                "ETIAS-MINI-BOT~"
            )
        ) {
            return res.json({
                success: false,
                message:
                    "SESSION_ID must start with ETIAS-MINI-BOT~"
            });
        }

        const number =
            String(userNumber || "")
                .replace(/\D/g, "");

        if (number.length < 10) {

            return res.json({
                success: false,
                message: "Invalid number"
            });
        }

        const days =
            parseInt(duration, 10) || 30;

        const expiry =
            new Date(
                Date.now() +
                days * 86400000
            );

        const db = getDB();

        const filtered =
            db.filter(
                item =>
                    item.number !== number
            );

        filtered.push({

            number,

            session:
                session.substring(0, 60) +
                "...",

            fullSession: session,

            duration: days,

            expiry:
                expiry.toISOString(),

            deployedAt:
                new Date().toISOString(),

            active: true

        });

        saveDB(filtered);

        console.log(
            `[DEPLOY] ${number} ${days} days`
        );

        res.json({
            success: true,
            expiry:
                expiry.toISOString(),
            message:
                `Deployed ${number}`
        });

    } catch (error) {

        console.error(
            "[DEPLOY ERROR]",
            error.message
        );

        res.status(500).json({
            success: false,
            message: "Failed"
        });
    }
});

/* ============================================================
   SOCKET STORAGE
============================================================ */

const activeSockets =
    new Map();

const pairingStates =
    new Map();

const qrSockets =
    new Map();

/* ============================================================
   HELPERS
============================================================ */

function cleanNumber(value) {

    return String(value || "")
        .replace(/\D/g, "");
}

function makePairId(number) {

    return (
        "ETIAS_" +
        number +
        "_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(4)
            .toString("hex")
    );
}

function getDisconnectCode(error) {

    if (!error) {
        return undefined;
    }

    return (
        error?.output?.statusCode ||
        error?.data?.attrs?.code ||
        error?.statusCode
    );
}

/* ============================================================
   TAR.GZ SESSION SYSTEM
============================================================ */

function createSessionBundle(authFolder) {

    if (!fs.existsSync(authFolder)) {
        throw new Error(
            "Auth folder not found"
        );
    }

    const credsPath =
        path.join(
            authFolder,
            "creds.json"
        );

    if (!fs.existsSync(credsPath)) {
        throw new Error(
            "creds.json not generated"
        );
    }

    const randomName =
        `temp_${Date.now()}_${crypto
            .randomBytes(3)
            .toString("hex")}`;

    const tempTar =
        path.join(
            ROOT,
            `${randomName}.tar`
        );

    const tempGz =
        `${tempTar}.gz`;

    try {

        /*
         * Archive the COMPLETE auth folder.
         *
         * This includes:
         *
         * creds.json
         * app-state-sync-key-*.json
         * pre-key-*.json
         * sender-key-*.json
         * session-*.json
         * other Baileys auth files
         */

        execFileSync(
            "tar",
            [
                "-cf",
                tempTar,
                "-C",
                authFolder,
                "."
            ],
            {
                stdio: "ignore"
            }
        );

        execFileSync(
            "gzip",
            ["-f", tempTar],
            {
                stdio: "ignore"
            }
        );

        const data =
            fs.readFileSync(tempGz);

        const base64 =
            data.toString("base64");

        /*
         * IMPORTANT:
         * The SESSION_ID always starts with:
         *
         * ETIAS-MINI-BOT~
         */

        return (
            "ETIAS-MINI-BOT~" +
            base64
        );

    } finally {

        try {
            fs.rmSync(
                tempTar,
                { force: true }
            );
        } catch {}

        try {
            fs.rmSync(
                tempGz,
                { force: true }
            );
        } catch {}
    }
}

/* ============================================================
   SAVE PAIRED SESSION
============================================================ */

function savePairedSession(
    number,
    session
) {

    const db = getDB();

    const filtered =
        db.filter(
            item =>
                item.number !== number
        );

    const expiry =
        new Date(
            Date.now() +
            30 * 86400000
        );

    filtered.push({

        number,

        session:
            session.substring(0, 60) +
            "...",

        fullSession: session,

        duration: 30,

        expiry:
            expiry.toISOString(),

        deployedAt:
            new Date().toISOString(),

        active: true

    });

    saveDB(filtered);
}

/* ============================================================
   SEND SESSION ID TO WHATSAPP
============================================================ */

/*
 * FORMAT:
 *
 * Part 1:
 *
 * ETIAS-MINI-BOT~BASE64...
 *
 * Part 2:
 *
 * BASE64...
 *
 * Part 3:
 *
 * BASE64...
 *
 * When combined:
 *
 * ETIAS-MINI-BOT~FULL_BASE64
 */

async function sendSessionToWhatsApp(
    sock,
    number,
    session,
    id
) {

    try {

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    3000
                )
        );

        let jid =
            sock.user?.id;

        if (!jid) {

            jid =
                `${number}@s.whatsapp.net`;

            console.log(
                `[DM] Using fallback ${jid}`
            );
        }

        /*
         * Ensure correct prefix.
         */

        if (
            !session.startsWith(
                "ETIAS-MINI-BOT~"
            )
        ) {

            session =
                "ETIAS-MINI-BOT~" +
                session;
        }

        const prefix =
            "ETIAS-MINI-BOT~";

        const payload =
            session.substring(
                prefix.length
            );

        /*
         * Keep WhatsApp messages
         * below the practical message size.
         */

        const chunkSize = 40000;

        const total =
            Math.ceil(
                payload.length /
                chunkSize
            );

        console.log(
            `[DM] Sending SESSION_ID`
        );

        console.log(
            `[DM] Number: ${number}`
        );

        console.log(
            `[DM] Pair ID: ${id}`
        );

        console.log(
            `[DM] Length: ${session.length}`
        );

        console.log(
            `[DM] Parts: ${total}`
        );

        /* ----------------------------------------------------
           FIRST MESSAGE
        ---------------------------------------------------- */

        const firstChunk =
            payload.substring(
                0,
                chunkSize
            );

        await sock.sendMessage(
            jid,
            {
                text:
`*ETIAS-MINI-BOT ✅ CONNECTED*

*Number:* ${number}
*Pair ID:* ${id}

*SESSION_ID*

*Part 1/${total}*

ETIAS-MINI-BOT~${firstChunk}`
            }
        );

        console.log(
            `[DM] Sent SESSION_ID 1/${total}`
        );

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    1000
                )
        );

        /* ----------------------------------------------------
           REMAINING PARTS
        ---------------------------------------------------- */

        for (
            let i = 1;
            i < total;
            i++
        ) {

            const chunk =
                payload.substring(
                    i * chunkSize,
                    (i + 1) * chunkSize
                );

            await sock.sendMessage(
                jid,
                {
                    text:
`*ETIAS-MINI-BOT SESSION CONTINUATION*

*Part ${i + 1}/${total}*

${chunk}`
                }
            );

            console.log(
                `[DM] Sent SESSION_ID ${i + 1}/${total}`
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        700
                    )
            );
        }

        /* ----------------------------------------------------
           COMPLETION MESSAGE
        ---------------------------------------------------- */

        await sock.sendMessage(
            jid,
            {
                text:
`*✅ SESSION_ID COMPLETE*

*ETIAS-MINI-BOT*

Your complete multi-file session has been sent.

*Parts:* ${total}
*Session length:* ${session.length}
*Pair ID:* ${id}

Combine the parts in order.

The final SESSION_ID must start with:

ETIAS-MINI-BOT~

Deploy here:

${process.env.PAIR_URL ||
"https://etias-mini-bot-pair.onrender.com"}/deploy`
            }
        );

        console.log(
            `[DM] ✅ SESSION_ID sent successfully`
        );

        return true;

    } catch (error) {

        console.error(
            `[DM ERROR] ${error.message}`
        );

        /*
         * Fallback.
         *
         * This is only used if the normal
         * chunked DM fails.
         */

        try {

            const fallbackSession =
                session.startsWith(
                    "ETIAS-MINI-BOT~"
                )
                    ? session
                    : "ETIAS-MINI-BOT~" +
                      session;

            await sock.sendMessage(
                `${number}@s.whatsapp.net`,
                {
                    text:
`*ETIAS-MINI-BOT SESSION_ID*

${fallbackSession}`
                }
            );

            console.log(
                "[DM] Fallback SESSION_ID sent"
            );

            return true;

        } catch (fallbackError) {

            console.error(
                `[DM FALLBACK ERROR] ${fallbackError.message}`
            );

            return false;
        }
    }
}

/* ============================================================
   START PAIRING
============================================================ */

async function startPairing(
    number,
    id,
    authFolder
) {

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            authFolder
        );

    console.log(
        `[AUTH] ${number} reg=${state.creds.registered}`
    );

    const logger =
        pino({
            level: "silent"
        });

    const sock =
        makeWASocket({

            auth: {
                creds: state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        logger
                    )
            },

            logger,

            browser:
                Browsers.macOS("Chrome"),

            printQRInTerminal: false,

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview:
                false,

            connectTimeoutMs:
                60000,

            keepAliveIntervalMs:
                10000
        });

    activeSockets.set(
        id,
        sock
    );

    let pairingCodeRequested =
        state.creds.registered;

    let sessionGenerated = false;

    const oldState =
        pairingStates.get(id);

    pairingStates.set(
        id,
        {
            id,
            number,

            status:
                state.creds.registered
                    ? "authenticated"
                    : "connecting",

            code: null,

            session: null,

            connected: false,

            restartCount:
                oldState?.restartCount ||
                0,

            createdAt:
                oldState?.createdAt ||
                new Date().toISOString()
        }
    );

    /* --------------------------------------------------------
       CREDS UPDATE
    -------------------------------------------------------- */

    sock.ev.on(
        "creds.update",
        async () => {

            try {
                await saveCreds();
            } catch {}
        }
    );

    /* --------------------------------------------------------
       CONNECTION UPDATE
    -------------------------------------------------------- */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect,
                qr,
                isNewLogin
            } = update;

            const info =
                pairingStates.get(id);

            if (
                connection === "connecting" &&
                info
            ) {

                info.status =
                    state.creds.registered
                        ? "authenticated"
                        : "connecting";
            }

            if (
                qr &&
                info
            ) {

                info.hasQR = true;
            }

            /* ------------------------------------------------
               REQUEST PAIRING CODE
            ------------------------------------------------ */

            if (
                !state.creds.registered &&
                !pairingCodeRequested &&
                (
                    connection === "connecting" ||
                    qr
                )
            ) {

                pairingCodeRequested = true;

                try {

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                2500
                            )
                    );

                    const code =
                        await sock.requestPairingCode(
                            number
                        );

                    const formatted =
                        code
                            ?.match(/.{1,4}/g)
                            ?.join("-") ||
                        code;

                    const current =
                        pairingStates.get(id);

                    if (current) {

                        current.code =
                            formatted;

                        current.status =
                            "waiting_for_pairing";
                    }

                    console.log(
                        `\n[PAIR CODE] ${formatted} for ${number}\n`
                    );

                } catch (error) {

                    pairingCodeRequested =
                        false;

                    const message =
                        error?.message ||
                        String(error);

                    const rate =
                        message
                            .toLowerCase()
                            .includes("429") ||
                        message
                            .toLowerCase()
                            .includes(
                                "rate-overlimit"
                            );

                    const current =
                        pairingStates.get(id);

                    if (current) {

                        current.status =
                            rate
                                ? "rate_limited"
                                : "pairing_code_error";

                        current.error =
                            message;

                        current.rateLimited =
                            rate;
                    }

                    console.error(
                        `[PAIR ERROR] ${message}`
                    );

                    if (rate) {

                        try {
                            sock.end();
                        } catch {}

                        activeSockets.delete(id);
                    }
                }
            }

            /* ------------------------------------------------
               CONNECTED
            ------------------------------------------------ */

            if (
                connection === "open"
            ) {

                console.log(
                    `\n[CONNECTED] ${number} newLogin=${isNewLogin} id=${sock.user?.id}\n`
                );

                const current =
                    pairingStates.get(id);

                if (current) {

                    current.connected =
                        true;

                    current.status =
                        "connected";

                    current.whatsappId =
                        sock.user?.id ||
                        null;
                }

                try {
                    await saveCreds();
                } catch {}

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            3000
                        )
                );

                /* ------------------------------------------------
                   CREATE COMPLETE TAR.GZ SESSION
                ------------------------------------------------ */

                if (!sessionGenerated) {

                    try {

                        const credsPath =
                            path.join(
                                authFolder,
                                "creds.json"
                            );

                        /*
                         * Make sure creds exists.
                         */

                        if (
                            !fs.existsSync(
                                credsPath
                            )
                        ) {

                            fs.writeFileSync(
                                credsPath,
                                JSON.stringify(
                                    state.creds,
                                    null,
                                    2
                                )
                            );
                        }

                        /*
                         * Create complete archive.
                         */

                        const session =
                            createSessionBundle(
                                authFolder
                            );

                        sessionGenerated =
                            true;

                        const currentState =
                            pairingStates.get(id);

                        if (currentState) {

                            currentState.status =
                                "session_ready";

                            currentState.session =
                                session;

                            currentState.connected =
                                true;

                            currentState.sessionLength =
                                session.length;
                        }

                        /*
                         * Save session.
                         */

                        savePairedSession(
                            number,
                            session
                        );

                        console.log(
                            `[SESSION] Complete TAR.GZ session created`
                        );

                        console.log(
                            `[SESSION] Length: ${session.length}`
                        );

                        console.log(
                            `[SESSION] Prefix valid: ${session.startsWith("ETIAS-MINI-BOT~")}`
                        );

                        /*
                         * Send session to WhatsApp.
                         */

                        const dmOk =
                            await sendSessionToWhatsApp(
                                sock,
                                number,
                                session,
                                id
                            );

                        const finalState =
                            pairingStates.get(id);

                        if (finalState) {
                            finalState.dmSent =
                                dmOk;
                        }

                    } catch (error) {

                        console.error(
                            `[SESSION ERR] ${error.message}`
                        );

                        const currentState =
                            pairingStates.get(id);

                        if (currentState) {

                            currentState.status =
                                "session_error";

                            currentState.error =
                                error.message;
                        }
                    }
                }

                return;
            }

            /* ------------------------------------------------
               CONNECTION CLOSED
            ------------------------------------------------ */

            if (
                connection === "close"
            ) {

                const code =
                    getDisconnectCode(
                        lastDisconnect?.error
                    );

                console.log(
                    `[CLOSED] ${number} CODE=${code}`
                );

                const current =
                    pairingStates.get(id);

                if (current) {

                    current.connected =
                        false;

                    current.disconnectCode =
                        code;
                }

                /* ------------------------------------------------
                   515 RESTART
                ------------------------------------------------ */

                if (
                    code ===
                    DisconnectReason.restartRequired
                ) {

                    console.log(
                        `[515 RESTART] ${number}`
                    );

                    const stateInfo =
                        pairingStates.get(id);

                    if (stateInfo) {

                        stateInfo.status =
                            "restarting";

                        stateInfo.restartCount =
                            (stateInfo.restartCount || 0) +
                            1;
                    }

                    activeSockets.delete(id);

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                1500
                            )
                    );

                    try {

                        await startPairing(
                            number,
                            id,
                            authFolder
                        );

                    } catch {}

                    return;
                }

                /* ------------------------------------------------
                   LOGGED OUT / BAD SESSION / RATE LIMIT
                ------------------------------------------------ */

                if (
                    code ===
                        DisconnectReason.loggedOut ||
                    code ===
                        DisconnectReason.badSession ||
                    code === 429
                ) {

                    if (current) {

                        current.status =
                            code === 429
                                ? "rate_limited"
                                : code ===
                                  DisconnectReason.loggedOut
                                    ? "logged_out"
                                    : "bad_session";
                    }

                    activeSockets.delete(id);

                    return;
                }

                if (current) {
                    current.status =
                        "disconnected";
                }

                activeSockets.delete(id);
            }
        }
    );

    return sock;
}

/* ============================================================
   REQUEST PAIRING CODE
============================================================ */

app.get(
    "/code",
    async (req, res) => {

        const number =
            cleanNumber(
                req.query.number
            );

        if (
            !number ||
            number.length < 10 ||
            number.length > 15
        ) {

            return res.status(400).json({
                success: false,
                error:
                    "Enter valid number ex: 2637XXXXXXX"
            });
        }

        /* ---------------------------------------------
           Existing pairing
        --------------------------------------------- */

        for (
            const [
                existingId,
                info
            ]
            of pairingStates.entries()
        ) {

            if (
                info.number === number &&
                [
                    "connecting",
                    "waiting_for_pairing",
                    "restarting",
                    "authenticated"
                ].includes(info.status)
            ) {

                return res.json({

                    success: true,

                    existing: true,

                    id: existingId,

                    sessionId:
                        existingId,

                    status:
                        info.status,

                    code:
                        info.code ||
                        null,

                    connected:
                        info.connected ||
                        false
                });
            }

            if (
                info.number === number &&
                info.status ===
                    "rate_limited"
            ) {

                return res.status(429).json({

                    success: false,

                    error:
                        "Rate limited",

                    id: existingId,

                    status:
                        info.status
                });
            }
        }

        /* ---------------------------------------------
           Create new pairing
        --------------------------------------------- */

        const id =
            makePairId(number);

        const authFolder =
            path.join(
                AUTH_DIR,
                id
            );

        try {

            fs.mkdirSync(
                authFolder,
                {
                    recursive: true
                }
            );

            console.log(
                `\n[PAIR START] ${number} | ${id}`
            );

            await startPairing(
                number,
                id,
                authFolder
            );

            const start =
                Date.now();

            while (
                Date.now() -
                start <
                30000
            ) {

                const info =
                    pairingStates.get(id);

                if (info?.code) {

                    return res.json({

                        success: true,

                        status:
                            "waiting_for_pairing",

                        code:
                            info.code,

                        sessionId:
                            id,

                        id,

                        number
                    });
                }

                if (
                    info?.status ===
                    "rate_limited"
                ) {

                    return res.status(429).json({

                        success: false,

                        status:
                            "rate_limited",

                        error:
                            info.error,

                        id,

                        sessionId:
                            id
                    });
                }

                if (
                    info?.status ===
                    "pairing_code_error"
                ) {

                    return res.status(500).json({

                        success: false,

                        error:
                            info.error ||
                            "Pairing failed",

                        id
                    });
                }

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            250
                        )
                );
            }

            return res.status(504).json({

                success: false,

                error:
                    "No code from WhatsApp",

                id,

                sessionId:
                    id
            });

        } catch (error) {

            try {

                fs.rmSync(
                    authFolder,
                    {
                        recursive: true,
                        force: true
                    }
                );

            } catch {}

            pairingStates.delete(id);

            return res.status(500).json({

                success: false,

                error:
                    error?.message ||
                    "Failed"
            });
        }
    }
);

/* ============================================================
   PAIRING STATUS
============================================================ */

app.get(
    "/status/:id",
    (req, res) => {

        const state =
            pairingStates.get(
                req.params.id
            );

        if (!state) {

            return res.json({

                success: false,

                status:
                    "not_found",

                id:
                    req.params.id
            });
        }

        res.json({

            success: true,

            id:
                state.id,

            number:
                state.number,

            status:
                state.status,

            connected:
                state.connected ||
                false,

            code:
                state.code ||
                null,

            hasSession:
                !!state.session,

            sessionLength:
                state.sessionLength ||
                0,

            dmSent:
                state.dmSent ||
                false,

            error:
                state.error ||
                null
        });
    }
);

/* ============================================================
   CHECK SESSION
============================================================ */

app.get(
    "/check/:id",
    (req, res) => {

        const state =
            pairingStates.get(
                req.params.id
            );

        if (state) {

            return res.json({

                connected:
                    state.connected ||
                    false,

                status:
                    state.status,

                code:
                    state.code ||
                    null,

                session:
                    state.session ||
                    null,

                number:
                    state.number,

                id:
                    req.params.id,

                dmSent:
                    state.dmSent ||
                    false
            });
        }

        const authFolder =
            path.join(
                AUTH_DIR,
                req.params.id
            );

        if (
            !fs.existsSync(
                authFolder
            )
        ) {

            return res.json({

                connected: false,

                status:
                    "not_found",

                id:
                    req.params.id
            });
        }

        try {

            const session =
                createSessionBundle(
                    authFolder
                );

            return res.json({

                connected: true,

                status:
                    "session_ready",

                session,

                id:
                    req.params.id
            });

        } catch (error) {

            return res.json({

                connected: false,

                status:
                    "waiting",

                id:
                    req.params.id,

                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   GET SESSION
============================================================ */

app.get(
    "/session/:id",
    (req, res) => {

        const state =
            pairingStates.get(
                req.params.id
            );

        if (state?.session) {

            return res.json({

                success: true,

                connected: true,

                session:
                    state.session,

                id:
                    req.params.id
            });
        }

        const authFolder =
            path.join(
                AUTH_DIR,
                req.params.id
            );

        try {

            const session =
                createSessionBundle(
                    authFolder
                );

            return res.json({

                success: true,

                connected: true,

                session,

                id:
                    req.params.id
            });

        } catch {

            return res.status(404).json({

                success: false,

                error:
                    "Not ready"
            });
        }
    }
);

/* ============================================================
   QR CODE
============================================================ */

app.get(
    "/qr-image",
    async (req, res) => {

        const id =
            "QR_" +
            Date.now() +
            "_" +
            crypto
                .randomBytes(3)
                .toString("hex");

        const authFolder =
            path.join(
                AUTH_DIR,
                id
            );

        try {

            const {
                state,
                saveCreds
            } =
                await useMultiFileAuthState(
                    authFolder
                );

            const logger =
                pino({
                    level: "silent"
                });

            const sock =
                makeWASocket({

                    auth: {
                        creds:
                            state.creds,

                        keys:
                            makeCacheableSignalKeyStore(
                                state.keys,
                                logger
                            )
                    },

                    logger,

                    browser:
                        Browsers.macOS(
                            "Chrome"
                        ),

                    printQRInTerminal:
                        false
                });

            qrSockets.set(
                id,
                sock
            );

            sock.ev.on(
                "creds.update",
                saveCreds
            );

            const qrData =
                await new Promise(
                    (resolve, reject) => {

                        let done = false;

                        const timer =
                            setTimeout(
                                () => {

                                    if (!done) {

                                        done = true;

                                        reject(
                                            new Error(
                                                "QR timeout"
                                            )
                                        );
                                    }

                                },
                                60000
                            );

                        sock.ev.on(
                            "connection.update",
                            async update => {

                                if (
                                    update.qr &&
                                    !done
                                ) {

                                    try {

                                        const image =
                                            await qrcode.toDataURL(
                                                update.qr
                                            );

                                        done = true;

                                        clearTimeout(
                                            timer
                                        );

                                        resolve(
                                            image
                                        );

                                    } catch (error) {

                                        done = true;

                                        clearTimeout(
                                            timer
                                        );

                                        reject(error);
                                    }
                                }

                                if (
                                    update.connection ===
                                        "close" &&
                                    !done
                                ) {

                                    done = true;

                                    clearTimeout(
                                        timer
                                    );

                                    reject(
                                        new Error(
                                            "Closed"
                                        )
                                    );
                                }
                            }
                        );
                    }
                );

            return res.json({

                success: true,

                id,

                qr:
                    qrData
            });

        } catch (error) {

            try {

                fs.rmSync(
                    authFolder,
                    {
                        recursive: true,
                        force: true
                    }
                );

            } catch {}

            return res.status(500).json({

                success: false,

                error:
                    "QR failed"
            });
        }
    }
);

/* ============================================================
   CLEAN QR SOCKETS
============================================================ */

setInterval(
    () => {

        for (
            const [
                id,
                socket
            ]
            of qrSockets.entries()
        ) {

            try {
                socket.end();
            } catch {}

            qrSockets.delete(id);

            try {

                fs.rmSync(
                    path.join(
                        AUTH_DIR,
                        id
                    ),
                    {
                        recursive: true,
                        force: true
                    }
                );

            } catch {}
        }

    },
    120000
);

/* ============================================================
   CLEAN OLD PAIRING SESSIONS
============================================================ */

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                id,
                state
            ]
            of pairingStates.entries()
        ) {

            const created =
                new Date(
                    state.createdAt
                ).getTime();

            if (
                !Number.isFinite(
                    created
                )
            ) {
                continue;
            }

            /*
             * Keep connected/session-ready
             * sessions.
             */

            if (
                state.connected ||
                state.status ===
                    "session_ready"
            ) {
                continue;
            }

            /*
             * Remove incomplete pairing
             * after 10 minutes.
             */

            if (
                now - created >
                600000
            ) {

                console.log(
                    `[CLEANUP] ${id}`
                );

                const socket =
                    activeSockets.get(id);

                try {
                    socket?.end();
                } catch {}

                activeSockets.delete(id);

                try {

                    fs.rmSync(
                        path.join(
                            AUTH_DIR,
                            id
                        ),
                        {
                            recursive: true,
                            force: true
                        }
                    );

                } catch {}

                pairingStates.delete(id);
            }
        }

    },
    60000
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
    "/ping",
    (req, res) => {

        res.send(
            "ETIAS-PAIR alive " +
            new Date().toISOString()
        );
    }
);

app.get(
    "/health",
    (req, res) => {

        res.json({

            status:
                "alive",

            total:
                getDB().length,

            activeSockets:
                activeSockets.size,

            pairingSessions:
                pairingStates.size,

            uptime:
                process.uptime(),

            timestamp:
                new Date().toISOString()
        });
    }
);

/* ============================================================
   START SERVER
============================================================ */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
==========================================
 ETIAS-MINI-BOT PAIRING SERVER
==========================================
 PORT: ${PORT}
 OWNER: ${OWNER_NUMBER}
 AUTH: ${AUTH_DIR}
 DATA: ${DATA_DIR}
 SESSION: TAR.GZ + BASE64
 SESSION PREFIX: ETIAS-MINI-BOT~
==========================================
`);
    }
);

/* ============================================================
   ERROR HANDLERS
============================================================ */

process.on(
    "unhandledRejection",
    error => {

        console.error(
            "[UNHANDLED]",
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {

        console.error(
            "[UNCAUGHT]",
            error
        );
    }
);
