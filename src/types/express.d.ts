import "express";

export type AuthenticatedUser = {
  id: string;
  uid: string;
  email: string | null;
  role: "user" | "vendor" | "admin";
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      walletBalance?: number;
    }
  }
}

export {};
