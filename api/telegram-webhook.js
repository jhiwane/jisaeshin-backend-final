const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { showAdminDashboard, handleDailyReport, handleLowStockCheck } = require('./adminCommands');
const fetch = require('node-fetch');

// Fungsi Hapus Pesan (Pembersih)
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

            // --- TOMBOL INTERAKSI ADMIN ---

            if (data === 'ADMIN_MENU') await showAdminDashboard(chatId);
            
            // LOGIKA UTAMA: TOMBOL ACC (TERIMA)
            else if (data.startsWith('ACC_')) {
                const orderId = data.replace('ACC_', ''); 
                
                // 1. BERSIHKAN CHAT: Hapus tombol ACC lama biar gak numpuk
                await deleteMessage(chatId, messageId);

                // 2. PROSES STOK (Cari dalam-dalam)
                // Fungsi ini akan SELALU set status DB -> 'success' (walau kosong)
                const result = await processOrderStock(orderId);

                // 3. AUTO FINALIZE (ALUR 3 DETIK -> LANGSUNG)
                // Kita langsung kirim notif "Done ✅" ke Admin.
                // Pembeli di Web sudah melihat status sukses (walau data kosong).
                await sendSuccessNotification(chatId, orderId, result.logs);

                // 4. CEK APAKAH PERLU INPUT MANUAL?
                // Jika ada item kosong, kita TIDAK MENAHAN proses. 
                // Kita cuma kasih tau admin lewat pesan Done tadi (ada tombol Revisi).
                // Jadi Admin tidak perlu nunggu 3 detik, bot langsung kerja.
            }

            else if (data.startsWith('REJECT_')) {
                const orderId = data.replace('REJECT_', '');
                await db.collection('orders').doc(orderId).update({ status: 'failed' });
                await deleteMessage(chatId, messageId); // Hapus tombol
                await sendMessage(chatId, `⛔️ Order <b>${orderId}</b> DITOLAK.`);
            }

            else if (data.startsWith('REVISI_')) {
                const orderId = data.replace('REVISI_', '');
                const snap = await db.collection('orders').doc(orderId).get();
                if (snap.exists) await showManualInputMenu(chatId, orderId, snap.data().items);
            }

            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                const prompt = `✍️ <b>INPUT DATA MANUAL</b>\nRefID: ${orderId}\nIdx: ${itemIdx}\n\nReply pesan ini dengan data akun/voucher.`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }

            else if (data === 'CLOSE_MENU') {
                await deleteMessage(chatId, messageId);
            }
            
            // ... (Kode lain COMPLAINT, dll tetap sama) ...

            return res.status(200).send('ok');
        }

        // --- HANDLE TEXT INPUT (REPLY) ---
        if (update.message && update.message.reply_to_message) {
            const text = update.message.text || "";
            const chatId = update.message.chat.id;
            const replyOrigin = update.message.reply_to_message.text || "";

            // Deteksi Input Manual
            if (replyOrigin.includes('RefID:')) {
                const idMatch = replyOrigin.match(/RefID:\s*([A-Za-z0-9-]+)/);
                const idxMatch = replyOrigin.match(/Idx:\s*(\d+)/);
                
                if (idMatch && idxMatch) {
                    const orderId = idMatch[1];
                    const itemIdx = parseInt(idxMatch[2]);
                    const dataArray = text.split('\n').filter(x => x.trim());

                    // Simpan ke DB
                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if(!doc.exists) return;
                        const items = doc.data().items;
                        
                        if(items[itemIdx]) {
                            items[itemIdx].data = dataArray;
                            items[itemIdx].sn = dataArray;
                            items[itemIdx].note = `Manual Input: ${new Date().toLocaleTimeString()}`;
                        }
                        // Pastikan status tetap success
                        t.update(ref, { items: items, status: 'success' });
                    });

                    await sendMessage(chatId, `✅ Data tersimpan! Cek Web/Link WA.`);
                    // Opsional: Kirim ulang notif sukses untuk refresh tombol
                    await sendSuccessNotification(chatId, orderId, ["Manual Update"]);
                }
            }
        }

    } catch (e) {
        console.error(e);
    }
    return res.status(200).send('ok');
};
