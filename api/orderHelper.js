const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * 1. PROSES STOK (CORE LOGIC)
 */
async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        // 1. Ambil Data Order
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw new Error("Order tidak ditemukan di Database.");
        
        const orderData = orderDoc.data();
        let items = JSON.parse(JSON.stringify(orderData.items)); 
        let logs = [];
        let needManual = false;

        // 2. Kumpulkan ID Produk Unik
        const uniqueProductIds = [...new Set(items.map(i => i.originalId || i.id))];
        const productCache = {}; 

        // 3. Baca Semua Data Produk
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

        // 4. Proses Item Satu per Satu
        for (let i = 0; i < items.length; i++) {
            if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.originalId || item.id;
            const productEntry = productCache[pid];

            if (!productEntry) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk tidak ditemukan.`);
                needManual = true; continue;
            }

            const pData = productEntry.data;
            let stokDiambil = [];

            // A. LOGIKA VARIASI
            if (item.isVariant && item.variantName) {
                const vIdx = pData.variations ? pData.variations.findIndex(v => 
                    v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                ) : -1;

                if (vIdx !== -1) {
                    const stokVarian = Array.isArray(pData.variations[vIdx].items) ? pData.variations[vIdx].items : [];
                    if (stokVarian.length >= item.qty) {
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty);
                        productEntry.modified = true;
                    }
                }
            } 
            // B. LOGIKA PRODUK UTAMA (PERBAIKAN DISINI)
            else {
                let stokUtama = [];
                if (Array.isArray(pData.items)) {
                    stokUtama = pData.items;
                } else if (typeof pData.items === 'string' && pData.items.trim() !== "") {
                    stokUtama = pData.items.split('\n').filter(x => x.trim());
                }

                if (stokUtama.length >= (item.qty || 1)) {
                    stokDiambil = stokUtama.slice(0, item.qty || 1);
                    pData.items = stokUtama.slice(item.qty || 1);
                    productEntry.modified = true;
                }
            }

            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil; 
                pData.realSold = (pData.realSold || 0) + (item.qty || 1);
                productEntry.modified = true;
                logs.push(`✅ <b>${item.name}</b>: Berhasil.`);
            } else {
                logs.push(`❌ <b>${item.name}</b>: Stok Kosong.`);
                needManual = true;
            }
        }

        // 5. Simpan Perubahan
        for (const pid in productCache) {
            if (productCache[pid].modified) {
                const entry = productCache[pid];
                t.update(entry.ref, {
                    items: entry.data.items || [],
                    variations: entry.data.variations || [],
                    realSold: entry.data.realSold || 0
                });
            }
        }

        const finalStatus = needManual ? 'processing' : 'success';
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items, status: finalStatus };
    });
}

/**
 * 2. KIRIM NOTIFIKASI SUKSES
 */
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return;
        const data = snap.data();
        
        let targetPhone = data.phoneNumber || "";
        
        if (!targetPhone || targetPhone.length < 5) {
            for (const item of (data.items || [])) {
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
    }
}

/**
 * 3. MENU INPUT MANUAL
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
