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
    getSessionById,
    getDeploymentCodeStatus,
    getAllSessions,
    markSessionDeployed,
    updateSession
} = require("./session");


/* ============================================================
   APP
============================================================ */

const app = express();

const PORT =
    Number(process.env.PORT || 3000);

const ROOT =
    __dirname;

const AUTH_DIR =
    path.join(
        ROOT,
        "auth"
    );

const DATA_DIR =
    path.join(
        ROOT,
        "data"
    );

const MEDIA_DIR =
    path.join(
        ROOT,
        "media"
    );

const SESSION_REGISTRY_FILE =
    path.join(
        DATA_DIR,
        "pairing-registry.json"
    );

const BOT_NAME =
    process.env.BOT_NAME ||
    "ETIAS-MINI-BOT";

const SESSION_TRANSFER_SECRET =
    String(
        process.env.SESSION_TRANSFER_SECRET ||
        ""
    ).trim();

const SESSION_ID_REGEX =
    /^ETIAS-MINI-BOT~\d{8}$/i;

const logger =
    pino({
        level:
            process.env.LOG_LEVEL ||
            "silent"
    });


/* ============================================================
   MULTI-USER SOCKETS
============================================================ */

const sockets =
    new Map();

const reconnecting =
    new Set();

const pairingLocks =
    new Set();


/* ============================================================
   DIRECTORIES
============================================================ */

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

    if (
        !fs.existsSync(
            SESSION_REGISTRY_FILE
        )
    ) {

        await fsp.writeFile(
            SESSION_REGISTRY_FILE,
            "[]",
            "utf8"
        );

    }

}


/* ============================================================
   BASIC HELPERS
============================================================ */

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

    return String(
        number || ""
    )
        .replace(
            /\D/g,
            ""
        );

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


function jidToNumber(jid) {

    const normalized =
        normalizeJid(jid);

    if (!normalized) {

        return null;

    }

    return normalized
        .split("@")[0]
        .replace(
            /\D/g,
            ""
        );

}


function normalizeSessionId(value) {

    return String(
        value || ""
    )
        .trim()
        .replace(
            /^[\[\(\s]+/,
            ""
        )
        .replace(
            /[\]\)\s]+$/,
            ""
        );

}


function isValidSessionId(
    sessionId
) {

    return SESSION_ID_REGEX.test(
        normalizeSessionId(
            sessionId
        )
    );

}


function getDisconnectCode(
    lastDisconnect
) {

    return (
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.data?.statusCode ||
        lastDisconnect?.error?.statusCode ||
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


/* ============================================================
   SESSION REGISTRY
============================================================ */

async function readSessionRegistry() {

    try {

        const raw =
            await fsp.readFile(
                SESSION_REGISTRY_FILE,
                "utf8"
            );

        const data =
            JSON.parse(raw);

        return Array.isArray(data)
            ? data
            : [];

    } catch (error) {

        console.error(
            "[REGISTRY] Read error:",
            error.message
        );

        return [];

    }

}


let registryWriteQueue =
    Promise.resolve();


function writeSessionRegistry(
    data
) {

    registryWriteQueue =
        registryWriteQueue.then(
            async () => {

                const tempFile =
                    `${SESSION_REGISTRY_FILE}.tmp`;

                await fsp.writeFile(
                    tempFile,
                    JSON.stringify(
                        data,
                        null,
                        2
                    ),
                    "utf8"
                );

                await fsp.rename(
                    tempFile,
                    SESSION_REGISTRY_FILE
                );

            }
        ).catch(
            error => {

                console.error(
                    "[REGISTRY] Write error:",
                    error.message
                );

            }
        );

    return registryWriteQueue;

}


async function saveSessionRecord(
    record
) {

    const sessions =
        await readSessionRegistry();

    const cleanId =
        normalizeSessionId(
            record.sessionId
        );

    if (
        !isValidSessionId(
            cleanId
        )
    ) {

        return;

    }

    const index =
        sessions.findIndex(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) === cleanId
        );

    const finalRecord = {

        ...record,

        sessionId:
            cleanId,

        updatedAt:
            new Date().toISOString()

    };


    if (
        index >= 0
    ) {

        sessions[index] = {

            ...sessions[index],

            ...finalRecord

        };

    } else {

        sessions.push(
            finalRecord
        );

    }

    await writeSessionRegistry(
        sessions
    );

}


/* ============================================================
   GET REGISTRY SESSION
============================================================ */

async function getSessionRecord(
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

        return null;

    }

    const sessions =
        await readSessionRegistry();

    return (
        sessions.find(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) === clean
        ) ||
        null
    );

}


