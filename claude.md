Saya ingin Anda membuatkan full project aplikasi sederhana berbasis Node.js + TypeScript yang berjalan di Docker untuk memonitor stock emas di website Logam Mulia dan mengirim notifikasi otomatis ke Telegram jika ada penambahan stock.

Aplikasi ini harus dibuat dengan arsitektur modular/atomic, mudah dirawat, mudah mengganti selector jika UI website berubah, dan siap dijalankan via Docker Compose.

==================================================
TUJUAN UTAMA
==================================================

Aplikasi harus:
1. Login ke website Logam Mulia menggunakan email dan password.
2. Mengakses halaman stock emas.
3. Mengambil data stock meskipun stock bernilai 0 / kosong / tidak tersedia.
4. Menyimpan snapshot stock terakhir ke file lokal agar bisa dibandingkan pada proses berikutnya.
5. Mengirim notifikasi Telegram hanya jika ada penambahan stock.
6. Menangani session login berbasis cookies secara otomatis:
   - simpan session/cookies setelah login berhasil
   - gunakan kembali session tersebut pada run berikutnya
   - jika session expired, aplikasi harus auto login ulang dan melanjutkan scraping
7. Berjalan periodik berdasarkan interval dari environment variable.
8. Mudah dijalankan di Docker.

==================================================
TARGET WEBSITE
==================================================

Halaman login:
https://www.logammulia.com/id/login

Halaman stock emas:
https://www.logammulia.com/id/purchase/gold

Catatan penting:
- Website kemungkinan memakai cookies/session sebagai penanda login.
- Website kemungkinan menggunakan rendering dinamis / JavaScript.
- Karena itu, prioritaskan Playwright untuk automasi browser dan scraping.
- Jangan gunakan pendekatan HTML static scraping sebagai strategi utama.

==================================================
TEKNOLOGI YANG WAJIB DIGUNAKAN
==================================================

- Node.js 20+
- TypeScript
- Playwright
- Docker
- Docker Compose
- Penyimpanan state lokal berbasis file JSON
- Telegram Bot API untuk mengirim pesan
- Logging yang jelas dan mudah dibaca

Boleh gunakan:
- axios atau native fetch untuk Telegram API
- fs/promises untuk persistence
- library env parser/validator bila perlu

==================================================
RULES FUNGSIONAL
==================================================

Aplikasi harus melakukan alur berikut:

1. Saat aplikasi berjalan:
   - load konfigurasi dari environment variables
   - inisialisasi browser Playwright
   - cek apakah file session tersedia
   - jika session tersedia, gunakan session tersebut
   - buka halaman stock

2. Validasi session:
   - jika halaman stock bisa diakses dan user masih login, lanjut scraping
   - jika ternyata diarahkan ke login / session invalid / unauthorized / halaman meminta login ulang:
     a. hapus session lama
     b. login ulang menggunakan email dan password
     c. simpan session/cookies/storage state baru
     d. buka ulang halaman stock
     e. lanjut scraping

3. Scraping stock:
   - baca data stock dari butik/lokasi yang ditentukan
   - aplikasi harus tetap mencatat data walaupun stock kosong atau 0
   - jika ada beberapa lokasi target, proses semua lokasi tersebut
   - untuk setiap lokasi, ambil daftar gramasi dan jumlah stock
   - jika website menampilkan “stok habis”, “tidak tersedia”, atau indikator sejenis, map menjadi qty=0

4. Snapshot:
   - simpan hasil scraping terbaru ke file JSON
   - load snapshot sebelumnya jika ada
   - bandingkan snapshot lama dan baru

5. Notifikasi Telegram:
   - kirim notifikasi hanya jika:
     - qty lama = 0 dan qty baru > 0
     - qty baru > qty lama
   - jangan kirim notifikasi jika:
     - qty tetap sama
     - qty turun
     - semuanya tetap kosong
   - jika beberapa gramasi naik dalam satu lokasi pada waktu yang sama, gabungkan dalam satu pesan Telegram per lokasi

6. Scheduler:
   - jalankan pengecekan secara periodik
   - interval berasal dari env, default 60 detik

==================================================
FORMAT PESAN TELEGRAM
==================================================

Gunakan format pesan seperti ini:

Info Stock Terbaru!

Lokasi : BELM Pulogadung Ekspedisi
Gramasi :
- 1.0 gr (1 pcs)
- 2.0 gr (5 pcs)
Stok : Tersedia
Jam : 12:02:24

Ketentuan:
- “Jam” harus menggunakan timezone Asia/Jakarta
- Jika hanya 1 item yang naik, tetap gunakan format list
- Jika lebih dari 1 item yang naik pada lokasi yang sama, gabungkan dalam 1 pesan
- Jika tidak ada item yang naik, jangan kirim apa pun

