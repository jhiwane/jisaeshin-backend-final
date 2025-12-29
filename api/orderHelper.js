const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * LOGIKA BARU: DEEP SEARCH & FUZZY MATCH
 * Mencari stok dengan toleransi tinggi (Hapus spasi, lowercase).
 */
async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);

    try {
        const result = await db.runTransaction(async (t) => {
            const orderDoc = await t.get(orderRef);
            if (!orderDoc.exists) return { success: false, logs: ["ID Not Found"], items: [] };
            
            const orderData = orderDoc.data();
            let items = orderData.items || [];
            let logs = [];
            
            // Loop Item
            for (let i = 0; i < items.length; i++) {
                // Skip jika item ini SUDAH TERISI (biar gak nimpa data revisi manual sebelumnya)
                if (items[i].data && items[i].data.length > 0) continue;

                const item = items[i];
                const pid = item.isVariant ? item.originalId : item.id;
                
                // Ambil Produk Master
                const pRef = db.collection('products').doc(pid);
                const pDoc = await t.get(pRef);

                if (!pDoc.exists) {
                    logs.push(`⚠️ ${item.name}: Produk induk dihapus dari DB.`);
                    continue; 
                }

                const pData = pDoc.data();
                
                // Jika produk diset MANUAL murni oleh Admin
                if (pData.processType === 'MANUAL') {
                    logs.push(`ℹ️ ${item.name}: Mode Manual Admin.`);
                    continue;
                }

                let stokDiambil = [];
                let updateTarget = {};

                // --- LOGIKA PENCARIAN STOK (DIPERBAIKI) ---
                if (item.isVariant) {
                    // Normalisasi Nama Varian Order (kecilkan semua, hapus spasi)
                    const targetName = (item.variantName || "").toLowerCase().trim().replace(/\s+/g, '');
                    
                    // Cari di Array Variations Database
                    const variations = pData.variations || [];
                    const vIdx = variations.findIndex(v => {
                        const dbName = (v.name || "").toLowerCase().trim().replace(/\s+/g, '');
                        return dbName === targetName;
                    });

                    if (vIdx !== -1) {
                        const rawStok = variations[vIdx].items || []; // Array stok akun
                        
                        if (rawStok.length > 0) {
                            // Ambil stok secukupnya
                            const ambilQty = Math.min(item.qty, rawStok.length);
                            stokDiambil = rawStok.slice(0, ambilQty);
                            
                            // Update sisa stok varian
                            variations[vIdx].items = rawStok.slice(ambilQty);
                            updateTarget = { variations: variations };
                            
                            logs.push(`✅ ${item.name}: Stok Ditemukan (${ambilQty} pcs).`);
                        } else {
                            logs.push(`❌ ${item.name}: Stok Varian KOSONG (0 pcs).`);
                        }
                    } else {
                        // Debugging: Kasih tau admin nama varian gak ketemu
                        logs.push(`❌ ${item.name}: Nama Varian Tidak Cocok di DB.`);
                    }
                } else {
                    // Produk Utama (Non Varian)
                    const rawStok = pData.items || [];
                    
                    if (rawStok.length > 0) {
                        const ambilQty = Math.min(item.qty, rawStok.length);
                        stokDiambil = rawStok.slice(0, ambilQty);
                        updateTarget = { items: rawStok.slice(ambilQty) };
                        logs.push(`✅ ${item.name}: Stok Utama Ditemukan.`);
                    } else {
                        logs.push(`❌ ${item.name}: Stok Utama KOSONG.`);
                    }
                }

                // JIKA STOK KETEMU -> SIMPAN KE ORDER ITEM
                if (stokDiambil.length > 0) {
                    items[i].data = stokDiambil; 
                    items[i].sn = stokDiambil; // Seringkali frontend baca field ini
                    items[i].desc = stokDiambil.join('\n'); // Untuk frontend legacy
                    
                    // Kurangi stok di DB Produk
                    updateTarget.realSold = (pData.realSold || 0) + stokDiambil.length;
                    t.update(pRef, updateTarget);
                }
            }

            // --- KUNCI LOGIKA: FORCE SUCCESS ---
            // Apapun hasilnya (kosong/isi), status harus SUCCESS agar tampil di Web
            t.update(orderRef, { items: items, status: 'success' });

            return { success: true, logs, items };
        });

        return result;

    } catch (e) {
        console.error("Stock Error:", e);
        // Tetap return object agar bot tidak crash
        return { success: false, logs: [`Error System: ${e.message}`], items: [] };
    }
}

/**
 * SEND NOTIFIKASI
 */
async function sendSuccessNotification(chatId, orderId, logs = []) {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if(!snap.exists) return;
        const data = snap.data();
        
        // Format Nomor HP
        let hp = (data.buyerPhone || "").replace(/\D/g,'');
        if(hp.startsWith('0')) hp = '62'+hp.slice(1);
        if(hp.startsWith('8')) hp = '62'+hp;
        
        let msgWA = `Halo Kak, Pesanan *${orderId}*:\n\n`;
        let adaKosong = false;

        data.items.forEach(i => {
            msgWA += `📦 *${i.name}* (x${i.qty})\n`;
            if (i.data && i.data.length > 0) {
                // Tampilkan Data
                msgWA += `${i.data.join('\n')}\n\n`;
            } else {
                msgWA += `_Data sedang disiapkan Admin..._\n\n`;
                adaKosong = true;
            }
        });
        msgWA += `Terima Kasih!`;

        const url = (hp.length > 9) ? `https://wa.me/${hp}?text=${encodeURIComponent(msgWA)}` : `https://wa.me/?text=${encodeURIComponent(msgWA)}`;

        // Pesan ke Admin
        const statusIcon = adaKosong ? "⚠️ PARTIAL/KOSONG" : "✅ LENGKAP";
        let adminMsg = `<b>DONE (AUTO-PROCESS)</b>\nRef: <code>${orderId}</code>\nStatus: ${statusIcon}\n\n`;
        if (logs.length > 0) adminMsg += `Log: ${logs.join('\n')}`;

        const keyboard = [
            [{ text: "📲 Chat WA User", url: url }],
            [{ text: "🛠 REVISI / INPUT MANUAL", callback_data: `REVISI_${orderId}` }]
        ];

        await sendMessage(chatId, adminMsg, { reply_markup: { inline_keyboard: keyboard } });
    } catch(e) { console.error(e); }
}

async function showManualInputMenu(chatId, orderId, items) {
    let msg = `🛠 <b>MENU REVISI MANUAL</b>\nRef: ${orderId}\n\nKlik item yang mau diisi/diedit:`;
    const kb = [];
    items.forEach((item, i) => {
        const status = (item.data && item.data.length > 0) ? '✅' : '❌';
        kb.push([{ text: `${status} ${item.name.slice(0,15)}...`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "❌ Tutup Menu", callback_data: `CLOSE_MENU` }]); 
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
