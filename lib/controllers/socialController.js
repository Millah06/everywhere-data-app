"use strict";
// backend/controllers/socialController.ts
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const auth_1 = require("../webhook/utils/auth");
const db = firebase_admin_1.default.firestore();
// const createPost = async (req: any, res: any) => {
//   try {
//     const userId = await checkAuth(req); // Verify auth
//     // const userId = req.user?.uid;
//     const { text, imageUrl } = req.body;
//     if (!userId) {
//       return res.status(401).json({ error: 'Unauthorized' });
//     }
//     if (!text || text.trim().length === 0) {
//       return res.status(400).json({ error: 'Post text is required' });
//     }
//     if (text.length > 500) {
//       return res.status(400).json({ error: 'Post text exceeds 500 characters' });
//     }
//     // Get user info
//     const userDoc = await db.collection('users').doc(userId).get();
//     const userData = userDoc.data();
//     const postData = {
//       userId,
//       userName: userData?.displayName || 'Anonymous',
//       userAvatar: userData?.photoURL || null,
//       text: text.trim(),
//       imageUrl: imageUrl || null,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//       likeCount: 0,
//       commentCount: 0,
//       rewardCount: 0,
//       rewardPointsTotal: 0,
//       isBoosted: false,
//       boostExpiresAt: null,
//     };
//     const postRef = await db.collection('posts').add(postData);
//     res.status(201).json({
//       success: true,
//       postId: postRef.id,
//       post: { ...postData, postId: postRef.id },
//     });
//   } catch (error) {
//     console.error('Create post error:', error);
//     res.status(500).json({ error: 'Failed to create post' });
//   }
// };
const getFeed = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { limit = 20, lastPostId } = req.query;
        const limitNum = Math.min(parseInt(limit), 50);
        let query = db
            .collection('posts')
            .orderBy('isBoosted', 'desc')
            .orderBy('createdAt', 'desc')
            .limit(limitNum);
        if (lastPostId) {
            const lastDoc = yield db.collection('posts').doc(lastPostId).get();
            if (lastDoc.exists) {
                query = query.startAfter(lastDoc);
            }
        }
        const snapshot = yield query.get();
        const now = Date.now();
        const posts = snapshot.docs.map((doc) => {
            var _a;
            const data = doc.data();
            // Check if boost expired
            let isBoosted = data.isBoosted;
            if (isBoosted && data.boostExpiresAt) {
                const expiresAt = data.boostExpiresAt.toMillis();
                if (now > expiresAt) {
                    isBoosted = false;
                    // Update asynchronously
                    doc.ref.update({ isBoosted: false });
                }
            }
            return Object.assign(Object.assign({ postId: doc.id }, data), { isBoosted, createdAt: ((_a = data.createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || Date.now() });
        });
        res.json({
            success: true,
            posts,
            hasMore: posts.length === limitNum,
        });
    }
    catch (error) {
        console.error('Get feed error:', error);
        res.status(500).json({ error: 'Failed to fetch feed' });
    }
});
const likePost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const userId = yield (0, auth_1.checkAuth)(req); // Verify auth
        // const userId = req.user?.uid;
        const { postId } = req.body;
        if (!userId || !postId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const postRef = db.collection('posts').doc(postId);
        const likeRef = postRef.collection('likes').doc(userId);
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            const likeDoc = yield transaction.get(likeRef);
            if (likeDoc.exists) {
                // Unlike
                transaction.delete(likeRef);
                transaction.update(postRef, {
                    likeCount: firebase_admin_1.default.firestore.FieldValue.increment(-1),
                });
            }
            else {
                // Like
                transaction.set(likeRef, {
                    userId,
                    likedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                });
                transaction.update(postRef, {
                    likeCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
                });
            }
        }));
        res.json({ success: true });
    }
    catch (error) {
        console.error('Like post error:', error);
        res.status(500).json({ error: 'Failed to like post' });
    }
});
const commentOnPost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const userId = yield (0, auth_1.checkAuth)(req); // Verify auth
        // const userId = req.user?.uid;
        const { postId, text } = req.body;
        if (!userId || !postId || !text) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (text.trim().length === 0 || text.length > 300) {
            return res.status(400).json({ error: 'Invalid comment length' });
        }
        const userDoc = yield db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        const postRef = db.collection('posts').doc(postId);
        const commentRef = postRef.collection('comments').doc();
        const commentData = {
            commentId: commentRef.id,
            userId,
            userName: (userData === null || userData === void 0 ? void 0 : userData.displayName) || 'Anonymous',
            userAvatar: (userData === null || userData === void 0 ? void 0 : userData.photoURL) || null,
            text: text.trim(),
            createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
        };
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            transaction.set(commentRef, commentData);
            transaction.update(postRef, {
                commentCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
            });
        }));
        res.status(201).json({
            success: true,
            comment: commentData,
        });
    }
    catch (error) {
        console.error('Comment error:', error);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});
