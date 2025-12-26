const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama (LOGIKA SUDAH DIPERBARUI DI ATAS)
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
// Import Fitur Admin Dashboard
const { showAdminDashboard, handleDailyReport, handleLowStockCheck } = require('./adminCommands');

module.exports = async function(req, res) {
    const update = req.body;

    try {
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;

            // --- 1. FITUR ADMIN DASHBOARD ---
            if (data === 'ADMIN_MENU') await showAdminDashboard(chatId);
            else if (data === 'ADMIN_REPORT') await handleDailyReport(chatId);
            else if (data === 'ADMIN_STOCK') await handleLowStockCheck(chatId);

            // --- 2. FITUR TRANSAKSI ---
            
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
            
            // FITUR BARU: TOMBOL REVISI (MUNCULKAN MENU EDIT)
            else if (data.startsWith('REVISI_')) {
                const orderId = data.replace('REVISI_', '');
                // Ambil data terbaru dari DB untuk ditampilkan di menu edit
                const snap = await db.collection('orders').doc(orderId).get();
                if (snap.exists) {
                    await showManualInputMenu(chatId, orderId, snap.data().items);
                }
            }

            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                const prompt = `✍️ <b>INPUT/UPDATE DATA</b>\n\nSilakan Reply pesan ini dengan data baru.\nData lama akan tertimpa.\n\nRefID: ${orderId}\nIdx: ${itemIdx}`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }
            
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.replace('REPLY_COMPLAINT_', ''); 
                const prompt = `💬 <b>BALAS KOMPLAIN</b>\n\nSilakan tulis balasan Anda untuk user.\n\nRefID: ${orderId}\nMode: COMPLAINT_MODE`;
                await sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
            }
            
            else if (data.startsWith('DONE_')) {
                const orderId = data.replace('DONE_', '');
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendSuccessNotification(chatId, orderId, "UPDATE DONE");
            }

            return res.status(200).send('ok');
        }

        // ==========================================
        // B. HANDLE REPLY PESAN & COMMAND (TEXT)
        // ==========================================
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

                    // SKENARIO 1: INPUT/UPDATE DATA BARANG
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
                                items[itemIdx].data = dataArray; // INI AKAN MENIMPA DATA LAMA (UPDATE)
                                items[itemIdx].sn = dataArray;
                                items[itemIdx].note = `Updated: ${new Date().toLocaleTimeString()}`;
                            }
                            const allFilled = items.every(i => i.data && i.data.length > 0);
                            t.update(ref, { items: items, status: allFilled ? 'success' : 'processing' });
                            return allFilled;
                        }).then(async (allFilled) => {
                             await sendMessage(chatId, `✅ Data berhasil diperbarui.`);
                             // Tampilkan notifikasi sukses lagi (opsional, biar admin bisa cek link WA lagi)
                             if(allFilled) await sendSuccessNotification(chatId, orderId, "DATA UPDATED"); 
                             else {
                                 const snap = await db.collection('orders').doc(orderId).get();
                                 await showManualInputMenu(chatId, orderId, snap.data().items);
                             }
                        });
                    }
                    
                    // SKENARIO 2: BALAS KOMPLAIN
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
