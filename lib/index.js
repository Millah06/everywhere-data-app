"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const sendAirtime_1 = __importDefault(require("./airtime/sendAirtime"));
const buyData_1 = __importDefault(require("./data/buyData"));
const verifyMerchant_1 = __importDefault(require("./cable/verifyMerchant"));
const purchaseTV_1 = __importDefault(require("./cable/purchaseTV"));
const verifyMeter_1 = __importDefault(require("./electricity/verifyMeter"));
const purchaseElectric_1 = __importDefault(require("./electricity/purchaseElectric"));
// import other functions here too if needed
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true }));
app.use(express_1.default.json());
app.post("/airtime/sendAirtime", sendAirtime_1.default);
app.post("/cable/purchaseTV", purchaseTV_1.default);
app.post("/cable/verifyMerchant", verifyMerchant_1.default);
app.post("/data/buyData", buyData_1.default);
app.post("/electricity/verifyMeter", verifyMeter_1.default);
app.post("/electricity/purchaseElectric", purchaseElectric_1.default);
// add more like: app.post("/wallet/fund", handleFundWallet)
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
