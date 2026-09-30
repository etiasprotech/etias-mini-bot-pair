"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const pino = require("pino");
const QRCode = require("qrcode");
const crypto = require("crypto");

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
    generateAndSendSession,
    getDeploymentCodeStatus,
    deleteDeploymentCode
} = require("./session");

const app = express();

const PORT =
    process.env.PORT || 3000;

const ROOT = __dirname;

const AUTH_DIR =
    path.join(ROOT, "auth");

const DATA_DIR =
    path.join(ROOT, "data");

const MEDIA_DIR =
    path.join(ROOT, "media");

const TEMP_AUTH_DIR =
    path.join(ROOT, "temp_auth");

const BOT_NAME =
    process.env.BOT_NAME ||
    "ETIAS-MINI-BOT";

/*
 * Shared secret used by the bot deployment
 * server when requesting authentication files.
 *
 * Set the SAME value on both Render services:
 *
 * SESSION_TRANSFER_SECRET=some-long-random-secret
 */

const SESSION_TRANSFER_SECRET =
    process.env.SESSION_TRANSFER_SECRET ||
    "";

const SESSION_ID_REGEX =
    /^ETIAS-MINI-BOT~\d{8}$/i;

const logger = pino({
    level:
        process.env.LOG_LEVEL ||
        "silent"
});

const sockets = new Map();

const reconnecting =
    new Set();

/* =========================================================
   DIRECTORIES
========================================================= */

async function ensureDirectories() {

    await fsp.mkdir(
        AUTH_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        DATA_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        MEDIA_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        TEMP_AUTH_DIR,
        {
            recursive: true
        }
    );
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function cleanNumber(number) {

    return String(number || "")
        .replace(/\D/g, "");
}

function normalizeJid(jid) {

    if (!jid) {
        return null;
    }

    return String(jid)
        .trim()
        .replace(
            /:\d+(?=@)/,
            ""
        );
}

function normalizeSessionId(value) {

    return String(value || "")
        .trim()
        .replace(
            /^\[\s*/,
            ""
        )
        .replace(
            /\s*\]$/,
            ""
        );
}

function isValidSessionId(sessionId) {

    return SESSION_ID_REGEX.test(
        sessionId
    );
}

/* =========================================================
   SESSION ID
========================================================= */

function generateSessionId() {

    const number =
        crypto
            .randomInt(
                0,
                100000000
            )
            .toString()
            .padStart(
                8,
                "0"
            );

    return `${BOT_NAME}~${number}`;
}

/*
 * Keep the session ID prefix fixed even if
 * BOT_NAME is changed accidentally.
 */

function generateEtiasSessionId() {

    const number =
        crypto
            .randomInt(
                0,
                100000000
            )
            .toString()
            .padStart(
                8,
                "0"
            );

    return `ETIAS-MINI-BOT~${number}`;
}

/* =========================================================
   AUTH FOLDER
========================================================= */

function getSessionAuthFolder(
    sessionId
) {

    const clean =
        normalizeSessionId(
            sessionId
        );

    if (
        !isValidSessionId(
            clean
        )
    ) {
        throw new Error(
            "Invalid Session ID"
        );
    }

    const suffix =
        clean
            .split("~")[1];

    return path.join(
        AUTH_DIR,
        `ETIAS-MINI-BOT_${suffix}`
    );
}

/* =========================================================
   DISCONNECT
========================================================= */

function getDisconnectCode(
    lastDisconnect
) {

    return (
        lastDisconnect?.error
            ?.output?.statusCode ||

        lastDisconnect?.error
            ?.data?.statusCode ||

        lastDisconnect?.error
            ?.statusCode ||

        null
    );
}

function isLoggedOut(code) {

    return (
        code ===
        DisconnectReason.loggedOut
    );
}

function isBadSession(code) {

    return (
        code ===
        DisconnectReason.badSession
    );
}

function isRestartRequired(code) {

    return (
        code ===
        DisconnectReason.restartRequired
    );
}

/* =========================================================
   FIND SESSION
========================================================= */

function findPairingBySessionId(
    sessionId
) {

    const clean =
        normalizeSessionId(
            sessionId
        );

    return getAllPairings()
        .find(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) === clean
        );
}

