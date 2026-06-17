// =============================================================================
// src/modules/social/controllers/surveyController.ts
// -----------------------------------------------------------------------------
// PHASE 11 — SURVEYS (the second wedge: "ask real humans, get real answers")
// =============================================================================
//
// WHAT A SURVEY IS, MECHANICALLY
// ------------------------------
// A survey is NOT a separate kind of object floating beside posts. It is a
// normal `Post` with `postType = "survey"`, plus a `Survey` row that hangs off
// that post and owns the questions/options. That choice is deliberate:
//   - It rides the EXISTING feed (the ranking engine already returns it),
//   - It rides the EXISTING share/deep-link surface (amril.app/post/:id),
//   - The PostCard just branches on postType to render the survey UI (Pass 3).
// So a survey is "a post that happens to be answerable."
//
// THE FIVE ENDPOINTS (one mental model each)
// ------------------------------------------
//   createSurvey   — author builds it; if it pays coins, the author ESCROWS the
//                    whole reward budget up front (so respondents can never be
//                    stiffed mid-survey).
//   getSurvey      — render the survey + "have I answered?" + "may I answer?".
//   submitResponse — validate answers, store them, PAY the respondent (if
//                    eligible + budget remains), all in ONE transaction.
//   getResults     — tallies + insight breakdowns, gated by resultVisibility.
//   closeSurvey    — author ends it; UNSPENT budget is refunded (safely).
//
// THE ANONYMITY RULE (most important design lesson in this file)
// --------------------------------------------------------------
// "Anonymous" does NOT mean "we don't know who answered." We ALWAYS store the
// respondent id, because we need it for three non-negotiable reasons:
//   1. FRAUD / DEDUP — one answer per account (DB-enforced unique).
//   2. PAYOUT — we must know who to pay the reward coins to.
//   3. INTEGRITY — so a deleted account's answers can be cleanly handled.
// Anonymity is a DISCLOSURE rule, not a storage rule: when survey.anonymous is
// true we simply never reveal the respondent id in any result/insight payload.
// The user-facing privacy policy must say exactly this in plain words.
//
// THE COIN / ANTI-FRAUD MODEL (read carefully — real money-adjacent value)
// -----------------------------------------------------------------------
// Coins have two buckets (see coin.helpers.ts): PURCHASED (spend-only, can never
// be cashed out) and EARNED (convertible to wallet for NG-tied users). Survey
// rewards interact with both, and the rules below exist to stop laundering and
// bot-farming:
//
//   • ESCROW AT CREATION: the author's whole `rewardBudget` is debited up front
//     via spendCoins(). This guarantees liquidity for every promised reward.
//
//   • PAYOUT = EARNED: a respondent's reward is credited as EARNED coins
//     (creditEarnedCoins) — same as a gift received. That's the intended way
//     value flows to people who contribute.
//
//   • REFUND = PURCHASED  ⚠️ CRITICAL: when a survey closes, unspent budget is
//     refunded to the author as PURCHASED (spend-only) coins, NEVER earned.
//     If we refunded as EARNED, an attacker could: buy purchased coins → escrow
//     them → close the survey → receive them back as EARNED → cash out. That
//     turns the spend-only rail into a cash-out rail = laundering. Refunding as
//     purchased closes that hole. (Mild downside: if the author had spent some
//     EARNED coins into the escrow, they come back as purchased. We accept that
//     conservative trade for safety; comment kept so future-you doesn't "fix" it.)
//
//   • REWARD ELIGIBILITY: a brand-new throwaway account does not get paid. A
//     respondent must pass isRewardEligible() (account age gate, extensible to
//     KYC/phone). Ineligible users can STILL answer — their data counts — they
//     just aren't paid. This keeps data open while denying bot farms the payout.
//
//   • ONE PER ACCOUNT: @@unique([surveyId, respondentId]) at the DB level. Even
//     a race that slips past our app check is rejected by Postgres.
//
//   • NEVER YOUR OWN SURVEY: authors can't answer (or be paid by) their own
//     survey.
// =============================================================================

import { prisma } from "../../../prisma";
import {
  spendCoins,
  creditEarnedCoins,
  creditPurchasedCoins,
  isNgTied,
} from "../../../shared/helpers/coin.helpers";

// -----------------------------------------------------------------------------
// TUNABLES (anti-fraud + limits live here so policy changes don't touch logic)
// -----------------------------------------------------------------------------

/** A respondent must be at least this old (account age, days) to be PAID a
 *  reward. They can still answer if younger — they just don't get coins. Raise
 *  this if you see farming. */
const REWARD_MIN_ACCOUNT_AGE_DAYS = 3;

/** Hard ceilings so a malformed/abusive create request can't build a monster
 *  survey or escrow an absurd amount. Tune freely. */
const MAX_QUESTIONS = 25;
const MAX_OPTIONS_PER_QUESTION = 12;
const MAX_REWARD_COINS_PER_RESPONSE = 1000;

