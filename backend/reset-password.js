const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Get the new password from the command line arguments
const newPassword = process.argv[2];

if (!newPassword) {
    console.error("❌ Kesalahan: Anda harus memberikan sandi baru.");
    console.log("👉 Cara Penggunaan: node reset-password.js <SandiBaru>");
    process.exit(1);
}

// Check if settings.json exists
if (!fs.existsSync(SETTINGS_FILE)) {
    console.error(`❌ Kesalahan: File pengaturan tidak ditemukan di ${SETTINGS_FILE}`);
    console.log("Silakan jalankan backend terlebih dahulu agar file ini otomatis dibuat.");
    process.exit(1);
}

try {
    // Read the current settings
    const settingsRaw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(settingsRaw);

    // Encrypt the new password
    const saltRounds = 10;
    const newHash = bcrypt.hashSync(newPassword, saltRounds);

    // Update the password in settings
    settings.admin.passwordHash = newHash;

    // Save the updated settings
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));

    console.log(`✅ BERHASIL! Sandi untuk Super Admin "${settings.admin.username}" telah di-reset.`);
    console.log("Silakan login kembali melalui halaman Admin Dashboard.");
} catch (error) {
    console.error("❌ Terjadi kesalahan saat membaca atau menyimpan file settings.json:", error.message);
    process.exit(1);
}
