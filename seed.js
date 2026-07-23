/* ============================================================
   seed.js — Firebase Realtime Database'e ilk kurulum verisini yazar

   Bu script SADECE İLK KURULUMDA BİR KEZ çalıştırılır.
   seed-data.json içeriğini /stickers ve /swapCounts yollarına yazar.
   Sonrasında uygulama normal şekilde canlı güncellemelerle ilerler.

   Kullanım:
     1. npm install firebase-admin
     2. Firebase Console → Project Settings → Service Accounts →
        "Generate new private key" ile bir serviceAccountKey.json indir
        ve bu klasöre koy (bu dosya da .gitignore'da, asla push etme).
     3. node seed.js
   ============================================================ */

const admin = require("firebase-admin");
const seedData = require("./seed-data.json");

// serviceAccountKey.json'ı indirip bu klasöre koymalısın (bkz. README).
const serviceAccount = require("./serviceAccountKey.json");

// databaseURL'i kendi Firebase projenle değiştir (config.js'deki ile aynı).
const DATABASE_URL = "https://BURAYA_PROJE-default-rtdb.firebaseio.com";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL,
});

async function seed() {
  const db = admin.database();

  console.log("Yazılıyor: /stickers ...");
  await db.ref("/stickers").set(seedData.stickers);

  console.log("Yazılıyor: /swapCounts ...");
  await db.ref("/swapCounts").set(seedData.swapCounts);

  console.log("✅ Seed tamamlandı. 6 koleksiyoncunun 980'er sticker durumu yazıldı.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed sırasında hata oluştu:", err);
  process.exit(1);
});
