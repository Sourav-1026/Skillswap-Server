const { jwtVerify, createRemoteJWKSet } = require("jose");
const { ObjectId } = require("mongodb");

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifySession = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized: No token" });
    }

    const token = authHeader.split(" ")[1];

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.CLIENT_URL,
      audience: process.env.CLIENT_URL,
    });

    const userId = payload.sub;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: No user in token" });
    }

    const db = req.app.locals.db;
    const objectId = new ObjectId(userId);
    const user = await db.collection("user").findOne({ _id: objectId });

    if (!user) return res.status(401).json({ error: "User not found" });
    if (user.isBlocked)
      return res.status(403).json({ error: "Account blocked" });

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error.message);
    res.status(401).json({ error: "Unauthorized", detail: error.message });
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
