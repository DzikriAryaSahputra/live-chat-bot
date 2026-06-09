# BPS Live Monitor & AI Chatbot

Aplikasi ini adalah asisten pintar (BIPS) untuk Badan Pusat Statistik (BPS) Kota Jambi, yang memadukan Live Chat Customer Service (Handoff ke Petugas Manusia) dan AI Chatbot (Rasa NLP + RAG dengan LLM Groq/Gemini).

Aplikasi dibangun menggunakan arsitektur Microservices, memisahkan backend Node.js (untuk Socket.IO dan manajemen dashboard) dengan engine Python Rasa (untuk pemrosesan bahasa alami).

---

## Fitur Utama
1. Hybrid AI Engine: Menggunakan Rasa untuk Intent Classification statis dan RAG (Retrieval-Augmented Generation) dengan LLM Groq/Gemini untuk menjawab dari dokumen PDF BPS.
2. Human Handoff: Warga bisa meminta untuk bicara langsung dengan petugas.
3. Role-Based Access Control (RBAC): Pemisahan hak akses antara super_admin (manajemen user & AI) dan petugas (hanya balas chat).
4. Collision Control: Obrolan yang sudah diklaim oleh satu petugas akan terkunci untuk petugas lain.
5. Dynamic Widget Injector: Mudah dipasang ke website mana pun (BPS) hanya dengan 1 baris skrip.

---

## Panduan Instalasi Lokal (Development)

### Persyaratan Sistem (Prerequisites)
- Node.js (v18 atau lebih baru)
- Python (v3.9 atau v3.10 disarankan untuk Rasa)
- PostgreSQL (v14 atau lebih baru)

### Langkah-Langkah Instalasi

1. Siapkan Database (PostgreSQL)
   - Buat database baru bernama bps_chatbot.
   - Buka PgAdmin atau psql CLI: CREATE DATABASE bps_chatbot;

2. Setup Backend (Node.js)
   - Buka terminal, masuk ke folder backend.
   - Jalankan npm install untuk mengunduh modul.
   - Buat file .env di dalam folder backend dengan isi berikut:
     ```env
     PORT=3000
     DB_USER=postgres
     DB_PASSWORD=password_database_anda
     DB_HOST=localhost
     DB_PORT=5432
     DB_NAME=bps_chatbot
     JWT_SECRET=supersecretkey_bps
     GROQ_API_KEY=kunci_api_groq_anda
     GEMINI_API_KEY=kunci_api_gemini_anda
     ```
   - Lakukan migrasi database (membuat tabel): node db-migrate.js

3. Setup AI Bot (Rasa & Python)
   - Buka terminal, masuk ke folder rasa-bot.
   - Buat Virtual Environment: python -m venv venv
   - Aktifkan Venv:
     - Windows: venv\Scripts\activate
     - Mac/Linux: source venv/bin/activate
   - Install dependensi: pip install rasa

### Cara Menjalankan Aplikasi di Lokal
Anda wajib membuka 3 terminal terpisah di VS Code dan menjalankannya secara bersamaan:

- Terminal 1 (Backend Node.js)
  ```bash
  cd backend
  node src/app.js
  ```
- Terminal 2 (Rasa Core Server)
  ```bash
  cd rasa-bot
  venv\Scripts\activate
  rasa run --enable-api --cors "*"
  ```
- Terminal 3 (Rasa Custom Actions)
  ```bash
  cd rasa-bot
  venv\Scripts\activate
  rasa run actions
  ```

Akses Dashboard Admin: http://localhost:3000/login
Akses Widget Warga: http://localhost:3000

---

## Panduan Instalasi Server (Production)

Untuk deployment ke server sungguhan (VPS/Cloud Ubuntu), pastikan server sudah terinstal Node.js, Python 3.10, PostgreSQL, Nginx, dan PM2.

### 1. Proses Instalasi Server
- Kloning/unggah file proyek ini ke VPS Anda (misal di /var/www/live-chat-bot).
- Setup PostgreSQL dan .env sama seperti cara lokal. Ubah DB_PASSWORD sesuai server.

