const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * LOGIKA UTAMA: HANDLING WEBHOOK TELEGRAM
 */
module.exports = async function(req, res) {
    const update = req.body;

    try {
        // ============================================================
        // 1. HANDLE KLIK TOMBOL (CALLBACK QUERY)
        // ============================================================
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            // --- A. TOMBOL ACC (PROSES OTOMATIS -> MANUAL FALLBACK) ---
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                
                // 1. Beri Tahu Admin Sedang Bekerja
                await sendMessage(chatId, `⚙️ <b>[STATUS]</b> Memproses Order ${orderId}...\nMencari stok di database...`);

                // 2. Jalankan Logika Cek Stok
                const result = await processOrderStock(orderId);

                // 3. Feedback ke Telegram Berdasarkan Hasil
                if (result.success) {
                    // Jika stok ketemu otomatis
                    await sendMessage(chatId, `✅ <b>[SUKSES]</b> Order ${orderId} berhasil diproses otomatis!\nData sudah tampil di Web User.\n\n${result.logs.join('\n')}`);
                    await sendWALink(chatId, orderId); 
                } else {
                    // Jika stok kosong / perlu manual
                    await sendMessage(chatId, `⚠️ <b>[PENDING]</b> Stok Otomatis Kosong/Gagal.\n${result.logs.join('\n')}\n\nSilakan input manual di bawah ini:`);
                    await showManualInputMenu(chatId, orderId, result.items);
                }
            }

            // --- B. TOMBOL FILL (INPUT MANUAL PER ITEM) ---
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                const itemName = parts[3] || "Item";

                // PENTING: Format Prompt yang JELAS agar terbaca Regex nanti
                const promptText = `✍️ <b>INPUT DATA MANUAL</b>\n\nSilakan Reply pesan ini dengan data akun/voucher/kode.\nBisa tulis berbaris (Enter) untuk banyak data.\n\n-------- JANGAN HAPUS BAWAH INI --------\nRefID: ${orderId}\nIdx: ${itemIdx}\nItem: ${itemName}`;
                
                await sendMessage(chatId, promptText, { reply_markup: { force_reply: true } });
            }

            // --- C. TOMBOL DONE (PAKSA SELESAI) ---
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendMessage(chatId, `✅ <b>[FORCED]</b> Order ${orderId} ditandai SUKSES oleh Admin.`);
                await sendWALink(chatId, orderId);
            }

            // --- D. TOMBOL BALAS KOMPLAIN ---
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                const promptText = `💬 <b>BALAS KOMPLAIN</b>\n\nSilakan tulis pesan balasan untuk pembeli.\n\n-------- JANGAN HAPUS BAWAH INI --------\nRefID: ${orderId}\nType: COMPLAINT_REPLY`;
                
                await sendMessage(chatId, promptText, { reply_markup: { force_reply: true } });
            }

            return res.status(200).send('ok');
        }

        // ============================================================
        // 2. HANDLE REPLY PESAN (INPUT TEKS DARI ADMIN)
        // ============================================================
        if (update.message && update.message.reply_to_message) {
            const textAdmin = update.message.text; // Jawaban Admin
            const replyOrigin = update.message.reply_to_message.text || ""; // Soal dari Bot
            const chatId = update.message.chat.id;

            // --- LOGIKA PARSING (Membaca RefID dari pesan bot sebelumnya) ---
            // Kita cari string "RefID: XXXXX" di pesan origin
            const idMatch = replyOrigin.match(/RefID:\s*([A-Za-z0-9-]+)/);
            
            if (!idMatch) {
                // Jika admin reply pesan sembarangan
                return res.status(200).send('ok');
            }

            const orderId = idMatch[1];

            // --- A. JIKA INI INPUT DATA BARANG (FILL) ---
            const idxMatch = replyOrigin.match(/Idx:\s*(\d+)/);
            if (idxMatch) {
                const itemIdx = parseInt(idxMatch[1]);
                
                await sendMessage(chatId, `🔄 <b>[PROSES]</b> Menyimpan data ke Web...`);

                // 1. Split Text jadi Array (Wajib buat App.jsx)
                const dataArray = textAdmin.split('\n').filter(x => x.trim());

                // 2. Update Database
                await db.runTransaction(async (t) => {
                    const docRef = db.collection('orders').doc(orderId);
                    const docSnap = await t.get(docRef);
                    if (!docSnap.exists) throw "Order Hilang";

                    const items = docSnap.data().items;
                    if (items[itemIdx]) {
                        items[itemIdx].data = dataArray; // Masuk ke Web
                        items[itemIdx].sn = dataArray;   // Backup
                        items[itemIdx].note = `Manual: ${new Date().toLocaleTimeString()}`; 
                    }

                    // Cek apakah semua item sudah diisi?
                    const allFilled = items.every(i => (i.data && Array.isArray(i.data) && i.data.length > 0));
                    const finalStatus = allFilled ? 'success' : 'processing';

                    t.update(docRef, { items: items, status: finalStatus });
                    return { allFilled, itemName: items[itemIdx].name };
                });

                await sendMessage(chatId, `✅ <b>[TERSIMPAN]</b> Data untuk ${orderId} index ${itemIdx} masuk.`);

                // Cek ulang apakah order sudah selesai semua?
                const finalCheck = await db.collection('orders').doc(orderId).get();
                if (finalCheck.data().status === 'success') {
                    await sendWALink(chatId, orderId);
                } else {
                    // Jika belum selesai (masih ada item lain yg kosong), tampilkan menu lagi
                    await showManualInputMenu(chatId, orderId, finalCheck.data().items);
                }
            }

            // --- B. JIKA INI BALASAN KOMPLAIN ---
            else if (replyOrigin.includes('Type: COMPLAINT_REPLY')) {
                await db.collection('orders').doc(orderId).update({
                    complaintReply: textAdmin,
                    hasNewReply: true
                });
                await sendMessage(chatId, `✅ <b>[TERKIRIM]</b> Balasan komplain masuk ke Web User (Order: ${orderId}).`);
            }
        }

    } catch (e) {
        console.error("WEBHOOK ERROR:", e);
        if(req.body.message) {
             sendMessage(req.body.message.chat.id, `❌ <b>SYSTEM ERROR:</b> ${e.message}`);
        }
    }
    return res.status(200).send('ok');
};


