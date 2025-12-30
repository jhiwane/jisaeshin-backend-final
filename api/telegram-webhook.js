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

                // --- PERBAIKAN LOGIKA DISINI ---
                // Jalankan proses pengurangan stok di database
                const result = await processOrderStock(orderId);

                // Kirim Notifikasi Sukses TERLEBIH DAHULU (Agar data produk utama muncul otomatis)
                await sendSuccessNotification(chatId, orderId, "ACC ADMIN");

                // Jika ada item yang masih kosong (perlu manual), tampilkan menunya
                if (!result.success) {
                    await sendMessage(chatId, "⚠️ <b>Beberapa item memerlukan input manual:</b>");
                    await showManualInputMenu(chatId, orderId, result.items);
                }
            }
            
            else if (data.startsWith('REJECT_')) {
                const orderId = data.replace('REJECT_', '');
                await db.collection('orders').doc(orderId).update({ status: 'failed' });
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, `❌ Order <code>${orderId}</code> telah DITOLAK.`);
            }

            else if (data.startsWith('REVISI_')) {
                const orderId = data.replace('REVISI_', '');
                const snap = await db.collection('orders').doc(orderId).get();
                if(snap.exists) await showManualInputMenu(chatId, orderId, snap.data().items);
            }

            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                // Simpan state user sedang input manual ke database/cache jika perlu
                await sendMessage(chatId, `📝 <b>INPUT DATA</b>\nSilakan kirim data untuk item ke-${parseInt(itemIdx)+1}.\n\n<i>Gunakan Enter untuk banyak baris.</i>\n\nContoh:\n<code>email:pass\nemail:pass</code>`, {
                    reply_markup: { force_reply: true }
                });
                // Simpan context admin untuk ReplyHandler (Bisa pakai metadata database)
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_MANUAL_INPUT',
                    orderId: orderId,
                    itemIdx: itemIdx
                });
            }

            else if (data.startsWith('DONE_')) {
                const orderId = data.replace('DONE_', '');
                await sendSuccessNotification(chatId, orderId, "MANUAL ADMIN");
                await deleteMessage(chatId, messageId);
            }
        } 

        // 2. LOGIKA REPLIES (UNTUK INPUT MANUAL)
        else if (update.message && update.message.reply_to_message) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            
            const contextSnap = await db.collection('admin_context').doc(chatId.toString()).get();
            if (contextSnap.exists) {
                const context = contextSnap.data();
                if (context.action === 'WAITING_MANUAL_INPUT') {
                    const { orderId, itemIdx } = context;
                    const dataArray = text.split('\n').map(x => x.trim()).filter(x => x);
                    
                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if(!doc.exists) return;
                        
                        const items = doc.data().items;
                        
                        if(items[itemIdx]) {
                            items[itemIdx].data = dataArray; 
                            items[itemIdx].sn = dataArray;   
                            items[itemIdx].desc = dataArray.join('\n');
                            items[itemIdx].manualInputTime = new Date().toISOString();
                        }
                        
                        t.update(ref, { 
                            items: items, 
                            status: 'success' 
                        });
                    });

                    await sendMessage(chatId, `✅ <b>DATA TERSIMPAN!</b>\nSilakan cek Web user.`);
                    await sendSuccessNotification(chatId, orderId, "Data Manual Updated");
                    await db.collection('admin_context').doc(chatId.toString()).delete();
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};
