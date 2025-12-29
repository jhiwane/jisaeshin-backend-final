const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * FUNGSI UTAMA: PROSES STOK (ANTI-MACET EDITION)
 * Mengembalikan objek: { success: boolean, logs: array, items: array }
 * Tidak akan pernah throw error (bikin bengong), tapi return error log.
 */
async function processOrderStock(orderId) {
    try {
        const orderRef = db.collection('orders').doc(orderId);

        // Kita gunakan Transaction agar stok aman (tidak minus berebut)
        const result = await db.runTransaction(async (t) => {
            const orderDoc = await t.get(orderRef);
            
            // 1. Cek Apakah Order Ada
            if (!orderDoc.exists) {
                return { 
                    success: false, 
                    logs: ["❌ Order ID tidak ditemukan di Database."], 
                    items: [] 
                };
            }
            
            const orderData = orderDoc.data();
            let items = orderData.items || [];
            let logs = [];
            let needManual = false;
            let hasChange = false; // Penanda apakah ada perubahan data

            // 2. Loop Setiap Item
            for (let i = 0; i < items.length; i++) {
                // Skip jika item ini SUDAH terisi sebelumnya
                if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) {
                    continue; 
                }

                const item = items[i];
                const pid = item.isVariant ? item.originalId : item.id;
                
                // Cek Produk di DB
                const pRef = db.collection('products').doc(pid);
                const pDoc = await t.get(pRef);

                if (!pDoc.exists) {
                    logs.push(`⚠️ <b>${item.name}</b>: Produk induk dihapus/hilang dari DB.`);
                    needManual = true; continue;
                }

                const pData = pDoc.data();
                
                // Cek apakah produk ini mode MANUAL (bukan otomatis)
                const isParentManual = pData.isManual || pData.processType === 'MANUAL';
                if (!item.isVariant && isParentManual) {
                    logs.push(`ℹ️ <b>${item.name}</b>: Produk tipe Manual (Tunggu Admin).`);
                    needManual = true; continue;
                }

                let stokDiambil = [];
                let updateTarget = {};

                // 3. Logika Pengambilan Stok (Varian vs Utama)
                if (item.isVariant) {
                    const vIdx = pData.variations ? pData.variations.findIndex(v => 
                        v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                    ) : -1;

                    if (vIdx !== -1) {
                        const stokVarian = pData.variations[vIdx].items || [];
                        if (stokVarian.length >= item.qty) {
                            stokDiambil = stokVarian.slice(0, item.qty);
                            // Update sisa stok di memory
                            pData.variations[vIdx].items = stokVarian.slice(item.qty);
                            updateTarget = { variations: pData.variations };
                            logs.push(`✅ <b>${item.name}</b>: Stok Sukses.`);
                        } else {
                            logs.push(`❌ <b>${item.name}</b>: Stok Varian KURANG (Sisa ${stokVarian.length}).`);
                            needManual = true;
                        }
                    } else {
                        logs.push(`❌ <b>${item.name}</b>: Nama Varian tidak cocok di DB.`);
                        needManual = true;
                    }
                } else {
                    // Produk Biasa (Non Varian)
                    const stokUtama = pData.items || [];
                    if (stokUtama.length >= item.qty) {
                        stokDiambil = stokUtama.slice(0, item.qty);
                        updateTarget = { items: stokUtama.slice(item.qty) };
                        logs.push(`✅ <b>${item.name}</b>: Stok Sukses.`);
                    } else {
                        logs.push(`❌ <b>${item.name}</b>: Stok Utama HABIS.`);
                        needManual = true;
                    }
                }

                // 4. Jika Stok Berhasil Diambil -> Simpan
                if (stokDiambil.length > 0) {
                    items[i].data = stokDiambil; 
                    items[i].sn = stokDiambil;
                    items[i].desc = stokDiambil; // Backup
                    
                    // Update Stok Produk di DB
                    updateTarget.realSold = (pData.realSold || 0) + item.qty;
                    t.update(pRef, updateTarget);
                    hasChange = true;
                }
            }

            // 5. Tentukan Status Akhir Order
            // Jika ada yang butuh manual, status = processing. Jika semua beres = success.
            // TAPI, kita cek dulu apakah semua items sudah terisi penuh?
            const allFilled = items.every(itm => itm.data && itm.data.length > 0);
            const finalStatus = allFilled ? 'success' : 'processing';

            // Update Order di DB
            if (hasChange || finalStatus !== orderData.status) {
                t.update(orderRef, { items: items, status: finalStatus });
            }

            // Return hasil transaksi
            return { 
                success: allFilled, // True jika SEMUA item beres
                logs: logs, 
                items: items,
                status: finalStatus
            };
        });

        return result;

    } catch (e) {
        console.error("🔥 Error processOrderStock:", e);
        // RETURN ERROR SAFE OBJECT (Supaya frontend/bot tidak bengong)
        return { 
            success: false, 
            logs: [`🔥 SYSTEM ERROR: ${e.message}`], 
            items: [] 
        };
    }
}

