import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.post("/generate", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        if (!cv || !jd) {
            return res.status(400).json({
                error: "CV and Job Description are required."
            });
        }

        const prompt = `
You are AskScoobyAI, an expert interview preparation assistant for job seekers.

Your job is to create highly tailored interview preparation using:
1. The candidate's CV
2. The job description
3. Optional company information

Return ONLY valid JSON. Do not include markdown, explanations, headings outside JSON, or code fences.

The JSON must follow this exact structure:
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
    "title": "1. string",
    "situation": "string",
    "task": "string",
    "action": "string",
    "result": "string"
  },
  {
    "title": "2. string",
    "situation": "string",
    "task": "string",
    "action": "string",
    "result": "string"
  },
  {
    "title": "3. string",
    "situation": "string",
    "task": "string",
    "action": "string",
    "result": "string"
  },
  {
    "title": "4. string",
    "situation": "string",
    "task": "string",
    "action": "string",
    "result": "string"
  },
  {
    "title": "5. string",
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
- Each interview question must be realistic for this specific role.
- Each interview answer must be 4–8 lines (approximately 80–140 words).
- Each answer must be written in the first person, as if the candidate is answering in an interview.
- Each answer must be practical and easy to speak out loud.
- Each answer should reference the candidate's actual experience, tools, industries, or achievements from the CV where possible.
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If the CV lacks evidence for something, phrase it carefully, for example: "I would approach this by..."
- Each answer must end with a natural, confident closing sentence.
- The closing sentence should summarise the approach or reinforce relevance to the role.
- Vary the closing sentence across answers using styles such as:
  - “That’s how I approached it in that scenario.”
  - “That worked well in practice.”
  - “That’s been my experience so far.”
  - “I’d apply the same approach here as well.”
  - “That’s something I’d look to bring into this role.”
  - Or similar natural variations that fit the context.

- Generate exactly 5 questionsForInterviewer.
- The questionsForInterviewer should be thoughtful, professional, and specific to the role or company where possible.

- Generate exactly 5 STAR answers.
- Each STAR answer must be clearly numbered from 1 to 5.
- Include the number in the "title" field (e.g. "1. Delivering a reporting improvement").
- Each STAR answer must be detailed and interview-ready.
- Each STAR answer should be 180–250 words in total.
- For each STAR answer, Situation, Task, Action, and Result should each be written in full sentences.
- The Action section should be the most detailed part.
- STAR examples must be based on the strongest relevant experience from the CV.
- The "starAnswers" array must contain exactly 5 objects. Do not return fewer than 5.

- Generate exactly 5 cvImprovementPreview bullet points.
- CV improvement points must explain how the CV could be better aligned to this job description.
- Suggest practical improvements such as clearer achievements, stronger wording, measurable outcomes, and keyword alignment.

- Cover letter must be concise, professional, and tailored to the role.
- Cover letter should be around 180–250 words.

- If company is missing, use "Company not provided".
- Keep language clear, confident, and suitable for a professional interview.

CV:
${cv}

Job Description:
${jd}

Company:
${company || "Company not provided"}
`;

        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: prompt
        });

        let text = response.output_text.trim();

        if (text.startsWith("```json")) {
            text = text.replace("```json", "").replace("```", "").trim();
        } else if (text.startsWith("```")) {
            text = text.replace("```", "").replace("```", "").trim();
        }

        console.log("AI raw response:", text);

        const parsed = JSON.parse(text);

        res.json(parsed);

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({
            error: "Failed to generate interview prep."
        });
    }
});

app.listen(port, () => {
    console.log(`AskScoobyAI API running at http://localhost:${port}`);
});