/* ============================================================
   SAVE SESSION MAPPING
============================================================ */

async function saveSessionMapping({
    sessionId,
    pairingId,
    number,
    jid,
    authFolder,
    status,
    connected,
    sent,
    deployedAt
}) {

    if (
        !isValidSessionId(
            sessionId
        )
    ) {

        return;

    }

    await saveSessionRecord({

        sessionId,

        pairingId:
            pairingId ||
            null,

        number:
            number ||
            null,

        jid:
            jid ||
            null,

        authFolder:
            authFolder ||
            null,

        status:
            status ||
            "unknown",

        connected:
            connected === true,

        sent:
            sent === true,

        deployedAt:
            deployedAt ||
            null

    });

}


/* ============================================================
   TEMPORARY AUTH FOLDER
============================================================ */

function getTemporaryAuthFolder(
    pairingId
) {

    const safe =
        String(
            pairingId || ""
        )
            .replace(
                /[^a-zA-Z0-9_-]/g,
                "_"
            );

    return path.join(
        AUTH_DIR,
        `PAIR_${safe}`
    );

}


/* ============================================================
   AUTH CHECK
============================================================ */

function authExists(
    authFolder
) {

    if (
        !authFolder
    ) {

        return false;

    }

    return fs.existsSync(
        path.join(
            authFolder,
            "creds.json"
        )
    );

}


