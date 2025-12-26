const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

module.exports = async function(req, res) {
    const update = req.body;

    try {
        // A. HANDLE TOMBOL (CALLBACK)
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;

            // 1. TOMBOL ACC (Manual Transfer)
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ <b>[MANUAL]</b> Memproses Order ${orderId}...`);
                
                // Gunakan Helper yg sama dengan Midtrans
                const result = await processOrderStock(orderId);

                if (result.success) {
                    await sendSuccessNotification(chatId, orderId, "MANUAL ACC");
                } else {
                    await sendMessage(chatId, `⚠️ <b>STOK KOSONG</b>\n${result.logs.join('\n')}`);
                    await showManualInputMenu(chatId, orderId, result.items);
                }
            }
            
            // 2. INPUT DATA MANUAL
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                // FORMAT JELAS UNTUK REGEX
                const prompt = `✍️ <b>INPUT DATA</b>\nReply pesan ini dengan data (bisa enter).\n\nRefID: ${orderId}\nIdx: ${itemIdx}`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }

            // 3. BALAS KOMPLAIN
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                // FORMAT JELAS UNTUK REGEX (BEDA BARIS)
                const prompt = `💬 <b>BALAS KOMPLAIN</b>\nReply pesan ini untuk user.\n\nRefID: ${orderId}\nMode: COMPLAINT_MODE`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }

            // 4. FORCE DONE
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendSuccessNotification(chatId, orderId, "FORCED");
            }

            return res.status(200).send('ok');
        }

        // B. HANDLE REPLY PESAN (TEXT)
        if (update.message && update.message.reply_to_message) {
            const textAdmin = update.message.text;
            const replyOrigin = update.message.reply_to_message.text || "";
            const chatId = update.message.chat.id;

            // --- REGEX PERBAIKAN (POIN 1) ---
            // Hanya ambil ID jika ada label "RefID:" persis
            const idMatch = replyOrigin.match(/RefID:\s*([A-Za-z0-9-]+)/);
            
            if (idMatch) {
                const orderId = idMatch[1]; // Ini pasti ID (misal TRX-123), bukan "COMPLAINT"

                // SKENARIO 1: INPUT DATA BARANG
                const idxMatch = replyOrigin.match(/Idx:\s*(\d+)/);
                if (idxMatch) {
                    const itemIdx = parseInt(idxMatch[1]);
                    const dataArray = textAdmin.split('\n').filter(x => x.trim());

                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if(!doc.exists) return;
                        const items = doc.data().items;
                        if(items[itemIdx]) {
                            items[itemIdx].data = dataArray;
                            items[itemIdx].sn = dataArray;
                            items[itemIdx].note = `Manual: ${new Date().toLocaleTimeString()}`;
                        }
                        // Cek status full
                        const allFilled = items.every(i => i.data && i.data.length > 0);
                        t.update(ref, { items: items, status: allFilled ? 'success' : 'processing' });
                        return allFilled;
                    }).then(async (allFilled) => {
                         await sendMessage(chatId, `✅ Data tersimpan.`);
                         if(allFilled) await sendSuccessNotification(chatId, orderId, "MANUAL FILLED");
                         else {
                             const snap = await db.collection('orders').doc(orderId).get();
                             await showManualInputMenu(chatId, orderId, snap.data().items);
                         }
                    });
                }

                // SKENARIO 2: BALAS KOMPLAIN
                // Cek label "Mode: COMPLAINT_MODE" agar tidak tertukar
                else if (replyOrigin.includes('Mode: COMPLAINT_MODE')) {
                    await db.collection('orders').doc(orderId).update({
                        complaintReply: textAdmin,
                        hasNewReply: true
                    });
                    await sendMessage(chatId, `✅ Balasan terkirim ke User (Order: ${orderId})`);
                }
            }
        }
    } catch (e) {
        console.error(e);
        if(req.body.message) sendMessage(req.body.message.chat.id, `ERROR: ${e.message}`);
    }
    return res.status(200).send('ok');
};
