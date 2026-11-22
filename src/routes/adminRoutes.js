
import express from "express";
import { ObjectId } from "mongodb";

import { getDB } from "../config/mongodb.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";

const router = express.Router();


// Validate MongoDB ObjectId
function isValidId(id) {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
}


// ============================================
// ADMIN DASHBOARD STATISTICS
// ============================================

router.get("/stats", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const database = getDB();

        const users = database.collection("user");
        const services = database.collection("services");
        const bookings = database.collection("bookings");

        const [
            totalUsers,
            totalCustomers,
            totalTechnicians,
            pendingServices,
            totalServices,
            totalBookings,
            recentBookings,
        ] = await Promise.all([
            users.countDocuments(),
            users.countDocuments({ role: "customer" }),
            users.countDocuments({ role: "technician" }),
            services.countDocuments({ approvalStatus: "pending" }),
            services.countDocuments(),
            bookings.countDocuments(),
            bookings.find({})
                .sort({ createdAt: -1 })
                .limit(5)
                .toArray(),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                totalUsers,
                totalCustomers,
                totalTechnicians,
                pendingServices,
                totalServices,
                totalBookings,
                recentBookings,
            },
        });

    } catch (error) {
        console.error("Admin stats error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard statistics",
        });
    }
});


// ============================================
// ADMIN: GET ALL USERS
// ============================================

router.get("/users", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const database = getDB();

        const users = await database
            .collection("user")
            .find({})
            .project({
                name: 1,
                email: 1,
                role: 1,
                image: 1,
                createdAt: 1,
            })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            success: true,
            total: users.length,
            data: users,
        });

    } catch (error) {
        console.error("Admin users error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch users",
        });
    }
});


// ============================================
// ADMIN: UPDATE USER ROLE
// ============================================

router.patch(
    "/users/:id/role",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { role } = req.body;

            if (!["customer", "technician", "admin"].includes(role)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid user role",
                });
            }

            if (String(req.user.id) === id) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot change your own role",
                });
            }

            const database = getDB();

            const userFilter = ObjectId.isValid(id)
                ? {
                    $or: [
                        { _id: new ObjectId(id) },
                        { _id: id },
                    ],
                }
                : { _id: id };

            const result = await database
                .collection("user")
                .updateOne(
                    userFilter,
                    {
                        $set: {
                            role,
                            updatedAt: new Date(),
                        },
                    }
                );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "User not found",
                });
            }

            return res.status(200).json({
                success: true,
                message: "User role updated successfully",
            });

        } catch (error) {
            console.error("Update user role error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to update user role",
            });
        }
    }
);


// ============================================
// ADMIN: GET ALL TECHNICIAN SERVICES
// ============================================

router.get("/services", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const database = getDB();

        const services = await database
            .collection("services")
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            success: true,
            total: services.length,
            data: services,
        });

    } catch (error) {
        console.error("Admin services error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch services",
        });
    }
});


// ============================================
// ADMIN: APPROVE SERVICE
// ============================================

router.patch(
    "/services/:id/approve",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const database = getDB();

            const filter = {
                _id: new ObjectId(id),
            };

            const result = await database
                .collection("services")
                .updateOne(
                    filter,
                    {
                        $set: {
                            approvalStatus: "approved",
                            rejectionReason: "",
                            updatedAt: new Date(),
                        },
                    }
                );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Service not found",
                });
            }

            const updatedService = await database
                .collection("services")
                .findOne(filter);

            return res.status(200).json({
                success: true,
                message: "Service approved successfully",
                data: updatedService,
            });

        } catch (error) {
            console.error("Approve service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to approve service",
            });
        }
    }
);


// ============================================
// ADMIN: REJECT SERVICE
// ============================================

router.patch(
    "/services/:id/reject",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { rejectionReason = "" } = req.body || {};

            if (!isValidId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const database = getDB();

            const filter = {
                _id: new ObjectId(id),
            };

            const result = await database
                .collection("services")
                .updateOne(
                    filter,
                    {
                        $set: {
                            approvalStatus: "rejected",
                            rejectionReason,
                            updatedAt: new Date(),
                        },
                    }
                );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Service not found",
                });
            }

            const updatedService = await database
                .collection("services")
                .findOne(filter);

            return res.status(200).json({
                success: true,
                message: "Service rejected successfully",
                data: updatedService,
            });

        } catch (error) {
            console.error("Reject service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to reject service",
            });
        }
    }
);


// ============================================
// ADMIN: DELETE ONE SERVICE
// ============================================

router.delete(
    "/services/:id",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID",
                });
            }

            const database = getDB();

            const result = await database
                .collection("services")
                .deleteOne({
                    _id: new ObjectId(id),
                });

            if (result.deletedCount === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Service not found",
                });
            }

            return res.status(200).json({
                success: true,
                message: "Service deleted successfully",
                deletedId: id,
            });

        } catch (error) {
            console.error("Delete service error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to delete service",
            });
        }
    }
);


// ============================================
// ADMIN: DELETE ALL SERVICES
// ============================================

router.delete(
    "/services",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
        try {
            const database = getDB();

            const result = await database
                .collection("services")
                .deleteMany({});

            return res.status(200).json({
                success: true,
                message: "All services deleted successfully",
                deletedCount: result.deletedCount,
            });

        } catch (error) {
            console.error("Delete all services error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Failed to delete all services",
            });
        }
    }
);


// ============================================
// ADMIN: GET ALL BOOKINGS
// ============================================

router.get("/bookings", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const database = getDB();

        const bookings = await database
            .collection("bookings")
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            success: true,
            total: bookings.length,
            data: bookings,
        });

    } catch (error) {
        console.error("Admin bookings error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch bookings",
        });
    }
});


// ============================================
// ADMIN: GET ALL TRANSACTIONS
// ============================================

router.get("/transactions", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const database = getDB();

        const payments = await database
            .collection("payments")
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        const totalRevenue = payments
            .filter((payment) => payment.status === "paid")
            .reduce((total, payment) => {
                return total + Number(payment.amount || 0);
            }, 0);

        const unpaidBookings = await database
            .collection("bookings")
            .find({
                status: "completed",
                paymentStatus: "unpaid",
            })
            .toArray();

        const unpaidAmount = unpaidBookings.reduce((total, booking) => {
            return total + Number(booking.finalAmount || 0);
        }, 0);

        return res.status(200).json({
            success: true,
            total: payments.length,
            totalRevenue,
            unpaidCount: unpaidBookings.length,
            unpaidAmount,
            data: payments,
        });

    } catch (error) {
        console.error("Admin transactions error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch transactions",
        });
    }
});


export default router;
