import "./config/firebase"
import app from "./app" 
import { startJobs } from "./jobs";

 
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    startJobs();
});