// ============================================================
// FUNGSI LOGIKA (CORE LOGIC) - AGAR RAPI & CERDAS
// ============================================================

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
            // Skip jika data sudah ada
            if (items[i].data && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.isVariant ? item.originalId : item.id;
            
            // Ambil Produk Induk
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);

            // Cek 1: Apakah Produk Ada?
            if (!pDoc.exists) {
                logs.push(`⚠️ ${item.name}: Produk induk dihapus/hilang.`);
                needManual = true; continue;
            }

            const pData = pDoc.data();

            // Cek 2: Apakah Produk MANUAL Settingan-nya?
            if (pData.isManual || pData.processType === 'MANUAL') {
                logs.push(`⚠️ ${item.name}: Settingan Produk = Manual.`);
                needManual = true; continue;
            }

            // Cek 3: Logika Stok (Varian vs Utama)
            let stokDiambil = [];
            let updateTarget = {};

            if (item.isVariant) {
                // Cari di Variasi
                const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                if (vIdx !== -1) {
                    const stokVarian = pData.variations[vIdx].items || [];
                    if (stokVarian.length >= item.qty) {
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty); // Sisa stok
                        updateTarget = { variations: pData.variations };
                        logs.push(`✅ ${item.name}: Ambil dari Varian.`);
                    } else {
                        logs.push(`❌ ${item.name}: Stok Varian KURANG.`);
                        needManual = true;
                    }
                } else {
                    logs.push(`❌ ${item.name}: Nama Varian tidak cocok.`);
                    needManual = true;
                }
            } else {
                // Cari di Utama
                const stokUtama = pData.items || [];
                if (stokUtama.length >= item.qty) {
                    stokDiambil = stokUtama.slice(0, item.qty);
                    updateTarget = { items: stokUtama.slice(item.qty) };
                    logs.push(`✅ ${item.name}: Ambil dari Stok Utama.`);
                } else {
                    logs.push(`❌ ${item.name}: Stok Utama HABIS.`);
                    needManual = true;
                }
            }

            // Jika Stok Ketemu -> Simpan ke Item Order
            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil;
                
                // Update Stok Produk di DB
                updateTarget.realSold = (pData.realSold || 0) + item.qty;
                t.update(pRef, updateTarget);
            }
        }

        // Tentukan Status Akhir Order
        // Success = muncul di web user
        // Processing = user liat "Menunggu Admin"
        const finalStatus = needManual ? 'processing' : 'success';
        
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items };
    });
}

// Fungsi Menampilkan Menu Input Manual (Jika Stok Kosong)
async function showManualInputMenu(chatId, orderId, items) {
    let msg = `📋 <b>MANUAL INPUT DIPERLUKAN</b>\nOrder ID: ${orderId}\n\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `${i+1}. ${item.name} [${ready ? '✅ TERISI' : '❌ KOSONG'}]\n`;
        
        if (!ready) {
            // Nama item disertakan di callback data agar nanti di prompt muncul
            // Tapi hati2 max panjang callback data 64 bytes. Kita pakai index saja aman.
            // Kita kirim nama item lewat split nanti di FILL handler
            const safeName = item.name.substring(0, 10); 
            kb.push([{ text: `✏️ ISI: ${item.name}`, callback_data: `FILL_${orderId}_${i}_${safeName}` }]);
        }
    });

    kb.push([{ text: "🚀 SELESAI & KIRIM NOTIF WA", callback_data: `DONE_${orderId}` }]);
    
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

// Fungsi Kirim Link WA
async function sendWALink(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    let hp = data.phoneNumber || "";
    // Cari nomor di note jika kosong
    if ((!hp || hp.length < 5) && data.items[0]?.note) {
        const num = data.items[0].note.replace(/\D/g, '');
        if (num.length > 9) hp = num;
    }
    hp = hp.replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);

    let msg = `Halo, Pesanan *${orderId}* Selesai!\n\n`;
    data.items.forEach(i => {
        msg += `📦 ${i.name}\n`;
        if(i.data && Array.isArray(i.data)) msg += `${i.data.join('\n')}\n\n`;
        else msg += `-\n\n`;
    });
    msg += `Terima Kasih!`;

    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    
    await sendMessage(chatId, `✅ <b>ORDER SELESAI SEMPURNA!</b>\nStatus Web: Success.\nKlik tombol di bawah untuk kirim ke WA Pembeli:`, { 
        reply_markup: { inline_keyboard: [[{ text: "📲 Chat WA Pembeli", url: url }]] } 
    });
}
