import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

dotenv.config();

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(helmet());

app.use(cors({
    origin(origin, callback) {
        console.log("Incoming origin:", origin);
        console.log("Allowed origins:", allowedOrigins);

        if (!origin) {
            callback(null, true);
            return;
        }

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        console.error("Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-token"]
}));

app.use(express.json({ limit: "1mb" }));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Too many requests. Please wait a few minutes and try again."
    }
});

app.use(apiLimiter);

function requireApiToken(req, res, next) {
    const expectedToken = process.env.EXTENSION_API_TOKEN;

    if (!expectedToken) {
        return res.status(500).json({
            error: "Server security token is not configured."
        });
    }

    const providedToken = req.get("x-api-token");

    if (!providedToken || providedToken !== expectedToken) {
        return res.status(401).json({
            error: "Unauthorised request."
        });
    }

    next();
}

app.use(
    [
        "/generate-interview",
        "/generate-star",
        "/generate-docs",
        "/generate-practice-feedback",
        "/generate-question-audio"
    ],
    requireApiToken
);
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
function stripHtmlAndDangerousText(value) {
    return String(value || "")
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
        .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
        .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
        .replace(/<embed[\s\S]*?>[\s\S]*?<\/embed>/gi, "")
        .replace(/<[^>]*>/g, "")
        .replace(/javascript:/gi, "")
        .replace(/data:/gi, "")
        .replace(/on\w+\s*=/gi, "")
        .trim();
}

function cleanText(text) {
    return stripHtmlAndDangerousText(text)
        .trim()
        .replace(/\s+/g, " ");
}

function normaliseForComparison(text) {
    return cleanText(text)
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function getSimilarityScore(a, b) {
    const first = normaliseForComparison(a);
    const second = normaliseForComparison(b);

    if (!first || !second) return 0;

    const firstWords = first.split(" ").filter(Boolean);
    const secondWords = second.split(" ").filter(Boolean);

    if (!firstWords.length || !secondWords.length) return 0;

    const firstSet = new Set(firstWords);
    const secondSet = new Set(secondWords);

    let overlap = 0;

    firstSet.forEach((word) => {
        if (secondSet.has(word)) {
            overlap += 1;
        }
    });

    const union = new Set([...firstSet, ...secondSet]).size;

    return union ? overlap / union : 0;
}

function trimInputs(cv, jd) {
    return {
        trimmedCV: cleanText(cv).slice(0, 5000),
        trimmedJD: cleanText(jd).slice(0, 7000)
    };
}

function getCompany(company) {
    return cleanText(company).slice(0, 120);
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

function validateBodyShape(req) {
    const { cv, jd, company } = req.body || {};

    if (typeof cv !== "string" || typeof jd !== "string") {
        return {
            valid: false,
            error: "Invalid request format."
        };
    }

    if (company !== undefined && typeof company !== "string") {
        return {
            valid: false,
            error: "Invalid company format."
        };
    }

    if (cv.length > 10000) {
        return {
            valid: false,
            error: "CV is too long. Please shorten it and try again."
        };
    }

    if (jd.length > 14000) {
        return {
            valid: false,
            error: "Job description is too long. Please shorten it and try again."
        };
    }

    if ((company || "").length > 200) {
        return {
            valid: false,
            error: "Company name is too long."
        };
    }

    return {
        valid: true
    };
}

function validateInputs(cv, jd) {
    const safeCV = cleanText(cv);
    const safeJD = cleanText(jd);

    if (isClearlyInvalidCV(safeCV)) {
        return {
            valid: false,
            error: "Please paste a valid CV before generating. A few full sentences or bullet points are needed."
        };
    }

    if (isClearlyInvalidJD(safeJD)) {
        return {
            valid: false,
            error: "Please paste a valid job description before generating. It should include role details, requirements, or responsibilities."
        };
    }

    return {
        valid: true,
        weak: isWeakInput(safeCV, safeJD)
    };
}

function validatePracticeBody(req) {
    const {
        question,
        expectedAnswer,
        transcript,
        contextType,
        cv,
        jd,
        company
    } = req.body || {};

    if (typeof transcript !== "string" || cleanText(transcript).length < 30) {
        return {
            valid: false,
            error: "Please record a longer answer before requesting feedback."
        };
    }

    const optionalFields = { question, expectedAnswer, contextType, cv, jd, company };

    for (const [key, value] of Object.entries(optionalFields)) {
        if (value !== undefined && typeof value !== "string") {
            return {
                valid: false,
                error: `Invalid ${key} format.`
            };
        }
    }

    if ((question || "").length > 1500) {
        return { valid: false, error: "Practice question is too long." };
    }

    if ((expectedAnswer || "").length > 4000) {
        return { valid: false, error: "Reference answer is too long." };
    }

    if ((transcript || "").length > 6000) {
        return { valid: false, error: "Practice transcript is too long." };
    }

    return { valid: true };
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
        temperature: 0.25,
        max_tokens: maxTokens
    });

    return JSON.parse(completion.choices[0].message.content.trim());
}

