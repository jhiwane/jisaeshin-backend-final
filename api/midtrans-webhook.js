const midtransClient = require('midtrans-client');
// Jika ingin update database di sini, kamu perlu inisialisasi Firebase Admin SDK di backend
// Tapi untuk sekarang, kita log saja biar simpel.

const apiClient = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

module.exports = async (req, res) => {
    try {
        const notificationJson = req.body;
        
        // Verifikasi tanda tangan Midtrans (Security)
        const statusResponse = await apiClient.transaction.notification(notificationJson);
        
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`[WEBHOOK] Order: ${orderId} | Status: ${transactionStatus}`);

        // Di sini kamu bisa tambahkan logika update database Firebase (Admin SDK)
        // jika ingin status berubah 'paid' meskipun user menutup browser.
        
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.status(200).send('OK'); // Selalu balas OK ke Midtrans biar gak di-spam
    }
};
