import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Candidate font directories
const candidateFontDirs = [
  path.resolve(__dirname, '../../../../client/public/fonts'),
  path.resolve(process.cwd(), 'client/public/fonts'),
  path.resolve(process.cwd(), '../client/public/fonts'),
  path.resolve(process.cwd(), 'public/fonts'),
];

let resolvedFontDir = null;
for (const dir of candidateFontDirs) {
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    resolvedFontDir = dir;
    break;
  }
}

if (!resolvedFontDir) {
  console.warn('[FontRegistry] Warning: Could not locate client/public/fonts directory automatically.');
}

// Devanagari & Stylish fonts auto-downloader
const REMOTE_DEV_FONTS = {
  'RozhaOne-Regular.ttf': 'https://fonts.gstatic.com/s/rozhaone/v17/AlZy_zVFtYP12Zncg2khdQ.ttf',
  'YatraOne-Regular.ttf': 'https://fonts.gstatic.com/s/yatraone/v16/C8ch4copsHzj8p7NaF0xww.ttf',
  'AlexBrush-Regular.ttf': 'https://fonts.gstatic.com/s/alexbrush/v23/SZc83FzrJKuqFbwMKk6EtUI.ttf',
  'Marcellus-Regular.ttf': 'https://fonts.gstatic.com/s/marcellus/v14/wEO_EBrOk8hQLDvIAF8FUQ.ttf',
  'Allura-Regular.ttf': 'https://fonts.gstatic.com/s/allura/v23/9oRPNYsQpS4zjuAPjA.ttf',
};

if (resolvedFontDir) {
  for (const [file, url] of Object.entries(REMOTE_DEV_FONTS)) {
    const dest = path.join(resolvedFontDir, file);
    if (!fs.existsSync(dest)) {
      fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((buf) => {
          if (buf) {
            fs.writeFileSync(dest, Buffer.from(buf));
            console.log(`[FontRegistry] Downloaded stylish Indic font "${file}" (${buf.byteLength} bytes)`);
          }
        })
        .catch((e) => console.warn(`[FontRegistry] Could not download font "${file}":`, e.message));
    }
  }
}

/**
 * Registry mapping normalized font family names and weights to exact TTF file names.
 */
