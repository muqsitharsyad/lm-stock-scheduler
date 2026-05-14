# Logam Mulia Stock Scheduler

Monitor stok emas di [logammulia.com](https://www.logammulia.com/id/purchase/gold) dan kirim notifikasi otomatis ke Telegram setiap kali ada penambahan stok.

## Fitur

- Login otomatis ke website Logam Mulia
- Deteksi session expired + auto re-login
- Scraping berbasis Playwright (tahan terhadap halaman JavaScript-rendered)
- Monitor beberapa lokasi/butik sekaligus
- Notifikasi Telegram hanya jika stok **naik**
- Persistence snapshot antar run (via `data/last-stock.json`)
- Debug mode: simpan screenshot + HTML saat terjadi error
- Siap dijalankan di Docker

---

## Quick Start (Lokal)

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Konfigurasi

```bash
cp .env.example .env
```

Isi semua nilai di `.env`:

| Variable | Keterangan |
|---|---|
| `LM_EMAIL` | Email akun Logam Mulia |
| `LM_PASSWORD` | Password akun |
| `LM_TARGET_LOCATIONS` | Nama butik, pisahkan dengan koma |
| `TELEGRAM_BOT_TOKEN` | Token dari [@BotFather](https://t.me/botfather) |
| `TELEGRAM_CHAT_ID` | Chat ID tujuan notifikasi |
| `CHECK_INTERVAL_SECONDS` | Interval cek dalam detik (default: `60`) |
| `HEADLESS` | `true` / `false` — tampilkan browser (default: `true`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default: `info`) |
| `DEBUG_SCREENSHOT_ON_ERROR` | Simpan screenshot saat error (default: `true`) |

### 3. Jalankan

```bash
# Development (ts-node)
npm run dev

# Production (build terlebih dahulu)
npm run build
npm run start
```

---

## Docker

```bash
# Copy & isi .env terlebih dahulu
cp .env.example .env

# Build & jalankan
docker compose up --build

# Jalankan di background
docker compose up --build -d
```

Folder `data/` di-mount sebagai volume sehingga session dan snapshot tetap ada saat container di-restart.

---

## Struktur Project

```
src/
├── app/
│   ├── config/env.ts           # Load & validasi env vars
│   ├── types/                  # TypeScript interfaces
│   └── utils/                  # logger, time, file, retry
├── domain/
│   ├── entities/               # stock-snapshot, stock-change
│   └── services/               # compare-stock, build-telegram-message
├── infrastructure/
│   ├── browser/                # playwright-client, session-store
│   ├── logammulia/             # auth-client, stock-scraper, selectors, parsers
│   ├── telegram/               # telegram-client
│   └── persistence/            # snapshot-repository
├── application/use-cases/      # check-stock (orkestrasi utama)
└── interfaces/
    ├── scheduler/              # interval-runner
    └── cli/index.ts            # entry point
```

---

## Menyesuaikan Selector

Jika tampilan website berubah, cukup edit satu file:

```
src/infrastructure/logammulia/selectors.ts
```

Semua selector diberi komentar `// TODO:` untuk bagian yang belum dapat diverifikasi tanpa akses langsung ke halaman.

---

## Format Notifikasi Telegram

```
Info Stock Terbaru!

Lokasi : BELM Pulogadung Ekspedisi
Gramasi :
- 1.0 gr (1 pcs)
- 2.0 gr (5 pcs)
Stok : Tersedia
Jam : 12:02:24
```

---

## Folder `data/`

| Path | Isi |
|---|---|
| `data/session.json` | Playwright storage state (cookies + localStorage) |
| `data/last-stock.json` | Snapshot stok terakhir |
| `data/debug/` | Screenshot & HTML dump saat error (jika debug aktif) |
