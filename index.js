"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const pino = require("pino");
const QRCode = require("qrcode");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const {
    createPairing,
    getPairing,
    updatePairing,
    getAllPairings,
    generateUserId,
    addDeployedUser,
    loadDeployed
} = require("./id");

const {
    generateAndSendSession
} = require("./session");

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const AUTH_DIR = path.join(ROOT, "auth");
const DATA_DIR = path.join(ROOT, "data");
const MEDIA_DIR = path.join(ROOT, "media");
const TEMP_AUTH_DIR = path.join(ROOT, "temp_auth");

const logger = pino({
    level: process.env.LOG_LEVEL || "silent"
});

const sockets = new Map();
const reconnecting = new Set();

/* =========================================================
   HELPERS
========================================================= */

async function ensureDirectories() {
    await fsp.mkdir(AUTH_DIR, {
        recursive: true
    });

    await fsp.mkdir(DATA_DIR, {
        recursive: true
    });

    await fsp.mkdir(MEDIA_DIR, {
        recursive: true
    });

    await fsp.mkdir(TEMP_AUTH_DIR, {
        recursive: true
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanNumber(number) {
    return String(number || "")
        .replace(/\D/g, "");
}

/*
 * Normalize WhatsApp JID.
 *
 * Example:
 * 263771234567:12@s.whatsapp.net
 *
 * becomes:
 *
 * 263771234567@s.whatsapp.net
 */
function normalizeJid(jid) {
    if (!jid) return null;

    return String(jid)
        .trim()
        .replace(/:\d+(?=@)/, "");
}

function getDisconnectCode(lastDisconnect) {
    return (
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.data?.statusCode ||
        lastDisconnect?.error?.statusCode ||
        null
    );
}

function isLoggedOut(code) {
    return code === DisconnectReason.loggedOut;
}

function isBadSession(code) {
    return code === DisconnectReason.badSession;
}

function isRestartRequired(code) {
    return code === DisconnectReason.restartRequired;
}

/* =========================================================
   SAVE SUCCESSFUL SESSION
========================================================= */

async function saveSuccessfulSession(
    pairingId,
    number,
    jid,
    sessionId,
    authFolder
) {
    const now = new Date().toISOString();

    updatePairing(
        pairingId,
        {
            status: "connected",
            connected: true,
            sent: true,
            sessionId,
            jid,
            authFolder,
            sessionSentAt: now
        }
    );

    /*
     * Persistence happens only after
     * the session has successfully been generated
     * and sent.
     */
    await addDeployedUser({
        id: generateUserId(),
        pairingId,
        number,
        jid,
        sessionId,
        authFolder,
        status: "connected",
        connected: true,
        sent: true,
        sessionSentAt: now,
        createdAt: now
    });
}

/* =========================================================
   START PAIRING
========================================================= */

async function startPairing(
    number,
    pairingId,
    existingAuthFolder = null
) {
    const clean = cleanNumber(number);

    if (!clean) {
        throw new Error("Invalid phone number");
    }

    let authFolder = existingAuthFolder;

    if (!authFolder) {
        authFolder = path.join(
            AUTH_DIR,
            `ETIAS_${clean}_${Date.now()}_${Math.random()
                .toString(16)
                .slice(2, 10)}`
        );
    }

    await fsp.mkdir(
        authFolder,
        {
            recursive: true
        }
    );

    console.log(
        `[PAIR] Auth folder: ${authFolder}`
    );

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        authFolder
    );

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                logger
            )
        },

        logger,

        browser: Browsers.macOS("Chrome"),

        markOnlineOnConnect: false,

        syncFullHistory: false,

        generateHighQualityLinkPreview: false,

        connectTimeoutMs: 60000,

        defaultQueryTimeoutMs: 60000,

        keepAliveIntervalMs: 25000
    });

    sockets.set(
        pairingId,
        sock
    );

    updatePairing(
        pairingId,
        {
            status: "connecting",
            connected: false,
            authFolder
        }
    );

    /* =====================================================
       CREDENTIAL UPDATES
    ===================================================== */

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /* =====================================================
       CONNECTION UPDATE
    ===================================================== */

    sock.ev.on(
        "connection.update",
        async update => {
            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            /* =================================================
               QR
            ================================================= */

            if (qr) {
                updatePairing(
                    pairingId,
                    {
                        status: "qr",
                        connected: false,

                        qr:
                            `https://wa.me/settings/linked_devices#${qr}`
                    }
                );

                try {
                    const qrData =
                        await QRCode.toDataURL(qr);

                    updatePairing(
                        pairingId,
                        {
                            qrImage: qrData
                        }
                    );
                } catch (error) {
                    console.error(
                        "[QR] Image error:",
                        error.message
                    );
                }
            }

            /* =================================================
               CONNECTING
            ================================================= */

            if (connection === "connecting") {
                console.log(
                    `[PAIR] Connecting: ${pairingId}`
                );

                updatePairing(
                    pairingId,
                    {
                        status: "connecting",
                        connected: false
                    }
                );
            }

            /* =================================================
               CONNECTED
            ================================================= */

            if (connection === "open") {
                console.log(
                    "========================================"
                );

                console.log(
                    "✅ WHATSAPP CONNECTED"
                );

                console.log(
                    `PAIR ID: ${pairingId}`
                );

                console.log(
                    `SOCKET JID: ${sock.user?.id || "unknown"}`
                );

                console.log(
                    "========================================"
                );

                try {
                    /*
                     * Give Baileys time to finish
                     * writing credentials.
                     */
                    await sleep(2500);

                    await saveCreds();

                    await sleep(1500);

                    const authenticatedJid =
                        sock.user?.id;

                    if (!authenticatedJid) {
                        throw new Error(
                            "Authenticated WhatsApp JID unavailable"
                        );
                    }

                    const normalizedJid =
                        normalizeJid(
                            authenticatedJid
                        );

                    console.log(
                        `[PAIR] Authenticated JID: ${authenticatedJid}`
                    );

                    console.log(
                        `[PAIR] Normalized JID: ${normalizedJid}`
                    );

                    updatePairing(
                        pairingId,
                        {
                            status: "generating_session",
                            connected: true,
                            jid: authenticatedJid,
                            authFolder
                        }
                    );

                    /* =========================================
                       GENERATE + SEND SESSION
                    ========================================= */

                    console.log(
                        "[SESSION] Generating and sending SESSION_ID..."
                    );

                    const result =
                        await generateAndSendSession(
                            sock,
                            authFolder,
                            authenticatedJid,
                            pairingId,
                            normalizedJid
                        );

                    if (!result) {
                        throw new Error(
                            "generateAndSendSession returned no result"
                        );
                    }

                    const sessionId =
                        result.sessionId;

                    if (!sessionId) {
                        throw new Error(
                            "generateAndSendSession did not return sessionId"
                        );
                    }

                    console.log(
                        "[SESSION] SESSION_ID generated successfully"
                    );

                    console.log(
                        `[SESSION] SESSION_ID length: ${sessionId.length}`
                    );

                    updatePairing(
                        pairingId,
                        {
                            status: "session_ready",
                            connected: true,
                            sent: true,
                            sessionId,
                            jid: authenticatedJid,
                            authFolder
                        }
                    );

                    console.log(
                        "[SESSION] Automatic delivery complete"
                    );

                    /* =========================================
                       SAVE DEPLOYED USER
                    ========================================= */

                    await saveSuccessfulSession(
                        pairingId,
                        clean,
                        authenticatedJid,
                        sessionId,
                        authFolder
                    );

                    console.log(
                        "========================================"
                    );

                    console.log(
                        "🎉 PAIRING COMPLETE"
                    );

                    console.log(
                        `PAIR ID: ${pairingId}`
                    );

                    console.log(
                        `NUMBER: ${clean}`
                    );

                    console.log(
                        `JID: ${authenticatedJid}`
                    );

                    console.log(
                        "SESSION SENT: YES"
                    );

                    console.log(
                        "========================================"
                    );

                } catch (error) {
                    console.error(
                        "========================================"
                    );

                    console.error(
                        "[SESSION ERROR]"
                    );

                    console.error(
                        error
                    );

                    console.error(
                        "========================================"
                    );

                    updatePairing(
                        pairingId,
                        {
                            status: "session_error",
                            connected: true,
                            sent: false,
                            error:
                                error.message ||
                                String(error)
                        }
                    );
                }
            }

            /* =================================================
               CLOSED
            ================================================= */

            if (connection === "close") {
                const code =
                    getDisconnectCode(
                        lastDisconnect
                    );

                console.log(
                    `[PAIR] Connection closed. Code: ${code}`
                );

                sockets.delete(
                    pairingId
                );

                /* =============================================
                   LOGGED OUT
                ============================================= */

                if (isLoggedOut(code)) {
                    console.log(
                        "[PAIR] ❌ WhatsApp logged out"
                    );

                    updatePairing(
                        pairingId,
                        {
                            status: "logged_out",
                            connected: false
                        }
                    );

                    return;
                }

                /* =============================================
                   BAD SESSION
                ============================================= */

                if (isBadSession(code)) {
                    console.log(
                        "[PAIR] ❌ Bad session"
                    );

                    updatePairing(
                        pairingId,
                        {
                            status: "bad_session",
                            connected: false
                        }
                    );

                    return;
                }

                /* =============================================
                   PREVENT DUPLICATE RECONNECTS
                ============================================= */

                if (
                    reconnecting.has(
                        pairingId
                    )
                ) {
                    return;
                }

                reconnecting.add(
                    pairingId
                );

                console.log(
                    "[PAIR] 🔄 Reconnecting using same auth folder..."
                );

                updatePairing(
                    pairingId,
                    {
                        status: "reconnecting",
                        connected: false
                    }
                );

                setTimeout(
                    async () => {
                        try {
                            reconnecting.delete(
                                pairingId
                            );

                            await startPairing(
                                clean,
                                pairingId,
                                authFolder
                            );

                        } catch (error) {
                            console.error(
                                "[PAIR] Reconnect failed:",
                                error.message
                            );

                            reconnecting.delete(
                                pairingId
                            );

                            updatePairing(
                                pairingId,
                                {
                                    status: "error",
                                    connected: false,
                                    error:
                                        error.message
                                }
                            );
                        }
                    },

                    isRestartRequired(code)
                        ? 1000
                        : 3000
                );
            }
        }
    );

    /* =========================================================
       REQUEST PAIRING CODE
    ========================================================= */

    if (!state.creds.registered) {
        try {
            console.log(
                "[PAIR] Waiting for WhatsApp connection..."
            );

            /*
             * Delay helps prevent the common
             * 428 Connection Closed error.
             */
            await sleep(5000);

            if (
                sockets.get(pairingId) !==
                sock
            ) {
                throw new Error(
                    "Pairing socket is no longer active"
                );
            }

            let code = null;
            let lastError = null;

            for (
                let attempt = 1;
                attempt <= 3;
                attempt++
            ) {
                try {
                    console.log(
                        `[PAIR] Requesting pairing code ${attempt}/3...`
                    );

                    code =
                        await sock.requestPairingCode(
                            clean
                        );

                    if (code) {
                        break;
                    }

                } catch (error) {
                    lastError =
                        error;

                    console.error(
                        `[PAIR] Pairing request ${attempt}/3 failed:`,
                        error.message
                    );

                    if (
                        attempt < 3
                    ) {
                        await sleep(
                            3000
                        );
                    }
                }
            }

            if (!code) {
                throw (
                    lastError ||
                    new Error(
                        "Failed to generate pairing code"
                    )
                );
            }

            console.log(
                `[PAIR] Pairing code: ${code}`
            );

            updatePairing(
                pairingId,
                {
                    status: "pairing_code",
                    pairingCode: code,
                    connected: false
                }
            );

        } catch (error) {
            console.error(
                "[PAIRING CODE ERROR]",
                error
            );

            updatePairing(
                pairingId,
                {
                    status: "error",
                    connected: false,
                    error:
                        error.message ||
                        String(error)
                }
            );
        }
    }

    return sock;
}