function buildFallbackIntroQuestion() {
    return {
        question: "Thanks for joining us today. Could you start by telling me a little about yourself and your background?",
        answer: "I would start by giving a concise overview of my background, focusing on the experience most relevant to this role. I would highlight the main skills, tools, and responsibilities from my CV that connect to the job description, then explain why this opportunity feels like a strong next step. I would keep the answer professional, clear, and tailored to the role rather than simply repeating my CV. That would help set the tone for the rest of the interview."
    };
}

function buildFallbackCVQuestion(index) {
    const questions = [
        {
            question: "Your CV mentions relevant experience for this role. Can you talk me through one example that best shows your technical or role-specific strengths?",
            answer: "I would choose an example from my CV that closely matches the requirements in the job description. I would explain the context, what I was responsible for, the tools or processes I used, and the outcome of the work. I would keep the answer grounded in what I have actually done, while making the link to this role clear. That would help show how my previous experience could transfer into this position."
        },
        {
            question: "Looking at your CV, which project or responsibility do you think is most relevant to this role, and why?",
            answer: "I would pick the project or responsibility from my CV that has the strongest connection to the job description. I would explain what made it relevant, what I contributed personally, and how it helped me build skills that would be useful in this role. I would avoid overclaiming and focus on the parts of the experience that are clearly supported by my CV. That’s the kind of experience I’d look to build on here."
        },
        {
            question: "Your CV shows a range of experience. Which technical or practical skill from your background would help you most in this role?",
            answer: "I would identify one technical or practical skill from my CV that aligns closely with the role requirements. I would explain how I have used that skill, what I learned from applying it, and how I would adapt it to the systems or responsibilities in this position. I would keep the answer specific and evidence-based. That’s something I’d aim to bring into this role from day one."
        }
    ];

    return questions[index] || questions[0];
}

function buildFallbackTechnicalQuestion(index) {
    const questions = [
        {
            question: "Based on the job description, how would you approach learning and working with the main systems, tools, or processes required in this role?",
            answer: "I would start by understanding how the main systems or tools are used in the team’s day-to-day work. I would look at existing documentation, review examples of good outputs, and ask focused questions to understand expectations and common issues. Once I understood the workflow, I would practise on real tasks and check my work carefully for accuracy and quality. That approach would help me become productive while reducing mistakes."
        },
        {
            question: "What technical checks would you carry out to make sure your work is accurate, reliable, and fit for purpose in this role?",
            answer: "I would check the input data, assumptions, calculations, logic, and final output before sharing anything with stakeholders. If the work involved systems, reports, analysis, or operational processes, I would compare results against known sources and investigate any unexpected differences. I would also document key steps so the work could be reviewed or repeated later. That’s how I would keep the work reliable and useful."
        },
        {
            question: "If a system, report, process, or technical output was not working as expected, how would you troubleshoot it?",
            answer: "I would break the issue down step by step rather than guessing. First, I would confirm what the expected result should be, then check the source inputs, configuration, logic, permissions, and recent changes. I would try to isolate where the issue starts and test one change at a time. If needed, I would involve the right colleague with a clear summary of what I had already checked. That would help solve the issue efficiently."
        },
        {
            question: "How would you balance speed and accuracy when delivering technical or system-based work under time pressure?",
            answer: "I would first clarify the deadline, the purpose of the work, and which parts are most critical. Then I would prioritise the core technical output, apply the most important quality checks, and communicate early if there were any risks or trade-offs. I would avoid rushing work that could lead to incorrect decisions, especially where accuracy matters. That’s how I would balance delivery pace with dependable results."
        }
    ];

    return questions[index] || questions[0];
}

