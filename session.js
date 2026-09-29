// ============================================================
// ETIAS-MINI-BOT
// SESSION GENERATOR
//
// Generates the COMPLETE multi-file Baileys auth session,
// converts it to:
//      TAR -> GZIP -> BASE64
//
// Then creates a JSON file named:
//      creds.json
//
// The JSON file contains the COMPLETE SESSION_ID.
//
// The session is sent to WhatsApp as a DOCUMENT,
// NOT as a normal text message.
//
// This prevents WhatsApp from truncating long sessions.
// ============================================================

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFileSync } = require("child_process");


// ============================================================
// CONFIG
// ============================================================

const PREFIX_SESSION =
    "ETIAS-MINI-BOT~";

const TEMP_AUTH_PATH =
    path.join(
        __dirname,
        "temp_auth"
    );

const SESSION_FILES_PATH =
    path.join(
        __dirname,
        "data",
        "sessions"
    );


// ============================================================
// CREATE DIRECTORIES
// ============================================================

for (
    const dir of [
        TEMP_AUTH_PATH,
        SESSION_FILES_PATH
    ]
) {

    if (
        !fs.existsSync(dir)
    ) {

        fs.mkdirSync(
            dir,
            {
                recursive: true
            }
        );

    }

}


// ============================================================
// LOG
// ============================================================

function log(message) {

    console.log(
        `[SESSION] ${message}`
    );

}


// ============================================================
// NORMALIZE JID
// ============================================================

function normalizeJid(value) {

    if (!value) {

        return "";

    }

    return String(value)
        .split(":")[0]
        .split("@")[0]
        .replace(
            /[^0-9]/g,
            ""
        );

}


// ============================================================
// CREATE STABLE AUTH SNAPSHOT
//
// Baileys may modify auth files while TAR is reading them.
// Therefore we first copy the complete auth folder to a
// temporary snapshot.
//
// This prevents:
//
//     tar: file changed as we read it
//
// ============================================================

