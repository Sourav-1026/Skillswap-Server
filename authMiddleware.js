const { MongoClient, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

const verifySession = async (req, res, next) => {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      return res.status(401).json({ error: "Unauthorized: No cookies found" });
    }

    // Call the Better Auth get-session API to validate the token properly
    const authUrl = process.env.CLIENT_URL
      ? `${process.env.CLIENT_URL}/api/auth/get-session`
      : "http://localhost:3000/api/auth/get-session";
    const response = await fetch(authUrl, {
      headers: {
        cookie: cookieHeader,
        origin: process.env.CLIENT_URL || "http://localhost:3000", // ✅ add this
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return res.status(401).json({ error: "Unauthorized: Invalid session" });
    }

    const sessionData = await response.json();

    if (!sessionData || !sessionData.user) {
      return res.status(401).json({
        error: "Unauthorized: Could not determine user ID from session",
      });
    }

    const userId = sessionData.user.id;

    const db = req.app.locals.db;
    if (!db) {
      return res
        .status(500)
        .json({ error: "Internal Server Error: DB not connected" });
    }

    // Ensure userId is an ObjectId if it's a string from JWT
    let objectId;
    try {
      objectId = typeof userId === "string" ? new ObjectId(userId) : userId;
    } catch (e) {
      objectId = userId;
    }

    // Fetch user details from our DB to get fresh role/status
    const user = await db.collection("user").findOne({ _id: objectId });
    if (!user) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    if (user.isBlocked) {
      return res
        .status(403)
        .json({ error: "Forbidden: Your account has been blocked" });
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.user.role?.toLowerCase() !== role.toLowerCase()) {
      return res
        .status(403)
        .json({ error: "Forbidden: Insufficient permissions" });
    }
    next();
  };
};

module.exports = { verifySession, requireRole };