/** OPTIONAL platform fee on the escrowed reward budget (coin-rail breakage =
 *  your revenue). Left at 0 so this file needs no new RevenueSource enum value.
 *  To monetise: set > 0 AND uncomment the recordRevenue hook in createSurvey
 *  AFTER adding a `survey_fee` value to the RevenueSource enum. */
const SURVEY_FEE_RATE = 0;

// Mirror of the Prisma enums (kept as string unions for readable validation).
type QuestionType =
  | "single_choice"
  | "multi_choice"
  | "scale"
  | "short_text"
  | "nps";
const QUESTION_TYPES: QuestionType[] = [
  "single_choice",
  "multi_choice",
  "scale",
  "short_text",
  "nps",
];
type Audience = "everyone" | "followers" | "ng_only";
type ResultVisibility =
  | "after_vote"
  | "after_close"
  | "author_only"
  | "always";

// =============================================================================
// SHARED HELPERS
// =============================================================================

/** Account-age reward gate. Returns true if this user may be PAID. */
function isRewardEligible(user: { createdAt: Date }): boolean {
  const ageDays =
    (Date.now() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays >= REWARD_MIN_ACCOUNT_AGE_DAYS;
}

/**
 * Can this viewer ANSWER this survey, given its audience targeting?
 * Returns { ok, reason } so the caller can show a precise message.
 *  - everyone  → always
 *  - followers → viewer must follow the author
 *  - ng_only   → viewer must be NG-tied (diaspora gate reuse)
 */
async function audienceAllows(
  audience: Audience,
  authorId: string,
  viewer: { id: string; phone: string | null; country: string | null },
): Promise<{ ok: boolean; reason?: string }> {
  if (audience === "everyone") return { ok: true };

  if (audience === "ng_only") {
    return isNgTied(viewer)
      ? { ok: true }
      : { ok: false, reason: "This survey is for Nigeria-based users." };
  }

  if (audience === "followers") {
    const follow = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: viewer.id,
          followingId: authorId,
        },
      },
    });
    return follow
      ? { ok: true }
      : { ok: false, reason: "Only followers can answer this survey." };
  }

  return { ok: true };
}

/**
 * Validate the question/option payload at CREATE time. Returns an error string
 * or null. We validate hard here so the stored survey is always renderable and
 * answerable — bad data caught at the door, not at vote time.
 */
function validateQuestions(questions: any[]): string | null {
  if (!Array.isArray(questions) || questions.length === 0)
    return "A survey needs at least one question.";
  if (questions.length > MAX_QUESTIONS)
    return `A survey can have at most ${MAX_QUESTIONS} questions.`;

  for (const [i, q] of questions.entries()) {
    if (!QUESTION_TYPES.includes(q.type))
      return `Question ${i + 1}: invalid type "${q.type}".`;
    if (typeof q.prompt !== "string" || q.prompt.trim().length === 0)
      return `Question ${i + 1}: prompt is required.`;

    if (q.type === "single_choice" || q.type === "multi_choice") {
      if (!Array.isArray(q.options) || q.options.length < 2)
        return `Question ${i + 1}: choice questions need at least 2 options.`;
      if (q.options.length > MAX_OPTIONS_PER_QUESTION)
        return `Question ${i + 1}: too many options (max ${MAX_OPTIONS_PER_QUESTION}).`;
      if (q.options.some((o: any) => typeof o !== "string" || !o.trim()))
        return `Question ${i + 1}: every option needs a label.`;
    }

    if (q.type === "scale") {
      const min = Number(q.scaleMin);
      const max = Number(q.scaleMax);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max)
        return `Question ${i + 1}: scale needs integer scaleMin < scaleMax.`;
    }
    // nps is a fixed 0..10 scale — no config needed; we set it on create.
    // short_text needs nothing.
  }
  return null;
}

