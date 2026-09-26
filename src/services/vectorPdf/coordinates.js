/**
 * Centralized Canonical Coordinate System & Transformations for Biodata99.
 * 
 * Canonical Design Space: 595 × 842 (A4 at 72 DPI nominal)
 * Physical A4: 210mm × 297mm
 * Exact PDF points: 595.2756 × 841.8898 pt (1 inch = 72 pt = 25.4 mm)
 */

export const DESIGN_A4_WIDTH = 595;
export const DESIGN_A4_HEIGHT = 842;

export const PDF_A4_WIDTH_PT = 595.2756;
export const PDF_A4_HEIGHT_PT = 841.8898;

export const SCALE_TO_PDF_X = PDF_A4_WIDTH_PT / DESIGN_A4_WIDTH;   // ~1.00046319
export const SCALE_TO_PDF_Y = PDF_A4_HEIGHT_PT / DESIGN_A4_HEIGHT; // ~0.99986912

/**
 * Converts a design coordinate (x, y) to exact PDF points.
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
export function toPdfPoint(x, y) {
  return {
    x: Number((x * SCALE_TO_PDF_X).toFixed(4)),
    y: Number((y * SCALE_TO_PDF_Y).toFixed(4)),
  };
}

/**
 * Converts design width & height to exact PDF points.
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number }}
 */
export function toPdfDimensions(width, height) {
  return {
    width: Number((width * SCALE_TO_PDF_X).toFixed(4)),
    height: Number((height * SCALE_TO_PDF_Y).toFixed(4)),
  };
}
