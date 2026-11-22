
import express from "express";
import { ObjectId } from "mongodb";
import { getDB } from "../config/mongodb.js";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

// --------------------
// Bangladesh date/time helpers
// --------------------

function getTodayInBangladesh() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Dhaka",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function isValidDateString(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(`${value}T00:00:00+06:00`);

    return (
        !Number.isNaN(date.getTime()) &&
        date.toLocaleDateString("en-CA", {
            timeZone: "Asia/Dhaka",
        }) === value
    );
}

function isValidTimeString(value) {
    return (
        typeof value === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    );
}

// --------------------
// Role checks
// --------------------

function verifyCustomer(req, res, next) {
    if (req.user?.role !== "customer") {
        return res.status(403).json({
            success: false,
            message: "Only customers can perform this action.",
        });
    }

    next();
}

function verifyTechnician(req, res, next) {
    if (req.user?.role !== "technician") {
        return res.status(403).json({
            success: false,
            message: "Only technicians can perform this action.",
        });
    }

    next();
}

// --------------------
// CUSTOMER: Get own bookings
// GET /api/bookings/my-bookings
// --------------------

router.get(
    "/my-bookings",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const db = getDB();

            const bookings = await db
                .collection("bookings")
                .find({
                    customerEmail: req.user.email,
                })
                .sort({ createdAt: -1 })
                .toArray();

            return res.json({
                success: true,
                data: bookings,
            });
        } catch (error) {
            console.error("Get customer bookings error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to load your bookings.",
            });
        }
    }
);

// --------------------
// TECHNICIAN: Get assigned bookings
// GET /api/bookings/technician-bookings
// --------------------

router.get(
    "/technician-bookings",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const db = getDB();

            const bookings = await db
                .collection("bookings")
                .find({
                    technicianEmail: req.user.email,
                    status: {
                        $in: [
                            "requested",
                            "accepted",
                            "in-progress",
                            "completed",
                        ],
                    },
                })
                .sort({ createdAt: -1 })
                .toArray();

            return res.json({
                success: true,
                data: bookings,
            });
        } catch (error) {
            console.error("Get technician bookings error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to load technician bookings.",
            });
        }
    }
);

// --------------------
// TECHNICIAN: Update booking status
// PATCH /api/bookings/:id/status
// --------------------

router.patch(
    "/:id/status",
    verifyToken,
    verifyTechnician,
    async (req, res) => {
        try {
            const { id } = req.params;
            const { status, finalAmount, priceExplanation } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid booking ID.",
                });
            }

            const allowedStatuses = [
                "accepted",
                "rejected",
                "in-progress",
                "completed",
            ];

            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid booking status.",
                });
            }

            const db = getDB();
            const bookings = db.collection("bookings");

            // Make sure this booking belongs to the logged-in technician
            const booking = await bookings.findOne({
                _id: new ObjectId(id),
                technicianEmail: req.user.email,
            });

            if (!booking) {
                return res.status(404).json({
                    success: false,
                    message: "Booking not found.",
                });
            }

            // Booking status workflow:
            // requested -> accepted OR rejected
            // accepted -> in-progress
            // in-progress -> completed

            const allowedTransitions = {
                requested: ["accepted", "rejected"],

                // Support older bookings created before this workflow change.
                approved: ["accepted", "rejected"],

                accepted: ["in-progress"],
                "in-progress": ["completed"],
            };

            if (!allowedTransitions[booking.status]?.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: `You cannot change a booking from ${booking.status} to ${status}.`,
                });
            }

            const now = new Date();

            const updateData = {
                status,
                updatedAt: now,
            };

            if (status === "accepted") {
                updateData.acceptedAt = now;
            }

            if (status === "rejected") {
                updateData.rejectedAt = now;
            }

            if (status === "in-progress") {
                updateData.startedAt = now;
            }

            if (status === "completed") {
                const amount = Number(finalAmount);

                if (
                    finalAmount === undefined ||
                    finalAmount === null ||
                    finalAmount === "" ||
                    !Number.isFinite(amount) ||
                    amount <= 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Please provide a valid final amount.",
                    });
                }

                if (
                    typeof priceExplanation !== "string" ||
                    !priceExplanation.trim() ||
                    priceExplanation.trim().length > 500
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Please provide a price explanation (maximum 500 characters).",
                    });
                }

                if (
                    !Number.isFinite(Number(booking.basePrice)) ||
                    Number(booking.basePrice) <= 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "The booking has an invalid base price.",
                    });
                }

                updateData.finalAmount = amount;
                updateData.priceExplanation = priceExplanation.trim();
                updateData.completedAt = now;
            }

            // Check the previous status again to prevent simultaneous updates
            const result = await bookings.updateOne(
                {
                    _id: new ObjectId(id),
                    technicianEmail: req.user.email,
                    status: booking.status,
                },
                {
                    $set: updateData,
                }
            );

            if (result.matchedCount === 0) {
                return res.status(409).json({
                    success: false,
                    message:
                        "The booking was changed by another request. Please refresh and try again.",
                });
            }

            return res.json({
                success: true,
                message: `Booking ${status} successfully.`,
            });
        } catch (error) {
            console.error("Technician booking status error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to update booking status.",
            });
        }
    }
);

// --------------------
// CUSTOMER: Cancel requested booking
// PATCH /api/bookings/:id/cancel
// --------------------

