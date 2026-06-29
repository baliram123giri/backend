import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { translations, translateDynamicOption } from '../constants/translations.js';
import { defaultBiodataValues } from '../constants/default-biodata.js';

const SYSTEM_PROMPT = `You are a matrimonial biodata generator for Indian families. Generate realistic, culturally appropriate dummy biodata data in JSON format.

Return ONLY valid JSON (no markdown, no code blocks, no explanation) matching this exact schema:
{
  "mantra": "string (Sanskrit mantra like ॥ श्री गणेशाय नमः ॥)",
  "title": "string (like Biodata, Vivah Parichay, Marriage Biodata)",
  "personalDetails": {
    "fullName": "string (Indian full name)",
    "dateOfBirth": "YYYY-MM-DD",
    "timeOfBirth": "hh:mm (Period) format like 10:30 (Morning) or 06:15 (Evening)",
    "placeOfBirth": "City, State",
    "height": "string (Height from allowed options)",
    "maritalStatus": "string (Marital Status from allowed options)",
    "bloodGroup": "string (Blood Group from allowed options)",
    "complexion": "string (Complexion from allowed options)",
    "religion": "the religion passed in the request",
    "caste": "string",
    "gotra": "string (Gotra from allowed options)",
    "rashi": "string (Rashi from allowed options)",
    "nakshatra": "string (Nakshatra from allowed options)",
    "manglik": "string (Manglik from allowed options)"
  },
  "educationDetails": {
    "education": "string (Highest Education from allowed options)",
    "college": "Full college or university name in India",
    "occupation": "string (Occupation from allowed options)",
    "annualIncome": "string (e.g. ₹ 8 LPA, 12 Lakhs PA, etc.)",
    "companyName": "Well-known Indian or multinational company name"
  },
  "familyDetails": {
    "fatherName": "Full Indian name",
    "fatherOccupation": "Occupation string",
    "motherName": "Full Indian name",
    "motherOccupation": "Occupation string",
    "totalBrothers": "0 or 1 or 2",
    "totalSisters": "0 or 1 or 2",
    "nativePlace": "Village or Town, State"
  },
  "contactDetails": {
    "mobileNumber": "+919876543210 (starts with +91 followed directly by 10 digits, with NO spaces, format: +91XXXXXXXXXX)",
    "email": "firstname.lastname@gmail.com (lowercase email, strictly using @gmail.com, with NO dots directly before the @ sign, e.g. sneha.gupta17@gmail.com)",
    "residentialAddress": "Street/Colony, City, PIN Code"
  }
}

IMPORTANT RULES:
- Generate DIFFERENT data each call (vary names, cities, professions randomly)
- Person must be 23-35 years old (dateOfBirth must reflect this)
- All field values must be strings
- Return ONLY the JSON object with no extra text`;

const selectFieldConfig = [
  { section: 'personalDetails', id: 'height' },
  { section: 'personalDetails', id: 'maritalStatus' },
  { section: 'personalDetails', id: 'bloodGroup' },
  { section: 'personalDetails', id: 'complexion' },
  { section: 'personalDetails', id: 'religion' },
  { section: 'personalDetails', id: 'gotra' },
  { section: 'personalDetails', id: 'rashi' },
  { section: 'personalDetails', id: 'nakshatra' },
  { section: 'personalDetails', id: 'manglik' },
  { section: 'educationDetails', id: 'education' },
  { section: 'educationDetails', id: 'occupation' },
  { section: 'familyDetails', id: 'fatherOccupation' },
  { section: 'familyDetails', id: 'motherOccupation' }
];

function getOptionsForField(sectionName, fieldId) {
  const section = defaultBiodataValues[sectionName];
  if (!section) return [];
  const field = section.find(f => f.id === fieldId);
  return field?.options || [];
}

