import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import crypto from "crypto";

dotenv.config();

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
    console.warn("⚠️ STRIPE_SECRET_KEY not set — payment routes will return 503 until it's configured. Everything else still works.");
}

// ── Supabase (service role — full access, never exposed to the extension) ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supabaseHeaders(extra = {}) {
    return {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation",
        ...extra
    };
}

async function supabaseFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
        ...options,
        headers: supabaseHeaders(options.headers)
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
        throw new Error(typeof json === "object" ? JSON.stringify(json) : String(json));
    }
    return json;
}

async function supabaseRpc(fnName, params) {
    return supabaseFetch(`/rest/v1/rpc/${fnName}`, {
        method: "POST",
        body: JSON.stringify(params)
    });
}

// ── Verify the caller's Google identity token, derive their email server-side ──
// (never trust an email the client sends in the body — always derive it from
// a token Google itself just vouched for)
async function verifyGoogleUser(req, res, next) {
    const authHeader = req.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: "Missing Google auth token." });
    }

    try {
        const googleRes = await fetch(
            `https://www.googleapis.com/oauth2/v2/userinfo?access_token=${encodeURIComponent(token)}`
        );
        if (!googleRes.ok) {
            return res.status(401).json({ error: "Invalid or expired Google token." });
        }
        const profile = await googleRes.json();
        if (!profile.email) {
            return res.status(401).json({ error: "Google token did not return an email." });
        }
        req.googleUser = {
            email: profile.email,
            name: profile.name || "",
            given: profile.given_name || "",
            photo: profile.picture || ""
        };
        next();
    } catch (err) {
        console.error("Google token verification error:", err);
        res.status(401).json({ error: "Could not verify Google token." });
    }
}

function getJobFingerprint(jd, company) {
    const normalized = String(jd || "").trim().toLowerCase() + "|" + String(company || "").trim().toLowerCase();
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 40);
}

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
    allowedHeaders: ["Content-Type", "x-api-token", "Authorization"]
}));

// ── Stripe webhook — must be registered BEFORE express.json() since it needs
// the raw, unparsed request body to verify Stripe's signature. Not behind
// requireApiToken/verifyGoogleUser — Stripe itself is the caller, authenticated
// via the webhook signature instead.
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Payments are not configured yet." });

    let event;

    try {
        const signature = req.get("stripe-signature");
        event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error("Stripe webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const email = session.metadata?.email;
        const credits = parseInt(session.metadata?.credits || "0", 10);

        if (email && credits > 0) {
            try {
                await supabaseRpc("add_credits", {
                    p_email: email,
                    p_amount: credits,
                    p_type: "stripe_purchase",
                    p_stripe_session_id: session.id
                });
                console.log(`Stripe: added ${credits} credits to ${email} (session ${session.id})`);
            } catch (err) {
                console.error("Stripe webhook: failed to add credits:", err);
                // Still return 200 below — Stripe will retry on non-2xx, but the
                // failure here is on our Supabase side, not something a retry
                // fixes automatically. Logged for manual follow-up.
            }
        }
    }

    res.json({ received: true });
});

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

// These three cost a credit, so we need to know WHO is calling — verified
// against Google, never trusted from the request body.
app.use(["/generate-interview", "/generate-star", "/generate-docs"], verifyGoogleUser);

// Practice feedback doesn't cost a credit, but we still need to know who's
// practicing so we can save their score history for My Progress.
app.use(["/generate-practice-feedback"], verifyGoogleUser);
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 60000
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

