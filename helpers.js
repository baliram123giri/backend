// Helper utilities and presets for Biodata Fastify Backend

export const GRADIENT_PRESETS = [
  // Light / Pastel
  { name: "Soft Rose", colors: "#ffffff,#fff0f5" },
  { name: "Pearl White", colors: "#ffffff,#f8f9fa" },
  { name: "Lavender Dream", colors: "#e0c3fc,#8ec5fc" },
  { name: "Sky Tint", colors: "#e0eafc,#cfdef3" },
  { name: "Rose Water", colors: "#e55d87,#5fc3e4" },
  { name: "Cotton Candy", colors: "#ffecd2,#fcb69f" },
  { name: "Peppermint", colors: "#a1ffce,#faffd1" },
  { name: "Vanilla", colors: "#f3e7e9,#e3eeff" },
  { name: "Lemon", colors: "#f9d423,#ff4e50" },
  // Dark / Rich Presets (Matches Gold frames well)
  { name: "Midnight Navy", colors: "#0f172a,#1e293b" },
  { name: "Deep Aubergine", colors: "#2a1b38,#3a254f" },
  { name: "Royal Onyx", colors: "#0a0a0a,#1c1c1c" },
  { name: "Emerald Black", colors: "#061a14,#0e3327" },
  { name: "Rich Crimson", colors: "#2b0910,#4a101b" },
  { name: "Deep Cocoa", colors: "#2c1810,#422418" },
  { name: "Midnight Sapphire", colors: "#020c1b,#0a192f" },
  { name: "Dark Amethyst", colors: "#1a0b2e,#3b185f" },
  { name: "Forest Night", colors: "#013220,#02422b" },
  { name: "Burgundy Wine", colors: "#3b0000,#5c0000" },
  { name: "Obsidian", colors: "#000000,#242424" },
  { name: "Navy to Purple", colors: "#0f0c29,#302b63,#24243e" },

  // Warm & Earthy
  { name: "Warm Gold", colors: "#ffffff,#fef9e7" },
  { name: "Sunset Orange", colors: "#ff7e5f,#feb47b" },
  { name: "Peachy Dawn", colors: "#ffedbc,#ed4264" },
  { name: "Desert Sand", colors: "#e6dada,#274046" },
  { name: "Autumn Leaves", colors: "#d38312,#a83279" },
  { name: "Mocha", colors: "#e6d0ce,#9a8478" },
  { name: "Bronze Muted", colors: "#b79891,#94716b" },
  { name: "Coffee", colors: "#603813,#b29f94" },

  // Cool & Aquatic
  { name: "Aqua Marine", colors: "#1a2a6c,#b21f1f,#fdbb2d" },
  { name: "Ocean Breeze", colors: "#2193b0,#6dd5ed" },
  { name: "Deep Sea", colors: "#2c3e50,#3498db" },
  { name: "Mint Water", colors: "#56ab2f,#a8e063" },
  { name: "Subtle Mint", colors: "#ffffff,#f2fbf5" },
  { name: "Teal Glow", colors: "#11998e,#38ef7d" },
  { name: "Azure Pop", colors: "#00c6ff,#0072ff" },
  { name: "Frost", colors: "#000428,#004e92" },

  // Vibrant & Playful
  { name: "Magenta Pop", colors: "#f12711,#f5af19" },
  { name: "Neon Pink", colors: "#dd3e54,#6be585" },
  { name: "Purple Haze", colors: "#8e2de2,#4a00e0" },
  { name: "Fruity", colors: "#f09819,#edde5d" },
  { name: "Mango", colors: "#ffe259,#ffa751" },
  { name: "Berry Smooth", colors: "#8a2387,#e94057,#f27121" },
  { name: "Cosmic", colors: "#ff0099,#493240" },

  // Elegant & Neutral
  { name: "Silver Grey", colors: "#bdc3c7,#2c3e50" },
  { name: "Slate", colors: "#4b6cb7,#182848" },
  { name: "Steel", colors: "#141e30,#243b55" },
  { name: "Platinum", colors: "#d7d2cc,#304352" },
  { name: "Ash", colors: "#606c88,#3f4c6b" },
  { name: "Graphite", colors: "#485563,#29323c" }
];