export async function generateAIBiodata({ gender = 'male', religion = 'Hindu', language = 'English' }) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not configured in environment variables');
  }

  const t = translations[language] || translations['English'];

  const allowedValuesInstructions = selectFieldConfig.map(cfg => {
    const englishOptions = getOptionsForField(cfg.section, cfg.id);
    const translatedOptions = englishOptions.map(opt => translateDynamicOption(opt, t, cfg.id));
    return `- ${cfg.id}: MUST be exactly one of: [${translatedOptions.join(', ')}]`;
  }).join('\n');

  const PERIODS = ['Early Morning', 'Morning', 'Afternoon', 'Evening', 'Night'];
  const translatedPeriods = PERIODS.map(p => t[p] || p);

  const languageInstruction = language !== 'English'
    ? `IMPORTANT: The user has selected the language '${language}'. You MUST generate ALL text field values (such as mantra, title, fullName, placeOfBirth, college, companyName, fatherName, fatherOccupation, motherName, motherOccupation, nativePlace, and residentialAddress) in the '${language}' language (using the correct native script of that language, e.g., Devanagari script for Hindi/Marathi, Bengali script for Bengali, etc. where appropriate).

For all dropdown/select fields, you MUST select the value from the following allowed values list translated into '${language}':
${allowedValuesInstructions}

For timeOfBirth, use format 'hh:mm (Period)' where Period is translated to '${language}' from one of: [${translatedPeriods.join(', ')}]. For example, in Hindi: '10:30 (सुबह)' or '06:15 (शाम)'.`
    : `For select/dropdown fields, you MUST choose from these allowed values:
${allowedValuesInstructions}
For timeOfBirth, use format 'hh:mm (Period)' where Period is one of: [${PERIODS.join(', ')}].`;

  const googleProvider = createGoogleGenerativeAI({ apiKey });

  const prompt = `${SYSTEM_PROMPT}\n\n${languageInstruction}\n\nGenerate biodata for a ${gender} person from ${religion} religion. Make all details realistic, authentic, and varied. Output ONLY valid JSON.`;

  const { text } = await generateText({
    model: googleProvider('gemini-2.5-flash'),
    prompt,
  });

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);

  selectFieldConfig.forEach(cfg => {
    const section = parsed[cfg.section];
    if (!section) return;
    const genVal = section[cfg.id];
    if (typeof genVal === 'string' && genVal) {
      const englishOptions = getOptionsForField(cfg.section, cfg.id);
      const match = englishOptions.find(opt => {
        const trans = translateDynamicOption(opt, t, cfg.id).trim().toLowerCase();
        const eng = opt.trim().toLowerCase();
        const gen = genVal.trim().toLowerCase();
        return trans === gen || eng === gen;
      });
      if (match) {
        section[cfg.id] = match;
      } else {
        if (englishOptions.includes('Other')) {
          section[cfg.id] = 'Other';
        }
      }
    }
  });

  if (parsed.personalDetails?.timeOfBirth) {
    const timeVal = parsed.personalDetails.timeOfBirth;
    const parts = timeVal.match(/(\d{1,2}):(\d{2})\s*(?:\((.*)\))?/i);
    if (parts) {
      const hh = parts[1];
      const mm = parts[2];
      const genPeriod = parts[3];
      if (genPeriod) {
        const matchedPeriod = PERIODS.find(p => {
          const trans = t[p] || p;
          return trans.toLowerCase() === genPeriod.trim().toLowerCase() || p.toLowerCase() === genPeriod.trim().toLowerCase();
        });
        parsed.personalDetails.timeOfBirth = `${hh}:${mm} (${matchedPeriod || 'Morning'})`;
      }
    }
  }

  // Post-process / sanitize email and mobileNumber formatting
  if (parsed.contactDetails) {
    if (parsed.contactDetails.mobileNumber) {
      let num = String(parsed.contactDetails.mobileNumber).replace(/\s+/g, '');
      const digits = num.replace(/\D/g, '');
      if (digits.length >= 10) {
        const last10 = digits.slice(-10);
        parsed.contactDetails.mobileNumber = `+91${last10}`;
      } else {
        parsed.contactDetails.mobileNumber = `+91${digits.padEnd(10, '0')}`;
      }
    }

    if (parsed.contactDetails.email) {
      let email = String(parsed.contactDetails.email).trim().toLowerCase();
      email = email.replace(/gamil\.com/g, 'gmail.com');
      email = email.replace(/\.@/g, '@'); // Fix trailing dots immediately before @
      parsed.contactDetails.email = email;
    }
  }

  return parsed;
}