// claude-haiku-4-5 — fast, for interview Q&A and STAR answers
// claude-sonnet-4-6 — quality, for cover letter and practice feedback
async function callClaude(prompt, maxTokens = 2500, model = "claude-haiku-4-5-20251001") {
    const response = await anthropic.messages.create({
        model: model,
        max_tokens: maxTokens,
        temperature: 0.25,
        messages: [
            {
                role: "user",
                content: prompt
            }
        ]
    });

    const text = response.content[0].text.trim();
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    return JSON.parse(cleaned);
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

        // ── Atomic credit charge — 1 credit unlocks all 3 sections for this
        // exact job. Charged once here; the other two routes see the same
        // fingerprint already charged and proceed for free.
        const jobFingerprint = getJobFingerprint(trimmedJD, providedCompany);
        const chargeRows = await supabaseRpc("charge_credit_for_job", {
            p_email: req.googleUser.email,
            p_job_fingerprint: jobFingerprint
        });
        const charge = Array.isArray(chargeRows) ? chargeRows[0] : chargeRows;

        if (!charge || (!charge.charged && !charge.already_unlocked)) {
            return res.status(402).json({
                error: "No credits remaining. Please buy more credits to continue.",
                noCredits: true
            });
        }

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
- Question 1 (self-introduction) must be 60-70 words maximum. It should be punchy, confident and naturally conversational — not a CV recitation.
- For CV-specific questions, answer using CV evidence where possible. Reference specific employers, tools, and outcomes from the CV.
- For questions 5-8, give concrete steps, checks, methods, trade-offs, or troubleshooting logic. Where the CV mentions specific tools (e.g. Databricks, Snowflake, Power BI, Alteryx), reference them directly in the answer rather than giving a generic response.
- For behavioural questions, use a practical workplace example grounded in the CV. Name the employer and context where possible.
- Where the CV includes quantified results (percentages, time savings, scale), use them. Where it does not, express results in relative terms (e.g. "reduced from monthly to weekly", "cut development time by approximately a third").
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

        const parsed = await callClaude(prompt, 3200);

        parsed.companyName = providedCompany;

        ensureInterviewQuestionStructure(parsed, hasCompany, providedCompany);

        parsed.questionsForInterviewer = Array.isArray(parsed.questionsForInterviewer)
            ? parsed.questionsForInterviewer.slice(0, 5)
            : [];

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        parsed.creditsRemaining = charge.credits;

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

        // ── Atomic credit charge — same job-fingerprint scheme as /generate-interview.
        const jobFingerprint = getJobFingerprint(trimmedJD, providedCompany);
        const chargeRows = await supabaseRpc("charge_credit_for_job", {
            p_email: req.googleUser.email,
            p_job_fingerprint: jobFingerprint
        });
        const charge = Array.isArray(chargeRows) ? chargeRows[0] : chargeRows;

        if (!charge || (!charge.charged && !charge.already_unlocked)) {
            return res.status(402).json({
                error: "No credits remaining. Please buy more credits to continue.",
                noCredits: true
            });
        }

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

Result rules:
- Where the CV includes specific figures or percentages, use them in the Result field.
- Where no figures exist, express the result in concrete relative terms — e.g. "reduced from monthly to weekly reporting", "cut dashboard development time by approximately a third", "enabled same-day rather than next-day decisions".
- Never use the word "measurably" or phrases like "increased measurably" or "improved measurably" — these are vague and unconvincing. Instead say something specific: "across 3 business units", "within 6 weeks", "for a team of 12", "across EU and US markets".
- Never leave the Result as vague or generic — every Result must convey a tangible, specific outcome.

Steal this phrase rules:
- Each stealThisPhrase must be punchy, memorable, and specific to that STAR answer — not a generic LinkedIn summary.
- It should capture the most impressive or distinctive element of the answer in a way that would stand out in an interview room.
- Maximum 18 words.
- Use different wording for each answer.
- Good example: "I built the model in parallel with the live system — zero downtime, zero reporting gaps."
- Bad example: "I designed a scalable data model that improved stakeholder adoption." (too generic)

What not to say rules:
- Each whatNotToSay must be a specific, practical warning relevant to that exact STAR answer.
- Maximum 25 words.
- Focus on the most common mistake a candidate would make when telling this specific story.

${weakInputInstruction}

${companyInfoRules}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callClaude(prompt, 3500);

        parsed.companyName = providedCompany;
        parsed.companyInfo = hasCompany ? (parsed.companyInfo || "") : "";

        ensureStarAnswerStructure(parsed);

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        parsed.creditsRemaining = charge.credits;

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

        // ── Atomic credit charge — same job-fingerprint scheme as the other two routes.
        const jobFingerprint = getJobFingerprint(trimmedJD, providedCompany);
        const chargeRows = await supabaseRpc("charge_credit_for_job", {
            p_email: req.googleUser.email,
            p_job_fingerprint: jobFingerprint
        });
        const charge = Array.isArray(chargeRows) ? chargeRows[0] : chargeRows;

        if (!charge || (!charge.charged && !charge.already_unlocked)) {
            return res.status(402).json({
                error: "No credits remaining. Please buy more credits to continue.",
                noCredits: true
            });
        }

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
- When referencing employers from the CV in the cover letter, always use the full employer name with correct prefix — e.g. "At E.On Energy" not "On Energy", "At Adidas" not "Adidas". Never drop the "At" prefix when starting a sentence with an employer name.
- Where a rewritten CV bullet is suggested, put the suggested text inside single quotes so it can be visually highlighted for the user.

${weakInputInstruction}

Company:
${providedCompany || "Not provided"}

CV:
${trimmedCV}

Job Description:
${trimmedJD}
`;

        const parsed = await callClaude(prompt, 2400, "claude-sonnet-4-6");

        parsed.companyName = providedCompany;
        parsed.cvImprovementPreview = Array.isArray(parsed.cvImprovementPreview)
            ? parsed.cvImprovementPreview.slice(0, 5)
            : [];

        if (validation.weak) {
            parsed.inputNote = "Tip: Adding more CV or job description detail can improve personalisation.";
        }

        parsed.creditsRemaining = charge.credits;

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

        if (!process.env.ELEVENLABS_API_KEY) {
            // Not configured yet — extension falls back to the browser's
            // built-in speech synthesis automatically.
            return res.status(501).json({
                error: "Voice generation is not configured yet."
            });
        }

        const voiceId = process.env.ELEVENLABS_VOICE_ID;
        const elevenRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
            {
                method: "POST",
                headers: {
                    "xi-api-key": process.env.ELEVENLABS_API_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    text: question,
                    model_id: "eleven_flash_v2_5",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true
                    }
                })
            }
        );

        if (!elevenRes.ok) {
            console.error("ElevenLabs TTS error:", elevenRes.status, await elevenRes.text().catch(() => ""));
            // Extension falls back to browser voice automatically on any
            // non-2xx response here.
            return res.status(502).json({ error: "Could not generate voice audio." });
        }

        const audioBuffer = Buffer.from(await elevenRes.arrayBuffer());
        res.set("Content-Type", "audio/mpeg");
        res.send(audioBuffer);

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
  "structureScore": 0,
  "technicalDepthScore": 0,
  "deliveryScore": 0,
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
- Provide overallScore plus three separate category scores: structureScore, technicalDepthScore, deliveryScore — each scored independently from 1 to 10 using the same encouraging philosophy below, not just copies of overallScore.
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

        const parsed = await callClaude(prompt, 2200, "claude-sonnet-4-6");

        parsed.overallScore = Number(parsed.overallScore) || 0;
        parsed.structureScore = Math.max(1, Math.min(10, Number(parsed.structureScore) || parsed.overallScore));
        parsed.technicalDepthScore = Math.max(1, Math.min(10, Number(parsed.technicalDepthScore) || parsed.overallScore));
        parsed.deliveryScore = Math.max(1, Math.min(10, Number(parsed.deliveryScore) || parsed.overallScore));
        parsed.strengths = Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3) : [];
        parsed.improvements = Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 3) : [];

        if (isVerySimilarToReference && parsed.overallScore < 8) {
            parsed.overallScore = 8;
        }

        if (isVerySimilarToReference) {
            parsed.improvedAnswer = "";
        }

        // Save this attempt for My Progress — doesn't block or fail the
        // response if it errors, since the feedback itself already succeeded.
        try {
            await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=id`)
                .then(async users => {
                    if (!users || users.length === 0) return;
                    await supabaseFetch(`/rest/v1/practice_sessions`, {
                        method: "POST",
                        body: JSON.stringify({
                            user_id: users[0].id,
                            company: safeCompany || null,
                            context_type: safeContextType || null,
                            question: safeQuestion || null,
                            transcript: safeTranscript || null,
                            expected_answer: safeExpectedAnswer || null,
                            overall_score: parsed.overallScore,
                            structure_score: parsed.structureScore,
                            technical_depth_score: parsed.technicalDepthScore,
                            delivery_score: parsed.deliveryScore,
                            summary_feedback: parsed.summaryFeedback || null,
                            strengths: parsed.strengths || null,
                            improvements: parsed.improvements || null,
                            structure_feedback: parsed.structureFeedback || null,
                            technical_depth_feedback: parsed.technicalDepthFeedback || null,
                            delivery_feedback: parsed.deliveryFeedback || null
                        })
                    });
                });
        } catch (saveErr) {
            console.error("practice-feedback: failed to save session (non-fatal):", saveErr);
        }

        res.json(parsed);

    } catch (error) {
        console.error("Practice Feedback Error:", error);

        res.status(500).json({
            error: "Failed to generate practice feedback."
        });
    }
});

