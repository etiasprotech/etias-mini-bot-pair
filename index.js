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
    generateAndSendSession,
    verifyDeploymentCode,
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

const logger = pino({
    level:
        process.env.LOG_LEVEL ||
        "silent"
});

const sockets = new Map();
const reconnecting = new Set();

/* =========================================================
   DIRECTORIES
========================================================= */

async function ensureDirectories() {
    await fsp.mkdir(
        AUTH_DIR,
        { recursive: true }
    );

    await fsp.mkdir(
        DATA_DIR,
        { recursive: true }
    );

    await fsp.mkdir(
        MEDIA_DIR,
        { recursive: true }
    );

    await fsp.mkdir(
        TEMP_AUTH_DIR,
        { recursive: true }
    );
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(resolve, ms)
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
        .replace(/:\d+(?=@)/, "");
}

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
   SAVE SUCCESSFUL DEPLOYMENT
========================================================= */

async function saveSuccessfulDeployment(
    pairingId,
    number,
    jid,
    authFolder
) {
    const now =
        new Date().toISOString();

    updatePairing(
        pairingId,
        {
            status: "deployed",
            connected: true,
            sent: true,
            jid,
            authFolder,
            deployedAt: now
        }
    );

    await addDeployedUser({
        id:
            generateUserId(),

        pairingId,

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
    existingAuthFolder = null
) {
    const clean =
        cleanNumber(number);

    if (!clean) {
        throw new Error(
            "Invalid phone number"
        );
    }

    let authFolder =
        existingAuthFolder;

    if (!authFolder) {
        authFolder =
            path.join(
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

            /* =============================================
               QR
            ============================================= */

            if (qr) {
                updatePairing(
                    pairingId,
                    {
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

            /* =============================================
               CONNECTING
            ============================================= */

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
                        status:
                            "connecting",

                        connected:
                            false
                    }
                );
            }

            /* =============================================
               OPEN
            ============================================= */

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
                    `JID: ${
                        sock.user?.id ||
                        "unknown"
                    }`
                );

                console.log(
                    "========================================"
                );

                try {
                    /*
                     * Allow credential writes to finish.
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

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "generating_code",

                            connected:
                                true,

                            jid:
                                authenticatedJid,

                            authFolder
                        }
                    );

                    console.log(
                        "[DEPLOYMENT] Generating 8-digit code..."
                    );

                    /*
                     * Generates the one-time deployment
                     * code and sends it directly to WhatsApp.
                     */
                    const result =
                        await generateAndSendSession(
                            sock,
                            authFolder,
                            authenticatedJid,
                            pairingId,
                            normalizedJid
                        );

                    const deploymentCode =
                        result.deploymentCode ||
                        result.sessionId;

                    if (!deploymentCode) {
                        throw new Error(
                            "Deployment code was not generated"
                        );
                    }

                    console.log(
                        "[DEPLOYMENT] Code sent successfully"
                    );

                    /*
                     * Do not put the actual code into
                     * the public pairing status.
                     */
                    updatePairing(
                        pairingId,
                        {
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
                        "📲 DEPLOYMENT CODE SENT"
                    );

                    console.log(
                        `PAIR ID: ${pairingId}`
                    );

                    console.log(
                        `JID: ${authenticatedJid}`
                    );

                    console.log(
                        "Waiting for code on deployment page..."
                    );

                    console.log(
                        "========================================"
                    );

                } catch (error) {
                    console.error(
                        "[DEPLOYMENT ERROR]",
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

                            error:
                                error.message ||
                                String(error)
                        }
                    );
                }
            }

            /* =============================================
               CLOSE
            ============================================= */

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

                /* =========================================
                   LOGGED OUT
                ========================================= */

                if (
                    isLoggedOut(code)
                ) {
                    console.log(
                        "[PAIR] ❌ WhatsApp logged out"
                    );

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "logged_out",

                            connected:
                                false
                        }
                    );

                    return;
                }

                /* =========================================
                   BAD SESSION
                ========================================= */

                if (
                    isBadSession(code)
                ) {
                    console.log(
                        "[PAIR] ❌ Bad session"
                    );

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "bad_session",

                            connected:
                                false
                        }
                    );

                    return;
                }

                /* =========================================
                   PREVENT DUPLICATE RECONNECT
                ========================================= */

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
       REQUEST PAIRING CODE
    ===================================================== */

    if (
        !state.creds.registered
    ) {
        try {
            console.log(
                "[PAIR] Waiting before requesting pairing code..."
            );

            await sleep(5000);

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
                        `[PAIR] Requesting pairing code ${attempt}/3...`
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

            if (!pairingCode) {
                throw (
                    lastError ||
                    new Error(
                        "Failed to generate WhatsApp pairing code"
                    )
                );
            }

            console.log(
                `[PAIR] Pairing code: ${pairingCode}`
            );

            updatePairing(
                pairingId,
                {
                    status:
                        "pairing_code",

                    pairingCode,

                    connected:
                        false
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
                                "generating_code",
                                "awaiting_deployment"
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

            startPairing(
                number,
                pairing.id
            ).catch(
                error => {
                    console.error(
                        "[PAIR] Startup error:",
                        error
                    );

                    updatePairing(
                        pairing.id,
                        {
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

                number,

                status:
                    current?.status ||
                    "starting",

                message:
                    "Pairing started. Wait for the deployment code."
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

        /*
         * Never return a deployment code
         * from this endpoint.
         */
        const safePairing = {
            ...pairing
        };

        delete safePairing
            .deploymentCode;

        delete safePairing
            .sessionId;

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
   DEPLOYMENT CODE STATUS
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
                    "Deployment code not found or expired"
            });
        }

        res.json({
            success:
                true,

            pairingId:
                status.pairingId,

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

app.post(
    "/deploy",
    async (req, res) => {
        try {
            const {
                pairingId,
                code
            } = req.body;

            if (!pairingId) {
                return res.status(
                    400
                ).json({
                    success:
                        false,

                    error:
                        "pairingId is required"
                });
            }

            if (!code) {
                return res.status(
                    400
                ).json({
                    success:
                        false,

                    error:
                        "8-digit deployment code is required"
                });
            }

            const pairing =
                getPairing(
                    pairingId
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

            /*
             * Verify the one-time code.
             */
            const verification =
                verifyDeploymentCode(
                    pairingId,
                    String(code)
                        .trim()
                );

            if (
                !verification.success
            ) {
                return res.status(
                    401
                ).json({
                    success:
                        false,

                    error:
                        verification.error
                });
            }

            /*
             * Verify the original socket still exists.
             */
            const sock =
                sockets.get(
                    pairingId
                );

            if (!sock) {
                return res.status(
                    410
                ).json({
                    success:
                        false,

                    error:
                        "WhatsApp connection is no longer active"
                });
            }

            /*
             * Make sure the pairing was actually
             * connected before deployment.
             */
            if (
                !pairing.connected
            ) {
                return res.status(
                    409
                ).json({
                    success:
                        false,

                    error:
                        "WhatsApp account is not connected"
                });
            }

            /*
             * Persist the deployment.
             */
            await saveSuccessfulDeployment(
                pairingId,
                pairing.number,
                verification.jid,
                verification.authFolder
            );

            console.log(
                "========================================"
            );

            console.log(
                "🎉 DEPLOYMENT VERIFIED"
            );

            console.log(
                `PAIR ID: ${pairingId}`
            );

            console.log(
                `JID: ${verification.jid}`
            );

            console.log(
                "AUTH STATE: STORED SERVER-SIDE"
            );

            console.log(
                "========================================"
            );

            res.json({
                success:
                    true,

                message:
                    "Deployment verified successfully.",

                pairingId,

                jid:
                    verification.jid,

                status:
                    "deployed"
            });

        } catch (error) {
            console.error(
                "[DEPLOY ERROR]",
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

            if (!pairing.qrImage) {
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
                        const copy =
                            {
                                ...user
                            };

                        /*
                         * Never expose auth
                         * credentials or codes.
                         */
                        delete copy.sessionId;

                        delete copy
                            .deploymentCode;

                        delete copy
                            .authFolder;

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
        shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () =>
        shutdown("SIGTERM")
);
