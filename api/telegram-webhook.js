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

// --- FUNGSI HELPER BARU: MENU REVISI FLEKSIBEL ---
async function showFlexibleRevisionMenu(chatId, orderId, items) {
    let message = `🛠 <b>MENU REVISI MANUAL</b>\nOrder ID: <code>${orderId}</code>\n\nStatus: <b>SUKSES (Tampil di Web)</b>\nNamun item di bawah ini stoknya kosong. Silakan klik tombol untuk mengisi manual:\n`;
    
    const keyboard = [];
    let missingCount = 0;

    items.forEach((item, index) => {
        // Cek apakah item ini kosong?
        const isMissed = !item.data || item.data.length === 0;
        
        if (isMissed) {
            missingCount++;
            // Potong nama jika kepanjangan biar tombol rapi
            const itemName = item.name.length > 20 ? item.name.substring(0, 17) + '...' : item.name;
            
            // Tombol khusus untuk isi item ini
            keyboard.push([{ 
                text: `✏️ Isi: ${itemName} (Qty: ${item.qty})`, 
                callback_data: `FILL_${orderId}_${index}` // Format: FILL_OrderId_IndexItem
            }]);
        }
    });

    // Tombol Selesai
    keyboard.push([{ text: "✅ Selesai / Tutup Menu", callback_data: "DONE_MANUAL" }]);

    if (missingCount === 0) {
        await sendMessage(chatId, `✅ <b>SEMUA LENGKAP!</b>\nOrder <code>${orderId}</code> sudah terisi penuh semua.`);
    } else {
        await sendMessage(chatId, message, { reply_markup: { inline_keyboard: keyboard } });
    }
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
                        keyboard.push([{ text: `🛠 Proses ${doc.id}`, callback_data: `RESOLVE_${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "ADMIN_MENU" }]);
                    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
                }
                await deleteMessage(chatId, messageId);
            }

            // === C. LOGIKA RESOLVE BARU (AUTO SAVE & FLEXIBLE MENU) ===
            else if (data.startsWith('RESOLVE_')) {
                const orderId = data.replace('RESOLVE_', '');
                
                await sendMessage(chatId, "⏳ <i>Scanning gudang & Updating database...</i>");
                
                // 1. SCAN GUDANG & UPDATE DB LANGSUNG
                // Fungsi ini akan mengambil stok jika ada, dan membiarkan kosong jika tidak ada
                const result = await processOrderStock(orderId);

                // 2. FORCE STATUS SUCCESS (Sesuai Request Anda)
                // Agar data langsung tampil di Web User (walaupun sebagian kosong)
                await db.collection('orders').doc(orderId).update({ status: 'success' });

                // 3. Hapus pesan loading/tombol lama
                await deleteMessage(chatId, messageId);

                // 4. TAMPILKAN MENU REVISI (Pilih sendiri mau isi yang mana)
                // Kita ambil data terbaru items dari result processOrderStock
                await showFlexibleRevisionMenu(chatId, orderId, result.items);
            }

            // === D. LOGIKA ACC (AUTO PROCESS + FORCE SUCCESS) ===
            else if (data.startsWith('ACC_')) {
                const orderId = data.replace('ACC_', ''); 
                await deleteMessage(chatId, messageId); 
                
                // Proses stok
                const result = await processOrderStock(orderId);
                
                // Apapun hasilnya, set Success agar user senang & tampil di web
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendSuccessNotification(chatId, orderId, "ACC ADMIN");

                // Jika ada yang kosong, munculkan menu revisi fleksibel
                if (!result.success) {
                    await showFlexibleRevisionMenu(chatId, orderId, result.items);
                }
            }
            
            // === E. TOMBOL FILL (KLIK DARI MENU REVISI) ===
            else if (data.startsWith('FILL_')) {
                // Format data: FILL_ORDERID_INDEX
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parseInt(parts[2]);
                
                // Ambil info item untuk judul pesan
                const orderDoc = await db.collection('orders').doc(orderId).get();
                if (!orderDoc.exists) return;
                const item = orderDoc.data().items[itemIdx];

                await sendMessage(chatId, 
                    `📝 <b>INPUT DATA MANUAL</b>\n` +
                    `📦 Produk: <b>${item.name}</b>\n` +
                    `🏷 Variasi: ${item.variation_name || item.variant || '-'}\n` +
                    `🔢 Butuh: <b>${item.qty} baris</b>\n\n` +
                    `<i>Silakan kirim data akun/voucher sekarang:</i>`, 
                    { reply_markup: { force_reply: true } }
                );

                // Simpan Context
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_MANUAL_INPUT', 
                    orderId: orderId, 
                    itemIdx: itemIdx
                });
            }

            // === F. TOMBOL LAINNYA ===
            else if (data === 'DONE_MANUAL') {
                await deleteMessage(chatId, messageId);
                await sendMessage(chatId, "✅ Menu Revisi Ditutup.");
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

                // INPUT MANUAL (DARI MENU REVISI)
                if (context.action === 'WAITING_MANUAL_INPUT') {
                    const { orderId, itemIdx } = context;
                    const dataArray = text.split('\n').map(x => x.trim()).filter(x => x);
                    
                    // 1. Simpan Data ke DB
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
                        // Status tetap success (karena sudah diset diawal)
                        t.update(ref, { items: items });
                    });

                    // 2. Hapus Context (Selesai input satu item)
                    await db.collection('admin_context').doc(chatId.toString()).delete();

                    // 3. TAMPILKAN LAGI MENU REVISI (Untuk item lain yg msh kosong)
                    const updatedDoc = await db.collection('orders').doc(orderId).get();
                    const updatedItems = updatedDoc.data().items;
                    
                    await sendMessage(chatId, `✅ Data tersimpan untuk item ke-${itemIdx+1}.`);
                    
                    // Panggil fungsi menu fleksibel lagi (Looping Menu)
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
