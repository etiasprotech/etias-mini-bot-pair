"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/*
 * ============================================================
 * ETIAS-MINI-BOT
 * PERSISTENT SESSION / DEPLOYMENT MANAGER
 * ============================================================
 *
 * PUBLIC SESSION FORMAT:
 *
 *     ETIAS-MINI-BOT~22552756
 *
 * Each Session ID is permanently linked to:
 *
 *     pairingId
 *     WhatsApp JID
 *     WhatsApp number
 *     authFolder
 *     deployment status
 *
 * IMPORTANT:
 *
 * The Session ID is NOT WhatsApp authentication.
 *
 * The actual authentication is:
 *
 *     creds.json
 *     keys/*
 *
 * The pairing server must keep the authFolder available.
 *
 * ============================================================
 */


/* ============================================================
   CONFIG
============================================================ */

const CODE_LENGTH = 8;
const SESSION_LENGTH = 8;

/*
 * Session ID verification window.
 *
 * The Session ID can be submitted for deployment for
 * 10 minutes after it is generated.
 *
 * IMPORTANT:
 *
 * Once deployed, the record is retained so the deployment
 * server can still look it up.
 */
const CODE_TTL = 10 * 60 * 1000;


/*
 * Persistent database.
 */
const DATA_DIR = path.join(
    __dirname,
    "data"
);

const SESSION_FILE = path.join(
    DATA_DIR,
    "sessions.json"
);


/* ============================================================
   IN-MEMORY INDEXES
============================================================ */

/*
 * pairingId -> session record
 */
const deploymentCodes = new Map();


/*
 * sessionId -> session record
 *
 * This is the primary lookup used by:
 *
 *     /session/:sessionId
 *     /session-status/:sessionId
 *     /check-session/:sessionId
 *     /check/:sessionId
 *     /session/:sessionId/auth
 */
const sessionIndex = new Map();


/* ============================================================
   FILE HELPERS
============================================================ */

function ensureDataDirectory() {

    if (!fs.existsSync(DATA_DIR)) {

        fs.mkdirSync(
            DATA_DIR,
            {
                recursive: true
            }
        );

    }

}


/* ============================================================
   SAFE JSON WRITE
============================================================ */

function saveSessions() {

    try {

        ensureDataDirectory();

        const records = Array.from(
            sessionIndex.values()
        );

        const tempFile =
            `${SESSION_FILE}.tmp`;

        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                records,
                null,
                2
            ),
            "utf8"
        );

        fs.renameSync(
            tempFile,
            SESSION_FILE
        );

    } catch (error) {

        console.error(
            "[SESSION DB] Failed to save:",
            error.message
        );

    }

}


/* ============================================================
   LOAD DATABASE
============================================================ */

function loadSessions() {

    try {

        ensureDataDirectory();

        if (!fs.existsSync(SESSION_FILE)) {

            console.log(
                "[SESSION DB] No existing session database."
            );

            return;

        }

        const raw =
            fs.readFileSync(
                SESSION_FILE,
                "utf8"
            );

        if (!raw.trim()) {

            return;

        }

        const records =
            JSON.parse(raw);

        if (!Array.isArray(records)) {

            console.warn(
                "[SESSION DB] Invalid database format."
            );

            return;

        }

        let restored = 0;

        for (const record of records) {

            if (
                !record ||
                !record.pairingId ||
                !record.sessionId
            ) {

                continue;

            }

            /*
             * Session records that have already been deployed
             * are intentionally restored even if their original
             * 10-minute deployment window has passed.
             *
             * Non-deployed records are discarded after expiry.
             */
            if (
                !record.used &&
                record.expiresAt &&
                Date.now() > record.expiresAt
            ) {

                continue;

            }

            deploymentCodes.set(
                record.pairingId,
                record
            );

            sessionIndex.set(
                record.sessionId,
                record
            );

            restored++;

        }

        console.log(
            `[SESSION DB] Restored ${restored} session(s).`
        );

    } catch (error) {

        console.error(
            "[SESSION DB] Load failed:",
            error.message
        );

    }

}


/* ============================================================
   RANDOM NUMERIC ID
============================================================ */