function buildFallbackBehaviouralQuestion(index) {
    const questions = [
        {
            question: "Tell me about a time you had to manage competing priorities. How did you decide what to focus on first?",
            answer: "I would start by understanding the urgency, importance, and impact of each task. I would clarify deadlines where needed, identify dependencies, and focus first on the work that had the greatest business or stakeholder impact. I would also communicate clearly if timelines needed to be adjusted. That approach helps me stay organised while making sure the most important work is handled properly."
        },
        {
            question: "How do you communicate complex information to stakeholders who may not have the same technical background?",
            answer: "I try to understand what the stakeholder needs to know and avoid unnecessary technical detail. I would explain the key message first, then use simple language, examples, or visuals where helpful. If there are risks, assumptions, or limitations, I would make those clear as well. That helps ensure the information is useful, not just technically correct."
        },
        {
            question: "What kind of working environment helps you perform at your best?",
            answer: "I perform best in an environment where expectations are clear, communication is open, and people are focused on delivering good-quality work. I value having ownership of my responsibilities while also being able to ask questions and collaborate when needed. I also appreciate constructive feedback because it helps me improve. That kind of environment helps me do my best work consistently."
        }
    ];

    return questions[index] || questions[0];
}

function buildFallbackCompanyCultureQuestion(companyName) {
    return {
        question: `What interests you most about working at ${companyName}, and how do you see yourself contributing to the team?`,
        answer: `What interests me about ${companyName} is the opportunity to contribute in a role where my experience can be applied in a practical and meaningful way. From the job description, I can see there is a strong focus on delivering value, working with stakeholders, and using the right skills to solve real business problems. I’m looking for a role where I can keep developing while also making a clear contribution to the team. That’s something I’d be excited to bring into this role.`
    };
}

function isCompanyQuestion(item, companyName) {
    const question = cleanText(item?.question || "").toLowerCase();
    const company = cleanText(companyName).toLowerCase();

    return (
        question.includes("why do you want to work") ||
        question.includes("work here") ||
        question.includes("company culture") ||
        question.includes("interests you most about working") ||
        question.includes(company)
    );
}

function isQuestionObject(item) {
    return (
        item &&
        typeof item.question === "string" &&
        typeof item.answer === "string" &&
        cleanText(item.question) &&
        cleanText(item.answer)
    );
}

function ensureInterviewQuestionStructure(parsed, hasCompany, companyName) {
    const targetCount = hasCompany ? 12 : 11;
    const originalQuestions = Array.isArray(parsed.interviewQuestions)
        ? parsed.interviewQuestions.filter(isQuestionObject)
        : [];

    const nonCompanyQuestions = originalQuestions.filter((item) => !isCompanyQuestion(item, companyName));
    const companyQuestions = originalQuestions.filter((item) => isCompanyQuestion(item, companyName));

    const finalQuestions = [];

    finalQuestions[0] = nonCompanyQuestions[0] || buildFallbackIntroQuestion();

    for (let i = 1; i <= 3; i++) {
        finalQuestions[i] = nonCompanyQuestions[i] || buildFallbackCVQuestion(i - 1);
    }

    for (let i = 4; i <= 7; i++) {
        finalQuestions[i] = nonCompanyQuestions[i] || buildFallbackTechnicalQuestion(i - 4);
    }

    for (let i = 8; i <= 10; i++) {
        finalQuestions[i] = nonCompanyQuestions[i] || buildFallbackBehaviouralQuestion(i - 8);
    }

    if (hasCompany) {
        finalQuestions[11] = companyQuestions[0] || buildFallbackCompanyCultureQuestion(companyName);
    }

    parsed.interviewQuestions = finalQuestions.slice(0, targetCount);

    return parsed;
}

