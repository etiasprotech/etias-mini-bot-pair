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

/*
 * IMPORTANT:
 *
 * session.js owns data/sessions.json.
 *
 * DO NOT use the same file here.
 */
const PAIRING_REGISTRY_FILE = path.join(
    DATA_DIR,
    "pairing-registry.json"
);

const BOT_NAME = process.env.BOT_NAME || "ETIAS-MINI-BOT";

const SESSION_TRANSFER_SECRET =
    process.env.SESSION_TRANSFER_SECRET || "";

const SESSION_PREFIX = "ETIAS-MINI-BOT~";

const SESSION_REGEX =
    /^ETIAS-MINI-BOT~\d{8}$/;

const logger = pino({
    level: process.env.LOG_LEVEL || "info"
});

const sockets = new Map();
const reconnecting = new Set();
const pairingLocks = new Set();

let registryWriteQueue = Promise.resolve();

/* ============================================================
   DIRECTORIES
============================================================ */

async function ensureDirectories() {
    await fsp.mkdir(AUTH_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(MEDIA_DIR, { recursive: true });

    try {
        await fsp.access(PAIRING_REGISTRY_FILE);
    } catch {
        await fsp.writeFile(
            PAIRING_REGISTRY_FILE,
            "{}",
            "utf8"
        );
    }
}

/* ============================================================
   HELPERS
============================================================ */

function cleanNumber(value) {
    return String(value || "")
        .replace(/[^\d]/g, "");
}

function normalizeJid(jid) {
    if (!jid) return null;

    return String(jid)
        .trim()
        .replace(/^jid:/i, "");
}

function normalizeSessionId(value) {
    if (!value) return null;

    return String(value)
        .trim()
        .toUpperCase();
}

function isValidSessionId(value) {
    return SESSION_REGEX.test(
        normalizeSessionId(value) || ""
    );
}

function getDisconnectCode(lastDisconnect) {
    return (
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.data?.statusCode ||
        lastDisconnect?.statusCode ||
        null
    );
}

function isLoggedOut(code) {
    return code === DisconnectReason.loggedOut;
}

function isConflict(code) {
    return (
        code === DisconnectReason.connectionReplaced ||
        code === 440 ||
        code ===  conflictCode()
    );
}

function conflictCode() {
    return 440;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   REGISTRY
============================================================ */

async function readSessionRegistry() {
    try {
        const raw = await fsp.readFile(
            PAIRING_REGISTRY_FILE,
            "utf8"
        );

        if (!raw.trim()) return {};

        const parsed = JSON.parse(raw);

        if (!parsed || typeof parsed !== "object") {
            return {};
        }

        return parsed;
    } catch (error) {
        logger.warn(
            {
                error: error.message
            },
            "[REGISTRY] Could not read registry"
        );

        return {};
    }
}

function writeSessionRegistry(registry) {
    registryWriteQueue =
        registryWriteQueue
            .then(async () => {
                const tmp =
                    `${PAIRING_REGISTRY_FILE}.tmp`;

                await fsp.writeFile(
                    tmp,
                    JSON.stringify(
                        registry,
                        null,
                        2
                    ),
                    "utf8"
                );

                await fsp.rename(
                    tmp,
                    PAIRING_REGISTRY_FILE
                );
            })
            .catch(error => {
                logger.error(
                    {
                        error: error.message
                    },
                    "[REGISTRY] Write failed"
                );
            });

    return registryWriteQueue;
}

async function savePairingRegistryRecord(
    sessionId,
    record
) {
    if (!sessionId) return;

    const registry =
        await readSessionRegistry();

    registry[sessionId] = {
        ...registry[sessionId],
        ...record,
        sessionId,
        updatedAt: new Date().toISOString()
    };

    await writeSessionRegistry(registry);
}

async function getPairingRegistryRecord(
    sessionId
) {
    const registry =
        await readSessionRegistry();

    return (
        registry[
            normalizeSessionId(sessionId)
        ] || null
    );
}

/* ============================================================
   SESSION LOOKUP
============================================================ */

/*
 * session.js is the PRIMARY source of truth
 * for the final ETIAS-MINI-BOT~XXXXXXXX Session ID.
 *
 * id.js / pairing-registry are used for current
 * pairing/socket state.
 */

async function findSessionEverywhere(sessionId) {
    const normalized =
        normalizeSessionId(sessionId);

    if (!isValidSessionId(normalized)) {
        return null;
    }

    let sessionRecord = null;
    let pairingRecord = null;
    let registryRecord = null;

    try {
        sessionRecord =
            await Promise.resolve(
                getSessionById(normalized)
            );
    } catch (error) {
        logger.warn(
            {
                error: error.message,
                sessionId: normalized
            },
            "[SESSION] session.js lookup failed"
        );
    }

    try {
        const pairings =
            await Promise.resolve(
                getAllPairings()
            );

        if (Array.isArray(pairings)) {
            pairingRecord =
                pairings.find(
                    item =>
                        normalizeSessionId(
                            item?.sessionId
                        ) === normalized
                ) || null;
        } else if (
            pairings &&
            typeof pairings === "object"
        ) {
            pairingRecord =
                Object.values(pairings)
                    .find(
                        item =>
                            normalizeSessionId(
                                item?.sessionId
                            ) === normalized
                    ) || null;
        }
    } catch (error) {
        logger.warn(
            {
                error: error.message,
                sessionId: normalized
            },
            "[SESSION] Pairing lookup failed"
        );
    }

    registryRecord =
        await getPairingRegistryRecord(
            normalized
        );

    if (
        !sessionRecord &&
        !pairingRecord &&
        !registryRecord
    ) {
        return null;
    }

    return {
        ...(registryRecord || {}),
        ...(pairingRecord || {}),
        ...(sessionRecord || {}),
        sessionId: normalized,

        pairingId:
            sessionRecord?.pairingId ||
            pairingRecord?.pairingId ||
            registryRecord?.pairingId ||
            null,

        jid:
            sessionRecord?.jid ||
            pairingRecord?.jid ||
            registryRecord?.jid ||
            null,

        number:
            sessionRecord?.number ||
            pairingRecord?.number ||
            registryRecord?.number ||
            null,

        authFolder:
            sessionRecord?.authFolder ||
            pairingRecord?.authFolder ||
            registryRecord?.authFolder ||
            null
    };
}

/* ============================================================
   AUTH HELPERS
============================================================ */

async function authExists(authFolder) {
    if (!authFolder) return false;

    try {
        const creds =
            path.join(
                authFolder,
                "creds.json"
            );

        await fsp.access(creds);

        return true;
    } catch {
        return false;
    }
}

async function readAuthFiles(
    directory
) {
    const files = [];

    async function walk(current) {
        let entries;

        try {
            entries =
                await fsp.readdir(
                    current,
                    {
                        withFileTypes: true
                    }
                );
        } catch {
            return;
        }

        for (const entry of entries) {
            const full =
                path.join(
                    current,
                    entry.name
                );

            if (entry.isSymbolicLink()) {
                continue;
            }

            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const relative =
                path.relative(
                    directory,
                    full
                );

            const data =
                await fsp.readFile(full);

            files.push({
                path: relative,
                data:
                    data.toString("base64")
            });
        }
    }

    await walk(directory);

    return files;
}

/* ============================================================
   TEMP AUTH DIRECTORY
============================================================ */

function getTemporaryAuthFolder(
    pairingId
) {
    return path.join(
        AUTH_DIR,
        `PAIR_${pairingId}`
    );
}

/* ============================================================
   SESSION REGISTRY SAVE
============================================================ */

async function saveSessionMapping(
    pairing,
    session
) {
    if (!session?.sessionId) {
        return;
    }

    await savePairingRegistryRecord(
        session.sessionId,
        {
            pairingId:
                session.pairingId ||
                pairing?.pairingId ||
                pairing?.id ||
                null,

            sessionId:
                session.sessionId,

            jid:
                session.jid ||
                pairing?.jid ||
                null,

            number:
                session.number ||
                pairing?.number ||
                null,

            authFolder:
                session.authFolder ||
                pairing?.authFolder ||
                null,

            status:
                session.status ||
                "connected",

            connected:
                session.connected !== false,

            authAvailable:
                true,

            createdAt:
                session.createdAt ||
                pairing?.createdAt ||
                new Date().toISOString(),

            expiresAt:
                session.expiresAt ||
                null
        }
    );
}

/* ============================================================
   SUCCESSFUL DEPLOYMENT
============================================================ */

async function saveSuccessfulDeployment(
    sessionId,
    days
) {
    const normalized =
        normalizeSessionId(sessionId);

    if (!normalized) return;

    const record =
        await findSessionEverywhere(
            normalized
        );

    if (!record) return;

    await savePairingRegistryRecord(
        normalized,
        {
            ...record,
            deployed: true,
            deployedAt:
                new Date().toISOString(),
            days:
                Number(days || record.days || 30),
            status: "deployed"
        }
    );

    try {
        if (
            typeof markSessionDeployed ===
            "function"
        ) {
            await Promise.resolve(
                markSessionDeployed(
                    normalized
                )
            );
        }
    } catch (error) {
        logger.warn(
            {
                error: error.message,
                sessionId: normalized
            },
            "[SESSION] Could not mark deployed"
        );
    }
}

/* ============================================================
   CLOSE PAIRING SOCKET
============================================================ */

/*
 * THIS IS THE IMPORTANT FIX.
 *
 * Once the Session ID has been generated and the
 * auth state has been saved, the pairing server
 * must stop owning the WhatsApp connection.
 *
 * The deployment/bot service becomes the only
 * Baileys connection.
 */

async function closePairingSocket(
    pairingId,
    reason = "SESSION_READY_FOR_DEPLOYMENT"
) {
    const socket =
        sockets.get(pairingId);

    if (!socket) {
        return;
    }

    logger.info(
        {
            pairingId,
            reason
        },
        "[PAIR] Closing pairing socket"
    );

    try {
        socket.__etiasIntentionalClose = true;

        if (
            typeof socket.ws?.close ===
            "function"
        ) {
            socket.ws.close();
        } else if (
            typeof socket.end ===
            "function"
        ) {
            socket.end(undefined);
        }
    } catch (error) {
        logger.warn(
            {
                error: error.message,
                pairingId
            },
            "[PAIR] Socket close warning"
        );
    }

    sockets.delete(pairingId);
    reconnecting.delete(pairingId);
}

/* ============================================================
   START PAIRING
============================================================ */

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
            "Invalid WhatsApp number"
        );
    }

    const authFolder =
        existingAuthFolder ||
        getTemporaryAuthFolder(
            pairingId
        );

    await fsp.mkdir(
        authFolder,
        {
            recursive: true
        }
    );

    let pairing =
        await Promise.resolve(
            getPairing(pairingId)
        );

    if (!pairing) {
        pairing = {
            pairingId,
            id: pairingId,
            number: clean,
            phone: clean,
            authFolder,
            sessionId:
                existingSessionId ||
                null,
            status: "connecting",
            connected: false,
            createdAt:
                new Date().toISOString()
        };
    }

    pairing.authFolder =
        authFolder;

    pairing.number =
        clean;

    pairing.phone =
        clean;

    if (existingSessionId) {
        pairing.sessionId =
            existingSessionId;
    }

    pairing.status =
        "connecting";

    pairing.connected =
        false;

    try {
        await Promise.resolve(
            updatePairing(
                pairingId,
                pairing
            )
        );
    } catch {}

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        authFolder
    );

    const socket =
        makeWASocket({
            auth: state,

            browser:
                Browsers.macOS(
                    "Chrome"
                ),

            printQRInTerminal: false,

            logger: pino({
                level: "silent"
            }),

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview:
                false,

            connectTimeoutMs: 60000,

            defaultQueryTimeoutMs:
                60000,

            keepAliveIntervalMs:
                25000
        });

    sockets.set(
        pairingId,
        socket
    );

    socket.ev.on(
        "creds.update",
        async () => {
            try {
                await saveCreds();
            } catch (error) {
                logger.warn(
                    {
                        error:
                            error.message,
                        pairingId
                    },
                    "[AUTH] saveCreds failed"
                );
            }
        }
    );

    socket.ev.on(
        "connection.update",
        async update => {
            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            /*
             * QR generated
             */
            if (qr) {
                pairing.qr = qr;
                pairing.status =
                    "qr_ready";

                try {
                    await Promise.resolve(
                        updatePairing(
                            pairingId,
                            pairing
                        )
                    );
                } catch {}

                logger.info(
                    {
                        pairingId
                    },
                    "[PAIR] QR generated"
                );
            }

            /*
             * Connection opening
             */
            if (
                connection ===
                "connecting"
            ) {
                pairing.status =
                    "connecting";

                pairing.connected =
                    false;

                try {
                    await Promise.resolve(
                        updatePairing(
                            pairingId,
                            pairing
                        )
                    );
                } catch {}

                logger.info(
                    {
                        pairingId
                    },
                    "[PAIR] Connecting..."
                );
            }

            /*
             * CONNECTION OPEN
             */
            if (
                connection ===
                "open"
            ) {
                try {
                    const userJid =
                        normalizeJid(
                            socket.user?.id
                        );

                    pairing.jid =
                        userJid;

                    pairing.connected =
                        true;

                    pairing.status =
                        "connected";

                    pairing.qr = null;

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}

                    logger.info(
                        {
                            pairingId,
                            jid: userJid
                        },
                        "[PAIR] WhatsApp connected"
                    );

                    /*
                     * Give Baileys a moment to finish
                     * writing authentication state.
                     */
                    await sleep(1500);

                    /*
                     * Generate and send the FINAL
                     * ETIAS-MINI-BOT~XXXXXXXX Session ID.
                     *
                     * session.js is the source of truth.
                     */
                    const result =
                        await generateAndSendSession(
                            socket,
                            authFolder,
                            userJid,
                            pairingId,
                            userJid
                        );

                    if (
                        !result ||
                        !result.sessionId
                    ) {
                        throw new Error(
                            "Session ID was not generated"
                        );
                    }

                    const finalSessionId =
                        normalizeSessionId(
                            result.sessionId
                        );

                    logger.info(
                        {
                            pairingId,
                            sessionId:
                                finalSessionId,
                            number: clean
                        },
                        "[SESSION] Session ID generated"
                    );

                    /*
                     * Save final mapping.
                     */
                    pairing.sessionId =
                        finalSessionId;

                    pairing.jid =
                        result.jid ||
                        userJid;

                    pairing.number =
                        result.number ||
                        clean;

                    pairing.authFolder =
                        result.authFolder ||
                        authFolder;

                    pairing.connected =
                        true;

                    pairing.status =
                        "session_sent";

                    pairing.sessionSent =
                        true;

                    pairing.sessionSentAt =
                        new Date().toISOString();

                    await saveSessionMapping(
                        pairing,
                        {
                            ...result,
                            sessionId:
                                finalSessionId,
                            pairingId,
                            authFolder,
                            number:
                                result.number ||
                                clean,
                            jid:
                                result.jid ||
                                userJid,
                            status:
                                "session_sent",
                            connected:
                                true
                        }
                    );

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}

                    /*
                     * Verify creds.json exists BEFORE
                     * closing the pairing connection.
                     */
                    const hasAuth =
                        await authExists(
                            authFolder
                        );

                    if (!hasAuth) {
                        logger.error(
                            {
                                pairingId,
                                sessionId:
                                    finalSessionId,
                                authFolder
                            },
                            "[AUTH] creds.json missing"
                        );

                        pairing.status =
                            "auth_missing";

                        try {
                            await Promise.resolve(
                                updatePairing(
                                    pairingId,
                                    pairing
                                )
                            );
                        } catch {}

                        return;
                    }

                    logger.info(
                        {
                            pairingId,
                            sessionId:
                                finalSessionId,
                            authFolder
                        },
                        "[AUTH] Auth state saved"
                    );

                    /*
                     * IMPORTANT:
                     *
                     * Do NOT reconnect this pairing socket.
                     * The bot/deployment server must now
                     * be the only WhatsApp connection.
                     */
                    await sleep(1000);

                    await closePairingSocket(
                        pairingId,
                        "SESSION_SENT_AUTH_SAVED"
                    );

                    pairing.connected =
                        false;

                    pairing.status =
                        "ready_for_deployment";

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}

                    logger.info(
                        {
                            pairingId,
                            sessionId:
                                finalSessionId
                        },
                        "[PAIR] Pairing socket closed. Ready for deployment."
                    );

                    return;
                } catch (error) {
                    logger.error(
                        {
                            error:
                                error.message,
                            stack:
                                error.stack,
                            pairingId
                        },
                        "[PAIR] Session generation failed"
                    );

                    pairing.status =
                        "session_error";

                    pairing.error =
                        error.message;

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}
                }
            }

            /*
             * CONNECTION CLOSED
             */
            if (
                connection ===
                "close"
            ) {
                const code =
                    getDisconnectCode(
                        lastDisconnect
                    );

                const intentional =
                    socket.__etiasIntentionalClose ===
                    true;

                logger.info(
                    {
                        pairingId,
                        code,
                        intentional,
                        sessionId:
                            pairing.sessionId ||
                            null
                    },
                    "[PAIR] Connection closed"
                );

                sockets.delete(
                    pairingId
                );

                /*
                 * If we intentionally closed the pairing
                 * socket after sending the Session ID,
                 * DO NOT reconnect it.
                 */
                if (
                    intentional ||
                    pairing.sessionSent ||
                    pairing.status ===
                        "session_sent" ||
                    pairing.status ===
                        "ready_for_deployment"
                ) {
                    pairing.connected =
                        false;

                    pairing.status =
                        "ready_for_deployment";

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}

                    return;
                }

                /*
                 * Logged out means the auth is no longer valid.
                 */
                if (
                    isLoggedOut(code)
                ) {
                    pairing.connected =
                        false;

                    pairing.status =
                        "logged_out";

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}

                    return;
                }

                /*
                 * Before Session ID generation, reconnect.
                 */
                if (
                    !reconnecting.has(
                        pairingId
                    )
                ) {
                    reconnecting.add(
                        pairingId
                    );

                    pairing.connected =
                        false;

                    pairing.status =
                        "reconnecting";

                    try {
                        await Promise.resolve(
                            updatePairing(
                                pairingId,
                                pairing
                            )
                        );
                    } catch {}

                    logger.info(
                        {
                            pairingId,
                            code
                        },
                        "[PAIR] Reconnecting in 5 seconds"
                    );

                    setTimeout(
                        async () => {
                            reconnecting.delete(
                                pairingId
                            );

                            try {
                                await startPairing(
                                    clean,
                                    pairingId,
                                    authFolder,
                                    pairing.sessionId ||
                                        null
                                );
                            } catch (error) {
                                logger.error(
                                    {
                                        error:
                                            error.message,
                                        pairingId
                                    },
                                    "[PAIR] Reconnect failed"
                                );
                            }
                        },
                        5000
                    );
                }
            }
        }
    );

    /*
     * REQUEST PAIRING CODE
     */
    if (
        !state.creds.registered
    ) {
        try {
            await delay(1500);

            pairing.status =
                "requesting_pairing_code";

            try {
                await Promise.resolve(
                    updatePairing(
                        pairingId,
                        pairing
                    )
                );
            } catch {}

            logger.info(
                {
                    pairingId,
                    number: clean
                },
                "[PAIR] Requesting WhatsApp pairing code"
            );

            const code =
                await socket.requestPairingCode(
                    clean
                );

            pairing.pairingCode =
                String(code || "")
                    .replace(
                        /[^A-Z0-9]/gi,
                        ""
                    )
                    .toUpperCase();

            pairing.status =
                "pairing_code";

            try {
                await Promise.resolve(
                    updatePairing(
                        pairingId,
                        pairing
                    )
                );
            } catch {}

            logger.info(
                {
                    pairingId
                },
                "[PAIR] Pairing code generated"
            );
        } catch (error) {
            logger.error(
                {
                    error:
                        error.message,
                    pairingId
                },
                "[PAIR] Pairing code failed"
            );

            pairing.status =
                "pairing_code_error";

            pairing.error =
                error.message;

            try {
                await Promise.resolve(
                    updatePairing(
                        pairingId,
                        pairing
                    )
                );
            } catch {}
        }
    } else {
        logger.info(
            {
                pairingId
            },
            "[PAIR] Existing authentication detected"
        );
    }

    return {
        pairingId,
        authFolder
    };
}

