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
/*1.fungsi sukses order*/
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return;
        const data = snap.data();
        
        // Header sesuai permintaan kamu
        let msg = `✅ <b>ORDER SELESAI (${type})</b>\n`;
        msg += `ID: <code>${orderId}</code>\n`;
        msg += `Status: Success\n\n`;

        // Loop Item dengan penomoran
        if (data.items && Array.isArray(data.items)) {
            data.items.forEach((item, index) => {
                // Format: item 1 :name qty: 100
                msg += `item ${index + 1} :${item.name}  qty: ${item.qty || 1}\n`;
                
                // --- LOGIKA ANTI-LIMIT & ANTI-DELAY ---
                if (item.data && Array.isArray(item.data) && item.data.length > 0) {
                    // Hanya tampilkan 3 data pertama di bot sebagai sampel
                    const sampleData = item.data.slice(0, 3); 
                    msg += `<code>${sampleData.join('\n')}</code>\n`;
                    
                    // Jika data lebih dari 3, beri info tambahan
                    if (item.data.length > 3) {
                        msg += `<i>(+ ${item.data.length - 3} data lainnya tersedia di Web)</i>\n`;
                    }
                } else {
                    msg += `<i>(Menunggu data/Manual)</i>\n`;
                }
                msg += `\n`; // Spasi antar produk
            });
        }

        msg += `👇 <b>Opsi Lanjutan:</b>`;

        // Ambil nomor WA untuk tombol
        let targetPhone = data.phoneNumber || "";
        targetPhone = targetPhone.replace(/\D/g, ''); 
        if (targetPhone.startsWith('0')) targetPhone = '62' + targetPhone.slice(1);
        if (targetPhone.startsWith('8')) targetPhone = '62' + targetPhone;
        
        const keyboard = [
            [{ text: "📲 Chat WA User", url: `https://wa.me/${targetPhone}` }],
            [{ text: "🛠 REVISI / EDIT DATA", callback_data: `REVISI_${orderId}` }]
        ];

        // KIRIM PESAN (Satu kali kirim untuk semua item agar tidak delay)
        await sendMessage(chatId, msg, { 
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'HTML'
        });

    } catch (e) {
        console.error("Gagal kirim notif:", e);
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
