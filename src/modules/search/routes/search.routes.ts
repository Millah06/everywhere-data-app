// ─────────────────────────────────────────────────────────────────────────────
// search.routes.ts  — Express router
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from "../../../middleware/auth";
import searchController from "../controllers/search.controller"; // your existing controller functions

const router = Router();

// ── Search endpoints (optional auth — guests can search, auth adds personalization) ──
router.get('/',            optionalAuthMiddleware, searchController.search);
router.get('/suggestions', optionalAuthMiddleware, searchController.suggestions);
router.get('/trending',    optionalAuthMiddleware, searchController.trending);

// ── Search history (requires auth) ───────────────────────────────────────────
router.get('/history',        authMiddleware, searchController.getHistory);
router.delete('/history/:id',    authMiddleware, searchController.deleteHistoryItem);
router.delete('/history',        authMiddleware, searchController.clearHistory);

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// In your main router (e.g. routes/index.ts):
//
//   import searchRoutes from './search/search.routes';
//   import { getFollowers, getFollowing } from './search/search.controller';
//
//   app.use('/search', searchRoutes);
//   app.get('/users/:userId/followers', optionalAuthMiddleware, getFollowers);
//   app.get('/users/:userId/following', optionalAuthMiddleware, getFollowing);
// ─────────────────────────────────────────────────────────────────────────────


// =============================================================================
// PRISMA SCHEMA ADDITIONS  (add to schema.prisma)
// =============================================================================
//
// model SearchHistory {
//   id          String   @id @default(uuid())
//   userId      String
//   kind        String   // "user" | "hashtag" | "query"
//   label       String
//   subLabel    String?
//   avatarUrl   String?
//   refUserId   String?  // if kind == "user"
//   searchedAt  DateTime @default(now())
//
//   user User @relation(fields: [userId], references: [id], onDelete: Cascade)
//
//   @@unique([userId, label])   // upsert key
//   @@index([userId, searchedAt])
// }
//
// Add to User model:
//   searchHistory SearchHistory[]
//
//
// ── DATABASE INDEXES to add for search performance ──────────────────────────
//
// On UserProfile:
//   @@index([userName])                          -- handle search
//   @@index([followersCount])                    -- popularity sort
//   @@index([isVerified, followersCount])        -- verified boost
//
// On Post:
//   @@index([text])                              -- text search
//   @@index([algorithmScore, createdAt])         -- already in schema ✓
//   @@index([isBoosted, createdAt])              -- already in schema ✓
//
// On User:
//   @@index([name])                              -- name search
//
//
// ── PostgreSQL FULL-TEXT SEARCH (recommended upgrade path) ──────────────────
//
// Add a generated tsvector column to Post via a migration:
//
//   ALTER TABLE "Post"
//   ADD COLUMN search_vector tsvector
//     GENERATED ALWAYS AS (
//       setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
//       setweight(to_tsvector('english', coalesce(text,  '')), 'B')
//     ) STORED;
//
//   CREATE INDEX idx_post_fts ON "Post" USING gin(search_vector);
//
// Then in search.repository.ts, replace the `ilike` text filter with:
//
//   WHERE p.search_vector @@ plainto_tsquery('english', ${clean})
//
// This gives you relevance ranking via ts_rank() and is 10-100x faster
// on large datasets. The service ranking layer on top still applies.
//
//
// ── FUTURE: Algolia / Elasticsearch integration point ───────────────────────
//
// The service layer is already decoupled from Prisma via the repository.
// To switch to Algolia:
//   1. Create search.algolia.repository.ts implementing the same function
//      signatures as search.repository.ts
//   2. Swap the import in search.service.ts
//   3. Keep the ranking/scoring in the service layer as a secondary pass
//      (Algolia's own ranking handles most of it)
//
// =============================================================================