/* ============================================================
   AUTH FILE READER
============================================================ */

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

    const files = [];

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

            files.push(
                ...nested
            );

        } else {

            const buffer =
                await fsp.readFile(
                    fullPath
                );

            files.push({

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

    return files;

}


/* ============================================================
   FIND SESSION EVERYWHERE
============================================================ */

async function findSessionEverywhere(
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

        return null;

    }


    /*
     * PRIMARY SOURCE:
     *
     * session.js
     */
    let session =
        getSessionById(
            clean
        );


    /*
     * SECONDARY SOURCE:
     *
     * local pairing registry
     */
    const registry =
        await getSessionRecord(
            clean
        );


    /*
     * THIRD SOURCE:
     *
     * id.js
     */
    const pairing =
        getAllPairings()
            .find(
                item =>
                    normalizeSessionId(
                        item.sessionId
                    ) === clean
            );


    if (
        !session &&
        !registry &&
        !pairing
    ) {

        return null;

    }


    /*
     * Merge in this order:
     *
     * session.js
     * registry
     * id.js pairing
     *
     * Session.js remains authoritative for the
     * final generated Session ID.
     */
    return {

        ...(session || {}),

        ...(registry || {}),

        ...(pairing || {}),

        sessionId:
            clean,

        pairingId:
            session?.pairingId ||
            registry?.pairingId ||
            pairing?.id ||
            null,

        number:
            session?.number ||
            registry?.number ||
            pairing?.number ||
            null,

        phone:
            session?.phone ||
            session?.number ||
            registry?.number ||
            pairing?.number ||
            null,

        jid:
            session?.jid ||
            registry?.jid ||
            pairing?.jid ||
            null,

        authFolder:
            session?.authFolder ||
            registry?.authFolder ||
            pairing?.authFolder ||
            null,

        status:
            session?.status ||
            registry?.status ||
            pairing?.status ||
            "unknown",

        connected:
            session?.connected === true ||
            registry?.connected === true ||
            pairing?.connected === true,

        sent:
            session?.sent === true ||
            registry?.sent === true ||
            pairing?.sent === true

    };

}


/* ============================================================
   SAVE SUCCESSFUL DEPLOYMENT
============================================================ */

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


    await saveSessionMapping({

        sessionId,

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
            now

    });


    /*
     * Keep session.js as the source of truth.
     */
    try {

        markSessionDeployed(
            sessionId
        );

    } catch (error) {

        console.error(
            "[SESSION] Mark deployed error:",
            error.message
        );

    }


    try {

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

    } catch (error) {

        console.error(
            "[DEPLOYED USER] Save error:",
            error.message
        );

    }

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
        cleanNumber(
            number
        );

    if (!clean) {

        throw new Error(
            "Invalid phone number"
        );

    }

    if (!pairingId) {

        throw new Error(
            "Pairing ID is required"
        );

    }


    /*
     * Reconnect using the same auth folder.
     */
    const authFolder =
        existingAuthFolder ||
        getTemporaryAuthFolder(
            pairingId
        );


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
        `[PAIR] Pairing ID: ${pairingId}`
    );

    console.log(
        `[PAIR] Phone: +${clean}`
    );

    console.log(
        `[PAIR] Auth folder: ${authFolder}`
    );

    if (
        existingSessionId
    ) {

        console.log(
            `[PAIR] Existing Session ID: ${existingSessionId}`
        );

    }

    console.log(
        "========================================"
    );


    updatePairing(
        pairingId,
        {

            number:
                clean,

            ...(existingSessionId
                ? {
                    sessionId:
                        existingSessionId
                }
                : {}),

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


    /*
     * Close old socket if one exists.
     */
    const oldSocket =
        sockets.get(
            pairingId
        );

    if (
        oldSocket
    ) {

        try {

            oldSocket.end(
                new Error(
                    "Replacing old socket"
                )
            );

        } catch (_) {}

        sockets.delete(
            pairingId
        );

    }


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

            ...(existingSessionId
                ? {
                    sessionId:
                        existingSessionId
                }
                : {}),

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


    /* ========================================================
       CONNECTION UPDATE
    ======================================================== */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;


            /* ==================================================
               QR
            ================================================== */

            if (
                qr
            ) {

                updatePairing(
                    pairingId,
                    {

                        status:
                            "qr",

                        connected:
                            false,

                        authFolder

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
                                qrData,

                            status:
                                "qr"

                        }
                    );

                } catch (error) {

                    console.error(
                        "[QR] Image error:",
                        error.message
                    );

                }

            }


            /* ==================================================
               CONNECTING
            ================================================== */

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


            /* ==================================================
               OPEN
            ================================================== */

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
                    `AUTH: ${authFolder}`
                );

                console.log(
                    "========================================"
                );


                try {

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
                        "[SESSION] Generating final Session ID..."
                    );


                    /*
                     * IMPORTANT:
                     *
                     * session.js generates the ONLY
                     * public Session ID.
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


                    const finalSessionId =
                        normalizeSessionId(
                            result.sessionId
                        );


                    console.log(
                        "========================================"
                    );

                    console.log(
                        "📲 SESSION ID CREATED"
                    );

                    console.log(
                        `SESSION ID: ${finalSessionId}`
                    );

                    console.log(
                        `JID: ${authenticatedJid}`
                    );

                    console.log(
                        `NUMBER: ${clean}`
                    );

                    console.log(
                        `AUTH: ${authFolder}`
                    );

                    console.log(
                        "========================================"
                    );


                    updatePairing(
                        pairingId,
                        {

                            sessionId:
                                finalSessionId,

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


                    await saveSessionMapping({

                        sessionId:
                            finalSessionId,

                        pairingId,

                        number:
                            clean,

                        jid:
                            authenticatedJid,

                        authFolder,

                        status:
                            "awaiting_deployment",

                        connected:
                            true,

                        sent:
                            true

                    });


                    /*
                     * Keep session.js state synchronized.
                     */
                    try {

                        updateSession(
                            finalSessionId,
                            {

                                jid:
                                    authenticatedJid,

                                number:
                                    clean,

                                phone:
                                    clean,

                                authFolder,

                                connected:
                                    true,

                                sent:
                                    true,

                                status:
                                    "awaiting_deployment"

                            }
                        );

                    } catch (error) {

                        console.error(
                            "[SESSION] Update error:",
                            error.message
                        );

                    }


                    console.log(
                        `[REGISTRY] Saved ${finalSessionId}`
                    );

                    console.log(
                        "[PAIR] Waiting for deployment..."
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

                            error:
                                error.message ||
                                String(error)

                        }
                    );

                }

            }


            /* ==================================================
               CLOSE
            ================================================== */

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


                const pairing =
                    getPairing(
                        pairingId
                    );


                const currentSessionId =
                    pairing?.sessionId ||
                    existingSessionId ||
                    null;


                /*
                 * LOGGED OUT
                 */

                if (
                    isLoggedOut(
                        code
                    )
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


                    if (
                        currentSessionId
                    ) {

                        try {

                            updateSession(
                                currentSessionId,
                                {

                                    status:
                                        "logged_out",

                                    connected:
                                        false

                                }
                            );

                        } catch (_) {}


                        await saveSessionMapping({

                            sessionId:
                                currentSessionId,

                            pairingId,

                            number:
                                pairing?.number ||
                                clean,

                            jid:
                                pairing?.jid ||
                                null,

                            authFolder,

                            status:
                                "logged_out",

                            connected:
                                false,

                            sent:
                                pairing?.sent ===
                                true

                        });

                    }


                    return;

                }


                /*
                 * BAD SESSION
                 */

                if (
                    isBadSession(
                        code
                    )
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


                    if (
                        currentSessionId
                    ) {

                        try {

                            updateSession(
                                currentSessionId,
                                {

                                    status:
                                        "bad_session",

                                    connected:
                                        false

                                }
                            );

                        } catch (_) {}

                    }


                    return;

                }


                /*
                 * PREVENT DUPLICATE RECONNECT LOOPS
                 */

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
                    `[PAIR] 🔄 Reconnecting ${pairingId}...`
                );


                setTimeout(
                    async () => {

                        try {

                            reconnecting.delete(
                                pairingId
                            );


                            const latest =
                                getPairing(
                                    pairingId
                                );


                            await startPairing(

                                clean,

                                pairingId,

                                authFolder,

                                latest?.sessionId ||
                                currentSessionId ||
                                null

                            );

                        } catch (error) {

                            reconnecting.delete(
                                pairingId
                            );


                            console.error(
                                "[PAIR] Reconnect failed:",
                                error.message
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


    /* ========================================================
       WHATSAPP PAIRING CODE
    ======================================================== */

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


            updatePairing(
                pairingId,
                {

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


/* ============================================================
   EXPRESS CONFIG
============================================================ */

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


/* ============================================================
   HOME
============================================================ */

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


/* ============================================================
   PAIR
============================================================ */

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


/* ============================================================
   QR
============================================================ */

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


/* ============================================================
   PING
============================================================ */

app.get(
    "/ping",
    (req, res) => {

        res.json({

            success:
                true,

            status:
                "ok",

            service:
                "ETIAS-MINI-BOT Pair Server",

            sockets:
                sockets.size,

            pairings:
                getAllPairings().length,

            sessions:
                getAllSessions().length,

            time:
                new Date().toISOString()

        });

    }
);


/* ============================================================
   HEALTH
============================================================ */

app.get(
    "/health",
    async (req, res) => {

        const registry =
            await readSessionRegistry();

        const sessions =
            getAllSessions();

        res.json({

            success:
                true,

            status:
                "online",

            service:
                "ETIAS-MINI-BOT Pair Server",

            multiUser:
                true,

            sockets:
                sockets.size,

            pairings:
                getAllPairings().length,

            registeredSessions:
                registry.length,

            sessionManagerSessions:
                sessions.length,

            authTransfer:
                Boolean(
                    SESSION_TRANSFER_SECRET
                ),

            uptime:
                process.uptime(),

            time:
                new Date().toISOString()

        });

    }
);


/* ============================================================
   CREATE PAIRING
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
                !number
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Phone number is required"

                });

            }


            /*
             * Prevent multiple pairing sessions
             * for the same number.
             */
            const existing =
                getAllPairings()
                    .find(
                        item =>

                            cleanNumber(
                                item.number
                            ) === number &&

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


            if (
                existing
            ) {

                const response = {

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

                    connected:
                        existing.connected ===
                        true,

                    message:
                        "Pairing session already exists."

                };


                if (
                    existing.status ===
                        "pairing_code" &&
                    existing.pairingCode
                ) {

                    response.pairingCode =
                        existing.pairingCode;

                }


                return res.json(
                    response
                );

            }


            const pairing =
                createPairing(
                    number
                );


            /*
             * Start asynchronously.
             */
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

                            connected:
                                false,

                            error:
                                error.message ||
                                String(error)

                        }
                    );

                }
            );


            /*
             * Wait for pairing code.
             */
            let current =
                null;

            let pairingCode =
                null;


            for (
                let attempt = 0;
                attempt < 30;
                attempt++
            ) {

                await sleep(
                    1000
                );


                current =
                    getPairing(
                        pairing.id
                    );


                if (
                    !current
                ) {

                    break;

                }


                if (
                    current.status ===
                        "pairing_code" &&
                    current.pairingCode
                ) {

                    pairingCode =
                        current.pairingCode;

                    break;

                }


                if (
                    current.status ===
                        "error"
                ) {

                    break;

                }

            }


            if (
                pairingCode
            ) {

                return res.json({

                    success:
                        true,

                    pairingId:
                        pairing.id,

                    sessionId:
                        current?.sessionId ||
                        null,

                    number,

                    status:
                        "pairing_code",

                    pairingCode,

                    message:
                        "Enter this pairing code in WhatsApp Linked Devices."

                });

            }


            return res.json({

                success:
                    true,

                pairingId:
                    pairing.id,

                sessionId:
                    current?.sessionId ||
                    null,

                number,

                status:
                    current?.status ||
                    "connecting",

                connected:
                    current?.connected ===
                    true,

                message:
                    "Pairing started. Wait for the WhatsApp pairing code."

            });

        } catch (error) {

            console.error(
                "[CODE] Error:",
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


/* ============================================================
   STATUS
============================================================ */

app.get(
    "/status/:id",
    (req, res) => {

        const pairing =
            getPairing(
                req.params.id
            );


        if (
            !pairing
        ) {

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
         * Do not expose pairing code through
         * the polling endpoint.
         */
        delete safePairing.pairingCode;
        delete safePairing.deploymentCode;


        return res.json({

            success:
                true,

            ...safePairing

        });

    }
);


/* ============================================================
   CHECK PAIRING
============================================================ */

app.get(
    "/check/:id",
    (req, res) => {

        const pairing =
            getPairing(
                req.params.id
            );


        if (
            !pairing
        ) {

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
                pairing.connected ===
                true,

            sent:
                pairing.sent ===
                true,

            jid:
                pairing.jid ||
                null,

            codeExpiresAt:
                pairing.codeExpiresAt ||
                null,

            authAvailable:
                authExists(
                    pairing.authFolder
                ),

            error:
                pairing.error ||
                null

        });

    }
);


/* ============================================================
   SESSION LOOKUP
============================================================ */

app.get(
    "/session/:sessionId",
    async (req, res) => {

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


            const session =
                await findSessionEverywhere(
                    sessionId
                );


            if (
                !session
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Session ID not found"

                });

            }


            const authenticated =
                authExists(
                    session.authFolder
                );


            return res.json({

                success:
                    true,

                sessionId,

                number:
                    session.number ||
                    session.phone ||
                    null,

                phone:
                    session.phone ||
                    session.number ||
                    null,

                jid:
                    session.jid ||
                    null,

                pairingId:
                    session.pairingId ||
                    null,

                status:
                    session.status ||
                    "unknown",

                connected:
                    session.connected ===
                    true,

                authenticated,

                authAvailable:
                    authenticated,

                authFolder:
                    session.authFolder ||
                    null,

                sent:
                    session.sent ===
                    true,

                used:
                    session.used ===
                    true,

                expiresAt:
                    session.expiresAt ||
                    null

            });

        } catch (error) {

            console.error(
                "[SESSION LOOKUP]",
                error
            );


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


/* ============================================================
   SESSION STATUS
============================================================ */

app.get(
    "/session-status/:sessionId",
    async (req, res) => {

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


        const session =
            await findSessionEverywhere(
                sessionId
            );


        if (
            !session
        ) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Session ID not found"

            });

        }


        const authenticated =
            authExists(
                session.authFolder
            );


        res.json({

            success:
                true,

            sessionId,

            number:
                session.number ||
                null,

            phone:
                session.phone ||
                session.number ||
                null,

            jid:
                session.jid ||
                null,

            pairingId:
                session.pairingId ||
                null,

            status:
                session.status,

            connected:
                session.connected ===
                true,

            authenticated,

            authAvailable:
                authenticated,

            used:
                session.used ===
                true

        });

    }
);


/* ============================================================
   CHECK SESSION
============================================================ */

app.get(
    "/check-session/:sessionId",
    async (req, res) => {

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


        const session =
            await findSessionEverywhere(
                sessionId
            );


        if (
            !session
        ) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Session ID not found"

            });

        }


        res.json({

            success:
                true,

            sessionId,

            number:
                session.number ||
                null,

            jid:
                session.jid ||
                null,

            pairingId:
                session.pairingId ||
                null,

            status:
                session.status,

            connected:
                session.connected ===
                true,

            authenticated:
                authExists(
                    session.authFolder
                ),

            authAvailable:
                authExists(
                    session.authFolder
                )

        });

    }
);


