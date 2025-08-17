import { getMessaging } from 'firebase-admin/messaging';

export const sendNotification = async (fcmToken: string, title: string, body: string) => {
  const message = {
    token: fcmToken,
    notification: { title, body },
    data: { click_action: 'FLUTTER_NOTIFICATION_CLICK' },
  };

  try {
    await getMessaging().send(message);
    console.log('Sent to:', fcmToken.substring(0, 10) + '...');
  } catch (error: any) {
    console.error('FCM Error:', error.code, error.message);
  }
};