
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import userRoutes from "./routes/userRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

import { connectDB } from "./config/mongodb.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
}));

app.use(express.json({
    verify: (req, res, buffer) => {
        if (req.originalUrl === "/api/payments/webhook") {
            req.rawBody = buffer;
        }
    },
}));

// API routes
app.use("/api/users", userRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);


// Root route
app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Welcome to FixMate API",
    });
});

// Start server after MongoDB connects
async function startServer() {
    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`FixMate server running on port ${PORT}`);
            console.log(`API: http://localhost:${PORT}/api/health`);
        });

    } catch (error) {
        console.error("Server startup failed:", error.message);
        process.exit(1);
    }
}

startServer();