/* =========================================================
   EXPRESS CONFIGURATION
========================================================= */

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

app.use(
    express.static(ROOT)
);

/* =========================================================
   HOME
========================================================= */

app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                ROOT,
                "index.html"
            )
        );
    }
);

/* =========================================================
   PAIR PAGE
========================================================= */

app.get(
    "/pair",
    (req, res) => {
        res.sendFile(
            path.join(
                ROOT,
                "pair.html"
            )
        );
    }
);

/* =========================================================
   QR PAGE
========================================================= */

app.get(
    "/qr",
    (req, res) => {
        res.sendFile(
            path.join(
                ROOT,
                "qr.html"
            )
        );
    }
);

/* =========================================================
   PING
========================================================= */

app.get(
    "/ping",
    (req, res) => {
        res.json({
            status: "ok",
            service:
                "ETIAS-MINI-BOT Pair Server",
            time:
                new Date().toISOString()
        });
    }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    (req, res) => {
        res.json({
            status: "online",
            sockets:
                sockets.size,
            pairings:
                getAllPairings().length,
            uptime:
                process.uptime()
        });
    }
);

/* =========================================================
   CREATE PAIRING
========================================================= */

app.get(
    "/code",
    async (req, res) => {
        try {
            const number =
                cleanNumber(
                    req.query.number
                );

            if (!number) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Phone number is required"
                });
            }

            /*
             * Don't create duplicate active
             * pairing sessions for same number.
             */
            const existing =
                getAllPairings().find(
                    item =>
                        item.number ===
                            number &&
                        [
                            "starting",
                            "connecting",
                            "pairing_code",
                            "qr",
                            "reconnecting",
                            "generating_session"
                        ].includes(
                            item.status
                        )
                );

            if (existing) {
                return res.json({
                    success: true,
                    pairingId:
                        existing.id,
                    number,
                    status:
                        existing.status,
                    message:
                        "Pairing session already exists."
                });
            }

            const pairing =
                createPairing(
                    number
                );

            /*
             * Start in background.
             */
            startPairing(
                number,
                pairing.id
            ).catch(error => {
                console.error(
                    "[PAIR] Startup error:",
                    error
                );

                updatePairing(
                    pairing.id,
                    {
                        status: "error",
                        error:
                            error.message ||
                            String(error)
                    }
                );
            });

            await sleep(1200);

            const current =
                getPairing(
                    pairing.id
                );

            return res.json({
                success: true,
                pairingId:
                    pairing.id,
                number,
                status:
                    current?.status ||
                    "starting",
                message:
                    "Pairing session started. Check /status/:id."
            });

        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
    "/status/:id",
    (req, res) => {
        const pairing =
            getPairing(
                req.params.id
            );

        if (!pairing) {
            return res.status(404).json({
                success: false,
                error:
                    "Pairing ID not found"
            });
        }

        return res.json({
            success: true,
            ...pairing
        });
    }
);

