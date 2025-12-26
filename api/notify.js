const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; 

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total } = req.body;

    try {
        // 1. AUTO / MIDTRANS SUKSES (WEB)
        if (type === 'auto') {
            await sendMessage(ADMIN_CHAT_ID, `bf <b>PESANAN WEB (MIDTRANS)</b>\nID: ${orderId}\nTotal: Rp ${total}\n\n⚙️ <i>Memproses stok otomatis...</i>`);
            
            // --- FIX BENGONG (POIN 2) ---
            // Langsung panggil fungsi proses stok disini!
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                // Jika stok ada, kirim notif sukses persis kayak manual
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");
            } else {
                // Jika stok kosong, munculkan menu input manual
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK OTOMATIS GAGAL/KOSONG</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // 2. KOMPLAIN
        else if (type === 'complaint') {
            const text = `⚠️ <b>KOMPLAIN MASUK</b>\nID: <code>${orderId}</code>\nUser: ${buyerContact}\nPesan: "${message}"\n\n👇 Klik tombol untuk balas:`;
            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "💬 BALAS PESAN", callback_data: `REPLY_COMPLAINT_${orderId}` }]]
                }
            });
        }
        
        // 3. KONFIRMASI MANUAL TRANSFER
        else if (type === 'manual') {
            const text = `💸 <b>KONFIRMASI MANUAL</b>\nID: <code>${orderId}</code>\nTotal: Rp ${total}\nUser: ${buyerContact}\n\nCek mutasi lalu klik:`;
            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "✅ ACC", callback_data: `ACC_${orderId}` }]]
                }
            });
        }

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
};
