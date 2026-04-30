@echo off
color 0B
echo =======================================================
echo     AUTO-INSTALLER BPS LIVE CHAT BOT (SISCA)
echo =======================================================
echo.

echo [1/2] Memulai Instalasi Backend (Node.js)...
cd backend
call npm install
cd ..
echo [OK] Backend Node.js selesai diinstal!
echo.

echo [2/2] Memulai Instalasi NLU (Rasa Python)...
cd rasa-bot
echo Membuat Virtual Environment (venv)...
python -m venv venv
echo Mengaktifkan Virtual Environment dan mengunduh dependencies (Proses ini mungkin memakan waktu agak lama)...
call venv\Scripts\activate
call python -m pip install --upgrade pip
call pip install -r requirements.txt
cd ..
echo [OK] NLU Rasa selesai diinstal!
echo.

echo =======================================================
echo 🎉 SEMUA DEPENDENSI BERHASIL DIINSTAL!
echo =======================================================
echo Cara menjalankan server:
echo 1. Buka 2 terminal.
echo 2. Terminal 1 (Backend): cd backend ^&^& npm start
echo 3. Terminal 2 (Rasa)   : cd rasa-bot ^&^& venv\Scripts\activate ^&^& rasa run --enable-api --cors "*"
echo =======================================================
pause
