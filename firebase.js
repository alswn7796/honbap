// firebase.js v22 — 혼밥러 공용 헬퍼 (로그인/커뮤니티/매칭/노쇼/메시지)
// -----------------------------------------------------------------------------
// 변경 요약
// - 프레즌스 주기: 15초 → 60초, localhost에서는 프레즌스 비활성화(쿼터 절약)
// - saveProfile: Firestore quota 초과(resource-exhausted) 메시지 명확화
// -----------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
    getAuth, onAuthStateChanged,
    signInAnonymously, signOut,
    signInWithEmailAndPassword, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
    collection, query, where, orderBy, limit, getDocs, onSnapshot, runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// -----------------------------------------------------------------------------
// 1) 구성값
const __cfg = (typeof firebaseConfig !== 'undefined' && firebaseConfig) ? firebaseConfig : {
    apiKey: "AIzaSyB0TUXQpzZIy0v2gbLOC343Jx_Lv51EQvw",
    authDomain: "honbap-paring.firebaseapp.com",
    projectId: "honbap-paring",
    storageBucket: "honbap-paring.firebasestorage.app",
    messagingSenderId: "375771626039",
    appId: "1:375771626039:web:03868631de56225cf49db2",
};
if (!__cfg || !__cfg.apiKey) throw new Error('[firebase.js] firebaseConfig.apiKey가 비었습니다.');

// -----------------------------------------------------------------------------
// 2) 초기화
const app = initializeApp(__cfg);
const auth = getAuth(app);
const db = getFirestore(app);

// -----------------------------------------------------------------------------
// 3) 공용 유틸
const my = {
    get uid() { return auth?.currentUser?.uid || null; },

    async requireAuth() {
        if (auth.currentUser) return auth.currentUser;
        await signInAnonymously(auth);
        return new Promise((res) => {
            const un = onAuthStateChanged(auth, (u) => { if (u) { un(); res(u); } });
        });
    },

    async logout() { await signOut(auth); },

    async nowProfile() {
        await my.requireAuth();
        const snap = await getDoc(doc(db, "profiles", my.uid));
        return snap.exists() ? snap.data() : null;
    },

    async saveProfile(p) {
        await my.requireAuth();
        const payload = {
            year: p.year ?? null,
            age: p.age ?? null,
            gender: p.gender ?? null,
            major: p.major ?? null,
            mbti: p.mbti ?? null,
            content: p.content ?? null,
            freeText: p.freeText ?? "",
            isBot: !!p.isBot,
            penaltyScore: p.penaltyScore ?? 0,
            honbapTemp: p.honbapTemp ?? 50,
            updatedAt: serverTimestamp(),
        };
        try {
            await setDoc(doc(db, "profiles", my.uid), payload, { merge: true });
        } catch (e) {
            // 🔴 일일 한도(쿼터) 초과 시 사용자에게 즉시 알림
            if (e?.code === 'resource-exhausted') {
                throw new Error('Firestore 할당량을 초과했습니다. 잠시 후(일일 리셋 후) 다시 시도하거나 요금제를 업그레이드하세요.');
            }
            throw e;
        }
    },
};

// -----------------------------------------------------------------------------
// 4) 로그인/회원가입
async function loginWithEmailPassword(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
}
async function signUpWithEmailPassword(email, password) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user;
}

// -----------------------------------------------------------------------------
// 5) 커뮤니티
async function createPost({ title, body }) {
    await my.requireAuth();
    const u = auth.currentUser;
    await addDoc(collection(db, "posts"), {
        title: title ?? '',
        body: body ?? '',
        authorUid: u.uid,
        authorEmail: u.email ?? null,
        createdAt: serverTimestamp(),
    });
}
async function listPosts({ take = 30, pageSize = 30, cursor = null } = {}) {
    // 기존 사용처 호환을 위해 인자 유지
    const qy = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(pageSize || take));
    const ss = await getDocs(qy);
    return { items: ss.docs.map(d => ({ id: d.id, ...d.data() })), cursor: null };
}

