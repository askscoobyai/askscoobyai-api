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
- Example style: "What interests you most about working at ${providedCompany}, and how do you see yourself contributing to the team?"
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
- The questions must follow the exact order below.
- Do not add category labels inside the question text.
- Do not number the questions inside the question text.
- Questions 1-11 must not ask why the candidate wants to work for the company.
- Only question 12 may be company-related, and only if a company name is provided.

Question structure:
1. Question 1 must be a warm self-introduction question.
   - Use this exact question or a very close natural variant:
     "Thanks for joining us today. Could you start by telling me a little about yourself and your background?"
   - Do not use the phrase "Please introduce yourself."
   - The answer should be a concise professional introduction tailored to the CV and job description.

2. Questions 2-4 must be CV-specific technical or experience-based questions.
   - The word "CV" must appear naturally in every question from question 2 to question 4.
   - These questions should reference tools, systems, projects, responsibilities, achievements, or previous experience clearly mentioned in the CV.
   - Example style: "Your CV mentions using Python in your previous work. Can you talk me through how you used it day to day?"
   - Only mention a company, role, tool, or project if it clearly appears in the CV.
   - If the CV mentions a tool but not a company, phrase it generally.

3. Questions 5-8 must be genuinely technical or system-specific questions based on the job description.
   - These must not be behavioural questions.
   - These must test practical technical understanding, system knowledge, troubleshooting, trade-offs, methods, workflows, tools, data, platforms, compliance processes, reporting processes, software, or operational systems mentioned in the job description.
   - Start these questions with direct technical phrasing such as:
     - "How would you configure..."
     - "How would you troubleshoot..."
     - "What checks would you perform..."
     - "How would you use [tool/system/process] to..."
     - "What steps would you take to..."
     - "How would you ensure accuracy when..."
   - Avoid behavioural phrasing such as:
     - "Tell me about a time..."
     - "Describe a situation..."
     - "How do you handle stakeholders..."
     - "How do you manage conflict..."
   - Identify the key tools, systems, platforms, software, databases, reporting tools, cloud services, programming languages, frameworks, methodologies, regulations, processes, and technical skills in the job description.
   - Prioritise the most prominent systems/tools/processes based on frequency, requirements, responsibilities, and essential criteria.
   - For highly technical roles, make these questions deeply practical and technical.
   - For less technical roles, make these questions process-specific, system-specific, compliance-specific, reporting-specific, or workflow-specific.

4. Questions 9-11 must be behavioural, stakeholder, communication, prioritisation, or generic role-fit questions.
   - These should not be company culture questions.
   - These should still relate to the role and job description.
   - They should test how the candidate handles realistic workplace situations.

${companyQuestionInstruction}

Technical question rules:
- If the role is technical or systems-heavy, at least 5 of the interview questions should be technical, systems-specific, or technical-experience based.
- Questions 5-8 must be the most technical/system-specific questions in the list.
- The most prominent systems/tools/processes in the job description should receive more attention.
- Technical questions should test practical understanding, trade-offs, troubleshooting, and real workplace usage.
- Avoid generic questions like "What is SQL?" unless the role is entry-level.
- Do not invent tools, systems, employers, dates, certifications, figures, or achievements.

Answer rules:
- Each answer should be 4-8 lines, approximately 70-110 words.
- Each answer must be written in the first person.
- For the self-introduction answer, summarise the candidate's relevant background, strengths, and fit for the role.
- For CV-specific questions, answer using the candidate's CV evidence where possible.
- For questions 5-8, give a technical, practical answer with concrete steps, checks, systems, methods, trade-offs, or troubleshooting logic.
- For behavioural questions, use a practical workplace example or a careful transferable approach based on the CV.
- For the company culture question, explain why the candidate is interested in the company and connect it to the role, the job description, or the company's apparent work.
- If the CV does not provide enough evidence, phrase carefully and avoid pretending the candidate has done something.
- Every interview answer must end with one short, natural closing line.
- Use a different closing line for each answer.
- Do not reuse the same closing line across multiple answers.

Other rules:
- Generate exactly 5 questionsForInterviewer.
- Questions for the interviewer should be thoughtful and relevant.
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

        const parsed = await callOpenAI(prompt, 4600);

        parsed.companyName = providedCompany;

        ensureInterviewQuestionStructure(parsed, hasCompany, providedCompany);

        if (Array.isArray(parsed.questionsForInterviewer)) {
            parsed.questionsForInterviewer = parsed.questionsForInterviewer.slice(0, 5);
        } else {
            parsed.questionsForInterviewer = [];
        }

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

STAR answer focus:
- For technical or systems-heavy roles, STAR answers should be technically oriented.
- Identify the key systems, tools, platforms, software, databases, reporting tools, cloud services, programming languages, frameworks, methodologies, and technical responsibilities in the job description.
- Prioritise STAR examples that show practical application of those systems or similar experience from the CV.
- Good STAR themes include:
  - improving a dashboard or report,
  - writing or optimising SQL,
  - building or improving a data pipeline,
  - using BI tools such as Tableau or Power BI,
  - using dbt or transformation workflows,
  - improving data quality,
  - automating a manual process,
  - solving a technical issue,
  - translating stakeholder requirements into technical outputs,
  - using CRM, ERP, cloud, analytics, or operational systems.
- Do not make the STAR answers generic unless the role itself is non-technical.
- If the CV mentions relevant tools or systems, use those as the basis for the STAR answers.
- If the job description mentions systems not found in the CV, do not pretend the candidate has used them. Instead, use transferable experience and careful wording.
- Each STAR title should clearly show the technical or role-specific theme.

${weakInputInstruction}

${companyInfoRules}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callOpenAI(prompt, 3000);

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
- Do not invent employers, dates, qualifications, certifications, figures, or achievements.
- If company is provided, use it naturally in the cover letter.
- If company is not provided, write the cover letter without naming a company.
- companyName must be the exact company value provided, or an empty string if not provided.

CV improvement rules:
- Each CV improvement point must be specific and actionable.
- Each point should identify which previous role, project, section, skill, or experience from the CV should be updated.
- Each point should explain which job requirement it connects to.
- Each point should say exactly what to add, clarify, or strengthen.
- Where possible, include an example rewritten bullet.
- Do not give generic advice like "add more metrics" unless you also specify where and how.
- If the CV does not clearly show role names or company names, refer to the relevant experience more generally, e.g. "your analytics experience", "your dashboarding work", or "your Python project".
- Prioritise technical systems, tools, platforms, reporting responsibilities, stakeholder requirements, and role-critical skills mentioned in the job description.
- Make the advice practical enough that the user can copy it into their CV after editing.

Expected style for cvImprovementPreview:
- "Update your [specific role/experience/section] to better reflect [job requirement]. Add detail on [tool/process/impact]. Example rewrite: '[example bullet]'."
- "In your [specific previous role/experience], strengthen the bullet about [activity] by mentioning [tool/system/stakeholder/outcome], because this role asks for [job requirement]."

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

        if (Array.isArray(parsed.cvImprovementPreview)) {
            parsed.cvImprovementPreview = parsed.cvImprovementPreview.slice(0, 5);
        } else {
            parsed.cvImprovementPreview = [];
        }

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