/**
 * FUNGSI NOTIFIKASI WA (SUPPORT PARTIAL)
 * Hanya mengirimkan kode untuk item yang SUDAH ADA datanya.
 */
async function sendSuccessNotification(chatId, orderId, type = "OTOMATIS") {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return;
        
        const data = snap.data();
        
        // --- LOGIKA CLEANING NOMOR HP ---
        let rawHP = data.buyerPhone || data.phoneNumber || "";
        let cleanHP = rawHP.replace(/\D/g, ''); 

        // Coba cari di Note jika kosong
        if (cleanHP.length < 9 && data.items && data.items[0]?.note) {
            let noteNum = data.items[0].note.replace(/\D/g, '');
            if (noteNum.length >= 9 && noteNum.length <= 15) cleanHP = noteNum;
        }
        // Format 62
        if (cleanHP.startsWith('0')) cleanHP = '62' + cleanHP.slice(1);
        else if (cleanHP.startsWith('8')) cleanHP = '62' + cleanHP;

        // Validasi Akhir
        if (cleanHP.length < 10 || !cleanHP.startsWith('62')) cleanHP = ""; 

        // --- MENYUSUN PESAN WA ---
        let msg = `Halo Kak ${data.buyerName || ''}, Pesanan *${orderId}* Kamu:\n\n`;
        let hasContent = false;

        data.items.forEach(i => {
            msg += `📦 *${i.name}*\n`;
            
            // Cek apakah item ini sudah punya data (Akun/Voucher)
            if(i.data && Array.isArray(i.data) && i.data.length > 0) {
                // Tampilkan Datanya
                msg += `${i.data.join('\n')}\n\n`;
                hasContent = true;
            } else {
                // Jika kosong (karena stok habis/partial), beri info pending
                msg += `_Sedang diproses Admin (Mohon Ditunggu)_\n\n`;
            }
        });
        msg += `Terima Kasih! Simpan bukti ini ya.`;

        // Generate Link WA
        const url = cleanHP 
            ? `https://wa.me/${cleanHP}?text=${encodeURIComponent(msg)}` 
            : `https://wa.me/?text=${encodeURIComponent(msg)}`;
        
        // --- TOMBOL BOT TELEGRAM ---
        const keyboard = [
            [{ text: "📲 Chat WA User", url: url }],
            // Tombol revisi tetap ada buat jaga-jaga
            [{ text: "🛠 REVISI / EDIT DATA", callback_data: `REVISI_${orderId}` }]
        ];

        // Kirim Pesan ke Admin Bot
        // Jika data ada isinya, bilang SUKSES. Jika masih ada yang pending, bilang PARTIAL.
        const statusText = hasContent ? "DATA TERKIRIM" : "MENUNGGU MANUAL";
        
        await sendMessage(chatId, `✅ <b>ORDER PROCESSED (${type})</b>\nID: ${orderId}\nStatus: ${statusText}\n\n👇 <b>Kirim ke Pembeli:</b>`, { 
            reply_markup: { inline_keyboard: keyboard } 
        });

    } catch (e) {
        console.error("Error sendSuccessNotification:", e);
    }
}

/**
 * FUNGSI MENU INPUT MANUAL
 * Digunakan saat stok kosong atau revisi
 */
async function showManualInputMenu(chatId, orderId, items) {
    if (!items || !Array.isArray(items)) {
        // Fallback jika items undefined (ambil dari DB)
        const s = await db.collection('orders').doc(orderId).get();
        if(s.exists) items = s.data().items;
        else items = [];
    }

    let msg = `📋 <b>INPUT / EDIT DATA PRODUK</b>\nOrder ID: <code>${orderId}</code>\n\nPilih item yang ingin diisi/diubah:\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        // Cek status per item
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        
        msg += `\n${i+1}. ${item.name} [${ready ? '✅ TERISI' : '❌ KOSONG'}]`;
        
        // Tombol
        const btnText = ready ? `📝 UBAH: ${item.name.slice(0, 10)}...` : `✏️ ISI: ${item.name.slice(0, 10)}...`;
        kb.push([{ text: btnText, callback_data: `FILL_${orderId}_${i}` }]);
    });

    // Tombol Selesai
    kb.push([{ text: "🚀 SELESAI (KIRIM NOTIF)", callback_data: `DONE_${orderId}` }]);
    
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
