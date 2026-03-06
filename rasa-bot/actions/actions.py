from typing import Any, Text, Dict, List
from rasa_sdk import Action, Tracker
from rasa_sdk.executor import CollectingDispatcher

class ActionCariWebsiteBPS(Action):
    def name(self) -> Text:
        return "action_cari_website_bps"

    def run(self, dispatcher: CollectingDispatcher,
            tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:

        # Mengambil pesan terakhir dari warga dan mengubahnya ke huruf kecil
        pesan_warga = tracker.latest_message.get('text', '').lower()
        
        # Base URL untuk halaman yang ada di dalam web utama BPS Jambi Kota
        base_url = "https://jambikota.bps.go.id/id"
        
        kategori = ""
        link = ""

        # --- KELOMPOK 1: MENGGUNAKAN BASE URL (Web Utama) ---
        if "publikasi" in pesan_warga or "buku" in pesan_warga:
            kategori = "Publikasi dan Buku Statistik"
            link = f"{base_url}/publication"
            
        elif "brs" in pesan_warga or "berita resmi" in pesan_warga or "rilis" in pesan_warga:
            kategori = "Berita Resmi Statistik (BRS)"
            link = f"{base_url}/pressrelease"
            
        elif "tabel dinamis" in pesan_warga or "statistik dinamis" in pesan_warga or "tabel statistik dinamis" in pesan_warga:
            kategori = "Tabel Statistik Dinamis"
            link = f"{base_url}/statistics-table"
            
        elif "berita" in pesan_warga or "kabar" in pesan_warga or "kegiatan" in pesan_warga:
            kategori = "Berita Kegiatan BPS"
            link = f"{base_url}/news"
            
        elif "grafik" in pesan_warga or "info grafik" in pesan_warga:
            kategori = "Infografik Statistik"
            link = f"{base_url}/infographic"

        # --- KELOMPOK 2: MENGGUNAKAN DOMAIN BERBEDA (Subdomain BPS Pusat) ---
        elif "sensus bps" in pesan_warga or "website sensus bps" in pesan_warga or "portal sensus bps" in pesan_warga:
            kategori = "Sensus BPS"
            link = "https://sensus.bps.go.id"
            
        elif "sensus 2020" in pesan_warga or "data sensus 2020" in pesan_warga or "hasil sensus 2020" in pesan_warga:
            kategori = "Data Sensus 2020"
            link = "https://sensus.bps.go.id/main/index/sp2020"
            
        elif "mitra" in pesan_warga or "rekrutmen" in pesan_warga or "loker" in pesan_warga:
            kategori = "Pendaftaran Mitra Statistik"
            link = "https://mitra.bps.go.id"
            
        elif "meta data" in pesan_warga or "meta data statistik" in pesan_warga:
            kategori = "Metadata Statistik"
            link = "https://sirusa.web.bps.go.id/metadata/"

        elif "ppid" in pesan_warga or "pejabat pengelola informasi dokumentasi" in pesan_warga:
            kategori = "PPID"
            link = "https://ppid.bps.go.id/?mfd=1571"

        elif "bps provinsi jambi" in pesan_warga or "website bps provinsi" in pesan_warga or "bps provinsi" in pesan_warga:
            kategori = "Website BPS Provinsi Jambi"
            link = "https://jambi.bps.go.id/id"
        
        elif "bps resmi" in pesan_warga or "website resmi bps" in pesan_warga or "website utama bps" in pesan_warga or "bps utama" in pesan_warga:
            kategori = "Website Resmi BPS"
            link = "https://www.bps.go.id/id"

        elif "layanan statistik" in pesan_warga or "layanan statistik bps" in pesan_warga or "layanan statistik bps jambi" in pesan_warga:
            kategori = "Layanan Statistik"
            link = "https://silastik.bps.go.id/v3/index.php/site/login/"

        elif "website lapor" in pesan_warga or "aplikasi lapor" in pesan_warga:
            kategori = "Aplikasi Lapor"
            link = "https://lapor.go.id/"
        
        elif "website portal" in pesan_warga or "aplikasi portal" in pesan_warga or "portal layanan" in pesan_warga:
            kategori = "Portal BPS"
            link = "https://statistik1571.my.id/"
        # --- JIKA TIDAK ADA KATA KUNCI YANG COCOK (Fallback) ---
        else:
            kategori = "Halaman Utama BPS Kota Jambi"
            link = base_url

        # --- MERAKIT PESAN BALASAN ---
        # Baris ini memastikan {link} dan teks penutup selalu ikut terkirim
# Mengganti \n dengan <br> agar aman saat dibaca oleh website
        pesan_balasan = f"Untuk informasi terkait **{kategori}**, Anda bisa mengaksesnya langsung melalui portal resmi kami di tautan berikut:<br><br>🔗 {link}<br><br>Apakah ada hal lain yang ingin ditanyakan?"        
        # Mengirimkan balasan ke layar warga
        dispatcher.utter_message(text=pesan_balasan)
        
        return []