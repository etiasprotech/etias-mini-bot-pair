"use strict";

const crypto = require("crypto");

/*
 * ETIAS-MINI-BOT
 * Session / Deployment Manager
 *
 * After WhatsApp pairing:
 *
 *     ETIAS-MINI-BOT~22552756
 *
 * is generated and sent to the authenticated WhatsApp account.
 *
 * The deployment code remains internal and is NOT used as
 * the session ID.
 */

const deploymentCodes = new Map();

const CODE_LENGTH = 8;
const SESSION_LENGTH = 8;
const CODE_TTL = 10 * 60 * 1000; // 10 minutes

// ============================================================
// GENERATE RANDOM NUMERIC VALUE
// ============================================================

function generateNumericId(length = 8) {
    const max = 10 ** length;

    return crypto
        .randomInt(0, max)
        .toString()
        .padStart(length, "0");
}

// ============================================================
// HASH
// ============================================================

function hashCode(code) {
    return crypto
        .createHash("sha256")
        .update(String(code))
        .digest("hex");
}

// ============================================================
// GENERATE SESSION ID
// ============================================================

function generateSessionId() {
    const number = generateNumericId(SESSION_LENGTH);

    return `ETIAS-MINI-BOT~${number}`;
}

// ============================================================
// GENERATE DEPLOYMENT CODE
// ============================================================

function generateDeploymentCode({
    pairingId,
    jid,
    authFolder
}) {
    if (!pairingId) {
        throw new Error("pairingId is required");
    }

    if (!jid) {
        throw new Error("WhatsApp JID is required");
    }

    if (!authFolder) {
        throw new Error("authFolder is required");
    }

    // Internal one-time deployment verification code
    const code = generateNumericId(CODE_LENGTH);

    // Short readable session ID
    const sessionId = generateSessionId();

    const codeHash = hashCode(code);

    const expiresAt = Date.now() + CODE_TTL;

    deploymentCodes.set(pairingId, {
        pairingId,

        // New session ID
        sessionId,

        // Internal deployment code
        codeHash,

        jid,
        authFolder,

        expiresAt,

        used: false,

        createdAt: Date.now()
    });

    return {
        code,
        sessionId,
        expiresAt
    };
}

// ============================================================
// GENERATE AND SEND SESSION ID
// ============================================================

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
        normalizedJid ||
        authenticatedJid;

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

    /*
     * Generate the deployment record.
     *
     * This creates:
     *
     *   deployment code = internal
     *   session ID      = ETIAS-MINI-BOT~12345678
     */

    const {
        code,
        sessionId,
        expiresAt
    } = generateDeploymentCode({
        pairingId,
        jid: targetJid,
        authFolder
    });

    /*
     * IMPORTANT:
     *
     * Do NOT send the internal deployment code.
     *
     * Send the actual session ID.
     */

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
        "┃ contact owner for deployment\n" +
        "┃ Don't edit the session.\n" +
        "┃\n" +
        "┃ ⏳ Valid for 10 minutes\n" +
        "┃\n" +
        "╰━━━━━━━━━━━━━━━━━━━━━━╯";

    await sock.sendMessage(
        targetJid,
        {
            text: message
        }
    );

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

    /*
     * Return the SESSION ID, not the deployment code.
     */

    return {
        sessionId,

        // Kept internally for compatibility
        deploymentCode: code,

        pairingId,

        jid: targetJid,

        authFolder,

        expiresAt
    };
}

// ============================================================
// VERIFY DEPLOYMENT CODE / SESSION ID
// ============================================================

function verifyDeploymentCode(
    pairingId,
    submittedCode
) {
    const record =
        deploymentCodes.get(pairingId);

    if (!record) {
        return {
            success: false,
            error: "Deployment session not found"
        };
    }

    if (record.used) {
        return {
            success: false,
            error: "Deployment session has already been used"
        };
    }

    if (
        Date.now() >
        record.expiresAt
    ) {
        deploymentCodes.delete(pairingId);

        return {
            success: false,
            error: "Session ID has expired"
        };
    }

    const submitted =
        String(submittedCode || "")
            .trim();

    /*
     * Accept the NEW format:
     *
     * ETIAS-MINI-BOT~22552756
     *
     * This is what the user pastes into
     * the Session ID field.
     */

    if (
        submitted ===
        record.sessionId
    ) {
        record.used = true;

        deploymentCodes.set(
            pairingId,
            record
        );

        return {
            success: true,

            pairingId:
                record.pairingId,

            sessionId:
                record.sessionId,

            jid:
                record.jid,

            authFolder:
                record.authFolder
        };
    }

    /*
     * Backwards compatibility:
     *
     * Also allow the old numeric deployment
     * code if an older deployment page is
     * still being used.
     */

    const submittedHash =
        hashCode(submitted);

    if (
        submittedHash !==
        record.codeHash
    ) {
        return {
            success: false,
            error: "Invalid Session ID"
        };
    }

    record.used = true;

    deploymentCodes.set(
        pairingId,
        record
    );

    return {
        success: true,

        pairingId:
            record.pairingId,

        sessionId:
            record.sessionId,

        jid:
            record.jid,

        authFolder:
            record.authFolder
    };
}

// ============================================================
// GET DEPLOYMENT STATUS
// ============================================================

function getDeploymentCodeStatus(
    pairingId
) {
    const record =
        deploymentCodes.get(
            pairingId
        );

    if (!record) {
        return null;
    }

    if (
        Date.now() >
        record.expiresAt
    ) {
        deploymentCodes.delete(
            pairingId
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

        authFolder:
            record.authFolder,

        expiresAt:
            record.expiresAt,

        used:
            record.used
    };
}

// ============================================================
// DELETE DEPLOYMENT SESSION
// ============================================================

function deleteDeploymentCode(
    pairingId
) {
    deploymentCodes.delete(
        pairingId
    );
}

// ============================================================
// CLEANUP EXPIRED SESSIONS
// ============================================================

setInterval(
    () => {
        const now =
            Date.now();

        for (
            const [
                pairingId,
                record
            ] of deploymentCodes
        ) {
            if (
                now >
                record.expiresAt
            ) {
                deploymentCodes.delete(
                    pairingId
                );
            }
        }
    },
    60 * 1000
).unref();

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    generateAndSendSession,
    generateDeploymentCode,
    verifyDeploymentCode,
    getDeploymentCodeStatus,
    deleteDeploymentCode,
    generateSessionId
};
