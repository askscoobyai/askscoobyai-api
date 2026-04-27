require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.post("/generate", async (req, res) => {
    try {
        const { cv, jd, company } = req.body;

        if (!cv || !jd) {
            return res.status(400).json({
                error: "Missing CV or Job Description"
            });
        }

        // ✅ Trim inputs for speed
        const trimmedCV = cv.slice(0, 5000);
        const trimmedJD = jd.slice(0, 7000);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: `
You are an expert interview coach.

Using the CV and job description below, generate structured interview preparation.

Company: ${company || "Not specified"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}

Provide:

1. 5 likely interview questions tailored to the role  
2. Strong sample answers based on the CV  
3. 2 STAR method examples  
4. A concise tailored cover letter  

Keep responses structured and practical.
`
                }
            ],
            temperature: 0.7
        });

        const result = completion.choices[0].message.content;

        res.json({ result });

    } catch (error) {
        console.error("Error generating response:", error);

        res.status(500).json({
            error: error.message || "Something went wrong"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`AskScoobyAI API running on port ${PORT}`);
});
