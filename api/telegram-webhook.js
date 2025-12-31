const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { showAdminDashboard, handleDailyReport, handleLowStockCheck } = require('./adminCommands');
const { sendRealtimeDashboard } = require('./adminRealtime');
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

// --- FUNGSI MENU REVISI (TAMPILKAN SEMUA, BAIK ISI MAUPUN KOSONG) ---
async function showFlexibleRevisionMenu(chatId, orderId, items) {
    let message = `🛠 <b>MENU EDIT / REVISI DATA</b>\nOrder ID: <code>${orderId}</code>\n\n` +
                  `Silakan klik item di bawah ini untuk melihat atau mengubah isinya.\n` +
                  `<i>(Berguna jika ada data salah kirim atau ingin revisi sebagian)</i>\n`;
    
    const keyboard = [];

    // Loop semua item (Tanpa Filter, Semua Ditampilkan)
    items.forEach((item, index) => {
        // Cek status isi
        const isFilled = item.data && item.data.length > 0;
        
        // Ikon Status
        const icon = isFilled ? "✅" : "❌";
        const statusText = isFilled ? "Terisi" : "KOSONG";
        
        // Nama Item (dipotong biar rapi)
        let itemName = item.name.length > 15 ? item.name.substring(0, 15) + '...' : item.name;
        const variantInfo = item.variation_name ? `(${item.variation_name})` : '';
        
        // Label Tombol
        const buttonLabel = `✏️ ${icon} ${itemName} ${variantInfo}`;
        
        keyboard.push([{ 
            text: buttonLabel, 
            callback_data: `FILL_${orderId}_${index}` 
        }]);
    });

    // Tombol Tutup
    keyboard.push([{ text: "✅ Selesai / Tutup Menu", callback_data: "DONE_MANUAL" }]);

    await sendMessage(chatId, message, { reply_markup: { inline_keyboard: keyboard } });
}

