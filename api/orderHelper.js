const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * FUNGSI BANTUAN: MATA ELANG (Cari Stok dimanapun dia bersembunyi)
 * Bot akan mengecek field: items, data, accounts, codes, stokList.
 */
function findStockInObject(obj) {
    if (!obj) return [];
    if (Array.isArray(obj.items) && obj.items.length > 0) return obj.items;
    if (Array.isArray(obj.data) && obj.data.length > 0) return obj.data;
    if (Array.isArray(obj.accounts) && obj.accounts.length > 0) return obj.accounts;
    if (Array.isArray(obj.codes) && obj.codes.length > 0) return obj.codes;
    if (Array.isArray(obj.stok) && obj.stok.length > 0) return obj.stok;
    return [];
}

/**
 * FUNGSI BANTUAN: NORMALISASI TEKS
 * Menghapus spasi ganda, spasi pinggir, dan huruf besar/kecil.
 */
function normalize(str) {
    return (str || "").toString().toLowerCase().trim().replace(/\s+/g, '');
}

async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);

    try {
        const result = await db.runTransaction(async (t) => {
            const orderDoc = await t.get(orderRef);
            if (!orderDoc.exists) return { success: false, logs: ["ID Not Found"], items: [] };
            
            const orderData = orderDoc.data();
            let items = orderData.items || [];
            let logs = [];
            
            for (let i = 0; i < items.length; i++) {
                // Skip item yang sudah ada isinya
                if (items[i].data && items[i].data.length > 0) continue;

                const item = items[i];
                const pid = item.isVariant ? item.originalId : item.id;
                
                const pRef = db.collection('products').doc(pid);
                const pDoc = await t.get(pRef);

                if (!pDoc.exists) {
                    logs.push(`⚠️ ${item.name}: Produk induk HILANG dari DB.`);
                    continue; 
                }

                const pData = pDoc.data();
                
                // Cek Mode Manual Admin
                if (pData.processType === 'MANUAL') {
                    logs.push(`ℹ️ ${item.name}: Mode Manual (Sesuai Setting DB).`);
                    continue;
                }

                let stokDiambil = [];
                let sisaStok = [];
                let targetField = ""; // Untuk tau field mana yang diupdate (items/accounts/dll)
                
                // --- KASUS 1: ITEM VARIASI ---
                if (item.isVariant) {
                    const targetName = normalize(item.variantName);
                    const variations = pData.variations || [];
                    
                    // CARI VARIAN YANG COCOK
                    const vIdx = variations.findIndex(v => normalize(v.name) === targetName);

                    if (vIdx !== -1) {
                        // Varian ketemu, sekarang cari stoknya pakai "Mata Elang"
                        const rawStok = findStockInObject(variations[vIdx]);
                        
                        if (rawStok.length > 0) {
                            const ambilQty = Math.min(item.qty, rawStok.length);
                            stokDiambil = rawStok.slice(0, ambilQty);
                            sisaStok = rawStok.slice(ambilQty);
                            
                            // Update object variation di memory
                            // Kita harus tau nama field aslinya agar update DB benar
                            if(variations[vIdx].items) variations[vIdx].items = sisaStok;
                            else if(variations[vIdx].data) variations[vIdx].data = sisaStok;
                            else if(variations[vIdx].accounts) variations[vIdx].accounts = sisaStok;
                            else variations[vIdx].items = sisaStok; // Default fallback

                            // Target update Transaction
                            targetField = "variations"; 
                            logs.push(`✅ ${item.name}: Stok Varian OK.`);
                        } else {
                            logs.push(`❌ ${item.name}: Varian Ketemu, TAPI STOK KOSONG (0).`);
                        }
                    } else {
                        // Debugging Canggih: Kasih tau admin varian apa aja yang ada di DB
                        const listVarianDB = variations.map(v => v.name).join(', ');
                        logs.push(`❌ ${item.name}: GAK COCOK. Order: "${item.variantName}". DB punya: [${listVarianDB}]`);
                    }
                } 
                
                // --- KASUS 2: ITEM UTAMA (NON VARIAN) ---
                else {
                    const rawStok = findStockInObject(pData);
                    
                    if (rawStok.length > 0) {
                        const ambilQty = Math.min(item.qty, rawStok.length);
                        stokDiambil = rawStok.slice(0, ambilQty);
                        sisaStok = rawStok.slice(ambilQty);
                        
                        // Tentukan field mana yang mau diupdate di DB
                        if(pData.items) targetField = "items";
                        else if(pData.data) targetField = "data";
                        else if(pData.accounts) targetField = "accounts";
                        else targetField = "items";

                        logs.push(`✅ ${item.name}: Stok Utama OK.`);
                    } else {
                        logs.push(`❌ ${item.name}: Stok Utama KOSONG/Tidak Ditemukan.`);
                    }
                }

                // --- EKSEKUSI SIMPAN DATA ---
                if (stokDiambil.length > 0) {
                    // Masukkan ke Order Item
                    items[i].data = stokDiambil; 
                    items[i].sn = stokDiambil; 
                    items[i].desc = stokDiambil.join('\n'); // Format string
                    items[i].processTime = new Date().toISOString();

                    // Update Produk DB
                    let updateDoc = { realSold: (pData.realSold || 0) + stokDiambil.length };
                    
                    if (item.isVariant) {
                        updateDoc.variations = pData.variations; // Update seluruh array variasi
                    } else {
                        updateDoc[targetField] = sisaStok; // Update field (items/accounts/dll)
                    }
                    
                    t.update(pRef, updateDoc);
                }
            }

            // --- FORCE STATUS SUCCESS ---
            // Agar web menampilkan data (entah kosong atau isi)
            t.update(orderRef, { items: items, status: 'success' });

            return { success: true, logs, items };
        });

        return result;

    } catch (e) {
        console.error("Stock Error:", e);
        return { success: false, logs: [`🔥 ERR: ${e.message}`], items: [] };
    }
}

