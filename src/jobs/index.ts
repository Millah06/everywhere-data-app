import cron from "node-cron";
import {
  runAutoCancelJob,
  runAutoReleaseJob,
} from "../modules/marketPlace/escow/autoReleaseJob";
import { runTrustUpgradeJob } from "../modules/trust/trust.cron";
import { runPaymentRecoveryJob } from "./paymentRecovery";

export const startJobs = () => {
  cron.schedule("0 * * * *", async () => {
    await runAutoReleaseJob();
  });

  cron.schedule("* * * * *", async () => {
    // Runs every minute — lightweight, only touches pending orders older than 30 min
    await runAutoCancelJob();
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
  
};
