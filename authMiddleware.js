const { ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

const verifySession = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const cookieHeader = req.headers.cookie;

    let userId;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      // ✅ JWT token from Authorization header (production)
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, process.env.BETTER_AUTH_SECRET, {
        algorithms: ["HS256", "RS256", "ES256"],
      });
      userId = decoded.sub || decoded.id;
    } else if (cookieHeader) {
      // ✅ Fallback: cookie-based session (localhost)
      const authUrl = process.env.CLIENT_URL
        ? `${process.env.CLIENT_URL}/api/auth/get-session`
        : "http://localhost:3000/api/auth/get-session";

      const response = await fetch(authUrl, {
        headers: {
          cookie: cookieHeader,
          origin: process.env.CLIENT_URL || "http://localhost:3000",
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        return res.status(401).json({ error: "Unauthorized: Invalid session" });
      }

      const sessionData = await response.json();
      if (!sessionData?.user) {
        return res.status(401).json({ error: "Unauthorized: No session" });
      }
      userId = sessionData.user.id;
    } else {
      return res.status(401).json({ error: "Unauthorized: No credentials" });
    }

    const db = req.app.locals.db;
    if (!db) {
      return res
        .status(500)
        .json({ error: "Internal Server Error: DB not connected" });
    }

    let objectId;
    try {
      objectId = typeof userId === "string" ? new ObjectId(userId) : userId;
    } catch (e) {
      objectId = userId;
    }

    const user = await db.collection("user").findOne({ _id: objectId });
    if (!user) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    if (user.isBlocked) {
      return res
        .status(403)
        .json({ error: "Forbidden: Your account has been blocked" });
    }

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