/* ============================================================
   AUTH EXPORT
============================================================ */

app.get(
    "/session/:sessionId/auth",
    async (req, res) => {

        try {

            /*
             * Authentication transfer must be explicitly
             * configured.
             */
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
                    ] ||
                    ""
                ).trim();


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


            const session =
                await findSessionEverywhere(
                    sessionId
                );


            if (
                !session
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Session ID not found"

                });

            }


            /*
             * The auth folder must be tied to this
             * exact session.
             */
            const authFolder =
                session.authFolder;


            if (
                !authFolder
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Authentication folder is not registered"

                });

            }


            if (
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


            if (
                !authExists(
                    authFolder
                )
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "creds.json not found"

                });

            }


            /*
             * Read Baileys credentials and key files.
             */
            const files =
                await readAuthFiles(
                    authFolder
                );


            const credsExists =
                files.some(
                    file =>
                        file.path ===
                        "creds.json"
                );


            if (
                !credsExists
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "creds.json not found"

                });

            }


            console.log(
                `[AUTH EXPORT] ${sessionId}: ${files.length} file(s)`
            );


            return res.json({

                success:
                    true,

                format:
                    "ETIAS-MINI-BOT-AUTH",

                version:
                    1,

                sessionId,

                number:
                    session.number ||
                    session.phone ||
                    null,

                phone:
                    session.phone ||
                    session.number ||
                    null,

                jid:
                    session.jid ||
                    null,

                pairingId:
                    session.pairingId ||
                    null,

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


/* ============================================================
   QR IMAGE
============================================================ */

app.get(
    "/qr-image",
    async (req, res) => {

        try {

            const id =
                String(
                    req.query.id ||
                    ""
                ).trim();


            if (
                !id
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Pairing ID is required"

                });

            }


            const pairing =
                getPairing(
                    id
                );


            if (
                !pairing
            ) {

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
                        "QR code is not available"

                });

            }


            if (
                pairing.qrImage.startsWith(
                    "data:image/"
                )
            ) {

                const base64 =
                    pairing.qrImage
                        .split(
                            ","
                        )[1];


                const buffer =
                    Buffer.from(
                        base64,
                        "base64"
                    );


                res.setHeader(
                    "Content-Type",
                    "image/png"
                );


                return res.send(
                    buffer
                );

            }


            return res.json({

                success:
                    true,

                qr:
                    pairing.qrImage

            });

        } catch (error) {

            console.error(
                "[QR IMAGE]",
                error
            );


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


/* ============================================================
   TOTAL USERS
============================================================ */

app.get(
    "/total-users",
    async (req, res) => {

        try {

            const sessions =
                await readSessionRegistry();


            let deployed =
                [];


            try {

                deployed =
                    await Promise.resolve(
                        loadDeployed()
                    );

            } catch (_) {

                deployed =
                    [];

            }


            const unique =
                new Set();


            for (
                const session of
                sessions
            ) {

                if (
                    session.number
                ) {

                    unique.add(
                        cleanNumber(
                            session.number
                        )
                    );

                }

            }


            if (
                Array.isArray(
                    deployed
                )
            ) {

                for (
                    const user of
                    deployed
                ) {

                    if (
                        user.number
                    ) {

                        unique.add(
                            cleanNumber(
                                user.number
                            )
                        );

                    }

                }

            }


            res.json({

                success:
                    true,

                totalUsers:
                    unique.size,

                total:
                    unique.size,

                users:
                    unique.size,

                count:
                    unique.size

            });

        } catch (error) {

            res.json({

                success:
                    true,

                totalUsers:
                    0,

                total:
                    0,

                users:
                    0,

                count:
                    0

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

            const pairings =
                getAllPairings();

            const sessions =
                await readSessionRegistry();


            const onlinePairings =
                pairings.filter(
                    item =>
                        item.connected ===
                        true
                ).length;


            const onlineSessions =
                sessions.filter(
                    item =>
                        item.connected ===
                        true
                ).length;


            const online =
                Math.max(
                    onlinePairings,
                    onlineSessions
                );


            res.json({

                success:
                    true,

                onlineUsers:
                    online,

                online,

                activeUsers:
                    online,

                active:
                    online,

                connected:
                    online,

                totalPairings:
                    pairings.length,

                totalSessions:
                    sessions.length

            });

        } catch (error) {

            res.json({

                success:
                    true,

                onlineUsers:
                    sockets.size,

                online:
                    sockets.size,

                activeUsers:
                    sockets.size,

                active:
                    sockets.size,

                connected:
                    sockets.size

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
                await readSessionRegistry();


            let deployed =
                [];


            try {

                deployed =
                    await Promise.resolve(
                        loadDeployed()
                    );

            } catch (_) {}


            res.json({

                success:
                    true,

                sessions,

                deployed:
                    Array.isArray(
                        deployed
                    )
                        ? deployed
                        : []

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


/* ============================================================
   SESSIONS
============================================================ */

app.get(
    "/sessions",
    async (req, res) => {

        const sessions =
            await readSessionRegistry();


        res.json({

            success:
                true,

            count:
                sessions.length,

            online:
                sessions.filter(
                    item =>
                        item.connected ===
                        true
                ).length,

            sessions

        });

    }
);


app.get(
    "/api/sessions",
    async (req, res) => {

        const sessions =
            await readSessionRegistry();


        res.json({

            success:
                true,

            count:
                sessions.length,

            online:
                sessions.filter(
                    item =>
                        item.connected ===
                        true
                ).length,

            sessions

        });

    }
);


/* ============================================================
   BOT IMAGE
============================================================ */

app.get(
    "/bot-image",
    (req, res) => {

        const candidates = [

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


        const image =
            candidates.find(
                file =>
                    fs.existsSync(
                        file
                    )
            );


        if (
            !image
        ) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Bot image not found"

            });

        }


        res.sendFile(
            image
        );

    }
);


/* ============================================================
   MANAGER
============================================================ */

app.get(
    "/manager",
    async (req, res) => {

        const registry =
            await readSessionRegistry();

        const sessions =
            getAllSessions();


        res.json({

            success:
                true,

            service:
                BOT_NAME,

            multiUser:
                true,

            activeSockets:
                sockets.size,

            totalSessions:
                Math.max(
                    registry.length,
                    sessions.length
                ),

            onlineSessions:
                registry.filter(
                    item =>
                        item.connected ===
                        true
                ).length,

            sessionPrefix:
                "ETIAS-MINI-BOT~",

            sessionFormat:
                "ETIAS-MINI-BOT~12345678",

            authTransfer:
                Boolean(
                    SESSION_TRANSFER_SECRET
                )

        });

    }
);


/* ============================================================
   PAIRING SERVER INFO
============================================================ */

app.get(
    "/pairing-server",
    (req, res) => {

        res.json({

            success:
                true,

            service:
                "ETIAS-MINI-BOT Pair Server",

            multiUser:
                true,

            pairingCodeGeneration:
                true,

            sessionPrefix:
                "ETIAS-MINI-BOT~",

            sessionFormat:
                "ETIAS-MINI-BOT~12345678",

            authTransfer:
                Boolean(
                    SESSION_TRANSFER_SECRET
                )

        });

    }
);


/* ============================================================
   404
============================================================ */

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


/* ============================================================
   ERROR HANDLER
============================================================ */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            "[EXPRESS ERROR]",
            error
        );


        if (
            res.headersSent
        ) {

            return next(
                error
            );

        }


        res.status(
            500
        ).json({

            success:
                false,

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


    const sessions =
        await readSessionRegistry();


    console.log(
        "========================================"
    );

    console.log(
        `🤖 ${BOT_NAME} PAIR SERVER`
    );

    console.log(
        "========================================"
    );

    console.log(
        `PORT: ${PORT}`
    );

    console.log(
        "MULTI USER: ENABLED"
    );

    console.log(
        `PAIRINGS: ${getAllPairings().length}`
    );

    console.log(
        `SESSION MANAGER: ${getAllSessions().length}`
    );

    console.log(
        `REGISTRY: ${sessions.length}`
    );

    console.log(
        `AUTH TRANSFER: ${
            SESSION_TRANSFER_SECRET
                ? "ENABLED"
                : "DISABLED"
        }`
    );

    console.log(
        "========================================"
    );


    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                `🚀 ${BOT_NAME} Pair Server running on port ${PORT}`
            );

            console.log(
                "🌐 Multi-user pairing enabled"
            );

        }
    );

}


/* ============================================================
   PROCESS ERROR HANDLING
============================================================ */

process.on(
    "unhandledRejection",
    error => {

        console.error(
            "[UNHANDLED REJECTION]",
            error
        );

    }
);


process.on(
    "uncaughtException",
    error => {

        console.error(
            "[UNCAUGHT EXCEPTION]",
            error
        );

    }
);


/* ============================================================
   START
============================================================ */

startServer().catch(
    error => {

        console.error(
            "[STARTUP ERROR]",
            error
        );

        process.exit(
            1
        );

    }
);


/* ============================================================
   EXPORT
============================================================ */

module.exports = app;
