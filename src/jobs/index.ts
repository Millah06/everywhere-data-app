import cron from "node-cron";
import {
  runAutoCancelJob,
  runAutoReleaseJob,
} from "../modules/marketPlace/escow/autoReleaseJob";

export const startJobs = () => {
  cron.schedule("0 * * * *", async () => {
    await runAutoReleaseJob();
  });

  cron.schedule("* * * * *", async () => {
    // Runs every minute — lightweight, only touches pending orders older than 30 min
    await runAutoCancelJob();
  });
};
