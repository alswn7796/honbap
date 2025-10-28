// ===== Firebase SDK =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
    sendPasswordResetEmail, isSignInWithEmailLink, signInWithEmailLink,
    sendSignInLinkToEmail, EmailAuthProvider, linkWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";

import {
    getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp,
    collection, addDoc, query, where, orderBy, limit, onSnapshot,
    runTransaction, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// ===== Project Config (사용 중인 값 유지) =====
const firebaseConfig = {
    apiKey: "AIzaSyB0TUXQpzZIy0v2gbLOC343Jx_Lv51EQvw",
    authDomain: "honbap-paring.firebaseapp.com",
    projectId: "honbap-paring",
    storageBucket: "honbap-paring.firebasestorage.app",
    messagingSenderId: "375771626039",
    appId: "1:375771626039:web:03868631de56225cf49db2",
};

// ===== Init =====
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ===== Small utils =====
const nowTS = () => serverTimestamp();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const asNumber = (v) => (v === undefined || v === null || v === "") ? null : Number(v);
const asString = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
};
const asStringArray = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
    // "월 12-15, 수 9-12" 같은 콤마 문자열 지원
    return String(v).split(",").map(s => s.trim()).filter(Boolean);
};

async function isAdmin(uid) {
    if (!uid) return false;
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
}

// ===== Auth helpers =====
function requireAuth() {
    return new Promise((resolve, reject) => {
        const off = onAuthStateChanged(auth, (u) => {
            off();
            u ? resolve(u) : reject(new Error("로그인이 필요합니다."));
        });
    });
}

async function loginWithEmailPassword(email, pw) {
    return signInWithEmailAndPassword(auth, email, pw);
}

async function resetPasswordByEmail(email) {
    if (!email) throw new Error("이메일을 입력하세요.");
    return sendPasswordResetEmail(auth, email);
}

async function logout() { return signOut(auth); }

// (선택) 이메일 링크 가입을 이미 쓰고 있다면 사용
const actionCodeSettings = {
    url: (typeof window !== "undefined" ? window.location.origin : "") + "/signup.html",
    handleCodeInApp: true,
};
async function sendEmailLink(email) {
    await sendSignInLinkToEmail(auth, email, actionCodeSettings);
    window.localStorage.setItem("pendingEmail", email);
}
async function handleEmailLinkIfPresent() {
    if (!isSignInWithEmailLink(auth, window.location.href)) return { consumed: false };
    let email = window.localStorage.getItem("pendingEmail");
    if (!email) email = window.prompt("학교 이메일을 다시 입력하세요:");
    await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem("pendingEmail");
    return { consumed: true, email };
}
async function setPasswordForCurrentUser(pw) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("로그인 상태가 아닙니다.");
    if (!pw || pw.length < 8) throw new Error("비밀번호는 8자 이상이어야 합니다.");
    const cred = EmailAuthProvider.credential(user.email, pw);
    try { await linkWithCredential(user, cred); }
    catch (e) {
        if (e.code === "auth/provider-already-linked" || e.code === "auth/credential-already-in-use") {
            await updatePassword(user, pw);
        } else { throw e; }
    }
}

// ===== Profile =====
// fields: year(입학년도), age(만), gender, major, mbti, content, freeSlots(공강시간 배열)
async function saveProfile(data) {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");
    const payload = {
        year: asNumber(data.year),
        age: asNumber(data.age),
        gender: asString(data.gender),
        major: asString(data.major),
        mbti: asString(data.mbti),
        content: asString(data.content),
        // 공강시간: 문자열/배열 모두 허용, undefined 방지
        freeSlots: asStringArray(data.freeSlots),
        updatedAt: nowTS(),
    };
    await setDoc(doc(db, "profiles", u.uid), payload, { merge: true });
}
async function loadProfile() {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");
    const snap = await getDoc(doc(db, "profiles", u.uid));
    return snap.exists() ? snap.data() : null;
}