const getComments = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { postId } = req.params;
        const { limit = 20 } = req.query;
        const snapshot = yield db
            .collection('posts')
            .doc(postId)
            .collection('comments')
            .orderBy('createdAt', 'desc')
            .limit(parseInt(limit))
            .get();
        const comments = snapshot.docs.map((doc) => {
            var _a;
            return (Object.assign(Object.assign({}, doc.data()), { createdAt: ((_a = doc.data().createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || Date.now() }));
        });
        res.json({ success: true, comments });
    }
    catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});
const getTopEarners = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const snapshot = yield db
            .collection('creatorStats')
            .orderBy('weeklyPoints', 'desc')
            .limit(10)
            .get();
        const earners = yield Promise.all(snapshot.docs.map((doc) => __awaiter(void 0, void 0, void 0, function* () {
            const data = doc.data();
            const userDoc = yield db.collection('users').doc(doc.id).get();
            const userData = userDoc.data();
            return {
                userId: doc.id,
                userName: (userData === null || userData === void 0 ? void 0 : userData.displayName) || 'Anonymous',
                userAvatar: (userData === null || userData === void 0 ? void 0 : userData.photoURL) || null,
                totalRewardPoints: data.totalRewardPoints || 0,
                weeklyPoints: data.weeklyPoints || 0,
                totalEarnedNaira: data.totalEarnedNaira || 0,
                level: data.level || 1,
            };
        })));
        res.json({ success: true, earners });
    }
    catch (error) {
        console.error('Get top earners error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});
// backend/controllers/socialController.ts - ADD THESE FUNCTIONS
const getForYouFeed = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { limit = 20, lastScore, lastPostId } = req.query;
        const limitNum = Math.min(parseInt(limit), 50);
        let query = db
            .collection('posts')
            .orderBy('algorithmScore', 'desc')
            .orderBy('createdAt', 'desc')
            .limit(limitNum);
        if (lastScore && lastPostId) {
            const lastDoc = yield db.collection('posts').doc(lastPostId).get();
            if (lastDoc.exists) {
                query = query.startAfter(lastDoc);
            }
        }
        const snapshot = yield query.get();
        const posts = yield Promise.all(snapshot.docs.map((doc) => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const data = doc.data();
            // Check if user is following post author
            let isFollowing = false;
            if (userId && data.userId !== userId) {
                const followDoc = yield db
                    .collection('follows')
                    .where('followerId', '==', userId)
                    .where('followingId', '==', data.userId)
                    .limit(1)
                    .get();
                isFollowing = !followDoc.empty;
            }
            return {
                postId: doc.id,
                userId: data.userId || '',
                userName: data.userName || 'Anonymous',
                userAvatar: data.userAvatar || null,
                text: data.text || '',
                imageUrl: data.imageUrl || null,
                hashtags: data.hashtags || [],
                createdAt: ((_a = data.createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || Date.now(),
                likeCount: data.likeCount || 0,
                commentCount: data.commentCount || 0,
                rewardCount: data.rewardCount || 0,
                rewardPointsTotal: data.rewardPointsTotal || 0,
                viewCount: data.viewCount || 0,
                isBoosted: data.isBoosted || false,
                boostExpiresAt: ((_b = data.boostExpiresAt) === null || _b === void 0 ? void 0 : _b.toMillis()) || null,
                algorithmScore: data.algorithmScore || 0,
                isFollowing,
            };
        })));
        res.json({
            success: true,
            posts,
            hasMore: posts.length === limitNum,
        });
    }
    catch (error) {
        console.error('Get For You feed error:', error);
        res.status(500).json({ error: 'Failed to fetch feed', message: error.message });
    }
});
const getFollowingFeed = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { limit = 20, lastPostId } = req.query;
        const limitNum = Math.min(parseInt(limit), 50);
        // Get users that current user follows
        const followingSnapshot = yield db
            .collection('follows')
            .where('followerId', '==', userId)
            .get();
        const followingIds = followingSnapshot.docs.map(doc => doc.data().followingId);
        if (followingIds.length === 0) {
            return res.json({ success: true, posts: [], hasMore: false });
        }
        // Get posts from followed users (Firestore 'in' supports max 10 values)
        // For production, implement pagination properly
        const chunks = [];
        for (let i = 0; i < followingIds.length; i += 10) {
            chunks.push(followingIds.slice(i, i + 10));
        }
        let allPosts = [];
        for (const chunk of chunks) {
            let query = db
                .collection('posts')
                .where('userId', 'in', chunk)
                .orderBy('createdAt', 'desc')
                .limit(limitNum);
            if (lastPostId) {
                const lastDoc = yield db.collection('posts').doc(lastPostId).get();
                if (lastDoc.exists) {
                    query = query.startAfter(lastDoc);
                }
            }
            const snapshot = yield query.get();
            const posts = snapshot.docs.map((doc) => {
                var _a, _b;
                const data = doc.data();
                return {
                    postId: doc.id,
                    userId: data.userId || '',
                    userName: data.userName || 'Anonymous',
                    userAvatar: data.userAvatar || null,
                    text: data.text || '',
                    imageUrl: data.imageUrl || null,
                    hashtags: data.hashtags || [],
                    createdAt: ((_a = data.createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || Date.now(),
                    likeCount: data.likeCount || 0,
                    commentCount: data.commentCount || 0,
                    rewardCount: data.rewardCount || 0,
                    rewardPointsTotal: data.rewardPointsTotal || 0,
                    viewCount: data.viewCount || 0,
                    isBoosted: data.isBoosted || false,
                    boostExpiresAt: ((_b = data.boostExpiresAt) === null || _b === void 0 ? void 0 : _b.toMillis()) || null,
                    isFollowing: true, // All posts are from followed users
                };
            });
            allPosts = allPosts.concat(posts);
        }
        // Sort by createdAt desc
        allPosts.sort((a, b) => b.createdAt - a.createdAt);
        allPosts = allPosts.slice(0, limitNum);
        res.json({
            success: true,
            posts: allPosts,
            hasMore: allPosts.length === limitNum,
        });
    }
    catch (error) {
        console.error('Get Following feed error:', error);
        res.status(500).json({ error: 'Failed to fetch following feed', message: error.message });
    }
});
const followUser = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const followerId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { userId: followingId } = req.body;
        if (!followerId || !followingId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (followerId === followingId) {
            return res.status(400).json({ error: 'Cannot follow yourself' });
        }
        const followRef = db.collection('follows').doc();
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            // Check if already following
            const existingFollow = yield db
                .collection('follows')
                .where('followerId', '==', followerId)
                .where('followingId', '==', followingId)
                .limit(1)
                .get();
            if (!existingFollow.empty) {
                throw new Error('Already following this user');
            }
            // Create follow
            transaction.set(followRef, {
                followId: followRef.id,
                followerId,
                followingId,
                createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
            // Update follower count
            const followerProfileRef = db.collection('userProfiles').doc(followingId);
            transaction.update(followerProfileRef, {
                followerCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
            });
            // Update following count
            const followingProfileRef = db.collection('userProfiles').doc(followerId);
            transaction.update(followingProfileRef, {
                followingCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
            });
        }));
        res.json({ success: true });
    }
    catch (error) {
        console.error('Follow user error:', error);
        res.status(500).json({ error: 'Failed to follow user', message: error.message });
    }
});
const unfollowUser = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const followerId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { userId: followingId } = req.body;
        if (!followerId || !followingId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            // Find follow document
            const followSnapshot = yield db
                .collection('follows')
                .where('followerId', '==', followerId)
                .where('followingId', '==', followingId)
                .limit(1)
                .get();
            if (followSnapshot.empty) {
                throw new Error('Not following this user');
            }
            const followDoc = followSnapshot.docs[0];
            // Delete follow
            transaction.delete(followDoc.ref);
            // Update follower count
            const followerProfileRef = db.collection('userProfiles').doc(followingId);
            transaction.update(followerProfileRef, {
                followerCount: firebase_admin_1.default.firestore.FieldValue.increment(-1),
            });
            // Update following count
            const followingProfileRef = db.collection('userProfiles').doc(followerId);
            transaction.update(followingProfileRef, {
                followingCount: firebase_admin_1.default.firestore.FieldValue.increment(-1),
            });
        }));
        res.json({ success: true });
    }
    catch (error) {
        console.error('Unfollow user error:', error);
        res.status(500).json({ error: 'Failed to unfollow user', message: error.message });
    }
});
const getUserProfile = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const { userId } = req.params;
        const currentUserId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const profileDoc = yield db.collection('userProfiles').doc(userId).get();
        if (!profileDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        const profileData = profileDoc.data();
        // Check if current user follows this user
        let isFollowing = false;
        if (currentUserId && currentUserId !== userId) {
            const followDoc = yield db
                .collection('follows')
                .where('followerId', '==', currentUserId)
                .where('followingId', '==', userId)
                .limit(1)
                .get();
            isFollowing = !followDoc.empty;
        }
        res.json({
            success: true,
            profile: Object.assign(Object.assign({ userId }, profileData), { isFollowing }),
        });
    }
    catch (error) {
        console.error('Get user profile error:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});
const getUserPosts = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { userId } = req.params;
        const { limit = 20 } = req.query;
        const snapshot = yield db
            .collection('posts')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(parseInt(limit))
            .get();
        const posts = snapshot.docs.map((doc) => {
            var _a, _b;
            const data = doc.data();
            return Object.assign(Object.assign({ postId: doc.id }, data), { createdAt: ((_a = data.createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || Date.now(), boostExpiresAt: ((_b = data.boostExpiresAt) === null || _b === void 0 ? void 0 : _b.toMillis()) || null });
        });
        res.json({ success: true, posts });
    }
    catch (error) {
        console.error('Get user posts error:', error);
        res.status(500).json({ error: 'Failed to fetch posts' });
    }
});
// Update createPost to extract hashtags
const createPost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { text, imageUrl } = req.body;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Post text is required' });
        }
        if (text.length > 500) {
            return res.status(400).json({ error: 'Post text exceeds 500 characters' });
        }
        // Extract hashtags
        const hashtagRegex = /#[\w]+/g;
        const hashtags = (text.match(hashtagRegex) || []).map((tag) => tag.toLowerCase());
        // Get user info
        const userDoc = yield db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        const postData = {
            userId,
            userName: (userData === null || userData === void 0 ? void 0 : userData.displayName) || (userData === null || userData === void 0 ? void 0 : userData.name) || 'Anonymous',
            userAvatar: (userData === null || userData === void 0 ? void 0 : userData.photoURL) || (userData === null || userData === void 0 ? void 0 : userData.photoUrl) || null,
            text: text.trim(),
            imageUrl: imageUrl || null,
            hashtags,
            createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            likeCount: 0,
            commentCount: 0,
            rewardCount: 0,
            rewardPointsTotal: 0,
            viewCount: 0,
            isBoosted: false,
            boostExpiresAt: null,
            algorithmScore: 10, // Initial score for new posts
        };
        const postRef = yield db.collection('posts').add(postData);
        // Update user post count
        yield db.collection('userProfiles').doc(userId).update({
            postCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
        });
        res.status(201).json({
            success: true,
            postId: postRef.id,
            post: Object.assign(Object.assign({}, postData), { postId: postRef.id, createdAt: Date.now() }),
        });
    }
    catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});
exports.default = {
    createPost,
    getFeed, // Keep existing
    getForYouFeed,
    getFollowingFeed,
    likePost,
    commentOnPost,
    getComments,
    getTopEarners,
    followUser,
    unfollowUser,
    getUserProfile,
    getUserPosts,
};
