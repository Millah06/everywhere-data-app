/**
 * Firebase → Postgres Migration
 * ─────────────────────────────
 * Copies users from Firestore into the Postgres schema.
 *
 * Usage:
 *   ts-node src/utils/migration.ts
 *   or POST /admin/migrate to trigger via HTTP.
 *
 * Safe to re-run: uses upsert so duplicate runs won't double-insert.
 */

import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { prisma } from "./prisma";
import { generateReferralCode } from "./shared/utils/generateRefferalCode";

interface MigrationResult {
  users: { migrated: number; skipped: number; failed: Array<{ id: string; reason: string }> };
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────

async function migrateUsers(): Promise<MigrationResult["users"]> {
  const db = getFirestore();
  let migrated = 0;
  let skipped = 0;
  // Changed from string[] to objects so you can see WHY each user failed
  const failed: Array<{ id: string; reason: string }> = [];

  console.log("📦 Starting user migration...");

  const snapshot = await db.collection("users").get();
  console.log(`   Found ${snapshot.size} users in Firestore.\n`);

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const firestoreId = doc.id;

    try {
      // ── 1. Confirm the Firebase Auth record exists ──────────────────────
      // firestoreId IS the Firebase UID in your setup, so one check is enough.
      try {
        await getAuth().getUser(firestoreId);
      } catch {
        console.warn(`   ⚠️  No Firebase Auth record for ${firestoreId} — skipping.`);
        skipped++;
        continue;
      }

      const firebaseUid = firestoreId;

      // ── 2. Safely read wallet balances with optional chaining ───────────
      //
      // THIS WAS THE BUG:
      //   data.wallet.fiat.lockedBalance  →  crashes if wallet or fiat is undefined
      //
      // Fix: use ?. so accessing a missing field returns undefined, not a crash.
      // The ?? 0 then gives a safe default.
      //
      // Your Firestore wallet structure may be flat (data.availableBalance) or
      // nested (data.wallet.fiat.availableBalance) — both are handled below.
      const availableBalance =
        data.wallet?.fiat?.availableBalance ??  // nested: wallet.fiat.availableBalance
        data.wallet?.availableBalance ??         // semi-nested: wallet.availableBalance
        data.availableBalance ??                 // flat: availableBalance
        data.balance ??                          // flat legacy: balance
        0;

      const lockedBalance =
        data.wallet?.fiat?.lockedBalance ??
        data.wallet?.lockedBalance ??
        data.lockedBalance ??
        0;

      const rewardBalance =
        data.wallet?.fiat?.rewardBalance ??
        data.wallet?.rewardBalance ??
        data.rewardBalance ??
        0;

      // ── 3. Upsert user + wallet + profile ──────────────────────────────
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
          referralCode: generateReferralCode(),
          referredBy: data.referredBy ?? null,
          notificationsEnabled: data.notificationsEnabled ?? true,
          notificationToken: data.notificationToken ?? data.fcmToken ?? null,
          createdAt: data.createdAt?.toDate?.() ?? new Date(),
          updatedAt: data.updatedAt?.toDate?.() ?? new Date(),
          wallet: {
            create: {
              fiat: {
                create: {
                  availableBalance,
                  lockedBalance,
                  rewardBalance,
                },
              },
            },
          },
          userProfile: {
            create: {
              bio: data.bio ?? "",
              // You had data.avatar — check your actual Firestore field name
              avatarUrl: data?.avatarUrl ?? data?.avatar ?? data?.photoURL ?? "",
              badges: data?.badges ?? [],
              isVerified: data?.isVerified ?? false,
              isPrivate: data?.isPrivate ?? false,
              followersCount: data?.followersCount ?? 0,
              followingCount: data?.followingCount ?? 0,
              postCount: data?.postCount ?? 0,
              totalEarnings: data?.totalEarnings ?? 0,
            },
          },
        },
        update: {
          // Re-run safe: only update fields that can legitimately change.
          // Wallet/profile are NOT updated here — they have their own upsert
          // path below if you need to sync balances on re-runs.
          name: data.name ?? data.displayName ?? undefined,
          phone: data.phone ?? data.phoneNumber ?? "",
          referralCode: data.referralCode ?? undefined,
          referredBy: data.referredBy ?? undefined,
          notificationToken: data.notificationToken ?? data.fcmToken ?? null,
          active: data.active ?? data.isActive ?? true,
        },
      });

      // ── 4. Sync wallet balance on re-runs ───────────────────────────────
      // The upsert above only creates the wallet on first run.
      // On re-runs, update balances separately so they stay in sync.
      await prisma.fiat.updateMany({
        where: { wallet: { userId: (await prisma.user.findUnique({
          where: { firebaseUid },
          select: { id: true },
        }))!.id }},
        data: { availableBalance, lockedBalance, rewardBalance },
      });

      migrated++;
      if (migrated % 10 === 0) {
        console.log(`   ✅ ${migrated} migrated so far...`);
      }

    } catch (e: any) {
      // Log the FULL error message and stack so you can actually debug it
      console.error(`   ❌ Failed [${firestoreId}]: ${e.message}`);
      if (e.code) console.error(`      Prisma error code: ${e.code}`);
      failed.push({ id: firestoreId, reason: e.message });
    }
  }

  console.log(`\n✅ Users done: ${migrated} migrated, ${skipped} skipped, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log("\nFailed IDs:");
    failed.forEach((f) => console.log(`  • ${f.id}: ${f.reason}`));
  }

  return { migrated, skipped, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

export async function migrationRunner(): Promise<MigrationResult> {
  console.log("\n🚀 Starting Firebase → Postgres migration\n");
  const start = Date.now();

  const userResult = await migrateUsers();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n🏁 Migration complete in ${elapsed}s\n`);

  return { users: userResult };
}

// Run directly: ts-node src/utils/migration.ts
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