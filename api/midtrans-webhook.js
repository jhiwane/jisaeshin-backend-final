const { db } = require('./firebaseConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187';

module.exports = async function(req, res) {
    const { order_id, transaction_status } = req.body;

    if (transaction_status == 'capture' || transaction_status == 'settlement') {
        try {
            // Update status dulu biar aman
            await db.collection('orders').doc(order_id).update({ status: 'paid' });

            // Proses Stok (Pakai logika yang sama dgn Notify/Telegram)
            const result = await processOrderStock(order_id);

            if (result.success) {
                // Jangan kirim notif double jika Notify.js sudah mengirimnya
                // Cek flag atau biarkan saja (biasanya midtrans webhook duluan daripada notify web)
                // Kita kirim notif silent sebagai log
                console.log(`Midtrans ${order_id} Sukses`);
            } else {
                // Jika stok habis, admin harus tau
                await showManualInputMenu(ADMIN_CHAT_ID, order_id, result.items);
            }

        } catch (e) {
            console.error("Midtrans Error:", e);
        }
    }
    res.status(200).send('ok');
};
