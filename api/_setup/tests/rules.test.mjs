// Database rules tests. Run with: npm --prefix tests test
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, collection, getDocs, query, orderBy, limit, Timestamp } from 'firebase/firestore';

let env;

before(async () => {
    env = await initializeTestEnvironment({
        projectId: 'demo-virasat',
        firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 }
    });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const asAsha = () => env.authenticatedContext('asha', { email: 'asha@example.com' }).firestore();
const asRavi = () => env.authenticatedContext('ravi', { email: 'ravi@example.com' }).firestore();
const asStranger = () => env.unauthenticatedContext().firestore();

const profile = (over = {}) => ({
    displayName: 'Asha', email: 'asha@example.com', language: 'en', theme: 'dark',
    createdAt: serverTimestamp(), lastLoginAt: serverTimestamp(), ...over
});
const quizEntry = (over = {}) => ({
    uid: 'asha', displayName: 'Asha', score: 6, total: 8, timeMs: 42000, plays: 1, updatedAt: serverTimestamp(), ...over
});
const matchEntry = (over = {}) => ({
    uid: 'asha', displayName: 'Asha', moves: 20, pairs: 8, timeMs: 30000, plays: 1, updatedAt: serverTimestamp(), ...over
});

async function seed(path, data) {
    await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), path), data));
}
const seededQuiz = (over = {}) => ({ ...quizEntry(over), updatedAt: Timestamp.now() });

describe('profiles', () => {
    test('owner can create and read their profile', async () => {
        await assertSucceeds(setDoc(doc(asAsha(), 'users/asha'), profile()));
        await assertSucceeds(getDoc(doc(asAsha(), 'users/asha')));
    });
    test('others cannot read or write it', async () => {
        await seed('users/asha', { ...profile(), createdAt: Timestamp.now(), lastLoginAt: Timestamp.now() });
        await assertFails(getDoc(doc(asRavi(), 'users/asha')));
        await assertFails(getDoc(doc(asStranger(), 'users/asha')));
        await assertFails(setDoc(doc(asRavi(), 'users/asha'), profile()));
    });
    test('email must match the signed-in account', async () => {
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ email: 'someone@else.com' })));
    });
    test('rejects bad nickname, language, theme and extra fields', async () => {
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ displayName: 'A' })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ displayName: 'x'.repeat(25) })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ language: 'fr' })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ theme: 'pink' })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ isAdmin: true })));
    });
    test('owner can change preferences but not createdAt', async () => {
        await seed('users/asha', { ...profile(), createdAt: Timestamp.fromMillis(1000), lastLoginAt: Timestamp.now() });
        await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { language: 'hi', theme: 'light' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { createdAt: Timestamp.now() }));
    });
});

describe('roles', () => {
    // vedanshtyagi925@gmail.com is on the admin list in firestore.rules; asha is not.
    const asVed = () => env.authenticatedContext('ved', { email: 'vedanshtyagi925@gmail.com' }).firestore();
    const vedProfile = (over = {}) => profile({ displayName: 'Vedansh', email: 'vedanshtyagi925@gmail.com', ...over });
    const seeded = over => ({ ...profile(over), createdAt: Timestamp.fromMillis(1000), lastLoginAt: Timestamp.now() });
    const seededVed = over => ({ ...vedProfile(over), createdAt: Timestamp.fromMillis(1000), lastLoginAt: Timestamp.now() });

    test('anyone can sign up as a student or teacher', async () => {
        for (const role of ['student', 'teacher']) {
            await env.clearFirestore();
            await assertSucceeds(setDoc(doc(asAsha(), 'users/asha'), profile({ role })));
        }
    });
    test('someone not on the list cannot sign up as admin', async () => {
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'admin' })));
    });
    test('an email on the list signs up as admin, and only admin', async () => {
        await assertFails(setDoc(doc(asVed(), 'users/ved'), vedProfile({ role: 'student' })));
        await assertSucceeds(setDoc(doc(asVed(), 'users/ved'), vedProfile({ role: 'admin' })));
    });
    test('rejects an unknown role', async () => {
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'principal' })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'Admin' })));
    });
    test('nobody can switch between student and teacher themselves', async () => {
        await seed('users/asha', seeded({ role: 'student' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'teacher' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'admin' }));
        await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { lastLoginAt: serverTimestamp() }));
    });
    test('an admin from before the list, not on it, can only go back to student', async () => {
        await seed('users/asha', seeded({ role: 'admin' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { lastLoginAt: serverTimestamp() }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'teacher' }));
        await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { role: 'student' }));
    });
    test('an email on the list becomes admin from any old role', async () => {
        for (const old of [{}, { role: 'student' }, { role: 'teacher' }]) {
            await env.clearFirestore();
            await seed('users/ved', seededVed(old));
            await assertFails(updateDoc(doc(asVed(), 'users/ved'), { role: 'teacher' }));
            await assertSucceeds(updateDoc(doc(asVed(), 'users/ved'), { role: 'admin' }));
        }
    });
    test('a profile with no role, not on the list, can only become student', async () => {
        await seed('users/asha', seeded({}));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'admin' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'teacher' }));
        await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { role: 'student' }));
    });
    test('each person can check only their own email against the admin list', async () => {
        await assertSucceeds(getDoc(doc(asVed(), 'adminCheck/vedanshtyagi925@gmail.com')));
        await assertFails(getDoc(doc(asAsha(), 'adminCheck/asha@example.com')));
        await assertFails(getDoc(doc(asAsha(), 'adminCheck/vedanshtyagi925@gmail.com')));
        await assertFails(getDoc(doc(asStranger(), 'adminCheck/vedanshtyagi925@gmail.com')));
        await assertFails(getDocs(collection(asVed(), 'adminCheck')));
    });
    test('the role cannot be removed', async () => {
        await seed('users/asha', seeded({ role: 'teacher' }));
        const { role, ...withoutRole } = seeded({ role: 'teacher' });
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), withoutRole));
    });
});

