const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { showAdminDashboard, handleDailyReport, handleLowStockCheck } = require('./adminCommands');
const fetch = require('node-fetch');

// Hapus Pesan Helper
async function deleteMessage(chatId, messageId) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        });
    } catch(e) {}
}

module.exports = async function(req, res) {
    const update = req.body;

    try {
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            // --- LOGIKA TOMBOL ---
            
            if (data === 'ADMIN_MENU') await showAdminDashboard(chatId);
            
            // 1. TOMBOL ACC: LANGSUNG FINALISASI (Tanpa Delay)
            else if (data.startsWith('ACC_')) {
                const orderId = data.replace('ACC_', ''); 
                await deleteMessage(chatId, messageId); // Hapus tombol ACC

                // Proses Stok (Akan selalu return success di DB)
                const result = await processOrderStock(orderId);

                // Langsung lapor ke Admin (Logika Anti-Bengong)
                // Jika kosong, admin akan lihat tombol "REVISI" di pesan ini
                await sendSuccessNotification(chatId, orderId, result.logs);
            }

            else if (data.startsWith('REJECT_')) {
                const orderId = data.replace('REJECT_', '');
                await db.collection('orders').doc(orderId).update({ status: 'failed' });
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, `⛔️ Order <b>${orderId}</b> DITOLAK.`);
            }

            // MENU REVISI
            else if (data.startsWith('REVISI_')) {
                const orderId = data.replace('REVISI_', '');
                const snap = await db.collection('orders').doc(orderId).get();
                if (snap.exists) await showManualInputMenu(chatId, orderId, snap.data().items);
            }

            // TOMBOL ISI PER ITEM (FILL)
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_'); // FILL_ORDERID_INDEX
                const orderId = parts[1];
                const itemIdx = parts[2];
                
                // Minta Input Manual
                const prompt = `✍️ <b>INPUT DATA MANUAL</b>\n\nSilakan Reply pesan ini dengan Data Akun / Voucher.\n(Bisa multi-baris untuk banyak akun)\n\nRefID: ${orderId}\nIdx: ${itemIdx}`;
                
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }

            else if (data === 'CLOSE_MENU') {
                await deleteMessage(chatId, messageId);
            }

            return res.status(200).send('ok');
        }

        // --- LOGIKA REPLY (INPUT REVISI SUPAYA MUNCUL DI WEB) ---
        if (update.message && update.message.reply_to_message) {
            const text = update.message.text || "";
            const chatId = update.message.chat.id;
            const replyOrigin = update.message.reply_to_message.text || "";

            // Pastikan ini adalah balasan untuk Input Manual
            if (replyOrigin.includes('RefID:')) {
                const idMatch = replyOrigin.match(/RefID:\s*([A-Za-z0-9-]+)/);
                const idxMatch = replyOrigin.match(/Idx:\s*(\d+)/);
                
                if (idMatch && idxMatch) {
                    const orderId = idMatch[1];
                    const itemIdx = parseInt(idxMatch[1]); // Ambil Index Item
                    
                    // Split text kalau ada banyak baris (untuk multi qty)
                    const dataArray = text.split('\n').filter(x => x.trim().length > 0);

                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if(!doc.exists) return;
                        
                        const items = doc.data().items;
                        
                        // PASTIKAN UPDATE SEMUA FIELD PENTING
                        if(items[itemIdx]) {
                            items[itemIdx].data = dataArray; // Array murni
                            items[itemIdx].sn = dataArray;   // Duplicate ke SN
                            items[itemIdx].desc = dataArray.join('\n'); // Join jadi string (fallback frontend lama)
                            items[itemIdx].manualInputTime = new Date().toISOString();
                        }
                        
                        // FORCE UPDATE KE DATABASE
                        t.update(ref, { 
                            items: items, 
                            status: 'success' // Pastikan status success agar tampil di web
                        });
                    });

                    // Konfirmasi ke Admin
                    await sendMessage(chatId, `✅ <b>DATA TERSIMPAN!</b>\nSilakan cek Web user.`);
                    
                    // Opsional: Kirim ulang notif sukses agar link WA terupdate dengan data baru
                    await sendSuccessNotification(chatId, orderId, ["Data Manual Updated"]);
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};
