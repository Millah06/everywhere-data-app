import cron from "node-cron";
import {
  runAutoCancelJob,
  runAutoReleaseJob,
} from "../modules/marketPlace/escow/autoReleaseJob";
import { runTrustUpgradeJob } from "../modules/trust/trust.cron";

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
  
};
