const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require("@whiskeysockets/baileys")

const qrcode = require("qrcode-terminal")

// ================= CONFIG =================
const OWNER = "6288291045579@s.whatsapp.net"
const TARGET_LID = "247369195061455@lid" // LID TARGET (PASTIKAN BENAR)

// =========================================
function unwrapQuotedMessage(quoted) {
  let m = quoted
  while (true) {
    if (!m) return null
    if (m.imageMessage || m.videoMessage) return m
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message
    else if (m.ephemeralMessage) m = m.ephemeralMessage.message
    else return null
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({
    auth: state,
    browser: ["Reply-VO Bot", "Chrome", "1.0.0"]
  })

  sock.ev.on("creds.update", saveCreds)

  // ===== CONNECTION =====
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true })

    if (connection === "open") {
      console.log("✅ BOT CONNECTED & READY")
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log("❌ DISCONNECTED:", code)
      if (code !== DisconnectReason.loggedOut) startBot()
    }
  })

  // ===== MESSAGE HANDLER =====
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return

    for (const msg of messages) {
      try {
        if (!msg.message) continue

        const jid = msg.key.remoteJid
        if (jid !== TARGET_LID) continue

        const ctx = msg.message.extendedTextMessage?.contextInfo
        if (!ctx?.quotedMessage) continue // ❌ bukan reply

        console.log("⚡ REPLY DARI TARGET TERDETEKSI")

        const unwrapped = unwrapQuotedMessage(ctx.quotedMessage)
        if (!unwrapped) {
          console.log("⏭️ reply tapi bukan view-once")
          continue
        }

        const media = unwrapped.imageMessage || unwrapped.videoMessage
        if (!media?.mimetype) continue

        console.log("📸 VIEW-ONCE TERDETEKSI")

        const buffer = await downloadMediaMessage(
          {
            key: {
              remoteJid: jid,
              fromMe: false,
              id: ctx.stanzaId,
              participant: ctx.participant
            },
            message: ctx.quotedMessage
          },
          "buffer",
          {},
          { reuploadRequest: sock.updateMediaMessage }
        )

        const typeMedia = media.mimetype.startsWith("video")
          ? "video"
          : "image"

        await sock.sendMessage(OWNER, {
          [typeMedia]: buffer,
          caption: "📥 Auto View-Once via Reply"
        })

        console.log("✅ VIEW-ONCE BERHASIL DI-DOWNLOAD")
      } catch (err) {
        console.error("❌ ERROR:", err.message || err)
      }
    }
  })
}

startBot()
