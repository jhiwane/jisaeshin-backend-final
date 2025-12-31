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

// --- FUNGSI BARU: LOGIKA CEK PENDING (DIPISAH SUPAYA BISA DIPANGGIL LEWAT TEKS) ---
async function handleCheckPending(chatId) {
    const snapshot = await db.collection('orders')
        .where('status', 'in', ['pending', 'manual_verification', 'manual_pending', 'process'])
        .get();

    if (snapshot.empty) {
        await sendMessage(chatId, "✅ <b>Aman!</b> Tidak ada orderan gantung.");
    } else {
        let text = `⭕ <b>DAFTAR PENDING (${snapshot.size}):</b>\n\n`;
        const keyboard = [];

        snapshot.forEach(doc => {
            const d = doc.data();
            const itemsCount = d.items ? d.items.length : 0;
            
            // Label status biar admin tau kenapa pending
            let statusLabel = '⚠️ CEK STOK/ERROR';
            if (d.status === 'manual_pending') statusLabel = '💸 BELUM ACC TRANSFER';
            if (d.status === 'pending') statusLabel = '⏳ MENUNGGU BAYAR';
            
            text += `🆔 <code>${doc.id}</code>\nStatus: ${statusLabel}\nItems: ${itemsCount} pcs\n\n`;
            
            // Tombol Dinamis
            if (d.status === 'manual_pending') {
                keyboard.push([{ text: `💸 ACC Transfer ${doc.id}`, callback_data: `ACC_${doc.id}` }]);
            } else {
                keyboard.push([{ text: `🛠 Proses Stok ${doc.id}`, callback_data: `ACC_${doc.id}` }]);
            }
        });
        
        keyboard.push([{ text: "🔙 Tutup", callback_data: "DONE_MANUAL" }]);
        await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    }
}

// --- FUNGSI MENU REVISI (TAMPILKAN SEMUA, BAIK ISI MAUPUN KOSONG) ---
async function showFlexibleRevisionMenu(chatId, orderId, items) {
    let message = `🛠 <b>MENU EDIT / REVISI DATA</b>\nOrder ID: <code>${orderId}</code>\n\n` +
                  `Silakan klik item di bawah ini untuk melihat atau mengubah isinya.\n` +
                  `<i>(Berguna jika ada komplain produk cacat atau salah kirim)</i>\n`;
    
    const keyboard = [];

    items.forEach((item, index) => {
        const isFilled = item.data && item.data.length > 0;
        const icon = isFilled ? "✅" : "❌";
        let itemName = item.name.length > 15 ? item.name.substring(0, 15) + '...' : item.name;
        const variantInfo = item.variation_name ? `(${item.variation_name})` : '';
        const buttonLabel = `✏️ ${icon} ${itemName} ${variantInfo}`;
        
        keyboard.push([{ 
            text: buttonLabel, 
            callback_data: `FILL_${orderId}_${index}` 
        }]);
    });

    keyboard.push([{ text: "✅ Selesai / Tutup Menu", callback_data: "DONE_MANUAL" }]);
    await sendMessage(chatId, message, { reply_markup: { inline_keyboard: keyboard } });
}