/* =========================================================
   CHECK
========================================================= */

app.get(
    "/check/:id",
    (req, res) => {
        const pairing =
            getPairing(
                req.params.id
            );

        if (!pairing) {
            return res.status(404).json({
                success: false,
                error:
                    "Pairing ID not found"
            });
        }

        res.json({
            success: true,
            id:
                pairing.id,
            number:
                pairing.number,
            status:
                pairing.status,
            connected:
                pairing.connected,
            sent:
                pairing.sent,
            hasSession:
                Boolean(
                    pairing.sessionId
                ),
            jid:
                pairing.jid ||
                null,
            error:
                pairing.error ||
                null
        });
    }
);

/* =========================================================
   SESSION STATUS
========================================================= */

app.get(
    "/session/:id",
    (req, res) => {
        const pairing =
            getPairing(
                req.params.id
            );

        if (!pairing) {
            return res.status(404).json({
                success: false,
                error:
                    "Pairing ID not found"
            });
        }

        /*
         * Do not expose the actual session
         * through an unauthenticated endpoint.
         */
        res.json({
            success: true,

            pairingId:
                pairing.id,

            status:
                pairing.status,

            connected:
                pairing.connected,

            sent:
                pairing.sent,

            jid:
                pairing.jid ||
                null,

            sessionAvailable:
                Boolean(
                    pairing.sessionId
                )
        });
    }
);

