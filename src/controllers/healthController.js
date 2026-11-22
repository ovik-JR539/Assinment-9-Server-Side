
export function checkHealth(req, res) {

    res.status(200).json({

        success: true,

        message: "FixMate server is running successfully",

        database: "Connected",

        timestamp: new Date(),

    });

}