==================================================
STRUKTUR DATA YANG DIHARAPKAN
==================================================

Normalisasi hasil scraping minimal mengikuti bentuk seperti ini:

{
  "location": "BELM Pulogadung Ekspedisi",
  "items": [
    { "weight": "1.0 gr", "qty": 0, "available": false },
    { "weight": "2.0 gr", "qty": 5, "available": true }
  ],
  "scrapedAt": "2026-05-14T12:02:24+07:00"
}

Buat type/interface TypeScript yang jelas untuk semua model data.

==================================================
ENVIRONMENT VARIABLES
==================================================

Buat file .env.example dengan variabel berikut:

LM_EMAIL=
LM_PASSWORD=
LM_TARGET_LOCATIONS=BELM Pulogadung Ekspedisi
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
CHECK_INTERVAL_SECONDS=60
TZ=Asia/Jakarta
HEADLESS=true
LOG_LEVEL=info
DEBUG_SCREENSHOT_ON_ERROR=true

Keterangan:
- LM_TARGET_LOCATIONS harus mendukung banyak lokasi, dipisahkan koma
- HEADLESS harus bisa dikonfigurasi
- DEBUG_SCREENSHOT_ON_ERROR jika true, saat error scraping/login simpan screenshot dan HTML dump ke folder debug

==================================================
PERSISTENCE
==================================================

Gunakan folder data/ untuk persistence, minimal berisi:

- data/session.json
  Menyimpan storage state / cookies Playwright

- data/last-stock.json
  Menyimpan snapshot stock terakhir

- data/debug/
  Menyimpan screenshot dan HTML dump saat error jika debug aktif

Folder data/ harus cocok dijadikan volume Docker supaya state tetap ada saat container restart.

==================================================
ERROR HANDLING DAN ROBUSTNESS
==================================================

Aplikasi harus robust dan tidak rapuh.

Implementasikan hal-hal berikut:
1. Retry sederhana untuk kegagalan network/transient
2. Logging yang jelas untuk:
   - start aplikasi
   - login sukses/gagal
   - session valid/expired
   - mulai scraping lokasi
   - hasil perubahan stock
   - pengiriman Telegram
   - error detail
3. Jika satu lokasi gagal discrape, aplikasi tidak langsung crash total; lanjutkan ke lokasi lain jika memungkinkan
4. Jika selector gagal atau UI berubah:
   - log error detail
   - jika DEBUG_SCREENSHOT_ON_ERROR=true, simpan screenshot dan HTML halaman
5. Pisahkan selector ke file terpisah agar mudah diedit

==================================================
ARSITEKTUR PROJECT YANG WAJIB DIIKUTI
==================================================

Gunakan struktur project ini secara eksplisit:

logammulia-stock-bot/
├─ src/
│  ├─ app/
│  │  ├─ config/
│  │  │  └─ env.ts
│  │  ├─ types/
│  │  │  ├─ stock.ts
│  │  │  ├─ telegram.ts
│  │  │  └─ session.ts
│  │  └─ utils/
│  │     ├─ logger.ts
│  │     ├─ time.ts
│  │     ├─ file.ts
│  │     └─ retry.ts
│  ├─ domain/
│  │  ├─ entities/
│  │  │  ├─ stock-snapshot.ts
│  │  │  └─ stock-change.ts
│  │  └─ services/
│  │     ├─ compare-stock.ts
│  │     └─ build-telegram-message.ts
│  ├─ infrastructure/
│  │  ├─ browser/
│  │  │  ├─ playwright-client.ts
│  │  │  └─ session-store.ts
│  │  ├─ logammulia/
│  │  │  ├─ auth-client.ts
│  │  │  ├─ stock-scraper.ts
│  │  │  ├─ selectors.ts
│  │  │  └─ parsers.ts
│  │  ├─ telegram/
│  │  │  └─ telegram-client.ts
│  │  └─ persistence/
│  │     └─ snapshot-repository.ts
│  ├─ application/
│  │  └─ use-cases/
│  │     └─ check-stock.ts
│  └─ interfaces/
│     ├─ scheduler/
│     │  └─ interval-runner.ts
│     └─ cli/
│        └─ index.ts
├─ data/
│  └─ .gitkeep
├─ Dockerfile
├─ docker-compose.yml
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ README.md
└─ .gitignore

==================================================
TANGGUNG JAWAB TIAP FILE
==================================================

Implementasikan tanggung jawab file sebagai berikut:

