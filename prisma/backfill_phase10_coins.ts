import { prisma } from "../src/prisma";
// Legacy single-pool `balance` was fully convertible, so we grandfather it into
// earnedCoins; purchasedCoins starts at 0. Idempotent: only rows where the split
// hasn't been populated yet (earnedCoins == 0 && purchasedCoins == 0 && balance > 0).
async function main() {
  const rows = await prisma.userCoins.findMany();
  let migrated = 0;
  for (const r of rows) {
    const purchased = (r as any).purchasedCoins ?? 0;
    const earned = (r as any).earnedCoins ?? 0;
    if (purchased === 0 && earned === 0 && r.balance > 0) {
      await prisma.userCoins.update({
        where: { userId: r.userId },
        data: { earnedCoins: r.balance, purchasedCoins: 0 }, // balance stays = sum
      });
      migrated++;
    }
  }
  console.log(`Backfilled ${migrated} / ${rows.length} coin ledgers.`);
}
main().finally(() => process.exit(0));