require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/generate", async (req, res) => {
  try {
    const { cv, jd, company } = req.body;

    if (!cv || !jd) {
      return res.status(400).json({
        error: "Missing CV or Job Description."
      });
    }

    const trimmedCV = cv.slice(0, 5000);
    const trimmedJD = jd.slice(0, 7000);

    const prompt = `
You are AskScoobyAI, an expert interview preparation assistant.

Return ONLY valid JSON. Do not include markdown or code fences.

Use this exact structure:
{
  "jobTitle": "string",
  "companyName": "string",
  "interviewQuestions": [
    {
      "question": "string",
      "answer": "string"
    }
  ],
  "questionsForInterviewer": ["string"],
  "starAnswers": [
    {
      "title": "string",
      "situation": "string",
      "task": "string",
      "action": "string",
      "result": "string"
    }
  ],
  "coverLetter": "string",
  "cvImprovementPreview": ["string"]
}

Rules:
- Generate exactly 10 interviewQuestions.
- Each answer should be 4-8 lines, approximately 70-110 words.
- Each answer must be written in the first person.
- Each answer should end with a natural confident closing sentence.
- Generate exactly 5 questionsForInterviewer.
- Generate exactly 3 STAR answers.
- The "starAnswers" array must contain exactly 3 objects.
- Each STAR answer should be detailed but concise, around 140-190 words in total.
- Generate exactly 5 cvImprovementPreview bullet points.
- Cover letter should be concise, around 120-160 words.
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If evidence is missing from the CV, phrase carefully instead of inventing.
- If company is missing, use "Company not provided".

Company:
${company || "Company not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.4,
      max_tokens: 3500
    });

    const text = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(text);

    res.json(parsed);

  } catch (error) {
    console.error("Backend Error:", error);

    res.status(500).json({
      error: error.message || "Failed to generate interview prep."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AskScoobyAI API running on port ${PORT}`);
});
