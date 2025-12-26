const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || '1383656187';

module.exports = async function(req, res) {
    const { order_id, transaction_status } = req.body;
    
    // Syarat status lunas Midtrans
    if (transaction_status === 'capture' || transaction_status === 'settlement') {
        try {
            const orderRef = db.collection('orders').doc(order_id);
            const doc = await orderRef.get();
            
            if (doc.exists) {
                // 1. Update status di Firebase agar web user melihat status "PAID"
                await orderRef.update({ status: 'paid' });
                
                // 2. Kirim Notifikasi ke Admin Bot agar Admin bisa langsung proses (ACC)
                const orderData = doc.data();
                const text = `💰 <b>PEMBAYARAN MIDTRANS LUNAS!</b>\n` +
                             `--------------------------------\n` +
                             `ID Order: <code>${order_id}</code>\n` +
                             `Total: Rp ${orderData.total.toLocaleString()}\n\n` +
                             `👇 <b>TINDAKAN:</b>\n` +
                             `Klik tombol di bawah untuk proses stok otomatis atau input data manual.`;
                
                await sendMessage(ADMIN_ID, text, {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "⚡ PROSES ORDER (ACC)", callback_data: `ACC_${order_id}` }
                        ]]
                    }
                });
            }
        } catch (error) {
            console.error("Midtrans Webhook Error:", error);
        }
    }
    res.status(200).json({ status: 'ok' });
};
