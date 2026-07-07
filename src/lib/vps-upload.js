import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";

// Resolve client public uploads path relative to backend
const CLIENT_UPLOADS_DIR = process.platform === "win32"
  ? path.resolve("d:/AstroAppBiodata/client/public/uploads")
  : "/var/www/biodata99/uploads/biodata";

/**
 * Converts a legacy relative URL starting with /uploads/ to a full CDN path
 * @param {string} url 
 * @returns {string}
 */
export function convertToFullUrl(url) {
  if (typeof url === "string") {
    if (url.startsWith("/uploads/")) {
      return `https://img.biodata99.com/biodata${url.substring("/uploads".length)}`;
    }
    if (url.startsWith("https://img.biodata99.com/matrimonial/")) {
      return `https://img.biodata99.com/biodata${url.substring("https://img.biodata99.com/matrimonial".length)}`;
    }
  }
  return url;
}

/**
 * Uploads a base64 encoded image to the client public directory.
 * 
 * @param {string} fileStr Base64 encoded string or raw SVG string
 * @param {string} subFolder Subfolder inside the uploads directory (e.g. "hero_slides")
 * @returns {Promise<string>} The public URL of the uploaded image
 */
export async function uploadToVPS(fileStr, subFolder) {
  if (!fileStr) {
    throw new Error("No file content provided");
  }

  // Create destination directory
  const normalizedSubFolder = subFolder.replace(/\\/g, "/");
  const destFolder = path.join(CLIENT_UPLOADS_DIR, ...normalizedSubFolder.split("/"));
  
  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  let mimeType = "";
  let buffer;

  // Parse the input string (base64 data URI, raw SVG, or raw base64)
  if (fileStr.startsWith("data:")) {
    const commaIndex = fileStr.indexOf(",");
    if (commaIndex === -1) {
      throw new Error("Invalid data URI format");
    }
    const header = fileStr.substring(0, commaIndex);
    const data = fileStr.substring(commaIndex + 1);
    
    const mimeMatch = header.match(/data:([^;]+)/);
    mimeType = mimeMatch ? mimeMatch[1] : "";
    
    if (header.includes(";base64")) {
      buffer = Buffer.from(data, "base64");
    } else {
      buffer = Buffer.from(decodeURIComponent(data));
    }
  } else if (fileStr.trim().startsWith("<svg") || fileStr.includes("http://www.w3.org/2000/svg")) {
    mimeType = "image/svg+xml";
    buffer = Buffer.from(fileStr, "utf-8");
  } else {
    // Attempt to parse as raw base64
    buffer = Buffer.from(fileStr, "base64");
    mimeType = "image/png"; // default fallback
  }

  // Find first non-whitespace byte to check if it begins as an XML/SVG document
  let firstNonWhitespaceByte = 0;
  if (buffer) {
    for (let i = 0; i < Math.min(buffer.length, 100); i++) {
      const byte = buffer[i];
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
        firstNonWhitespaceByte = byte;
        break;
      }
    }
  }

  const isSvg =
    firstNonWhitespaceByte === 0x3C && // Must start with '<' (ASCII 60)
    (mimeType === "image/svg+xml" ||
      mimeType.includes("svg") ||
      (buffer && /<svg/i.test(buffer.toString("utf-8"))));

  if (isSvg) {
    mimeType = "image/svg+xml";
  }

  // Server-side Size Validation: Max 10MB
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File size exceeds 10MB limit");
  }

  // Convert raster images to compressed WebP
  if (!isSvg) {
    try {
      buffer = await sharp(buffer)
        .webp({ quality: 80 })
        .toBuffer();
      mimeType = "image/webp";
    } catch (err) {
      console.error("Failed to compress image with sharp, falling back to original:", err);
    }
  }

  const filename = crypto.randomUUID();
  let extension = "";

  if (isSvg) {
    extension = ".svg";
  } else if (mimeType.includes("webp")) {
    extension = ".webp";
  } else if (mimeType.includes("png")) {
    extension = ".png";
  } else {
    extension = ".jpg";
  }

  const finalFilename = `${filename}${extension}`;
  const destFilePath = path.join(destFolder, finalFilename);

  // Write file to filesystem
  fs.writeFileSync(destFilePath, buffer);
  
  // Return the full public URL with domain
  return `https://img.biodata99.com/biodata/${normalizedSubFolder}/${finalFilename}`;
}

/**
 * Deletes a file from the uploads folder
 * @param {string} url The public URL of the file to delete
 */
export async function deleteFromVPS(url) {
  if (!url) return;

  try {
    let relativePath = "";
    if (url.startsWith("/uploads/")) {
      relativePath = url.substring("/uploads/".length);
    } else if (url.startsWith("https://img.biodata99.com/biodata/")) {
      relativePath = url.substring("https://img.biodata99.com/biodata/".length);
    } else if (url.startsWith("https://img.biodata99.com/matrimonial/")) {
      relativePath = url.substring("https://img.biodata99.com/matrimonial/".length);
    } else {
      return; // Not a VPS uploaded image
    }

    const filePath = path.join(CLIENT_UPLOADS_DIR, ...relativePath.split("/"));

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(`Failed to delete file from uploads (${url}):`, error);
  }
}
