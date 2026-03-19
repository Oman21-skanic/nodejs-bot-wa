require("dotenv").config()
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  downloadContentFromMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require("baileys")

const qrcode = require("qrcode-terminal")
const pino = require("pino")
const { Boom } = require("@hapi/boom")
const fs = require("fs")
const os = require("os")
const path = require("path")
const sqlite3 = require("sqlite3").verbose()
const express = require("express")
const axios = require("axios")
const ExifParser = require("exif-parser")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")

// ================= CONFIG =================
const OWNER = process.env.OWNER || "6288291045579@s.whatsapp.net"
const TARGET_LID = process.env.TARGET_LID || "247369195061455@lid"
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "KODE_RAHASIA_KOM"
const logger = pino({ level: "silent" })

// ================= DATABASE SETUP =================
const dbDir = path.join(__dirname, "auth")
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir)

const db = new sqlite3.Database(path.join(dbDir, "database.db"))

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, jid TEXT, message JSON, timestamp INTEGER)`)
  db.run(`CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, value TEXT, owner TEXT, timestamp INTEGER)`)
  db.run(`CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, deadline TEXT, status INTEGER DEFAULT 0, timestamp INTEGER)`)
  db.run(`CREATE TABLE IF NOT EXISTS monitors (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE, lastStatus TEXT, lastChecked INTEGER)`)
  db.run(`CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT, reason TEXT, time INTEGER, notified INTEGER DEFAULT 0)`)
})

// DB Helpers
const saveMsg = (id, jid, message) => db.run(`INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?)`, [id, jid, JSON.stringify(message), Date.now()])
const getMsg = (id) => new Promise(res => db.get(`SELECT message FROM messages WHERE id = ?`, [id], (e, r) => res(r ? JSON.parse(r.message) : null)))

// ================= EXPRESS WEBHOOK =================
const app = express()
app.use(express.json())
let botSock = null

app.post("/send", async (req, res) => {
  const { secret, target, text } = req.body
  if (secret !== WEBHOOK_SECRET) return res.status(403).json({ error: "Invalid Secret" })
  if (!botSock) return res.status(503).json({ error: "Bot not connected" })
  try {
    await botSock.sendMessage(target || OWNER, { text })
    res.json({ status: "success" })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.listen(WEBHOOK_PORT, () => console.log(`📡 WEBHOOK READY ON PORT ${WEBHOOK_PORT}`))

// ================= UTILS =================
function unwrapQuotedMessage(quoted) {
  let m = quoted
  while (m) {
    if (m.imageMessage || m.videoMessage) return m
    m = m.viewOnceMessageV2?.message || m.viewOnceMessage?.message || m.ephemeralMessage?.message || null
  }
  return null
}

// ================= MONITORING ENGINE =================
async function checkMonitors() {
  if (!botSock) return
  db.all(`SELECT * FROM monitors`, [], async (err, rows) => {
    if (err || !rows) return
    for (const row of rows) {
      try {
        const start = Date.now()
        await axios.get(row.url, { timeout: 5000 })
        if (row.lastStatus === "DOWN") {
          await botSock.sendMessage(OWNER, { text: `✅ *MONITOR UP:* ${row.url}\nKembali online setelah gangguan.` })
        }
        db.run(`UPDATE monitors SET lastStatus = "UP", lastChecked = ? WHERE id = ?`, [Date.now(), row.id])
      } catch (e) {
        if (row.lastStatus !== "DOWN") {
          await botSock.sendMessage(OWNER, { text: `🚨 *MONITOR DOWN:* ${row.url}\nError: ${e.message}` })
        }
        db.run(`UPDATE monitors SET lastStatus = "DOWN", lastChecked = ? WHERE id = ?`, [Date.now(), row.id])
      }
    }
  })
}
setInterval(checkMonitors, 5 * 60 * 1000) // Check every 5 mins

async function checkReminders() {
  if (!botSock) return
  const now = Date.now()
  db.all(`SELECT * FROM reminders WHERE time <= ? AND notified = 0`, [now], async (err, rows) => {
    if (err || !rows) return
    for (const row of rows) {
      await botSock.sendMessage(row.target, { text: `⏰ *REMINDER:* @${row.target.split("@")[0]}\n\n*${row.reason}*`, mentions: [row.target] })
      db.run(`UPDATE reminders SET notified = 1 WHERE id = ?`, [row.id])
    }
  })
}
setInterval(checkReminders, 10 * 1000) // Check every 10 secs

// ================= BOT ENGINE =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth")
  const { version, isLatest } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    getMessage: async (key) => await getMsg(key.id),
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  botSock = sock
  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("connection.update", (up) => {
    if (up.qr) qrcode.generate(up.qr, { small: true })
    if (up.connection === "open") console.log("✅ BOT CONNECTED")
    if (up.connection === "close") {
      const reconnect = (up.lastDisconnect?.error instanceof Boom) ? up.lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true
      if (reconnect) setTimeout(startBot, 3000)
      else process.exit(0)
    }
  })

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    for (const msg of messages) {
      if (!msg.message) continue
      const jid = msg.key.remoteJid
      const id = msg.key.id
      const sender = msg.key.participant || jid
      const isOwner = sender.includes(OWNER.split("@")[0])
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""
      const cmd = body.trim().toLowerCase()

      if (jid !== "status@broadcast") saveMsg(id, jid, msg.message)

      try {
        // ANTI-DELETE
        const protocolMsg = msg.message.protocolMessage
        if (protocolMsg?.type === 0) {
          const old = await getMsg(protocolMsg.key.id)
          if (old) {
            await sock.sendMessage(OWNER, { text: `🚨 *ANTI-DELETE* dari @${sender.split("@")[0]}`, mentions: [sender] })
            await sock.sendMessage(OWNER, { forward: { key: protocolMsg.key, message: old } })
          }
          continue
        }

        // COMMANDS
        if (cmd === "/s" || cmd === "s") {
          const q = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          const isImg = msg.message.imageMessage || q?.imageMessage
          if (isImg) {
            const buffer = await downloadMediaMessage(q ? { key: { id: msg.message.extendedTextMessage.contextInfo.stanzaId, remoteJid: jid, participant: msg.message.extendedTextMessage.contextInfo.participant }, message: q } : msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage })
            const sticker = new Sticker(buffer, { pack: "Bot", author: "@oman21", type: StickerTypes.FULL, quality: 50 })
            await sock.sendMessage(jid, await sticker.toMessage(), { quoted: msg })
          }
        }

        if (cmd.startsWith("/todo")) {
          const args = body.slice(6).trim()
          if (args.startsWith("add ")) {
            const [t, d] = args.slice(4).split("|").map(s => s.trim())
            if (t) db.run(`INSERT INTO todos (task, deadline, timestamp) VALUES (?, ?, ?)`, [t, d || "-", Date.now()], () => sock.sendMessage(jid, { text: "✅ To-Do ditambahkan!" }))
          } else if (args === "list") {
            db.all(`SELECT * FROM todos ORDER BY status ASC, timestamp DESC`, [], (err, rows) => {
              let list = `📋 *TO-DO LIST*\n\n`
              rows?.forEach((r, i) => list += `${i+1}. ${r.status ? "✅" : "⏳"} *${r.task}* (${r.deadline})\n`)
              sock.sendMessage(jid, { text: list || "Kosong" })
            })
          } else if (args.startsWith("done ")) {
            const n = parseInt(args.slice(5))
            db.all(`SELECT id FROM todos ORDER BY status ASC, timestamp DESC`, [], (e, r) => {
              if (r[n-1]) db.run(`UPDATE todos SET status = 1 WHERE id = ?`, [r[n-1].id], () => sock.sendMessage(jid, { text: "🎯 Selesai!" }))
            })
          }
        }

        if (cmd.startsWith("/monitor")) {
          if (!isOwner) return
          const args = body.slice(9).trim()
          if (args.startsWith("add ")) {
            const url = args.slice(4).trim()
            db.run(`INSERT INTO monitors (url) VALUES (?)`, [url], (e) => sock.sendMessage(jid, { text: e ? "❌ URL sudah ada atau salah." : `✅ Monitoring dimulai: ${url}` }))
          } else if (args === "list") {
            db.all(`SELECT * FROM monitors`, [], (e, rows) => {
              let l = `🖥️ *UPTIME MONITOR*\n\n`
              rows?.forEach(r => l += `- ${r.lastStatus === "UP" ? "✅" : "🚨"} ${r.url}\n`)
              sock.sendMessage(jid, { text: l || "Tidak ada monitor." })
            })
          }
        }

        if (cmd.startsWith("/remind ")) {
          const s = body.split(" ")
          const tStr = s[1], reason = s.slice(2).join(" ")
          const v = parseInt(tStr), u = tStr?.toLowerCase().slice(-1)
          let ms = u === "s" ? v * 1000 : u === "m" ? v * 60000 : u === "h" ? v * 3600000 : 0
          if (ms > 0) {
            db.run(`INSERT INTO reminders (target, reason, time) VALUES (?, ?, ?)`, [jid, reason, Date.now() + ms], () => sock.sendMessage(jid, { text: `✅ Diingatkan dalam ${tStr}` }))
          }
        }

        if (cmd.startsWith("/price ")) {
          const coin = body.split(" ")[1]?.toLowerCase()
          if (coin) {
            const { data } = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=idr`).catch(() => ({}))
            if (data[coin]) sock.sendMessage(jid, { text: `💰 *${coin.toUpperCase()}*\n\n🇮🇩 Rp ${data[coin].idr.toLocaleString("id-ID")}` })
          }
        }

        if (cmd.startsWith("/whois ")) {
          const dom = body.split(" ")[1]?.toLowerCase()
          if (dom) {
            const { data } = await axios.get(`https://rdap.org/domain/${dom}`).catch(e => e.response || {})
            const avail = !(data && data.handle)
            sock.sendMessage(jid, { text: avail ? `✅ *${dom}* TERSEDIA!` : `🚨 *${dom}* SUDAH ADA PEMILIK.` })
          }
        }

        if (cmd === "/stats") {
          const free = (os.freemem() / 1024 / 1024).toFixed(0), total = (os.totalmem() / 1024 / 1024).toFixed(0)
          sock.sendMessage(jid, { text: `📊 *STATS*\nRAM: ${total - free}/${total}MB\nUptime: ${(os.uptime() / 3600).toFixed(1)} Jam` })
        }

        if (cmd === "//menu") {
          const menuText = `🤖 *BOT MENU & FEATURES* 🤖

📌 *Media & Utilities*
- \`/dl\` atau \`/download\` : Balas foto/video utk didownload & dikirim ke Owner.
- \`/s\` atau \`/sticker\` : Balas gambar utk jadikan stiker.
- \`/tagall\` : Tag semua member (Khusus Grup).
- \`/stats\` : Cek status RAM & Uptime VPS.

📋 *Productivity*
- \`/todo add [tugas] | [deadline]\` : Tambah tugas.
- \`/todo list\` : Lihat daftar tugas.
- \`/todo done [nomor]\` : Selesaikan tugas.
- \`/todo del [nomor]\` : Hapus tugas.
- \`/todo clear\` : Bersihkan tugas yg selesai.
- \`/remind [waktu] [pesan]\` : Pengingat (waktu: 10s, 5m, 1h).

🖥️ *Monitoring (Owner)*
- \`/monitor add [url]\` : Pantau website.
- \`/monitor list\` : Daftar web yg dipantau.

💰 *Information*
- \`/price [koin]\` : Cek harga crypto (Cth: /price btc).
- \`/whois [domain]\` : Cek status domain (Cth: /whois google.com).

_Built by @oman21 for Personal Developer Use_`
          await sock.sendMessage(jid, { text: menuText })
        }

        if (cmd === "/dl" || cmd === "/download") {
          const q = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          const unwrapped = unwrapQuotedMessage(q)
          if (unwrapped) {
            const isImg = unwrapped.imageMessage
            const isVid = unwrapped.videoMessage
            if (isImg || isVid) {
              const dlDir = path.join(__dirname, "downloads")
              if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir)
              const stream = await downloadContentFromMessage(isImg || isVid, isImg ? "image" : "video")
              let buffer = Buffer.from([])
              for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk])
              }
              
              const ext = isImg ? "jpg" : "mp4"
              const filename = `${Date.now()}.${ext}`
              const filepath = path.join(dlDir, filename)
              fs.writeFileSync(filepath, buffer)
              
              const typeMedia = isImg ? "image" : "video"
              await sock.sendMessage(OWNER, { [typeMedia]: buffer, caption: `📥 *DOWNLOADED MEDIA*\nSource: @${sender.split("@")[0]}\nSaved to: ${filepath}` })
              await sock.sendMessage(jid, { text: `✅ Media berhasil didownload dan dikirim ke Owner.` }, { quoted: msg })
            }
          } else {
             await sock.sendMessage(jid, { text: `❌ Reply foto atau video dengan pesan /dl untuk mendownload` }, { quoted: msg })
          }
        }

        if (cmd === "/tagall" && jid.endsWith("@g.us")) {
            const meta = await sock.groupMetadata(jid)
            const mentions = meta.participants.map(p => p.id)
            const text = `📢 *TAG ALL*\n\n` + mentions.map(m => `@${m.split("@")[0]}`).join(" ")
            sock.sendMessage(jid, { text, mentions })
        }

        if (jid === TARGET_LID) {
          const q = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          const unwrapped = unwrapQuotedMessage(q)
          if (unwrapped) {
            const stream = await downloadContentFromMessage(unwrapped.imageMessage || unwrapped.videoMessage, unwrapped.imageMessage ? "image" : "video")
            let buffer = Buffer.from([])
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk])
            }
            await sock.sendMessage(OWNER, { [unwrapped.imageMessage ? "image" : "video"]: buffer, caption: "👀 View-Once Target" })
          }
        }
      } catch (e) { console.error("Error:", e.message) }
    }
  })
}

startBot()
