// src/utils/checkAuth.ts
import admin from "./firebase";

export async function checkAuth(req: any): Promise<string> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }

  const token = authHeader.split("Bearer ")[1];
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded.uid;
}