function buildFallbackStarAnswer(index) {
    const answers = [
        {
            title: "Taking ownership of a role-relevant challenge",
            situation: "In one of my previous roles or projects, I was involved in work that required me to understand a problem clearly and contribute to a practical solution.",
            task: "My task was to use the information available, understand what mattered most, and support a reliable outcome without overcomplicating the work.",
            action: "I broke the work into clear steps, checked the available information carefully, asked focused questions where needed, and made sure my contribution aligned with the wider objective.",
            result: "The result was a more structured and dependable piece of work that supported the needs of the team or stakeholder. It also helped me strengthen the way I approach similar challenges.",
            whatNotToSay: "Avoid making the example sound vague or claiming ownership of results that are not supported by the CV.",
            stealThisPhrase: "I took ownership of clarifying the problem first, so the solution was focused on the right outcome."
        },
        {
            title: "Improving a process or output",
            situation: "In a previous role or project, I noticed an opportunity to improve the way a task, report, workflow, or process was being handled.",
            task: "My task was to make the work more accurate, efficient, or easier to use while keeping the needs of the role or stakeholder in mind.",
            action: "I reviewed the current approach, identified where errors or delays could occur, and made practical improvements based on the tools, data, or process available.",
            result: "The improvement helped make the output clearer, more reliable, or easier to repeat. It also showed that I can look beyond completion and think about quality and long-term usefulness.",
            whatNotToSay: "Do not imply that the previous process was poor because of other people. Focus on improvement, not blame.",
            stealThisPhrase: "I improved the process by focusing on accuracy, repeatability, and the end user’s needs."
        },
        {
            title: "Working with stakeholders or team members",
            situation: "In a previous role or project, I worked with others to understand expectations, clarify requirements, or deliver something useful.",
            task: "My task was to communicate clearly, understand what was needed, and make sure my work supported the wider objective.",
            action: "I listened carefully, asked clarifying questions, kept communication practical, and translated the requirements into clear actions that I could follow through on.",
            result: "This helped avoid misunderstandings and made the final output more aligned with what was needed. It also strengthened my ability to work effectively with different people.",
            whatNotToSay: "Avoid saying stakeholders were difficult or unreasonable. Show how you handled communication professionally.",
            stealThisPhrase: "I aligned stakeholders by clarifying expectations early and keeping communication focused on the outcome."
        },
        {
            title: "Solving a technical or practical problem",
            situation: "In one of my previous experiences, I faced a technical or practical issue that needed a structured approach rather than a quick guess.",
            task: "My task was to understand the cause of the issue, identify possible solutions, and help move the work forward with minimal disruption.",
            action: "I checked the issue step by step, reviewed the source information or process, tested assumptions, and used a logical approach to narrow down the root cause.",
            result: "This helped resolve or reduce the issue and gave the team a clearer understanding of what had happened. It also reinforced the importance of careful troubleshooting.",
            whatNotToSay: "Do not suggest that you guessed your way through the issue. Emphasise a calm and structured approach.",
            stealThisPhrase: "I worked through the issue methodically, testing one assumption at a time until I found the root cause."
        },
        {
            title: "Adapting and learning quickly",
            situation: "In a previous role or project, I had to learn something new or adapt quickly to a new tool, process, requirement, or working environment.",
            task: "My task was to get up to speed quickly while still delivering work to a good standard.",
            action: "I focused on the most important parts first, used available resources, asked targeted questions, and applied what I learned directly to the task in front of me.",
            result: "This helped me become productive more quickly and gave me confidence in handling unfamiliar situations. It also showed that I can learn fast while staying focused on quality.",
            whatNotToSay: "Avoid saying you needed too much hand-holding. Show that you asked good questions and took responsibility for learning.",
            stealThisPhrase: "I focused my learning on what would help me deliver value fastest."
        }
    ];

    return answers[index] || answers[0];
}

function ensureStarAnswerStructure(parsed) {
    if (!Array.isArray(parsed.starAnswers)) {
        parsed.starAnswers = [];
    }

    parsed.starAnswers = parsed.starAnswers
        .filter((item) => item && typeof item === "object")
        .map((item, index) => ({
            title: cleanText(item.title) || buildFallbackStarAnswer(index).title,
            situation: cleanText(item.situation) || buildFallbackStarAnswer(index).situation,
            task: cleanText(item.task) || buildFallbackStarAnswer(index).task,
            action: cleanText(item.action) || buildFallbackStarAnswer(index).action,
            result: cleanText(item.result) || buildFallbackStarAnswer(index).result,
            whatNotToSay: cleanText(item.whatNotToSay) || buildFallbackStarAnswer(index).whatNotToSay,
            stealThisPhrase: cleanText(item.stealThisPhrase) || buildFallbackStarAnswer(index).stealThisPhrase
        }))
        .slice(0, 5);

    while (parsed.starAnswers.length < 5) {
        parsed.starAnswers.push(buildFallbackStarAnswer(parsed.starAnswers.length));
    }

    return parsed;
}

