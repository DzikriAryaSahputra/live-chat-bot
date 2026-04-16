(function() {
    // 1. Buat elemen Iframe penyedia chatbot SISCA
    var iframe = document.createElement('iframe');
    
    // URL server chatbot (HARUS diganti ke URL production nanti)
    var hostUrl = 'http://localhost:3000';
    
    iframe.src = hostUrl + '/';
    iframe.id = 'sisca-chatbot-iframe';
    
    // 2. Styling bawaan agar tidak mengganggu web utama
    iframe.style.position = 'fixed';
    iframe.style.bottom = '0';
    iframe.style.right = '0';
    iframe.style.border = 'none';
    iframe.style.zIndex = '2147483647';
    iframe.style.background = 'transparent';
    iframe.allow = 'microphone';

    // 3. Mulai dengan ukuran kecil (Hanya seukuran tombol Bubble)
    iframe.style.width = '100px';
    iframe.style.height = '100px';

    // Tempelkan ke halaman website BPS
    document.body.appendChild(iframe);

    // 4. Dengarkan sinyal dari Chatbot (saat dibuka / ditutup)
    window.addEventListener('message', function(event) {
        // Cek keamanan (hanya dengarkan pesan dari server bot kita)
        if (event.origin !== hostUrl) return;

        if (event.data === 'CHAT_OPENED') {
            // Perbesar ukuran iframe agar kotak chat terlihat utuh
            iframe.style.width = '420px';
            iframe.style.height = '620px';
        } else if (event.data === 'CHAT_CLOSED') {
            // Beri jeda 300ms membiarkan animasi chat menutup, baru iframe dikecilkan
            setTimeout(function() {
                iframe.style.width = '100px';
                iframe.style.height = '100px';
            }, 300);
        }
    });
})();
