const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID;

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message } = req.body;

    try {
        // 1. Handle Komplain
        if (type === 'complaint') {
            const text = `⚠️ <b>KOMPLAIN BARU!</b>\nOrder ID: <code>${orderId}</code>\nKontak: ${buyerContact}\nPesan: ${message}\n\n👉 <i>Reply pesan ini untuk membalas ke web pembeli.</i>`;
            await sendMessage(ADMIN_CHAT_ID, text);
            return res.status(200).json({ status: 'ok' });
        }

        // 2. Handle Konfirmasi Manual
        if (type === 'manual') {
            const orderSnap = await db.collection('orders').doc(orderId).get();
            if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found' });

            const orderData = orderSnap.data();
            const itemsList = orderData.items.map(i => `- ${i.name} (x${i.qty})`).join('\n');

            const msg = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n` +
                        `ID: <code>${orderId}</code>\n` +
                        `Total: Rp ${orderData.total.toLocaleString()}\n` +
                        `Kontak: ${buyerContact}\n\n` +
                        `🛒 <b>Items:</b>\n${itemsList}\n\n` +
                        `👇 <b>TINDAKAN:</b>\nCek mutasi. Jika OK, klik tombol di bawah.`;

            await sendMessage(ADMIN_CHAT_ID, msg, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ ACC PEMBAYARAN", callback_data: `ACC_${orderId}` },
                        { text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }
                    ]]
                }
            });
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
};