export function sanitizeTemplateConfig(config) {
  if (!config) return config;

  const frame = config.frame ? { ...config.frame } : undefined;
  if (frame) {
    if (frame.type === "svg" || frame.type === "gradient") {
      frame.outerCornerRadius = 0;
      frame.innerCornerRadius = 0;
    }
  }

  return {
    ...config,
    photo: config.photo ? {
      ...config.photo,
      cornerRadius: config.photo.cornerRadius ?? 8,
    } : { x: 390, y: 100, width: 140, height: 175, cornerRadius: 8 },
    frame,
  };
}

export function mapDbTemplateToConfig(dbTpl) {
  let frame;

  if (dbTpl.frameType === "image") {
    frame = {
      type: "image",
      urlTemplate: dbTpl.frameUrlTemplate || "",
      bgColor: dbTpl.frameBgColor || "#ffffff",
    };
  } else if (dbTpl.frameType === "svg") {
    frame = {
      type: "svg",
      bgColor: dbTpl.frameBgColor || "#ffffff",
      outerInset: dbTpl.frameOuterInset ?? 10,
      outerStrokeWidth: dbTpl.frameOuterStrokeWidth ?? 2,
      outerCornerRadius: 0,
      innerInset: dbTpl.frameInnerInset ?? 16,
      innerStrokeWidth: dbTpl.frameInnerStrokeWidth ?? 1,
      innerCornerRadius: 0,
      hasCornerCurves: dbTpl.frameHasCornerCurves ?? true,
    };
  } else if (dbTpl.frameType === "gradient") {
    frame = {
      type: "gradient",
      bgColor: dbTpl.frameBgColor || "#ffffff",
      gradientColors: dbTpl.frameGradientColors || ["#4F46E5", "#06B6D4"],
      outerInset: dbTpl.frameOuterInset ?? 10,
      outerStrokeWidth: dbTpl.frameOuterStrokeWidth ?? 2,
      outerCornerRadius: 0,
      innerInset: dbTpl.frameInnerInset ?? 16,
      innerStrokeWidth: dbTpl.frameInnerStrokeWidth ?? 1,
      innerCornerRadius: 0,
    };
  } else {
    frame = {
      type: "custom",
      componentId: dbTpl.frameComponentId || "new-generation-arch",
      bgColor: dbTpl.frameBgColor || "#ffffff",
    };
  }

  let bgConfig = undefined;
  if (dbTpl.bgConfig) {
    try {
      const parsed = typeof dbTpl.bgConfig === "string" ? JSON.parse(dbTpl.bgConfig) : dbTpl.bgConfig;
      if (parsed) {
        bgConfig = {
          url: parsed.url || undefined,
          x: typeof parsed.x === "number" ? parsed.x : 0,
          y: typeof parsed.y === "number" ? parsed.y : 0,
          width: typeof parsed.width === "number" ? parsed.width : 595,
          height: typeof parsed.height === "number" ? parsed.height : 842,
          opacity: typeof parsed.opacity === "number" ? parsed.opacity : 1.0,
          fontFamily: parsed.fontFamily || undefined,
          fontWeight: parsed.fontWeight || undefined,
          fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : undefined,
          alignment: parsed.alignment || undefined,
          sectionOffsets: parsed.sectionOffsets || "{}",
          sectionStyles: parsed.sectionStyles || "{}",
          imageFrameOffset: parsed.imageFrameOffset || "0",
          frameImageX: parsed.frameImageX,
          frameImageY: parsed.frameImageY,
          frameImageWidth: parsed.frameImageWidth,
          frameImageHeight: parsed.frameImageHeight,
          enableSvgTint: parsed.enableSvgTint,
        };
      }
    } catch (e) {
      console.error("Error parsing bgConfig:", e);
    }
  }

  return sanitizeTemplateConfig({
    id: dbTpl.id,
    name: dbTpl.name,
    description: dbTpl.description || "",
    defaultPrimary: dbTpl.defaultPrimary,
    defaultSecondary: dbTpl.defaultSecondary,
    defaultAccent: dbTpl.defaultAccent,
    defaultPadding: dbTpl.defaultPadding,
    defaultYPadding: dbTpl.defaultYPadding ?? undefined,
    defaultPaddingTop: dbTpl.defaultPaddingTop ?? undefined,
    defaultPaddingRight: dbTpl.defaultPaddingRight ?? undefined,
    defaultPaddingLeft: dbTpl.defaultPaddingLeft ?? undefined,
    photo: {
      x: dbTpl.photoX,
      y: dbTpl.photoY,
      width: dbTpl.photoWidth,
      height: dbTpl.photoHeight,
      cornerRadius: dbTpl.photoCornerRadius ?? 8,
      showBorder: dbTpl.photoShowBorder !== false,
    },
    frame,
    thumbnailUrl: dbTpl.thumbnailUrl || undefined,
    bgType: dbTpl.frameBgType || "solid",
    bgGradientColors: dbTpl.frameBgGradientColors || [],
    bgConfig,
    language: dbTpl.language || "English",
    detailsLayout: dbTpl.detailsLayout || "classic",
    titleShape: dbTpl.titleShape || "simple",
    mantraSignPlacement: dbTpl.mantraSignPlacement || "both",
    mantraSignVertical: dbTpl.mantraSignVertical || "top",
    rawInput: sanitizeRawInput(dbTpl.rawInput),
    religion: dbTpl.religion || "Hindu",
    isPremium: dbTpl.isPremium === true,
    isDefault: dbTpl.isDefault === true,
    price: dbTpl.price ?? null,
    discountPrice: dbTpl.discountPrice ?? null,
    currency: dbTpl.currency || "INR",
    pdfPrice: dbTpl.pdfPrice ?? null,
    pdfDiscountPrice: dbTpl.pdfDiscountPrice ?? null,
    docxPrice: dbTpl.docxPrice ?? null,
    docxDiscountPrice: dbTpl.docxDiscountPrice ?? null,
    jpgPrice: dbTpl.jpgPrice ?? null,
    jpgDiscountPrice: dbTpl.jpgDiscountPrice ?? null,
    pngPrice: dbTpl.pngPrice ?? null,
    pngDiscountPrice: dbTpl.pngDiscountPrice ?? null,
    comboPrice: dbTpl.comboPrice ?? null,
    comboDiscountPrice: dbTpl.comboDiscountPrice ?? null,
    fontSize: dbTpl.defaultFontSize ?? undefined,
  });
}

export function sanitizeRawInput(rawInput) {
  if (!rawInput) return undefined;
  try {
    const raw = typeof rawInput === "string" ? JSON.parse(rawInput) : JSON.parse(JSON.stringify(rawInput));
    if (raw && typeof raw === "object") {
      const clean = {};
      if ('title' in raw) clean.title = raw.title;
      if ('mantra' in raw) clean.mantra = raw.mantra;
      if ('language' in raw) clean.language = raw.language;
      if ('community' in raw) clean.community = raw.community;
      if ('personalTitle' in raw) clean.personalTitle = raw.personalTitle;
      if ('educationTitle' in raw) clean.educationTitle = raw.educationTitle;
      if ('familyTitle' in raw) clean.familyTitle = raw.familyTitle;
      if ('contactTitle' in raw) clean.contactTitle = raw.contactTitle;
      if ('headerSymbol' in raw) clean.headerSymbol = raw.headerSymbol;
      return clean;
    }
    return raw;
  } catch (e) {
    console.error("Error sanitizing rawInput:", e);
    return undefined;
  }
}
