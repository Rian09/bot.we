require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "ganti-token-admin";
const ADMIN_WA = String(process.env.ADMIN_WA || "").replace(/\D/g, "");
const SESSION_DIR = process.env.SESSION_DIR || "./session";

fs.mkdirSync(SESSION_DIR, { recursive: true });

const db = new Database("./pengaduan.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  category TEXT,
  location TEXT,
  description TEXT,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'DITERIMA',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  phone TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

let sock = null;
let qrDataUrl = null;
let waReady = false;

function normalizeJid(jid) {
  return String(jid || "").split(":")[0];
}

function phoneFromJid(jid) {
  return normalizeJid(jid).split("@")[0].replace(/\D/g, "");
}

function makeTicket() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `ADU-${y}${m}${day}-${suffix}`;
}

function getSession(phone) {
  const row = db.prepare("SELECT * FROM sessions WHERE phone=?").get(phone);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data || "{}") };
}

function saveSession(phone, step, data) {
  db.prepare(`
    INSERT INTO sessions(phone, step, data, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      step=excluded.step,
      data=excluded.data,
      updated_at=CURRENT_TIMESTAMP
  `).run(phone, step, JSON.stringify(data));
}

function clearSession(phone) {
  db.prepare("DELETE FROM sessions WHERE phone=?").run(phone);
}

async function sendText(to, text) {
  if (!sock) return;
  await sock.sendMessage(to, { text });
}

async function notifyAdmin(complaint) {
  if (!ADMIN_WA) return;
  const msg =
`📢 *PENGADUAN BARU*
Tiket: *${complaint.ticket}*
Nama: ${complaint.name || "-"}
No. WA: ${complaint.phone}
Kategori: ${complaint.category || "-"}
Lokasi: ${complaint.location || "-"}
Status: ${complaint.status}

Uraian:
${complaint.description || "-"}

Buka panel admin untuk memproses tiket.`;
  await sendText(`${ADMIN_WA}@s.whatsapp.net`, msg);
}

function mainMenu() {
  return `👋 *LAYANAN PENGADUAN*

Silakan pilih menu:
1️⃣ Buat Pengaduan
2️⃣ Cek Status Pengaduan
3️⃣ Informasi Pelayanan
4️⃣ Hubungi Petugas

Ketik *MENU* kapan saja untuk kembali.`;
}