async function sendSuccessNotification(chatId, orderId, logs = []) {
    try {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return;
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
                msgWA += `${i.data.join('\n')}\n\n`;
            } else {
                msgWA += `_Proses Input Manual..._\n\n`;
                adaKosong = true;
            }
        });
        msgWA += `Terima Kasih!`;

        const url = (hp.length > 9) ? `https://wa.me/${hp}?text=${encodeURIComponent(msgWA)}` : `https://wa.me/?text=${encodeURIComponent(msgWA)}`;

        // LOGIKA DEBUG DI CHAT ADMIN
        const statusIcon = adaKosong ? "⚠️ PARTIAL" : "✅ LENGKAP";
        let adminMsg = `<b>DONE</b>\nRef: <code>${orderId}</code>\nStatus: ${statusIcon}\n\n`;
        
        // Tampilkan Log Error Stok secara detail supaya tidak bingung
        if (logs.length > 0) {
            // Filter log yang error saja biar gak penuh
            const errLogs = logs.filter(l => l.includes('❌') || l.includes('⚠️'));
            if(errLogs.length > 0) adminMsg += `<b>Log Masalah:</b>\n${errLogs.join('\n')}\n`;
        }

        const keyboard = [
            [{ text: "📲 Chat WA User", url: url }],
            [{ text: "🛠 REVISI / INPUT MANUAL", callback_data: `REVISI_${orderId}` }]
        ];

        await sendMessage(chatId, adminMsg, { reply_markup: { inline_keyboard: keyboard } });
    } catch(e) { console.error(e); }
}

async function showManualInputMenu(chatId, orderId, items) {
    let msg = `🛠 <b>MENU REVISI MANUAL</b>\nRef: ${orderId}\n\nKlik item untuk edit:`;
    const kb = [];
    items.forEach((item, i) => {
        const status = (item.data && item.data.length > 0) ? '✅' : '❌';
        kb.push([{ text: `${status} ${item.name.slice(0,20)}`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "❌ Tutup Menu", callback_data: `CLOSE_MENU` }]); 
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

module.exports = { processOrderStock, sendSuccessNotification, showManualInputMenu };