/* =========================================================
   SAVE SUCCESSFUL DEPLOYMENT
========================================================= */

async function saveSuccessfulDeployment(
    pairingId,
    number,
    jid,
    authFolder,
    sessionId
) {

    const now =
        new Date().toISOString();

    updatePairing(
        pairingId,
        {

            status:
                "deployed",

            connected:
                true,

            sent:
                true,

            jid,

            authFolder,

            sessionId,

            deployedAt:
                now
        }
    );

    await addDeployedUser({

        id:
            generateUserId(),

        pairingId,

        sessionId,

        number,

        jid,

        authFolder,

        status:
            "deployed",

        connected:
            true,

        sent:
            true,

        deployedAt:
            now,

        createdAt:
            now
    });
}

/* =========================================================
   START WHATSAPP PAIRING
========================================================= */

async function startPairing(
    number,
    pairingId,
    existingAuthFolder = null,
    existingSessionId = null
) {

    const clean =
        cleanNumber(number);

    if (!clean) {

        throw new Error(
            "Invalid phone number"
        );
    }

    /*
     * Create the REAL session ID before
     * creating the authentication folder.
     */

    const sessionId =
        existingSessionId ||
        generateEtiasSessionId();

    if (
        !isValidSessionId(
            sessionId
        )
    ) {

        throw new Error(
            "Generated invalid Session ID"
        );
    }

    /*
     * Authentication folder is now tied
     * directly to the Session ID.
     *
     * Example:
     *
     * auth/
     *   ETIAS-MINI-BOT_43340319/
     */

    let authFolder =
        existingAuthFolder;

    if (!authFolder) {

        authFolder =
            getSessionAuthFolder(
                sessionId
            );
    }

    await fsp.mkdir(
        authFolder,
        {
            recursive:
                true
        }
    );

    console.log(
        "========================================"
    );

    console.log(
        `[PAIR] Session ID: ${sessionId}`
    );

    console.log(
        `[PAIR] Phone: +${clean}`
    );

    console.log(
        `[PAIR] Auth folder: ${authFolder}`
    );

    console.log(
        "========================================"
    );

    /*
     * Store the Session ID immediately.
     */

    updatePairing(
        pairingId,
        {

            sessionId,

            number:
                clean,

            authFolder,

            status:
                "starting",

            connected:
                false

        }
    );

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            authFolder
        );

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

            markOnlineOnConnect:
                false,

            syncFullHistory:
                false,

            generateHighQualityLinkPreview:
                false,

            connectTimeoutMs:
                60000,

            defaultQueryTimeoutMs:
                60000,

            keepAliveIntervalMs:
                25000

        });

    sockets.set(
        pairingId,
        sock
    );

    updatePairing(
        pairingId,
        {

            sessionId,

            status:
                "connecting",

            connected:
                false,

            authFolder

        }
    );

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

                        sessionId,

                        status:
                            "qr",

                        connected:
                            false

                    }
                );

                try {

                    const qrData =
                        await QRCode.toDataURL(
                            qr
                        );

                    updatePairing(
                        pairingId,
                        {

                            qrImage:
                                qrData

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

            if (
                connection ===
                "connecting"
            ) {

                console.log(
                    `[PAIR] Connecting: ${pairingId}`
                );

                updatePairing(
                    pairingId,
                    {

                        sessionId,

                        status:
                            "connecting",

                        connected:
                            false

                    }
                );
            }

            /* =================================================
               OPEN
            ================================================= */

            if (
                connection ===
                "open"
            ) {

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
                    `SESSION ID: ${sessionId}`
                );

                console.log(
                    `JID: ${
                        sock.user?.id ||
                        "unknown"
                    }`
                );

                console.log(
                    `AUTH: ${authFolder}`
                );

                console.log(
                    "========================================"
                );

                try {

                    /*
                     * Make sure the latest credentials
                     * are written to disk.
                     */

                    await sleep(
                        2500
                    );

                    await saveCreds();

                    await sleep(
                        1000
                    );

                    const authenticatedJid =
                        sock.user?.id;

                    if (
                        !authenticatedJid
                    ) {

                        throw new Error(
                            "Authenticated WhatsApp JID unavailable"
                        );
                    }

                    const normalizedJid =
                        normalizeJid(
                            authenticatedJid
                        );

                    updatePairing(
                        pairingId,
                        {

                            sessionId,

                            status:
                                "generating_session",

                            connected:
                                true,

                            jid:
                                authenticatedJid,

                            authFolder

                        }
                    );

                    console.log(
                        `[SESSION] Sending ${sessionId} to WhatsApp...`
                    );

                    /*
                     * session.js now sends:
                     *
                     * ETIAS-MINI-BOT~12345678
                     *
                     * instead of the old 8-digit
                     * deployment code.
                     */

                    const result =
                        await generateAndSendSession(

                            sock,

                            authFolder,

                            authenticatedJid,

                            pairingId,

                            normalizedJid

                        );

                    if (
                        !result ||
                        !result.sessionId ||
                        !isValidSessionId(
                            result.sessionId
                        )
                    ) {

                        throw new Error(
                            "Invalid Session ID returned by session.js"
                        );
                    }

                    /*
                     * Make absolutely sure the ID
                     * generated by session.js matches
                     * the pairing record.
                     */

                    if (
                        result.sessionId !==
                        sessionId
                    ) {

                        throw new Error(
                            "Session ID mismatch between pairing server and session.js"
                        );
                    }

                    updatePairing(
                        pairingId,
                        {

                            sessionId,

                            status:
                                "awaiting_deployment",

                            connected:
                                true,

                            sent:
                                true,

                            jid:
                                authenticatedJid,

                            authFolder,

                            codeExpiresAt:
                                result.expiresAt

                        }
                    );

                    console.log(
                        "========================================"
                    );

                    console.log(
                        "📲 SESSION ID SENT TO WHATSAPP"
                    );

                    console.log(
                        `SESSION ID: ${sessionId}`
                    );

                    console.log(
                        `JID: ${authenticatedJid}`
                    );

                    console.log(
                        "Waiting for deployment..."
                    );

                    console.log(
                        "========================================"
                    );

                } catch (error) {

                    console.error(
                        "[SESSION ERROR]",
                        error
                    );

                    updatePairing(
                        pairingId,
                        {

                            status:
                                "deployment_error",

                            connected:
                                true,

                            sent:
                                false,

                            sessionId,

                            error:
                                error.message ||
                                String(error)

                        }
                    );
                }
            }

            /* =================================================
               CLOSE
            ================================================= */

            if (
                connection ===
                "close"
            ) {

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

                if (
                    isLoggedOut(code)
                ) {

                    console.log(
                        "[PAIR] ❌ WhatsApp logged out"
                    );

                    updatePairing(
                        pairingId,
                        {

                            sessionId,

                            status:
                                "logged_out",

                            connected:
                                false

                        }
                    );

                    return;
                }

                if (
                    isBadSession(code)
                ) {

                    console.log(
                        "[PAIR] ❌ Bad session"
                    );

                    updatePairing(
                        pairingId,
                        {

                            sessionId,

                            status:
                                "bad_session",

                            connected:
                                false

                        }
                    );

                    return;
                }

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

                updatePairing(
                    pairingId,
                    {

                        sessionId,

                        status:
                            "reconnecting",

                        connected:
                            false

                    }
                );

                console.log(
                    "[PAIR] 🔄 Reconnecting..."
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

                                authFolder,

                                sessionId

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

                                    sessionId,

                                    status:
                                        "error",

                                    connected:
                                        false,

                                    error:
                                        error.message

                                }
                            );
                        }

                    },

                    isRestartRequired(
                        code
                    )
                        ? 1000
                        : 3000
                );
            }
        }
    );

    /* =====================================================
       WHATSAPP PAIRING CODE
    ===================================================== */

    if (
        !state.creds.registered
    ) {

        try {

            console.log(
                "[PAIR] Waiting before requesting pairing code..."
            );

            await sleep(
                5000
            );

            if (
                sockets.get(
                    pairingId
                ) !== sock
            ) {

                throw new Error(
                    "Pairing socket is no longer active"
                );
            }

            let pairingCode =
                null;

            let lastError =
                null;

            for (
                let attempt = 1;
                attempt <= 3;
                attempt++
            ) {

                try {

                    console.log(
                        `[PAIR] Requesting WhatsApp pairing code ${attempt}/3...`
                    );

                    pairingCode =
                        await sock.requestPairingCode(
                            clean
                        );

                    if (
                        pairingCode
                    ) {

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

            if (
                !pairingCode
            ) {

                throw (
                    lastError ||
                    new Error(
                        "Failed to generate WhatsApp pairing code"
                    )
                );
            }

            console.log(
                `[PAIR] WhatsApp pairing code generated for ${clean}`
            );

            /*
             * This is the WhatsApp login code.
             *
             * It is NOT the Session ID.
             */

            updatePairing(
                pairingId,
                {

                    sessionId,

                    status:
                        "pairing_code",

                    pairingCode,

                    connected:
                        false,

                    authFolder

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

                    sessionId,

                    status:
                        "error",

                    connected:
                        false,

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
   EXPRESS
========================================================= */

app.use(
    express.json({
        limit:
            "10mb"
    })
);

app.use(
    express.urlencoded({
        extended:
            true,

        limit:
            "10mb"
    })
);

app.use(
    express.static(
        ROOT
    )
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
   PAIR
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
   QR
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

            status:
                "ok",

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

            status:
                "online",

            sockets:
                sockets.size,

            pairings:
                getAllPairings()
                    .length,

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

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Phone number is required"

                });
            }

            const existing =
                getAllPairings()
                    .find(
                        item =>

                            item.number ===
                                number &&

                            [
                                "starting",
                                "connecting",
                                "pairing_code",
                                "qr",
                                "reconnecting",
                                "generating_session",
                                "awaiting_deployment",
                                "deployed"
                            ].includes(
                                item.status
                            )
                    );

            if (existing) {

                return res.json({

                    success:
                        true,

                    pairingId:
                        existing.id,

                    sessionId:
                        existing.sessionId ||
                        null,

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
             * Generate the real Session ID now.
             */

            const sessionId =
                generateEtiasSessionId();

            updatePairing(
                pairing.id,
                {

                    sessionId,

                    number,

                    status:
                        "starting"

                }
            );

            startPairing(
                number,

                pairing.id,

                null,

                sessionId

            ).catch(
                error => {

                    console.error(
                        "[PAIR] Startup error:",
                        error
                    );

                    updatePairing(
                        pairing.id,
                        {

                            sessionId,

                            status:
                                "error",

                            error:
                                error.message ||
                                String(error)

                        }
                    );
                }
            );

            await sleep(
                1200
            );

            const current =
                getPairing(
                    pairing.id
                );

            return res.json({

                success:
                    true,

                pairingId:
                    pairing.id,

                sessionId,

                number,

                status:
                    current?.status ||
                    "starting",

                message:
                    "Pairing started. Use the WhatsApp pairing code. After successful pairing, your Session ID will be sent to WhatsApp."

            });

        } catch (error) {

            return res.status(
                500
            ).json({

                success:
                    false,

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

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Pairing ID not found"

            });
        }

        const safePairing = {
            ...pairing
        };

        /*
         * Never expose the WhatsApp pairing
         * login code through status.
         */

        delete safePairing
            .pairingCode;

        delete safePairing
            .deploymentCode;

        res.json({

            success:
                true,

            ...safePairing

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

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Pairing ID not found"

            });
        }

        res.json({

            success:
                true,

            id:
                pairing.id,

            number:
                pairing.number,

            sessionId:
                pairing.sessionId ||
                null,

            status:
                pairing.status,

            connected:
                pairing.connected,

            sent:
                pairing.sent,

            jid:
                pairing.jid ||
                null,

            codeExpiresAt:
                pairing.codeExpiresAt ||
                null,

            error:
                pairing.error ||
                null

        });
    }
);

/* =========================================================
   SESSION LOOKUP
========================================================= */

app.get(
    "/session/:sessionId",
    (req, res) => {

        try {

            const sessionId =
                normalizeSessionId(
                    req.params.sessionId
                );

            if (
                !isValidSessionId(
                    sessionId
                )
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Invalid Session ID"

                });
            }

            const pairing =
                findPairingBySessionId(
                    sessionId
                );

            if (!pairing) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Session ID not found"

                });
            }

            const authFolder =
                pairing.authFolder;

            const authExists =
                authFolder &&
                fs.existsSync(
                    path.join(
                        authFolder,
                        "creds.json"
                    )
                );

            return res.json({

                success:
                    true,

                sessionId,

                number:
                    pairing.number ||
                    null,

                jid:
                    pairing.jid ||
                    null,

                pairingId:
                    pairing.id,

                status:
                    pairing.status,

                connected:
                    pairing.connected ===
                    true,

                authenticated:
                    authExists,

                authAvailable:
                    authExists

            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message

            });
        }
    }
);

