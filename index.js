const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { verifySession, requireRole } = require("./authMiddleware");

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
require("dotenv").config();

const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("skillswap_db");
    app.locals.db = db; // expose db to middleware

    const tasksCollection = db.collection("tasks");
    const proposalsCollection = db.collection("proposals");
    const usersCollection = db.collection("user"); // Better Auth uses 'user' collection

    // --- TASKS API ---

    // POST /api/tasks (Client only)
    app.post(
      "/api/tasks",
      verifySession,
      requireRole("client"),
      async (req, res) => {
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

    // GET /api/tasks (Public)
    app.get("/api/tasks", async (req, res) => {
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
      if (search) {
        query.title = { $regex: search, $options: "i" };
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const cursor = tasksCollection
        .find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ createdAt: -1 });
      const result = await cursor.toArray();
      const total = await tasksCollection.countDocuments(query);

      res.send({
        tasks: result,
        total,
        page: parseInt(page),
        limit: parseInt(limit),
      });
    });

    // GET /api/tasks/:id
    app.get("/api/tasks/:id", async (req, res) => {
      const { id } = req.params;
      const result = await tasksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // PUT /api/tasks/:id (Edit task or submit deliverable)
    app.put("/api/tasks/:id", verifySession, async (req, res) => {
      const { id } = req.params;
      const updates = req.body;
      const result = await tasksCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updates },
      );
      res.send(result);
    });

    // GET /api/tasks/freelancer/:email (Get tasks assigned to a freelancer)
    app.get(
      "/api/tasks/freelancer/:email",
      verifySession,
      requireRole("freelancer"),
      async (req, res) => {
        const { email } = req.params;
        // Find accepted proposals for this freelancer
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

    // DELETE /api/tasks/:id
    app.delete("/api/tasks/:id", verifySession, async (req, res) => {
      const { id } = req.params;
      const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // --- PROPOSALS API ---

    // POST /api/proposals (Freelancer only)
    app.post(
      "/api/proposals",
      verifySession,
      requireRole("freelancer"),
      async (req, res) => {
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

    // GET /api/proposals
    app.get("/api/proposals", verifySession, async (req, res) => {
      const { taskId, freelancerEmail } = req.query;
      const query = {};
      if (taskId) query.task_id = taskId;
      if (freelancerEmail) query.freelancer_email = freelancerEmail;

      const cursor = proposalsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // PUT /api/proposals/:id (Client accept/reject)
    app.put("/api/proposals/:id", verifySession, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body; // 'accepted' or 'rejected'

      const result = await proposalsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } },
      );

      if (status === "accepted") {
        const proposal = await proposalsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (proposal) {
          await tasksCollection.updateOne(
            { _id: new ObjectId(proposal.task_id) },
            { $set: { status: "In Progress" } },
          );
          await proposalsCollection.updateMany(
            { task_id: proposal.task_id, _id: { $ne: new ObjectId(id) } },
            { $set: { status: "rejected" } },
          );

          // Mock payment generation for Admin Dashboard
          const paymentsCollection = db.collection("payments");
          await paymentsCollection.insertOne({
            client_email: req.user.email,
            freelancer_email: proposal.freelancer_email,
            task_id: proposal.task_id,
            amount: proposal.proposed_budget,
            transaction_id:
              "mock_txn_" + Math.random().toString(36).substr(2, 9),
            payment_status: "succeeded",
            paid_at: new Date(),
          });
        }
      }
      res.send(result);
    });

    // --- USERS API ---

    // GET /api/users
    app.get("/api/users", async (req, res) => {
      const query = {};
      if (req.query.role) query.role = req.query.role;
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    // GET /api/users/:email
    app.get("/api/users/:email", async (req, res) => {
      const result = await usersCollection.findOne({ email: req.params.email });
      if (!result) return res.status(404).json({ error: "User not found" });
      res.send(result);
    });

    // PUT /api/users/:email (Update Profile)
    app.put("/api/users/:email", verifySession, async (req, res) => {
      const updates = req.body;
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: updates },
      );
      res.send(result);
    });

    // PUT /api/users/:email/block (Admin Only)
    app.put(
      "/api/users/:email/block",
      verifySession,
      requireRole("admin"),
      async (req, res) => {
        const { isBlocked } = req.body;
        const result = await usersCollection.updateOne(
          { email: req.params.email },
          { $set: { isBlocked } },
        );
        res.send(result);
      },
    );

    // --- PAYMENTS API ---
    const paymentsCollection = db.collection("payments");

    // GET /api/payments
    app.get("/api/payments", verifySession, async (req, res) => {
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
    const reviewsCollection = db.collection("reviews");

    // POST /api/reviews
    app.post(
      "/api/reviews",
      verifySession,
      requireRole("client"),
      async (req, res) => {
        const review = {
          ...req.body,
          reviewer_email: req.user.email,
          created_at: new Date(),
        };
        const result = await reviewsCollection.insertOne(review);
        res.send(result);
      },
    );

    // GET /api/reviews
    app.get("/api/reviews", async (req, res) => {
      const { taskId, revieweeEmail } = req.query;
      const query = {};
      if (taskId) query.task_id = taskId;
      if (revieweeEmail) query.reviewee_email = revieweeEmail;

      const result = await reviewsCollection.find(query).toArray();
      res.send(result);
    });

    // --- ADMIN API ---
    // GET /api/admin/stats
    app.get(
      "/api/admin/stats",
      verifySession,
      requireRole("admin"),
      async (req, res) => {
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

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Skillswap Server Running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
