import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

function trimInputs(cv, jd) {
    return {
        trimmedCV: cv.slice(0, 5000),
        trimmedJD: jd.slice(0, 7000)
    };
}

function getCompany(company) {
    return company && company.trim() ? company.trim() : "";
}

/**
 * 🔒 CRITICAL VALIDATION FUNCTION
 */
function isMeaningfulText(text, minLength = 150) {
    if (!text) return false;

    const cleaned = text.trim();

    if (cleaned.length < minLength) return false;

    const words = cleaned.split(/\s+/);
    if (words.length < 20) return false;

    const uniqueChars = new Set(cleaned.toLowerCase());
    if (uniqueChars.size < 10) return false;

    return true;
}

async function callOpenAI(prompt, maxTokens = 2500) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
            {
                role: "user",
                content: prompt
            }
        ],
        temperature: 0.3,
        max_tokens: maxTokens
    });

    return JSON.parse(completion.choices[0].message.content.trim());
}

/**
 * =========================
 * INTERVIEW
 * =========================
 */
app.post("/generate-interview", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        // 🔒 VALIDATION
        if (!isMeaningfulText(cv, 150) || !isMeaningfulText(jd, 200)) {
            return res.status(400).json({
                error: "Input too short or not meaningful. Please provide a valid CV and job description."
            });
        }

        const { trimmedCV, trimmedJD } = trimInputs(cv, jd);
        const providedCompany = getCompany(company);

        const prompt = `
You are AskScoobyAI, an expert interview preparation assistant.

Return ONLY valid JSON. Do not include markdown or code fences.

Use this exact JSON structure:
{
  "jobTitle": "string",
  "companyName": "string",
  "interviewQuestions": [
    {
      "question": "string",
      "answer": "string"
    }
  ],
  "questionsForInterviewer": ["string"]
}

Rules:
- Extract the jobTitle from the job description.
- Generate exactly 10 interviewQuestions.
- Each question must be realistic for this specific job.
- Each answer should be 4-8 lines, approximately 70-110 words.
- Each answer must be written in the first person.
- Each answer should reference the candidate's CV where possible.
- Every interview answer must end with one short, natural closing line.
- The closing line must be relevant to the answer and role.
- Use a different closing line for each answer.
- Closing lines should sound similar in style to:
  "That’s how I approached it in that scenario."
  "That worked well in practice."
  "That’s been my experience so far."
  "I’d apply the same approach here as well."
  "That’s something I’d look to bring into this role."
- Do not reuse the same closing line across multiple answers.
- Generate exactly 5 questionsForInterviewer.
- Questions for the interviewer should be thoughtful and relevant.
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If company is provided, use it naturally.
- If company is not provided, leave companyName as an empty string.

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 2800);
        parsed.companyName = providedCompany;

        res.json(parsed);

    } catch (error) {
        console.error("Interview Generation Error:", error);

        res.status(500).json({
            error: error.message || "Failed to generate interview questions."
        });
    }
});

/**
 * =========================
 * STAR
 * =========================
 */
app.post("/generate-star", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        // 🔒 VALIDATION
        if (!isMeaningfulText(cv, 150) || !isMeaningfulText(jd, 200)) {
            return res.status(400).json({
                error: "Input too short or not meaningful. Please provide a valid CV and job description."
            });
        }

        const { trimmedCV, trimmedJD } = trimInputs(cv, jd);
        const providedCompany = getCompany(company);
        const hasCompany = providedCompany.length > 1;

        const companyInfoRules = hasCompany
            ? `
Company Info rules:
- Generate a factual companyInfo mini-profile of at least 6 sentences.
- companyInfo must only describe the company itself.
- Do not give interview advice in companyInfo.
- Do not mention the candidate in companyInfo.
- Do not use phrases like "in your interview", "you can reference", "align your experience", "highlight", or "demonstrates".
- Focus on what the company does, its sector, customers or stakeholders, products/services, mission, operating model, and relevant business priorities.
- If the exact company cannot be confidently described, say that detailed public company information is limited.
`
            : `
Company Info rules:
- companyInfo must be an empty string.
- Do not generate a company profile.
- Do not mention that the company name was not provided.
`;

        const prompt = `
You are AskScoobyAI, an expert interview preparation assistant.

Return ONLY valid JSON.

Use this exact JSON structure:
{
  "jobTitle": "string",
  "companyName": "string",
  "companyInfo": "string",
  "starAnswers": [
    {
      "title": "string",
      "situation": "string",
      "task": "string",
      "action": "string",
      "result": "string"
    }
  ]
}

Rules:
- Generate exactly 3 STAR answers.
- Use real CV evidence where possible.
- Do not invent details.

${companyInfoRules}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 2600);

        parsed.companyName = providedCompany;
        parsed.companyInfo = hasCompany ? (parsed.companyInfo || "") : "";
        parsed.starAnswers = Array.isArray(parsed.starAnswers)
            ? parsed.starAnswers.slice(0, 3)
            : [];

        res.json(parsed);

    } catch (error) {
        console.error("STAR Generation Error:", error);

        res.status(500).json({
            error: error.message || "Failed to generate STAR answers."
        });
    }
});

/**
 * =========================
 * DOCS
 * =========================
 */
app.post("/generate-docs", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        // 🔒 VALIDATION
        if (!isMeaningfulText(cv, 150) || !isMeaningfulText(jd, 200)) {
            return res.status(400).json({
                error: "Input too short or not meaningful. Please provide a valid CV and job description."
            });
        }

        const { trimmedCV, trimmedJD } = trimInputs(cv, jd);
        const providedCompany = getCompany(company);

        const prompt = `
You are AskScoobyAI, an expert career assistant.

Return ONLY valid JSON.

Use this structure:
{
  "jobTitle": "string",
  "companyName": "string",
  "coverLetter": "string",
  "cvImprovementPreview": ["string"]
}

Rules:
- Generate 1 tailored cover letter (120–160 words)
- Generate exactly 5 CV improvement points
- Do not invent achievements

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 1800);
        parsed.companyName = providedCompany;

        res.json(parsed);

    } catch (error) {
        console.error("Docs Generation Error:", error);

        res.status(500).json({
            error: error.message || "Failed to generate cover letter and CV tips."
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`AskScoobyAI API running on port ${PORT}`);
});