/* =========================================================
   AUTH EXPORT
========================================================= */

/*
 * The bot deployment server uses this endpoint
 * to obtain the authenticated Baileys state.
 *
 * It requires:
 *
 * x-session-transfer-secret
 *
 * with the same SESSION_TRANSFER_SECRET on
 * both services.
 */

app.get(
    "/session/:sessionId/auth",
    async (req, res) => {

        try {

            if (
                !SESSION_TRANSFER_SECRET
            ) {

                return res.status(
                    503
                ).json({

                    success:
                        false,

                    error:
                        "SESSION_TRANSFER_SECRET is not configured"

                });
            }

            const suppliedSecret =
                String(
                    req.headers[
                        "x-session-transfer-secret"
                    ] || ""
                );

            if (
                suppliedSecret !==
                SESSION_TRANSFER_SECRET
            ) {

                return res.status(
                    401
                ).json({

                    success:
                        false,

                    error:
                        "Unauthorized"

                });
            }

            const sessionId =
                normalizeSessionId(
                    req.params.sessionId
                );

            if (
                !isValidSessionId(
                    sessionId
                )
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Invalid Session ID"

                });
            }

            const pairing =
                findPairingBySessionId(
                    sessionId
                );

            if (!pairing) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Session ID not found"

                });
            }

            if (
                pairing.connected !==
                true
            ) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "WhatsApp session is not connected"

                });
            }

            const authFolder =
                pairing.authFolder;

            if (
                !authFolder ||
                !fs.existsSync(
                    authFolder
                )
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Authentication folder not found"

                });
            }

            /*
             * Read all auth files recursively.
             */

            async function readAuthFiles(
                directory,
                relative = ""
            ) {

                const entries =
                    await fsp.readdir(
                        directory,
                        {
                            withFileTypes:
                                true
                        }
                    );

                const output = [];

                for (
                    const entry of entries
                ) {

                    const fullPath =
                        path.join(
                            directory,
                            entry.name
                        );

                    const relativePath =
                        path.join(
                            relative,
                            entry.name
                        );

                    if (
                        entry.isDirectory()
                    ) {

                        const nested =
                            await readAuthFiles(
                                fullPath,
                                relativePath
                            );

                        output.push(
                            ...nested
                        );

                    } else {

                        const buffer =
                            await fsp.readFile(
                                fullPath
                            );

                        output.push({

                            path:
                                relativePath
                                    .replace(
                                        /\\/g,
                                        "/"
                                    ),

                            data:
                                buffer.toString(
                                    "base64"
                                )

                        });
                    }
                }

                return output;
            }

            const files =
                await readAuthFiles(
                    authFolder
                );

            /*
             * Make sure creds.json exists.
             */

            const hasCreds =
                files.some(
                    file =>
                        file.path ===
                        "creds.json"
                );

            if (!hasCreds) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "creds.json is not available yet"

                });
            }

            return res.json({

                success:
                    true,

                sessionId,

                number:
                    pairing.number,

                jid:
                    pairing.jid,

                files

            });

        } catch (error) {

            console.error(
                "[AUTH EXPORT]",
                error
            );

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)

            });
        }
    }
);