// ===== Community (익명 게시판) =====
// posts: { title, body, createdAt, authorUid, authorHash (익명), }
function anonTag(uid) {
    // 아주 간단한 익명 태그(앞 4자리)
    if (!uid) return "익명";
    return "익명#" + uid.slice(0, 4);
}
async function createPost({ title, body }) {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");
    const payload = {
        title: asString(title),
        body: asString(body),
        createdAt: nowTS(),
        authorUid: u.uid,
        authorHash: anonTag(u.uid),
    };
    if (!payload.title || !payload.body) throw new Error("제목/내용을 입력하세요.");
    await addDoc(collection(db, "posts"), payload);
}
function listPosts(callback, limitCount = 30) {
    const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(limitCount));
    return onSnapshot(q, (snap) => {
        const arr = [];
        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
        callback(arr);
    });
}
async function deletePost(postId) {
    const u = await requireAuth();
    // 앱단 관리자 체크
    const ok = await isAdmin(u.uid);
    if (!ok) throw new Error("관리자만 삭제할 수 있습니다.");
    await deleteDoc(doc(db, "posts", postId));
}

// ===== Matching / Chat =====
const MATCH_TTL_MS = 20 * 1000;   // 최근 20초 내 활동 사용자만
const HEARTBEAT_MS = 10 * 1000;   // 10초마다 lastActive 갱신
let _hbTimer = null;
let _queueUnsub = null;

// freeSlots 교집합 있는지 검사
function hasOverlap(a = [], b = []) {
    if (!a || !b) return false;
    const S = new Set(a);
    for (const x of b) if (S.has(x)) return true;
    return false;
}

async function startMatching(pref = {}) {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");

    // 내 프로필 로드(공강시간/나이 등 필터 계산용)
    const myProfile = await loadProfile().catch(() => null);
    const mySlots = myProfile?.freeSlots || [];

    const myRef = doc(db, "matchQueue", u.uid);
    const base = {
        uid: u.uid,
        email: u.email || null,
        status: "waiting",
        lastActive: nowTS(),
        createdAt: nowTS(),
        roomId: null,
        // 사용자가 요청한 필터를 그대로 보존(후보 필터링에 사용)
        filter: {
            year: asNumber(pref.year),
            major: asString(pref.major),
            gender: asString(pref.gender),
            ageMin: asNumber(pref.ageMin),
            ageMax: asNumber(pref.ageMax),
        },
        mySlots, // 내 공강시간
    };
    await setDoc(myRef, base, { merge: true });

    // heartbeat
    if (_hbTimer) clearInterval(_hbTimer);
    _hbTimer = setInterval(async () => {
        try { await updateDoc(myRef, { lastActive: nowTS() }); } catch (_) { }
    }, HEARTBEAT_MS);

    // 즉시 한 번 매칭 시도
    const roomId = await tryMatch();
    return roomId || null;
}

async function cancelMatching() {
    const u = auth.currentUser; if (!u) return;
    if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
    if (_queueUnsub) {
        try { _queueUnsub(); } catch (_) { }
        _queueUnsub = null;
    }
    await deleteDoc(doc(db, "matchQueue", u.uid)).catch(() => { });
}

function onMyQueueStatus(callback) {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");
    const ref = doc(db, "matchQueue", u.uid);
    if (_queueUnsub) try { _queueUnsub(); } catch (_) { }
    _queueUnsub = onSnapshot(ref, (snap) => {
        if (!snap.exists()) return;
        callback(snap.data());
    });
    return _queueUnsub;
}

/**
 * 인덱스 없이 동작:
 * - where("status","==","waiting") 단일 조건 쿼리
 * - 필터/정렬/TTL/겹침검사는 클라이언트에서
 */
