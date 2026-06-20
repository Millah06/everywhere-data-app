// prisma/seed_phase1_trust.ts
//
// PHASE 1 — FOUNDATION (data backfill)
//
// One-off backfill: every EXISTING approved vendor gets a MerchantTrustProfile
// at level 1 so current sellers are not gated out the moment the trust system
// goes live (level 0 = cannot sell / not publicly visible).
//
// Level 1 settings come from the trust table:
//   level 1 (Identity) → settlementDelayHours 48, dailyWithdrawalLimit ₦50,000
//
// SAFETY:
//   • Idempotent — uses upsert on the unique `vendorId`, so re-running it does
//     not create duplicates and will not downgrade a vendor already promoted.
//   • Only touches APPROVED vendors. Pending/rejected vendors stay at the
//     model default (level 0) until they verify.
//
// RUN (after the phase1_foundation migration is applied + client generated):
//   npx ts-node prisma/seed_phase1_trust.ts
//   # or: npx tsx prisma/seed_phase1_trust.ts
//
// ⚠️ This writes to whichever database DATABASE_URL points at. Run against
//    staging first; running against the live DB is a gated step — confirm before.
//
import { prisma } from "../src/prisma";

async function main() {
  const approved = await prisma.vendor.findMany({
    where: { status: "approved" },
    select: { id: true, name: true },
  });

  console.log(`Found ${approved.length} approved vendor(s) to backfill.`);

  let created = 0;
  let skipped = 0;

  for (const v of approved) {
    const result = await prisma.merchantTrustProfile.upsert({
      where: { vendorId: v.id },
      // If a profile already exists we leave it untouched (no downgrade).
      update: {},
      create: {
        vendorId: v.id,
        level: 1,
        // They are already approved & selling — treat identity/phone as met so
        // the level-1 gate is satisfied. Adjust if your KYC policy differs.
        identityVerified: true,
        phoneVerified: true,
        settlementDelayHours: 48,
        dailyWithdrawalLimit: 50000,
      },
    });
    if (result.level === 1) created++;
    else skipped++;
    console.log(` • ${v.name} (${v.id}) → level ${result.level}`);
  }

  console.log(`Done. Newly seeded: ${created}, left as-is: ${skipped}.`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });