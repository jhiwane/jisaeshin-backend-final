const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * FUNGSI PENCARI STOK "SAPU JAGAT" (UNIVERSAL)
 * Bot tidak lagi peduli nama fieldnya 'items' atau 'data'.
 * Dia akan mengambil ARRAY PERTAMA yang dia temukan di dalam objek.
 */
function grabAnyStockArray(obj) {
    if (!obj) return [];
    
    // 1. Prioritas Utama: Field standar
    if (Array.isArray(obj.items) && obj.items.length > 0) return obj.items;
    if (Array.isArray(obj.data) && obj.data.length > 0) return obj.data;
    if (Array.isArray(obj.accounts) && obj.accounts.length > 0) return obj.accounts;
    if (Array.isArray(obj.codes) && obj.codes.length > 0) return obj.codes;
    if (Array.isArray(obj.stok) && obj.stok.length > 0) return obj.stok;

    // 2. Prioritas Darurat: Cari field APAPUN yang isinya Array dan bukan 'variations'
    const keys = Object.keys(obj);
    for (const key of keys) {
        // Skip field 'variations' supaya tidak rekursif aneh
        if (key === 'variations') continue; 
        
        const val = obj[key];
        // Jika ketemu Array dan ada isinya, AMBIL!
        if (Array.isArray(val) && val.length > 0) {
            console.log(`[DEBUG] Menemukan stok di field tidak dikenal: '${key}'`);
            return val;
        }
    }

    return [];
}

/**
 * Normalisasi String (Hapus spasi, lowercase)
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
                // Skip jika item ini SUDAH TERISI
                if (items[i].data && items[i].data.length > 0) continue;

                const item = items[i];
                const pid = item.isVariant ? item.originalId : item.id;
                
                // Ambil Produk Master
                const pRef = db.collection('products').doc(pid);
                const pDoc = await t.get(pRef);

                if (!pDoc.exists) {
                    logs.push(`⚠️ ${item.name}: Produk induk HILANG (ID: ${pid}).`);
                    continue; 
                }

                const pData = pDoc.data();
                
                // LOG DEBUG: Tampilkan isi produk di console server biar tau strukturnya
                console.log(`[CHECKING] ${item.name} | Variant: ${item.isVariant ? 'YES' : 'NO'}`);

                if (pData.processType === 'MANUAL') {
                    logs.push(`ℹ️ ${item.name}: Mode Manual Admin.`);
                    continue;
                }

                let stokDiambil = [];
                let sisaStok = [];
                let targetLocation = null; // Object referensi (variasi atau main product)
                let targetField = ""; // Nama field yang akan diupdate
                
                // --- KASUS 1: ITEM VARIASI ---
                if (item.isVariant) {
                    const targetName = normalize(item.variantName);
                    const variations = pData.variations || [];
                    
                    // Cari Variasi (Fuzzy Match)
                    const vIdx = variations.findIndex(v => normalize(v.name) === targetName);

                    if (vIdx !== -1) {
                        // Variasi Ketemu. Sekarang BONGKAR isinya cari Array
                        const rawStok = grabAnyStockArray(variations[vIdx]);
                        
                        if (rawStok.length > 0) {
                            const ambilQty = Math.min(item.qty, rawStok.length);
                            stokDiambil = rawStok.slice(0, ambilQty);
                            sisaStok = rawStok.slice(ambilQty);

                            // Update Memory
                            // Kita harus cari tau field mana yang diambil tadi
                            // Trik: Timpa field 'items' standar atau cari field aslinya
                            // Untuk aman: Kita cari lagi field mana yang punya array ini
                            let foundKey = 'items'; // default
                            for(const k of Object.keys(variations[vIdx])) {
                                if(variations[vIdx][k] === rawStok) foundKey = k;
                            }
                            
                            variations[vIdx][foundKey] = sisaStok;
                            
                            // Siapkan Update DB
                            targetLocation = "variations";
                            logs.push(`✅ ${item.name}: Stok Varian OK (Field: ${foundKey}).`);
                        } else {
                            // Cek apakah mungkin user salah taruh stok di produk utama?
                            const backupStok = grabAnyStockArray(pData);
                            if(backupStok.length > 0) {
                                logs.push(`⚠️ ${item.name}: Stok Varian Kosong, tapi ada di Utama. (Tidak diambil demi keamanan).`);
                            }
                            logs.push(`❌ ${item.name}: Varian Ketemu, TAPI KOSONG/ARRAY TIDAK DITEMUKAN.`);
                            console.log("Structure Varian yg Gagal:", JSON.stringify(variations[vIdx]));
                        }
                    } else {
                         // Debug: Print semua nama varian yang ada
                        const listVarian = variations.map(v => v.name).join(', ');
                        logs.push(`❌ ${item.name}: Nama Varian SALAH. Order: "${item.variantName}". DB: [${listVarian}]`);
                    }
                } 
                
                // --- KASUS 2: ITEM UTAMA (NON VARIAN) ---
                else {
                    const rawStok = grabAnyStockArray(pData);
                    
                    if (rawStok.length > 0) {
                        const ambilQty = Math.min(item.qty, rawStok.length);
                        stokDiambil = rawStok.slice(0, ambilQty);
                        sisaStok = rawStok.slice(ambilQty);
                        
                        // Cari nama field aslinya
                        let foundKey = 'items';
                        for(const k of Object.keys(pData)) {
                             // Hati2 jangan ambil 'variations'
                            if(k !== 'variations' && pData[k] === rawStok) foundKey = k;
                        }

                        targetLocation = "main";
                        targetField = foundKey;
                        logs.push(`✅ ${item.name}: Stok Utama OK (Field: ${foundKey}).`);
                    } else {
                        logs.push(`❌ ${item.name}: Stok Utama KOSONG.`);
                    }
                }

                // --- EKSEKUSI SIMPAN DATA ---
                if (stokDiambil.length > 0) {
                    // Update Order Item
                    items[i].data = stokDiambil; 
                    items[i].sn = stokDiambil; // Field SN diisi
                    items[i].desc = stokDiambil.join('\n'); // Field Desc diisi (utk web legacy)
                    
                    // Update DB Produk
                    let updateDoc = { realSold: (pData.realSold || 0) + stokDiambil.length };
                    
                    if (targetLocation === "variations") {
                        updateDoc.variations = pData.variations;
                    } else if (targetLocation === "main") {
                        updateDoc[targetField] = sisaStok;
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
        let adminMsg = `<b>DONE (AUTO)</b>\nRef: <code>${orderId}</code>\nStatus: ${statusIcon}\n\n`;
        
        // Filter log error biar admin tau kenapa
        const errLogs = logs.filter(l => l.includes('❌') || l.includes('⚠️'));
        if (errLogs.length > 0) adminMsg += `<b>Log:</b>\n${errLogs.join('\n')}`;

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