/* =========================================================
   DEPLOYMENT STATUS
========================================================= */

app.get(
    "/deployment-status/:id",
    (req, res) => {

        const status =
            getDeploymentCodeStatus(
                req.params.id
            );

        if (!status) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Deployment session not found or expired"

            });
        }

        res.json({

            success:
                true,

            pairingId:
                status.pairingId,

            sessionId:
                status.sessionId ||
                null,

            jid:
                status.jid,

            expiresAt:
                status.expiresAt,

            used:
                status.used

        });
    }
);

/* =========================================================
   DEPLOY
========================================================= */

/*
 * This endpoint now accepts:
 *
 * {
 *   sessionId:
 *     "ETIAS-MINI-BOT~43340319"
 * }
 *
 * instead of requiring the old 8-digit
 * deployment code.
 */

app.post(
    "/deploy",
    async (req, res) => {

        try {

            const sessionId =
                normalizeSessionId(
                    req.body.sessionId
                );

            if (
                !isValidSessionId(
                    sessionId
                )
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Valid Session ID is required. Example: ETIAS-MINI-BOT~43340319"

                });
            }

            const pairing =
                findPairingBySessionId(
                    sessionId
                );

            if (!pairing) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "This Session ID does not exist on the pairing server"

                });
            }

            if (
                pairing.connected !==
                true
            ) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "The WhatsApp number belonging to this Session ID is not connected"

                });
            }

            if (
                !pairing.authFolder
            ) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "Authentication folder is unavailable"

                });
            }

            const credsPath =
                path.join(
                    pairing.authFolder,
                    "creds.json"
                );

            if (
                !fs.existsSync(
                    credsPath
                )
            ) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "WhatsApp credentials are not ready"

                });
            }

            console.log(
                "========================================"
            );

            console.log(
                "🎉 SESSION ID VERIFIED"
            );

            console.log(
                `SESSION: ${sessionId}`
            );

            console.log(
                `PHONE: +${pairing.number}`
            );

            console.log(
                `JID: ${pairing.jid}`
            );

            console.log(
                `AUTH: ${pairing.authFolder}`
            );

            console.log(
                "========================================"
            );

            /*
             * Mark the pairing as deployed.
             */

            await saveSuccessfulDeployment(

                pairing.id,

                pairing.number,

                pairing.jid,

                pairing.authFolder,

                sessionId

            );

            return res.json({

                success:
                    true,

                message:
                    "Session ID verified successfully",

                sessionId,

                number:
                    pairing.number,

                jid:
                    pairing.jid,

                authAvailable:
                    true,

                status:
                    "deployed"

            });

        } catch (error) {

            console.error(
                "[DEPLOY ERROR]",
                error
            );

            return res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)

            });
        }
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

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Pairing ID required"

                });
            }

            const pairing =
                getPairing(id);

            if (!pairing) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Pairing ID not found"

                });
            }

            if (
                !pairing.qrImage
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "QR code not available"

                });
            }

            res.type(
                "png"
            );

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

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)

            });
        }
    }
);