app.post("/generate-interview", async (req, res) => {
    try {
        const bodyValidation = validateBodyShape(req);

        if (!bodyValidation.valid) {
            return res.status(400).json({
                error: bodyValidation.error
            });
        }

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
        const targetInterviewQuestionCount = hasCompany ? 12 : 11;

        const weakInputInstruction = validation.weak
            ? `
Input detail note:
- The CV or job description is brief. Be extra careful not to invent details.
- Keep answers useful, but avoid claiming specific achievements, tools, employers, metrics, or responsibilities unless they appear in the CV or job description.
`
            : "";

        const companyQuestionInstruction = hasCompany
            ? `
Company culture question rule:
- Generate question 12 only as the company motivation or company culture question.
- Question 12 must naturally reference the company name "${providedCompany}".
- Do not include company motivation or company culture questions in questions 1-11.
`
            : `
Company culture question rule:
- Do not generate a company culture or company motivation question.
- Do not ask "Why do you want to work here?"
- Because no company name was provided, generate exactly 11 interviewQuestions only.
`;

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
- companyName must be the exact company value provided, or an empty string if not provided.
- Generate exactly ${targetInterviewQuestionCount} interviewQuestions.
- Questions must follow this order:
  1: warm self-introduction question.
  2-4: CV-specific technical or experience-based questions. The word "CV" must appear in each question.
  5-8: genuinely technical or system-specific questions based on the job description.
  9-11: behavioural, stakeholder, communication, prioritisation, or role-fit questions.
  12: company motivation/culture question only if company is provided.
- Question 1 should use a natural variant of: "Thanks for joining us today. Could you start by telling me a little about yourself and your background?"
- Do not use "Please introduce yourself."
- Do not add category labels.
- Do not number questions inside the question text.
- Questions 1-11 must not ask why the candidate wants to work for the company.
- Only question 12 may be company-related.

Technical question rules:
- Questions 5-8 must be practical and technical/system-specific.
- They must not be behavioural questions.
- They should test tools, systems, methods, workflows, troubleshooting, checks, data, platforms, software, compliance processes, reporting processes, or operational systems from the job description.
- Do not invent tools, systems, employers, dates, certifications, figures, or achievements.

Answer rules:
- Each answer should be 4-8 lines, approximately 70-110 words.
- Each answer must be written in the first person.
- For CV-specific questions, answer using CV evidence where possible.
- For questions 5-8, give concrete steps, checks, methods, trade-offs, or troubleshooting logic.
- For behavioural questions, use a practical workplace example or careful transferable approach.
- Every answer must end with one short, natural closing line.
- Do not reuse the same closing line.

Other rules:
- Generate exactly 5 questionsForInterviewer.
- Questions for the interviewer should be thoughtful and relevant.

${weakInputInstruction}

${companyQuestionInstruction}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 4600);

        parsed.companyName = providedCompany;

        ensureInterviewQuestionStructure(parsed, hasCompany, providedCompany);

        parsed.questionsForInterviewer = Array.isArray(parsed.questionsForInterviewer)
            ? parsed.questionsForInterviewer.slice(0, 5)
            : [];

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        res.json(parsed);

    } catch (error) {
        console.error("Interview Generation Error:", error);

        res.status(500).json({
            error: "Failed to generate interview questions."
        });
    }
});

app.post("/generate-star", async (req, res) => {
    try {
        const bodyValidation = validateBodyShape(req);

        if (!bodyValidation.valid) {
            return res.status(400).json({
                error: bodyValidation.error
            });
        }

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
- The CV or job description is brief. Do not invent details.
- STAR answers should stay grounded in what the CV actually says.
`
            : "";

        const companyInfoRules = hasCompany
            ? `
Company Info rules:
- Generate a factual companyInfo mini-profile of at least 6 sentences.
- companyInfo must only describe the company itself.
- Do not give interview advice in companyInfo.
- If exact company information is limited, say that detailed public company information is limited, then describe only what can be inferred from the job description.
`
            : `
Company Info rules:
- companyInfo must be an empty string.
`;

        const prompt = `
You are AskScoobyAI, an expert interview preparation and STAR answer coaching assistant.

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
      "result": "string",
      "whatNotToSay": "string",
      "stealThisPhrase": "string"
    }
  ]
}