// -----------------------------------------------------------------------------
// 6) 프레즌스
// ✅ 로컬 개발 환경에서는 프레즌스를 꺼서 쓰기 폭탄 방지
const DEV_NO_PRESENCE = location.hostname === 'localhost';

const presence = {
    tick: null,
    start() {
        if (DEV_NO_PRESENCE || presence.tick) return;
        presence.tick = setInterval(async () => {
            try {
                await my.requireAuth();
                await setDoc(doc(db, "presence", my.uid),
                    { lastActive: serverTimestamp() }, { merge: true });
            } catch { }
        }, 60_000); // ⬅ 60초로 완화(기존 15초)
    },
    stop() { if (presence.tick) clearInterval(presence.tick); presence.tick = null; }
};
presence.start();

// -----------------------------------------------------------------------------
// 7) 매칭/노쇼
const MATCH_TIMEOUT_MS = 45_000;
const ONLINE_WINDOW_MS = 90_000;

async function leaveQueueByUid(uid) {
    const qy = query(collection(db, "matchQueue"), where("uid", "==", uid));
    const ss = await getDocs(qy);
    await Promise.all(ss.docs.map(d => deleteDoc(d.ref)));
}

async function enterQueue(options) {
    await my.requireAuth();
    const prof = await my.nowProfile() || {};
    const ref = doc(collection(db, "matchQueue"));
    const payload = {
        uid: my.uid,
        email: auth.currentUser.email ?? null,
        createdAt: serverTimestamp(),
        lastActive: serverTimestamp(),
        status: "waiting",
        pref: {
            year: prof.year ?? null,
            age: prof.age ?? null,
            gender: prof.gender ?? null,
            major: prof.major ?? null,
            freeText: prof.freeText ?? "",
            ...options,
        },
        isBot: !!prof.isBot,
        roomId: null,
    };
    await setDoc(ref, payload);
    return ref.id;
}

async function findOpponent(myDocId) {
    const myRef = doc(db, "matchQueue", myDocId);
    const myDoc = await getDoc(myRef);
    if (!myDoc.exists()) throw new Error("대기열 문서가 없어요.");
    const me = myDoc.data();

    const snaps = await getDocs(
        query(collection(db, "matchQueue"),
            where("status", "==", "waiting"),
            orderBy("createdAt", "asc"), limit(25))
    );

    const now = Date.now();
    const freeOverlapCheck = (A, B) => {
        if (!me.pref?.freeOverlap) return true;
        const pick = s => (s || "").replace(/\s/g, "");
        const a = pick(me.pref?.freeText);
        const b = pick(B?.pref?.freeText);
        if (!a || !b) return false;
        return ['월', '화', '수', '목', '금', '토', '일'].some(ch => a.includes(ch) && b.includes(ch));
    };

    for (const d of snaps.docs) {
        if (d.id === myDocId) continue;
        const you = d.data();
        if (you.uid === me.uid) continue;
        if (you.status !== 'waiting') continue;

        if (me.pref?.onlineOnly) {
            const last = (you.lastActive?.toDate?.() || new Date(0)).getTime();
            if (now - last > ONLINE_WINDOW_MS) continue;
        }
        const same = (a, b) => (a != null && b != null && a === b);
        if (me.pref?.yearSame && !same(me.pref?.year, you.pref?.year)) continue;
        if (me.pref?.majorSame && !same(me.pref?.major, you.pref?.major)) continue;
        if (me.pref?.ageSame && !same(me.pref?.age, you.pref?.age)) continue;
        if (me.pref?.genderSame && !same(me.pref?.gender, you.pref?.gender)) continue;
        if (!freeOverlapCheck(me.pref?.freeText, you)) continue;

        return { id: d.id, you };
    }
    return null;
}

// ★ 배열에 serverTimestamp() 금지 → invites는 '객체'로 저장
async function createRoomAndInvite(myDocId, oppDocId) {
    const roomRef = doc(collection(db, "rooms"));
    const room = {
        members: [my.uid],
        createdAt: serverTimestamp(),
        phase: "pendingAccept",
        invites: { to: oppDocId, at: serverTimestamp(), accepted: null },
    };
    await setDoc(roomRef, room);
    await updateDoc(doc(db, "matchQueue", myDocId), { status: "matched", roomId: roomRef.id, lastActive: serverTimestamp() });
    await updateDoc(doc(db, "matchQueue", oppDocId), { status: "matched", roomId: roomRef.id, lastActive: serverTimestamp() });
    return roomRef;
}