/* ============================================================
   EXPRESS
============================================================ */

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

/* ============================================================
   HOME
============================================================ */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            ROOT,
            "index.html"
        ),
        error => {
            if (error) {
                res.json({
                    success: true,
                    name:
                        BOT_NAME +
                        " Pairing Server",
                    status: "online",
                    service: "pairing",
                    sessionPrefix:
                        SESSION_PREFIX,
                    time:
                        new Date().toISOString()
                });
            }
        }
    );
});

/* ============================================================
   PAGES
============================================================ */

app.get("/pair", (req, res) => {
    res.sendFile(
        path.join(
            ROOT,
            "pair.html"
        )
    );
});

app.get("/qr", (req, res) => {
    res.sendFile(
        path.join(
            ROOT,
            "qr.html"
        )
    );
});

app.get("/active", (req, res) => {
    res.sendFile(
        path.join(
            ROOT,
            "active.html"
        )
    );
});

/* ============================================================
   HEALTH
============================================================ */

app.get(
    "/ping",
    (req, res) => {
        res.json({
            success: true,
            pong: true,
            time:
                new Date().toISOString()
        });
    }
);

app.get(
    "/health",
    async (req, res) => {
        const sessions =
            await Promise.resolve(
                getAllSessions()
            ).catch(() => []);

        res.json({
            success: true,
            status: "online",
            service: "pairing",
            name: BOT_NAME,
            pairingSockets:
                sockets.size,
            sessions:
                Array.isArray(sessions)
                    ? sessions.length
                    : 0,
            authTransfer:
                Boolean(
                    SESSION_TRANSFER_SECRET
                ),
            time:
                new Date().toISOString()
        });
    }
);

