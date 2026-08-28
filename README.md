# Bot WhatsApp Pelayanan Pengaduan

Fitur:
- Menu WhatsApp otomatis
- Pembuatan tiket pengaduan
- SQLite sebagai database lokal
- Cek status dengan nomor tiket
- Notifikasi pengaduan baru ke nomor admin
- Panel admin sederhana
- Admin dapat mengubah status: DITERIMA, DIPROSES, SELESAI, DITOLAK
- Perubahan status dikirim kembali ke pelapor

## 1. Persiapan

Gunakan Node.js versi LTS.

```bash
npm install
```

Salin `.env.example` menjadi `.env`, lalu ubah:

```env
PORT=3000
ADMIN_TOKEN=buat-token-yang-kuat
ADMIN_WA=628xxxxxxxxxx
SESSION_DIR=./session
```

`ADMIN_WA` memakai format internasional tanpa tanda `+`.

## 2. Jalankan

```bash
npm start
```

Buka:

```text
http://localhost:3000/qr
```

Scan QR menggunakan WhatsApp pada HP yang akan menjadi akun bot.

Setelah terhubung, database `pengaduan.db` dibuat otomatis.

## 3. Panel admin

Buka:

```text
http://localhost:3000/admin?token=TOKEN_ANDA
```

Contoh:
```text
http://localhost:3000/admin?token=buat-token-yang-kuat
```

## 4. Alur pengguna

Kirim:
`MENU`

Lalu:
`1` → Buat pengaduan

Bot meminta:
- Nama
- Kategori
- Lokasi
- Uraian
- Konfirmasi

Setelah tersimpan, bot memberikan tiket seperti:
`ADU-20260828-A1B2C3`

Untuk cek:
`CEK ADU-20260828-A1B2C3`

## Catatan keamanan

- Jangan membagikan file `.env`.
- Gunakan `ADMIN_TOKEN` yang panjang dan sulit ditebak.
- Untuk penggunaan publik/produksi, sebaiknya panel admin ditempatkan di HTTPS dan diberi autentikasi yang lebih kuat.
- Jangan gunakan bot untuk spam, broadcast massal, atau mengganggu pengguna.
- Data pengaduan dapat berisi informasi pribadi; batasi akses database dan panel admin.