async function waitInviteDecision(roomId, timeoutSec = 30) {
    const ref = doc(db, "rooms", roomId);
    return new Promise((resolve) => {
        const t = setTimeout(() => { un(); resolve(false); }, timeoutSec * 1000);
        const un = onSnapshot(ref, (snap) => {
            if (!snap.exists()) return;
            const r = snap.data();
            if (r.phase === 'startCheck') { clearTimeout(t); un(); resolve(true); }
            if (r.phase === 'declined') { clearTimeout(t); un(); resolve(false); }
        });
    });
}

async function myAcceptOrDecline(roomId, accept) {
    const ref = doc(db, "rooms", roomId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("room not found");
        const r = snap.data();
        if (r.phase !== 'pendingAccept') return;
        tx.update(ref, {
            members: Array.from(new Set([...(r.members || []), my.uid])),
            phase: accept ? 'startCheck' : 'declined',
            updatedAt: serverTimestamp(),
        });
    });
}

async function waitStartDecision(roomId, timeoutSec = 30) {
    const ref = doc(db, "rooms", roomId);
    return new Promise((resolve) => {
        const t = setTimeout(() => { un(); resolve(false); }, timeoutSec * 1000);
        const un = onSnapshot(ref, (snap) => {
            if (!snap.exists()) return;
            const r = snap.data();
            if (r.phase === 'chatting') { clearTimeout(t); un(); resolve(true); }
            if (r.phase === 'startDeclined') { clearTimeout(t); un(); resolve(false); }
        });
    });
}

async function myStartYesOrNo(roomId, yes) {
    const ref = doc(db, "rooms", roomId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("room not found");
        const r = snap.data();
        if (r.phase !== 'startCheck') return;

        const voted = new Set(r.startVoted || []);
        const yesSet = new Set(r.startYes || []);
        voted.add(my.uid);
        if (yes) yesSet.add(my.uid);

        const all = new Set(r.members || []);
        const everyoneVoted = Array.from(all).every(u => voted.has(u));
        const everyoneYes = everyoneVoted && Array.from(all).every(u => yesSet.has(u));

        tx.update(ref, {
            startVoted: Array.from(voted),
            startYes: Array.from(yesSet),
            phase: everyoneVoted ? (everyoneYes ? 'chatting' : 'startDeclined') : 'startCheck',
            updatedAt: serverTimestamp(),
        });
    });
}

function gotoRoom(roomId) {
    location.href = `chat.html?room=${encodeURIComponent(roomId)}`;
}

// 패널티/큐 종료
async function applyPenalty({ kind }) {
    await my.requireAuth();
    const ref = doc(db, "profiles", my.uid);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const p = snap.exists() ? snap.data() : {};
        let penaltyScore = p.penaltyScore ?? 0;
        let honbapTemp = p.honbapTemp ?? 50;
        if (kind === 'early_decline' || kind === 'start_decline') penaltyScore -= 1;
        if (kind === 'after_start_cancel') honbapTemp = Math.max(0, honbapTemp - 3);
        tx.set(ref, { penaltyScore, honbapTemp, updatedAt: serverTimestamp() }, { merge: true });
    });
}
async function cancelMatching() {
    if (!auth.currentUser) return;
    await leaveQueueByUid(my.uid);
}
async function markLeaving() {
    if (!auth.currentUser) return;
    const qy = query(collection(db, "matchQueue"), where("uid", "==", my.uid), limit(1));
    const ss = await getDocs(qy);
    if (ss.empty) return;
    await updateDoc(ss.docs[0].ref, { status: "leaving", lastActive: serverTimestamp() });
}

