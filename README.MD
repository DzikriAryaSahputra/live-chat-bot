# 📊 BPS Live Monitor & AI Chatbot

Aplikasi ini menggunakan arsitektur Microservices. Untuk menjalankannya, buka 3 terminal terpisah di VS Code dan jalankan perintah berikut secara berurutan:

### Terminal 1: Menyalakan Backend (Node.js & Live Chat)
- Buka terminal di folder utama project.
- Ketik: `node src/app.js`  *(disarankan masuk folder backend dulu jika perlu)*
- Akses URL Widget/Warga: http://localhost:3000
- Akses URL Admin: http://localhost:3000/admin

### Terminal 2: Menyalakan Otak AI (Rasa Core)
- Buka terminal dan masuk ke folder: `cd rasa-bot`
- Aktifkan environment: `venv\Scripts\activate`
- Ketik: `rasa run --enable-api --cors "*"`
*(Catatan: `rasa train --force` jika ingin paksa latih dari awal)*

### Terminal 3: Menyalakan Tangan AI (Rasa Custom Actions)
- Buka terminal dan masuk ke folder: `cd rasa-bot`
- Aktifkan environment: `venv\Scripts\activate`
- Ketik: `rasa run actions`

---

## 🛠️ Panduan Integrasi (Cara Menempel Chatbot di Portal Web BPS)

Kini *chatbot* sudah dirancang sepenuhnya menggunakan sistem **Skrip Injektor Dinamis** (`widget.js`). Metode ini digunakan untuk mengatasi limitasi teknis di mana area kotak Iframe tidak menghalangi kursor mouse (klik web utama) tetapi tetap bisa merespon klik ketika asisten SISCA terbuka.

**Instruksi Pemasangan untuk Tim IT BPS:**
1. Sediakan halaman *website* Anda (layaknya portal beranda).
2. Salin kode tag script di bawah ini.
3. Tempelkan/Sisipkan persis tepat **di atas** baris `</body>` penutup halaman *website* tersebut.

```html
<!-- ========================================== -->
<!-- 🤖 S.I.S.C.A. (Sistem Informasi Statistik & Chat Asisten) - LIVE CHAT BPS KOTA JAMBI  -->
<!-- ========================================== -->
<script src="https://domaintarget.go.id/widget.js"></script>
```

### 📝 Catatan Penting Parameter Kode:
- `src="https://domaintarget.go.id/widget.js"` 👉 **Wajib diubah** dengan URL Production/Server aplikasi Node.js chatbot ini di BPS Jambi. Saat diuji lokalan, Anda bisa menggunakan `src="http://localhost:3000/widget.js"`.
- Anda tidak perlu memusingkan `z-index` atau ukuran layar iframe secara manual. Skrip `widget.js` secara otomatis akan melahirkan kotak Iframe transparan yang akan **membesar** ketika di-klik dan **mengecil** kembali saat *chat* ditutup. Dengan ini, kursor warga 100% aman mengklik berbagai tombol BPS di belakangnya!