app.get(
    "/api/health",
    async (req, res) => {
        const sessions =
            await Promise.resolve(
                getAllSessions()
            ).catch(() => []);

        res.json({
            success: true,
            status: "online",
            service: "pairing",
            pairingSockets:
                sockets.size,
            sessions:
                Array.isArray(sessions)
                    ? sessions.length
                    : 0,
            authTransfer:
                Boolean(
                    SESSION_TRANSFER_SECRET
                ),
            time:
                new Date().toISOString()
        });
    }
);

/* ============================================================
   START PAIRING
============================================================ */

app.get(
    "/code",
    async (req, res) => {
        try {
            const number =
                cleanNumber(
                    req.query.number
                );

            if (
                !number ||
                number.length < 8
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Valid WhatsApp number required"
                });
            }

            /*
             * Create pairing record.
             */
            const created =
                await Promise.resolve(
                    createPairing(number)
                );

            const pairingId =
                created?.pairingId ||
                created?.id ||
                created;

            if (!pairingId) {
                throw new Error(
                    "Could not create pairing"
                );
            }

            logger.info(
                {
                    pairingId,
                    number
                },
                "[PAIR] New pairing request"
            );

            /*
             * Start socket asynchronously.
             */
            startPairing(
                number,
                pairingId
            ).catch(error => {
                logger.error(
                    {
                        error:
                            error.message,
                        pairingId
                    },
                    "[PAIR] Background pairing failed"
                );
            });

            /*
             * Poll for the pairing code.
             *
             * This prevents the frontend from receiving
             * a response before Baileys has generated it.
             */
            const timeout =
                Date.now() + 30000;

            while (
                Date.now() < timeout
            ) {
                await sleep(500);

                const pairing =
                    await Promise.resolve(
                        getPairing(
                            pairingId
                        )
                    );

                if (
                    pairing?.pairingCode
                ) {
                    return res.json({
                        success: true,
                        pairingId,
                        sessionId:
                            pairing.sessionId ||
                            null,
                        number,
                        status:
                            pairing.status ||
                            "pairing_code",
                        pairingCode:
                            pairing.pairingCode,
                        message:
                            "Enter this pairing code in WhatsApp Linked Devices."
                    });
                }

                if (
                    pairing?.status ===
                        "error" ||
                    pairing?.status ===
                        "pairing_code_error"
                ) {
                    return res.status(500).json({
                        success: false,
                        pairingId,
                        error:
                            pairing.error ||
                            "Pairing code generation failed"
                    });
                }
            }

            const finalPairing =
                await Promise.resolve(
                    getPairing(
                        pairingId
                    )
                );

            return res.json({
                success: true,
                pairingId,
                sessionId:
                    finalPairing?.sessionId ||
                    null,
                number,
                status:
                    finalPairing?.status ||
                    "connecting",
                pairingCode:
                    finalPairing?.pairingCode ||
                    null,
                message:
                    finalPairing?.pairingCode
                        ? "Enter this pairing code in WhatsApp Linked Devices."
                        : "Pairing started. Wait for the pairing code."
            });
        } catch (error) {
            logger.error(
                {
                    error:
                        error.message
                },
                "[PAIR] /code failed"
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   PAIRING STATUS
============================================================ */

app.get(
    "/status/:id",
    async (req, res) => {
        try {
            const id =
                req.params.id;

            const pairing =
                await Promise.resolve(
                    getPairing(id)
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
                pairingId: id,
                sessionId:
                    pairing.sessionId ||
                    null,
                number:
                    pairing.number ||
                    pairing.phone ||
                    null,
                status:
                    pairing.status ||
                    "unknown",
                connected:
                    Boolean(
                        pairing.connected
                    ),
                pairingCode:
                    pairing.pairingCode ||
                    null,
                qr:
                    pairing.qr ||
                    null,
                authAvailable:
                    await authExists(
                        pairing.authFolder
                    )
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   CHECK PAIRING ID
============================================================ */

app.get(
    "/check/:id",
    async (req, res) => {
        const pairing =
            await Promise.resolve(
                getPairing(
                    req.params.id
                )
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
            pairingId:
                req.params.id,
            sessionId:
                pairing.sessionId ||
                null,
            number:
                pairing.number ||
                pairing.phone ||
                null,
            status:
                pairing.status ||
                "unknown",
            connected:
                Boolean(
                    pairing.connected
                )
        });
    }
);

/* ============================================================
   FINAL SESSION LOOKUP
============================================================ */

async function sendSessionDetails(
    req,
    res
) {
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
            return res.status(400).json({
                success: false,
                error:
                    "Invalid Session ID"
            });
        }

        const record =
            await findSessionEverywhere(
                sessionId
            );

        if (!record) {
            return res.status(404).json({
                success: false,
                error:
                    "Session ID not found"
            });
        }

        const authAvailable =
            await authExists(
                record.authFolder
            );

        return res.json({
            success: true,

            sessionId,

            pairingId:
                record.pairingId ||
                null,

            number:
                record.number ||
                null,

            phone:
                record.number ||
                null,

            jid:
                record.jid ||
                null,

            authFolder:
                record.authFolder ||
                null,

            authAvailable,

            status:
                record.status ||
                (
                    authAvailable
                        ? "ready_for_deployment"
                        : "unknown"
                ),

            /*
             * Do not require the pairing socket to remain
             * connected. It is intentionally closed after
             * authentication is saved.
             */
            connected:
                Boolean(
                    record.connected
                ),

            deployed:
                Boolean(
                    record.deployed
                ),

            createdAt:
                record.createdAt ||
                null,

            expiresAt:
                record.expiresAt ||
                null
        });
    } catch (error) {
        logger.error(
            {
                error:
                    error.message,
                sessionId:
                    req.params.sessionId
            },
            "[SESSION] Lookup failed"
        );

        return res.status(500).json({
            success: false,
            error:
                error.message
        });
    }
}

app.get(
    "/session/:sessionId",
    sendSessionDetails
);

app.get(
    "/api/session/:sessionId",
    sendSessionDetails
);

/* ============================================================
   SESSION STATUS
============================================================ */

app.get(
    "/session-status/:sessionId",
    async (req, res) => {
        const fakeReq = {
            params: req.params
        };

        const fakeRes = {
            status(code) {
                this.statusCode = code;
                return this;
            },

            json(data) {
                res
                    .status(
                        this.statusCode ||
                        200
                    )
                    .json(data);
            }
        };

        return sendSessionDetails(
            fakeReq,
            fakeRes
        );
    }
);

app.get(
    "/check-session/:sessionId",
    async (req, res) => {
        const record =
            await findSessionEverywhere(
                req.params.sessionId
            );

        if (!record) {
            return res.status(404).json({
                success: false,
                valid: false,
                error:
                    "Session ID not found"
            });
        }

        const authAvailable =
            await authExists(
                record.authFolder
            );

        return res.json({
            success: true,
            valid: true,
            sessionId:
                normalizeSessionId(
                    req.params.sessionId
                ),
            number:
                record.number ||
                null,
            jid:
                record.jid ||
                null,
            authAvailable,
            status:
                record.status ||
                "ready_for_deployment"
        });
    }
);

/* ============================================================
   AUTH TRANSFER
============================================================ */

app.get(
    "/session/:sessionId/auth",
    async (req, res) => {
        try {
            if (
                !SESSION_TRANSFER_SECRET
            ) {
                return res.status(503).json({
                    success: false,
                    error:
                        "Session auth transfer is not configured"
                });
            }

            const suppliedSecret =
                String(
                    req.headers[
                        "x-session-transfer-secret"
                    ] ||
                    req.query.secret ||
                    ""
                );

            if (
                suppliedSecret !==
                SESSION_TRANSFER_SECRET
            ) {
                return res.status(401).json({
                    success: false,
                    error:
                        "Invalid session transfer secret"
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
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid Session ID"
                });
            }

            const record =
                await findSessionEverywhere(
                    sessionId
                );

            if (!record) {
                return res.status(404).json({
                    success: false,
                    error:
                        "Session ID not found"
                });
            }

            if (
                !record.authFolder
            ) {
                return res.status(404).json({
                    success: false,
                    error:
                        "Auth folder not available"
                });
            }

            const authAvailable =
                await authExists(
                    record.authFolder
                );

            if (!authAvailable) {
                return res.status(404).json({
                    success: false,
                    error:
                        "creds.json not found"
                });
            }

            /*
             * IMPORTANT:
             *
             * We intentionally do NOT require
             * record.connected === true.
             *
             * The pairing socket was intentionally
             * closed after authentication.
             */

            const files =
                await readAuthFiles(
                    record.authFolder
                );

            if (!files.length) {
                return res.status(404).json({
                    success: false,
                    error:
                        "No authentication files found"
                });
            }

            logger.info(
                {
                    sessionId,
                    files:
                        files.length
                },
                "[AUTH TRANSFER] Auth files requested"
            );

            return res.json({
                success: true,

                sessionId,

                pairingId:
                    record.pairingId ||
                    null,

                number:
                    record.number ||
                    null,

                jid:
                    record.jid ||
                    null,

                files,

                fileCount:
                    files.length,

                transferredAt:
                    new Date().toISOString()
            });
        } catch (error) {
            logger.error(
                {
                    error:
                        error.message,
                    sessionId:
                        req.params.sessionId
                },
                "[AUTH TRANSFER] Failed"
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   QR IMAGE
============================================================ */

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
                await Promise.resolve(
                    getPairing(id)
                );

            if (
                !pairing ||
                !pairing.qr
            ) {
                return res.status(404).json({
                    success: false,
                    error:
                        "QR not available"
                });
            }

            const png =
                await QRCode.toBuffer(
                    pairing.qr,
                    {
                        type: "png",
                        width: 500,
                        margin: 2
                    }
                );

            res.setHeader(
                "Content-Type",
                "image/png"
            );

            return res.send(png);
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   ALL SESSIONS
============================================================ */

app.get(
    "/sessions",
    async (req, res) => {
        try {
            const sessions =
                await Promise.resolve(
                    getAllSessions()
                );

            return res.json({
                success: true,
                count:
                    Array.isArray(
                        sessions
                    )
                        ? sessions.length
                        : 0,
                sessions:
                    Array.isArray(
                        sessions
                    )
                        ? sessions
                        : []
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

app.get(
    "/api/sessions",
    async (req, res) => {
        try {
            const sessions =
                await Promise.resolve(
                    getAllSessions()
                );

            return res.json({
                success: true,
                count:
                    Array.isArray(
                        sessions
                    )
                        ? sessions.length
                        : 0,
                sessions:
                    Array.isArray(
                        sessions
                    )
                        ? sessions
                        : []
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   TOTAL USERS
============================================================ */

app.get(
    "/total-users",
    async (req, res) => {
        try {
            const sessions =
                await Promise.resolve(
                    getAllSessions()
                );

            const count =
                Array.isArray(
                    sessions
                )
                    ? sessions.length
                    : 0;

            return res.json({
                success: true,
                totalUsers: count,
                total: count
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                totalUsers: 0,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   DEPLOY STATS
============================================================ */

app.get(
    "/deploy-stats",
    async (req, res) => {
        try {
            const sessions =
                await Promise.resolve(
                    getAllSessions()
                );

            const list =
                Array.isArray(
                    sessions
                )
                    ? sessions
                    : [];

            let connected = 0;
            let deployed = 0;
            let expired = 0;

            const now =
                Date.now();

            for (
                const session of list
            ) {
                if (
                    session.connected
                ) {
                    connected++;
                }

                if (
                    session.deployed
                ) {
                    deployed++;
                }

                if (
                    session.expiresAt &&
                    new Date(
                        session.expiresAt
                    ).getTime() <
                        now
                ) {
                    expired++;
                }
            }

            return res.json({
                success: true,
                totalUsers:
                    list.length,
                total:
                    list.length,
                connected,
                online:
                    connected,
                deployed,
                expired,
                active:
                    Math.max(
                        0,
                        list.length -
                            expired
                    )
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                totalUsers: 0,
                connected: 0,
                deployed: 0,
                expired: 0,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   DEPLOYED LIST
============================================================ */

app.get(
    "/deployed-list",
    async (req, res) => {
        try {
            const sessions =
                await Promise.resolve(
                    getAllSessions()
                );

            const list =
                Array.isArray(
                    sessions
                )
                    ? sessions
                    : [];

            const deployed =
                list.filter(
                    session =>
                        session.deployed ||
                        session.status ===
                            "deployed"
                );

            return res.json({
                success: true,
                count:
                    deployed.length,
                users:
                    deployed,
                sessions:
                    deployed
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error:
                    error.message
            });
        }
    }
);

/* ============================================================
   BOT IMAGE
============================================================ */

app.get(
    "/bot-image",
    (req, res) => {
        const possible = [
            path.join(
                ROOT,
                "assets",
                "bot_image.png"
            ),
            path.join(
                ROOT,
                "bot_image.png"
            ),
            path.join(
                MEDIA_DIR,
                "bot_image.png"
            )
        ];

        const found =
            possible.find(
                file =>
                    fs.existsSync(file)
            );

        if (!found) {
            return res.status(404).json({
                success: false,
                error:
                    "Bot image not found"
            });
        }

        return res.sendFile(
            found
        );
    }
);

/* ============================================================
   PAIRING SERVER INFORMATION
============================================================ */

app.get(
    "/pairing-server",
    (req, res) => {
        res.json({
            success: true,
            name:
                BOT_NAME +
                " Pairing Server",
            status: "online",
            pairingCodeGeneration:
                true,
            sessionPrefix:
                SESSION_PREFIX,
            authTransfer:
                Boolean(
                    SESSION_TRANSFER_SECRET
                ),
            pairingSockets:
                sockets.size,
            time:
                new Date().toISOString()
        });
    }
);

/* ============================================================
   MANAGER
============================================================ */

app.get(
    "/manager",
    async (req, res) => {
        const sessions =
            await Promise.resolve(
                getAllSessions()
            ).catch(() => []);

        res.json({
            success: true,
            service:
                "ETIAS-MINI-BOT Pairing Manager",
            activePairingSockets:
                sockets.size,
            sessions:
                Array.isArray(
                    sessions
                )
                    ? sessions.length
                    : 0,
            authTransferEnabled:
                Boolean(
                    SESSION_TRANSFER_SECRET
                ),
            sessionPrefix:
                SESSION_PREFIX
        });
    }
);

/* ============================================================
   LOGS
============================================================ */

app.get(
    "/logs",
    (req, res) => {
        res.json({
            success: true,
            message:
                "Use Render logs for live server logs.",
            pairingSockets:
                sockets.size,
            time:
                new Date().toISOString()
        });
    }
);

/* ============================================================
   404
============================================================ */

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,
            error: "Route not found",
            path: req.originalUrl
        });
    }
);

/* ============================================================
   ERROR HANDLER
============================================================ */

app.use(
    (error, req, res, next) => {
        logger.error(
            {
                error:
                    error.message,
                stack:
                    error.stack
            },
            "[HTTP] Error"
        );

        if (res.headersSent) {
            return next(error);
        }

        res.status(500).json({
            success: false,
            error:
                error.message ||
                "Internal server error"
        });
    }
);

/* ============================================================
   START SERVER
============================================================ */

async function startServer() {
    await ensureDirectories();

    app.listen(
        PORT,
        "0.0.0.0",
        () => {
            logger.info(
                {
                    port: PORT,
                    bot: BOT_NAME,
                    authTransfer:
                        Boolean(
                            SESSION_TRANSFER_SECRET
                        )
                },
                "[SERVER] Pairing server running"
            );

            logger.info(
                "[SERVER] Session prefix: " +
                SESSION_PREFIX
            );

            logger.info(
                "[SERVER] Pairing socket will close after Session ID delivery"
            );
        }
    );
}

if (
    require.main === module
) {
    startServer().catch(error => {
        logger.error(
            {
                error:
                    error.message,
                stack:
                    error.stack
            },
            "[SERVER] Startup failed"
        );

        process.exit(1);
    });
}

module.exports = app;