/* =========================================================
   DEPLOYED LIST
========================================================= */

app.get(
    "/deployed-list",
    async (req, res) => {

        try {

            const users =
                await loadDeployed();

            const safeUsers =
                users.map(
                    user => {

                        const copy = {
                            ...user
                        };

                        delete copy
                            .deploymentCode;

                        delete copy
                            .authFolder;

                        /*
                         * Do not expose credentials.
                         */

                        return copy;
                    }
                );

            res.json({

                success:
                    true,

                count:
                    safeUsers.length,

                users:
                    safeUsers

            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

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

                success:
                    true,

                total:
                    users.length

            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

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
                        user.connected ===
                        true
                ).length;

            const sent =
                users.filter(
                    user =>
                        user.sent ===
                        true
                ).length;

            const deployed =
                users.filter(
                    user =>
                        user.status ===
                        "deployed"
                ).length;

            res.json({

                success:
                    true,

                total:
                    users.length,

                connected,

                sent,

                deployed

            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

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

        res.status(
            404
        ).json({

            success:
                false,

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

        res.status(
            404
        ).json({

            success:
                false,

            error:
                "Route not found",

            path:
                req.path

        });
    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "[EXPRESS ERROR]",
            err
        );

        if (
            res.headersSent
        ) {

            return next(err);
        }

        res.status(
            500
        ).json({

            success:
                false,

            error:
                err.message ||
                "Internal server error"

        });
    }
);

/* =========================================================
   START
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
                    `🔐 AUTH TRANSFER: ${
                        SESSION_TRANSFER_SECRET
                            ? "ENABLED"
                            : "DISABLED"
                    }`
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

        process.exit(
            1
        );
    }
}

startServer();

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
    signal
) {

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

    process.exit(
        0
    );
}

process.on(
    "SIGINT",
    () =>
        shutdown(
            "SIGINT"
        )
);

process.on(
    "SIGTERM",
    () =>
        shutdown(
            "SIGTERM"
        )
);
