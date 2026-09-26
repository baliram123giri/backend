import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderDesignPageToSvg } from './svgRenderer.js';
import { generateVectorPdfFromDesign } from './vectorPdfGenerator.js';
import { DESIGN_A4_WIDTH, DESIGN_A4_HEIGHT } from './coordinates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Representative Comprehensive Test Document
export const REPRESENTATIVE_TEST_DOCUMENT = {
  version: 1,
  metadata: {
    title: 'Representative Vector Test Biodata',
    language: 'Marathi',
    templateId: 'test-template-v1',
  },
  pages: [
    {
      pageIndex: 0,
      width: DESIGN_A4_WIDTH,
      height: DESIGN_A4_HEIGHT,
      // 1. A4 Page & 4. Gradient Background
      background: {
        type: 'linearGradient',
        angle: 180,
        stops: [
          { offset: 0, color: '#fff9f5' },
          { offset: 0.5, color: '#ffffff' },
          { offset: 1, color: '#fff3ea' },
        ],
      },
      elements: [
        // 3. Outer Decorative Border (Multiple Layers, Layer 1)
        {
          id: 'outer-border',
          type: 'rect',
          x: 20,
          y: 20,
          width: 555,
          height: 802,
          fill: { color: 'none' },
          stroke: '#C9A84C',
          strokeWidth: 2,
          cornerRadius: 12,
          zIndex: 1,
        },
        // Inner Fine Border
        {
          id: 'inner-border',
          type: 'rect',
          x: 26,
          y: 26,
          width: 543,
          height: 790,
          fill: { color: 'none' },
          stroke: '#9B1B30',
          strokeWidth: 0.75,
          cornerRadius: 8,
          zIndex: 2,
        },

        // 14. Decorative Corner Circles (Layer 3)
        {
          id: 'corner-circle-tl',
          type: 'circle',
          x: 24,
          y: 24,
          radius: 6,
          fill: { color: '#C9A84C' },
          zIndex: 3,
        },
        {
          id: 'corner-circle-tr',
          type: 'circle',
          x: 559,
          y: 24,
          radius: 6,
          fill: { color: '#C9A84C' },
          zIndex: 3,
        },
        {
          id: 'corner-circle-bl',
          type: 'circle',
          x: 24,
          y: 806,
          radius: 6,
          fill: { color: '#C9A84C' },
          zIndex: 3,
        },
        {
          id: 'corner-circle-br',
          type: 'circle',
          x: 559,
          y: 806,
          radius: 6,
          fill: { color: '#C9A84C' },
          zIndex: 3,
        },

        // 15. Rotation & 16. Opacity: Rotated Decorative Accent Diamond
        {
          id: 'accent-diamond-top',
          type: 'rect',
          x: 290,
          y: 42,
          width: 14,
          height: 14,
          rotation: 45,
          opacity: 0.85,
          fill: {
            type: 'linearGradient',
            angle: 45,
            stops: [
              { offset: 0, color: '#9B1B30' },
              { offset: 1, color: '#C9A84C' },
            ],
          },
          zIndex: 4,
        },

        // 7. Hindi Mantra Text (Normal Header Text)
        {
          id: 'hindi-mantra',
          type: 'text',
          x: 35,
          y: 65,
          width: 525,
          height: 25,
          align: 'center',
          text: '॥ श्री गणेशाय नमः ॥',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 16,
          fontWeight: 700,
          fill: { color: '#9B1B30' },
          zIndex: 5,
        },

        // 5. Gradient Text & 6. Marathi Text & 9. Custom Font: Main Heading
        {
          id: 'marathi-title-gradient',
          type: 'text',
          x: 35,
          y: 95,
          width: 525,
          height: 45,
          align: 'center',
          text: 'मराठी विवाह बायोडाटा',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 32,
          fontWeight: 700,
          // True vector gradient fill!
          fill: {
            type: 'linearGradient',
            angle: 90,
            stops: [
              { offset: 0, color: '#8B0000' },
              { offset: 0.5, color: '#D4AF37' },
              { offset: 1, color: '#8B0000' },
            ],
          },
          zIndex: 6,
        },

        // 8. English Subtitle Text
        {
          id: 'english-subtitle',
          type: 'text',
          x: 35,
          y: 142,
          width: 525,
          height: 20,
          align: 'center',
          text: 'MATRIMONIAL BIODATA',
          fontFamily: 'Cinzel',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 2,
          fill: { color: '#666666' },
          zIndex: 7,
        },

        // 13. Decorative Section Heading Pill (Rectangle with rounded corners & gradient)
        {
          id: 'section-1-pill',
          type: 'rect',
          x: 45,
          y: 180,
          width: 220,
          height: 28,
          cornerRadius: 14,
          fill: {
            type: 'linearGradient',
            angle: 90,
            stops: [
              { offset: 0, color: '#9B1B30' },
              { offset: 1, color: '#7A1424' },
            ],
          },
          zIndex: 8,
        },
        {
          id: 'section-1-title',
          type: 'text',
          x: 55,
          y: 186,
          width: 200,
          height: 20,
          align: 'center',
          text: 'वैयक्तिक माहिती (Personal Details)',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 700,
          fill: { color: '#ffffff' },
          zIndex: 9,
        },

        // Biodata Fields (Normal Text, Searchable & Selectable)
        {
          id: 'field-1-label',
          type: 'text',
          x: 55,
          y: 225,
          width: 130,
          height: 18,
          align: 'left',
          text: 'पूर्ण नाव (Full Name):',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 10,
        },
        {
          id: 'field-1-value',
          type: 'text',
          x: 200,
          y: 225,
          width: 200,
          height: 18,
          align: 'left',
          text: 'आदित्य रमेश जोशी',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 400,
          fill: { color: '#222222' },
          zIndex: 10,
        },

        {
          id: 'field-2-label',
          type: 'text',
          x: 55,
          y: 252,
          width: 130,
          height: 18,
          align: 'left',
          text: 'जन्म तारीख (DOB):',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 10,
        },
        {
          id: 'field-2-value',
          type: 'text',
          x: 200,
          y: 252,
          width: 200,
          height: 18,
          align: 'left',
          text: '१५ ऑक्टोबर १९९६ (10:15 AM)',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 400,
          fill: { color: '#222222' },
          zIndex: 10,
        },

        {
          id: 'field-3-label',
          type: 'text',
          x: 55,
          y: 279,
          width: 130,
          height: 18,
          align: 'left',
          text: 'जात / धर्म (Religion & Caste):',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 10,
        },
        {
          id: 'field-3-value',
          type: 'text',
          x: 200,
          y: 279,
          width: 200,
          height: 18,
          align: 'left',
          text: 'हिंदू - देशस्थ ब्राह्मण',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 11,
          fontWeight: 400,
          fill: { color: '#222222' },
          zIndex: 10,
        },

        // 11. Profile Image & 12. Rounded Image Clipping
        {
          id: 'user-photo',
          type: 'image',
          src: 'client/public/favicon.png', // valid local sample image
          x: 420,
          y: 180,
          width: 110,
          height: 140,
          cornerRadius: 10,
          borderColor: '#C9A84C',
          borderWidth: 2,
          zIndex: 11,
        },

        // Family Section Heading with Underline
        {
          id: 'section-2-title',
          type: 'text',
          x: 55,
          y: 340,
          width: 300,
          height: 24,
          align: 'left',
          text: 'पारिवारिक माहिती (Family Information)',
          fontFamily: 'Noto Sans Devanagari',
          fontSize: 13,
          fontWeight: 700,
          fill: { color: '#9B1B30' },
          zIndex: 12,
        },
        {
          id: 'section-2-underline',
          type: 'rect',
          x: 55,
          y: 366,
          width: 475,
          height: 2,
          fill: {
            type: 'linearGradient',
            angle: 90,
            stops: [
              { offset: 0, color: '#9B1B30' },
              { offset: 0.7, color: '#C9A84C' },
              { offset: 1, color: '#ffffff' },
            ],
          },
          zIndex: 12,
        },

        // Regional Script Text Demonstrating Ligatures & Shaping
        {
          id: 'regional-heading',
          type: 'text',
          x: 55,
          y: 400,
          width: 475,
          height: 20,
          align: 'left',
          text: 'Regional Complex Scripts Test:',
          fontFamily: 'Poppins',
          fontSize: 11,
          fontWeight: 700,
          fill: { color: '#666666' },
          zIndex: 13,
        },
        {
          id: 'script-tamil',
          type: 'text',
          x: 55,
          y: 430,
          width: 475,
          height: 20,
          align: 'left',
          text: 'Tamil: திருமண பயோடேட்டா (திருமண தகவல்)',
          fontFamily: 'Noto Sans Tamil',
          fontSize: 12,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 14,
        },
        {
          id: 'script-kannada',
          type: 'text',
          x: 55,
          y: 460,
          width: 475,
          height: 20,
          align: 'left',
          text: 'Kannada: ಕನ್ನಡ ವಿವಾಹ ಬಯೋಡೇಟಾ',
          fontFamily: 'Noto Sans Kannada',
          fontSize: 12,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 14,
        },
        {
          id: 'script-telugu',
          type: 'text',
          x: 55,
          y: 490,
          width: 475,
          height: 20,
          align: 'left',
          text: 'Telugu: వివాహ బయోడేటా (శుభమస్తు)',
          fontFamily: 'Noto Sans Telugu',
          fontSize: 12,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 14,
        },
        {
          id: 'script-bengali',
          type: 'text',
          x: 55,
          y: 520,
          width: 475,
          height: 20,
          align: 'left',
          text: 'Bengali: বিবাহের বায়োডাটা',
          fontFamily: 'Noto Sans Bengali',
          fontSize: 12,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 14,
        },
        {
          id: 'script-gujarati',
          type: 'text',
          x: 55,
          y: 550,
          width: 475,
          height: 20,
          align: 'left',
          text: 'Gujarati: લગ્ન બાયોડેટા (શુભ લગ્ન)',
          fontFamily: 'Noto Sans Gujarati',
          fontSize: 12,
          fontWeight: 700,
          fill: { color: '#333333' },
          zIndex: 14,
        },

        // Footer Text
        {
          id: 'footer-note',
          type: 'text',
          x: 35,
          y: 775,
          width: 525,
          height: 15,
          align: 'center',
          text: 'Biodata99 • True Vector PDF Architecture • Pure Mathematical Coordinates',
          fontFamily: 'Poppins',
          fontSize: 8.5,
          fontWeight: 500,
          fill: { color: '#999999' },
          zIndex: 15,
        },
      ],
    },
  ],
};

