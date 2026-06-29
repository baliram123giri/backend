import fs from "fs";
import path from "path";
import crypto from "crypto";

// Resolve client public uploads path relative to backend
const CLIENT_UPLOADS_DIR = path.resolve("d:/AstroAppBiodata/client/public/uploads");

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

  // Server-side Size Validation: Max 10MB
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File size exceeds 10MB limit");
  }

  const filename = crypto.randomUUID();
  let extension = "";

  if (mimeType === "image/svg+xml" || mimeType.includes("svg")) {
    extension = ".svg";
  } else if (mimeType.includes("png")) {
    extension = ".png";
  } else if (mimeType.includes("webp")) {
    extension = ".webp";
  } else {
    extension = ".jpg";
  }

  const finalFilename = `${filename}${extension}`;
  const destFilePath = path.join(destFolder, finalFilename);

  // Write file to filesystem
  fs.writeFileSync(destFilePath, buffer);
  
  // Return the public URL relative to Astro server root
  return `/uploads/${normalizedSubFolder}/${finalFilename}`;
}

/**
 * Deletes a file from the uploads folder
 * @param {string} url The public URL of the file to delete
 */
export async function deleteFromVPS(url) {
  if (!url || !url.startsWith("/uploads/")) return;

  try {
    const relativePath = url.substring("/uploads/".length);
    const filePath = path.join(CLIENT_UPLOADS_DIR, ...relativePath.split("/"));

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(`Failed to delete file from uploads (${url}):`, error);
  }
}
