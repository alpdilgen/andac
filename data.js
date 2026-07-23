/* ============================================================
   data.js — Fena Ekip Sticker Takip: sabit veri modeli
   Koleksiyoncular, gruplar, ülkeler, sticker kodları, bayraklar.
   ============================================================ */

// 6 koleksiyoncu (sabit, genişletilebilirlik gerekmiyor)
const COLLECTORS = ["Efe", "Cenk", "Andaç", "Andaç D.", "Berker", "Arda"];

// Ana sayfada sol/sağ hizalama
const COLLECTORS_LEFT = ["Efe", "Cenk", "Andaç"];
const COLLECTORS_RIGHT = ["Andaç D.", "Berker", "Arda"];

// 12 grup x 4 ülke = 48 ülke, [Ülke adı, Kod]
const GROUPS = {
  A: [["Mexico", "MEX"], ["South Africa", "RSA"], ["Korea Republic", "KOR"], ["Czechia", "CZE"]],
  B: [["Canada", "CAN"], ["Bosnia-Herzegovina", "BIH"], ["Qatar", "QAT"], ["Switzerland", "SUI"]],
  C: [["Brazil", "BRA"], ["Morocco", "MAR"], ["Haiti", "HAI"], ["Scotland", "SCO"]],
  D: [["USA", "USA"], ["Paraguay", "PAR"], ["Australia", "AUS"], ["Turkiye", "TUR"]],
  E: [["Germany", "GER"], ["Curaçao", "CUW"], ["Côte d'Ivoire", "CIV"], ["Ecuador", "ECU"]],
  F: [["Netherlands", "NED"], ["Japan", "JPN"], ["Sweden", "SWE"], ["Tunisia", "TUN"]],
  G: [["Belgium", "BEL"], ["Egypt", "EGY"], ["IR Iran", "IRN"], ["New Zealand", "NZL"]],
  H: [["Spain", "ESP"], ["Cabo Verde", "CPV"], ["Saudi Arabia", "KSA"], ["Uruguay", "URU"]],
  I: [["France", "FRA"], ["Senegal", "SEN"], ["Iraq", "IRQ"], ["Norway", "NOR"]],
  J: [["Argentina", "ARG"], ["Algeria", "ALG"], ["Austria", "AUT"], ["Jordan", "JOR"]],
  K: [["Portugal", "POR"], ["Congo DR", "COD"], ["Uzbekistan", "UZB"], ["Colombia", "COL"]],
  L: [["England", "ENG"], ["Croatia", "CRO"], ["Ghana", "GHA"], ["Panama", "PAN"]],
};

const GROUP_ORDER = Object.keys(GROUPS); // A..L

const CARDS_PER_COUNTRY = 20;
const FWC_CODE_LIST = ["00", ...Array.from({ length: 19 }, (_, i) => `FWC${i + 1}`)]; // 20 kart
const TOTAL_STICKERS = 48 * CARDS_PER_COUNTRY + FWC_CODE_LIST.length; // 980

// Ülke adı -> ISO-3166 alpha-2 (bayrak emoji üretimi için)
const ISO2_MAP = {
  "Mexico": "MX", "South Africa": "ZA", "Korea Republic": "KR", "Czechia": "CZ",
  "Canada": "CA", "Bosnia-Herzegovina": "BA", "Qatar": "QA", "Switzerland": "CH",
  "Brazil": "BR", "Morocco": "MA", "Haiti": "HT", "Scotland": "GB-SCT",
  "USA": "US", "Paraguay": "PY", "Australia": "AU", "Turkiye": "TR",
  "Germany": "DE", "Curaçao": "CW", "Côte d'Ivoire": "CI", "Ecuador": "EC",
  "Netherlands": "NL", "Japan": "JP", "Sweden": "SE", "Tunisia": "TN",
  "Belgium": "BE", "Egypt": "EG", "IR Iran": "IR", "New Zealand": "NZ",
  "Spain": "ES", "Cabo Verde": "CV", "Saudi Arabia": "SA", "Uruguay": "UY",
  "France": "FR", "Senegal": "SN", "Iraq": "IQ", "Norway": "NO",
  "Argentina": "AR", "Algeria": "DZ", "Austria": "AT", "Jordan": "JO",
  "Portugal": "PT", "Congo DR": "CD", "Uzbekistan": "UZ", "Colombia": "CO",
  "England": "GB-ENG", "Croatia": "HR", "Ghana": "GH", "Panama": "PA",
};

// Bayrak emoji üretimi. Unicode regional indicator sembolleri A-Z -> U+1F1E6..
// England/Scotland gibi "GB-XXX" özel altbayraklar Unicode tag-sequence ile.
function flagEmoji(iso2) {
  if (iso2 === "GB-SCT") return "🏴󠁧󠁢󠁳󠁣󠁴󠁿"; // İskoçya
  if (iso2 === "GB-ENG") return "🏴󠁧󠁢󠁥󠁮󠁧󠁿"; // İngiltere
  const codePoints = [...iso2.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

function countryFlag(countryName) {
  const iso2 = ISO2_MAP[countryName];
  return iso2 ? flagEmoji(iso2) : "🏳️";
}

// Sticker kod indeksi: her kod için { code, group, country, countryCode, flag }
// FWC kartları group="FWC", country=null
const STICKER_INDEX = {}; // code -> meta
const GROUP_CODES = {}; // group -> [codes]
const COUNTRY_CODES = {}; // countryCode -> [codes]

for (const g of GROUP_ORDER) {
  GROUP_CODES[g] = [];
  for (const [name, code] of GROUPS[g]) {
    COUNTRY_CODES[code] = [];
    for (let i = 1; i <= CARDS_PER_COUNTRY; i++) {
      const stickerCode = `${code}${i}`;
      STICKER_INDEX[stickerCode] = {
        code: stickerCode,
        group: g,
        countryName: name,
        countryCode: code,
        flag: countryFlag(name),
      };
      GROUP_CODES[g].push(stickerCode);
      COUNTRY_CODES[code].push(stickerCode);
    }
  }
}
for (const code of FWC_CODE_LIST) {
  STICKER_INDEX[code] = {
    code,
    group: "FWC",
    countryName: null,
    countryCode: "FWC",
    flag: "⚽",
  };
}

// Kolaylık: grup içindeki ülke sırası (önceki/sonraki geçiş için)
function countriesInGroup(g) {
  return GROUPS[g].map(([name, code]) => ({ name, code }));
}

function nextCountryInGroup(g, code) {
  const list = countriesInGroup(g);
  const idx = list.findIndex((c) => c.code === code);
  if (idx === -1) return null;
  return list[(idx + 1) % list.length];
}

function prevCountryInGroup(g, code) {
  const list = countriesInGroup(g);
  const idx = list.findIndex((c) => c.code === code);
  if (idx === -1) return null;
  return list[(idx - 1 + list.length) % list.length];
}
