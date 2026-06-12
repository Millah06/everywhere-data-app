// src/modules/users/controllers/updateRegion.controller.ts
//
// PHASE 9 — Home-country setting (server side).
//
// PATCH /users/me/region   Body: { country: "NG" | "CN" | ... }
//
// Lets a user declare their home country. This is the diaspora fix: a
// Nigerian who registered with a foreign SIM (+86 etc.) sets country=NG here
// and the NG-tied gate (phone +234 OR country NG) opens for them.
//
// Deliberately narrow: ONLY `country` is writable (plus currency snapped to
// NGN when claiming NG). Phone, role, balances are untouchable through this
// endpoint. ISO alpha-2 validated; anything else is a 400.

import { prisma } from "../../../prisma";

const updateRegion = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { country } = req.body;

    if (
      !country ||
      typeof country !== "string" ||
      !/^[A-Za-z]{2}$/.test(country.trim())
    ) {
      return res.status(400).json({
        message: "country must be a 2-letter ISO code, e.g. 'NG'.",
      });
    }

    const iso = country.trim().toUpperCase();

    // Claiming NG also snaps display currency to NGN — the only transacting
    // currency in the app (binding Phase 9 decision). For other countries we
    // record the country ONLY; currency stays as-is until Phase 10 (coins)
    // decides what non-NG currency display means.
    const data: any = { country: iso };
    if (iso === "NG") data.currency = "NGN";

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        country: true,
        currency: true,
        phone: true,
      },
    });

    return res.json({ user, message: "Region updated." });
  } catch (e: any) {
    console.error("[updateRegion]", e);
    return res.status(500).json({ message: e.message });
  }
};

export default { updateRegion };