describe('leaderboards', () => {
    test('signed-in players can read; strangers cannot', async () => {
        await seed('leaderboards/quiz/entries/ravi', { ...seededQuiz({ uid: 'ravi', displayName: 'Ravi' }) });
        const top = query(collection(asAsha(), 'leaderboards/quiz/entries'), orderBy('score', 'desc'), orderBy('timeMs', 'asc'), limit(10));
        await assertSucceeds(getDocs(top));
        await assertFails(getDocs(collection(asStranger(), 'leaderboards/quiz/entries')));
    });
    test('player can post their first score', async () => {
        await assertSucceeds(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry()));
        await assertSucceeds(setDoc(doc(asAsha(), 'leaderboards/match/entries/asha'), matchEntry()));
    });
    test("cannot post someone else's score", async () => {
        await assertFails(setDoc(doc(asRavi(), 'leaderboards/quiz/entries/asha'), quizEntry()));
        await assertFails(setDoc(doc(asRavi(), 'leaderboards/quiz/entries/ravi'), quizEntry()));   // uid field says asha
    });
    test('rejects impossible scores', async () => {
        const ref = () => doc(asAsha(), 'leaderboards/quiz/entries/asha');
        await assertFails(setDoc(ref(), quizEntry({ score: 9, total: 8 })));
        await assertFails(setDoc(ref(), quizEntry({ score: -1 })));
        await assertFails(setDoc(ref(), quizEntry({ score: 6.5 })));
        await assertFails(setDoc(ref(), quizEntry({ timeMs: 500 })));
        await assertFails(setDoc(ref(), quizEntry({ plays: 5 })));
        await assertFails(setDoc(ref(), quizEntry({ bonus: 100 })));
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/match/entries/asha'), matchEntry({ moves: 10 })));  // < 2 × pairs
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/chess/entries/asha'), quizEntry()));
    });
    test('better score replaces the best and counts a play', async () => {
        await seed('leaderboards/quiz/entries/asha', seededQuiz());
        await assertSucceeds(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ score: 7, plays: 2 })));
    });
    test('same score but faster time also counts as better', async () => {
        await seed('leaderboards/quiz/entries/asha', seededQuiz());
        await assertSucceeds(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ timeMs: 30000, plays: 2 })));
    });
    test('worse game can only bump the play count', async () => {
        await seed('leaderboards/quiz/entries/asha', seededQuiz());
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ score: 3, plays: 2 })));
        await assertSucceeds(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ plays: 2 })));
    });
    test('play count must go up by exactly one', async () => {
        await seed('leaderboards/quiz/entries/asha', seededQuiz());
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ score: 7, plays: 1 })));
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ score: 7, plays: 10 })));
    });
    test('Heritage Match: fewer moves is better', async () => {
        await seed('leaderboards/match/entries/asha', { ...matchEntry(), updatedAt: Timestamp.now() });
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/match/entries/asha'), matchEntry({ moves: 30, plays: 2 })));
        await assertSucceeds(setDoc(doc(asAsha(), 'leaderboards/match/entries/asha'), matchEntry({ moves: 18, plays: 2 })));
    });
    test('timestamp must come from the server', async () => {
        await assertFails(setDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), quizEntry({ updatedAt: Timestamp.fromMillis(0) })));
    });
});
