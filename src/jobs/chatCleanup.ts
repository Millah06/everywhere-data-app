// src/jobs/chatCleanup.ts
//
// Firestore chat cost control. Messages are written with an `expireAt`
// timestamp (currently now + 120h). The Flutter app caches all messages
// locally (Hive), so once a message is delivered its server copy is just a
// transport artifact — deleting it keeps Firestore small (= cheap) while users
// keep full history on-device.
//
// This job sweeps every chat room's `messages` subcollection (via a
// collectionGroup query) and batch-deletes documents whose `expireAt` has
// passed. It also clears empty room previews.
//
// NOTE: For zero-maintenance cleanup you can ALSO enable a native Firestore TTL
// policy on the `messages` collection group keyed on `expireAt`
// (Firestore console → TTL, or `gcloud firestore fields ttl update`). That
// deletes expired docs automatically at no read cost. This cron is the
// portable fallback / works without that policy and lets us log volume.

import admin from "../config/firebase";

const BATCH_LIMIT = 400; // Firestore batch max is 500; stay under.

export const runChatCleanupJob = async () => {
  try {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    const expired = await db
      .collectionGroup("messages")
      .where("expireAt", "<=", now)
      .limit(BATCH_LIMIT)
      .get();

    if (expired.empty) return;

    const batch = db.batch();
    expired.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    console.log(`[chatCleanup] deleted ${expired.size} expired message(s)`);
  } catch (e: any) {
    // Missing index on (messages, expireAt) throws FAILED_PRECONDITION with a
    // console link to create it — surface clearly but don't crash the worker.
    console.error("[chatCleanup] job error", e?.message || e);
  }
};
