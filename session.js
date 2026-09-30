"use strict";

const crypto = require("crypto");

/*
 * In-memory deployment-code store.
 *
 * For production with multiple Render instances,
 * move this to MongoDB/Redis so codes survive restarts
 * and are shared between instances.
 */
const deploymentCodes = new Map();

const CODE_LENGTH = 8;
const CODE_TTL = 10 * 60 * 1000; // 10 minutes

function generateCode() {
    /*
     * Generate exactly 8 numeric digits.
     * Leading zeroes are allowed.
     */
    return crypto
        .randomInt(0, 100000000)
        .toString()
        .padStart(CODE_LENGTH, "0");
}

function hashCode(code) {
    return crypto
        .createHash("sha256")
        .update(String(code))
        .digest("hex");
}

function generateDeploymentCode({
    pairingId,
    jid,
    authFolder
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

    const code = generateCode();

    const codeHash = hashCode(code);

    const expiresAt =
        Date.now() + CODE_TTL;

    deploymentCodes.set(
        pairingId,
        {
            pairingId,
            jid,
            authFolder,
            codeHash,
            expiresAt,
            used: false,
            createdAt: Date.now()
        }
    );

    return {
        code,
        expiresAt
    };
}

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

    /*
     * Generate a one-time deployment code.
     */
    const {
        code,
        expiresAt
    } = generateDeploymentCode({
        pairingId,
        jid: targetJid,
        authFolder
    });

    const message =
        "╭━━━〔 ETIAS-MINI-BOT 〕━━━╮\n" +
        "┃\n" +
        "┃ DEPLOYMENT CODE\n" +
        "┃\n" +
        `┃ ${code}\n` +
        "┃\n" +
        "┃ Enter this code on the\n" +
        "┃ deployment page to link\n" +
        "┃ your bot.\n" +
        "┃\n" +
        "┃ Expires in 10 minutes.\n" +
        "┃ One-time use only.\n" +
        "┃\n" +
        "╰━━━━━━━━━━━━━━━━━━━━━━╯";

    /*
     * Send the code directly as a message.
     */
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
        "[DEPLOYMENT] Code generated"
    );

    console.log(
        `[DEPLOYMENT] Pairing ID: ${pairingId}`
    );

    console.log(
        `[DEPLOYMENT] JID: ${targetJid}`
    );

    console.log(
        `[DEPLOYMENT] Code expires: ${new Date(
            expiresAt
        ).toISOString()}`
    );

    console.log(
        "========================================"
    );

    /*
     * Return the code to index.js.
     *
     * Do not log the actual code in production.
     */
    return {
        sessionId: code,
        deploymentCode: code,
        pairingId,
        jid: targetJid,
        expiresAt
    };
}

/*
 * Verify a code entered on the deployment page.
 */
function verifyDeploymentCode(
    pairingId,
    submittedCode
) {
    const record =
        deploymentCodes.get(
            pairingId
        );

    if (!record) {
        return {
            success: false,
            error:
                "Deployment code not found"
        };
    }

    if (record.used) {
        return {
            success: false,
            error:
                "Deployment code has already been used"
        };
    }

    if (
        Date.now() >
        record.expiresAt
    ) {
        deploymentCodes.delete(
            pairingId
        );

        return {
            success: false,
            error:
                "Deployment code has expired"
        };
    }

    const submittedHash =
        hashCode(
            String(
                submittedCode
            ).trim()
        );

    if (
        submittedHash !==
        record.codeHash
    ) {
        return {
            success: false,
            error:
                "Invalid deployment code"
        };
    }

    /*
     * One-time use.
     */
    record.used = true;

    deploymentCodes.set(
        pairingId,
        record
    );

    return {
        success: true,
        pairingId:
            record.pairingId,
        jid:
            record.jid,
        authFolder:
            record.authFolder
    };
}

/*
 * Get deployment information without
 * exposing the actual code.
 */
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
        jid:
            record.jid,
        expiresAt:
            record.expiresAt,
        used:
            record.used
    };
}

/*
 * Remove an existing code.
 */
function deleteDeploymentCode(
    pairingId
) {
    deploymentCodes.delete(
        pairingId
    );
}

/*
 * Cleanup expired codes.
 */
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

module.exports = {
    generateAndSendSession,
    generateDeploymentCode,
    verifyDeploymentCode,
    getDeploymentCodeStatus,
    deleteDeploymentCode
};
