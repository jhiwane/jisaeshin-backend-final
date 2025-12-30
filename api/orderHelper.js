const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * 1. PROSES STOK (CORE LOGIC)
 * Perbaikan: Mendukung Multi-Item & Deteksi Stok Utama agar data tidak kosong.
 */
async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        // 1. Ambil Data Order
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw new Error("Order tidak ditemukan di Database.");
        
        const orderData = orderDoc.data();
        // Clone items agar tidak merusak referensi asli saat manipulasi
        let items = JSON.parse(JSON.stringify(orderData.items)); 
        let logs = [];
        let needManual = false;

        // 2. Kumpulkan ID Produk Unik (SOLUSI: Support originalId untuk produk utama)
        const uniqueProductIds = [...new Set(items.map(i => i.originalId || i.id))];
        const productCache = {}; 

        // 3. Baca Semua Data Produk Sekaligus (READ PHASE)
        for (const pid of uniqueProductIds) {
            if (!pid) continue;
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);
            if (pDoc.exists) {
                productCache[pid] = { 
                    ref: pRef, 
                    data: pDoc.data(), 
                    modified: false 
                };
            }
        }

        // 4. Proses Item Satu per Satu (SOLUSI: Looping Multi-Item Tanpa Putus)
        for (let i = 0; i < items.length; i++) {
            // Skip jika item sudah pernah diproses sebelumnya
            if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.originalId || item.id; // KUNCI: Gunakan originalId jika ada
            const productEntry = productCache[pid];

            // Cek Ketersediaan Produk Induk
            if (!productEntry) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk tidak ditemukan di DB.`);
                needManual = true; continue;
            }

            const pData = productEntry.data;
            const isParentManual = pData.isManual || pData.processType === 'MANUAL' || pData.processType === 'EXTERNAL_API';
            
            if (!item.isVariant && isParentManual) {
                logs.push(`⚠️ <b>${item.name}</b>: Tipe Manual (Menunggu Admin).`);
                needManual = true; continue;
            }

            let stokDiambil = [];

            if (item.isVariant && item.variantName) {
                // --- LOGIKA VARIASI ---
                const vIdx = pData.variations ? pData.variations.findIndex(v => 
                    v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                ) : -1;

                if (vIdx !== -1) {
                    const stokVarian = pData.variations[vIdx].items || [];
                    if (stokVarian.length >= item.qty) {
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty);
                        productEntry.modified = true;
                        logs.push(`✅ <b>${item.name}</b>: Stok Varian OK.`);
                    } else {
                        logs.push(`❌ <b>${item.name}</b>: Stok Varian Habis.`);
                        needManual = true;
                    }
                }
            } else {
                // --- PERBAIKAN STOK UTAMA (SOLUSI POIN 1) ---
                const stokUtama = Array.isArray(pData.items) ? pData.items : [];
                
                if (stokUtama.length >= item.qty) {
                    stokDiambil = stokUtama.slice(0, item.qty);
                    pData.items = stokUtama.slice(item.qty);
                    productEntry.modified = true;
                    logs.push(`✅ <b>${item.name}</b>: Stok Utama OK.`);
                } else {
                    logs.push(`❌ <b>${item.name}</b>: Stok Utama Kosong.`);
                    needManual = true;
                }
            }

            // Jika stok berhasil diambil, masukkan ke data item order
            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil; 
                pData.realSold = (pData.realSold || 0) + item.qty;
                productEntry.modified = true;
            }
        }

        // 5. Simpan Perubahan ke Database (WRITE PHASE)
        for (const pid in productCache) {
            if (productCache[pid].modified) {
                const entry = productCache[pid];
                let updatePayload = { realSold: entry.data.realSold || 0 };
                if (entry.data.variations) updatePayload.variations = entry.data.variations;
                if (entry.data.items) updatePayload.items = entry.data.items;
                t.update(entry.ref, updatePayload);
            }
        }

        const finalStatus = needManual ? 'processing' : 'success';
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items, status: finalStatus };
    });
}

/**
 * 2. KIRIM NOTIFIKASI SUKSES (WA)
 * SOLUSI: Menampilkan semua item meskipun banyak variasi di keranjang.
 */
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return;
        const data = snap.data();
        
        let targetPhone = data.phoneNumber || "";
        
        if (!targetPhone || targetPhone.length < 5) {
            for (const item of data.items) {
                if (item.note) {
                    let cleanNote = item.note.replace(/\D/g, '');
                    if (cleanNote.length >= 10 && cleanNote.length <= 15) {
                        targetPhone = cleanNote;
                        break;
                    }
                }
            }
        }

        targetPhone = targetPhone.replace(/\D/g, ''); 
        if (targetPhone.startsWith('0')) targetPhone = '62' + targetPhone.slice(1);
        if (targetPhone.startsWith('8')) targetPhone = '62' + targetPhone;

        const validPhone = (targetPhone.length >= 10 && targetPhone.startsWith('62'));
        const waUrl = validPhone ? `https://wa.me/${targetPhone}` : `https://wa.me/`;

        let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
        // SOLUSI POIN 2: Loop semua item untuk notifikasi bot
        data.items.forEach(i => {
            msg += `📦 *${i.name}*\n`;
            if(i.data && Array.isArray(i.data) && i.data.length > 0) {
                msg += `<code>${i.data.join('\n')}</code>\n\n`;
            } else if (i.note) {
                msg += `_Note: ${i.note}_\nStatus: Diproses\n\n`;
            } else {
                msg += `-\n\n`;
            }
        });
        msg += `Terima Kasih!`;
        
        const finalUrl = `${waUrl}?text=${encodeURIComponent(msg)}`;

        const keyboard = [
            [{ text: "📲 Chat WA User", url: finalUrl }],
            [{ text: "🛠 REVISI / EDIT DATA", callback_data: `REVISI_${orderId}` }]
        ];

        await sendMessage(chatId, `✅ <b>ORDER SELESAI (${type})</b>\nID: ${orderId}\nStatus: Success\n\n👇 <b>Opsi Lanjutan:</b>`, { 
            reply_markup: { inline_keyboard: keyboard } 
        });
    } catch (e) {
        console.error("SendSuccessNotification Error:", e);
        await sendMessage(chatId, `⚠️ Gagal kirim format WA: ${e.message}`);
    }
}

/**
 * 3. MENU INPUT MANUAL (BIARKAN TETAP SAMA)
 */
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `📋 <b>INPUT / EDIT DATA PRODUK</b>\nOrder ID: <code>${orderId}</code>\n\nPilih item yang ingin diisi/diubah:\n`;
    const kb = [];
    if(items && Array.isArray(items)) {
        items.forEach((item, i) => {
            const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
            msg += `\n${i+1}. ${item.name} [${ready ? '✅ TERISI' : '❌ KOSONG'}]`;
            const btnText = ready ? `📝 UBAH: ${item.name.slice(0, 10)}...` : `✏️ ISI: ${item.name.slice(0, 10)}...`;
            kb.push([{ text: btnText, callback_data: `FILL_${orderId}_${i}` }]);
        });
    }
    kb.push([{ text: "🚀 SELESAI (KIRIM NOTIF)", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
