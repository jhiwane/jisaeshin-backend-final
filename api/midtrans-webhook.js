const { db } = require('./firebaseConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { sendMessage } = require('./botConfig'); // Import sendMessage

const ADMIN_CHAT_ID = '1383656187';

module.exports = async function(req, res) {
    const { order_id, transaction_status } = req.body;

    if (transaction_status == 'capture' || transaction_status == 'settlement') {
        try {
            console.log(`[MIDTRANS] Order ${order_id} LUNAS.`);

            // 1. Update status
            await db.collection('orders').doc(order_id).update({ status: 'paid' });

            // 2. Proses Stok
            const result = await processOrderStock(order_id);

            if (result.success) {
                // [FIX] KIRIM NOTIFIKASI KE TELEGRAM AGAR ADMIN TAU
                await sendSuccessNotification(ADMIN_CHAT_ID, order_id, "MIDTRANS OTOMATIS");
                console.log(`[MIDTRANS] Notif terkirim.`);
            } else {
                // Jika stok habis
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>MIDTRANS LUNAS TAPI STOK GAGAL</b>\nOrder: ${order_id}`);
                await showManualInputMenu(ADMIN_CHAT_ID, order_id, result.items);
            }

        } catch (e) {
            console.error("Midtrans Error:", e);
        }
    }
    // Selalu return 200 ke Midtrans agar tidak dikirim ulang terus menerus
    res.status(200).send('ok');
};