const FONT_FILE_MAP = {
  // Devanagari (Hindi, Marathi, Sanskrit)
  'rozha one': {
    400: 'RozhaOne-Regular.ttf',
    700: 'RozhaOne-Regular.ttf',
  },
  'yatra one': {
    400: 'YatraOne-Regular.ttf',
    700: 'YatraOne-Regular.ttf',
  },
  'noto sans devanagari': {
    400: 'NotoSansDevanagari-Regular.ttf',
    600: 'NotoSansDevanagari-Bold.ttf',
    700: 'NotoSansDevanagari-Bold.ttf',
    800: 'NotoSansDevanagari-Bold.ttf',
  },
  'noto serif devanagari': {
    400: 'NotoSerif-Regular.ttf',
    700: 'NotoSerif-Bold.ttf',
  },
  'mukta': {
    400: 'NotoSansDevanagari-Regular.ttf',
    700: 'NotoSansDevanagari-Bold.ttf',
  },

  // Gujarati
  'noto sans gujarati': {
    400: 'MuktaVaani-Regular.ttf',
    700: 'MuktaVaani-Bold.ttf',
  },
  'mukta vaani': {
    400: 'MuktaVaani-Regular.ttf',
    700: 'MuktaVaani-Bold.ttf',
  },

  // Bengali
  'noto sans bengali': {
    400: 'NotoSansBengali-Regular.ttf',
    700: 'NotoSansBengali-Bold.ttf',
  },

  // Tamil
  'noto sans tamil': {
    400: 'NotoSansTamil-Regular.ttf',
    700: 'NotoSansTamil-Bold.ttf',
  },

  // Telugu
  'noto sans telugu': {
    400: 'NotoSansTelugu-Regular.ttf',
    700: 'NotoSansTelugu-Bold.ttf',
  },
  'mandali': {
    400: 'Mandali-Regular.ttf',
    700: 'Mandali-Regular.ttf',
  },
  'ramabhadra': {
    400: 'Ramabhadra-Regular.ttf',
    700: 'Ramabhadra-Regular.ttf',
  },

  // Kannada
  'noto sans kannada': {
    400: 'NotoSansKannada-Regular.ttf',
    700: 'NotoSansKannada-Bold.ttf',
  },

  // Punjabi / Gurmukhi
  'mukta mahee': {
    400: 'MuktaMahee-Regular.ttf',
    700: 'MuktaMahee-Bold.ttf',
  },
  'noto sans gurmukhi': {
    400: 'MuktaMahee-Regular.ttf',
    700: 'MuktaMahee-Bold.ttf',
  },

  // Urdu / Arabic
  'amiri': {
    400: 'Amiri-Regular.ttf',
    700: 'Amiri-Bold.ttf',
  },
  'noto sans arabic': {
    400: 'Amiri-Regular.ttf',
    700: 'Amiri-Bold.ttf',
  },

  // Latin / Clean Sans
  'poppins': {
    400: 'Poppins-Regular.ttf',
    500: 'Poppins-Regular.ttf',
    600: 'Poppins-SemiBold.ttf',
    700: 'Poppins-Bold.ttf',
    800: 'Poppins-Bold.ttf',
  },
  'inter': {
    400: 'Inter-Regular.ttf',
    700: 'Inter-Bold.ttf',
  },
  'montserrat': {
    400: 'Montserrat-Regular.ttf',
    600: 'Montserrat-SemiBold.ttf',
    700: 'Montserrat-Bold.ttf',
  },
  'raleway': {
    400: 'Raleway-Regular.ttf',
    700: 'Raleway-Bold.ttf',
  },

  // Latin / Display & Serif
  'cinzel': {
    400: 'Cinzel-Regular.ttf',
    700: 'Cinzel-Bold.ttf',
  },
  'cinzel decorative': {
    400: 'Cinzel-Regular.ttf',
    700: 'Cinzel-Bold.ttf',
  },
  'playfair display': {
    400: 'PlayfairDisplay-Regular.ttf',
    700: 'PlayfairDisplay-Bold.ttf',
  },
  'cormorant garamond': {
    400: 'CormorantGaramond-Regular.ttf',
    700: 'CormorantGaramond-Bold.ttf',
  },
  'eb garamond': {
    400: 'EBGaramond-Regular.ttf',
    700: 'EBGaramond-Bold.ttf',
  },
  'lora': {
    400: 'Lora-Regular.ttf',
    700: 'Lora-Bold.ttf',
  },
  'noto serif': {
    400: 'NotoSerif-Regular.ttf',
    700: 'NotoSerif-Bold.ttf',
  },

  // Calligraphy & Display
  'great vibes': {
    400: 'GreatVibes-Regular.ttf',
    700: 'GreatVibes-Regular.ttf',
  },
  'alex brush': {
    400: 'AlexBrush-Regular.ttf',
    700: 'AlexBrush-Regular.ttf',
    800: 'AlexBrush-Regular.ttf',
  },
  'marcellus': {
    400: 'Marcellus-Regular.ttf',
    700: 'Marcellus-Regular.ttf',
    800: 'Marcellus-Regular.ttf',
  },
  'allura': {
    400: 'Allura-Regular.ttf',
    700: 'Allura-Regular.ttf',
  },
};

/**
 * Normalizes font family name for robust matching.
 * @param {string} family
 * @returns {string}
 */
