# ⚽ Fena Ekip - Dünya Kupası Sticker Takip

Panini 2026 Dünya Kupası sticker albümü ilerlemesini takip eden, 6 kişilik
"Fena Ekip" arkadaş grubu için canlı senkronize, mobil öncelikli, koyu/futbol
sahası temalı bir web uygulaması. Saf HTML/CSS/JS + Firebase Realtime
Database — build adımı yok, doğrudan GitHub Pages'e push edilebilir.

## İçindekiler

- `index.html` — ana sayfa
- `style.css` — tüm stiller (koyu tema, futbol sahası deseni)
- `data.js` — sabit veri modeli (koleksiyoncular, gruplar, ülkeler, bayraklar)
- `app.js` — uygulama mantığı (router, Firebase senkron, tüm ekranlar)
- `config.js.example` — Firebase yapılandırma şablonu
- `seed-data.json` — mevcut Excel'den çıkarılmış gerçek veri (6 kişi x 980 sticker)
- `seed.js` — Firebase Admin SDK ile seed-data.json'ı veritabanına yazan script
- `.gitignore` — `config.js` ve `serviceAccountKey.json`'ı repo dışında tutar

---

## 1) Firebase Kurulumu

1. [Firebase Console](https://console.firebase.google.com/)'a git, **"Add project"**
   ile yeni bir proje oluştur (ücretsiz Spark plan yeterli).
2. Sol menüden **Build → Realtime Database → Create Database**'e tıkla.
   - Bölge seç (örn. Europe).
   - **"Start in test mode"** seç (sonra kuralları tamamen açık yapacağız).
3. **Realtime Database → Rules** sekmesine gidip kuralları şu şekilde ayarla
   (bu özel, küçük bir arkadaş grubu projesi olduğu için authentication
   gerekmiyor — basitlik tercih edildi):
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
   **Publish** ile kaydet.
4. Sol üstteki ⚙️ **Project Settings → General** sekmesine gidip
   **"Your apps"** altında **Web (`</>`)** simgesine tıklayarak bir web app
   kaydet (isim önemli değil, Firebase Hosting'i işaretlemene gerek yok).
5. Sana gösterilen `firebaseConfig` nesnesini kopyala.
6. Bu klasördeki **`config.js.example`** dosyasını **`config.js`** olarak
   kopyala ve içindeki değerleri kendi `firebaseConfig`'in ile değiştir:
   ```bash
   cp config.js.example config.js
   ```
   `config.js` `.gitignore`'da olduğu için yanlışlıkla repo'ya gitmez —
   ama Firebase kuralları tamamen açık olduğu için `apiKey` gizli kalmasa
   da ciddi bir risk oluşturmaz (yine de repo'yu public yapmadan önce
   iki kez düşün).

---

## 2) İlk Kurulum Verisinin (seed-data.json) Aktarımı

Bu adım **sadece bir kez**, projeyi ilk kurarken yapılır. Amaç, 6
koleksiyoncunun Excel'de zaten işlenmiş olan gerçek sticker durumlarının
sıfırdan başlamak yerine doğrudan uygulamaya aktarılmasıdır.

### Yöntem A — Node.js script ile (önerilen)

1. Firebase Console → ⚙️ **Project Settings → Service Accounts** sekmesine
   git, **"Generate new private key"**'e tıkla. İnen dosyayı bu klasöre
   `serviceAccountKey.json` adıyla koy (bu dosya da `.gitignore`'da,
   **asla** repo'ya push etme).
2. `seed.js` içindeki `DATABASE_URL` değerini kendi projenin
   `databaseURL` değeriyle değiştir (config.js'deki ile aynı).
3. Terminalde:
   ```bash
   npm install firebase-admin
   node seed.js
   ```
4. `✅ Seed tamamlandı` mesajını gördüğünde, Firebase Console → Realtime
   Database → Data sekmesinden `/stickers` ve `/swapCounts` altında 6
   kişinin verisinin göründüğünü doğrula.

### Yöntem B — Firebase Console'dan manuel import

1. Realtime Database → Data sekmesinde, veritabanının kök (root)
   düğümünün yanındaki ⋮ menüsünden **"Import JSON"**'ı seç.
2. Bu klasördeki `seed-data.json` dosyasını seç ve import et.
   (Bu dosyanın kökünde zaten `stickers` ve `swapCounts` anahtarları var,
   bu yüzden doğrudan kök düğüme import edilebilir.)

Import tamamlandıktan sonra uygulamayı açtığında ana sayfadaki
tamamlanma yüzdeleri şu değerlerle eşleşmeli:

| Kişi | Owned (toplam) | Missing |
|---|---|---|
| Efe | 691 | 352 |
| Cenk | 615 | 426 |
| Andaç | 528 | 487 |
| Andaç D | 1273 | 240 |
| Berker | 684 | 472 |
| Arda | 0 | 980 |

---

## 3) Yerelde Test Etme

Herhangi bir statik dosya sunucusuyla açabilirsin, örneğin:

```bash
python3 -m http.server 8000
# tarayıcıda http://localhost:8000 aç
```

(Doğrudan `file://` ile açmak da çoğu tarayıcıda çalışır, ama bazı
tarayıcılar `file://` üzerinden Firebase'e bağlanırken sorun çıkarabilir —
yerel sunucu daha güvenli.)

---

## 4) GitHub Pages'e Deploy

1. Bu klasörü bir GitHub reposuna push et (config.js ve
   serviceAccountKey.json otomatik olarak dışarıda kalacak, `.gitignore`
   sayesinde — repo'ya push etmeden önce `git status` ile kontrol et).
2. **Reponun ayarlarına git: Settings → Pages.**
3. **"Build and deployment" → Source** altında **"Deploy from a branch"**
   seç.
4. **Branch**'i `main` (veya kullandığın branch), klasörü `/ (root)`
   olarak seç, **Save**'e tıkla.
5. Birkaç dakika içinde `https://<kullanıcı-adın>.github.io/<repo-adı>/`
   adresinde canlıya geçecek.
6. **Önemli:** `config.js` GitHub'a push edilmediği için, GitHub Pages'te
   siteyi açtığında konfigürasyon eksik olacak. İki seçenek var:
   - **(a)** `config.js`'i gerçek değerleriyle repoya ekle (küçük, kapalı
     bir arkadaş grubu projesi olduğu için bu genelde kabul edilebilir —
     Firebase kuralları zaten tamamen açık).
   - **(b)** `.gitignore`'dan `config.js`'i çıkarıp yine de push et.

---

## 5) Kullanım Notları

- Her koleksiyoncu ana sayfada kendi ismine tıklayarak panele girer.
  İlk girişte bir renk seçmesi istenir (bu renk sadece kutu/panel
  kenarlığı olarak kullanılır, kart durumlarıyla karışmaz).
- Tarayıcı hiçbir şeyi hatırlamaz — her girişte isme tekrar tıklanır,
  şifre/PIN yok, güven bazlı bir sistemdir.
- Bir kartın durumunu değiştirmek Firebase'e anında yazılır ve diğer
  cihazlarda açık olan uygulamalar da canlı olarak güncellenir.
- Her panelde son 1-3 işlemi geri almak için **"↩ Geri Al"** butonu
  kullanılabilir (sadece o an açık olan oturum için, kalıcı bir işlem
  geçmişi tutulmaz).
- Toplu sıfırlama arayüzü yoktur — ihtiyaç olursa Firebase Console'dan
  ilgili düğüm elle silinebilir/güncellenebilir.

---

## 6) Sorun Giderme

- **"Bağlantı sorunu, tekrar deneyin" hatası alıyorum:** İnternet
  bağlantını kontrol et; Firebase Realtime Database kurallarının
  `.read`/`.write: true` olarak yayınlandığından emin ol.
- **Sayfa hiç yüklenmiyor / sonsuz "Veriler yükleniyor…" görüyorum:**
  `config.js` dosyasının doğru `databaseURL` ile var olduğundan emin ol;
  tarayıcı konsolunda (F12) hata olup olmadığına bak.
- **Seed verisi eksik/yanlış görünüyor:** Seed adımını (Bölüm 2) tekrar
  çalıştırmadan önce Firebase Console'dan `/stickers` ve `/swapCounts`
  düğümlerini elle silip tekrar dene.
