# 📊 BPS Live Monitor & AI Chatbot

Aplikasi ini menggunakan arsitektur Microservices. Untuk menjalankannya, buka 3 terminal terpisah di VS Code dan jalankan perintah berikut secara berurutan:

### Terminal 1: Menyalakan Backend (Node.js & Live Chat)
- Buka terminal di folder utama project.
- Ketik: `node src/app.js`
- Akses Web Warga: http://localhost:3000
- Akses Web Admin: http://localhost:3000/admin.html

### Terminal 2: Menyalakan Otak AI (Rasa Core)
- Buka terminal dan masuk ke folder: `cd rasa-bot`
- Aktifkan environment: `venv\Scripts\activate`
- Ketik: `rasa run --enable-api --cors "*"`

### Terminal 3: Menyalakan Tangan AI (Rasa Custom Actions)
- Buka terminal dan masuk ke folder: `cd rasa-bot`
- Aktifkan environment: `venv\Scripts\activate`
- Ketik: `rasa run actions`