### 2. Menjalankan Node.js dengan PM2 (Background Process)
Agar server Node.js tetap berjalan walaupun terminal SSH ditutup, gunakan PM2:
```bash
sudo npm install -g pm2
cd /var/www/live-chat-bot/backend
pm2 start src/app.js --name "bps-backend"
pm2 save
pm2 startup
```

### 3. Menjalankan Rasa di Production (Screen / Systemd / Tmux)
Karena proses instalasi Rasa cukup berat, disarankan menggunakan Screen atau membuat Systemd Service. Contoh menggunakan screen:
```bash
# Buka sesi screen untuk Rasa
screen -S rasa-server
cd /var/www/live-chat-bot/rasa-bot
source venv/bin/activate
rasa run --enable-api --cors "*" -p 5005
# Tekan Ctrl+A lalu D untuk meminimalkan layar (detach)

# Buka sesi screen untuk Actions
screen -S rasa-actions
cd /var/www/live-chat-bot/rasa-bot
source venv/bin/activate
rasa run actions -p 5055
# Tekan Ctrl+A lalu D untuk meminimalkan layar (detach)
```

### 4. Konfigurasi Nginx (Reverse Proxy & SSL HTTPS)
Agar aplikasi bisa diakses melalui domain (misal: chat.bpsjambi.go.id) dan mendukung WSS (WebSockets) untuk real-time chat:
- Buat konfigurasi Nginx: sudo nano /etc/nginx/sites-available/bps-chat
```nginx
server {
    listen 80;
    server_name chat.bpsjambi.go.id;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```
- Aktifkan: sudo ln -s /etc/nginx/sites-available/bps-chat /etc/nginx/sites-enabled/
- Restart Nginx: sudo systemctl restart nginx
- Jangan lupa instal Sertifikat SSL (HTTPS) menggunakan Certbot (Let's Encrypt) agar kamera, mic, dan WebSockets aman.

---

## Panduan Integrasi Widget ke Portal Web BPS

1. Salin kode tag script di bawah ini.
2. Tempelkan/Sisipkan persis tepat di atas baris </body> penutup halaman portal website BPS Anda.

```html
<!-- ========================================== -->
<!-- B.I.P.S. (BPS Intelligence & Public Service) -->
<!-- ========================================== -->
<script src="https://chat.bpsjambi.go.id/widget.js"></script>
```

### Catatan Penting
- Ganti URL chat.bpsjambi.go.id pada skrip di atas dengan nama domain production Anda yang sesungguhnya.
- Skrip ini secara otomatis akan mengatur UI, mendeteksi lebar layar warga (Mobile/Desktop), dan membuat Iframe mengecil/membesar secara cerdas.

---

## Panduan Manajemen NLU (Admin Dashboard)

Agar chatbot RAG berfungsi optimal, mohon patuhi 3 Aturan Emas NLU ini saat mengisi Menu AI di Dasbor:

1. Berikan Variasi Kalimat, Bukan Sekadar Pengulangan
   Berikan gaya bahasa campuran (formal & santai). Minimal 10 contoh per topik.
   - [X] Buruk: "apa visi misi bps", "apa visi misi bps jambi"
   - [V] Bagus: "apa visi misi bps", "tujuan utama instansi ini apa", "minta info dong visi misi"

2. Gunakan Kata Kunci Spesifik (Unik)
   Untuk topik Sensus Ekonomi, wajib masukkan kata "sensus", "ekonomi", atau "SE2026". Jangan gunakan kata dasar seperti "2026" saja.

3. Hindari Topik "Sapu Jagat" (Kelewat Umum)
   Jangan buat NLU untuk sekadar "data" atau "angka". Biarkan pertanyaan berbasis data kompleks ditangani langsung oleh AI LLM RAG yang membaca PDF. Topik NLU sebaiknya murni untuk profil statis, alamat, sapaan, atau penolakan.