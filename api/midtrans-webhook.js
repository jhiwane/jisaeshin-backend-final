const midtransClient = require('midtrans-client');
const { sendMessage } = require('./botConfig'); // Import botConfig

const apiClient = new midtransClient.Snap({
    isProduction: true, 
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

// Ambil Chat ID dari .env
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

module.exports = async (req, res) => {
    try {
        const notificationJson = req.body;
        
        // 1. Verifikasi Data Midtrans
        const statusResponse = await apiClient.transaction.notification(notificationJson);

        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;
        const grossAmount = statusResponse.gross_amount;
        const paymentType = statusResponse.payment_type;

        console.log(`[WEBHOOK] Order: ${orderId} | Status: ${transactionStatus}`);

        // 2. Logika Notifikasi
        let message = "";
        let shouldSend = false;

        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                message = `⚠️ <b>Transaksi Ditahan (Challenge)</b>\nID: ${orderId}`;
                shouldSend = true;
            } else if (fraudStatus == 'accept') {
                message = `✅ <b>PEMBAYARAN SUKSES (CC)</b>\n\n🆔 ID: ${orderId}\n💰 Rp ${grossAmount}`;
                shouldSend = true;
            }
        } else if (transactionStatus == 'settlement') {
            // Sukses QRIS / VA
            message = `✅ <b>PEMBAYARAN DITERIMA!</b>\n\n` +
                      `🆔 ID: <code>${orderId}</code>\n` +
                      `💰 Nominal: Rp ${grossAmount}\n` +
                      `💳 Metode: ${paymentType}\n` +
                      `📅 Status: Lunas`;
            shouldSend = true;
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            message = `❌ <b>Transaksi Gagal/Batal</b>\nID: ${orderId}\nStatus: ${transactionStatus}`;
            shouldSend = true;
        }

        // 3. Kirim ke Telegram Admin
        if (shouldSend && ADMIN_CHAT_ID) {
            await sendMessage(ADMIN_CHAT_ID, message);
        }

        // Selalu balas OK ke Midtrans
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.status(200).send('OK'); 
    }
};
