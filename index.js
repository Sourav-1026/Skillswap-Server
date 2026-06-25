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
    const usersCollection = db.collection("user");

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

    // PUT /api/proposals/:id (Client reject)
    app.put("/api/proposals/:id", verifySession, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body; // 'rejected'

      const result = await proposalsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } },
      );
      res.send(result);
    });

    // --- CHECKOUT & PAYMENTS API ---
    const paymentsCollection = db.collection("payments");

    // POST /api/checkout/create-intent
    app.post(
      "/api/checkout/create-intent",
      verifySession,
      requireRole("client"),
      async (req, res) => {
        try {
          console.log("HIT /api/checkout/create-intent", req.body);
          const { proposalId } = req.body;

          // 1. Fetch the proposal to get the exact budget
          const proposal = await proposalsCollection.findOne({
            _id: new ObjectId(proposalId),
          });
          if (!proposal) {
            console.log("Proposal not found for ID:", proposalId);
            return res.status(404).send({ error: "Proposal not found" });
          }

          // 2. Convert budget to cents (Stripe expects the amount in the smallest currency unit)
          const amount = Math.round(proposal.proposed_budget * 100);

          // 3. Create the PaymentIntent on Stripe
          const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: "usd",
            // Store metadata to easily identify the payment later
            metadata: {
              proposalId: proposalId,
              taskId: proposal.task_id,
              clientId: req.user.id || req.user.email,
              freelancerEmail: proposal.freelancer_email,
            },
          });

          // 4. Send the client secret back so the frontend can render the secure Stripe Elements form
          res.send({ clientSecret: paymentIntent.client_secret, proposal });
        } catch (error) {
          console.error("Stripe Intent Error:", error);
          res.status(500).send({ error: error.message });
        }
      },
    );

    // POST /api/proposals/:id/confirm-payment
    app.post(
      "/api/proposals/:id/confirm-payment",
      verifySession,
      requireRole("client"),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { paymentIntentId } = req.body;

          // 1. Verify the payment status directly with Stripe to prevent fraud
          const paymentIntent =
            await stripe.paymentIntents.retrieve(paymentIntentId);
          if (paymentIntent.status !== "succeeded") {
            return res.status(400).send({ error: "Payment not successful" });
          }

          // 2. Retrieve the proposal details
          const proposal = await proposalsCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!proposal)
            return res.status(404).send({ error: "Proposal not found" });

          // 3. Check if we already processed this payment (Idempotency)
          const existingPayment = await paymentsCollection.findOne({
            transaction_id: paymentIntentId,
          });
          if (existingPayment) {
            return res.send({ success: true, message: "Already processed" });
          }

          // 4. Update the proposal status to 'accepted'
          await proposalsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "accepted" } },
          );

          // Update task status
          await tasksCollection.updateOne(
            { _id: new ObjectId(proposal.task_id) },
            { $set: { status: "In Progress" } },
          );

          // Reject all other proposals for this task
          await proposalsCollection.updateMany(
            { task_id: proposal.task_id, _id: { $ne: new ObjectId(id) } },
            { $set: { status: "rejected" } },
          );

          // Record the payment
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
