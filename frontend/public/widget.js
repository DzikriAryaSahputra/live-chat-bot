(function() {
    // 1. Buat elemen Iframe penyedia chatbot BIPS
    var iframe = document.createElement('iframe');
    
    // URL server chatbot (HARUS diganti ke URL production nanti)
    var hostUrl = 'http://localhost:3000';
    
    iframe.src = hostUrl + '/';
    iframe.id = 'bips-chatbot-iframe';
    
    // 2. Styling bawaan agar tidak mengganggu web utama
    iframe.style.position = 'fixed';
    iframe.style.bottom = '0';
    iframe.style.right = '0';
    iframe.style.border = 'none';
    iframe.style.zIndex = '2147483647';
    iframe.style.background = 'transparent';
    iframe.allow = 'microphone; speaker-selection';
    // KRITIS: sandbox tanpa allow-top-navigation mencegah iframe menavigasi/refresh halaman parent
    iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

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
            // Cek lebar layar (jika mobile < 768px, penuhi layar 100%)
            var isMobile = window.innerWidth < 768;
            if (isMobile) {
                iframe.style.width = '100%';
                iframe.style.height = '100%';
            } else {
                iframe.style.width = '420px';
                iframe.style.height = '620px';
            }
            // Kirim sinyal layout ke dalam iframe
            iframe.contentWindow.postMessage({ type: 'LAYOUT_MODE', isMobile: isMobile }, '*');
        } else if (event.data === 'CHAT_CLOSED') {
            // Beri jeda 300ms membiarkan animasi chat menutup, baru iframe dikecilkan
            setTimeout(function() {
                iframe.style.width = '100px';
                iframe.style.height = '100px';
            }, 300);
        }
    });
})();
