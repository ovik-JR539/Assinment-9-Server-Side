
import { jwtVerify } from "jose";

export async function verifyToken(req, res, next) {
    try {
        const authorization = req.headers.authorization;

        if (!authorization || !authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication token is required",
            });
        }

        const token = authorization.split(" ")[1];

        const secret = process.env.JWT_SECRET;

        if (!secret) {
            throw new Error("JWT_SECRET is missing");
        }

        const secretKey = new TextEncoder().encode(secret);

        const { payload } = await jwtVerify(token, secretKey);

        if (!payload.userId || !payload.email || !payload.role) {
            return res.status(401).json({
                success: false,
                message: "Invalid authentication token information",
            });
        }

        req.user = {
            id: payload.userId,
            email: payload.email,
            role: payload.role,
        };

        next();

    } catch (error) {
        console.error("Token verification error:", error.message);

        return res.status(401).json({
            success: false,
            message: "Invalid or expired authentication token",
        });
    }
}