router.patch(
    "/:id/cancel",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid booking ID.",
                });
            }

            const db = getDB();

            const result = await db.collection("bookings").updateOne(
                {
                    _id: new ObjectId(id),
                    customerEmail: req.user.email,
                    status: "requested",
                },
                {
                    $set: {
                        status: "cancelled",
                        cancelledAt: new Date(),
                        updatedAt: new Date(),
                    },
                }
            );

            if (result.matchedCount === 0) {
                return res.status(400).json({
                    success: false,
                    message: "This booking cannot be cancelled.",
                });
            }

            return res.json({
                success: true,
                message: "Booking cancelled successfully.",
            });
        } catch (error) {
            console.error("Cancel booking error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to cancel booking.",
            });
        }
    }
);

// --------------------
// CUSTOMER: Create booking
// POST /api/bookings
// --------------------

router.post(
    "/",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const {
                serviceId,
                phone,
                address,
                repairMethod,
                bookingDate,
                bookingTime,
                problemDescription,
            } = req.body;

            // Validate required fields
            if (
                typeof serviceId !== "string" ||
                typeof phone !== "string" ||
                typeof address !== "string" ||
                typeof repairMethod !== "string" ||
                typeof bookingDate !== "string" ||
                typeof bookingTime !== "string" ||
                typeof problemDescription !== "string" ||
                !serviceId.trim() ||
                !phone.trim() ||
                !address.trim() ||
                !repairMethod.trim() ||
                !bookingDate.trim() ||
                !bookingTime.trim() ||
                !problemDescription.trim()
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Please complete all required fields with valid values.",
                });
            }

            if (!ObjectId.isValid(serviceId)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service ID.",
                });
            }

            const allowedRepairMethods = [
                "Home Visit",
                "Shop Drop-off",
            ];

            if (!allowedRepairMethods.includes(repairMethod)) {
                return res.status(400).json({
                    success: false,
                    message: "Please select a valid repair method.",
                });
            }

            const cleanPhone = phone.trim();
            const cleanAddress = address.trim();
            const cleanDescription = problemDescription.trim();

            if (cleanPhone.length < 8 || cleanPhone.length > 20) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid phone number.",
                });
            }

            if (cleanAddress.length < 5) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a complete address.",
                });
            }

            if (
                cleanDescription.length < 20 ||
                cleanDescription.length > 1000
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Problem description must be between 20 and 1000 characters.",
                });
            }

            // Validate date and time
            if (
                !isValidDateString(bookingDate) ||
                !isValidTimeString(bookingTime)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid booking date and time.",
                });
            }

            if (bookingDate < getTodayInBangladesh()) {
                return res.status(400).json({
                    success: false,
                    message: "Booking date cannot be in the past.",
                });
            }

            const bookingDateTime = new Date(
                `${bookingDate}T${bookingTime}:00+06:00`
            );

            if (
                Number.isNaN(bookingDateTime.getTime()) ||
                bookingDateTime <= new Date()
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Please select a future date and time.",
                });
            }

            const db = getDB();

            // Only approved and available services can be booked.
            // Service approval by admin is still required.
            const service = await db.collection("services").findOne({
                _id: new ObjectId(serviceId),
                approvalStatus: "approved",
                isAvailable: true,
                isDeleted: { $ne: true },
            });

            if (!service) {
                return res.status(404).json({
                    success: false,
                    message:
                        "This service is unavailable or has not been approved.",
                });
            }

            if (!service.technicianEmail || !service.technicianName) {
                return res.status(400).json({
                    success: false,
                    message:
                        "This service does not have a valid assigned technician.",
                });
            }

            // Prevent duplicate active bookings for the same customer and service.
            const existingBooking = await db.collection("bookings").findOne({
                customerEmail: req.user.email,
                serviceId,
                status: {
                    $in: [
                        "requested",
                        "approved",
                        "accepted",
                        "in-progress",
                    ],
                },
            });

            if (existingBooking) {
                return res.status(409).json({
                    success: false,
                    message:
                        "You already have an active booking for this service.",
                });
            }

            // Find customer account
            const customer = await db.collection("user").findOne({
                email: req.user.email,
            });

            if (!customer) {
                return res.status(404).json({
                    success: false,
                    message: "Customer account not found.",
                });
            }

            const now = new Date();

            // Create booking directly as requested.
            // No admin booking approval is required.
            const booking = {
                serviceId,
                serviceTitle: service.title,
                serviceCategory: service.category,
                serviceImage: service.image,
                basePrice: Number(service.basePrice),
                estimatedDuration: service.estimatedDuration,

                serviceMode: repairMethod,
                repairMethod,

                serviceArea: service.serviceArea,

                technicianName: service.technicianName,
                technicianEmail: service.technicianEmail,

                customerId: req.user.id,
                customerName: customer.name || req.user.name || "",
                customerEmail: req.user.email,
                customerPhone: cleanPhone,
                customerAddress: cleanAddress,

                preferredDate: new Date(
                    `${bookingDate}T12:00:00.000Z`
                ),
                bookingDate,
                bookingTime,
                bookingDateTime,

                problemDescription: cleanDescription,

                status: "requested",
                paymentStatus: "unpaid",

                createdAt: now,
                updatedAt: now,
            };

            const result = await db
                .collection("bookings")
                .insertOne(booking);

            return res.status(201).json({
                success: true,
                message:
                    "Repair request submitted successfully. The technician can now accept or reject your request.",
                bookingId: result.insertedId,
                data: {
                    ...booking,
                    _id: result.insertedId,
                },
            });
        } catch (error) {
            console.error("Create booking error:", error);

            return res.status(500).json({
                success: false,
                message: "Failed to submit your repair request.",
            });
        }
    }
);

export default router;
