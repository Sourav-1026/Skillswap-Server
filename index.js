require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { verifySession, requireRole } = require("./authMiddleware");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ✅ Connection handler
let db;
async function connectDB() {
  if (!db || !client.topology || !client.topology.isConnected()) {
    // Force a fresh client if topology is dead
    await client.close().catch(() => {});
    await client.connect();
    db = client.db("skillswap_db");
    app.locals.db = db;
    console.log("Connected to MongoDB");
  }
  return db;
}

// ✅ Reconnects on every request if needed
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("MongoDB connection error:", err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// ✅ Helper — always gets fresh collection references
const cols = () => ({
  tasksCollection: db.collection("tasks"),
  proposalsCollection: db.collection("proposals"),
  usersCollection: db.collection("user"),
  paymentsCollection: db.collection("payments"),
  reviewsCollection: db.collection("reviews"),
});

// --- TASKS API ---

app.post(
  "/api/tasks",
  verifySession,
  requireRole("client"),
  async (req, res) => {
    const { tasksCollection } = cols();
    const task = {
      ...req.body,
      client_email: req.user.email,
      status: "open",
      createdAt: new Date(),
    };
    const result = await tasksCollection.insertOne(task);
    res.send(result);
  },
);

app.get("/api/tasks", async (req, res) => {
  const { tasksCollection } = cols();
  const {
    search,
    category,
    clientEmail,
    status,
    page = 1,
    limit = 9,
  } = req.query;

  const query = {};
  if (clientEmail) query.client_email = clientEmail;
  if (status) query.status = status;
  if (category && category !== "All") query.category = category;
  if (search) query.title = { $regex: search, $options: "i" };

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const result = await tasksCollection
    .find(query)
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 })
    .toArray();
  const total = await tasksCollection.countDocuments(query);

  res.send({
    tasks: result,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
  });
});

// ⚠️ Must be before /api/tasks/:id
app.get(
  "/api/tasks/freelancer/:email",
  verifySession,
  requireRole("freelancer"),
  async (req, res) => {
    const { tasksCollection, proposalsCollection } = cols();
    const { email } = req.params;
    const acceptedProposals = await proposalsCollection
      .find({ freelancer_email: email, status: "accepted" })
      .toArray();
    const taskIds = acceptedProposals.map((p) => new ObjectId(p.task_id));
    const tasks = await tasksCollection
      .find({ _id: { $in: taskIds } })
      .toArray();
    res.send(tasks);
  },
);

app.get("/api/tasks/:id", async (req, res) => {
  const { tasksCollection } = cols();
  const result = await tasksCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  res.send(result);
});

app.put("/api/tasks/:id", verifySession, async (req, res) => {
  const { tasksCollection } = cols();
  const result = await tasksCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body },
  );
  res.send(result);
});

app.delete("/api/tasks/:id", verifySession, async (req, res) => {
  const { tasksCollection } = cols();
  const result = await tasksCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });
  res.send(result);
});

// --- PROPOSALS API ---

app.post(
  "/api/proposals",
  verifySession,
  requireRole("freelancer"),
  async (req, res) => {
    const { proposalsCollection } = cols();
    const proposal = {
      ...req.body,
      freelancer_email: req.user.email,
      status: "pending",
      submitted_at: new Date(),
    };
    const result = await proposalsCollection.insertOne(proposal);
    res.send(result);
  },
);

app.get("/api/proposals", verifySession, async (req, res) => {
  const { proposalsCollection } = cols();
  const { taskId, freelancerEmail } = req.query;
  const query = {};
  if (taskId) query.task_id = taskId;
  if (freelancerEmail) query.freelancer_email = freelancerEmail;
  const result = await proposalsCollection.find(query).toArray();
  res.send(result);
});

app.put("/api/proposals/:id", verifySession, async (req, res) => {
  const { proposalsCollection } = cols();
  const result = await proposalsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: req.body.status } },
  );
  res.send(result);
});

// --- CHECKOUT & PAYMENTS API ---

app.post(
  "/api/checkout/create-intent",
  verifySession,
  requireRole("client"),
  async (req, res) => {
    try {
      const { proposalsCollection } = cols();
      const { proposalId } = req.body;
      const proposal = await proposalsCollection.findOne({
        _id: new ObjectId(proposalId),
      });
      if (!proposal)
        return res.status(404).send({ error: "Proposal not found" });

      const amount = Math.round(proposal.proposed_budget * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        metadata: {
          proposalId,
          taskId: proposal.task_id,
          clientId: req.user.id || req.user.email,
          freelancerEmail: proposal.freelancer_email,
        },
      });
      res.send({ clientSecret: paymentIntent.client_secret, proposal });
    } catch (error) {
      console.error("Stripe Intent Error:", error);
      res.status(500).send({ error: error.message });
    }
  },
);

