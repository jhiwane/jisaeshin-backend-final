const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * PROSES CEK STOK & UPDATE STATUS (Core Logic)
 * Dipakai oleh: Midtrans, Telegram ACC, dan Notify Auto
 */
async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw new Error("Order tidak ditemukan");
        
        const orderData = orderDoc.data();
        let items = orderData.items;
        let logs = [];
        let needManual = false;

        // Loop setiap item
        for (let i = 0; i < items.length; i++) {
            // Skip jika data sudah terisi (menghindari double processing)
            if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.isVariant ? item.originalId : item.id;
            
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);

            if (!pDoc.exists) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk induk dihapus/hilang di DB.`);
                needManual = true; continue;
            }

            const pData = pDoc.data();
            const isParentManual = pData.isManual || pData.processType === 'MANUAL';

            // --- PERBAIKAN LOGIKA 1: IZINKAN VARIAN MESKIPUN INDUK MANUAL ---
            // Jika ini BUKAN varian (Produk Utama) DAN settingannya manual, baru kita skip.
            if (!item.isVariant && isParentManual) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk tipe Manual (Tunggu Admin).`);
                needManual = true; continue;
            }

            let stokDiambil = [];
            let updateTarget = {};

            // --- CEK STOK ---
            if (item.isVariant) {
                // Cari index variasi (Case Insensitive & Trimmed biar akurat)
                const vIdx = pData.variations ? pData.variations.findIndex(v => 
                    v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                ) : -1;

                if (vIdx !== -1) {
                    const stokVarian = pData.variations[vIdx].items || [];
                    if (stokVarian.length >= item.qty) {
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty); // Sisa stok
                        updateTarget = { variations: pData.variations };
                        logs.push(`✅ <b>${item.name}</b>: Stok Varian OK.`);
                    } else {
                        logs.push(`❌ <b>${item.name}</b>: Stok Varian KURANG (Sisa: ${stokVarian.length}).`);
                        needManual = true;
                    }
                } else {
                    logs.push(`❌ <b>${item.name}</b>: Nama Varian '${item.variantName}' tidak cocok di DB.`);
                    needManual = true;
                }
            } else {
                // Produk Utama (Non-Varian)
                const stokUtama = pData.items || [];
                if (stokUtama.length >= item.qty) {
                    stokDiambil = stokUtama.slice(0, item.qty);
                    updateTarget = { items: stokUtama.slice(item.qty) };
                    logs.push(`✅ <b>${item.name}</b>: Stok Utama OK.`);
                } else {
                    logs.push(`❌ <b>${item.name}</b>: Stok Utama HABIS.`);
                    needManual = true;
                }
            }

            // Update ke Item & Database jika stok ketemu
            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil;   // Backup
                items[i].desc = stokDiambil; // Backup
                
                // Tambah counter terjual
                updateTarget.realSold = (pData.realSold || 0) + item.qty;
                t.update(pRef, updateTarget);
            }
        }

        // Status Final
        const finalStatus = needManual ? 'processing' : 'success';
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items, status: finalStatus };
    });
}

/**
 * KIRIM NOTIFIKASI SUKSES (Format Konsisten)
 */
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    // Logika Cari Nomor HP
    let hp = data.phoneNumber || "";
    if ((!hp || hp.length < 5) && data.items[0]?.note) {
        hp = data.items[0].note.replace(/\D/g, '');
    }
    hp = hp.replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);

    // Format Pesan WA
    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 ${i.name}\n`;
        if(i.data && Array.isArray(i.data)) msg += `${i.data.join('\n')}\n\n`;
        else msg += `-\n\n`;
    });
    msg += `Terima Kasih!`;

    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    
    // Kirim Ke Telegram Admin
    await sendMessage(chatId, `✅ <b>ORDER SELESAI (${type})</b>\nID: ${orderId}\nStatus: Success (Dikirim ke Web)\n\n👇 <b>Kirim ke User:</b>`, { 
        reply_markup: { inline_keyboard: [[{ text: "📲 Chat WA User", url: url }]] } 
    });
}

/**
 * TAMPILKAN MENU INPUT MANUAL (Jika Stok Kosong)
 */
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `⚠️ <b>BUTUH INPUT MANUAL</b>\nOrder ID: <code>${orderId}</code>\n\nIsi data untuk item berikut:\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        const icon = ready ? '✅' : '❌';
        msg += `\n${i+1}. ${item.name} [${icon}]`;
        
        if (!ready) {
            // Callback data MAX 64 bytes. Kita kirim index saja biar aman.
            kb.push([{ text: `✏️ ISI: ${item.name.slice(0, 15)}...`, callback_data: `FILL_${orderId}_${i}` }]);
        }
    });

    kb.push([{ text: "🚀 FORCE DONE (PAKSA SELESAI)", callback_data: `DONE_${orderId}` }]);
    
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