// =============================================================================
// 1) CREATE  — POST /social/surveys   (authMiddleware)
// =============================================================================
const createSurvey = async (req: any, res: any) => {
  const authorId = req.user?.id;
  try {
    if (!authorId) return res.status(401).json({ error: "Auth required" });

    const {
      title,
      description = "",
      anonymous = true,
      audience = "everyone",
      resultVisibility = "after_vote",
      closesAt = null,
      rewardCoins = 0, // coins paid per completed response
      rewardBudget = 0, // total coins the author funds (escrowed up front)
      questions = [],
      // host-post fields (the survey is a Post under the hood):
      text = "",
      images = [],
      hashtags = [],
    } = req.body ?? {};

    // --- validation -----------------------------------------------------------
    if (typeof title !== "string" || !title.trim())
      return res.status(400).json({ error: "Survey title is required." });

    const qErr = validateQuestions(questions);
    if (qErr) return res.status(400).json({ error: qErr });

    const reward = Math.max(0, Math.floor(Number(rewardCoins) || 0));
    const budget = Math.max(0, Math.floor(Number(rewardBudget) || 0));
    if (reward > MAX_REWARD_COINS_PER_RESPONSE)
      return res
        .status(400)
        .json({ error: `Reward per response is capped at ${MAX_REWARD_COINS_PER_RESPONSE} coins.` });
    if (reward > 0 && budget < reward)
      return res
        .status(400)
        .json({ error: "Reward budget must cover at least one reward." });

    // Load the author for the host-post denormalized fields (same pattern as
    // createPost) — feed cards read these directly off the Post row.
    const author = await prisma.user.findUnique({
      where: { id: authorId },
      include: { userProfile: true },
    });
    if (!author) return res.status(404).json({ error: "User not found" });

    // --- build everything in ONE transaction ---------------------------------
    // If the coin escrow fails (insufficient coins), the whole thing rolls back
    // and no orphan post/survey is created. Atomicity is the point.
    const result = await prisma.$transaction(async (tx) => {
      // (a) ESCROW the reward budget first. If the author can't afford it, this
      //     throws INSUFFICIENT_COINS and aborts before we create anything.
      if (budget > 0) {
        await spendCoins(tx, authorId, budget);

        // OPTIONAL platform fee (off by default — see SURVEY_FEE_RATE note):
        // const fee = Math.floor(budget * SURVEY_FEE_RATE);
        // if (fee > 0) {
        //   await recordRevenue(tx, {
        //     source: "survey_fee",   // ← needs a new RevenueSource enum value
        //     track: "coin",
        //     amount: fee,
        //     refType: "survey",
        //     refId: post.id,
        //     idempotencyKey: `survey_fee:${post.id}`,
        //     note: "Survey reward platform fee",
        //   });
        // }
      }

      // (b) the host POST (postType = "survey")
      const post = await tx.post.create({
        data: {
          userId: authorId,
          userName: author.name || "Anonymous",
          userHandle: author.userProfile?.userName || "",
          userAvatar: author.userProfile?.avatarUrl || null,
          title: title.trim(),
          text: typeof text === "string" ? text : "",
          images: Array.isArray(images) ? images : [],
          hashtags: Array.isArray(hashtags) ? hashtags : [],
          postType: "survey",
        },
      });

      // (c) the SURVEY + nested questions + options. Prisma builds the whole
      //     tree in one go. We normalise scale/nps config here so stored rows
      //     are always self-describing for the renderer.
      const survey = await tx.survey.create({
        data: {
          postId: post.id,
          authorId,
          title: title.trim(),
          description: String(description ?? ""),
          anonymous: !!anonymous,
          audience: audience as Audience,
          resultVisibility: resultVisibility as ResultVisibility,
          closesAt: closesAt ? new Date(closesAt) : null,
          rewardCoins: reward,
          rewardBudget: budget,
          questions: {
            create: questions.map((q: any, qi: number) => ({
              type: q.type,
              prompt: q.prompt.trim(),
              order: qi,
              required: q.required !== false, // default required
              // scale config: explicit for "scale", fixed 0..10 for "nps"
              scaleMin:
                q.type === "nps" ? 0 : q.type === "scale" ? Number(q.scaleMin) : null,
              scaleMax:
                q.type === "nps" ? 10 : q.type === "scale" ? Number(q.scaleMax) : null,
              scaleMinLabel: q.scaleMinLabel ?? null,
              scaleMaxLabel: q.scaleMaxLabel ?? null,
              options:
                q.type === "single_choice" || q.type === "multi_choice"
                  ? {
                      create: q.options.map((label: string, oi: number) => ({
                        label: label.trim(),
                        order: oi,
                      })),
                    }
                  : undefined,
            })),
          },
        },
        include: { questions: { include: { options: true } } },
      });

      // keep UserProfile.postCount coherent (same as createPost)
      await tx.userProfile.updateMany({
        where: { userId: authorId },
        data: { postCount: { increment: 1 } },
      });

      return { post, survey };
    });

    return res.status(201).json({
      success: true,
      postId: result.post.id,
      survey: shapeSurvey(result.survey, {
        isAuthor: true,
        canSeeResults: true,
        myResponse: null,
        canRespond: false, // author can't answer their own survey
      }),
    });
  } catch (e: any) {
    if (e?.code === "INSUFFICIENT_COINS") {
      return res.status(400).json({
        error: "Not enough coins to fund the reward budget.",
        code: "INSUFFICIENT_COINS",
        available: e.available,
      });
    }
    console.error("createSurvey error:", e);
    return res.status(500).json({ error: "Failed to create survey" });
  }
};

