// Heritage AI function tests (Groq is faked; sign-in uses the Firebase Auth emulator).
// Run with: npm --prefix tests test   (from the api/_setup folder)
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

process.env.FIREBASE_API_KEY = 'demo-key';
process.env.GROQ_API_KEY = 'test-groq-key';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;

const realFetch = globalThis.fetch;
let groqCalls = [];
let groqReply = { status: 200, body: { choices: [{ message: { content: 'The Taj Mahal is in Agra.' } }] } };
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com/')) {
        groqCalls.push({ url, init });
        return new Response(JSON.stringify(groqReply.body), { status: groqReply.status, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
};

const { default: handler } = await import('../../heritage-chat.js');

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `kid${Date.now()}@example.com`, password: 'secret123', returnSecureToken: true })
    });
    idToken = (await r.json()).idToken;
    assert.ok(idToken, 'emulator sign-up should return an ID token');
});

describe('api/heritage-chat', () => {
    test('answers a signed-in user and keeps the key on the server', async () => {
        groqCalls = [];
        const res = await call({ token: idToken, body: { message: 'Where is the Taj Mahal?' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.payload.answer, 'The Taj Mahal is in Agra.');
        assert.equal(groqCalls.length, 1);
        assert.equal(groqCalls[0].init.headers.Authorization, 'Bearer test-groq-key');
        const sent = JSON.parse(groqCalls[0].init.body);
        assert.equal(sent.messages[0].role, 'system');
        assert.equal(sent.messages[1].content, 'Where is the Taj Mahal?');
        assert.ok(!JSON.stringify(res.payload).includes('test-groq-key'));
    });
    test('rejects requests without sign-in', async () => {
        groqCalls = [];
        const res = await call({ body: { message: 'hi' } });
        assert.equal(res.statusCode, 401);
        assert.equal(groqCalls.length, 0);
    });
    test('rejects a fake token', async () => {
        const res = await call({ token: 'not-a-real-token', body: { message: 'hi' } });
        assert.equal(res.statusCode, 401);
    });
    test('rejects empty and over-long messages', async () => {
        assert.equal((await call({ token: idToken, body: { message: '   ' } })).statusCode, 400);
        assert.equal((await call({ token: idToken, body: { message: 'x'.repeat(1001) } })).statusCode, 400);
    });
    test('answers CORS preflight and refuses GET', async () => {
        const pre = await call({ method: 'OPTIONS' });
        assert.equal(pre.statusCode, 204);
        assert.equal(pre.headers['Access-Control-Allow-Origin'], '*');
        assert.equal((await call({ method: 'GET' })).statusCode, 405);
    });
    test('hides Groq errors behind a friendly message', async () => {
        groqReply = { status: 429, body: { error: { message: 'rate limit: key gsk_live_xyz' } } };
        const res = await call({ token: idToken, body: { message: 'hi' } });
        assert.equal(res.statusCode, 502);
        assert.ok(!res.payload.error.includes('gsk_'));
    });
});