async function createAuthSnapshot(
    authFolder
) {

    if (
        !fs.existsSync(authFolder)
    ) {

        throw new Error(
            "Auth folder does not exist"
        );

    }


    const credsPath =
        path.join(
            authFolder,
            "creds.json"
        );


    if (
        !fs.existsSync(credsPath)
    ) {

        throw new Error(
            "creds.json not found in auth folder"
        );

    }


    const snapshotName =
        `snapshot-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;


    const snapshotPath =
        path.join(
            TEMP_AUTH_PATH,
            snapshotName
        );


    await fsp.mkdir(
        snapshotPath,
        {
            recursive: true
        }
    );


    try {

        await fsp.cp(
            authFolder,
            snapshotPath,
            {
                recursive: true,
                force: true
            }
        );


        if (
            !fs.existsSync(
                path.join(
                    snapshotPath,
                    "creds.json"
                )
            )
        ) {

            throw new Error(
                "Snapshot does not contain creds.json"
            );

        }


        return snapshotPath;

    } catch (error) {

        try {

            await fsp.rm(
                snapshotPath,
                {
                    recursive: true,
                    force: true
                }
            );

        } catch {}


        throw error;

    }

}


// ============================================================
// CREATE SESSION BUNDLE
//
// COMPLETE AUTH DIRECTORY
//          |
//          v
//       TAR FILE
//          |
//          v
//      GZIP FILE
//          |
//          v
//       BASE64
//          |
//          v
// ETIAS-MINI-BOT~BASE64
//
// Returns the COMPLETE session string.
// ============================================================

async function createSessionBundle(
    authFolder
) {

    let snapshotPath = null;

    const random =
        crypto
            .randomBytes(8)
            .toString("hex");


    const tarPath =
        path.join(
            TEMP_AUTH_PATH,
            `session-${random}.tar`
        );


    const gzipPath =
        `${tarPath}.gz`;


    try {

        log(
            "Creating stable auth snapshot..."
        );


        snapshotPath =
            await createAuthSnapshot(
                authFolder
            );


        log(
            "Creating TAR archive..."
        );


        execFileSync(
            "tar",
            [
                "-cf",
                tarPath,
                "-C",
                snapshotPath,
                "."
            ],
            {
                stdio: "ignore"
            }
        );


        if (
            !fs.existsSync(tarPath)
        ) {

            throw new Error(
                "TAR archive was not created"
            );

        }


        log(
            "Compressing session..."
        );


        execFileSync(
            "gzip",
            [
                "-f",
                tarPath
            ],
            {
                stdio: "ignore"
            }
        );


        if (
            !fs.existsSync(gzipPath)
        ) {

            throw new Error(
                "GZIP archive was not created"
            );

        }


        const compressed =
            await fsp.readFile(
                gzipPath
            );


        if (
            !compressed.length
        ) {

            throw new Error(
                "Generated session archive is empty"
            );

        }


        const base64 =
            compressed.toString(
                "base64"
            );


        if (
            !base64.length
        ) {

            throw new Error(
                "Generated Base64 session is empty"
            );

        }


        const sessionId =
            PREFIX_SESSION +
            base64;


        log(
            `SESSION_ID generated: ${sessionId.length} characters`
        );


        return sessionId;

    } finally {

        try {

            await fsp.rm(
                tarPath,
                {
                    force: true
                }
            );

        } catch {}


        try {

            await fsp.rm(
                gzipPath,
                {
                    force: true
                }
            );

        } catch {}


        if (
            snapshotPath
        ) {

            try {

                await fsp.rm(
                    snapshotPath,
                    {
                        recursive: true,
                        force: true
                    }
                );

            } catch {}

        }

    }

}


// ============================================================
// CREATE SESSION JSON
//
// This creates:
//
// data/sessions/NUMBER/creds.json
//
// Example:
//
// {
//   "sessionId": "ETIAS-MINI-BOT~....",
//   "number": "2637...",
//   "pairId": "...",
//   "createdAt": "..."
// }
//
// IMPORTANT:
// This is the generated ETIAS SESSION_ID file.
// It is NOT the original Baileys creds.json.
// ============================================================

async function createSessionFile(
    sessionId,
    number,
    pairingId
) {

    const cleanNumber =
        normalizeJid(
            number
        ) ||
        "unknown";


    const userDirectory =
        path.join(
            SESSION_FILES_PATH,
            cleanNumber
        );


    await fsp.mkdir(
        userDirectory,
        {
            recursive: true
        }
    );


    const filePath =
        path.join(
            userDirectory,
            "creds.json"
        );


    const payload = {

        sessionId,

        number:
            cleanNumber,

        pairId:
            pairingId ||
            null,

        createdAt:
            new Date().toISOString(),

        format:
            "ETIAS-MINI-BOT-SESSION",

        version:
            1

    };


    await fsp.writeFile(
        filePath,
        JSON.stringify(
            payload,
            null,
            2
        ),
        "utf8"
    );


    log(
        `Session file created: ${filePath}`
    );


    return {

        filePath,

        payload

    };

}


// ============================================================
// READ SESSION FILE
//
// Useful if another part of the application needs to load
// a previously generated creds.json.
// ============================================================

async function readSessionFile(
    filePath
) {

    if (
        !fs.existsSync(filePath)
    ) {

        throw new Error(
            "Session file not found"
        );

    }


    const raw =
        await fsp.readFile(
            filePath,
            "utf8"
        );


    let data;


    try {

        data =
            JSON.parse(raw);

    } catch {

        /*
         * Also support a file containing
         * only the raw session string.
         */

        const session =
            raw.trim();


        if (
            session.startsWith(
                PREFIX_SESSION
            )
        ) {

            return session;

        }


        throw new Error(
            "Invalid session JSON file"
        );

    }


    if (
        typeof data.sessionId !==
        "string"
    ) {

        throw new Error(
            "creds.json does not contain sessionId"
        );

    }


    if (
        !data.sessionId.startsWith(
            PREFIX_SESSION
        )
    ) {

        throw new Error(
            "Invalid ETIAS-MINI-BOT sessionId"
        );

    }


    return data.sessionId;

}


// ============================================================
// SEND CONNECTED MESSAGE
//
// This is the first WhatsApp message.
//
// No session data is placed in this message.
// ============================================================

async function sendConnectedMessage(
    sock,
    jid,
    pairingId
) {

    if (!jid) {

        throw new Error(
            "WhatsApp JID is required"
        );

    }


    const text =

`*ETIAS-MINI-BOT*

━━━━━━━━━━━━━━━━━━━━

✅ *WHATSAPP CONNECTED*

PAIR ID:
${pairingId || "N/A"}

STATUS:
CONNECTED ✅

Your SESSION_ID has been generated.

It will be sent as a secure file named:

📄 creds.json

━━━━━━━━━━━━━━━━━━━━

⚠️ *IMPORTANT*

• Keep the file private.
• Do not post it publicly.
• Do not send it to unknown people.
• Anyone with valid authentication data may access the associated session.

━━━━━━━━━━━━━━━━━━━━

Powered by ETIAS TECH`;


    await sock.sendMessage(
        jid,
        {
            text
        }
    );


    log(
        `Connected message sent to ${jid}`
    );

}


// ============================================================
// SEND SESSION FILE
//
// The SESSION_ID is sent as a WhatsApp DOCUMENT.
//
// Filename:
//
//     creds.json
//
// MIME:
//
//     application/json
//
// Therefore even a very long session is transferred as a
// document instead of being restricted by WhatsApp's normal
// text-message length.
// ============================================================

async function sendSessionMessage(
    sock,
    sessionId,
    jid,
    pairingId,
    number
) {

    if (!sock) {

        throw new Error(
            "WhatsApp socket is required"
        );

    }


    if (!sessionId) {

        throw new Error(
            "SESSION_ID is empty"
        );

    }


    if (!jid) {

        throw new Error(
            "WhatsApp JID is required"
        );

    }


    /*
     * Validate session.
     */

    if (
        !sessionId.startsWith(
            PREFIX_SESSION
        )
    ) {

        throw new Error(
            "Invalid ETIAS-MINI-BOT SESSION_ID"
        );

    }


    /*
     * Create the JSON object.
     */

    const payload = {

        sessionId,

        number:
            normalizeJid(
                number ||
                jid
            ),

        pairId:
            pairingId ||
            null,

        createdAt:
            new Date().toISOString(),

        format:
            "ETIAS-MINI-BOT-SESSION",

        version:
            1

    };


    /*
     * Convert JSON to a Buffer.
     *
     * Buffer is important because it sends the
     * complete file directly.
     */

    const json =
        JSON.stringify(
            payload,
            null,
            2
        );


    const documentBuffer =
        Buffer.from(
            json,
            "utf8"
        );


    log(
        `Sending creds.json (${documentBuffer.length} bytes)...`
    );


    /*
     * Send as WhatsApp document.
     */

    await sock.sendMessage(
        jid,
        {

            document:
                documentBuffer,

            mimetype:
                "application/json",

            fileName:
                "creds.json",

            caption:
                `🔐 *ETIAS-MINI-BOT SESSION*\n\n` +
                `📄 File: creds.json\n` +
                `📱 Number: ${normalizeJid(number || jid)}\n` +
                `🆔 Pair ID: ${pairingId || "N/A"}\n\n` +
                `⚠️ Keep this file private.\n` +
                `Do not forward or publish it.`

        }
    );


    log(
        "✅ creds.json sent successfully"
    );


    return true;

}


// ============================================================
// SEND COMPLETE SESSION
//
// EXACTLY TWO MESSAGES:
//
// 1. Connected message
// 2. creds.json document
//
// No long session text is sent.
// No PART messages are required.
// ============================================================

async function sendSessionToWhatsApp(
    sock,
    sessionId,
    jid,
    pairingId,
    number
) {

    if (!sock) {

        throw new Error(
            "Socket unavailable"
        );

    }


    if (!sessionId) {

        throw new Error(
            "SESSION_ID unavailable"
        );

    }


    const targetJid =
        jid ||
        sock.user?.id;


    if (!targetJid) {

        throw new Error(
            "Unable to determine WhatsApp JID"
        );

    }


    const actualNumber =
        normalizeJid(
            number ||
            sock.user?.id ||
            targetJid
        );


    /*
     * Message 1:
     * Connected notification.
     */

    await sendConnectedMessage(
        sock,
        targetJid,
        pairingId
    );


    /*
     * Small delay so WhatsApp receives the
     * connected notification before the file.
     */

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                800
            )
    );


    /*
     * Message 2:
     * Complete SESSION_ID as creds.json.
     */

    await sendSessionMessage(
        sock,
        sessionId,
        targetJid,
        pairingId,
        actualNumber
    );


    log(
        `MESSAGES SENT: 2`
    );


    log(
        `SESSION FORMAT: JSON DOCUMENT`
    );


    log(
        `SESSION LENGTH: ${sessionId.length}`
    );


    return true;

}


// ============================================================
// GENERATE + SAVE + SEND
//
// Convenience function used by index.js.
//
// Flow:
//
// Baileys auth
//     |
//     v
// createSessionBundle()
//     |
//     v
// SESSION_ID
//     |
//     +----> create creds.json
//     |
//     +----> send creds.json to WhatsApp
// ============================================================

async function generateAndSendSession(
    sock,
    authFolder,
    jid,
    pairingId,
    number
) {

    log(
        "Generating SESSION_ID..."
    );


    const sessionId =
        await createSessionBundle(
            authFolder
        );


    /*
     * Save permanent JSON session file.
     */

    const sessionFile =
        await createSessionFile(
            sessionId,
            number ||
                sock?.user?.id ||
                jid,
            pairingId
        );


    log(
        `Session saved to ${sessionFile.filePath}`
    );


    /*
     * Send file to WhatsApp.
     */

    await sendSessionToWhatsApp(
        sock,
        sessionId,
        jid ||
            sock?.user?.id,
        pairingId,
        number ||
            sock?.user?.id ||
            jid
    );


    return {

        sessionId,

        filePath:
            sessionFile.filePath,

        number:
            normalizeJid(
                number ||
                sock?.user?.id ||
                jid
            )

    };

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    PREFIX_SESSION,

    normalizeJid,

    createAuthSnapshot,

    createSessionBundle,

    createSessionFile,

    readSessionFile,

    sendConnectedMessage,

    sendSessionMessage,

    sendSessionToWhatsApp,

    generateAndSendSession

};