// =============================================================================
// 2) GET  — GET /social/surveys/:surveyId   (optionalAuthMiddleware)
// =============================================================================
// Returns the survey to render, plus viewer-specific state: am I the author?
// have I answered? may I answer? may I see results yet? Guests get the survey
// with no per-viewer state (and can't answer).
// =============================================================================
// Shared: given a loaded survey (with questions+options) and a viewer, compute
// the per-viewer state (author? answered? can answer? can see results?) and
// return the shaped JSON. Both getSurvey (by surveyId) and getSurveyByPost (by
// postId) delegate here so the two paths can never drift apart.
async function resolveSurveyView(survey: any, viewerId: string | null) {
  const isAuthor = !!viewerId && viewerId === survey.authorId;

  // Have I already answered?
  let myResponse: { id: string } | null = null;
  if (viewerId && !isAuthor) {
    const r = await prisma.surveyResponse.findUnique({
      where: {
        surveyId_respondentId: { surveyId: survey.id, respondentId: viewerId },
      },
      select: { id: true },
    });
    myResponse = r ? { id: r.id } : null;
  }

  // May I answer? (closed/expired/audience/already-answered all block it)
  let canRespond = false;
  if (viewerId && !isAuthor && !myResponse && !isSurveyOver(survey)) {
    const viewer = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { id: true, phone: true, country: true },
    });
    if (viewer) {
      const gate = await audienceAllows(
        survey.audience as Audience,
        survey.authorId,
        viewer,
      );
      canRespond = gate.ok;
    }
  }

  const canSeeResults = maySeeResults(survey, {
    isAuthor,
    hasResponded: !!myResponse,
  });

  return shapeSurvey(survey, { isAuthor, canSeeResults, myResponse, canRespond });
}

