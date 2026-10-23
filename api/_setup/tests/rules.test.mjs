// Database rules tests. Run with: npm --prefix tests test
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, deleteDoc, collection, getDocs, query, orderBy, limit, Timestamp } from 'firebase/firestore';

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

    test('everyone not on the list signs up as a student, and only a student', async () => {
        await assertSucceeds(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'student' })));
        await env.clearFirestore();
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'teacher' })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'admin' })));
    });
    test('an email on the list signs up as admin, and only admin', async () => {
        await assertFails(setDoc(doc(asVed(), 'users/ved'), vedProfile({ role: 'student' })));
        await assertSucceeds(setDoc(doc(asVed(), 'users/ved'), vedProfile({ role: 'admin' })));
    });
    test('rejects unknown roles', async () => {
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'principal' })));
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), profile({ role: 'Student' })));
    });
    test('a student cannot make themselves admin (or teacher)', async () => {
        await seed('users/asha', seeded({ role: 'student' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'admin' }));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'teacher' }));
        await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { lastLoginAt: serverTimestamp() }));
    });
    test('old teacher or unlisted admin profiles can only be corrected to student', async () => {
        for (const old of ['teacher', 'admin']) {
            await env.clearFirestore();
            await seed('users/asha', seeded({ role: old }));
            await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { lastLoginAt: serverTimestamp() }));
            await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { role: 'student' }));
        }
    });
    test('an email on the list becomes admin from any old role', async () => {
        for (const old of [{}, { role: 'student' }, { role: 'teacher' }]) {
            await env.clearFirestore();
            await seed('users/ved', seededVed(old));
            await assertFails(updateDoc(doc(asVed(), 'users/ved'), { role: 'student' }));
            await assertSucceeds(updateDoc(doc(asVed(), 'users/ved'), { role: 'admin' }));
        }
    });
    test('a profile with no role, not on the list, becomes student', async () => {
        await seed('users/asha', seeded({}));
        await assertFails(updateDoc(doc(asAsha(), 'users/asha'), { role: 'admin' }));
        await assertSucceeds(updateDoc(doc(asAsha(), 'users/asha'), { role: 'student' }));
    });
    test('the role cannot be removed', async () => {
        await seed('users/asha', seeded({ role: 'student' }));
        const { role, ...withoutRole } = seeded({ role: 'student' });
        await assertFails(setDoc(doc(asAsha(), 'users/asha'), withoutRole));
    });
    test('each person can check only their own email against the admin list', async () => {
        await assertSucceeds(getDoc(doc(asVed(), 'adminCheck/vedanshtyagi925@gmail.com')));
        await assertFails(getDoc(doc(asAsha(), 'adminCheck/asha@example.com')));
        await assertFails(getDoc(doc(asAsha(), 'adminCheck/vedanshtyagi925@gmail.com')));
        await assertFails(getDoc(doc(asStranger(), 'adminCheck/vedanshtyagi925@gmail.com')));
        await assertFails(getDocs(collection(asVed(), 'adminCheck')));
    });
});

