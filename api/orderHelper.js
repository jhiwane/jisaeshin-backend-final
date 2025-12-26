const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

// ... (Fungsi processOrderStock BIARKAN TETAP SAMA sprti sebelumnya) ...
// ... COPY PASTE KODE processOrderStock YANG LAMA DI SINI ...
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
            const isParentManual = pData.isManual || pData.processType === 'MANUAL';

            if (!item.isVariant && isParentManual) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk tipe Manual (Tunggu Admin).`);
                needManual = true; continue;
            }

            let stokDiambil = [];
            let updateTarget = {};

            if (item.isVariant) {
                const vIdx = pData.variations ? pData.variations.findIndex(v => 
                    v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                ) : -1;

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
                    logs.push(`❌ <b>${item.name}</b>: Varian tidak cocok.`);
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
                items[i].sn = stokDiambil;
                items[i].desc = stokDiambil;
                updateTarget.realSold = (pData.realSold || 0) + item.qty;
                t.update(pRef, updateTarget);
            }
        }

        const finalStatus = needManual ? 'processing' : 'success';
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items, status: finalStatus };
    });
}

// ... (INI YANG DIPERBAIKI UNTUK WA) ...
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    // --- LOGIKA WA SUPER KETAT ---
    let rawHP = data.phoneNumber || "";
    
    // 1. Bersihkan semua karakter selain angka
    let cleanHP = rawHP.replace(/\D/g, ''); 

    // 2. Jika kosong/pendek, coba cari di Note item pertama
    if (cleanHP.length < 9 && data.items[0]?.note) {
        let noteNum = data.items[0].note.replace(/\D/g, '');
        // Validasi: Nomor HP Indo minimal 9-13 digit
        if (noteNum.length >= 9 && noteNum.length <= 15) {
            cleanHP = noteNum;
        }
    }

    // 3. Format Prefix (08 -> 628)
    if (cleanHP.startsWith('0')) {
        cleanHP = '62' + cleanHP.slice(1);
    } else if (cleanHP.startsWith('8')) {
        cleanHP = '62' + cleanHP;
    }

    // 4. Validasi Akhir: Jika formatnya aneh, kosongkan saja biar link WA ngebuka Contact Picker
    if (cleanHP.length < 10 || !cleanHP.startsWith('62')) {
        cleanHP = ""; 
    }

    // Pesan
    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 *${i.name}*\n`;
        if(i.data && Array.isArray(i.data)) msg += `${i.data.join('\n')}\n\n`;
        else msg += `-\n\n`;
    });
    msg += `Terima Kasih!`;

    // Jika cleanHP ada isinya, dia akan direct chat. Jika kosong, dia akan minta pilih kontak.
    const url = cleanHP ? `https://wa.me/${cleanHP}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    
    const keyboard = [
        [{ text: "📲 Chat WA User", url: url }],
        [{ text: "🛠 REVISI / EDIT DATA", callback_data: `REVISI_${orderId}` }]
    ];

    await sendMessage(chatId, `✅ <b>ORDER SELESAI (${type})</b>\nID: ${orderId}\nStatus: Success\n\n👇 <b>Opsi Lanjutan:</b>`, { 
        reply_markup: { inline_keyboard: keyboard } 
    });
}

// ... (Fungsi showManualInputMenu BIARKAN TETAP SAMA) ...
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `📋 <b>INPUT / EDIT DATA PRODUK</b>\nOrder ID: <code>${orderId}</code>\n\nPilih item yang ingin diisi/diubah:\n`;
    const kb = [];
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `\n${i+1}. ${item.name} [${ready ? '✅ TERISI' : '❌ KOSONG'}]`;
        const btnText = ready ? `📝 UBAH DATA: ${item.name.slice(0, 10)}...` : `✏️ ISI DATA: ${item.name.slice(0, 10)}...`;
        kb.push([{ text: btnText, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "🚀 SELESAI (KIRIM NOTIF)", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
