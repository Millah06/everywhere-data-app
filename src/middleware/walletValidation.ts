// backend/middleware/walletValidation.ts

import { Request, Response, NextFunction } from 'express';

export const validateSufficientBalance = (requiredAmount: number) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.uid; // Assuming Firebase Auth middleware sets this
      
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Assume wallet helper exists
      const { getWalletBalance } = require('../helpers/walletHelper');
      const balance = await getWalletBalance(userId);

      if (balance < requiredAmount) {
        return res.status(400).json({
          error: 'Insufficient balance',
          required: requiredAmount,
          available: balance,
        });
      }

      req.walletBalance = balance;
      next();
    } catch (error) {
      console.error('Wallet validation error:', error);
      res.status(500).json({ error: 'Failed to validate wallet balance' });
    }
  };
};