app.post(
  "/api/proposals/:id/confirm-payment",
  verifySession,
  requireRole("client"),
  async (req, res) => {
    try {
      const { proposalsCollection, tasksCollection, paymentsCollection } =
        cols();
      const { id } = req.params;
      const { paymentIntentId } = req.body;

      const paymentIntent =
        await stripe.paymentIntents.retrieve(paymentIntentId);
      if (paymentIntent.status !== "succeeded")
        return res.status(400).send({ error: "Payment not successful" });

      const proposal = await proposalsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!proposal)
        return res.status(404).send({ error: "Proposal not found" });

      const existingPayment = await paymentsCollection.findOne({
        transaction_id: paymentIntentId,
      });
      if (existingPayment)
        return res.send({ success: true, message: "Already processed" });

      await proposalsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "accepted" } },
      );
      await tasksCollection.updateOne(
        { _id: new ObjectId(proposal.task_id) },
        { $set: { status: "In Progress" } },
      );
      await proposalsCollection.updateMany(
        { task_id: proposal.task_id, _id: { $ne: new ObjectId(id) } },
        { $set: { status: "rejected" } },
      );
      await paymentsCollection.insertOne({
        client_email: req.user.email,
        freelancer_email: proposal.freelancer_email,
        task_id: proposal.task_id,
        amount: proposal.proposed_budget,
        transaction_id: paymentIntentId,
        payment_status: "succeeded",
        paid_at: new Date(),
      });

      res.send({ success: true });
    } catch (error) {
      console.error("Confirm Payment Error:", error);
      res.status(500).send({ error: error.message });
    }
  },
);

// --- USERS API ---

app.get("/api/users", async (req, res) => {
  const { usersCollection } = cols();
  const query = {};
  if (req.query.role) query.role = req.query.role;
  const result = await usersCollection.find(query).toArray();
  res.send(result);
});

app.get("/api/users/:email", async (req, res) => {
  const { usersCollection } = cols();
  const result = await usersCollection.findOne({ email: req.params.email });
  if (!result) return res.status(404).json({ error: "User not found" });
  res.send(result);
});

app.put("/api/users/:email", verifySession, async (req, res) => {
  const { usersCollection } = cols();
  const result = await usersCollection.updateOne(
    { email: req.params.email },
    { $set: req.body },
  );
  res.send(result);
});

app.put(
  "/api/users/:email/block",
  verifySession,
  requireRole("admin"),
  async (req, res) => {
    const { usersCollection } = cols();
    const result = await usersCollection.updateOne(
      { email: req.params.email },
      { $set: { isBlocked: req.body.isBlocked } },
    );
    res.send(result);
  },
);

// --- PAYMENTS API ---

app.get("/api/payments", verifySession, async (req, res) => {
  const { paymentsCollection } = cols();
  const query = {};
  if (req.query.freelancerEmail)
    query.freelancer_email = req.query.freelancerEmail;
  if (req.query.clientEmail) query.client_email = req.query.clientEmail;
  const payments = await paymentsCollection
    .find(query)
    .sort({ paid_at: -1 })
    .toArray();
  res.send(payments);
});

// --- REVIEWS API ---

app.post(
  "/api/reviews",
  verifySession,
  requireRole("client"),
  async (req, res) => {
    const { reviewsCollection } = cols();
    const review = {
      ...req.body,
      reviewer_email: req.user.email,
      created_at: new Date(),
    };
    const result = await reviewsCollection.insertOne(review);
    res.send(result);
  },
);

app.get("/api/reviews", async (req, res) => {
  const { reviewsCollection } = cols();
  const { taskId, revieweeEmail } = req.query;
  const query = {};
  if (taskId) query.task_id = taskId;
  if (revieweeEmail) query.reviewee_email = revieweeEmail;
  const result = await reviewsCollection.find(query).toArray();
  res.send(result);
});

// --- ADMIN API ---

app.get(
  "/api/admin/stats",
  verifySession,
  requireRole("admin"),
  async (req, res) => {
    const { usersCollection, tasksCollection, paymentsCollection } = cols();
    const totalUsers = await usersCollection.countDocuments();
    const totalTasks = await tasksCollection.countDocuments();
    const activeTasks = await tasksCollection.countDocuments({
      status: { $in: ["open", "In Progress"] },
    });
    const payments = await paymentsCollection
      .find({ payment_status: "succeeded" })
      .toArray();
    const totalRevenue = payments.reduce(
      (acc, curr) => acc + (curr.amount || 0),
      0,
    );
    res.send({ totalUsers, totalTasks, activeTasks, totalRevenue });
  },
);

app.get("/", (req, res) => res.send("Skillswap Server Running"));

// ✅ Only listen locally
// if (process.env.NODE_ENV !== "production") {
const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Server running on port ${port}`));
// }

process.on("unhandledRejection", (err) => {
  console.error("Unhandled error:", err);
});
// ✅ Required for Vercel
// module.exports = app;