export function normalizeFontFamily(family) {
  if (!family || typeof family !== 'string') return 'poppins';
  return family.trim().toLowerCase().replace(/['"]/g, '').replace(/[-_]+/g, ' ');
}

/**
 * Normalizes weight to 400, 600, or 700.
 * @param {number|string} weight
 * @returns {number}
 */
export function normalizeFontWeight(weight) {
  if (!weight) return 400;
  if (typeof weight === 'string') {
    const lower = weight.toLowerCase();
    if (lower === 'bold' || lower === 'bolder' || lower === '900' || lower === '800') return 700;
    if (lower === 'semibold' || lower === '600') return 600;
    if (lower === 'medium' || lower === '500') return 500;
    const parsed = parseInt(weight, 10);
    return isNaN(parsed) ? 400 : parsed;
  }
  return weight >= 600 ? 700 : 400;
}

/**
 * Resolves the absolute path to the local TTF font file.
 * Throws an explicit error if the font is missing, rather than silently substituting.
 * 
 * @param {string} family
 * @param {number|string} weight
 * @returns {string} Absolute path to TTF file
 */
export function resolveFontFilePath(family, weight = 400) {
  const normFamily = normalizeFontFamily(family);
  const normWeight = normalizeFontWeight(weight);

  const familyEntry = FONT_FILE_MAP[normFamily];
  if (!familyEntry) {
    const errorMsg = `[FontRegistry] Explicit font error: Unknown font family "${family}". No silent substitution allowed.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const fileName = familyEntry[normWeight] || familyEntry[700] || familyEntry[400];
  if (!fileName) {
    const errorMsg = `[FontRegistry] Explicit font error: Weight ${normWeight} unavailable for font "${family}".`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  if (!resolvedFontDir) {
    throw new Error(`[FontRegistry] Cannot locate font directory for "${family}".`);
  }

  const fullPath = path.join(resolvedFontDir, fileName);
  if (!fs.existsSync(fullPath)) {
    const errorMsg = `[FontRegistry] Explicit font error: Font file missing on disk: ${fullPath}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  return fullPath;
}

/**
 * Detects regional script from text characters.
 * @param {string} text
 * @param {string} defaultFamily
 * @returns {string}
 */
export function detectScriptFontFamily(text, defaultFamily = 'Poppins', isHeading = false) {
  if (!text) return defaultFamily;
  if (/[\u0900-\u097F]/.test(text)) return 'Noto Sans Devanagari';
  if (/[\u0A80-\u0AFF]/.test(text)) return 'Noto Sans Gujarati';
  if (/[\u0980-\u09FF]/.test(text)) return 'Noto Sans Bengali';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'Noto Sans Tamil';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'Noto Sans Telugu';
  if (/[\u0C80-\u0CFF]/.test(text)) return 'Noto Sans Kannada';
  if (/[\u0A00-\u0A7F]/.test(text)) return 'Mukta Mahee';
  if (/[\u0600-\u06FF]/.test(text)) return 'Amiri';
  return defaultFamily;
}

export function doesFontSupportScript(fontName, text) {
  if (!fontName) return false;
  if (!text) return true;
  const font = fontName.toLowerCase().trim().replace(/['"]/g, '');

  const isDevanagari = /[\u0900-\u097F]/.test(text);
  const isBengali = /[\u0980-\u09FF]/.test(text);
  const isGujarati = /[\u0A80-\u0AFF]/.test(text);
  const isGurmukhi = /[\u0A00-\u0A7F]/.test(text);
  const isTamil = /[\u0B80-\u0BFF]/.test(text);
  const isTelugu = /[\u0C00-\u0C7F]/.test(text);
  const isKannada = /[\u0C80-\u0CFF]/.test(text);
  const isArabic = /[\u0600-\u06FF]/.test(text);

  if (!isDevanagari && !isBengali && !isGujarati && !isGurmukhi && !isTamil && !isTelugu && !isKannada && !isArabic) {
    return true;
  }

  const devanagariOnlyFonts = [
    'rozha one', 'yatra one', 'kalam', 'tillana', 'amita', 'gotu', 'modak', 'kurale',
    'arya', 'eczar', 'karma', 'sahitya', 'noto serif devanagari', 'mukta', 'noto sans devanagari'
  ];
  if (devanagariOnlyFonts.includes(font)) {
    return isDevanagari;
  }

  if (font.includes('gujarati') || font.includes('mukta vaani')) return isGujarati;
  if (font.includes('bengali')) return isBengali;
  if (font.includes('tamil')) return isTamil;
  if (font.includes('telugu') || font.includes('mandali') || font.includes('ramabhadra')) return isTelugu;
  if (font.includes('kannada')) return isKannada;
  if (font.includes('gurmukhi') || font.includes('mukta mahee')) return isGurmukhi;
  if (font.includes('arabic') || font.includes('amiri')) return isArabic;

  return false;
}

