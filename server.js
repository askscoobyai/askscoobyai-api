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

function cleanText(text) {
    return (text || "").trim().replace(/\s+/g, " ");
}

function getWordCount(text) {
    return cleanText(text).split(/\s+/).filter(Boolean).length;
}

function hasEnoughVariety(text) {
    const cleaned = cleanText(text).toLowerCase();

    if (!cleaned) return false;

    const uniqueChars = new Set(cleaned.replace(/\s/g, ""));
    const words = cleaned.split(/\s+/).filter(Boolean);
    const uniqueWords = new Set(words);

    return uniqueChars.size >= 8 && uniqueWords.size >= 8;
}

function looksLikeJobDescription(text) {
    const lower = cleanText(text).toLowerCase();

    const jdKeywords = [
        "responsibilities",
        "requirements",
        "qualifications",
        "experience",
        "skills",
        "about the role",
        "about the job",
        "job description",
        "what you'll do",
        "what you’ll do",
        "we are looking for",
        "we're looking for",
        "you will",
        "role",
        "candidate",
        "team",
        "position"
    ];

    return jdKeywords.some((keyword) => lower.includes(keyword));
}

function isClearlyInvalidCV(text) {
    const cleaned = cleanText(text);

    if (cleaned.length < 80) return true;
    if (getWordCount(cleaned) < 12) return true;
    if (!hasEnoughVariety(cleaned)) return true;

    return false;
}

function isClearlyInvalidJD(text) {
    const cleaned = cleanText(text);

    if (cleaned.length < 120) return true;
    if (getWordCount(cleaned) < 18) return true;
    if (!hasEnoughVariety(cleaned)) return true;
    if (!looksLikeJobDescription(cleaned)) return true;

    return false;
}

function isWeakInput(cv, jd) {
    const cleanedCV = cleanText(cv);
    const cleanedJD = cleanText(jd);

    return (
        cleanedCV.length < 300 ||
        cleanedJD.length < 400 ||
        getWordCount(cleanedCV) < 45 ||
        getWordCount(cleanedJD) < 60
    );
}

function validateInputs(cv, jd) {
    if (isClearlyInvalidCV(cv)) {
        return {
            valid: false,
            error: "Please paste a valid CV before generating. A few full sentences or bullet points are needed."
        };
    }

    if (isClearlyInvalidJD(jd)) {
        return {
            valid: false,
            error: "Please paste a valid job description before generating. It should include role details, requirements, or responsibilities."
        };
    }

    return {
        valid: true,
        weak: isWeakInput(cv, jd)
    };
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

app.post("/generate-interview", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        const validation = validateInputs(cv, jd);

        if (!validation.valid) {
            return res.status(400).json({
                error: validation.error
            });
        }

        const { trimmedCV, trimmedJD } = trimInputs(cv, jd);
        const providedCompany = getCompany(company);

        const weakInputInstruction = validation.weak
            ? `
Input detail note:
- The CV or job description is brief. Be extra careful not to invent details.
- Keep answers useful, but avoid claiming specific achievements, tools, employers, metrics, or responsibilities unless they appear in the CV or job description.
`
            : "";

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

${weakInputInstruction}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 2800);
        parsed.companyName = providedCompany;

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        res.json(parsed);

    } catch (error) {
        console.error("Interview Generation Error:", error);

        res.status(500).json({
            error: error.message || "Failed to generate interview questions."
        });
    }
});

app.post("/generate-star", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        const validation = validateInputs(cv, jd);

        if (!validation.valid) {
            return res.status(400).json({
                error: validation.error
            });
        }

        const { trimmedCV, trimmedJD } = trimInputs(cv, jd);
        const providedCompany = getCompany(company);
        const hasCompany = providedCompany.length > 1;

        const weakInputInstruction = validation.weak
            ? `
Input detail note:
- The CV or job description is brief. Be extra careful not to invent details.
- STAR answers should stay grounded in what the CV actually says.
- If evidence is limited, phrase carefully using wording like "I would approach this by..." rather than inventing past achievements.
`
            : "";

        const companyInfoRules = hasCompany
            ? `
Company Info rules:
- Generate a factual companyInfo mini-profile of at least 6 sentences.
- companyInfo must only describe the company itself.
- Do not give interview advice in companyInfo.
- Do not mention the candidate in companyInfo.
- Do not use phrases like "in your interview", "you can reference", "align your experience", "highlight", or "demonstrates".
- Focus on what the company does, its sector, customers or stakeholders, products/services, mission, operating model, and relevant business priorities.
- If the exact company cannot be confidently described from the company name and job description, say that detailed public company information is limited, then describe only what can be inferred from the job description.
`
            : `
Company Info rules:
- companyInfo must be an empty string.
- Do not generate a company profile.
- Do not mention that the company name was not provided.
- Do not repeat any fallback message.
`;

        const prompt = `
You are AskScoobyAI, an expert interview preparation assistant.

Return ONLY valid JSON. Do not include markdown or code fences.

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
- Extract the jobTitle from the job description.
- Generate exactly 3 STAR answers.
- The starAnswers array must contain exactly 3 objects.
- Each STAR answer should be detailed but concise, around 140-190 words in total.
- STAR examples must be based on the strongest relevant experience from the CV.
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If evidence is missing from the CV, phrase carefully instead of inventing.
- companyName must be the exact company value provided, or an empty string if not provided.

${weakInputInstruction}

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

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        res.json(parsed);

    } catch (error) {
        console.error("STAR Generation Error:", error);

        res.status(500).json({
            error: error.message || "Failed to generate STAR answers."
        });
    }
});

app.post("/generate-docs", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        const validation = validateInputs(cv, jd);

        if (!validation.valid) {
            return res.status(400).json({
                error: validation.error
            });
        }

        const { trimmedCV, trimmedJD } = trimInputs(cv, jd);
        const providedCompany = getCompany(company);

        const weakInputInstruction = validation.weak
            ? `
Input detail note:
- The CV or job description is brief. Be extra careful not to invent details.
- Keep the cover letter general where needed, and only mention specific achievements if they appear in the CV.
`
            : "";

        const prompt = `
You are AskScoobyAI, an expert career assistant.

Return ONLY valid JSON. Do not include markdown or code fences.

Use this exact JSON structure:
{
  "jobTitle": "string",
  "companyName": "string",
  "coverLetter": "string",
  "cvImprovementPreview": ["string"]
}

Rules:
- Extract the jobTitle from the job description.
- Generate one concise tailored cover letter.
- Cover letter should be around 120-160 words.
- Generate exactly 5 cvImprovementPreview bullet points.
- CV improvement points must explain how the CV could better align with this job description.
- Suggest practical improvements such as clearer achievements, stronger keywords, measurable outcomes, and role alignment.
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If company is provided, use it naturally in the cover letter.
- If company is not provided, write the cover letter without naming a company.
- companyName must be the exact company value provided, or an empty string if not provided.

${weakInputInstruction}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 1800);
        parsed.companyName = providedCompany;

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

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