/* =========================================================
   QR IMAGE
========================================================= */

app.get(
    "/qr-image",
    async (req, res) => {
        try {
            const id =
                req.query.id;

            if (!id) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Pairing ID required"
                });
            }

            const pairing =
                getPairing(id);

            if (!pairing) {
                return res.status(404).json({
                    success: false,
                    error:
                        "Pairing ID not found"
                });
            }

            if (!pairing.qrImage) {
                return res.status(404).json({
                    success: false,
                    error:
                        "QR code not available"
                });
            }

            res.type("png");

            const base64 =
                pairing.qrImage
                    .replace(
                        /^data:image\/png;base64,/,
                        ""
                    );

            res.send(
                Buffer.from(
                    base64,
                    "base64"
                )
            );

        } catch (error) {
            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   DEPLOYED USERS
========================================================= */

app.get(
    "/deployed-list",
    async (req, res) => {
        try {
            const users =
                await loadDeployed();

            /*
             * Never expose sessionId publicly.
             */
            const safeUsers =
                users.map(user => {
                    const copy = {
                        ...user
                    };

                    delete copy.sessionId;

                    return copy;
                });

            res.json({
                success: true,
                count:
                    safeUsers.length,
                users:
                    safeUsers
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   TOTAL USERS
========================================================= */

app.get(
    "/total-users",
    async (req, res) => {
        try {
            const users =
                await loadDeployed();

            res.json({
                success: true,
                total:
                    users.length
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   DEPLOY STATS
========================================================= */

app.get(
    "/deploy-stats",
    async (req, res) => {
        try {
            const users =
                await loadDeployed();

            const connected =
                users.filter(
                    user =>
                        user.connected === true
                ).length;

            const sent =
                users.filter(
                    user =>
                        user.sent === true
                ).length;

            res.json({
                success: true,

                total:
                    users.length,

                connected,

                sent
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   BOT IMAGE
========================================================= */

app.get(
    "/bot-image",
    (req, res) => {
        const imagePath =
            path.join(
                MEDIA_DIR,
                "bot_image.png"
            );

        if (
            fs.existsSync(
                imagePath
            )
        ) {
            return res.sendFile(
                imagePath
            );
        }

        res.status(404).json({
            success: false,
            error:
                "Bot image not found"
        });
    }
);

/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,
            error:
                "Route not found",
            path:
                req.path
        });
    }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
    (err, req, res, next) => {
        console.error(
            "[EXPRESS ERROR]",
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            success: false,
            error:
                err.message ||
                "Internal server error"
        });
    }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
    try {
        await ensureDirectories();

        app.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log(
                    "========================================"
                );

                console.log(
                    "🚀 ETIAS-MINI-BOT PAIR SERVER"
                );

                console.log(
                    `🌐 PORT: ${PORT}`
                );

                console.log(
                    `📁 ROOT: ${ROOT}`
                );

                console.log(
                    `📁 AUTH: ${AUTH_DIR}`
                );

                console.log(
                    `📁 DATA: ${DATA_DIR}`
                );

                console.log(
                    "========================================"
                );
            }
        );

    } catch (error) {
        console.error(
            "[SERVER] Failed to start:",
            error
        );

        process.exit(1);
    }
}

startServer();

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(signal) {
    console.log(
        `[SERVER] ${signal} received. Shutting down...`
    );

    for (
        const [
            pairingId,
            sock
        ] of sockets.entries()
    ) {
        try {
            console.log(
                `[SERVER] Closing socket: ${pairingId}`
            );

            if (
                sock &&
                typeof sock.end ===
                    "function"
            ) {
                sock.end(
                    undefined
                );
            }

        } catch (error) {
            console.error(
                `[SERVER] Failed closing ${pairingId}:`,
                error.message
            );
        }
    }

    sockets.clear();

    process.exit(0);
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);