describe('admin leaderboard tools', () => {
    const asVed = () => env.authenticatedContext('ved', { email: 'vedanshtyagi925@gmail.com' }).firestore();
    test('an admin can change only the score, within what is possible', async () => {
        await seed('leaderboards/quiz/entries/asha', seededQuiz({ score: 8, total: 8 }));
        const ref = () => doc(asVed(), 'leaderboards/quiz/entries/asha');
        await assertSucceeds(updateDoc(ref(), { score: 3 }));
        await assertFails(updateDoc(ref(), { score: 9 }));
        await assertFails(updateDoc(ref(), { score: -1 }));
        await assertFails(updateDoc(ref(), { score: 2.5 }));
        await assertFails(updateDoc(ref(), { timeMs: 99999 }));
        await assertFails(updateDoc(ref(), { displayName: 'Renamed' }));
        await assertFails(updateDoc(ref(), { score: 4, plays: 50 }));
    });
    test('Heritage Match: an admin edits moves, never below 2 per pair', async () => {
        await seed('leaderboards/match/entries/asha', { ...matchEntry(), updatedAt: Timestamp.now() });
        await assertSucceeds(updateDoc(doc(asVed(), 'leaderboards/match/entries/asha'), { moves: 40 }));
        await assertFails(updateDoc(doc(asVed(), 'leaderboards/match/entries/asha'), { moves: 10 }));
        await assertFails(updateDoc(doc(asVed(), 'leaderboards/match/entries/asha'), { score: 5 }));
    });
    test('an admin can remove an entry; players cannot', async () => {
        await seed('leaderboards/quiz/entries/asha', seededQuiz());
        await seed('leaderboards/quiz/entries/ravi', seededQuiz({ uid: 'ravi', displayName: 'Ravi' }));
        await assertFails(deleteDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha')));
        await assertFails(deleteDoc(doc(asAsha(), 'leaderboards/quiz/entries/ravi')));
        await assertSucceeds(deleteDoc(doc(asVed(), 'leaderboards/quiz/entries/ravi')));
    });
    test('a player still cannot edit anyone else, or their own score directly', async () => {
        await seed('leaderboards/quiz/entries/ravi', seededQuiz({ uid: 'ravi', displayName: 'Ravi' }));
        await seed('leaderboards/quiz/entries/asha', seededQuiz());
        await assertFails(updateDoc(doc(asAsha(), 'leaderboards/quiz/entries/ravi'), { score: 0 }));
        await assertFails(updateDoc(doc(asAsha(), 'leaderboards/quiz/entries/asha'), { score: 8 }));
    });
});

describe('quiz questions added by admins', () => {
    const asVed = () => env.authenticatedContext('ved', { email: 'vedanshtyagi925@gmail.com' }).firestore();   // on the admin list
    const question = (over = {}) => ({ game: 'quiz', q: 'Which dynasty built the Brihadeeswara Temple?', opts: ['Chola', 'Pallava', 'Chalukya', 'Pandya'], a: 0, createdBy: 'ved', createdByName: 'Vedansh', createdAt: serverTimestamp(), ...over });
    const seededQ = (over = {}) => ({ ...question(over), createdAt: Timestamp.now() });

    test('an admin can add a question for Heritage Quiz or Festival Match', async () => {
        await assertSucceeds(setDoc(doc(asVed(), 'quizQuestions/q1'), question()));
        await assertSucceeds(setDoc(doc(asVed(), 'quizQuestions/q2'), question({ game: 'festival' })));
    });
    test('non-admins cannot add questions', async () => {
        await assertFails(setDoc(doc(asAsha(), 'quizQuestions/q1'), question({ createdBy: 'asha' })));
        await assertFails(setDoc(doc(asStranger(), 'quizQuestions/q1'), question()));
    });
    test('rejects badly formed questions', async () => {
        const ref = () => doc(asVed(), 'quizQuestions/q1');
        await assertFails(setDoc(ref(), question({ game: 'scramble' })));
        await assertFails(setDoc(ref(), question({ q: 'Hi?' })));
        await assertFails(setDoc(ref(), question({ q: 'x'.repeat(301) })));
        await assertFails(setDoc(ref(), question({ opts: ['A', 'B', 'C'] })));
        await assertFails(setDoc(ref(), question({ opts: ['A', 'B', 'C', ''] })));
        await assertFails(setDoc(ref(), question({ a: 4 })));
        await assertFails(setDoc(ref(), question({ a: '0' })));
        await assertFails(setDoc(ref(), question({ createdBy: 'someone-else' })));
        await assertFails(setDoc(ref(), question({ createdAt: Timestamp.fromMillis(0) })));
        await assertFails(setDoc(ref(), question({ points: 100 })));
    });
    test('every signed-in player can read them; strangers cannot', async () => {
        await seed('quizQuestions/q1', seededQ());
        await assertSucceeds(getDocs(collection(asAsha(), 'quizQuestions')));
        await assertFails(getDocs(collection(asStranger(), 'quizQuestions')));
    });
    test('only admins can remove a question, and nobody can edit one', async () => {
        await seed('quizQuestions/q1', seededQ());
        await assertFails(deleteDoc(doc(asAsha(), 'quizQuestions/q1')));
        await assertFails(updateDoc(doc(asVed(), 'quizQuestions/q1'), { a: 2 }));
        await assertSucceeds(deleteDoc(doc(asVed(), 'quizQuestions/q1')));
    });
});

describe('reviews on recipes and Desi Nuskhe', () => {
    const asVed = () => env.authenticatedContext('ved', { email: 'vedanshtyagi925@gmail.com' }).firestore();   // on the admin list
    const review = (over = {}) => ({ kind: 'recipe', item: 'dal-makhani', uid: 'asha', displayName: 'Asha', rating: 5, text: 'Tasty!', createdAt: serverTimestamp(), ...over });
    const seededReview = (over = {}) => ({ ...review(over), createdAt: Timestamp.now() });

    test('a signed-in player can post one review per item, with or without text', async () => {
        await assertSucceeds(setDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_asha'), review()));
        const { text, ...noText } = review({ kind: 'nuskha', item: 'tulsi', rating: 3 });
        await assertSucceeds(setDoc(doc(asAsha(), 'reviews/nuskha_tulsi_asha'), noText));
    });
    test('the id must be kind_item_uid of the poster (so nobody reviews twice or as someone else)', async () => {
        await assertFails(setDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_ravi'), review()));
        await assertFails(setDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_asha2'), review()));
        await assertFails(setDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_ravi'), review({ uid: 'ravi' })));
        await assertFails(setDoc(doc(asAsha(), 'reviews/abc'), review()));
    });
    test('rejects bad stars, kind, item, long text, extra fields and signed-out posts', async () => {
        const ref = id => doc(asAsha(), 'reviews/' + id);
        await assertFails(setDoc(ref('recipe_dal-makhani_asha'), review({ rating: 0 })));
        await assertFails(setDoc(ref('recipe_dal-makhani_asha'), review({ rating: 6 })));
        await assertFails(setDoc(ref('recipe_dal-makhani_asha'), review({ rating: 4.5 })));
        await assertFails(setDoc(ref('game_dal-makhani_asha'), review({ kind: 'game' })));
        await assertFails(setDoc(ref('recipe_Dal Makhani_asha'), review({ item: 'Dal Makhani' })));
        await assertFails(setDoc(ref('recipe_dal-makhani_asha'), review({ text: 'x'.repeat(501) })));
        await assertFails(setDoc(ref('recipe_dal-makhani_asha'), review({ likes: 99 })));
        await assertFails(setDoc(ref('recipe_dal-makhani_asha'), review({ displayName: 'A' })));
        await assertFails(setDoc(doc(asStranger(), 'reviews/recipe_dal-makhani_asha'), review()));
    });
    test('nobody can change a review after posting, not even its author', async () => {
        await seed('reviews/recipe_dal-makhani_asha', seededReview());
        await assertFails(setDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_asha'), review({ rating: 1 })));
        await assertFails(updateDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_asha'), { text: 'changed' }));
        await assertFails(updateDoc(doc(asVed(), 'reviews/recipe_dal-makhani_asha'), { text: 'changed' }));
    });
    test('signed-in players read reviews; only admins delete them', async () => {
        await seed('reviews/recipe_dal-makhani_asha', seededReview());
        await assertSucceeds(getDocs(collection(asRavi(), 'reviews')));
        await assertFails(getDocs(collection(asStranger(), 'reviews')));
        await assertFails(deleteDoc(doc(asAsha(), 'reviews/recipe_dal-makhani_asha')));
        await assertFails(deleteDoc(doc(asRavi(), 'reviews/recipe_dal-makhani_asha')));
        await assertSucceeds(deleteDoc(doc(asVed(), 'reviews/recipe_dal-makhani_asha')));
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
