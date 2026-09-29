"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const ROOT = __dirname;

const TEMP_AUTH_DIR =
    path.join(ROOT, "temp_auth");

const SESSION_PREFIX =
    "ETIAS-MINI-BOT~";

/*
 * =========================================================
 * UTILITIES
 * =========================================================
 */

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

async function ensureTempDir() {
    await fsp.mkdir(
        TEMP_AUTH_DIR,
        {
            recursive: true
        }
    );
}

function normalizeJid(value) {
    if (!value) {
        return null;
    }

    let jid = String(value).trim();

    /*
     * Baileys may return:
     *
     * 263778810589:49@s.whatsapp.net
     *
     * For DM delivery we normalize it to:
     *
     * 263778810589@s.whatsapp.net
     */
    if (jid.includes(":")) {
        const atIndex =
            jid.indexOf("@");

        if (atIndex !== -1) {
            const user =
                jid.slice(
                    0,
                    atIndex
                );

            const server =
                jid.slice(
                    atIndex + 1
                );

            jid =
                `${user.split(":")[0]}@${server}`;
        }
    }

    if (!jid.includes("@")) {
        jid =
            `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
    }

    return jid;
}

/*
 * =========================================================
 * AUTH SNAPSHOT
 * =========================================================
 *
 * Baileys may still be changing files in the live
 * auth directory.
 *
 * Therefore:
 *
 * LIVE AUTH
 *    ↓
 * SNAPSHOT
 *    ↓
 * TAR
 *    ↓
 * GZIP
 *    ↓
 * BASE64
 *
 * This prevents:
 *
 * tar: .: file changed as we read it
 */

async function createAuthSnapshot(
    authFolder
) {
    await ensureTempDir();

    if (!authFolder) {
        throw new Error(
            "Auth folder is missing"
        );
    }

    if (!fs.existsSync(authFolder)) {
        throw new Error(
            `Auth folder does not exist: ${authFolder}`
        );
    }

    const snapshotName =
        `snapshot_${crypto.randomBytes(8).toString("hex")}`;

    const snapshotFolder =
        path.join(
            TEMP_AUTH_DIR,
            snapshotName
        );

    await fsp.mkdir(
        snapshotFolder,
        {
            recursive: true
        }
    );

    console.log(
        "[SESSION] Creating stable auth snapshot..."
    );

    await fsp.cp(
        authFolder,
        snapshotFolder,
        {
            recursive: true,
            force: true,
            errorOnExist: false
        }
    );

    const credsPath =
        path.join(
            snapshotFolder,
            "creds.json"
        );

    if (!fs.existsSync(credsPath)) {

        await fsp.rm(
            snapshotFolder,
            {
                recursive: true,
                force: true
            }
        );

        throw new Error(
            "creds.json not found in auth snapshot"
        );
    }

    return snapshotFolder;
}

/*
 * =========================================================
 * CREATE SINGLE SESSION_ID
 * =========================================================
 *
 * The complete auth directory becomes ONE:
 *
 * ETIAS-MINI-BOT~BASE64...
 *
 * No splitting happens here.
 */

async function createSessionBundle(
    authFolder
) {
    console.log(
        "[SESSION] Creating full auth archive..."
    );

    const snapshotFolder =
        await createAuthSnapshot(
            authFolder
        );

    const archiveId =
        crypto.randomBytes(8).toString("hex");

    const tarPath =
        path.join(
            TEMP_AUTH_DIR,
            `${archiveId}.tar`
        );

    const gzipPath =
        `${tarPath}.gz`;

    try {

        /*
         * TAR
         */
        console.log(
            "[SESSION] Creating TAR archive..."
        );

        await execFileAsync(
            "tar",
            [
                "-cf",
                tarPath,
                "-C",
                snapshotFolder,
                "."
            ]
        );

        /*
         * GZIP
         */
        console.log(
            "[SESSION] Compressing archive..."
        );

        await execFileAsync(
            "gzip",
            [
                "-f",
                tarPath
            ]
        );

        if (
            !fs.existsSync(
                gzipPath
            )
        ) {
            throw new Error(
                "GZIP archive was not created"
            );
        }

        /*
         * BASE64
         */
        console.log(
            "[SESSION] Encoding complete archive..."
        );

        const archiveBuffer =
            await fsp.readFile(
                gzipPath
            );

        const base64 =
            archiveBuffer.toString(
                "base64"
            );

        if (!base64) {
            throw new Error(
                "Base64 archive is empty"
            );
        }

        /*
         * ONE SESSION ID
         */
        const sessionId =
            SESSION_PREFIX +
            base64;

        console.log(
            "========================================"
        );

        console.log(
            "🔐 SESSION_ID GENERATED"
        );

        console.log(
            `Archive size: ${archiveBuffer.length} bytes`
        );

        console.log(
            `SESSION_ID length: ${sessionId.length} characters`
        );

        console.log(
            "========================================"
        );

        return sessionId;

    } finally {

        /*
         * Remove temporary snapshot.
         */
        await fsp.rm(
            snapshotFolder,
            {
                recursive: true,
                force: true
            }
        ).catch(() => {});

        /*
         * Remove TAR.
         */
        await fsp.rm(
            tarPath,
            {
                force: true
            }
        ).catch(() => {});

        /*
         * Remove GZIP.
         */
        await fsp.rm(
            gzipPath,
            {
                force: true
            }
        ).catch(() => {});
    }
}

/*
 * =========================================================
 * FIRST MESSAGE
 * =========================================================
 */

async function sendConnectedMessage(
    sock,
    jid,
    pairingId
) {
    const message =
`*ETIAS-MINI-BOT CONNECTED ✅*

Your WhatsApp account has been successfully connected.

━━━━━━━━━━━━━━━━━━━━

*SESSION INFORMATION*

Your SESSION_ID will be sent in the next message.

The SESSION_ID contains the complete authentication data required by your bot.

━━━━━━━━━━━━━━━━━━━━

*IMPORTANT*

• Keep your SESSION_ID private.
• Do not post it publicly.
• Do not send it to unknown people.
• Anyone who obtains valid authentication data may be able to access the associated session.

━━━━━━━━━━━━━━━━━━━━

*PAIR ID:* ${pairingId}

*STATUS:* CONNECTED ✅

Your SESSION_ID is coming next.`;

    await sock.sendMessage(
        jid,
        {
            text: message
        }
    );

    console.log(
        `[SESSION] ✅ Connection instructions sent to ${jid}`
    );

    await sleep(1200);
}

/*
 * =========================================================
 * SECOND MESSAGE — ONE SESSION_ID
 * =========================================================
 */

async function sendSessionMessage(
    sock,
    sessionId,
    jid,
    pairingId
) {
    if (!sessionId) {
        throw new Error(
            "SESSION_ID is empty"
        );
    }

    if (
        !sessionId.startsWith(
            SESSION_PREFIX
        )
    ) {
        throw new Error(
            "Invalid SESSION_ID prefix"
        );
    }

    const targetJid =
        normalizeJid(jid);

    if (!targetJid) {
        throw new Error(
            "Invalid WhatsApp JID"
        );
    }

    /*
     * IMPORTANT:
     *
     * The complete SESSION_ID is sent as ONE
     * WhatsApp message.
     *
     * No chunking.
     * No PART 1.
     * No PART 2.
     */

    const message =
`${sessionId}`;

    console.log(
        `[SESSION] 📤 Sending ONE SESSION_ID message to ${targetJid}`
    );

    console.log(
        `[SESSION] SESSION_ID length: ${sessionId.length}`
    );

    await sock.sendMessage(
        targetJid,
        {
            text: message
        }
    );

    console.log(
        `[SESSION] 🎉 Single SESSION_ID message delivered to ${targetJid}`
    );

    return true;
}

/*
 * =========================================================
 * COMPLETE DELIVERY
 * =========================================================
 */

async function sendSessionToWhatsApp(
    sock,
    sessionId,
    jid,
    pairingId
) {
    if (!sock) {
        throw new Error(
            "WhatsApp socket unavailable"
        );
    }

    if (!sessionId) {
        throw new Error(
            "SESSION_ID is missing"
        );
    }

    const targetJid =
        normalizeJid(jid);

    if (!targetJid) {
        throw new Error(
            "Invalid WhatsApp JID"
        );
    }

    /*
     * Message 1
     */
    await sendConnectedMessage(
        sock,
        targetJid,
        pairingId
    );

    /*
     * Message 2
     *
     * Complete SESSION_ID.
     */
    await sendSessionMessage(
        sock,
        sessionId,
        targetJid,
        pairingId
    );

    console.log(
        "========================================"
    );

    console.log(
        "🎉 SESSION DELIVERY COMPLETE"
    );

    console.log(
        `JID: ${targetJid}`
    );

    console.log(
        "MESSAGES SENT: 2"
    );

    console.log(
        "SESSION PARTS: 1"
    );

    console.log(
        "========================================"
    );

    return true;
}

module.exports = {
    SESSION_PREFIX,
    normalizeJid,
    createAuthSnapshot,
    createSessionBundle,
    sendConnectedMessage,
    sendSessionMessage,
    sendSessionToWhatsApp
};
