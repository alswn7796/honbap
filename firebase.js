// ===== Firebase SDK 로드 =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
    getAuth, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail,
    EmailAuthProvider, linkWithCredential, updatePassword,
    signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";

import {
    getFirestore, doc, getDoc, setDoc, serverTimestamp,
    collection, query, where, orderBy, limit, addDoc, updateDoc, deleteDoc,
    onSnapshot, runTransaction, getDocs,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// ===== 프로젝트 설정 (네 값 유지) =====
const firebaseConfig = {
    apiKey: "AIzaSyB0TUXQpzZIy0v2gbLOC343Jx_Lv51EQvw",
    authDomain: "honbap-paring.firebaseapp.com",
    projectId: "honbap-paring",
    storageBucket: "honbap-paring.firebasestorage.app",
    messagingSenderId: "375771626039",
    appId: "1:375771626039:web:03868631de56225cf49db2",
};

// ===== 초기화 =====
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ========================= 공통 유틸/인증/프로필 =========================
const KW_DOMAIN = /@kw\.ac\.kr$/i;
function flash(el, msg) { if (el) el.textContent = msg; }

function requireAuth() {
    return new Promise((resolve, reject) => {
        const unsub = onAuthStateChanged(auth, (user) => {
            unsub();
            if (user) resolve(user);
            else reject(new Error("로그인이 필요합니다."));
        });
    });
}

const actionCodeSettings = {
    url: window.location.origin + "/signup.html",
    handleCodeInApp: true,
};

async function sendEmailLink(email) {
    if (!KW_DOMAIN.test(email)) throw new Error("@kw.ac.kr 이메일만 사용 가능합니다.");
    await sendSignInLinkToEmail(auth, email, actionCodeSettings);
    window.localStorage.setItem("pendingEmail", email);
}

async function handleEmailLinkIfPresent() {
    if (!isSignInWithEmailLink(auth, window.location.href)) return { consumed: false };
    let email = window.localStorage.getItem("pendingEmail");
    if (!email) email = window.prompt("확인을 위해 학교 이메일을 다시 입력하세요:");
    await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem("pendingEmail");
    return { consumed: true, email };
}

async function setPasswordForCurrentUser(pw) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("로그인 상태가 아닙니다.");
    if (!pw || pw.length < 8) throw new Error("비밀번호는 8자 이상이어야 합니다.");

    const cred = EmailAuthProvider.credential(user.email, pw);
    try {
        await linkWithCredential(user, cred);
    } catch (e) {
        if (e.code === "auth/provider-already-linked" || e.code === "auth/credential-already-in-use") {
            await updatePassword(user, pw);
        } else {
            throw e;
        }
    }
}

async function loginWithEmailPassword(email, pw) {
    return signInWithEmailAndPassword(auth, email, pw);
}
async function logout() { return signOut(auth); }

async function saveProfile(data) {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");
    const payload = {
        year: data.year ?? null,
        age: data.age ?? null,
        gender: data.gender ?? null,
        major: (data.major || "").trim() || null,
        mbti: (data.mbti || "").trim() || null,
        content: (data.content || "").trim() || null,
        updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, "profiles", user.uid), payload, { merge: true });
}

async function loadProfile() {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");
    const snap = await getDoc(doc(db, "profiles", user.uid));
    return snap.exists() ? snap.data() : null;
}

// ========================= 매칭/채팅 =========================
const MATCH_TTL_MS = 20 * 1000;   // 최근 20초 내 활동 사용자만 매칭
const HEARTBEAT_MS = 10 * 1000;   // 10초마다 lastActive 갱신
let _heartBeatTimer = null;

async function startMatching(pref = {}) {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");

    const myRef = doc(db, "matchQueue", user.uid);
    const now = serverTimestamp();

    await setDoc(myRef, {
        uid: user.uid,
        email: user.email || null,
        pref: pref || {},
        status: "waiting",
        lastActive: now,
        createdAt: now,
        roomId: null,
    }, { merge: true });

    if (_heartBeatTimer) clearInterval(_heartBeatTimer);
    _heartBeatTimer = setInterval(async () => {
        try { await updateDoc(myRef, { lastActive: serverTimestamp() }); } catch (_) { }
    }, HEARTBEAT_MS);

    const roomId = await tryMatch();
    return roomId || null;
}

async function cancelMatching() {
    const user = auth.currentUser;
    if (!user) return;
    const myRef = doc(db, "matchQueue", user.uid);
    if (_heartBeatTimer) { clearInterval(_heartBeatTimer); _heartBeatTimer = null; }
    await deleteDoc(myRef).catch(() => { });
}

function onMyQueueStatus(callback) {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");
    const myRef = doc(db, "matchQueue", user.uid);
    return onSnapshot(myRef, (snap) => {
        if (!snap.exists()) return;
        callback(snap.data());
    });
}

