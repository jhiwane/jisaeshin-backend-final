const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

// ==========================================
// 1. PROSES STOK (TRANSACTION)
// ==========================================
async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw new Error("Order tidak ditemukan");
        
        const orderData = orderDoc.data();
        let items = orderData.items;
        let logs = [];
        let needManual = false;

        for (let i = 0; i < items.length; i++) {
            // Skip jika data sudah terisi (misal disuntik dari Frontend)
            if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.isVariant ? item.originalId : item.id;
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);

            if (!pDoc.exists) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk induk dihapus/hilang.`);
                needManual = true; continue;
            }

            const pData = pDoc.data();
            // Cek apakah produk manual
            const isParentManual = pData.isManual || pData.processType === 'MANUAL';

            if (!item.isVariant && isParentManual) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk tipe Manual (Tunggu Admin).`);
                needManual = true; continue;
            }

            let stokDiambil = [];
            let updateTarget = {};

            if (item.isVariant) {
                // [FIX] Gunakan Optional Chaining (?.) biar gak crash kalo variations null
                const vIdx = pData.variations?.findIndex(v => 
                    v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                ) ?? -1;

                if (vIdx !== -1) {
                    const stokVarian = pData.variations[vIdx].items || [];
                    if (stokVarian.length >= item.qty) {
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty);
                        updateTarget = { variations: pData.variations };
                        logs.push(`✅ <b>${item.name}</b>: Stok Varian OK.`);
                    } else {
                        logs.push(`❌ <b>${item.name}</b>: Stok Varian KURANG.`);
                        needManual = true;
                    }
                } else {
                    logs.push(`❌ <b>${item.name}</b>: Varian tidak cocok/hilang.`);
                    needManual = true;
                }
            } else {
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

            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil; // Backward compatibility
                // items[i].desc = stokDiambil; // Opsional, biasanya data cukup
                updateTarget.realSold = (pData.realSold || 0) + item.qty;
                t.update(pRef, updateTarget);
            }
        }

        const finalStatus = needManual ? 'processing' : 'success';
        // Simpan status baru
        t.update(orderRef, { items: items, status: finalStatus });

        // [OPTIMASI] Kembalikan orderData terbaru supaya gak perlu fetch ulang di notif
        return { success: !needManual, logs, items, status: finalStatus, orderData: { ...orderData, items, status: finalStatus } };
    });
}

// ==========================================
// 2. KIRIM NOTIFIKASI (WA LINK FIX)
// ==========================================
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS", preLoadedData = null) {
    let data;
    
    // [OPTIMASI] Pakai data yang dilempar dari processOrderStock jika ada
    if (preLoadedData) {
        data = preLoadedData;
    } else {
        const snap = await db.collection('orders').doc(orderId).get();
        data = snap.data();
    }

    if (!data) return; // Safety check
    
    // --- LOGIKA NOMOR HP ---
    let rawHP = data.phoneNumber || ""; // Default string kosong
    
    // 1. Bersihkan karakter aneh
    let cleanHP = rawHP.replace(/\D/g, ''); 

    // 2. Coba ambil dari Note jika HP utama kosong
    // [FIX CRITICAL] Tambahkan ( || "") agar tidak error replace pada undefined
    if (cleanHP.length < 9) {
        let noteToCheck = data.items[0]?.note || ""; 
        let noteNum = noteToCheck.replace(/\D/g, '');
        
        if (noteNum.length >= 9 && noteNum.length <= 15) {
            cleanHP = noteNum;
        }
    }

    // 3. Format Prefix Indonesia
    if (cleanHP.startsWith('0')) {
        cleanHP = '62' + cleanHP.slice(1);
    } else if (cleanHP.startsWith('8')) {
        cleanHP = '62' + cleanHP;
    }

    // 4. Validasi Akhir
    if (cleanHP.length < 10 || !cleanHP.startsWith('62')) {
        cleanHP = ""; // Kosongkan biar jadi link netral
    }

    // Susun Pesan
    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 *${i.name}*\n`;
        if(i.data && Array.isArray(i.data) && i.data.length > 0) {
            msg += `${i.data.join('\n')}\n\n`;
        } else {
            msg += `(Data terkirim terpisah/kosong)\n\n`;
        }
    });
    msg += `Terima Kasih!`;

    const url = cleanHP ? `https://wa.me/${cleanHP}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    
    const keyboard = [
        [{ text: "📲 Chat WA User", url: url }],
        [{ text: "🛠 REVISI / EDIT DATA", callback_data: `REVISI_${orderId}` }]
    ];

    await sendMessage(chatId, `✅ <b>ORDER SELESAI (${type})</b>\nID: <code>${orderId}</code>\nStatus: Success\n\n👇 <b>Opsi Lanjutan:</b>`, { 
        reply_markup: { inline_keyboard: keyboard } 
    });
}

// ... (showManualInputMenu TETAP SAMA) ...
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `📋 <b>INPUT / EDIT DATA PRODUK</b>\nOrder ID: <code>${orderId}</code>\n\nPilih item yang ingin diisi/diubah:\n`;
    const kb = [];
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `\n${i+1}. ${item.name} [${ready ? '✅ TERISI' : '❌ KOSONG'}]`;
        // Potong nama jika terlalu panjang agar tombol rapi
        const shortName = item.name.length > 15 ? item.name.slice(0, 15) + '...' : item.name;
        const btnText = ready ? `📝 UBAH: ${shortName}` : `✏️ ISI: ${shortName}`;
        kb.push([{ text: btnText, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "🚀 SELESAI (KIRIM NOTIF)", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