// --- FUNGSI BARU: TRACKING ORDER ---
async function trackOrder(chatId, orderId) {
    const doc = await db.collection('orders').doc(orderId).get();
    
    if (!doc.exists) {
        return sendMessage(chatId, `❌ <b>TIDAK DITEMUKAN</b>\nOrder ID <code>${orderId}</code> tidak ada di database.`);
    }

    const d = doc.data();
    const statusIcon = d.status === 'success' ? '✅' : d.status === 'pending' ? '⏳' : d.status === 'failed' ? '❌' : '⚠️';
    const total = parseInt(d.total || 0).toLocaleString();
    const contact = d.buyerContact || "Guest";
    
    let itemsList = "";
    (d.items || []).forEach((i, idx) => {
        const statusItem = (i.data && i.data.length > 0) ? "✅" : "❌";
        itemsList += `${idx+1}. ${statusItem} <b>${i.name}</b> (${i.qty})\n`;
    });

    const msg = `🔍 <b>HASIL TRACKING</b>\n\n` +
                `🆔 ID: <code>${doc.id}</code>\n` +
                `📊 Status: <b>${statusIcon} ${d.status.toUpperCase()}</b>\n` +
                `💰 Total: Rp ${total}\n` +
                `👤 Kontak: ${contact}\n\n` +
                `📦 <b>Rincian Item:</b>\n${itemsList}\n` +
                `👇 <i>Klik tombol di bawah untuk Edit/Lihat Data Produk:</i>`;

    await sendMessage(chatId, msg, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🛠 Edit / Revisi Data (Komplain)", callback_data: `REVISI_${doc.id}` }],
                [{ text: "🔙 Tutup", callback_data: "DONE_MANUAL" }]
            ]
        }
    });
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

            if (data === 'ADMIN_MENU') await sendRealtimeDashboard(chatId, "🎛 <b>DASHBOARD UTAMA</b>");
            else if (data === 'ADMIN_REPORT') await handleDailyReport(chatId);
            else if (data === 'ADMIN_STOCK') await handleLowStockCheck(chatId);

            // === B. CEK ORDER PENDING (ALL IN ONE) ===
            else if (data === 'CHECK_PENDING') {
                await deleteMessage(chatId, messageId);
                await handleCheckPending(chatId); // Panggil fungsi yang baru dibuat
            }

            // === C. LOGIKA ACC / RESOLVE ===
            else if (data.startsWith('ACC_') || data.startsWith('RESOLVE_')) {
                const orderId = data.replace('ACC_', '').replace('RESOLVE_', '');
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, "⏳ <i>Memproses stok...</i>");

                const result = await processOrderStock(orderId);
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendSuccessNotification(chatId, orderId, "PROCESSED");
                await showFlexibleRevisionMenu(chatId, orderId, result.items);
            }

            // === D. LOGIKA REVISI (DARI TOMBOL TRACKING) ===
            else if (data.startsWith('REVISI_')) {
                const orderId = data.replace('REVISI_', '');
                const doc = await db.collection('orders').doc(orderId).get();
                if (doc.exists) {
                    await showFlexibleRevisionMenu(chatId, orderId, doc.data().items);
                }
            }
            
            // === E. LOGIKA INPUT / EDIT ITEM (FILL) ===
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parseInt(parts[2]);
                
                const orderDoc = await db.collection('orders').doc(orderId).get();
                if (!orderDoc.exists) return;
                
                const item = orderDoc.data().items[itemIdx];
                const variantInfo = item.variation_name || item.variant || '-';
                
                let extraMsg = "";
                if (item.data && item.data.length > 0) {
                    const dataLama = item.data.join('\n');
                    extraMsg = `📂 <b>DATA SAAT INI (Klik untuk Copy):</b>\n` +
                               `<code>${dataLama}</code>\n\n` +
                               `👆 <i>Copy teks di atas, edit yang salah, lalu kirim versi barunya.</i>\n\n`;
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

                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_MANUAL_INPUT', 
                    orderId: orderId, 
                    itemIdx: itemIdx
                });
            }

            // === F. TOMBOL LAINNYA ===
            else if (data === 'DONE_MANUAL') {
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, "✅ Menu Ditutup.");
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

        // --- 2. LOGIKA PESAN TEKS (COMMAND & TRACKING) ---
        else if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            const lowerText = text.toLowerCase();
            
            const contextSnap = await db.collection('admin_context').doc(chatId.toString()).get();
            
            if (contextSnap.exists) {
                const context = contextSnap.data();

                // INPUT MANUAL / EDIT
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
                        t.update(ref, { items: items });
                    });

                    await db.collection('admin_context').doc(chatId.toString()).delete();
                    
                    const updatedDoc = await db.collection('orders').doc(orderId).get();
                    await sendMessage(chatId, `✅ Item #${itemIdx+1} Berhasil Diupdate!`);
                    await showFlexibleRevisionMenu(chatId, orderId, updatedDoc.data().items);
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
            } 
            
            // JIKA TIDAK ADA CONTEXT
            else {
                // 1. CEK COMMAND PENDING (INI YANG BARU)
                if (['pending', '/pending', 'cek pending'].includes(lowerText)) {
                    await handleCheckPending(chatId);
                }
                
                // 2. CEK COMMAND ADMIN LAIN
                else if (['/admin', '/menu', '/start', 'menu', 'dashboard'].includes(lowerText)) {
                    await sendRealtimeDashboard(chatId, "🎛 <b>DASHBOARD UTAMA</b>");
                }
                
                // 3. TRACKING ORDER (JIKA BUKAN COMMAND)
                else if (!text.startsWith('/')) {
                    await trackOrder(chatId, text);
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};