Rules:
- Extract the jobTitle from the job description.
- Generate exactly 5 STAR answers.
- Each STAR answer should be realistic and interview-ready.
- Do not invent employers, dates, qualifications, certifications, figures, achievements, tools, systems, or metrics.
- Mine the CV for real roles, projects, responsibilities, tools, systems, achievements, and work examples.
- Use the job description to choose the most relevant CV examples.
- For technical roles, make most STAR answers technical, process-specific, or systems-specific.
- Align each result to what the job values: cost reduction, growth, accuracy, compliance, stakeholder service, efficiency, reliability, or scale.
- Infer seniority from the CV and job description.
- Senior candidates should show ownership, strategy, stakeholder alignment, risk management, mentoring, and impact.
- Junior candidates should show learning agility, reliability, execution, curiosity, and collaboration.
- Each STAR answer must include:
  - whatNotToSay: short warning, max 25 words.
  - stealThisPhrase: short interview-ready phrase, max 18 words.
- Use different stealThisPhrase wording for each answer.

${weakInputInstruction}

${companyInfoRules}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 5000);

        parsed.companyName = providedCompany;
        parsed.companyInfo = hasCompany ? (parsed.companyInfo || "") : "";

        ensureStarAnswerStructure(parsed);

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        res.json(parsed);

    } catch (error) {
        console.error("STAR Generation Error:", error);

        res.status(500).json({
            error: "Failed to generate STAR answers."
        });
    }
});

app.post("/generate-docs", async (req, res) => {
    try {
        const bodyValidation = validateBodyShape(req);

        if (!bodyValidation.valid) {
            return res.status(400).json({
                error: bodyValidation.error
            });
        }

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
- The CV or job description is brief. Be careful not to invent details.
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
- Generate one concise tailored cover letter around 120-160 words.
- Generate exactly 5 cvImprovementPreview bullet points.
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If company is provided, use it naturally.
- If company is not provided, write without naming a company.
- CV improvement points must be specific, actionable, and connected to job requirements.
- Where possible, include an example rewritten bullet.

${weakInputInstruction}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 2400);

        parsed.companyName = providedCompany;
        parsed.cvImprovementPreview = Array.isArray(parsed.cvImprovementPreview)
            ? parsed.cvImprovementPreview.slice(0, 5)
            : [];

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        res.json(parsed);

    } catch (error) {
        console.error("Docs Generation Error:", error);

        res.status(500).json({
            error: "Failed to generate cover letter and CV tips."
        });
    }
});