- src/app/config/env.ts
  Validasi dan parsing environment variables

- src/app/types/stock.ts
  Type/interface untuk stock hasil scraping

- src/app/types/telegram.ts
  Type/interface terkait payload Telegram

- src/app/types/session.ts
  Type/interface session/browser state jika diperlukan

- src/app/utils/logger.ts
  Utility logger sederhana dan konsisten

- src/app/utils/time.ts
  Helper waktu dan format Asia/Jakarta

- src/app/utils/file.ts
  Helper baca/tulis file JSON dan ensure directory

- src/app/utils/retry.ts
  Helper generic retry dengan delay

- src/domain/entities/stock-snapshot.ts
  Entity snapshot stock

- src/domain/entities/stock-change.ts
  Entity perubahan stock

- src/domain/services/compare-stock.ts
  Logic membandingkan snapshot lama vs baru dan menentukan item mana yang naik

- src/domain/services/build-telegram-message.ts
  Logic membangun pesan Telegram sesuai format yang diminta

- src/infrastructure/browser/playwright-client.ts
  Inisialisasi browser Playwright dan browser context

- src/infrastructure/browser/session-store.ts
  Load/save/delete storage state session Playwright

- src/infrastructure/logammulia/auth-client.ts
  Logic login dan validasi session

- src/infrastructure/logammulia/selectors.ts
  Semua selector Playwright untuk login dan scraping dipusatkan di sini

- src/infrastructure/logammulia/parsers.ts
  Parser text qty/weight/status menjadi bentuk data terstruktur

- src/infrastructure/logammulia/stock-scraper.ts
  Logic navigasi ke halaman stock, memilih lokasi, membaca gramasi dan qty

- src/infrastructure/telegram/telegram-client.ts
  Logic kirim pesan ke Telegram Bot API

- src/infrastructure/persistence/snapshot-repository.ts
  Read/write snapshot JSON

- src/application/use-cases/check-stock.ts
  Orkestrasi utama:
  validasi session -> login ulang bila perlu -> scrape -> compare -> notify -> save snapshot

- src/interfaces/scheduler/interval-runner.ts
  Scheduler periodik berbasis setInterval atau loop async yang aman

- src/interfaces/cli/index.ts
  Entry point aplikasi

==================================================
KETENTUAN IMPLEMENTASI
==================================================

Harus memenuhi semua poin berikut:

1. Gunakan TypeScript typing yang jelas dan rapi.
2. Jangan hardcode credential.
3. Simpan selector di file terpisah.
4. Tambahkan komentar seperlunya, terutama pada area selector/fallback.
5. Kode harus cukup robust untuk menghadapi perubahan kecil pada UI.
6. Wajib menyimpan qty=0 jika stock kosong.
7. Gunakan Playwright storage state untuk session persistence.
8. Saat session invalid, lakukan auto re-login.
9. Retry untuk operasi yang masuk akal.
10. Logging harus informatif namun tetap sederhana.
11. Project harus bisa dijalankan dengan:
    - npm install
    - npm run dev
    - npm run build
    - npm run start
    - docker compose up --build
12. Gunakan image Docker yang kompatibel dengan Playwright.
13. Mount volume untuk folder data/.
14. Pastikan aplikasi berjalan baik sebagai service tunggal dalam container.
15. Jangan membuat arsitektur terlalu overengineered; tetap clean, modular, dan practical.

==================================================
STRATEGI SCRAPING YANG DIHARAPKAN
==================================================

Implementasikan strategi scraping yang cukup tahan terhadap perubahan UI:

1. Buka halaman stock
2. Tunggu load yang relevan (misalnya network idle / element ready)
3. Cek apakah user masih login
4. Jika belum login, login ulang
5. Setelah login sukses, buka lagi halaman stock
6. Untuk tiap lokasi target:
   - pilih lokasi/butik
   - tunggu data stock termuat
   - ekstrak semua gramasi yang tersedia di tampilan
   - jika ada indikator sold out / tidak tersedia / habis, catat qty=0
   - jika qty numerik ada, parse ke integer
7. Kembalikan hasil dalam bentuk data terstruktur

Tambahkan fallback logic jika:
- selector utama tidak ketemu
- teks status stock menggunakan variasi wording
- halaman butuh delay setelah memilih lokasi

==================================================
OUTPUT YANG SAYA INGINKAN DARI ANDA
==================================================

Saya ingin Anda menghasilkan FULL PROJECT FILES secara lengkap, bukan hanya penjelasan.


*catatan
Jika ada selector DOM yang belum pasti, tetap buat implementasi dengan placeholder selector yang diberi komentar TODO agar mudah saya sesuaikan.