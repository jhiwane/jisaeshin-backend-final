const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

module.exports = async function(req, res) {
    const update = req.body;

    try {
        // ============================================================
        // A. HANDLE TOMBOL (CALLBACK QUERY)
        // ============================================================
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; // Contoh: ACC_TRX-12345
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            // ------------------------------------------------------------
            // 1. TOMBOL ACC (Verifikasi Pembayaran & Proses Stok)
            // ------------------------------------------------------------
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ <b>Memproses Order ${orderId}...</b>\nMohon tunggu sistem mengecek stok otomatis.`);

                const orderRef = db.collection('orders').doc(orderId);

                // Jalankan Transaksi Database (Agar aman & tidak bentrok)
                const result = await db.runTransaction(async (t) => {
                    const orderDoc = await t.get(orderRef);
                    if (!orderDoc.exists) throw new Error("Order hilang!");

                    const orderData = orderDoc.data();
                    let items = orderData.items;
                    let logs = [];
                    let needManualInput = false;

                    // 1. Ubah status jadi PAID dulu (Supaya user tau pembayaran diterima)
                    let newStatus = 'paid';

                    // 2. Loop setiap item untuk cek apakah bisa otomatis
                    for (let i = 0; i < items.length; i++) {
                        // Skip jika data sudah terisi sebelumnya
                        if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

                        const item = items[i];
                        
                        // Cek Product di DB
                        const pid = item.isVariant ? item.originalId : item.id;
                        const pRef = db.collection('products').doc(pid);
                        const pDoc = await t.get(pRef);

                        // --- SKENARIO 1: PRODUK MANUAL / JOKI ---
                        // Jika produk disetting Manual di DB, atau Tipe Proses Manual
                        if (!pDoc.exists || pDoc.data().isManual || pDoc.data().processType === 'MANUAL') {
                            logs.push(`⚠️ <b>${item.name}</b>: Menunggu Input Manual Admin.`);
                            needManualInput = true;
                            continue; // Lanjut ke item berikutnya
                        }

                        // --- SKENARIO 2: PRODUK OTOMATIS (CEK STOK) ---
                        const pData = pDoc.data();
                        let stokDiambil = [];
                        let updateTarget = {};

                        // Logic Stok (Varian vs Utama)
                        if (item.isVariant) {
                            const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                            if (vIdx !== -1) {
                                const stokVarian = pData.variations[vIdx].items || [];
                                if (stokVarian.length >= item.qty) {
                                    stokDiambil = stokVarian.slice(0, item.qty);
                                    pData.variations[vIdx].items = stokVarian.slice(item.qty);
                                    updateTarget = { variations: pData.variations };
                                    logs.push(`✅ <b>${item.name}</b>: Stok Varian Terkirim.`);
                                } else {
                                    logs.push(`❌ <b>${item.name}</b>: Stok Varian KURANG (Perlu Manual).`);
                                    needManualInput = true;
                                }
                            }
                        } else {
                            const stokUtama = pData.items || [];
                            if (stokUtama.length >= item.qty) {
                                stokDiambil = stokUtama.slice(0, item.qty);
                                updateTarget = { items: stokUtama.slice(item.qty) };
                                logs.push(`✅ <b>${item.name}</b>: Stok Utama Terkirim.`);
                            } else {
                                logs.push(`❌ <b>${item.name}</b>: Stok Utama KOSONG (Perlu Manual).`);
                                needManualInput = true;
                            }
                        }

                        // Jika Stok Ditemukan -> Update Item & DB Produk
                        if (stokDiambil.length > 0) {
                            items[i].data = stokDiambil; // ARRAY PENTING UTK APP.JSX
                            items[i].sn = stokDiambil;   // Backup legacy
                            
                            // Tambah Counter Terjual
                            updateTarget.realSold = (pData.realSold || 0) + item.qty;
                            t.update(pRef, updateTarget);
                        }
                    }

                    // 3. Tentukan Status Akhir
                    // Jika tidak butuh manual, berarti semua sukses -> 'success'
                    // Jika butuh manual -> 'processing' (User lihat: Menunggu Proses Admin)
                    const finalStatus = needManualInput ? 'processing' : 'success';
                    
                    t.update(orderRef, { 
                        items: items, 
                        status: finalStatus,
                        // Reset admin message biar bersih
                        adminMessage: needManualInput ? 'Pembayaran diterima. Sedang menyiapkan pesanan.' : 'Pesanan selesai.' 
                    });

                    return { logs, needManualInput, items };
                });

                // --- POST TRANSACTION: KIRIM LAPORAN KE TELEGRAM ---
                const reportMsg = `<b>[ACC] LAPORAN PROSES ${orderId}</b>\n\n${result.logs.join('\n')}\n\nStatus: <b>${result.needManualInput ? 'BUTUH INPUT MANUAL' : 'SELESAI OTOMATIS'}</b>`;
                await sendMessage(chatId, reportMsg);

                // Jika butuh manual, tampilkan Menu Edit
                if (result.needManualInput) {
                    await showItemEditor(chatId, orderId, result.items);
                } else {
                    // Jika selesai otomatis, kirim link WA
                    await sendSuccessNotification(chatId, orderId);
                }
            }

            // ------------------------------------------------------------
            // 2. TOMBOL FILL (Admin Mau Isi Data Manual)
            // ------------------------------------------------------------
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                
                // Secret Code untuk Reply Listener
                const secret = `DATA|${orderId}|${itemIdx}`;
                
                await sendMessage(chatId, `✍️ <b>INPUT DATA MANUAL</b>\n\nSilahkan Reply pesan ini dengan data (Akun/Kode).\nBisa multi-line (Enter) untuk banyak data.`, { reply_markup: { force_reply: true } });
                // Hidden metadata utk bot mengenali reply
                await sendMessage(chatId, `<span class="tg-spoiler">${secret}</span>`, { parse_mode: 'HTML' });
            }

            // ------------------------------------------------------------
            // 3. TOMBOL DONE (Paksa Selesai)
            // ------------------------------------------------------------
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendMessage(chatId, `✅ Order ${orderId} ditandai SUKSES secara manual.`);
                await sendSuccessNotification(chatId, orderId);
            }

            // ------------------------------------------------------------
            // 4. REPLY KOMPLAIN (Fitur Lapor Masalah)
            // ------------------------------------------------------------
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                const secret = `COMPLAINT|${orderId}`;
                await sendMessage(chatId, `💬 <b>BALAS KOMPLAIN ${orderId}</b>\n\nSilahkan Reply pesan ini dengan jawaban/solusi untuk user.`, { reply_markup: { force_reply: true } });
                await sendMessage(chatId, `<span class="tg-spoiler">${secret}</span>`, { parse_mode: 'HTML' });
            }

            return res.status(200).send('ok');
        }

        // ============================================================
        // B. HANDLE REPLY PESAN (TEXT INPUT ADMIN)
        // ============================================================
        if (update.message && update.message.reply_to_message) {
            const text = update.message.text;
            const replyOrigin = update.message.reply_to_message.text || "";
            const chatId = update.message.chat.id;

            // Regex untuk menangkap Metadata yang kita sembunyikan di spoiler/text
            // Format: DATA|OrderID|ItemIndex
            let matchData = replyOrigin.match(/DATA\|([A-Za-z0-9-]+)\|(\d+)/);
            // Format: COMPLAINT|OrderID
            let matchComp = replyOrigin.match(/COMPLAINT\|([A-Za-z0-9-]+)/);

            // --- 1. HANDLE INPUT DATA PRODUK (FILL) ---
            if (matchData) {
                const orderId = matchData[1];
                const idx = parseInt(matchData[2]);

                // [LOGIKA CERDAS] Split enter jadi Array agar App.jsx merender per baris
                const dataArray = text.split('\n').filter(x => x.trim());

                const ref = db.collection('orders').doc(orderId);
                
                // Gunakan Transaction agar aman
                await db.runTransaction(async (t) => {
                    const snap = await t.get(ref);
                    if (!snap.exists) throw "Order tidak ada";

                    let items = snap.data().items;
                    if (items[idx]) {
                        items[idx].data = dataArray; // Masuk ke kotak data di web
                        // Reset note jadi pesan sukses
                        items[idx].note = `Dikirim Admin: ${new Date().toLocaleTimeString()}`; 
                    }

                    // Cek apakah semua item sudah terisi?
                    const allFilled = items.every(i => (i.data && i.data.length > 0));
                    const nextStatus = allFilled ? 'success' : 'processing';

                    t.update(ref, { items: items, status: nextStatus });
                    return { allFilled, itemName: items[idx].name };
                }).then(async (res) => {
                    await sendMessage(chatId, `✅ Data untuk <b>${res.itemName}</b> tersimpan!`);
                    
                    if (res.allFilled) {
                        await sendMessage(chatId, "🎉 Semua item telah terisi! Mengirim notifikasi ke user...");
                        await sendSuccessNotification(chatId, orderId);
                    } else {
                        // Jika masih ada yg kosong, tampilkan menu lagi
                        await showItemEditor(chatId, orderId, (await ref.get()).data().items);
                    }
                }).catch((e) => sendMessage(chatId, `❌ Error DB: ${e.message}`));
            }

            // --- 2. HANDLE BALASAN KOMPLAIN ---
            else if (matchComp) {
                const orderId = matchComp[1];
                
                // Update Firestore agar muncul di App.jsx (field complaintReply)
                await db.collection('orders').doc(orderId).update({
                    complaintReply: text, // Ini yang dibaca App.jsx
                    hasNewReply: true,     // Trigger notifikasi (opsional)
                    adminMessage: "Admin telah membalas komplain Anda." // Fallback
                });

                await sendMessage(chatId, `✅ <b>Balasan Komplain Terkirim!</b>\nUser akan melihat pesan ini di detail pesanan mereka.`);
            }
        }

    } catch (e) {
        console.error(e);
        if (req.body.message) sendMessage(req.body.message.chat.id, `⚠️ System Error: ${e.message}`);
    }
    return res.status(200).send('ok');
};

// ============================================================
// C. FUNGSI BANTUAN (HELPER)
// ============================================================

// Menampilkan Daftar Item dengan Tombol Edit
async function showItemEditor(chatId, orderId, items) {
    let msg = `📋 <b>ORDER ${orderId} (BUTUH MANUAL)</b>\nTekan tombol Edit untuk mengisi data:\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        // Cek apakah data sudah ada (Array dan ada isinya)
        const isReady = (item.data && Array.isArray(item.data) && item.data.length > 0);
        const icon = isReady ? '✅' : '✏️';
        const statusText = isReady ? 'Terisi' : 'KOSONG';
        
        msg += `\n${i+1}. ${item.name} [${statusText}]`;
        
        // Tombol Edit per item
        kb.push([{ text: `${icon} Isi Data: ${item.name}`, callback_data: `FILL_${orderId}_${i}` }]);
    });

    // Tombol Paksa Selesai
    kb.push([{ text: "🚀 SELESAI & KIRIM LINK", callback_data: `DONE_${orderId}` }]);

    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

