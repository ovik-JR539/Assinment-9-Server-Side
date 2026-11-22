
import express from "express";
import Stripe from "stripe";
import { ObjectId } from "mongodb";

import { getDB } from "../config/mongodb.js";
import { verifyToken } from "../middleware/verifyToken.js";

const router = express.Router();

// ============================================
// STRIPE CONNECTION
// ============================================

function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error("Stripe secret key is missing");
    }

    return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// ============================================
// CUSTOMER-ONLY MIDDLEWARE
// ============================================

function verifyCustomer(req, res, next) {
    if (req.user?.role !== "customer") {
        return res.status(403).json({
            success: false,
            message: "Only customers can make payments",
        });
    }

    next();
}

// ============================================
// HELPER: VERIFY STRIPE SESSION
// ============================================

function verifySessionDetails(session, booking, bookingId, customerEmail) {
    const expectedAmount = Math.round(
        Number(booking.finalAmount) * 100
    );

    return (
        session.metadata?.bookingId === bookingId &&
        session.metadata?.customerEmail === customerEmail &&
        session.currency === "usd" &&
        session.amount_total === expectedAmount &&
        Number.isFinite(expectedAmount) &&
        expectedAmount > 0
    );
}

// ============================================
// HELPER: SAVE SUCCESSFUL PAYMENT
// ============================================

async function saveSuccessfulPayment(session, booking, bookingId, customerEmail) {
    const db = getDB();

    const bookings = db.collection("bookings");
    const payments = db.collection("payments");

    if (!verifySessionDetails(session, booking, bookingId, customerEmail)) {
        throw new Error("Stripe payment details do not match the booking");
    }

    const paymentIntentId =
        typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || null;

    // Prevent duplicate payment records.
    await payments.createIndex(
        { stripeSessionId: 1 },
        { unique: true }
    );

    // Save payment information.
    await payments.updateOne(
        { stripeSessionId: session.id },
        {
            $setOnInsert: {
                bookingId: new ObjectId(bookingId),
                customerEmail,
                technicianEmail: booking.technicianEmail,
                serviceTitle: booking.serviceTitle,
                amount: booking.finalAmount,
                currency: "usd",
                stripeSessionId: session.id,
                stripePaymentIntentId: paymentIntentId,
                status: "paid",
                createdAt: new Date(),
            },
        },
        { upsert: true }
    );

    // Update booking payment status.
    await bookings.updateOne(
        {
            _id: new ObjectId(bookingId),
            customerEmail,
            stripeCheckoutSessionId: session.id,
            paymentStatus: { $ne: "paid" },
        },
        {
            $set: {
                paymentStatus: "paid",
                paidAt: new Date(),
                stripePaymentIntentId: paymentIntentId,
                updatedAt: new Date(),
            },
        }
    );

    console.log(`Payment confirmed for booking ${bookingId}`);
}

// ============================================
// CUSTOMER: CREATE CHECKOUT SESSION
// ============================================