app.post("/generate-question-audio", async (req, res) => {
    try {
        const question =
            cleanText(req.body?.question).slice(0, 1200);

        if (!question || question.length < 10) {
            return res.status(400).json({
                error: "A valid interview question is required."
            });
        }

        const audio = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            input: question,
            format: "mp3"
        });

        const buffer = Buffer.from(
            await audio.arrayBuffer()
        );

        res.set({
            "Content-Type": "audio/mpeg",
            "Content-Length": buffer.length,
            "Cache-Control": "no-store"
        });

        res.send(buffer);

    } catch (error) {
        console.error(
            "Question Audio Error:",
            error
        );

        res.status(500).json({
            error:
                "Failed to generate interview question audio."
        });
    }
});
app.post("/generate-practice-feedback", async (req, res) => {
    try {
        const validation = validatePracticeBody(req);

        if (!validation.valid) {
            return res.status(400).json({
                error: validation.error
            });
        }

        const {
            question,
            expectedAnswer,
            transcript,
            contextType,
            cv,
            jd,
            company
        } = req.body;

        const safeQuestion = cleanText(question).slice(0, 1000);
        const safeExpectedAnswer = cleanText(expectedAnswer).slice(0, 3000);
        const safeTranscript = cleanText(transcript).slice(0, 5000);
        const safeContextType = cleanText(contextType).slice(0, 50);
        const safeCompany = getCompany(company);
        const { trimmedCV, trimmedJD } = trimInputs(cv || "", jd || "");

        const similarityScore = getSimilarityScore(safeTranscript, safeExpectedAnswer);
        const isVerySimilarToReference = similarityScore >= 0.72;

        const prompt = `
You are AskScoobyAI, an expert interview delivery coach.

Return ONLY valid JSON. Do not include markdown or code fences.

Use this exact JSON structure:
{
  "overallScore": 0,
  "summaryFeedback": "string",
  "strengths": ["string"],
  "improvements": ["string"],
  "structureFeedback": "string",
  "technicalDepthFeedback": "string",
  "deliveryFeedback": "string",
  "improvedAnswer": "string"
}

Context:
- Practice type: ${safeContextType || "interview"}
- Company: ${safeCompany || "Not provided"}
- Similarity between spoken transcript and provided reference answer: ${Math.round(similarityScore * 100)}%
- Is the transcript very similar to the reference answer? ${isVerySimilarToReference ? "Yes" : "No"}

Question or STAR prompt:
${safeQuestion}

Reference answer or STAR example generated by AskScoobyAI:
${safeExpectedAnswer}

Candidate spoken answer transcript:
${safeTranscript}

CV:
${trimmedCV}

Job Description:
${trimmedJD}

Feedback philosophy:
- This feature evaluates how well the candidate delivered the provided answer out loud.
- Do not behave like a generic answer rewriter.
- If the transcript is very similar to the reference answer, assume the content is already strong unless there is a clear issue.
- In that case, focus feedback on delivery, clarity, confidence, pacing, conciseness, and sounding natural.
- Do not criticise the answer for lacking examples, structure, or technical depth if the candidate closely repeated the provided reference answer.
- Do not generate contradictory feedback that says the provided reference answer needs more content unless it is genuinely incomplete.
- The improvedAnswer field should be empty if the answer is already strong and no major content rewrite is needed.

Scoring rules:
- Score from 1 to 10.
- If the transcript is very similar to the reference answer and is understandable, the score should usually be 8 to 10.
- If it closely matches the reference but sounds slightly stiff, repetitive, or overlong, score 8 or 9 and give delivery tips.
- If it is incomplete, off-topic, very short, unclear, or missing major points, score lower.
- Be encouraging but honest.

Feedback rules:
- strengths must contain exactly 3 bullet points.
- improvements must contain exactly 3 bullet points.
- Improvements should be practical, supportive, and should not contradict the reference answer.
- Feedback tone must feel like an encouraging interview coach, not a harsh evaluator.
- Always acknowledge positives before suggesting refinements.
- Frame improvements as small coaching suggestions rather than mistakes or failures.
- Avoid overly critical, discouraging, or harsh wording.
- Never imply the candidate lacks intelligence, expertise, or technical ability purely because of delivery style, pacing, or pronunciation.
- Use supportive phrases such as:
  "would sound even stronger if..."
  "could become even clearer by..."
  "to make your point land more confidently..."
  "your answer already has strong content, and..."
- Avoid phrases such as:
  "difficult to gauge your expertise"
  "lacked depth"
  "poor delivery"
  "weak answer"
  "unclear technical ability"
- If this is an interview question, assess relevance, structure, confidence, role fit, and spoken delivery.
- If this is a STAR answer, assess Situation, Task, Action, Result clarity and spoken flow.
- For technical answers, assess whether the spoken answer communicated technical points clearly; do not demand extra technical examples when the transcript already matches the reference.
- deliveryFeedback should focus on confidence, clarity, pacing, natural delivery, and sounding conversational rather than overly rehearsed.
- Improvements should feel motivating and confidence-building so the user feels encouraged to practise again.
- If the transcript is already strong, improvements should be minor refinements rather than major criticisms.
- improvedAnswer should only be provided if the transcript is materially weaker than the reference answer.
- If no rewrite is needed, improvedAnswer must be an empty string.
- Do not ask the user to add specific examples, metrics, achievements, tools, or extra detail if the transcript closely follows the generated reference answer.
- If the reference answer itself is general, do not criticise the user for repeating it. Focus on delivery, confidence, pacing, and clarity instead.
- Technical depth feedback should only assess whether the user clearly communicated the technical content already present in the reference answer.
- Avoid phrases like "provide specific examples", "add more achievements", "include metrics", or "give more detail" when the user practised the generated answer closely.
- If more detail would genuinely help, phrase it gently as optional: "In a real interview, you could add one short example if you have one available."
`;

        const parsed = await callOpenAI(prompt, 2200);

        parsed.overallScore = Number(parsed.overallScore) || 0;
        parsed.strengths = Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3) : [];
        parsed.improvements = Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 3) : [];

        if (isVerySimilarToReference && parsed.overallScore < 8) {
            parsed.overallScore = 8;
        }

        if (isVerySimilarToReference) {
            parsed.improvedAnswer = "";
        }

        res.json(parsed);

    } catch (error) {
        console.error("Practice Feedback Error:", error);

        res.status(500).json({
            error: "Failed to generate practice feedback."
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`AskScoobyAI API running on port ${PORT}`);
});