async function runTest() {
  console.log('=== RUNNING BIODATA99 VECTOR EXPORT TEST ===');
  const t0 = Date.now();

  // 1. Render to SVG
  const svgMarkup = renderDesignPageToSvg(REPRESENTATIVE_TEST_DOCUMENT.pages[0]);
  const svgTime = Date.now() - t0;
  console.log(`[Test] SVG generated in ${svgTime}ms (${svgMarkup.length} characters)`);

  const outSvgPath = path.resolve(__dirname, '../../test_output.svg');
  fs.writeFileSync(outSvgPath, svgMarkup, 'utf8');
  console.log(`[Test] SVG written to: ${outSvgPath}`);

  // 2. Render to Vector PDF
  const t1 = Date.now();
  const pdfBuffer = await generateVectorPdfFromDesign(REPRESENTATIVE_TEST_DOCUMENT);
  const pdfTime = Date.now() - t1;
  console.log(`[Test] Vector PDF generated in ${pdfTime}ms (${pdfBuffer.length} bytes)`);

  const outPdfPath = path.resolve(__dirname, '../../test_output.pdf');
  fs.writeFileSync(outPdfPath, pdfBuffer);
  console.log(`[Test] PDF written to: ${outPdfPath}`);

  const totalTime = Date.now() - t0;
  console.log(`=== TEST COMPLETED SUCCESSFULLY IN ${totalTime}ms ===`);
}

runTest().catch((err) => {
  console.error('[Test Error]:', err);
  process.exit(1);
});