router.post(
    "/create-checkout-session",
    verifyToken,
    verifyCustomer,
    async (req, res) => {
        try {
            const { bookingId } = req.body;

            // Validate booking ID.
            if (!bookingId || !ObjectId.isValid(bookingId)) {
                return res.status(400).json({
                    success: false,
                    message: "A valid booking ID is required",
                });
            }

            const db = getDB();
            const bookings = db.collection("bookings");

            // Find customer's booking.
            const booking = await bookings.findOne({
                _id: new ObjectId(bookingId),
                customerEmail: req.user.email,
            });

            if (!booking) {
                return res.status(404).json({
                    success: false,
                    message: "Booking not found",
                });
            }

            // Only completed repairs can be paid.
            if (booking.status !== "completed") {
                return res.status(400).json({
                    success: false,
                    message: "You can only pay for completed repairs",
                });
            }

            // Check MongoDB payment status.
            if (booking.paymentStatus === "paid") {
                return res.status(409).json({
                    success: false,
                    alreadyPaid: true,
                    message: "This booking has already been paid",
                });
            }

            // Validate final amount.
            const amount = Number(booking.finalAmount);

            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid final repair amount",
                });
            }

            const stripe = getStripe();

            // ========================================
            // CHECK PREVIOUS STRIPE SESSION
            // ========================================

            if (booking.stripeCheckoutSessionId) {
                const existingSession =
                    await stripe.checkout.sessions.retrieve(
                        booking.stripeCheckoutSessionId
                    );

                // Verify that the old session belongs to this booking.
                if (
                    existingSession.metadata?.bookingId !== bookingId ||
                    existingSession.metadata?.customerEmail !== req.user.email
                ) {
                    throw new Error(
                        "Existing Stripe session does not match this booking"
                    );
                }

                // Reuse an open checkout session.
                if (
                    existingSession.status === "open" &&
                    existingSession.payment_status !== "paid"
                ) {
                    return res.status(200).json({
                        success: true,
                        url: existingSession.url,
                    });
                }

                // Stripe already received payment.
                if (existingSession.payment_status === "paid") {
                    await saveSuccessfulPayment(
                        existingSession,
                        booking,
                        bookingId,
                        req.user.email
                    );

                    return res.status(409).json({
                        success: false,
                        alreadyPaid: true,
                        message: "Payment already completed. Please refresh your bookings.",
                    });
                }

                // Expired or incomplete sessions can be replaced.
            }

            // ========================================
            // CREATE NEW STRIPE CHECKOUT SESSION
            // ========================================

            const clientUrl = process.env.CLIENT_URL;

            if (!clientUrl) {
                throw new Error("CLIENT_URL is missing");
            }

            const session = await stripe.checkout.sessions.create({
                mode: "payment",

                customer_email: req.user.email,

                line_items: [
                    {
                        price_data: {
                            currency: "usd",

                            product_data: {
                                name:
                                    booking.serviceTitle ||
                                    "FixMate Repair Service",

                                description: `Repair booking #${bookingId}`,
                            },

                            unit_amount: Math.round(amount * 100),
                        },

                        quantity: 1,
                    },
                ],

                metadata: {
                    bookingId,
                    customerEmail: req.user.email,
                },

                success_url:
                    `${clientUrl}/dashboard/my-bookings?payment=success&session_id={CHECKOUT_SESSION_ID}`,

                cancel_url:
                    `${clientUrl}/dashboard/my-bookings?payment=cancelled`,
            });

            // Save the new session ID.
            await bookings.updateOne(
                {
                    _id: new ObjectId(bookingId),
                    customerEmail: req.user.email,
                    paymentStatus: { $ne: "paid" },
                },
                {
                    $set: {
                        stripeCheckoutSessionId: session.id,
                        updatedAt: new Date(),
                    },
                }
            );

            // Return Stripe Checkout URL to frontend.
            return res.status(200).json({
                success: true,
                url: session.url,
            });

        } catch (error) {
            console.error(
                "Create Checkout Session error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                message: "Unable to start payment. Please try again.",
            });
        }
    }
);

// ============================================
// STRIPE WEBHOOK: CONFIRM SUCCESSFUL PAYMENT
// ============================================

router.post("/webhook", async (req, res) => {
    try {
        const stripe = getStripe();

        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!webhookSecret) {
            throw new Error("Stripe webhook secret is missing");
        }

        if (!req.rawBody) {
            throw new Error("Raw webhook body is missing");
        }

        const signature = req.headers["stripe-signature"];

        if (!signature) {
            return res.status(400).json({
                success: false,
                message: "Stripe signature is missing",
            });
        }

        // Verify Stripe webhook signature.
        const event = stripe.webhooks.constructEvent(
            req.rawBody,
            signature,
            webhookSecret
        );

        // ========================================
        // CHECK COMPLETED CHECKOUT SESSION
        // ========================================

        if (event.type === "checkout.session.completed") {
            const session = event.data.object;

            if (session.payment_status !== "paid") {
                return res.status(200).json({
                    received: true,
                    message: "Payment is not completed yet",
                });
            }

            const bookingId = session.metadata?.bookingId;
            const customerEmail = session.metadata?.customerEmail;

            if (
                !bookingId ||
                !ObjectId.isValid(bookingId) ||
                !customerEmail
            ) {
                console.log(
                    "Ignoring Stripe event without FixMate booking information"
                );

                return res.status(200).json({
                    received: true,
                    message: "No FixMate booking associated with this event",
                });
            }

            if (session.currency !== "usd") {
                throw new Error("Unexpected payment currency");
            }

            const db = getDB();
            const bookings = db.collection("bookings");

            // Find the original completed booking.
            const booking = await bookings.findOne({
                _id: new ObjectId(bookingId),
                customerEmail,
                status: "completed",
                stripeCheckoutSessionId: session.id,
            });

            if (!booking) {
                throw new Error(
                    "Matching completed booking not found"
                );
            }

            // Save payment and update booking.
            await saveSuccessfulPayment(
                session,
                booking,
                bookingId,
                customerEmail
            );
        }

        return res.status(200).json({
            received: true,
        });

    } catch (error) {
        console.error(
            "Stripe webhook processing error:",
            error.message
        );

        return res.status(400).json({
            success: false,
            message: "Webhook processing failed",
        });
    }
});

export default router;
