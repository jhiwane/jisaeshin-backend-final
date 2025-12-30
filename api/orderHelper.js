const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * 1. PROSES STOK (CORE LOGIC)
 * Perbaikan: Menggunakan sistem Batch Processing untuk mencegah konflik transaksi
 * saat membeli banyak varian dari produk yang sama.
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

        // 2. Kumpulkan ID Produk Unik (Supaya tidak baca DB berkali-kali untuk produk yg sama)
        const uniqueProductIds = [...new Set(items.map(i => i.isVariant ? i.originalId : i.id))];
        const productCache = {}; // Penyimpanan sementara data produk

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

        // 4. Proses Item Satu per Satu (LOGIC PHASE)
        for (let i = 0; i < items.length; i++) {
            // Skip jika item sudah pernah diproses sebelumnya (ada data)
            if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.isVariant ? item.originalId : item.id;
            const productEntry = productCache[pid];

            // Cek Ketersediaan Produk Induk
            if (!productEntry) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk induk tidak ditemukan di Database.`);
                needManual = true; continue;
            }

            const pData = productEntry.data;
            
            // Cek apakah produk ini Manual/API (Langsung skip stok)
            const isParentManual = pData.isManual || pData.processType === 'MANUAL' || pData.processType === 'EXTERNAL_API';
            if (!item.isVariant && isParentManual) {
                logs.push(`⚠️ <b>${item.name}</b>: Produk tipe Manual/API (Menunggu Admin).`);
                needManual = true; continue;
            }

            // --- LOGIKA POTONG STOK ---
            let stokDiambil = [];

            if (item.isVariant) {
                // Cari Index Varian (Case Insensitive & Trimmed)
                const vIdx = pData.variations ? pData.variations.findIndex(v => 
                    v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                ) : -1;

                if (vIdx !== -1) {
                    const stokVarian = pData.variations[vIdx].items || [];
                    if (stokVarian.length >= item.qty) {
                        // Potong Stok
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty); // Update memori lokal
                        productEntry.modified = true; // Tandai untuk disimpan nanti
                        logs.push(`✅ <b>${item.name}</b>: Stok Varian OK.`);
                    } else {
                        logs.push(`❌ <b>${item.name}</b>: Stok Varian KURANG (Sisa ${stokVarian.length}).`);
                        needManual = true;
                    }
                } else {
                    logs.push(`❌ <b>${item.name}</b>: Nama Varian tidak cocok/hilang.`);
                    needManual = true;
                }
            } else {
                // --- PERBAIKAN STOK UTAMA DI SINI ---
                // Mengambil dari pData.items (Array Stok)
                const stokUtama = Array.isArray(pData.items) ? pData.items : [];
                
                if (stokUtama.length >= item.qty) {
                    stokDiambil = stokUtama.slice(0, item.qty);
                    pData.items = stokUtama.slice(item.qty); // Update memori
                    productEntry.modified = true;
                    logs.push(`✅ <b>${item.name}</b>: Stok Utama OK.`);
                } else {
                    // Jika stokUtama kosong, logs akan memberitahu admin
                    logs.push(`❌ <b>${item.name}</b>: Stok Utama KOSONG/HABIS.`);
                    needManual = true;
                }
            }

            // Jika stok berhasil diambil, masukkan ke data item order
            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil; // Kompatibilitas lama
                // Tambah counter terjual di data produk
                pData.realSold = (pData.realSold || 0) + item.qty;
                productEntry.modified = true;
            }
        }

        // 5. Simpan Perubahan ke Database (WRITE PHASE)
        // Update Produk yang stoknya berubah
        for (const pid in productCache) {
            if (productCache[pid].modified) {
                const entry = productCache[pid];
                // Kita update field yang relevan saja agar efisien
                let updatePayload = { realSold: entry.data.realSold };
                if (entry.data.variations) updatePayload.variations = entry.data.variations;
                if (entry.data.items) updatePayload.items = entry.data.items;
                
                t.update(entry.ref, updatePayload);
            }
        }

        // Update Status Order & Items yang sudah terisi data
        const finalStatus = needManual ? 'processing' : 'success';
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items, status: finalStatus };
    });
}

/**
 * 2. KIRIM NOTIFIKASI SUKSES (WA)
 * Perbaikan: Mencari Nomor HP di SEMUA item, bukan cuma item pertama.
 */
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return;
        const data = snap.data();
        
        // --- LOGIKA PENCARIAN NOMOR HP (REVISI) ---
        let targetPhone = "";
        
        // Cek 1: Apakah ada field phoneNumber global? (Dari profil user)
        if (data.phoneNumber) targetPhone = data.phoneNumber;

        // Cek 2: Jika kosong, cari di Note SETIAP ITEM
        if (!targetPhone || targetPhone.length < 5) {
            // Loop semua item untuk cari yang mirip nomor HP
            for (const item of data.items) {
                if (item.note) {
                    // Bersihkan note, ambil angkanya saja
                    let cleanNote = item.note.replace(/\D/g, '');
                    // Jika panjangnya wajar untuk nomor HP (10-15 digit)
                    if (cleanNote.length >= 10 && cleanNote.length <= 15) {
                        targetPhone = cleanNote;
                        break; // Ketemu! Berhenti mencari.
                    }
                }
            }
        }

        // Format ke 62 (Standar WA)
        targetPhone = targetPhone.replace(/\D/g, ''); // Pastikan cuma angka
        if (targetPhone.startsWith('0')) targetPhone = '62' + targetPhone.slice(1);
        if (targetPhone.startsWith('8')) targetPhone = '62' + targetPhone;

        // Validasi Akhir
        const validPhone = (targetPhone.length >= 10 && targetPhone.startsWith('62'));
        const waUrl = validPhone 
            ? `https://wa.me/${targetPhone}` 
            : `https://wa.me/`; // Jika invalid, buka WA picker

        // Susun Pesan
        let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
        data.items.forEach(i => {
            msg += `📦 *${i.name}*\n`;
            if(i.data && Array.isArray(i.data) && i.data.length > 0) {
                // Tampilkan kode/data stok
                msg += `${i.data.join('\n')}\n\n`;
            } else if (i.note) {
                // Jika manual/proses, tampilkan catatan user
                msg += `_Note: ${i.note}_\nStatus: Menunggu Proses/Terkirim\n\n`;
            } else {
                msg += `-\n\n`;
            }
        });
        msg += `Terima Kasih!`;
        
        // Encode pesan untuk URL
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
