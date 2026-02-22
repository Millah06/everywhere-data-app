"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendNotification = void 0;
const messaging_1 = require("firebase-admin/messaging");
const sendNotification = (fcmToken, title, body) => __awaiter(void 0, void 0, void 0, function* () {
    const message = {
        token: fcmToken,
        notification: { title, body },
        data: { click_action: 'FLUTTER_NOTIFICATION_CLICK' },
    };
    try {
        yield (0, messaging_1.getMessaging)().send(message);
        console.log('Sent to:', fcmToken.substring(0, 10) + '...');
    }
    catch (error) {
        console.error('FCM Error:', error.code, error.message);
    }
});
exports.sendNotification = sendNotification;
