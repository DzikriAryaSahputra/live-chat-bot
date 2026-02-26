// whatsapp-gateway/index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Inisialisasi client WhatsApp dengan LocalAuth
// LocalAuth berfungsi menyimpan sesi login agar tidak perlu scan QR terus-menerus
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, // Berjalan di background
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Event: Memunculkan QR Code di terminal jika belum login
client.on('qr', (qr) => {
    console.log('Scan QR Code ini menggunakan WhatsApp untuk login:');
    qrcode.generate(qr, { small: true });
});

// Event: Jika bot sukses terhubung
client.on('ready', () => {
    console.log('✅ WhatsApp Bot BPS sudah siap dan terhubung!');
});

// Event: Membaca pesan masuk
client.on('message', async msg => {
    console.log(`Pesan masuk dari ${msg.from}: ${msg.body}`);

    // Uji coba bot sederhana (tanpa NLP/Rasa)
    if (msg.body.toLowerCase() === 'ping') {
        msg.reply('pong! Bot WhatsApp BPS merespon dengan baik. 🤖');
    }
});

// Menjalankan client
client.initialize();