function generateNumericId(
    length = 8
) {

    const max =
        10 ** length;

    return crypto
        .randomInt(
            0,
            max
        )
        .toString()
        .padStart(
            length,
            "0"
        );

}


/* ============================================================
   HASH
============================================================ */

function hashCode(
    code
) {

    return crypto
        .createHash("sha256")
        .update(
            String(code)
        )
        .digest("hex");

}


/* ============================================================
   NORMALIZE JID
============================================================ */

function normalizeJid(
    jid
) {

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


/* ============================================================
   JID -> PHONE
============================================================ */

function jidToNumber(
    jid
) {

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


/* ============================================================
   NORMALIZE PHONE
============================================================ */

function normalizePhone(
    phone
) {

    if (!phone) {

        return null;

    }

    return String(phone)
        .replace(
            /\D/g,
            ""
        );

}


/* ============================================================
   SESSION ID VALIDATION
============================================================ */

function isValidSessionId(
    sessionId
) {

    return /^ETIAS-MINI-BOT~\d{8}$/
        .test(
            String(
                sessionId || ""
            ).trim()
        );

}


/* ============================================================
   GENERATE SESSION ID
============================================================ */

function generateSessionId() {

    let sessionId;

    do {

        const number =
            generateNumericId(
                SESSION_LENGTH
            );

        sessionId =
            `ETIAS-MINI-BOT~${number}`;

    } while (
        sessionIndex.has(
            sessionId
        )
    );

    return sessionId;

}


/* ============================================================
   GENERATE DEPLOYMENT RECORD
============================================================ */

function generateDeploymentCode({
    pairingId,
    jid,
    authFolder,
    phone
}) {

    if (!pairingId) {

        throw new Error(
            "pairingId is required"
        );

    }

    if (!jid) {

        throw new Error(
            "WhatsApp JID is required"
        );

    }

    if (!authFolder) {

        throw new Error(
            "authFolder is required"
        );

    }


    /*
     * Internal compatibility code.
     *
     * This is not normally shown to the user.
     */
    const code =
        generateNumericId(
            CODE_LENGTH
        );


    /*
     * PUBLIC SESSION ID.
     */
    const sessionId =
        generateSessionId();


    const normalizedJid =
        normalizeJid(jid);

    const number =
        normalizePhone(
            phone
        ) ||
        jidToNumber(
            normalizedJid
        );


    const createdAt =
        Date.now();

    const expiresAt =
        createdAt +
        CODE_TTL;


    const record = {

        pairingId,

        sessionId,

        codeHash:
            hashCode(code),

        jid:
            normalizedJid,

        number,

        phone:
            number,

        authFolder,

        createdAt,

        updatedAt:
            createdAt,

        expiresAt,

        /*
         * false until the deployment server accepts
         * the Session ID.
         */
        used: false,

        /*
         * WhatsApp pairing is already complete when
         * this function is called.
         */
        connected: true,

        sent: false,

        status:
            "connected",

        deployedAt: null,

        deleted: false

    };


    /*
     * Store by pairing ID.
     */
    deploymentCodes.set(
        pairingId,
        record
    );


    /*
     * Store by Session ID.
     */
    sessionIndex.set(
        sessionId,
        record
    );


    saveSessions();


    console.log(
        `[SESSION DB] Created ${sessionId}`
    );

    console.log(
        `[SESSION DB] Pairing: ${pairingId}`
    );

    console.log(
        `[SESSION DB] Number: ${number || "unknown"}`
    );

    console.log(
        `[SESSION DB] Auth: ${authFolder}`
    );


    return {

        code,

        sessionId,

        pairingId,

        jid:
            normalizedJid,

        number,

        authFolder,

        expiresAt

    };

}


/* ============================================================
   GENERATE + SEND SESSION ID
============================================================ */

async function generateAndSendSession(
    sock,
    authFolder,
    authenticatedJid,
    pairingId,
    normalizedJid
) {

    if (!sock) {

        throw new Error(
            "WhatsApp socket unavailable"
        );

    }

    const targetJid =
        normalizeJid(
            normalizedJid ||
            authenticatedJid
        );

    if (!targetJid) {

        throw new Error(
            "WhatsApp JID unavailable"
        );

    }

    if (!pairingId) {

        throw new Error(
            "pairingId is required"
        );

    }

    if (!authFolder) {

        throw new Error(
            "authFolder is required"
        );

    }


    const result =
        generateDeploymentCode({

            pairingId,

            jid:
                targetJid,

            authFolder,

            phone:
                jidToNumber(
                    targetJid
                )

        });


    const {
        sessionId,
        expiresAt,
        number
    } = result;


    const message =

        "╭━━━〔 ETIAS-MINI-BOT 〕━━━╮\n" +
        "┃\n" +
        "┃ ✅ WHATSAPP PAIRED\n" +
        "┃\n" +
        "┃ 🔑 SESSION ID\n" +
        "┃\n" +
        `┃ ${sessionId}\n` +
        "┃\n" +
        "┃ Copy the Session ID above\n" +
        "┃ and use it for deployment.\n" +
        "┃\n" +
        "┃ ⚠️ Keep this Session ID private.\n" +
        "┃\n" +
        "┃ ⏳ Deployment window: 10 minutes\n" +
        "┃\n" +
        "╰━━━━━━━━━━━━━━━━━━━━━━╯";


    await sock.sendMessage(
        targetJid,
        {
            text: message
        }
    );


    const record =
        sessionIndex.get(
            sessionId
        );


    if (record) {

        record.sent = true;

        record.status =
            "session_sent";

        record.updatedAt =
            Date.now();

        deploymentCodes.set(
            record.pairingId,
            record
        );

        sessionIndex.set(
            record.sessionId,
            record
        );

        saveSessions();

    }


    console.log(
        "========================================"
    );

    console.log(
        "[SESSION] WhatsApp pairing completed"
    );

    console.log(
        `[SESSION] Pairing ID: ${pairingId}`
    );

    console.log(
        `[SESSION] JID: ${targetJid}`
    );

    console.log(
        `[SESSION] Number: ${number || "unknown"}`
    );

    console.log(
        `[SESSION] Session ID: ${sessionId}`
    );

    console.log(
        `[SESSION] Auth folder: ${authFolder}`
    );

    console.log(
        `[SESSION] Expires: ${new Date(
            expiresAt
        ).toISOString()}`
    );

    console.log(
        "========================================"
    );


    return {

        sessionId,

        /*
         * Compatibility field.
         */
        deploymentCode:
            result.code,

        pairingId,

        jid:
            targetJid,

        number,

        authFolder,

        expiresAt

    };

}


/* ============================================================
   GET SESSION BY ID
============================================================ */

function getSessionById(
    sessionId
) {

    const id =
        String(
            sessionId || ""
        ).trim();


    if (!id) {

        return null;

    }


    if (!isValidSessionId(id)) {

        return null;

    }


    const record =
        sessionIndex.get(
            id
        );


    if (!record) {

        return null;

    }


    /*
     * Do not delete deployed sessions just because the
     * original 10-minute window expired.
     */
    if (
        !record.used &&
        record.expiresAt &&
        Date.now() > record.expiresAt
    ) {

        deleteDeploymentCode(
            record.pairingId
        );

        return null;

    }


    return {

        pairingId:
            record.pairingId,

        sessionId:
            record.sessionId,

        jid:
            record.jid,

        number:
            record.number,

        phone:
            record.phone ||
            record.number,

        authFolder:
            record.authFolder,

        createdAt:
            record.createdAt,

        expiresAt:
            record.expiresAt,

        used:
            record.used,

        connected:
            record.connected,

        sent:
            record.sent,

        status:
            record.status,

        deployedAt:
            record.deployedAt,

        updatedAt:
            record.updatedAt ||
            record.createdAt

    };

}


/* ============================================================
   GET SESSION RECORD - INTERNAL
============================================================ */

function getRawSession(
    sessionId
) {

    return sessionIndex.get(
        String(
            sessionId || ""
        ).trim()
    ) || null;

}


/* ============================================================
   VERIFY SESSION
============================================================ */

function verifyDeploymentCode(
    pairingId,
    submittedCode
) {

    const record =
        deploymentCodes.get(
            String(
                pairingId || ""
            ).trim()
        );


    if (!record) {

        return {

            success: false,

            error:
                "Deployment session not found"

        };

    }


    /*
     * Expired and not yet deployed.
     */
    if (
        !record.used &&
        record.expiresAt &&
        Date.now() >
        record.expiresAt
    ) {

        deleteDeploymentCode(
            record.pairingId
        );

        return {

            success: false,

            error:
                "Session ID has expired"

        };

    }


    const submitted =
        String(
            submittedCode || ""
        ).trim();


    /*
     * PUBLIC SESSION ID.
     */
    if (
        submitted ===
        record.sessionId
    ) {

        return {

            success: true,

            pairingId:
                record.pairingId,

            sessionId:
                record.sessionId,

            jid:
                record.jid,

            number:
                record.number,

            phone:
                record.phone ||
                record.number,

            authFolder:
                record.authFolder,

            expiresAt:
                record.expiresAt,

            used:
                record.used,

            connected:
                record.connected,

            status:
                record.status

        };

    }


    /*
     * BACKWARDS COMPATIBILITY:
     *
     * Accept old numeric deployment code.
     */
    const submittedHash =
        hashCode(
            submitted
        );


    if (
        submittedHash !==
        record.codeHash
    ) {

        return {

            success: false,

            error:
                "Invalid Session ID"

        };

    }


    return {

        success: true,

        pairingId:
            record.pairingId,

        sessionId:
            record.sessionId,

        jid:
            record.jid,

        number:
            record.number,

        phone:
            record.phone ||
            record.number,

        authFolder:
            record.authFolder,

        expiresAt:
            record.expiresAt,

        used:
            record.used,

        connected:
            record.connected,

        status:
            record.status

    };

}


/* ============================================================
   MARK SESSION DEPLOYED
============================================================ */

function markSessionDeployed(
    sessionId
) {

    const id =
        String(
            sessionId || ""
        ).trim();


    const record =
        sessionIndex.get(
            id
        );


    if (!record) {

        return {

            success: false,

            error:
                "Session ID not found"

        };

    }


    record.used = true;

    record.status =
        "deployed";

    record.deployedAt =
        Date.now();

    record.updatedAt =
        Date.now();


    deploymentCodes.set(
        record.pairingId,
        record
    );

    sessionIndex.set(
        record.sessionId,
        record
    );


    saveSessions();


    console.log(
        `[SESSION DB] ${record.sessionId} marked deployed`
    );


    return {

        success: true,

        sessionId:
            record.sessionId,

        pairingId:
            record.pairingId,

        jid:
            record.jid,

        number:
            record.number,

        authFolder:
            record.authFolder,

        status:
            record.status,

        deployedAt:
            record.deployedAt

    };

}


/* ============================================================
   UPDATE SESSION
============================================================ */

function updateSession(
    sessionId,
    updates = {}
) {

    const id =
        String(
            sessionId || ""
        ).trim();


    const record =
        sessionIndex.get(
            id
        );


    if (!record) {

        return null;

    }


    const allowedFields = [

        "jid",
        "number",
        "phone",
        "authFolder",
        "connected",
        "sent",
        "used",
        "status",
        "deployedAt"

    ];


    for (
        const field of allowedFields
    ) {

        if (
            Object.prototype.hasOwnProperty.call(
                updates,
                field
            )
        ) {

            record[field] =
                updates[field];

        }

    }


    if (updates.jid) {

        record.jid =
            normalizeJid(
                updates.jid
            );

    }


    if (updates.phone || updates.number) {

        const number =
            normalizePhone(
                updates.phone ||
                updates.number
            );

        record.number =
            number;

        record.phone =
            number;

    }


    record.updatedAt =
        Date.now();


    deploymentCodes.set(
        record.pairingId,
        record
    );

    sessionIndex.set(
        record.sessionId,
        record
    );


    saveSessions();


    return getSessionById(
        record.sessionId
    );

}


/* ============================================================
   GET STATUS BY PAIRING ID
============================================================ */

function getDeploymentCodeStatus(
    pairingId
) {

    const record =
        deploymentCodes.get(
            String(
                pairingId || ""
            ).trim()
        );


    if (!record) {

        return null;

    }


    /*
     * Keep deployed records accessible.
     */
    if (
        !record.used &&
        record.expiresAt &&
        Date.now() >
        record.expiresAt
    ) {

        deleteDeploymentCode(
            record.pairingId
        );

        return null;

    }


    return {

        pairingId:
            record.pairingId,

        sessionId:
            record.sessionId,

        jid:
            record.jid,

        number:
            record.number,

        phone:
            record.phone ||
            record.number,

        authFolder:
            record.authFolder,

        expiresAt:
            record.expiresAt,

        used:
            record.used,

        connected:
            record.connected,

        sent:
            record.sent,

        status:
            record.status,

        createdAt:
            record.createdAt,

        deployedAt:
            record.deployedAt,

        updatedAt:
            record.updatedAt

    };

}


/* ============================================================
   GET ALL SESSIONS
============================================================ */

function getAllSessions() {

    const now =
        Date.now();

    const sessions = [];


    for (
        const record of
        sessionIndex.values()
    ) {

        /*
         * Remove only expired sessions that were never deployed.
         */
        if (
            !record.used &&
            record.expiresAt &&
            now > record.expiresAt
        ) {

            continue;

        }


        sessions.push({

            pairingId:
                record.pairingId,

            sessionId:
                record.sessionId,

            jid:
                record.jid,

            number:
                record.number,

            phone:
                record.phone ||
                record.number,

            authFolder:
                record.authFolder,

            expiresAt:
                record.expiresAt,

            used:
                record.used,

            connected:
                record.connected,

            sent:
                record.sent,

            status:
                record.status,

            createdAt:
                record.createdAt,

            deployedAt:
                record.deployedAt,

            updatedAt:
                record.updatedAt

        });

    }


    return sessions;

}


/* ============================================================
   DELETE BY PAIRING ID
============================================================ */

function deleteDeploymentCode(
    pairingId
) {

    const id =
        String(
            pairingId || ""
        ).trim();


    const record =
        deploymentCodes.get(
            id
        );


    if (record) {

        sessionIndex.delete(
            record.sessionId
        );

    }


    deploymentCodes.delete(
        id
    );


    saveSessions();

}


/* ============================================================
   DELETE BY SESSION ID
============================================================ */

function deleteSessionById(
    sessionId
) {

    const id =
        String(
            sessionId || ""
        ).trim();


    const record =
        sessionIndex.get(
            id
        );


    if (!record) {

        return false;

    }


    deploymentCodes.delete(
        record.pairingId
    );

    sessionIndex.delete(
        record.sessionId
    );


    saveSessions();


    console.log(
        `[SESSION DB] Deleted ${id}`
    );


    return true;

}


/* ============================================================
   CLEANUP EXPIRED UNDEPLOYED SESSIONS
============================================================ */

function cleanupExpiredSessions() {

    const now =
        Date.now();

    let removed = 0;


    for (
        const [
            pairingId,
            record
        ] of deploymentCodes
    ) {

        /*
         * Never remove deployed sessions simply because their
         * original Session ID window has passed.
         */
        if (
            record.used
        ) {

            continue;

        }


        if (
            record.expiresAt &&
            now >
            record.expiresAt
        ) {

            deploymentCodes.delete(
                pairingId
            );

            sessionIndex.delete(
                record.sessionId
            );

            removed++;

        }

    }


    if (removed > 0) {

        saveSessions();

        console.log(
            `[SESSION DB] Removed ${removed} expired session(s).`
        );

    }

}


/* ============================================================
   RESTORE
============================================================ */

loadSessions();


/* ============================================================
   CLEANUP TIMER
============================================================ */

setInterval(
    cleanupExpiredSessions,
    60 * 1000
).unref();


/* ============================================================
   EXPORTS
============================================================ */

module.exports = {

    /*
     * Main pairing flow
     */
    generateAndSendSession,

    /*
     * Session generation
     */
    generateDeploymentCode,

    generateSessionId,

    /*
     * Verification
     */
    verifyDeploymentCode,

    /*
     * Lookups
     */
    getSessionById,

    getDeploymentCodeStatus,

    getAllSessions,

    /*
     * Deployment state
     */
    markSessionDeployed,

    updateSession,

    /*
     * Internal lookup
     */
    getRawSession,

    /*
     * Delete
     */
    deleteDeploymentCode,

    deleteSessionById

};