// Mengirim Link WA ke Admin agar diteruskan ke User (Atau User bisa klik di Web)
async function sendSuccessNotification(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    if (!snap.exists) return;
    
    const data = snap.data();
    
    // --- LOGIKA CARI NOMOR HP USER (AGRESIF) ---
    // App.jsx menyimpan nomor/kontak user biasanya di item pertama bagian 'note' 
    // atau jika user login, di field phoneNumber.
    let hp = data.phoneNumber || "";
    
    if ((!hp || hp.length < 5) && data.items[0]?.note) {
        // Coba ambil angka saja dari note item pertama
        const possibleNumber = data.items[0].note.replace(/\D/g, '');
        // Validasi kasar nomor Indonesia (min 10 digit)
        if (possibleNumber.length >= 10) hp = possibleNumber;
    }

    // Format ke 62
    hp = hp.replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);
    
    // Susun Pesan WA Otomatis
    let waMsg = `Halo, Pesanan *${orderId}* Sudah Selesai! ✅\n\n`;
    data.items.forEach(i => {
        waMsg += `📦 *${i.name}*\n`;
        if (i.data && Array.isArray(i.data)) {
            waMsg += `${i.data.join('\n')}\n`; // Gabung array jadi text
        } else {
            waMsg += `Data: (Cek Riwayat Web)\n`;
        }
        waMsg += `\n`;
    });
    waMsg += `Terima Kasih!`;

    // Buat Link WA
    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(waMsg)}` : `https://wa.me/?text=${encodeURIComponent(waMsg)}`;
    
    await sendMessage(chatId, `✅ <b>ORDER SELESAI!</b>\nStatus di Web sudah "Success". Data sudah muncul di akun user.\n\n📱 <b>Kirim ke User:</b>`, { 
        reply_markup: { inline_keyboard: [[{ text: "📲 Chat WhatsApp User", url: url }]] } 
    });
}
