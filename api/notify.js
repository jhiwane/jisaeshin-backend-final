const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

const ADMIN_CHAT_ID = '1383656187'; // Pastikan ID Admin Benar

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // ==========================================
        // 1. HANDLE KOMPLAIN (FIX: ADA TOMBOL BALAS)
        // ==========================================
        if (type === 'complaint') {
            const text = `⚠️ <b>LAPORAN MASALAH BARU!</b>\n\n🆔 ID: <code>${orderId}</code>\n👤 Kontak: ${buyerContact}\nPs Pesan: "${message}"\n\n👇 <i>Klik tombol di bawah untuk membalas ke User:</i>`;
            
            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "💬 BALAS PESAN USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]
                    ]
                }
            });
            return res.status(200).json({ status: 'ok' });
        }

        // ==========================================
        // 2. HANDLE ORDER MANUAL (NOTIFIKASI AWAL)
        // ==========================================
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
                        `👇 <b>TINDAKAN:</b>\nCek mutasi bank. Jika dana masuk, klik ACC.`;

            await sendMessage(ADMIN_CHAT_ID, msg, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ ACC & PROSES", callback_data: `ACC_${orderId}` },
                        { text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }
                    ]]
                }
            });
        }
        
        // ==========================================
        // 3. HANDLE ORDER OTOMATIS (NOTIF KE BOT)
        // ==========================================
        if (type === 'auto') {
             await sendMessage(ADMIN_CHAT_ID, `bf <b>PESANAN WEB (MIDTRANS)</b>\nID: ${orderId}\nTotal: Rp ${total}\n\n⚙️ <i>Sedang memproses stok otomatis...</i>`);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Notify Error:", error);
        return res.status(500).json({ error: error.message });
    }
};
