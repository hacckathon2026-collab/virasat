// Photo reader function tests (Groq is faked; sign-in uses the Firebase Auth emulator).
// Run with: npm --prefix tests test   (from the api/_setup folder)
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

process.env.FIREBASE_API_KEY = 'demo-key';
process.env.GROQ_API_KEY = 'test-groq-key';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;

const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg bytes').toString('base64');
const GOOD = {
    ok: true, script: 'Devanagari', lang: 'Sanskrit', era: 'Modern print',
    text: 'कर्मण्येवाधिकारस्ते', roman: 'karmaṇy evādhikāras te',
    tr: 'Your right is to action alone.', about: 'A famous Gita verse.', conf: 'high', extra_field: 'dropped'
};

const realFetch = globalThis.fetch;
let groqCalls = [];
let groqReply;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com/')) {
        groqCalls.push({ url, init });
        return new Response(groqReply.body, { status: groqReply.status, headers: groqReply.headers || { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
};
const reply = (content, status = 200, headers) => ({ status, headers, body: JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : { error: { message: 'nope' } }) });

const { default: handler } = await import('../../scripture-read.js');

function call({ method = 'POST', token, body } = {}) {
    const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body };
    return new Promise(resolve => {
        const res = {
            statusCode: 200, headers: {}, payload: undefined,
            setHeader(k, v) { this.headers[k] = v; },
            status(code) { this.statusCode = code; return this; },
            json(obj) { this.payload = obj; resolve(this); return this; },
            end() { resolve(this); return this; }
        };
        handler(req, res);
    });
}

let idToken;
before(async () => {
    const r = await realFetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `reader${Date.now()}@example.test`, password: 'secret123', returnSecureToken: true })
    });
    idToken = (await r.json()).idToken;
    assert.ok(idToken);
});

describe('api/scripture-read', () => {
    test('reads a photo for a signed-in user and keeps the key on the server', async () => {
        groqCalls = []; groqReply = reply(JSON.stringify(GOOD));
        const res = await call({ token: idToken, body: { image: PHOTO, lang: 'hi' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.payload.result.script, 'Devanagari');
        assert.equal(res.payload.result.original, 'कर्मण्येवाधिकारस्ते');
        assert.equal(res.payload.result.translation, 'Your right is to action alone.');
        assert.equal(res.payload.result.translationLang, 'hi');
        assert.equal(res.payload.result.confidence, 'high');
        assert.equal(res.payload.result.extra_field, undefined);
        const sent = JSON.parse(groqCalls[0].init.body);
        assert.equal(sent.model, 'qwen/qwen3.8-27b');
        assert.equal(sent.messages[0].content[1].image_url.url, PHOTO);
        assert.match(sent.messages[0].content[0].text, /translation into Hindi\./);
        assert.match(sent.messages[0].content[0].text, /"ok":true,"script"/);
        assert.equal(groqCalls[0].init.headers.Authorization, 'Bearer test-groq-key');
        assert.ok(!JSON.stringify(res.payload).includes('test-groq-key'));
    });
    test('rejects requests without sign-in or with a fake token', async () => {
        groqCalls = [];
        assert.equal((await call({ body: { image: PHOTO } })).statusCode, 401);
        assert.equal((await call({ token: 'fake', body: { image: PHOTO } })).statusCode, 401);
        assert.equal(groqCalls.length, 0);
    });
    test('accepts only JPG, PNG or WebP photos of a sensible size', async () => {
        assert.equal((await call({ token: idToken, body: {} })).statusCode, 400);
        assert.equal((await call({ token: idToken, body: { image: 'https://example.com/a.jpg' } })).statusCode, 400);
        assert.equal((await call({ token: idToken, body: { image: 'data:image/svg+xml;base64,PHN2Zz4=' } })).statusCode, 400);
        assert.equal((await call({ token: idToken, body: { image: 'data:image/jpeg;base64,' + 'A'.repeat(3500001) } })).statusCode, 413);
    });
    test('says the limit was exceeded when Groq refuses with 429', async () => {
        groqReply = reply('', 429, { 'Content-Type': 'application/json', 'retry-after': '7' });
        const res = await call({ token: idToken, body: { image: PHOTO } });
        assert.equal(res.statusCode, 429);
        assert.equal(res.payload.error, 'Limit exceeded. Please try again in a few minutes.');
    });
    test('a Sanskrit page gets its translation in Hindi; an English page in English', async () => {
        groqCalls = []; groqReply = reply(JSON.stringify(GOOD));
        assert.equal((await call({ token: idToken, body: { image: PHOTO, lang: 'sa' } })).payload.result.translationLang, 'hi');
        assert.equal((await call({ token: idToken, body: { image: PHOTO, lang: 'en' } })).payload.result.translationLang, 'en');
        assert.match(JSON.parse(groqCalls[1].init.body).messages[0].content[0].text, /translation into English\./);
    });
    test('copes with an answer wrapped in extra text, and with a broken one', async () => {
        groqReply = reply('Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```');
        assert.equal((await call({ token: idToken, body: { image: PHOTO } })).payload.result.language, 'Sanskrit');
        groqReply = reply('not json at all');
        assert.equal((await call({ token: idToken, body: { image: PHOTO } })).statusCode, 502);
    });
    test('cleans up odd values from the model', async () => {
        groqReply = reply(JSON.stringify({ ok: false, conf: 'certain', script: 42, about: 'x'.repeat(5000), roman: 'None', era: 'N/A' }));
        const r = (await call({ token: idToken, body: { image: PHOTO } })).payload.result;
        assert.equal(r.isScript, false);
        assert.equal(r.confidence, 'low');
        assert.equal(r.script, '');
        assert.equal(r.explanation.length, 1500);
        assert.equal(r.transliteration, '');
        assert.equal(r.period, '');
    });
});