/**
 * 인덱스 없이 동작하도록 설계:
 * - 서버 쿼리는 status == "waiting" 만 (limit N)
 * - createdAt 정렬/TTL 필터링은 클라이언트에서 처리
 * - 트랜잭션에서 waiting 상태를 다시 검증
 */
async function tryMatch() {
    const me = auth.currentUser;
    if (!me) throw new Error("로그인이 필요합니다.");

    const qRef = collection(db, "matchQueue");

    // ✅ 인덱스 없이 가능한 쿼리(단일 where)
    const candidatesQ = query(
        qRef,
        where("status", "==", "waiting"),
        limit(50)
    );

    // 1) 후보 가져오기 (클라이언트에서 정렬/TTL 필터)
    const listSnap = await getDocs(candidatesQ);
    const nowMs = Date.now();

    const candidates = [];
    listSnap.forEach((d) => {
        const v = d.data();
        if (d.id === me.uid) return;
        const lastActiveMs = (v.lastActive && v.lastActive.toMillis)
            ? v.lastActive.toMillis()
            : nowMs;
        const createdAtMs = (v.createdAt && v.createdAt.toMillis)
            ? v.createdAt.toMillis()
            : 0;

        if (nowMs - lastActiveMs <= MATCH_TTL_MS && v.status === "waiting") {
            candidates.push({ id: d.id, data: v, createdAtMs });
        }
    });

    // 오래 기다린 사람 우선
    candidates.sort((a, b) => a.createdAtMs - b.createdAtMs);

    // 후보 1명 선택
    const partner = candidates[0];
    if (!partner) return null;

    const myRef = doc(db, "matchQueue", me.uid);
    const partnerRef = doc(db, "matchQueue", partner.id);

    let createdRoomId = null;

    // 2) 트랜잭션: 두 문서가 아직 waiting인지 확인하고 방 생성
    await runTransaction(db, async (tx) => {
        const mySnap = await tx.get(myRef);
        const partnerSnap = await tx.get(partnerRef);

        if (!mySnap.exists() || !partnerSnap.exists()) return;

        const myData = mySnap.data();
        const partnerData = partnerSnap.data();

        if (myData.status !== "waiting" || partnerData.status !== "waiting") return;

        const roomRef = doc(collection(db, "rooms"));

        tx.set(roomRef, {
            roomId: roomRef.id,
            createdAt: serverTimestamp(),
            participants: [
                { uid: me.uid, email: me.email || null },
                { uid: partnerRef.id, email: partnerData.email || null },
            ],
            lastMessageAt: serverTimestamp(),
        });

        tx.update(myRef, { status: "matched", roomId: roomRef.id });
        tx.update(partnerRef, { status: "matched", roomId: roomRef.id });

        createdRoomId = roomRef.id;
    });

    return createdRoomId;
}

// 채팅
async function sendMessage(roomId, text) {
    const u = auth.currentUser;
    if (!u) throw new Error("로그인이 필요합니다.");
    if (!text || !text.trim()) return;

    const msgRef = collection(db, "rooms", roomId, "messages");
    await addDoc(msgRef, {
        uid: u.uid,
        email: u.email || null,
        text: text.trim(),
        createdAt: serverTimestamp(),
    });

    await updateDoc(doc(db, "rooms", roomId), { lastMessageAt: serverTimestamp() }).catch(() => { });
}

function onMessages(roomId, callback) {
    // 단일 orderBy(createdAt) 는 기본 단일필드 인덱스로 동작
    const q = query(collection(db, "rooms", roomId, "messages"), orderBy("createdAt", "asc"));
    return onSnapshot(q, (snap) => {
        const arr = [];
        snap.forEach((d) => arr.push({ id: d.id, ...d.data() }));
        callback(arr);
    });
}

async function assertRoomMember(roomId) {
    const u = auth.currentUser;
    if (!u) throw new Error("로그인이 필요합니다.");
    const r = await getDoc(doc(db, "rooms", roomId));
    if (!r.exists()) throw new Error("방이 없습니다.");
    const p = r.data().participants || [];
    if (!p.find(m => m.uid === u.uid)) throw new Error("이 방의 멤버가 아닙니다.");
    return true;
}

// ========================= 전역 공개 =========================
window.fb = {
    // 기본
    auth, db, flash,
    requireAuth,
    sendEmailLink,
    handleEmailLinkIfPresent,
    setPasswordForCurrentUser,
    loginWithEmailPassword,
    logout,
    saveProfile,
    loadProfile,
    // 매칭/채팅
    startMatching,
    cancelMatching,
    onMyQueueStatus,
    tryMatch,
    sendMessage,
    onMessages,
    assertRoomMember,
};

window.fbReady = Promise.resolve(window.fb);
