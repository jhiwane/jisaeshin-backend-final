const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * PROSES CEK STOK & UPDATE STATUS (Core Logic)
 * (Bagian ini TIDAK BERUBAH dari versi sebelumnya)
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

/**
 * KIRIM NOTIFIKASI SUKSES (Update Fix WA & Tombol Revisi)
 */
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    // --- PERBAIKAN LOGIKA NOMOR WA ---
    // 1. Ambil dari phoneNumber user dulu (bersihkan karakter aneh)
    let hp = data.phoneNumber ? data.phoneNumber.replace(/\D/g, '') : "";

    // 2. Kalau kosong atau kependekan (di bawah 10 digit), baru cek Note
    if (hp.length < 10 && data.items[0]?.note) {
        const numbersInNote = data.items[0].note.replace(/\D/g, '');
        // HANYA AMBIL jika panjangnya masuk akal (10-15 digit)
        // Ini mencegah angka "15442" dianggap nomor HP
        if (numbersInNote.length >= 10 && numbersInNote.length <= 15) {
            hp = numbersInNote;
        }
    }

    // 3. Format ke 62 (Indonesia)
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);
    if (hp.startsWith('8')) hp = '62' + hp; // Jaga-jaga user ngetik 812...

    // 4. Buat Link (Jika HP kosong, link WA akan membuka daftar kontak)
    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 ${i.name}\n`;
        if(i.data && Array.isArray(i.data)) msg += `${i.data.join('\n')}\n\n`;
        else msg += `-\n\n`;
    });
    msg += `Terima Kasih!`;

    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    
    // --- TOMBOL NOTIFIKASI ---
    const keyboard = [
        [{ text: "📲 Chat WA User", url: url }],
        // FITUR BARU: TOMBOL REVISI (UPDATE KONTEN)
        [{ text: "🛠 REVISI / EDIT DATA", callback_data: `REVISI_${orderId}` }]
    ];

    await sendMessage(chatId, `✅ <b>ORDER SELESAI (${type})</b>\nID: ${orderId}\nStatus: Success (Dikirim ke Web)\n\n👇 <b>Opsi Lanjutan:</b>`, { 
        reply_markup: { inline_keyboard: keyboard } 
    });
}

/**
 * TAMPILKAN MENU INPUT/EDIT (Update: Bisa untuk Revisi)
 */
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `📋 <b>INPUT / EDIT DATA PRODUK</b>\nOrder ID: <code>${orderId}</code>\n\nPilih item yang ingin diisi/diubah:\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        
        // Tampilan Status di Text
        msg += `\n${i+1}. ${item.name} [${ready ? '✅ TERISI' : '❌ KOSONG'}]`;
        
        // PERBAIKAN: Tombol selalu muncul.
        // Jika kosong -> "✏️ ISI"
        // Jika isi -> "📝 UBAH" (Fitur Update Konten)
        const btnText = ready ? `📝 UBAH DATA: ${item.name.slice(0, 10)}...` : `✏️ ISI DATA: ${item.name.slice(0, 10)}...`;
        
        kb.push([{ text: btnText, callback_data: `FILL_${orderId}_${i}` }]);
    });

    kb.push([{ text: "🚀 SELESAI (KIRIM NOTIF)", callback_data: `DONE_${orderId}` }]);
    
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