// ============================================================
// User, session, and payment endpoints — all backend-mediated.
// The extension never talks to Supabase directly any more.
// ============================================================

// ── Get-or-create user on sign-in. Grants 1 free credit on first creation. ──
app.post("/auth/sync-user", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const { email, name, given, photo } = req.googleUser;

        const existing = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=*`);
        if (existing && existing.length > 0) {
            return res.json({ success: true, user: existing[0] });
        }

        const created = await supabaseFetch(`/rest/v1/users`, {
            method: "POST",
            body: JSON.stringify({
                google_id: email,
                email,
                name,
                given_name: given,
                photo,
                credits: 1
            })
        });
        const newUser = Array.isArray(created) ? created[0] : created;

        try {
            await supabaseFetch(`/rest/v1/credit_transactions`, {
                method: "POST",
                body: JSON.stringify({ user_id: newUser.id, amount: 1, type: "signup_bonus" })
            });
        } catch (ledgerErr) {
            console.error("sync-user: ledger log failed (non-fatal):", ledgerErr);
        }

        res.json({ success: true, user: newUser });
    } catch (err) {
        console.error("sync-user error:", err);
        res.status(500).json({ error: "Could not sync user." });
    }
});

// ── Get current credit balance ──
app.post("/credits", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const rows = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=credits`);
        const credits = rows && rows.length > 0 ? rows[0].credits : 0;
        res.json({ success: true, credits });
    } catch (err) {
        console.error("credits error:", err);
        res.status(500).json({ error: "Could not fetch credits." });
    }
});

