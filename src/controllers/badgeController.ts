// backend/controllers/badgeController.ts

import admin from 'firebase-admin';

const db = admin.firestore();

const BADGE_TYPES = {
  kyc_blue: 'KYC Verified',
  premium_paid: 'Premium Member',
  business: 'Business Account',
  creator_earnings: 'Top Creator',
} as const;

const awardBadge = async (req: any, res: any) => {
  try {
    const adminId = req.user?.uid;
    const { userId, badgeType, expiresAt, metadata } = req.body;

    // TODO: Verify admin permissions
    // if (!isAdmin(adminId)) return res.status(403).json({ error: 'Unauthorized' });

    if (!userId || !badgeType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!Object.keys(BADGE_TYPES).includes(badgeType)) {
      return res.status(400).json({ error: 'Invalid badge type' });
    }

    const badgeRef = db.collection('userBadges').doc(userId);
    const badgeDoc = await badgeRef.get();

    const badgeData = {
      awarded: true,
      awardedAt: admin.firestore.FieldValue.serverTimestamp(),
      awardedBy: adminId,
      ...(expiresAt && { expiresAt: admin.firestore.Timestamp.fromDate(new Date(expiresAt)) }),
      ...(metadata && { metadata }),
    };

    if (badgeDoc.exists) {
      await badgeRef.update({
        [`badges.${badgeType}`]: badgeData,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await badgeRef.set({
        userId,
        badges: {
          [badgeType]: badgeData,
        },
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ success: true, message: `Badge ${badgeType} awarded to user` });
  } catch (error: any) {
    console.error('Award badge error:', error);
    res.status(500).json({ error: 'Failed to award badge' });
  }
};

const revokeBadge = async (req: any, res: any) => {
  try {
    const adminId = req.user?.uid;
    const { userId, badgeType } = req.body;

    // TODO: Verify admin permissions

    if (!userId || !badgeType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await db.collection('userBadges').doc(userId).update({
      [`badges.${badgeType}.awarded`]: false,
      [`badges.${badgeType}.revokedAt`]: admin.firestore.FieldValue.serverTimestamp(),
      [`badges.${badgeType}.revokedBy`]: adminId,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: `Badge ${badgeType} revoked from user` });
  } catch (error: any) {
    console.error('Revoke badge error:', error);
    res.status(500).json({ error: 'Failed to revoke badge' });
  }
};

const getUserBadges = async (req: any, res: any) => {
  try {
    const { userId } = req.params;

    const badgeDoc = await db.collection('userBadges').doc(userId).get();

    if (!badgeDoc.exists) {
      return res.json({ success: true, badges: {} });
    }

    const badges = badgeDoc.data()?.badges || {};
    
    // Filter only awarded badges that haven't expired
    const now = Date.now();
    const activeBadges = Object.entries(badges).reduce((acc: any, [type, data]: [string, any]) => {
      if (data.awarded) {
        const expiresAt = data.expiresAt?.toMillis();
        if (!expiresAt || expiresAt > now) {
          acc[type] = {
            ...data,
            awardedAt: data.awardedAt?.toMillis(),
            expiresAt: expiresAt || null,
          };
        }
      }
      return acc;
    }, {});

    res.json({ success: true, badges: activeBadges });
  } catch (error: any) {
    console.error('Get badges error:', error);
    res.status(500).json({ error: 'Failed to get badges' });
  }
};

export default {
  awardBadge,
  revokeBadge,
  getUserBadges,
};