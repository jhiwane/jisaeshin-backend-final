const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { showAdminDashboard, handleDailyReport, handleLowStockCheck } = require('./adminCommands');

// FUNGSI TAMBAHAN UTK MENGHAPUS PESAN (OPSIONAL, AGAR CHAT BERSIH)
const fetch = require('node-fetch');
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
            const messageId = query.message.message_id; // Kita butuh ini untuk hapus pesan

            // ... (KODE ADMIN DASHBOARD TETAP SAMA) ...
            if (data === 'ADMIN_MENU') await showAdminDashboard(chatId);
            else if (data === 'ADMIN_REPORT') await handleDailyReport(chatId);
            else if (data === 'ADMIN_STOCK') await handleLowStockCheck(chatId);

            // ... (KODE TRANSAKSI LAIN TETAP SAMA) ...
            else if (data.startsWith('ACC_')) {
                const orderId = data.replace('ACC_', ''); 
                await sendMessage(chatId, `⚙️ <b>[MANUAL]</b> Memproses Order ${orderId}...`);
                const result = await processOrderStock(orderId);
                if (result.success) await sendSuccessNotification(chatId, orderId, "MANUAL ACC");
                else {
                    await sendMessage(chatId, `⚠️ <b>STOK KOSONG</b>\n${result.logs.join('\n')}`);
                    await showManualInputMenu(chatId, orderId, result.items);
                }
            }

            // === [FIX MASALAH 3: FITUR TOLAK/REJECT] ===
            else if (data.startsWith('REJECT_')) {
                const orderId = data.replace('REJECT_', '');
                
                // 1. Update Database jadi 'failed' agar Web berhenti proses
                await db.collection('orders').doc(orderId).update({ status: 'failed' });
                
                // 2. Hapus pesan notifikasi "Menunggu ACC" biar chat bersih (Efek "Hilang")
                await deleteMessage(chatId, messageId);

                // 3. Kirim konfirmasi singkat
                await sendMessage(chatId, `⛔️ Order <b>${orderId}</b> telah DITOLAK.`);
            }
            // ============================================

            else if (data.startsWith('REVISI_')) {
                const orderId = data.replace('REVISI_', '');
                const snap = await db.collection('orders').doc(orderId).get();
                if (snap.exists) await showManualInputMenu(chatId, orderId, snap.data().items);
            }

            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                const prompt = `✍️ <b>INPUT/UPDATE DATA</b>\n\nSilakan Reply pesan ini dengan data baru.\nRefID: ${orderId}\nIdx: ${itemIdx}`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }
            
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.replace('REPLY_COMPLAINT_', ''); 
                const prompt = `💬 <b>BALAS KOMPLAIN</b>\n\nSilakan tulis balasan Anda.\nRefID: ${orderId}\nMode: COMPLAINT_MODE`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }
            
            else if (data.startsWith('DONE_')) {
                const orderId = data.replace('DONE_', '');
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendSuccessNotification(chatId, orderId, "FORCED");
            }

            return res.status(200).send('ok');
        }

        // ... (BAGIAN HANDLE TEXT DI BAWAH TETAP SAMA JANGAN DIUBAH) ...
        if (update.message) {
            const text = update.message.text || "";
            const chatId = update.message.chat.id;

            if (text === '/admin' || text === '/menu') {
                await showAdminDashboard(chatId);
                return res.status(200).send('ok');
            }

            if (update.message.reply_to_message) {
                const replyOrigin = update.message.reply_to_message.text || "";
                const idMatch = replyOrigin.match(/RefID:\s*([A-Za-z0-9-]+)/);
                
                if (idMatch) {
                    const orderId = idMatch[1];
                    const idxMatch = replyOrigin.match(/Idx:\s*(\d+)/);
                    if (idxMatch) {
                        const itemIdx = parseInt(idxMatch[1]);
                        const dataArray = text.split('\n').filter(x => x.trim());

                        await db.runTransaction(async (t) => {
                            const ref = db.collection('orders').doc(orderId);
                            const doc = await t.get(ref);
                            if(!doc.exists) return;
                            const items = doc.data().items;
                            if(items[itemIdx]) {
                                items[itemIdx].data = dataArray;
                                items[itemIdx].sn = dataArray;
                                items[itemIdx].note = `Updated: ${new Date().toLocaleTimeString()}`;
                            }
                            const allFilled = items.every(i => i.data && i.data.length > 0);
                            t.update(ref, { items: items, status: allFilled ? 'success' : 'processing' });
                            return allFilled;
                        }).then(async (allFilled) => {
                             await sendMessage(chatId, `✅ Data tersimpan.`);
                             if(allFilled) await sendSuccessNotification(chatId, orderId, "DATA UPDATED"); 
                             else {
                                 const snap = await db.collection('orders').doc(orderId).get();
                                 await showManualInputMenu(chatId, orderId, snap.data().items);
                             }
                        });
                    }
                    else if (replyOrigin.includes('Mode: COMPLAINT_MODE')) {
                        await db.collection('orders').doc(orderId).update({
                            complaintReply: text, 
                            hasNewReply: true,
                            adminMessage: "Admin: " + text 
                        });
                        await sendMessage(chatId, `✅ <b>Balasan Terkirim!</b>`);
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
    return res.status(200).send('ok');
};