// ── List all job sessions for the signed-in user ──
app.post("/sessions/list", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const users = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=id`);
        if (!users || users.length === 0) return res.json({ success: true, sessions: [] });
        const userId = users[0].id;
        const sessions = await supabaseFetch(`/rest/v1/job_sessions?user_id=eq.${userId}&order=created_at.desc&select=*`);
        res.json({ success: true, sessions: sessions || [] });
    } catch (err) {
        console.error("sessions list error:", err);
        res.status(500).json({ error: "Could not fetch sessions." });
    }
});

// ── Create or update a job session ──
app.post("/sessions/save", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const {
            jd, job_title, company,
            generated_interview, generated_star, generated_docs, credit_used,
            answers_interview, answers_star, answers_docs
        } = req.body || {};

        const users = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=id`);
        if (!users || users.length === 0) return res.status(404).json({ error: "User not found." });
        const userId = users[0].id;

        const jdSnippet = String(jd || "").slice(0, 500);

        const existing = await supabaseFetch(
            `/rest/v1/job_sessions?user_id=eq.${userId}&jd_snippet=eq.${encodeURIComponent(jdSnippet)}&select=*`
        );

        if (existing && existing.length > 0) {
            const session = existing[0];
            const updated = await supabaseFetch(`/rest/v1/job_sessions?id=eq.${session.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                    generated_interview: generated_interview ?? session.generated_interview,
                    generated_star: generated_star ?? session.generated_star,
                    generated_docs: generated_docs ?? session.generated_docs,
                    credit_used: credit_used ?? session.credit_used,
                    jd_full: jd || session.jd_full || "",
                    answers_interview: answers_interview !== undefined ? answers_interview : session.answers_interview,
                    answers_star: answers_star !== undefined ? answers_star : session.answers_star,
                    answers_docs: answers_docs !== undefined ? answers_docs : session.answers_docs
                })
            });
            return res.json({ success: true, session: Array.isArray(updated) ? updated[0] : updated });
        }

        const created = await supabaseFetch(`/rest/v1/job_sessions`, {
            method: "POST",
            body: JSON.stringify({
                user_id: userId,
                job_title: job_title || "",
                company: company || "",
                jd_snippet: jdSnippet,
                jd_full: jd || "",
                generated_interview: generated_interview || false,
                generated_star: generated_star || false,
                generated_docs: generated_docs || false,
                credit_used: credit_used || false,
                status: "prepping",
                answers_interview: answers_interview || null,
                answers_star: answers_star || null,
                answers_docs: answers_docs || null
            })
        });
        res.json({ success: true, session: Array.isArray(created) ? created[0] : created });
    } catch (err) {
        console.error("session save error:", err);
        res.status(500).json({ error: "Could not save session." });
    }
});

// ── Verify a session belongs to the calling user before letting them touch it ──
async function assertSessionOwnership(sessionId, email) {
    const rows = await supabaseFetch(
        `/rest/v1/job_sessions?id=eq.${sessionId}&select=id,users!inner(email)&users.email=eq.${encodeURIComponent(email)}`
    );
    return Array.isArray(rows) && rows.length > 0;
}

// ── Move a session between kanban columns ──
app.post("/sessions/move", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const { sessionId, status } = req.body || {};
        if (!sessionId || !["prepping", "applied", "done"].includes(status)) {
            return res.status(400).json({ error: "Invalid request." });
        }

        const owned = await assertSessionOwnership(sessionId, req.googleUser.email);
        if (!owned) return res.status(403).json({ error: "Not authorised." });

        await supabaseFetch(`/rest/v1/job_sessions?id=eq.${sessionId}`, {
            method: "PATCH",
            body: JSON.stringify({ status })
        });
        res.json({ success: true });
    } catch (err) {
        console.error("session move error:", err);
        res.status(500).json({ error: "Could not update session." });
    }
});

// ── Delete a session ──
app.post("/sessions/delete", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const { sessionId } = req.body || {};
        if (!sessionId) return res.status(400).json({ error: "Invalid request." });

        const owned = await assertSessionOwnership(sessionId, req.googleUser.email);
        if (!owned) return res.status(403).json({ error: "Not authorised." });

        await supabaseFetch(`/rest/v1/job_sessions?id=eq.${sessionId}`, { method: "DELETE" });
        res.json({ success: true });
    } catch (err) {
        console.error("session delete error:", err);
        res.status(500).json({ error: "Could not delete session." });
    }
});

// ── My Progress — practice history, growth areas, and milestones ──
app.post("/progress", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const users = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=id`);
        if (!users || users.length === 0) {
            return res.json({ success: true, sessions: [], milestones: [], growthArea: null });
        }
        const userId = users[0].id;

        const sessions = await supabaseFetch(
            `/rest/v1/practice_sessions?user_id=eq.${userId}&order=created_at.asc&select=*`
        );
        const practiceSessions = sessions || [];

        const jobSessions = await supabaseFetch(
            `/rest/v1/job_sessions?user_id=eq.${userId}&select=status`
        );
        const totalJobs = (jobSessions || []).length;
        const appliedJobs = (jobSessions || []).filter(j => j.status === "applied").length;

        // ── Growth area — the lowest-average category, framed positively ──
        let growthArea = null;
        if (practiceSessions.length >= 3) {
            const avg = key => practiceSessions.reduce((sum, s) => sum + (s[key] || 0), 0) / practiceSessions.length;
            const categories = [
                { key: "structure_score", label: "Structure", tip: "Try organising your answers with a clear beginning, middle, and end — the STAR method can help here." },
                { key: "technical_depth_score", label: "Technical Depth", tip: "A few more specific technical details in your answers could make them even stronger." },
                { key: "delivery_score", label: "Delivery", tip: "Practising your pacing and confidence out loud a bit more could help your delivery feel even smoother." }
            ];
            const scored = categories.map(c => ({ ...c, avg: avg(c.key) }));
            scored.sort((a, b) => a.avg - b.avg);
            growthArea = { label: scored[0].label, tip: scored[0].tip, average: Math.round(scored[0].avg * 10) / 10 };
        }

        // ── Milestones ──
        const milestones = [];

        milestones.push({
            id: "first_step",
            name: "First Step",
            description: "Complete your first mock interview practice",
            unlocked: practiceSessions.length >= 1
        });

        milestones.push({
            id: "consistent_practice",
            name: "Consistent Practice",
            description: "Complete 10 practice sessions",
            unlocked: practiceSessions.length >= 10,
            progress: Math.min(practiceSessions.length, 10),
            target: 10
        });

        let risingConfidenceUnlocked = false;
        if (practiceSessions.length >= 6) {
            const first3 = practiceSessions.slice(0, 3);
            const last3 = practiceSessions.slice(-3);
            const avgOf = arr => arr.reduce((sum, s) => sum + (s.overall_score || 0), 0) / arr.length;
            risingConfidenceUnlocked = (avgOf(last3) - avgOf(first3)) >= 2;
        }
        milestones.push({
            id: "rising_confidence",
            name: "Rising Confidence",
            description: "Improve your average score as you keep practicing",
            unlocked: risingConfidenceUnlocked
        });

        let wellRoundedUnlocked = false;
        if (practiceSessions.length >= 3) {
            const avg = key => practiceSessions.reduce((sum, s) => sum + (s[key] || 0), 0) / practiceSessions.length;
            wellRoundedUnlocked = avg("structure_score") >= 8 && avg("technical_depth_score") >= 8 && avg("delivery_score") >= 8;
        }
        milestones.push({
            id: "well_rounded",
            name: "Well-Rounded",
            description: "Score strongly across structure, technical depth, and delivery",
            unlocked: wellRoundedUnlocked
        });

        milestones.push({
            id: "job_hunter",
            name: "Job Hunter",
            description: "Save or prep 10 jobs",
            unlocked: totalJobs >= 10,
            progress: Math.min(totalJobs, 10),
            target: 10
        });

        milestones.push({
            id: "follow_through",
            name: "Follow Through",
            description: "Mark 5 jobs as Applied",
            unlocked: appliedJobs >= 5,
            progress: Math.min(appliedJobs, 5),
            target: 5
        });

        milestones.push({
            id: "perfect_practice",
            name: "Perfect Practice",
            description: "Score a 10/10 on any practice session",
            unlocked: practiceSessions.some(s => s.overall_score === 10)
        });

        res.json({
            success: true,
            sessions: practiceSessions,
            growthArea,
            milestones
        });
    } catch (err) {
        console.error("progress error:", err);
        res.status(500).json({ error: "Could not fetch progress." });
    }
});


