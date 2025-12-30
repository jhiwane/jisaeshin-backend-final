const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { showAdminDashboard } = require('./adminCommands'); // Pastikan import ini benar
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
        // --- LOGIKA TOMBOL (CALLBACK QUERY) ---
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            console.log(`[DEBUG] Tombol diklik: ${data}`); // Cek log ini di server console kamu

            if (data === 'ADMIN_MENU') await showAdminDashboard(chatId);
            
            // ... (Kode ACC, REJECT, REVISI, FILL, DONE tetap sama seperti sebelumnya) ...
            else if (data.startsWith('ACC_')) {
                const orderId = data.replace('ACC_', ''); 
                await deleteMessage(chatId, messageId); 
                const result = await processOrderStock(orderId);
                await sendSuccessNotification(chatId, orderId, "ACC ADMIN");
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
                await sendMessage(chatId, `📝 <b>INPUT DATA</b>\nSilakan kirim data item ke-${parseInt(itemIdx)+1}.`, { reply_markup: { force_reply: true } });
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_MANUAL_INPUT', orderId, itemIdx
                });
            }
            else if (data.startsWith('DONE_')) {
                const orderId = data.replace('DONE_', '');
                await sendSuccessNotification(chatId, orderId, "MANUAL ADMIN");
                await deleteMessage(chatId, messageId);
            }

            // ============================================================
            // PERBAIKAN UTAMA: LOGIKA TOMBOL BALAS KOMPLAIN
            // Pastikan tombol di notifikasi kamu mengirim data: "REPLY_CS_IDTIKETNYA"
            // ============================================================
            else if (data.startsWith('REPLY_CS_')) {
                const ticketId = data.replace('REPLY_CS_', '');
                
                // 1. Simpan status bahwa admin sedang mau membalas
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_COMPLAINT_REPLY',
                    ticketId: ticketId
                });

                // 2. Beri respon ke Admin agar bot tidak terlihat "bengong"
                await sendMessage(chatId, `💬 <b>MODE BALAS KOMPLAIN</b>\n\nAnda sedang membalas Tiket ID: <code>${ticketId}</code>\n\n👇 <i>Silakan ketik pesan balasan Anda sekarang:</i>`, {
                    reply_markup: { force_reply: true } // Memaksa keyboard user reply
                });
            }
            // Jika data tombol tidak dikenali sama sekali
            else {
                console.log("Data tombol tidak dikenal:", data);
            }
        } 

        // --- LOGIKA BALASAN TEKS (ADMIN MENGETIK) ---
        else if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            
            // Cek Context (Apakah admin sedang mengetik input manual ATAU balasan komplain?)
            const contextSnap = await db.collection('admin_context').doc(chatId.toString()).get();
            
            if (contextSnap.exists) {
                const context = contextSnap.data();

                // KASUS 1: INPUT DATA VOUCHER/AKUN
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
                        t.update(ref, { items: items, status: 'success' });
                    });

                    await sendMessage(chatId, `✅ <b>DATA TERSIMPAN!</b>`);
                    await sendSuccessNotification(chatId, orderId, "Data Manual Updated");
                    await db.collection('admin_context').doc(chatId.toString()).delete();
                }

                // ============================================================
                // KASUS 2: ADMIN MENGIRIM BALASAN KOMPLAIN (CS)
                // ============================================================
                else if (context.action === 'WAITING_COMPLAINT_REPLY') {
                    const { ticketId } = context; // Ini sebenarnya adalah orderId

                    try {
                        // 1. Cek dulu apakah Order ada
                        const orderRef = db.collection('orders').doc(ticketId);
                        const orderSnap = await orderRef.get();

                        if (!orderSnap.exists) {
                            await sendMessage(chatId, `❌ <b>ERROR:</b> Data Order ID <code>${ticketId}</code> tidak ditemukan di database.`);
                            await db.collection('admin_context').doc(chatId.toString()).delete();
                            return;
                        }

                        // 2. Update Data di Collection 'orders'
                        // Kita simpan balasan di field 'complaintReply' agar muncul di Web
                        await orderRef.update({
                            complaintReply: text,           // Isi balasan admin
                            complaintStatus: 'replied',     // Status komplain selesai/dibalas
                            complaintReplyTime: new Date().toISOString(),
                            hasNewReply: true               // Flag untuk frontend (opsional)
                        });

                        // 3. Konfirmasi Sukses ke Admin
                        await sendMessage(chatId, `✅ <b>Balasan Terkirim!</b>\n\nUntuk Order ID: <code>${ticketId}</code>\nIsi: "${text}"\n\n<i>Silakan cek di Website/Aplikasi User.</i>`);
                        
                        // 4. Hapus Context (Reset status admin)
                        await db.collection('admin_context').doc(chatId.toString()).delete();

                    } catch (err) {
                        console.error("Error Reply Complaint:", err);
                        await sendMessage(chatId, `❌ <b>GAGAL MENYIMPAN:</b>\n${err.message}`);
                    }
                

                    // C. Konfirmasi ke Admin & Hapus Context
                    await sendMessage(chatId, `✅ <b>Balasan Terkirim ke User!</b>\nTiket <code>${ticketId}</code> telah ditutup.`);
                    await db.collection('admin_context').doc(chatId.toString()).delete();
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};