async function handleMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const from = msg.key.remoteJid;
  if (!from || from.endsWith("@g.us")) return;

  const phone = phoneFromJid(from);
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    "";
  const input = text.trim();

  if (!input) return;

  const upper = input.toUpperCase();

  if (upper === "MENU" || upper === "HALO" || upper === "START") {
    clearSession(phone);
    await sendText(from, mainMenu());
    return;
  }

  const cek = upper.match(/^CEK\s+(ADU-\d{8}-[A-Z0-9]+)$/);
  if (cek) {
    const row = db.prepare("SELECT ticket,status,created_at,updated_at FROM complaints WHERE ticket=?")
      .get(cek[1]);
    if (!row) {
      await sendText(from, `❌ Tiket *${cek[1]}* tidak ditemukan.`);
    } else {
      await sendText(from,
`🎫 *STATUS PENGADUAN*
Tiket: *${row.ticket}*
Status: *${row.status}*
Dibuat: ${row.created_at}
Diperbarui: ${row.updated_at}`);
    }
    return;
  }

  let s = getSession(phone);

  if (!s) {
    await sendText(from, mainMenu());
    return;
  }

  let data = s.data;

  if (s.step === "name") {
    data.name = input;
    saveSession(phone, "category", data);
    await sendText(from, `Baik, *${input}*.\n\nPilih kategori:\n1. Pelayanan\n2. Infrastruktur\n3. Keamanan\n4. Lainnya`);
    return;
  }

  if (s.step === "category") {
    const categories = {
      "1": "Pelayanan",
      "2": "Infrastruktur",
      "3": "Keamanan",
      "4": "Lainnya"
    };
    if (!categories[input]) {
      await sendText(from, "Pilihan tidak valid. Balas 1, 2, 3, atau 4.");
      return;
    }
    data.category = categories[input];
    saveSession(phone, "location", data);
    await sendText(from, "📍 Tuliskan lokasi pengaduan.");
    return;
  }

  if (s.step === "location") {
    data.location = input;
    saveSession(phone, "description", data);
    await sendText(from, "📝 Jelaskan pengaduan secara singkat dan jelas.");
    return;
  }

  if (s.step === "description") {
    data.description = input;
    saveSession(phone, "confirm", data);
    await sendText(from,
`🔎 *KONFIRMASI*

Nama: ${data.name}
Kategori: ${data.category}
Lokasi: ${data.location}
Uraian: ${data.description}

Ketik *YA* untuk mengirim atau *BATAL* untuk membatalkan.`);
    return;
  }

  if (s.step === "confirm") {
    if (upper === "BATAL") {
      clearSession(phone);
      await sendText(from, "Pengaduan dibatalkan.\n\n" + mainMenu());
      return;
    }

    if (upper !== "YA") {
      await sendText(from, "Balas *YA* untuk mengirim atau *BATAL* untuk membatalkan.");
      return;
    }

    const ticket = makeTicket();
    db.prepare(`
      INSERT INTO complaints(ticket,phone,name,category,location,description)
      VALUES (?,?,?,?,?,?)
    `).run(ticket, phone, data.name, data.category, data.location, data.description);

    const complaint = db.prepare("SELECT * FROM complaints WHERE ticket=?").get(ticket);
    clearSession(phone);

    await sendText(from,
`✅ *PENGADUAN BERHASIL DITERIMA*

Nomor tiket: *${ticket}*

Simpan nomor tiket tersebut untuk mengecek perkembangan pengaduan.

Ketik:
*CEK ${ticket}*

Terima kasih.`);
    await notifyAdmin(complaint);
    return;
  }

  if (upper === "1") {
    saveSession(phone, "name", {});
    await sendText(from, "📝 *BUAT PENGADUAN*\n\nSilakan tuliskan nama Anda.");
    return;
  }

  if (upper === "2") {
    await sendText(from, "🔎 Kirim nomor tiket dengan format:\n*CEK ADU-20260828-ABC123*");
    return;
  }

  if (upper === "3") {
    await sendText(from,
`ℹ️ *INFORMASI PELAYANAN*

Layanan ini digunakan untuk menerima dan memantau pengaduan.
Jam pelayanan: Senin–Jumat, 08.00–16.00 WIB.

Untuk kembali ke menu, ketik *MENU*.`);
    return;
  }

  if (upper === "4") {
    await sendText(from,
`👮 *HUBUNGI PETUGAS*

Silakan tuliskan pesan Anda. Petugas akan menindaklanjuti sesuai jam pelayanan.

Ketik *MENU* untuk kembali.`);
    return;
  }

  await sendText(from, mainMenu());
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {
    version = undefined;
  }

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Bot Pengaduan", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr);
      console.log("QR WhatsApp tersedia di http://localhost:" + PORT + "/qr");
    }

    if (connection === "open") {
      waReady = true;
      qrDataUrl = null;
      console.log("WhatsApp terhubung.");
    }

    if (connection === "close") {
      waReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log("Sesi logout. Hapus folder session lalu jalankan ulang.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error("Message error:", err);
      }
    }
  });
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function auth(req, res, next) {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

app.get("/", (req, res) => {
  res.send(`<h2>Bot WA Pelayanan Pengaduan</h2>
  <p>Status WhatsApp: <b>${waReady ? "TERHUBUNG" : "BELUM TERHUBUNG"}</b></p>
  <p><a href="/qr">Tampilkan QR WhatsApp</a></p>
  <p>Panel admin: <code>/admin?token=TOKEN</code></p>`);
});

app.get("/qr", (req, res) => {
  if (!qrDataUrl) return res.send("<h3>QR belum tersedia. Jika sudah terhubung, tidak diperlukan.</h3>");
  res.send(`<h3>Scan QR dengan WhatsApp</h3><img src="${qrDataUrl}" style="max-width:320px">`);
});

app.get("/admin", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM complaints ORDER BY id DESC LIMIT 200").all();
  const html = `
<!doctype html><html><head><meta charset="utf-8">
<title>Panel Pengaduan</title>
<style>
body{font-family:Arial;margin:20px;background:#f5f5f5}
.card{background:#fff;padding:16px;border-radius:10px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:9px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
select,button{padding:7px}
.small{color:#666;font-size:12px}
</style></head><body>
<h2>📋 Panel Admin Pengaduan</h2>
<div class="card">WhatsApp: <b>${waReady ? "TERHUBUNG" : "BELUM TERHUBUNG"}</b></div>
<table><tr><th>Tiket</th><th>Pelapor</th><th>Pengaduan</th><th>Status</th><th>Aksi</th></tr>
${rows.map(r => `<tr>
<td><b>${r.ticket}</b><br><span class="small">${r.created_at}</span></td>
<td>${escapeHtml(r.name || "-")}<br>${escapeHtml(r.phone)}</td>
<td><b>${escapeHtml(r.category || "-")}</b><br>${escapeHtml(r.location || "-")}<br>${escapeHtml(r.description || "-")}</td>
<td>${escapeHtml(r.status)}</td>
<td>
<select onchange="updateStatus('${r.ticket}',this.value)">
<option ${r.status==="DITERIMA"?"selected":""}>DITERIMA</option>
<option ${r.status==="DIPROSES"?"selected":""}>DIPROSES</option>
<option ${r.status==="SELESAI"?"selected":""}>SELESAI</option>
<option ${r.status==="DITOLAK"?"selected":""}>DITOLAK</option>
</select>
</td></tr>`).join("")}
</table>
<script>
async function updateStatus(ticket,status){
  const res=await fetch('/api/complaints/'+encodeURIComponent(ticket)+'/status',{
    method:'PUT',headers:{'Content-Type':'application/json','x-admin-token':${JSON.stringify(ADMIN_TOKEN)}},
    body:JSON.stringify({status})
  });
  if(res.ok) location.reload(); else alert('Gagal memperbarui status');
}
</script></body></html>`;
  res.send(html);
});

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

app.get("/api/complaints", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM complaints ORDER BY id DESC").all());
});

app.put("/api/complaints/:ticket/status", auth, async (req, res) => {
  const allowed = ["DITERIMA", "DIPROSES", "SELESAI", "DITOLAK"];
  const status = String(req.body.status || "").toUpperCase();

  if (!allowed.includes(status)) return res.status(400).json({ error: "Status tidak valid" });

  const row = db.prepare("SELECT * FROM complaints WHERE ticket=?").get(req.params.ticket);
  if (!row) return res.status(404).json({ error: "Tiket tidak ditemukan" });

  db.prepare("UPDATE complaints SET status=?, updated_at=CURRENT_TIMESTAMP WHERE ticket=?")
    .run(status, req.params.ticket);

  try {
    await sendText(`${row.phone}@s.whatsapp.net`,
`🔔 *PEMBARUAN PENGADUAN*

Tiket: *${row.ticket}*
Status: *${status}*

Silakan gunakan:
*CEK ${row.ticket}*
untuk melihat status terbaru.`);
  } catch (e) {
    console.error("Gagal mengirim update:", e);
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Panel berjalan di http://localhost:${PORT}`);
  startWhatsApp().catch(console.error);
});
