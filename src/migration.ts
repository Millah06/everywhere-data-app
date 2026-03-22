/**
 * Firebase → Postgres Migration
 * ─────────────────────────────
 * Copies users, userProfiles, transactions, and transfers from Firestore
 * into the new Postgres schema.
 *
 * Usage:
 *   ts-node src/utils/migration.ts
 *   or call migrationRunner() programmatically from a one-off endpoint.
 *
 * Safe to re-run: uses upsert everywhere so duplicate runs won't double-insert.
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {prisma}  from "./prisma";
import { generateReferralCode } from "./shared/utils/generateRefferalCode"

const BATCH_SIZE = 100;

interface MigrationResult {
  users: { migrated: number; skipped: number; failed: string[] };
  transactions: { migrated: number; skipped: number; failed: string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────

async function migrateUsers(): Promise<MigrationResult["users"]> {
  const db = getFirestore();
  let migrated = 0;
  let skipped = 0;
  const failed: string[] = [];

  console.log("📦 Starting user migration...");

  const snapshot = await db.collection("users").get();
  console.log(`   Found ${snapshot.size} users in Firestore.`);

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const firestoreId = doc.id; // This is usually the Firebase UID
    const userProfileDoc = await db.collection('userProfile').doc(firestoreId).get();
    const profileData = userProfileDoc.data();
    

    try {
      // Try to get the Firebase Auth record to confirm UID
      let firebaseUid =  firestoreId;
      try {
        await getAuth().getUser(firebaseUid);
      } catch {
        // If not found by stored uid, try the doc id
        try {
          await getAuth().getUser(firestoreId);
          firebaseUid = firestoreId;
        } catch {
          console.warn(`   ⚠️  No Firebase Auth record for ${firestoreId} — skipping.`);
          skipped++;
          continue;
        }
      }

      await prisma.user.upsert({
        where: { firebaseUid },
        create: {
          firebaseUid,
          transferUid: data.transferUid ?? firebaseUid,
          name: data.name ?? data.displayName ?? "Unknown",
          email: data.email ?? "",
          phone: data.phone ?? data.phoneNumber ?? "",
          role: data.role ?? "user",
          active: data.active ?? data.isActive ?? true,
          referralCode: data.referralCode ?? generateReferralCode(),
          referredBy: data.referredBy ?? null,
          notificationsEnabled: data.notificationsEnabled ?? true,
          notificationToken: data.notificationToken ?? data.fcmToken ?? null,
          createdAt: data.createdAt?.toDate?.() ?? new Date(),
          updatedAt: data.updatedAt?.toDate?.() ?? new Date(),
          // Create wallet immediately
          wallet: {
            create: {
              fiat: {
                create: {
                  availableBalance: data.wallet.fiat.availableBalance ?? data.balance ?? 0,
                  lockedBalance: data.wallet.fiat.lockedBalance ?? 0,
                  rewardBalance: data.wallet.fiat.rewardBalance ?? 0,
                },
              },
            },
          },
          // Create user profile
          userProfile: {
            create: {
              bio: profileData!.bio ?? "",
              avatarUrl: profileData!.avatar  ?? "",
              badges: data.badges ?? [],
              isVerified: data.isVerified ?? false,
              isPrivate: data.isPrivate ?? false,
              followersCount: data.followersCount ?? 0,
              followingCount: data.followingCount ?? 0,
              postCount: profileData!.postCount ?? 0,
              totalEarnings: profileData!.totalEarnings ?? 0,
            },
          },
        },
        update: {
          // On re-run: only update mutable fields, don't overwrite wallet/profile
          name: data.name ?? data.displayName,
          phone: data.phone ?? data.phoneNumber ?? "",
          referralCode: data.referralCode ?? undefined,
          referredBy: data.referredBy ?? undefined,
          notificationToken: data.notificationToken ?? data.fcmToken ?? null,
          active: data.active ?? data.isActive ?? true,
        },
      });

      migrated++;
      if (migrated % 50 === 0) console.log(`   ✅ Migrated ${migrated} users...`);
    } catch (e: any) {
      console.error(`   ❌ Failed to migrate user ${firestoreId}: ${e.message}`);
      failed.push(firestoreId);
    }
  }

  console.log(`✅ Users: ${migrated} migrated, ${skipped} skipped, ${failed.length} failed.\n`);
  return { migrated, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function migrateTransactions(): Promise<MigrationResult["transactions"]> {
  const db = getFirestore();
  let migrated = 0;
  let skipped = 0;
  const failed: string[] = [];

  console.log("💳 Starting transaction migration...");

  // Build a map of firebaseUid → postgres userId for lookups
  const users = await prisma.user.findMany({ select: { id: true, firebaseUid: true } });
  const uidToId = Object.fromEntries(users.map((u) => [u.firebaseUid, u.id]));

  // Handle both "transactions" and "transfers" collections
  const collections = ["transactions", "transfers"];

  for (const collectionName of collections) {
    const snapshot = await db.collection(collectionName).get();
    console.log(`   Found ${snapshot.size} docs in ${collectionName}.`);

    for (const doc of snapshot.docs) {
      const data = doc.data();

      try {
        // Determine the postgres userId
        const firebaseUid = data.userId ?? data.uid ?? data.firebaseUid;
        const postgresUserId = uidToId[firebaseUid];

        if (!postgresUserId) {
          console.warn(`   ⚠️  No Postgres user found for uid ${firebaseUid} (doc ${doc.id})`);
          skipped++;
          continue;
        }

        // Normalise status
        const rawStatus = (data.status ?? "success").toLowerCase();
        const status =
          rawStatus === "successful" || rawStatus === "success"
            ? "success"
            : rawStatus === "pending"
            ? "pending"
            : "failed";

        // Normalise type
        const type =
          (data.type ?? "").toLowerCase().includes("credit") ||
          (data.type ?? "").toLowerCase().includes("deposit") ||
          (data.type ?? "").toLowerCase().includes("fund")
            ? "credit"
            : "debit";

        await prisma.transaction.upsert({
          where: {
            // Use clientRequestId if present, otherwise use doc.id
            clientRequestId: data.clientRequestId ?? doc.id,
          },
          create: {
            userId: postgresUserId,
            type,
            amount: data.amount ?? 0,
            transactionRef: data.transactionRef ?? data.reference ?? data.ref ?? null,
            clientRequestId: data.clientRequestId ?? doc.id,
            status: status as any,
            message: data.message ?? data.description ?? data.narration ?? null,
            metaData: { ...data, _migratedFrom: collectionName, _firestoreId: doc.id },
            createdAt: data.createdAt?.toDate?.() ?? new Date(),
            updatedAt: data.updatedAt?.toDate?.() ?? new Date(),
          },
          update: {
            status: status as any,
          },
        });

        migrated++;
      } catch (e: any) {
        console.error(`   ❌ Failed to migrate ${collectionName}/${doc.id}: ${e.message}`);
        failed.push(doc.id);
      }
    }
  }

  console.log(`✅ Transactions: ${migrated} migrated, ${skipped} skipped, ${failed.length} failed.\n`);
  return { migrated, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// KYC
// ─────────────────────────────────────────────────────────────────────────────

async function migrateKyc(): Promise<void> {
  const db = getFirestore();
  let migrated = 0;

  const kycSnap = await db.collection("kyc").get();
  if (kycSnap.empty) {
    console.log("ℹ️  No kyc collection found — skipping.\n");
    return;
  }

  const users = await prisma.user.findMany({ select: { id: true, firebaseUid: true } });
  const uidToId = Object.fromEntries(users.map((u) => [u.firebaseUid, u.id]));

  console.log("🪪 Starting KYC migration...");

  for (const doc of kycSnap.docs) {
    const data = doc.data();
    const postgresUserId = uidToId[data.userId ?? doc.id];
    if (!postgresUserId) continue;

    await prisma.kyc.upsert({
      where: { userId: postgresUserId },
      create: {
        userId: postgresUserId,
        status: data.status ?? "unverified",
        document: data.document ?? data.documents ?? null,
        createdAt: data.createdAt?.toDate?.() ?? new Date(),
        updatedAt: data.updatedAt?.toDate?.() ?? new Date(),
      },
      update: { status: data.status ?? "unverified" },
    });
    migrated++;
  }

  console.log(`✅ KYC: ${migrated} records migrated.\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

export async function migrationRunner(): Promise<MigrationResult> {
  console.log("\n🚀 Starting Firebase → Postgres migration\n");
  const start = Date.now();

  const userResult = await migrateUsers();
  const txResult = await migrateTransactions();
  await migrateKyc();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n🏁 Migration complete in ${elapsed}s\n`);

  return { users: userResult, transactions: txResult };
}

// Run directly with ts-node
if (require.main === module) {
  
  migrationRunner()
    .then((result) => {
      console.log("Final result:", JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error("Migration failed:", e);
      process.exit(1);
    });
}