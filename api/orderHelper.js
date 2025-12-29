const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * LOGIKA INTELIJEN PENCARI STOK (DEEP SEARCH)
 * - Mencari di item utama & variasi.
 * - Mengembalikan status sukses agar Web langsung update.
 */
async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);

    try {
        const result = await db.runTransaction(async (t) => {
            const orderDoc = await t.get(orderRef);
            if (!orderDoc.exists) return { success: false, logs: ["ID Not Found"] };
            
            const orderData = orderDoc.data();
            let items = orderData.items || [];
            let logs = [];
            
            // Loop Item
            for (let i = 0; i < items.length; i++) {
                // Skip jika data sudah terisi (revisi partial)
                if (items[i].data && items[i].data.length > 0) continue;

                const item = items[i];
                const pid = item.isVariant ? item.originalId : item.id;
                
                const pRef = db.collection('products').doc(pid);
                const pDoc = await t.get(pRef);

                if (!pDoc.exists) {
                    logs.push(`⚠️ ${item.name}: Produk induk hilang.`);
                    continue; 
                }

                const pData = pDoc.data();
                // Jika manual murni, skip (biarkan kosong utk diisi admin nanti)
                if (pData.processType === 'MANUAL') {
                    logs.push(`ℹ️ ${item.name}: Mode Manual Admin.`);
                    continue;
                }

                let stokDiambil = [];
                let updateTarget = {};

                // --- LOGIKA DEEP SEARCH (UTAMA & VARIASI) ---
                if (item.isVariant) {
                    // Cari variasi yang cocok
                    const vIdx = pData.variations ? pData.variations.findIndex(v => 
                        v.name.trim().toLowerCase() === item.variantName.trim().toLowerCase()
                    ) : -1;

                    if (vIdx !== -1) {
                        const rawStok = pData.variations[vIdx].items || [];
                        // Ambil sesuai Qty (Kalau kurang, ambil semua yg ada)
                        const ambilQty = Math.min(item.qty, rawStok.length);
                        
                        if (ambilQty > 0) {
                            stokDiambil = rawStok.slice(0, ambilQty);
                            pData.variations[vIdx].items = rawStok.slice(ambilQty); // Sisanya
                            updateTarget = { variations: pData.variations };
                            logs.push(`✅ ${item.name}: Dapat ${ambilQty} item.`);
                        } else {
                            logs.push(`❌ ${item.name}: Stok Varian Kosong.`);
                        }
                    }
                } else {
                    // Produk Utama
                    const rawStok = pData.items || [];
                    const ambilQty = Math.min(item.qty, rawStok.length);

                    if (ambilQty > 0) {
                        stokDiambil = rawStok.slice(0, ambilQty);
                        updateTarget = { items: rawStok.slice(ambilQty) };
                        logs.push(`✅ ${item.name}: Dapat ${ambilQty} item.`);
                    } else {
                        logs.push(`❌ ${item.name}: Stok Utama Kosong.`);
                    }
                }

                // Simpan Stok ke Item Order
                if (stokDiambil.length > 0) {
                    items[i].data = stokDiambil; 
                    items[i].sn = stokDiambil;
                    
                    // Update Stok Database Produk
                    updateTarget.realSold = (pData.realSold || 0) + stokDiambil.length;
                    t.update(pRef, updateTarget);
                }
            }

            // --- POINT PENTING: ALWAYS SUCCESS ---
            // Kita set status 'success' agar Web user langsung tampil (entah isinya ada atau kosong)
            t.update(orderRef, { items: items, status: 'success' });

            return { success: true, logs, items };
        });

        return result;

    } catch (e) {
        console.error("Stock Error:", e);
        return { success: false, logs: [e.message], items: [] };
    }
}

/**
 * KIRIM NOTIFIKASI FINAL (Done ✅)
 * Menampilkan Link WA dan Tombol Revisi
 */
async function sendSuccessNotification(chatId, orderId, logs = []) {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    // Format Nomor HP
    let hp = (data.buyerPhone || "").replace(/\D/g,'');
    if(hp.startsWith('0')) hp = '62'+hp.slice(1);
    if(hp.startsWith('8')) hp = '62'+hp;
    if(hp.length < 10) hp = "";

    // Cek Kelengkapan Data untuk Pesan WA
    let msgWA = `Halo Kak, Pesanan *${orderId}*:\n\n`;
    let adaKosong = false;

    data.items.forEach(i => {
        msgWA += `📦 *${i.name}* (x${i.qty})\n`;
        if (i.data && i.data.length > 0) {
            msgWA += `${i.data.join('\n')}\n\n`;
        } else {
            msgWA += `_DATA BELUM MUNCUL (Silakan Refresh/Hub Admin)_\n\n`;
            adaKosong = true;
        }
    });
    msgWA += `Terima Kasih!`;

    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(msgWA)}` : `https://wa.me/?text=${encodeURIComponent(msgWA)}`;

    // --- PESAN LAPORAN ADMIN (DONE ✅) ---
    const statusIcon = adaKosong ? "⚠️ PARTIAL/KOSONG" : "✅ LENGKAP";
    let adminMsg = `<b>DONE</b> ✅\nID: <code>${orderId}</code>\nStatus: ${statusIcon}\n\n`;
    
    // Jika ada log error/kosong, tampilkan sedikit
    if (logs.length > 0) adminMsg += `Log: ${logs.join(', ')}\n`;
    
    adminMsg += `\n<i>Data sudah tampil di Web (Status: Success).</i>`;

    const keyboard = [
        [{ text: "📲 Chat WA User", url: url }],
        // Tombol ini SELALU ADA untuk revisi/input manual kapan saja
        [{ text: "🛠 REVISI / INPUT MANUAL", callback_data: `REVISI_${orderId}` }]
    ];

    await sendMessage(chatId, adminMsg, { reply_markup: { inline_keyboard: keyboard } });
}

// Fungsi Menu Input Manual (Tetap diperlukan untuk tombol REVISI)
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `🛠 <b>REVISI / INPUT DATA</b>\nRef: ${orderId}\n\nKlik item untuk edit:`;
    const kb = [];
    items.forEach((item, i) => {
        const status = (item.data && item.data.length > 0) ? '✅' : '❌';
        kb.push([{ text: `${status} ${item.name}`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    // Tombol Done untuk menutup menu
    kb.push([{ text: "Selesai (Tutup Menu)", callback_data: `CLOSE_MENU` }]); 
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