const CREDIT_TIERS = {
    try: { priceEnv: "STRIPE_PRICE_TRY", credits: 2 },
    starter: { priceEnv: "STRIPE_PRICE_STARTER", credits: 10 },
    popular: { priceEnv: "STRIPE_PRICE_POPULAR", credits: 25 }
};

app.post("/create-checkout-session", requireApiToken, verifyGoogleUser, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Payments are not configured yet." });

    try {
        const { tier } = req.body || {};
        const tierConfig = CREDIT_TIERS[tier];
        const priceId = tierConfig && process.env[tierConfig.priceEnv];

        if (!priceId) {
            return res.status(400).json({ error: "Invalid pricing tier." });
        }

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            line_items: [{ price: priceId, quantity: 1 }],
            customer_email: req.googleUser.email,
            success_url: `https://askscoobyai-api.onrender.com/payment-success`,
            cancel_url: `https://askscoobyai-api.onrender.com/payment-cancelled`,
            metadata: {
                email: req.googleUser.email,
                credits: String(tierConfig.credits)
            }
        });

        res.json({ success: true, url: session.url });
    } catch (err) {
        console.error("checkout session error:", err);
        res.status(500).json({ error: "Could not start checkout." });
    }
});

// ── Simple post-checkout confirmation pages ──
// Stripe's success_url/cancel_url need a real https:// URL — chrome-extension://
// isn't a supported redirect target, so we host a minimal confirmation page here
// instead. The actual credit grant already happened via the webhook by this point;
// this page is purely a "you're done, go back" message for the user.
app.get("/payment-success", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Payment successful</title>
    <style>body{font-family:-apple-system,sans-serif;background:#0f1117;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
    .box{max-width:380px;padding:24px;} h1{color:#4ade80;} p{color:#9ca3af;line-height:1.5;}</style></head>
    <body><div class="box"><h1>✓ Payment successful</h1>
    <p>Your credits have been added to your AskScoobyAI account. You can close this tab and return to the extension.</p>
    </div></body></html>`);
});

app.get("/payment-cancelled", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Payment cancelled</title>
    <style>body{font-family:-apple-system,sans-serif;background:#0f1117;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
    .box{max-width:380px;padding:24px;} h1{color:#facc15;} p{color:#9ca3af;line-height:1.5;}</style></head>
    <body><div class="box"><h1>Payment cancelled</h1>
    <p>No charge was made. You can close this tab and return to the extension to try again.</p>
    </div></body></html>`);
});

