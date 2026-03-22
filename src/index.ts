import "./config/firebase"
import app from "./app" 
import { startJobs } from "./jobs";

// import { prisma } from "./lib/prisma";
// await prisma.appConfig.upsert({
//   where: { id: "singleton" },
//   update: {},
//   create: {
//     id: "singleton",
//     transactionFeePercent: 0,
//     autoReleaseHours: 24,
//     appealWindowHours: 48,
//     chatCloseHours: 72,
//     commissionPercent: 5,
//   },
// });

 


 

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    startJobs();
});