const getSurvey = async (req: any, res: any) => {
  const viewerId = req.user?.id ?? null;
  try {
    const { surveyId } = req.params;
    const survey = await prisma.survey.findUnique({
      where: { id: surveyId },
      include: { questions: { include: { options: true }, orderBy: { order: "asc" } } },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found" });

    return res.json({
      success: true,
      survey: await resolveSurveyView(survey, viewerId),
    });
  } catch (e: any) {
    console.error("getSurvey error:", e);
    return res.status(500).json({ error: "Failed to fetch survey" });
  }
};

// =============================================================================
// 2b) GET BY POST  — GET /social/surveys/by-post/:postId  (optionalAuth)
// =============================================================================
// The feed only knows a post's id, not its surveyId. When PostCard sees a post
// with postType === "survey", it calls THIS to load the survey to render. We
// resolve via Survey.postId (which is @unique) and reuse the same viewer-state
// logic as getSurvey.
// =============================================================================
const getSurveyByPost = async (req: any, res: any) => {
  const viewerId = req.user?.id ?? null;
  try {
    const { postId } = req.params;
    const survey = await prisma.survey.findUnique({
      where: { postId },
      include: { questions: { include: { options: true }, orderBy: { order: "asc" } } },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found" });

    return res.json({
      success: true,
      survey: await resolveSurveyView(survey, viewerId),
    });
  } catch (e: any) {
    console.error("getSurveyByPost error:", e);
    return res.status(500).json({ error: "Failed to fetch survey" });
  }
};

// =============================================================================
// 3) RESPOND  — POST /social/surveys/:surveyId/respond   (authMiddleware)
// =============================================================================
// Body: { answers: [{ questionId, optionIds?: string[], scaleValue?: number,
//                     textValue?: string }] }
// Validates every required question is answered correctly, stores the response +
// answers, updates tallies, and pays the reward (if eligible + budget remains).
// All inside ONE transaction so a half-saved response can never exist.
// =============================================================================
const submitResponse = async (req: any, res: any) => {
  const respondentId = req.user?.id;
  try {
    if (!respondentId) return res.status(401).json({ error: "Auth required" });
    const { surveyId } = req.params;
    const { answers } = req.body ?? {};
    if (!Array.isArray(answers))
      return res.status(400).json({ error: "answers must be an array." });

    const survey = await prisma.survey.findUnique({
      where: { id: surveyId },
      include: { questions: { include: { options: true } } },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found" });

    // --- gate checks ----------------------------------------------------------
    if (survey.authorId === respondentId)
      return res.status(400).json({ error: "You can't answer your own survey." });
    if (isSurveyOver(survey))
      return res.status(400).json({ error: "This survey is closed." });

    const respondent = await prisma.user.findUnique({
      where: { id: respondentId },
      select: { id: true, phone: true, country: true, createdAt: true },
    });
    if (!respondent) return res.status(404).json({ error: "User not found" });

    const gate = await audienceAllows(
      survey.audience as Audience,
      survey.authorId,
      respondent,
    );
    if (!gate.ok) return res.status(403).json({ error: gate.reason });

    // already answered? (the DB unique is the real guard; this is a nicer error)
    const existing = await prisma.surveyResponse.findUnique({
      where: { surveyId_respondentId: { surveyId, respondentId } },
      select: { id: true },
    });
    if (existing)
      return res.status(409).json({ error: "You already answered this survey." });

    // --- validate answers against the questions ------------------------------
    // Build a quick lookup of questionId → question (+ valid option id set).
    const qById = new Map(survey.questions.map((q) => [q.id, q]));
    const answerByQ = new Map<string, any>();
    for (const a of answers) answerByQ.set(a.questionId, a);

    const normalized: Array<{
      questionId: string;
      optionIds: string[];
      scaleValue: number | null;
      textValue: string | null;
    }> = [];

    for (const q of survey.questions) {
      const a = answerByQ.get(q.id);
      const answered =
        a &&
        ((Array.isArray(a.optionIds) && a.optionIds.length > 0) ||
          a.scaleValue !== undefined ||
          (typeof a.textValue === "string" && a.textValue.trim().length > 0));

      if (!answered) {
        if (q.required)
          return res
            .status(400)
            .json({ error: `Please answer: "${q.prompt}"` });
        continue; // optional + skipped → fine
      }

      // Per-type validation. We never trust client ids/values.
      if (q.type === "single_choice" || q.type === "multi_choice") {
        const validIds = new Set(q.options.map((o) => o.id));
        const chosen: string[] = (a.optionIds ?? []).filter((id: string) =>
          validIds.has(id),
        );
        if (chosen.length === 0)
          return res.status(400).json({ error: `Invalid option for "${q.prompt}".` });
        if (q.type === "single_choice" && chosen.length > 1)
          return res
            .status(400)
            .json({ error: `Pick only one option for "${q.prompt}".` });
        normalized.push({ questionId: q.id, optionIds: chosen, scaleValue: null, textValue: null });
      } else if (q.type === "scale" || q.type === "nps") {
        const v = Number(a.scaleValue);
        const min = q.scaleMin ?? 0;
        const max = q.scaleMax ?? 10;
        if (!Number.isInteger(v) || v < min || v > max)
          return res
            .status(400)
            .json({ error: `Value out of range for "${q.prompt}".` });
        normalized.push({ questionId: q.id, optionIds: [], scaleValue: v, textValue: null });
      } else {
        // short_text
        const t = String(a.textValue ?? "").trim().slice(0, 2000);
        normalized.push({ questionId: q.id, optionIds: [], scaleValue: null, textValue: t });
      }
    }

    // --- snapshot demographics for cheap, historically-accurate breakdowns ----
    // (We snapshot at answer time so editing your profile later never rewrites
    //  past results.) Whether the respondent followed the author RIGHT NOW:
    const wasFollower = !!(await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId: respondentId,
          followingId: survey.authorId,
        },
      },
      select: { followerId: true },
    }));

    // --- decide reward BEFORE the transaction (cheap checks) ------------------
    const budgetLeft = survey.rewardBudget - survey.rewardSpent;
    const willReward =
      survey.rewardCoins > 0 &&
      budgetLeft >= survey.rewardCoins &&
      isRewardEligible(respondent);

    // --- write everything atomically -----------------------------------------
    await prisma.$transaction(async (tx) => {
      const response = await tx.surveyResponse.create({
        data: {
          surveyId,
          respondentId, // ALWAYS stored (anonymity is a disclosure rule)
          respondentCountry: respondent.country ?? null,
          respondentWasFollower: wasFollower,
          rewardPaid: willReward,
        },
      });

      // answers (one row per question; multi_choice = one row per chosen option)
      const answerRows: any[] = [];
      for (const n of normalized) {
        if (n.optionIds.length > 0) {
          for (const optionId of n.optionIds) {
            answerRows.push({
              responseId: response.id,
              questionId: n.questionId,
              optionId,
            });
          }
        } else {
          answerRows.push({
            responseId: response.id,
            questionId: n.questionId,
            scaleValue: n.scaleValue,
            textValue: n.textValue,
          });
        }
      }
      await tx.surveyAnswer.createMany({ data: answerRows });

      // bump denormalized tallies: option voteCounts (instant charts) ...
      const chosenOptionIds = normalized.flatMap((n) => n.optionIds);
      if (chosenOptionIds.length > 0) {
        await tx.surveyOption.updateMany({
          where: { id: { in: chosenOptionIds } },
          data: { voteCount: { increment: 1 } },
        });
      }

      // ... and the survey response count, plus reward spend if we're paying.
      await tx.survey.update({
        where: { id: surveyId },
        data: {
          responseCount: { increment: 1 },
          ...(willReward
            ? { rewardSpent: { increment: survey.rewardCoins } }
            : {}),
        },
      });

      // PAYOUT (earned coins — convertible, same as a gift received).
      if (willReward) {
        await creditEarnedCoins(tx, respondentId, survey.rewardCoins);
      }
    });

    return res.json({
      success: true,
      rewarded: willReward,
      coinsAwarded: willReward ? survey.rewardCoins : 0,
    });
  } catch (e: any) {
    // Unique-violation race (two submits at once): treat as already-answered.
    if (e?.code === "P2002")
      return res.status(409).json({ error: "You already answered this survey." });
    console.error("submitResponse error:", e);
    return res.status(500).json({ error: "Failed to submit response" });
  }
};

// =============================================================================
// 4) RESULTS  — GET /social/surveys/:surveyId/results   (optionalAuthMiddleware)
// =============================================================================
// Returns aggregate results + insight breakdowns, GATED by resultVisibility.
// This is what makes Amril a research tool, not a toy poll: per-question tallies
// PLUS breakdowns by country and by follower/non-follower.
// =============================================================================
const getResults = async (req: any, res: any) => {
  const viewerId = req.user?.id ?? null;
  try {
    const { surveyId } = req.params;
    const survey = await prisma.survey.findUnique({
      where: { id: surveyId },
      include: { questions: { include: { options: true }, orderBy: { order: "asc" } } },
    });
    if (!survey) return res.status(404).json({ error: "Survey not found" });

    const isAuthor = !!viewerId && viewerId === survey.authorId;
    let hasResponded = false;
    if (viewerId && !isAuthor) {
      const r = await prisma.surveyResponse.findUnique({
        where: { surveyId_respondentId: { surveyId, respondentId: viewerId } },
        select: { id: true },
      });
      hasResponded = !!r;
    }

    // VISIBILITY GATE — return a precise reason so the client shows the right
    // "results unlock after you vote / after it closes" message.
    if (!maySeeResults(survey, { isAuthor, hasResponded })) {
      return res.status(403).json({
        error: "Results are not available yet.",
        code: "RESULTS_LOCKED",
        visibility: survey.resultVisibility,
      });
    }

    // --- per-question tallies -------------------------------------------------
    // Choice questions read straight off the denormalized voteCounts (cheap).
    // Scale/nps/text need the raw answers, pulled per question (bounded).
    const questions = [];
    for (const q of survey.questions) {
      if (q.type === "single_choice" || q.type === "multi_choice") {
        const total = q.options.reduce((s, o) => s + o.voteCount, 0) || 0;
        questions.push({
          questionId: q.id,
          type: q.type,
          prompt: q.prompt,
          totalVotes: total,
          options: q.options
            .sort((a, b) => a.order - b.order)
            .map((o) => ({
              optionId: o.id,
              label: o.label,
              votes: o.voteCount,
              percent: total > 0 ? Math.round((o.voteCount / total) * 1000) / 10 : 0,
            })),
        });
      } else if (q.type === "scale" || q.type === "nps") {
        const rows = await prisma.surveyAnswer.findMany({
          where: { questionId: q.id, scaleValue: { not: null } },
          select: { scaleValue: true },
        });
        const values = rows.map((r) => r.scaleValue as number);
        questions.push({
          questionId: q.id,
          type: q.type,
          prompt: q.prompt,
          count: values.length,
          average:
            values.length > 0
              ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100
              : 0,
          distribution: tallyDistribution(values, q.scaleMin ?? 0, q.scaleMax ?? 10),
          // NPS score = %promoters(9-10) − %detractors(0-6), the standard formula.
          npsScore: q.type === "nps" ? computeNps(values) : undefined,
        });
      } else {
        // short_text → return recent answers (anonymized; capped).
        const rows = await prisma.surveyAnswer.findMany({
          where: { questionId: q.id, textValue: { not: null } },
          select: { textValue: true },
          orderBy: { id: "desc" },
          take: 100,
        });
        questions.push({
          questionId: q.id,
          type: q.type,
          prompt: q.prompt,
          count: rows.length,
          answers: rows.map((r) => r.textValue),
        });
      }
    }

    // --- insight breakdowns (the "research tool" payoff) ----------------------
    // From the snapshot fields on SurveyResponse → cheap, no joins, historically
    // accurate. Respondent identities are NEVER returned.
    //
    // COUNTRY: one groupBy. The `_count` field is typed as OPTIONAL by Prisma
    // (it only exists if you ask for it), so we read it with `?._all ?? 0` to
    // satisfy strict TypeScript — never `r._count._all`.
    //
    // FOLLOWER: instead of groupBy on a NULLABLE boolean (finicky to type and
    // would need a third "null/unknown" bucket), we run two explicit count()
    // queries. Clearer, and no `_count` typing dance.
    const [byCountry, followerYes, followerNo] = await Promise.all([
      prisma.surveyResponse.groupBy({
        by: ["respondentCountry"],
        where: { surveyId },
        _count: { _all: true },
      }),
      prisma.surveyResponse.count({
        where: { surveyId, respondentWasFollower: true },
      }),
      prisma.surveyResponse.count({
        where: { surveyId, respondentWasFollower: false },
      }),
    ]);

    return res.json({
      success: true,
      surveyId,
      title: survey.title,
      responseCount: survey.responseCount,
      isClosed: survey.isClosed,
      questions,
      breakdowns: {
        byCountry: byCountry.map((r) => ({
          country: r.respondentCountry ?? "Unknown",
          count: r._count?._all ?? 0, // _count is optional in Prisma's type
        })),
        byFollower: [
          { follower: true, count: followerYes },
          { follower: false, count: followerNo },
        ],
      },
    });
  } catch (e: any) {
    console.error("getResults error:", e);
    return res.status(500).json({ error: "Failed to fetch results" });
  }
};

// =============================================================================
// 5) CLOSE  — POST /social/surveys/:surveyId/close   (authMiddleware, author)
// =============================================================================
// Author ends the survey early (or after). Marks it closed and REFUNDS the
// unspent reward budget as PURCHASED coins (see the anti-laundering note up top).
// =============================================================================
const closeSurvey = async (req: any, res: any) => {
  const userId = req.user?.id;
  try {
    if (!userId) return res.status(401).json({ error: "Auth required" });
    const { surveyId } = req.params;

    const survey = await prisma.survey.findUnique({ where: { id: surveyId } });
    if (!survey) return res.status(404).json({ error: "Survey not found" });
    if (survey.authorId !== userId)
      return res.status(403).json({ error: "Only the author can close this survey." });
    if (survey.isClosed)
      return res.json({ success: true, alreadyClosed: true, refunded: 0 });

    const unspent = Math.max(0, survey.rewardBudget - survey.rewardSpent);

    await prisma.$transaction(async (tx) => {
      await tx.survey.update({
        where: { id: surveyId },
        data: { isClosed: true },
      });
      // ⚠️ Refund as PURCHASED (spend-only) — NEVER earned. See header note.
      if (unspent > 0) {
        await creditPurchasedCoins(tx, userId, unspent);
      }
    });

    return res.json({ success: true, refunded: unspent });
  } catch (e: any) {
    console.error("closeSurvey error:", e);
    return res.status(500).json({ error: "Failed to close survey" });
  }
};

// =============================================================================
// SMALL PURE HELPERS (shaping + visibility + stats)
// =============================================================================

/** A survey is "over" if it's been closed or its closesAt has passed. */
function isSurveyOver(survey: { isClosed: boolean; closesAt: Date | null }): boolean {
  if (survey.isClosed) return true;
  if (survey.closesAt && survey.closesAt.getTime() <= Date.now()) return true;
  return false;
}

/** Apply the resultVisibility rule. */
function maySeeResults(
  survey: { resultVisibility: string; isClosed: boolean; closesAt: Date | null },
  ctx: { isAuthor: boolean; hasResponded: boolean },
): boolean {
  if (ctx.isAuthor) return true; // author always sees their own results
  switch (survey.resultVisibility) {
    case "always":
      return true;
    case "after_vote":
      return ctx.hasResponded;
    case "after_close":
      return isSurveyOver(survey);
    case "author_only":
      return false;
    default:
      return false;
  }
}

/** Shape a survey row (+ questions/options) for the client. Hides option
 *  voteCounts when the viewer isn't allowed to see results yet, so the live
 *  tallies don't leak through the render payload. */
function shapeSurvey(
  survey: any,
  ctx: {
    isAuthor: boolean;
    canSeeResults: boolean;
    myResponse: { id: string } | null;
    canRespond: boolean;
  },
) {
  return {
    surveyId: survey.id,
    postId: survey.postId,
    authorId: survey.authorId,
    title: survey.title,
    description: survey.description,
    anonymous: survey.anonymous,
    audience: survey.audience,
    resultVisibility: survey.resultVisibility,
    closesAt: survey.closesAt ? survey.closesAt.getTime() : null,
    isClosed: survey.isClosed,
    isOver: isSurveyOver(survey),
    responseCount: survey.responseCount,
    rewardCoins: survey.rewardCoins,
    rewardBudgetRemaining: Math.max(0, survey.rewardBudget - survey.rewardSpent),
    isAuthor: ctx.isAuthor,
    canRespond: ctx.canRespond,
    canSeeResults: ctx.canSeeResults,
    hasResponded: !!ctx.myResponse,
    questions: (survey.questions ?? [])
      .sort((a: any, b: any) => a.order - b.order)
      .map((q: any) => ({
        questionId: q.id,
        type: q.type,
        prompt: q.prompt,
        required: q.required,
        scaleMin: q.scaleMin,
        scaleMax: q.scaleMax,
        scaleMinLabel: q.scaleMinLabel,
        scaleMaxLabel: q.scaleMaxLabel,
        options: (q.options ?? [])
          .sort((a: any, b: any) => a.order - b.order)
          .map((o: any) => ({
            optionId: o.id,
            label: o.label,
            // Only expose tallies if the viewer may see results.
            ...(ctx.canSeeResults ? { votes: o.voteCount } : {}),
          })),
      })),
  };
}

/** Count how many times each value (min..max) appears, for scale/nps charts. */
function tallyDistribution(values: number[], min: number, max: number) {
  const dist: Record<number, number> = {};
  for (let v = min; v <= max; v++) dist[v] = 0;
  for (const v of values) if (dist[v] !== undefined) dist[v]++;
  return Object.entries(dist).map(([value, count]) => ({
    value: Number(value),
    count,
  }));
}

/** Net Promoter Score: %promoters (9–10) − %detractors (0–6). Range −100..100. */
function computeNps(values: number[]): number {
  if (values.length === 0) return 0;
  const promoters = values.filter((v) => v >= 9).length;
  const detractors = values.filter((v) => v <= 6).length;
  return Math.round(((promoters - detractors) / values.length) * 100);
}

// =============================================================================
// FEED EMBEDDING — attach a fully-shaped survey to survey posts in a feed
// =============================================================================
//
// WHY: a survey post in the feed should render its survey IMMEDIATELY, with the
// post — not fetch it separately (which causes a visible second wait and a
// refetch every time the list recycles the card on scroll). So any endpoint
// that returns posts calls `attachSurveys(posts, viewerId)` once, and the survey
// rides along inside each survey post's JSON. The client then renders from the
// embedded data with zero extra requests.
//
// COST: this runs at most ~4 batched queries for the WHOLE page, regardless of
// how many survey posts it contains (surveys, the viewer's responses to them,
// the viewer's follow edges to their authors, and the viewer row). Standard
// posts cost nothing here.
// =============================================================================

/**
 * Build a Map<postId, shapedSurvey> for the given survey post ids, with full
 * per-viewer state (isAuthor / hasResponded / canRespond / canSeeResults).
 * Reuses the exact same shaping + gating helpers as the single-survey endpoints,
 * so embedded surveys and directly-fetched surveys are byte-for-byte identical.
 */
export async function loadSurveysForPosts(
  postIds: string[],
  viewerId: string | null,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (postIds.length === 0) return out;

  const surveys = await prisma.survey.findMany({
    where: { postId: { in: postIds } },
    include: {
      questions: { include: { options: true }, orderBy: { order: "asc" } },
    },
  });
  if (surveys.length === 0) return out;

  // Per-viewer context, all batched (one query each), only when signed in.
  let respondedSet = new Set<string>(); // surveyIds the viewer has answered
  let followingSet = new Set<string>(); // authorIds the viewer follows
  let viewer: { id: string; phone: string | null; country: string | null } | null =
    null;

  if (viewerId) {
    const surveyIds = surveys.map((s) => s.id);
    const authorIds = Array.from(new Set(surveys.map((s) => s.authorId)));
    const [responses, follows, v] = await Promise.all([
      prisma.surveyResponse.findMany({
        where: { surveyId: { in: surveyIds }, respondentId: viewerId },
        select: { surveyId: true },
      }),
      prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: authorIds } },
        select: { followingId: true },
      }),
      prisma.user.findUnique({
        where: { id: viewerId },
        select: { id: true, phone: true, country: true },
      }),
    ]);
    respondedSet = new Set(responses.map((r) => r.surveyId));
    followingSet = new Set(follows.map((f) => f.followingId));
    viewer = v;
  }

  for (const survey of surveys) {
    const isAuthor = !!viewerId && viewerId === survey.authorId;
    const hasResponded = respondedSet.has(survey.id);
    const myResponse = hasResponded ? { id: "responded" } : null;

    // canRespond — same rules as audienceAllows, but using the batched sets so
    // we don't hit the DB per survey.
    let canRespond = false;
    if (viewerId && !isAuthor && !hasResponded && !isSurveyOver(survey)) {
      const aud = survey.audience as Audience;
      if (aud === "everyone") canRespond = true;
      else if (aud === "followers") canRespond = followingSet.has(survey.authorId);
      else if (aud === "ng_only") canRespond = viewer ? isNgTied(viewer) : false;
    }

    const canSeeResults = maySeeResults(survey, { isAuthor, hasResponded });

    out.set(
      survey.postId,
      shapeSurvey(survey, { isAuthor, canSeeResults, myResponse, canRespond }),
    );
  }

  return out;
}

/**
 * Mutate an array of ALREADY-SHAPED client posts, attaching `.survey` to each
 * one whose `postType === "survey"`. One line to call from any feed endpoint:
 *
 *     const out = await attachSurveys(posts, userId);
 *     return res.json({ success: true, posts: out, hasMore });
 *
 * Requires the shaped posts to carry `postType` + `postId` (postToClientShape
 * now includes `postType`).
 */
export async function attachSurveys(
  posts: any[],
  viewerId: string | null,
): Promise<any[]> {
  const surveyPostIds = posts
    .filter((p) => p.postType === "survey")
    .map((p) => p.postId);
  if (surveyPostIds.length === 0) return posts;

  const map = await loadSurveysForPosts(surveyPostIds, viewerId);
  for (const p of posts) {
    if (p.postType === "survey") p.survey = map.get(p.postId) ?? null;
  }
  return posts;
}

export default {
  createSurvey,
  getSurvey,
  getSurveyByPost,
  submitResponse,
  getResults,
  closeSurvey,
};