async function tryMatch() {
    const me = auth.currentUser; if (!me) throw new Error("로그인이 필요합니다.");

    const myProfile = await loadProfile().catch(() => null);
    const mySlots = myProfile?.freeSlots || [];
    const myAge = myProfile?.age ?? null;
    const myYear = myProfile?.year ?? null;
    const myMajor = myProfile?.major ?? null;
    const myGender = myProfile?.gender ?? null;

    const myQRef = collection(db, "matchQueue");
    const candQ = query(myQRef, where("status", "==", "waiting"), limit(50));
    const list = await getDocs(candQ);

    const nowMs = Date.now();
    const mineSnap = await getDoc(doc(db, "matchQueue", me.uid));
    const mine = mineSnap.exists() ? mineSnap.data() : null;
    const myFilter = mine?.filter || {};

    const cands = [];
    list.forEach(d => {
        if (d.id === me.uid) return;
        const v = d.data();
        // TTL
        const lastMs = (v.lastActive && v.lastActive.toMillis) ? v.lastActive.toMillis() : nowMs;
        if (nowMs - lastMs > MATCH_TTL_MS) return;
        if (v.status !== "waiting") return;

        // 상대의 프로필을 가져와 클라이언트 필터링(부하를 줄이기 위해 캐시 없이 단회 조회)
        cands.push({ id: d.id, data: v });
    });

    // 후보 상세 프로필 병렬 조회
    const enriched = [];
    await Promise.all(cands.map(async (c) => {
        const ps = await getDoc(doc(db, "profiles", c.id)).catch(() => ({ exists: () => false }));
        enriched.push({ ...c, profile: ps.exists() ? ps.data() : {} });
    }));

    // 필터: 나의 필터가 요구하는 조건을 상대가 만족하는지
    function passMyFilter(pf) {
        if (!pf) return true;
        if (myFilter.gender && pf.gender && myFilter.gender !== pf.gender) return false;
        if (myFilter.major && pf.major && myFilter.major !== pf.major) return false;
        if (myFilter.year && pf.year && myFilter.year !== pf.year) return false;
        if (myFilter.ageMin && pf.age != null && pf.age < myFilter.ageMin) return false;
        if (myFilter.ageMax && pf.age != null && pf.age > myFilter.ageMax) return false;
        return true;
    }
    // 상호 공강 겹침
    function passOverlap(pf) {
        const otherSlots = pf?.freeSlots || [];
        return hasOverlap(mySlots, otherSlots);
    }

    // 오래 기다린 사람 우선: createdAt asc
    const scored = enriched
        .filter(c => passMyFilter(c.profile))
        .filter(c => passOverlap(c.profile))
        .map(c => {
            const createdMs = (c.data.createdAt && c.data.createdAt.toMillis)
                ? c.data.createdAt.toMillis() : 0;
            return { ...c, createdMs };
        })
        .sort((a, b) => a.createdMs - b.createdMs);

    const partner = scored[0];
    if (!partner) return null;

    const myRef = doc(db, "matchQueue", me.uid);
    const pRef = doc(db, "matchQueue", partner.id);

    let createdRoomId = null;
    await runTransaction(db, async (tx) => {
        const myS = await tx.get(myRef);
        const pS = await tx.get(pRef);
        if (!myS.exists() || !pS.exists()) return;
        const myD = myS.data(); const pD = pS.data();
        if (myD.status !== "waiting" || pD.status !== "waiting") return;

        const roomRef = doc(collection(db, "rooms"));
        tx.set(roomRef, {
            roomId: roomRef.id,
            createdAt: nowTS(),
            participants: [
                { uid: me.uid, email: me.email || null },
                { uid: partner.id, email: partner.data.email || null },
            ],
            lastMessageAt: nowTS(),
        });
        tx.update(myRef, { status: "matched", roomId: roomRef.id });
        tx.update(pRef, { status: "matched", roomId: roomRef.id });
        createdRoomId = roomRef.id;
    });

    return createdRoomId;
}

// 채팅
async function assertRoomMember(roomId) {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");
    const r = await getDoc(doc(db, "rooms", roomId));
    if (!r.exists()) throw new Error("방이 없습니다.");
    const p = r.data().participants || [];
    if (!p.find(x => x.uid === u.uid)) throw new Error("이 방의 멤버가 아닙니다.");
    return true;
}
async function sendMessage(roomId, text) {
    const u = auth.currentUser; if (!u) throw new Error("로그인이 필요합니다.");
    const t = (text || "").trim();
    if (!t) return;
    const ref = collection(db, "rooms", roomId, "messages");
    await addDoc(ref, { uid: u.uid, email: u.email || null, text: t, createdAt: nowTS() });
    await updateDoc(doc(db, "rooms", roomId), { lastMessageAt: nowTS() }).catch(() => { });
}
function onMessages(roomId, callback) {
    const q = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "asc"));
    return onSnapshot(q, (snap) => {
        const arr = []; snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
        callback(arr);
    });
}

// (선택) 탭 이탈 표시용
async function markLeaving() { /* no-op placeholder */ }
async function markActive() { /* no-op placeholder */ }

// ===== Expose =====
window.fb = {
    // base
    auth, db,
    requireAuth, loginWithEmailPassword, resetPasswordByEmail, logout,
    sendEmailLink, handleEmailLinkIfPresent, setPasswordForCurrentUser,

    // profile
    saveProfile, loadProfile,

    // community
    createPost, listPosts, deletePost,

    // match/chat
    startMatching, cancelMatching, onMyQueueStatus, tryMatch,
    assertRoomMember, sendMessage, onMessages,

    // markers
    markLeaving, markActive,
};

// 초기화 완료 신호
window.fbReady = Promise.resolve(window.fb);