module.exports = async function(req, res) {
    const update = req.body;

    try {
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            console.log(`[DEBUG] Tombol: ${data}`); 

            // === A. NAVIGATION ===
            if (data === 'ADMIN_MENU') await sendRealtimeDashboard(chatId, "🎛 <b>DASHBOARD UTAMA</b>");
            else if (data === 'ADMIN_REPORT') await handleDailyReport(chatId);
            else if (data === 'ADMIN_STOCK') await handleLowStockCheck(chatId);

            // === B. CEK ORDER PENDING ===
            else if (data === 'CHECK_PENDING') {
                const snapshot = await db.collection('orders')
                    .where('status', '==', 'manual_verification')
                    .get();

                if (snapshot.empty) {
                    await sendMessage(chatId, "✅ <b>Aman!</b> Tidak ada orderan pending.");
                } else {
                    let text = `⚠️ <b>${snapshot.size} ORDER PENDING:</b>\n`;
                    const keyboard = [];
                    snapshot.forEach(doc => {
                        const d = doc.data();
                        text += `🆔 <code>${doc.id}</code> (${d.items.length} Item)\n`;
                        keyboard.push([{ text: `🛠 Proses ${doc.id}`, callback_data: `ACC_${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "ADMIN_MENU" }]);
                    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
                }
                await deleteMessage(chatId, messageId);
            }

            // === C. LOGIKA ACC / RESOLVE (HAJAR DULU BARU REVISI) ===
            else if (data.startsWith('ACC_') || data.startsWith('RESOLVE_')) {
                const orderId = data.replace('ACC_', '').replace('RESOLVE_', '');
                
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, "⏳ <i>Memproses stok & update database...</i>");

                // 1. PROSES STOCK
                const result = await processOrderStock(orderId);

                // 2. PAKSA STATUS SUKSES
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendSuccessNotification(chatId, orderId, "PROCESSED");

                // 3. TAMPILKAN MENU REVISI (TAMPIL SEMUA ITEM)
                await showFlexibleRevisionMenu(chatId, orderId, result.items);
            }
            
            // === D. LOGIKA INPUT ITEM / EDIT (FILL) ===
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parseInt(parts[2]);
                
                const orderDoc = await db.collection('orders').doc(orderId).get();
                if (!orderDoc.exists) return;
                
                const item = orderDoc.data().items[itemIdx];
                const variantInfo = item.variation_name || item.variant || '-';
                
                // LOGIKA BARU: TAMPILKAN DATA LAMA JIKA ADA
                let extraMsg = "";
                if (item.data && item.data.length > 0) {
                    const dataLama = item.data.join('\n');
                    extraMsg = `📂 <b>DATA SAAT INI (Klik untuk Copy):</b>\n` +
                               `<code>${dataLama}</code>\n\n` +
                               `👆 <i>Copy teks di atas, edit bagian yang salah (misal no 7), lalu kirimkan versi lengkapnya ke sini.</i>\n\n`;
                }

                await sendMessage(chatId, 
                    `📝 <b>EDIT / INPUT DATA MANUAL</b>\n` +
                    `📦 Produk: <b>${item.name}</b>\n` +
                    `🏷 Variasi: ${variantInfo}\n` +
                    `🔢 Butuh Qty: <b>${item.qty}</b>\n\n` +
                    extraMsg +
                    `👇 <i>Silakan kirim data baru (akan menimpa data lama):</i>`, 
                    { reply_markup: { force_reply: true } }
                );

                // Simpan Context
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_MANUAL_INPUT', 
                    orderId: orderId, 
                    itemIdx: itemIdx
                });
            }

            // === E. TOMBOL LAINNYA ===
            else if (data === 'DONE_MANUAL') {
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, "✅ Menu Edit Ditutup.");
            }
            else if (data.startsWith('REJECT_')) {
                const orderId = data.replace('REJECT_', '');
                await db.collection('orders').doc(orderId).update({ status: 'failed' });
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, `❌ Order DITOLAK.`);
            }
            else if (data.startsWith('REPLY_CS_')) {
                const ticketId = data.replace('REPLY_CS_', '');
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_COMPLAINT_REPLY', ticketId
                });
                await sendMessage(chatId, `💬 Balas Tiket ${ticketId}:`, { reply_markup: { force_reply: true } });
            }
        } 

        // --- 2. LOGIKA TEXT INPUT (INPUT DATA) ---
        else if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            
            const contextSnap = await db.collection('admin_context').doc(chatId.toString()).get();
            
            if (contextSnap.exists) {
                const context = contextSnap.data();

                // INPUT MANUAL / EDIT (DARI MENU REVISI)
                if (context.action === 'WAITING_MANUAL_INPUT') {
                    const { orderId, itemIdx } = context;
                    const dataArray = text.split('\n').map(x => x.trim()).filter(x => x);
                    
                    // 1. Simpan Data ke DB (MENIMPA DATA LAMA)
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
                        
                        t.update(ref, { items: items });
                    });

                    // 2. Hapus Context
                    await db.collection('admin_context').doc(chatId.toString()).delete();

                    // 3. AUTO-REFRESH MENU REVISI
                    const updatedDoc = await db.collection('orders').doc(orderId).get();
                    const updatedItems = updatedDoc.data().items;
                    
                    await sendMessage(chatId, `✅ Item #${itemIdx+1} Berhasil Diupdate!`);
                    
                    // Tampilkan lagi menu (Tombol ✅ tetap muncul agar bisa diedit lagi kalau mau)
                    await showFlexibleRevisionMenu(chatId, orderId, updatedItems);
                }

                // BALAS KOMPLAIN
                else if (context.action === 'WAITING_COMPLAINT_REPLY') {
                    const { ticketId } = context;
                    await db.collection('orders').doc(ticketId).update({
                        complaintReply: text,
                        complaintStatus: 'replied',
                        complaintReplyTime: new Date().toISOString(),
                        hasNewReply: true
                    });
                    await sendMessage(chatId, `✅ Balasan terkirim.`);
                    await db.collection('admin_context').doc(chatId.toString()).delete();
                }
            } else {
                if (['/admin', '/menu', '/start'].includes(text)) await sendRealtimeDashboard(chatId, "🎛 <b>DASHBOARD</b>");
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};