// ── Scooby Coach — AI-generated cross-session coaching analysis ──
const SCOOBY_COACH_MIN_SESSIONS = 5;

// Free — just checks unlock status and returns the last cached analysis,
// if one exists. Viewing/revisiting never costs a credit.
app.post("/scooby-coach/status", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const users = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=id`);
        if (!users || users.length === 0) {
            return res.json({ success: true, sessionCount: 0, unlocked: false, latest: null });
        }
        const userId = users[0].id;

        const sessions = await supabaseFetch(`/rest/v1/practice_sessions?user_id=eq.${userId}&select=id`);
        const sessionCount = (sessions || []).length;

        const latestRows = await supabaseFetch(
            `/rest/v1/scooby_coach_analyses?user_id=eq.${userId}&order=created_at.desc&select=*`
        );
        const history = latestRows || [];
        const latest = history.length > 0 ? history[0] : null;

        res.json({
            success: true,
            sessionCount,
            unlocked: sessionCount >= SCOOBY_COACH_MIN_SESSIONS,
            minSessions: SCOOBY_COACH_MIN_SESSIONS,
            latest,
            history
        });
    } catch (err) {
        console.error("scooby-coach status error:", err);
        res.status(500).json({ error: "Could not check Scooby Coach status." });
    }
});

// Costs 1 credit — generates a fresh cross-session analysis.
app.post("/scooby-coach/generate", requireApiToken, verifyGoogleUser, async (req, res) => {
    try {
        const users = await supabaseFetch(`/rest/v1/users?email=eq.${encodeURIComponent(req.googleUser.email)}&select=id`);
        if (!users || users.length === 0) {
            return res.status(404).json({ error: "User not found." });
        }
        const userId = users[0].id;

        const sessions = await supabaseFetch(
            `/rest/v1/practice_sessions?user_id=eq.${userId}&order=created_at.asc&select=*`
        );
        const allSessions = sessions || [];

        if (allSessions.length < SCOOBY_COACH_MIN_SESSIONS) {
            return res.status(400).json({
                error: `Complete at least ${SCOOBY_COACH_MIN_SESSIONS} practice sessions to unlock Scooby Coach.`
            });
        }

        // Atomic credit spend
        const spendRows = await supabaseRpc("spend_credit", {
            p_email: req.googleUser.email,
            p_type: "coach_analysis"
        });
        const spend = Array.isArray(spendRows) ? spendRows[0] : spendRows;

        if (!spend || !spend.spent) {
            return res.status(402).json({
                error: "No credits remaining. Please buy more credits to continue.",
                noCredits: true
            });
        }

        // Cap to the most recent 20 sessions to keep the prompt bounded for
        // very frequent practicers, while still covering plenty of history.
        const recentSessions = allSessions.slice(-20);

        const sessionSummaries = recentSessions.map((s, i) => {
            const date = new Date(s.created_at).toISOString().slice(0, 10);
            return `Session ${i + 1} (${date}) — Overall: ${s.overall_score}/10, Structure: ${s.structure_score}/10, Technical Depth: ${s.technical_depth_score}/10, Delivery: ${s.delivery_score}/10
Summary: ${s.summary_feedback || "N/A"}
Improvements noted: ${Array.isArray(s.improvements) ? s.improvements.join(" | ") : "N/A"}`;
        }).join("\n\n");

        const prompt = `You are Scooby Coach, an encouraging AI interview coach reviewing a job seeker's mock interview practice history.

Practice history (oldest to newest):
${sessionSummaries}

Analyze this history and identify genuine patterns across sessions — not just a single session's feedback. Be specific, encouraging, and constructive. Never harsh or critical in tone — this is a supportive coach, not a critic.

Important constraint for the action plan: only suggest things achievable using AskScoobyAI itself (e.g. "redo this practice session focusing on X," "review your past feedback for Y," "try editing your transcript to tighten up Z before your next attempt") or general practice habits that don't assume external tools or devices. Do NOT suggest recording on a phone, using outside apps, or anything requiring equipment or software outside of what a job seeker already has just by using this product.

Return ONLY this exact JSON structure, no markdown, no preamble:
{
  "trendAnalysis": "2-3 sentences describing how their scores/skills have changed across sessions — be specific about direction (improving, plateauing, fluctuating) and which areas.",
  "recurringThemes": ["2-4 specific patterns noticed repeatedly across multiple sessions' feedback, phrased constructively"],
  "actionPlan": ["3-4 concrete, specific next steps tailored to what was found, phrased encouragingly"]
}`;

        const parsed = await callClaude(prompt, 1200, "claude-sonnet-4-6");

        const saved = await supabaseFetch(`/rest/v1/scooby_coach_analyses`, {
            method: "POST",
            body: JSON.stringify({
                user_id: userId,
                sessions_analyzed: recentSessions.length,
                trend_analysis: parsed.trendAnalysis || null,
                recurring_themes: parsed.recurringThemes || null,
                action_plan: parsed.actionPlan || null
            })
        });

        const savedRow = Array.isArray(saved) ? saved[0] : saved;

        res.json({
            success: true,
            latest: savedRow,
            creditsRemaining: spend.credits
        });
    } catch (err) {
        console.error("scooby-coach generate error:", err);
        res.status(500).json({ error: "Could not generate Scooby Coach analysis." });
    }
});

const PORT = process.env.PORT || 3000;



app.listen(PORT, "0.0.0.0", () => {
    console.log(`AskScoobyAI API running on port ${PORT}`);
});
