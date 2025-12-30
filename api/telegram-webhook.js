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
        // --- 1. LOGIKA TOMBOL (CALLBACK QUERY) ---
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            console.log(`[DEBUG] Tombol diklik: ${data}`); 

            // === A. NAVIGATION & DASHBOARD ===
            if (data === 'ADMIN_MENU') await showAdminDashboard(chatId);
            else if (data === 'ADMIN_REPORT') await handleDailyReport(chatId);
            else if (data === 'ADMIN_STOCK') await handleLowStockCheck(chatId);

            // === B. CEK ORDER PENDING (MACET) ===
            else if (data === 'CHECK_PENDING') {
                const snapshot = await db.collection('orders')
                    .where('status', '==', 'manual_verification')
                    .get();

                if (snapshot.empty) {
                    await sendMessage(chatId, "✅ <b>Aman!</b> Tidak ada orderan gantung (pending).");
                } else {
                    let text = `⚠️ <b>DITEMUKAN ${snapshot.size} ORDER GANTUNG:</b>\n\n`;
                    const keyboard = [];

                    snapshot.forEach(doc => {
                        const d = doc.data();
                        const itemsCount = d.items ? d.items.length : 0;
                        text += `🆔 <code>${doc.id}</code> (${itemsCount} Item)\n`;
                        // Tombol untuk memproses satu per satu
                        keyboard.push([{ text: `🛠 Proses Order ${doc.id}`, callback_data: `RESOLVE_${doc.id}` }]);
                    });
                    
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "ADMIN_MENU" }]);
                    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
                }
                await deleteMessage(chatId, messageId);
            }

            // === C. SMART RESOLVE (AUTO CEK STOK DULU) ===
            else if (data.startsWith('RESOLVE_')) {
                const orderId = data.replace('RESOLVE_', '');
                
                // 1. BERI TAHU ADMIN SEDANG CEK GUDANG
                await sendMessage(chatId, "⏳ <i>Sedang mengecek stok di gudang...</i>");

                // 2. COBA PROSES ULANG STOK (Agar kalau ada stok, langsung keambil)
                await processOrderStock(orderId);

                // 3. AMBIL DATA TERBARU (Setelah update stok di atas)
                const orderDoc = await db.collection('orders').doc(orderId).get();
                
                if (!orderDoc.exists) {
                    await sendMessage(chatId, "❌ Order tidak ditemukan.");
                } else {
                    const orderData = orderDoc.data();
                    const items = orderData.items || [];
                    
                    // 4. CARI ITEM YANG MASIH KOSONG SETELAH SCAN
                    let missingItemIndex = -1;
                    for (let i = 0; i < items.length; i++) {
                        if (!items[i].data || items[i].data.length === 0) {
                            missingItemIndex = i;
                            break;
                        }
                    }

                    if (missingItemIndex !== -1) {
                        // JIKA MASIH KOSONG -> MINTA INPUT MANUAL
                        const item = items[missingItemIndex];
                        const productName = item.name || "Produk Tanpa Nama";
                        const variantName = item.variation_name || item.variant || "-";
                        const qtyNeeded = item.qty || 1;

                        await sendMessage(chatId, 
                            `⚠️ <b>STOK MASIH KOSONG</b>\n` +
                            `Order ID: <code>${orderId}</code>\n\n` +
                            `📦 <b>Produk:</b> ${productName}\n` +
                            `🏷 <b>Variasi:</b> ${variantName}\n` +
                            `🔢 <b>Jumlah (Qty):</b> ${qtyNeeded} pcs\n\n` +
                            `👇 <i>Silakan kirim ${qtyNeeded} baris data manual sekarang:</i>`, 
                            { reply_markup: { force_reply: true } }
                        );

                        await db.collection('admin_context').doc(chatId.toString()).set({
                            action: 'RESOLVING_PENDING_ORDER',
                            orderId: orderId,
                            itemIdx: missingItemIndex
                        });
                    } else {
                        // JIKA TERNYATA SUDAH TERISI (Auto-Refill Berhasil)
                        await db.collection('orders').doc(orderId).update({ status: 'success' });
                        await sendSuccessNotification(chatId, orderId, "AUTO-RESOLVED");
                        await sendMessage(chatId, "✅ <b>BERES!</b> Stok ditemukan di gudang & otomatis terkirim.");
                        await deleteMessage(chatId, messageId);
                    }
                }
            }

            // === D. LOGIKA ACC (AUTO PROCESS + PARSIAL) ===
            else if (data.startsWith('ACC_')) {
                const orderId = data.replace('ACC_', ''); 
                await deleteMessage(chatId, messageId); 
                
                // 1. Jalankan proses stok otomatis (Potong yang ada dulu)
                const result = await processOrderStock(orderId);

                // Jika sukses SEMUA
                if (result.success) {
                    await sendSuccessNotification(chatId, orderId, "ACC ADMIN");
                } 
                // Jika GAGAL atau HANYA SEBAGIAN
                else {
                    // Update status jadi manual_verification (Pending)
                    await db.collection('orders').doc(orderId).update({ status: 'manual_verification' });
                    
                    // Hitung berapa item yang berhasil terisi
                    const filledCount = result.items.filter(i => i.data && i.data.length > 0).length;
                    const totalCount = result.items.length;

                    await sendMessage(chatId, 
                        `⚠️ <b>PROSES PARSIAL</b>\nOrder: <code>${orderId}</code>\n\n` +
                        `✅ Terkirim Otomatis: <b>${filledCount} Item</b>\n` +
                        `❌ Stok Kosong: <b>${totalCount - filledCount} Item</b>\n\n` +
                        `Item yang ada stoknya sudah masuk ke data user. Silakan input manual sisanya.`, 
                        {
                            reply_markup: { inline_keyboard: [[{ text: "🛠 Cek Sisa Item", callback_data: `RESOLVE_${orderId}` }]] }
                        }
                    );
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

            // === E. BALAS KOMPLAIN (REPLY_CS) ===
            else if (data.startsWith('REPLY_CS_')) {
                const ticketId = data.replace('REPLY_CS_', '');
                await db.collection('admin_context').doc(chatId.toString()).set({
                    action: 'WAITING_COMPLAINT_REPLY',
                    ticketId: ticketId
                });
                await sendMessage(chatId, `💬 <b>MODE BALAS KOMPLAIN</b>\n\nAnda sedang membalas Tiket ID: <code>${ticketId}</code>\n👇 <i>Ketik pesan balasan Anda:</i>`, {
                    reply_markup: { force_reply: true }
                });
            }

            else {
                console.log("Data tombol tidak dikenal:", data);
            }
        } 

        // --- 2. LOGIKA PESAN TEKS (COMMAND & INPUT) ---
        else if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            
            const contextSnap = await db.collection('admin_context').doc(chatId.toString()).get();
            
            if (contextSnap.exists) {
                const context = contextSnap.data();

                // 1. INPUT DATA NORMAL (VIA TOMBOL FILL)
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

                // 2. INPUT DATA PENDING (VIA TOMBOL RESOLVE) - FITUR BARU
                else if (context.action === 'RESOLVING_PENDING_ORDER') {
                    const { orderId, itemIdx } = context;
                    const dataArray = text.split('\n').map(x => x.trim()).filter(x => x);

                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if(!doc.exists) return;
                        
                        const items = doc.data().items;
                        // Update item saat ini
                        if(items[itemIdx]) {
                            items[itemIdx].data = dataArray;
                            items[itemIdx].sn = dataArray;
                            items[itemIdx].desc = dataArray.join('\n');
                        }
                        // Cek apakah masih ada item lain yang kosong?
                        let nextMissingIndex = -1;
                        for (let i = 0; i < items.length; i++) {
                            if (i == itemIdx) continue; // Skip item ini
                            if (!items[i].data || items[i].data.length === 0) {
                                nextMissingIndex = i;
                                break;
                            }
                        }

                        if (nextMissingIndex === -1) {
                            // SEMUA LENGKAP -> SUCCESS
                            t.update(ref, { items: items, status: 'success' });
                        } else {
                            // MASIH ADA YG KOSONG -> TETAP SIMPAN, STATUS TETAP
                            t.update(ref, { items: items });
                        }
                    });

                    // Hapus Context
                    await db.collection('admin_context').doc(chatId.toString()).delete();

                    // Cek Ulang Status untuk memberi respon selanjutnya
                    setTimeout(async () => {
                        const checkDoc = await db.collection('orders').doc(orderId).get();
                        if (checkDoc.data().status === 'success') {
                            await sendMessage(chatId, "✅ <b>ORDER SELESAI!</b> Notifikasi dikirim ke user.");
                            await sendSuccessNotification(chatId, orderId, "RESOLVED");
                        } else {
                            // Panggil tombol RESOLVE lagi untuk item berikutnya
                            await sendMessage(chatId, "✅ Item tersimpan. Masih ada item lain yang kosong.", {
                                reply_markup: { inline_keyboard: [[{ text: "➡️ Lanjut Item Berikutnya", callback_data: `RESOLVE_${orderId}` }]] }
                            });
                        }
                    }, 1000);
                }

                // 3. BALAS KOMPLAIN (REPLY_CS)
                else if (context.action === 'WAITING_COMPLAINT_REPLY') {
                    const { ticketId } = context;
                    try {
                        const orderRef = db.collection('orders').doc(ticketId);
                        const orderSnap = await orderRef.get();

                        if (!orderSnap.exists) {
                            await sendMessage(chatId, `❌ Error: Order ${ticketId} tidak ditemukan.`);
                        } else {
                            await orderRef.update({
                                complaintReply: text,
                                complaintStatus: 'replied',
                                complaintReplyTime: new Date().toISOString(),
                                hasNewReply: true
                            });
                            await sendMessage(chatId, `✅ <b>Balasan Terkirim!</b>\nOrder: <code>${ticketId}</code>`);
                        }
                        await db.collection('admin_context').doc(chatId.toString()).delete();
                    } catch (err) {
                        console.error(err);
                        await sendMessage(chatId, `❌ Gagal: ${err.message}`);
                    }
                }
            } 
            
            // JIKA TIDAK ADA CONTEXT (Command Handler)
            else {
                // Trigger Menu Admin dengan mengetik /admin, /start, atau /menu
                if (['/admin', '/start', '/menu'].includes(text.toLowerCase())) {
                    await showAdminDashboard(chatId);
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};
