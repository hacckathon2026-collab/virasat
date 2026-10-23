// Heritage AI — runs on Vercel's server, never in the browser, so the Groq key stays secret.
// You don't need to edit this file. It needs two settings in Vercel → Settings → Environment Variables:
//   GROQ_API_KEY      (mark as Sensitive)
//   FIREBASE_API_KEY  (the apiKey from the Firebase settings in index.html; used to check who is signed in)

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-20b';
const MAX_MESSAGE_CHARS = 1000;

const SYSTEM_PROMPT =
    "You are Heritage AI, the friendly educational assistant for Virasat — India's Living Heritage. " +
    "Answer questions about India's history, monuments, culture, traditions, architecture, " +
    "art, festivals, food and heritage. Keep answers interesting, accurate and student-friendly. " +
    "When useful, connect your answer to places or heritage shown on the Virasat map. " +
    "If a question is unrelated to heritage, answer briefly and gently guide the user back to India's heritage. " +
    // Hindi answers must be in Devanagari: the site reads them aloud with a Hindi voice, and an
    // English voice is used for anything in English letters (so "aap kaise hain" sounds wrong).
    "Reply in the language the student writes in. If they write in Hindi, including Hindi typed in English " +
    "letters (Hinglish, e.g. 'aap kaise hain'), reply in Hindi written in Devanagari script (हिंदी), " +
    "never in English letters.";

// The site's language (sent by the page) — the answer follows it.
const LANGUAGE_RULES = {
    hi: 'The student is using the site in Hindi: always reply in Hindi, written in Devanagari script.',
    sa: 'The student is using the site in Sanskrit: reply in simple Sanskrit, written in Devanagari script.'
};

// Asks Firebase whether this sign-in token belongs to a real, active Virasat account.
async function isSignedIn(idToken) {
    const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;   // only set when testing locally
    const base = emulator ? `http://${emulator}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
    const res = await fetch(`${base}/v1/accounts:lookup?key=${encodeURIComponent(process.env.FIREBASE_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    const user = data.users && data.users[0];
    return !!(user && !user.disabled);
}

module.exports = async function handler(req, res) {
    // Any page may call this (the live site, previews, or the HTML opened from a laptop);
    // the sign-in check below is what keeps strangers out.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

    if (!process.env.GROQ_API_KEY || !process.env.FIREBASE_API_KEY) {
        console.error('Missing GROQ_API_KEY or FIREBASE_API_KEY environment variable.');
        return res.status(500).json({ error: 'Heritage AI is not set up yet.' });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!bearer) return res.status(401).json({ error: 'Please sign in to use Heritage AI.' });
    try {
        if (!(await isSignedIn(bearer[1]))) {
            return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
        }
    } catch (err) {
        console.error('Sign-in check failed', err);
        return res.status(502).json({ error: 'Heritage AI could not check your sign-in. Please try again.' });
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Please type a question.' });
    if (message.length > MAX_MESSAGE_CHARS) {
        return res.status(400).json({ error: `Please keep questions under ${MAX_MESSAGE_CHARS} characters.` });
    }
    const languageRule = LANGUAGE_RULES[req.body?.language];
    const systemPrompt = languageRule ? SYSTEM_PROMPT + ' ' + languageRule : SYSTEM_PROMPT;

    try {
        const groqRes = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: message }
                ],
                temperature: 0.7,
                max_tokens: 500
            })
        });
        const data = await groqRes.json().catch(() => ({}));

        if (groqRes.status === 429) {
            // Groq's free plan allows only so many requests per minute/day.
            return res.status(429).json({ error: 'Limit exceeded. Please try again in a few minutes.' });
        }

        if (!groqRes.ok) {
            console.error('Groq error', groqRes.status, data.error?.message);
            return res.status(502).json({ error: 'Heritage AI is busy right now. Please try again in a moment.' });
        }

        const answer = data.choices?.[0]?.message?.content;
        if (!answer) return res.status(502).json({ error: 'No answer received. Please try again.' });

        return res.status(200).json({ answer });
    } catch (err) {
        console.error('Groq request failed', err);
        return res.status(502).json({ error: 'Heritage AI could not be reached. Please try again.' });
    }
};