// -----------------------------------------------------------------------------
// 8) 채팅 기능 + 멤버십 확인
async function assertRoomMember(roomId) {
    await my.requireAuth();
    const snap = await getDoc(doc(db, "rooms", roomId));
    if (!snap.exists()) throw new Error("room not found");
    const room = snap.data();
    if (!Array.isArray(room.members) || !room.members.includes(my.uid)) {
        throw new Error("you are not a member of this room");
    }
    return true;
}
function onMessages(roomId, cb) {
    const qy = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "asc"), limit(200));
    return onSnapshot(qy, (ss) => {
        cb(ss.docs.map(d => ({ id: d.id, ...d.data() })));
    });
}
async function sendMessage(roomId, text) {
    await my.requireAuth();
    const t = (text || "").trim();
    if (!t) return;
    await addDoc(collection(db, "rooms", roomId, "messages"), {
        text: t,
        uid: my.uid,
        email: auth.currentUser?.email ?? null,
        createdAt: serverTimestamp(),
    });
}

// ★ 추가: 완전 나가기 (멤버에서 제거, 마지막이면 종료)
async function leaveRoom(roomId) {
    await my.requireAuth();
    const ref = doc(db, "rooms", roomId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const r = snap.data();
        const members = (r.members || []).filter(u => u !== my.uid);
        const update = { members, updatedAt: serverTimestamp() };
        if (members.length === 0) update.phase = 'ended';
        tx.update(ref, update);
    });
    await leaveQueueByUid(my.uid);
}

// -----------------------------------------------------------------------------
// 9) 테스트봇 즉시 매칭
async function startWithTestBot() {
    await my.requireAuth();
    await leaveQueueByUid(my.uid);

    const roomRef = doc(collection(db, "rooms"));
    await setDoc(roomRef, {
        members: [my.uid, "__testbot__"],
        createdAt: serverTimestamp(),
        phase: "chatting"
    });

    await addDoc(collection(db, "rooms", roomRef.id, "messages"), {
        text: "테스트봇 연결 완료 ✅ 채팅 입력 테스트 해보세요.",
        uid: "__testbot__",
        email: "bot",
        createdAt: serverTimestamp()
    });

    return { id: roomRef.id };
}

// -----------------------------------------------------------------------------
// 10) 전역 API
const api = {
    // 기본
    auth, db, requireAuth: my.requireAuth, logout: my.logout,

    // 로그인/회원가입
    loginWithEmailPassword, signUpWithEmailPassword,

    // 프로필
    loadProfile: my.nowProfile,
    saveProfile: my.saveProfile,

    // 커뮤니티
    createPost, listPosts,

    // 매칭
    startMatching: async (options) => {
        await my.requireAuth();
        await leaveQueueByUid(my.uid);
        const myDocId = await enterQueue(options);
        const found = await findOpponent(myDocId);
        if (!found) {
            const myRef = doc(db, "matchQueue", myDocId);
            const room = await new Promise((resolve, reject) => {
                const t = setTimeout(() => { un(); reject(new Error("제한 시간 내에 상대를 못 찾았어요.")); }, MATCH_TIMEOUT_MS);
                const un = onSnapshot(myRef, async (snap) => {
                    if (!snap.exists()) return;
                    const d = snap.data();
                    if (d.status === 'matched' && d.roomId) { clearTimeout(t); un(); resolve({ id: d.roomId }); }
                    else updateDoc(myRef, { lastActive: serverTimestamp() }).catch(() => { });
                });
            });
            return room;
        }
        const roomRef = await createRoomAndInvite(myDocId, found.id);
        return { id: roomRef.id };
    },
    readyToAccept: waitInviteDecision,
    acceptMatch: (roomId) => myAcceptOrDecline(roomId, true),
    declineMatch: (roomId) => myAcceptOrDecline(roomId, false),
    readyToChat: waitStartDecision,
    startYes: (roomId) => myStartYesOrNo(roomId, true),
    startNo: (roomId) => myStartYesOrNo(roomId, false),
    gotoRoom,

    // 패널티 & 종료
    applyPenalty, cancelMatching, markLeaving,

    // 채팅
    onMessages, sendMessage, assertRoomMember, leaveRoom,

    // 테스트봇
    startWithTestBot,
};

window.fb = api;
window.fbReady = Promise.resolve(api);
window.getFb = async () => window.fbReady;
