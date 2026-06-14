import cron from "node-cron";
import {
  runAutoCancelJob,
  runAutoReleaseJob,
  runPodAutoConfirmJob
} from "../modules/marketPlace/escow/autoReleaseJob";
import { runTrustUpgradeJob } from "../modules/trust/trust.cron";
import { runPaymentRecoveryJob } from "./paymentRecovery";
import { runChatCleanupJob } from "./chatCleanup";
import { runSettlementJob } from "../modules/marketPlace/settlement/settlement.service";

export const startJobs = () => {
  
  // Phase 6 legacy auto-release (every hour): release holds whose autoReleaseAt has come due. This is the backup safety for any holds that fail to release through the normal settlement flow; once settlement is fully rolled out and stable we can remove this job and the `autoReleaseAt` column.
  // cron.schedule("0 * * * *", async () => {
  //   await runAutoReleaseJob();
  // });

  cron.schedule("*0 * * * *", async () => {
    // Runs every minute — lightweight, only touches pending orders older than 30 min
    await runAutoCancelJob();
  });
  
  // Phase 7 POD auto-confirm (every minute): confirm orders left "accepted" for 24 hours.
  cron.schedule("* * * * *", async () => {
    await runPodAutoConfirmJob();
  });

  // Phase 6 settlement (every 5 min): roll due PENDING holds → Available.
  // Replaces auto-release for the new settlement model. Migration-safe no-op
  // until the MerchantBalance/SettlementHold tables exist (fails closed).
  cron.schedule("*/5 * * * *", async () => {
    await runSettlementJob();
  });

  // Nightly (~02:00) — promote L1→L2 when criteria are met, sync settlement
  // columns. Migration-safe no-op until the trust table exists.
  cron.schedule("0 2 * * *", async () => {
    await runTrustUpgradeJob();
  });

  // Payment recovery (spec §13): re-query stuck OPay payments, expire stale
  // CREATED sessions, retry failed dispatch. Migration-safe no-op until the
  // Payment table exists.
  cron.schedule("*/5 * * * *", async () => {
    await runPaymentRecoveryJob();
  });

  // Chat cost control (hourly, off the :00 mark): delete Firestore messages
  // whose `expireAt` has passed. Clients keep history in their local Hive
  // cache, so this only trims the transport copy. Runs in batches of 400.
  cron.schedule("17 * * * *", async () => {
    await runChatCleanupJob();
  });
};