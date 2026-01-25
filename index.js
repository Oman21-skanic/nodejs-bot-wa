const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")

// ===== CONFIG =====
const OWNER = "6288291045579@s.whatsapp.net"
const TRIGGERS = ["yeayyy", "y", "apaa sekali lihat", "cantikk bilaa", "sekali liat wae", "apa coba sekali liat", "mau liat ah kepo"]

// ===== UNWRAP VIEW-ONCE =====
function unwrapMessage(msg) {
  let m = msg
  while (true) {
    if (!m) return null
    if (m.imageMessage || m.videoMessage) return m
    if (m.viewOnceMessage) m = m.viewOnceMessage.message
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message
    else if (m.ephemeralMessage) m = m.ephemeralMessage.message
    else return null
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth")
  const sock = makeWASocket({
    auth: state,
    browser: ["ViewOnce Bot", "Chrome", "1.0.0"],
    printQRInTerminal: false
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
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message) continue
        if (msg.key.remoteJid === "status@broadcast") continue

        const from = msg.key.remoteJid
        const sender = msg.key.participant || from
        const body =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ""

        console.log("📩 MSG:", body)

        // ===== TRIGGER REPLY "yeayyy" =====
        if (!TRIGGERS.includes(body.toLowerCase())) continue

        const ctx = msg.message.extendedTextMessage?.contextInfo
        if (!ctx?.quotedMessage) continue

        console.log("⚡ REPLY VIEW-ONCE DETECTED")

        // ===== UNWRAP =====
        const unwrapped = unwrapMessage(ctx.quotedMessage)
        if (!unwrapped) throw new Error("Media tidak ditemukan")

        const media = unwrapped.imageMessage || unwrapped.videoMessage
        if (!media) throw new Error("Media tidak ditemukan")

        const mediaKey = {
          remoteJid: from,
          fromMe: false,
          id: ctx.stanzaId,
          participant: ctx.participant
        }

        const buffer = await downloadMediaMessage(
          {
            key: mediaKey,
            message: ctx.quotedMessage
          },
          "buffer",
          {},
          { reuploadRequest: sock.updateMediaMessage }
        )

        const type = media.mimetype.startsWith("video") ? "video" : "image"

        await sock.sendMessage(OWNER, {
          [type]: buffer,
          caption: "📥 View-once via reply"
        })

        console.log("✅ VIEW-ONCE TERKIRIM KE OWNER")
      } catch (err) {
        console.error("❌ HANDLER ERROR:", err.message || err)
      }
    }
  })
}

startBot()