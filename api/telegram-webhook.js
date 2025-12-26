const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

module.exports = async function(req, res) {
    const update = req.body;

    try {
        // ============================================================
        // A. HANDLE KLIK TOMBOL (CALLBACK QUERY)
        // ============================================================
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data; 
            const chatId = query.message.chat.id;

            // 1. TOMBOL ACC (PROSES STOK OTOMATIS)
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ <b>[SISTEM]</b> Memproses Order ${orderId}...\nMencari stok di database...`);

                // Panggil Fungsi Logika Stok (Sama dengan Midtrans)
                const result = await processOrderStock(orderId);

                if (result.success) {
                    await sendMessage(chatId, `✅ <b>[SUKSES]</b> Order ${orderId} selesai otomatis!\nData terkirim ke web.\n\n${result.logs.join('\n')}`);
                    await sendWALink(chatId, orderId); 
                } else {
                    await sendMessage(chatId, `⚠️ <b>[PENDING]</b> Stok Otomatis Kosong/Gagal.\n${result.logs.join('\n')}\n\nSilakan input manual di bawah ini:`);
                    await showManualInputMenu(chatId, orderId, result.items);
                }
            }

            // 2. TOMBOL FILL (MINTA INPUT MANUAL)
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                
                // Prompt dengan RefID JELAS agar tidak Error parsing
                const promptText = `✍️ <b>INPUT DATA MANUAL</b>\n\nSilakan Reply pesan ini dengan data (Akun/Kode).\nBisa multi-baris (Enter).\n\n-------- JANGAN HAPUS --------\nRefID: ${orderId}\nIdx: ${itemIdx}`;
                
                await sendMessage(chatId, promptText, { reply_markup: { force_reply: true } });
            }

            // 3. TOMBOL DONE (PAKSA SELESAI)
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendMessage(chatId, `✅ <b>[FORCED]</b> Order ${orderId} ditandai SUKSES manual.`);
                await sendWALink(chatId, orderId);
            }

            // 4. TOMBOL BALAS KOMPLAIN
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                const promptText = `💬 <b>BALAS KOMPLAIN</b>\n\nTulis pesan balasan untuk User:\n\n-------- JANGAN HAPUS --------\nRefID: ${orderId}\nType: COMPLAINT`;
                
                await sendMessage(chatId, promptText, { reply_markup: { force_reply: true } });
            }

            return res.status(200).send('ok');
        }

        // ============================================================
        // B. HANDLE REPLY PESAN (INPUT TEXT ADMIN)
        // ============================================================
        if (update.message && update.message.reply_to_message) {
            const textAdmin = update.message.text;
            const replyOrigin = update.message.reply_to_message.text || "";
            const chatId = update.message.chat.id;

            // PARSING RefID DARI TEXT (Lebih Stabil daripada Metadata)
            const idMatch = replyOrigin.match(/RefID:\s*([A-Za-z0-9-]+)/);
            
            if (idMatch) {
                const orderId = idMatch[1];

                // --- SKENARIO 1: INPUT DATA BARANG (FILL) ---
                const idxMatch = replyOrigin.match(/Idx:\s*(\d+)/);
                if (idxMatch) {
                    const itemIdx = parseInt(idxMatch[1]);
                    
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
                            items[itemIdx].sn = dataArray;
                            items[itemIdx].note = `Manual: ${new Date().toLocaleTimeString()}`; 
                        }

                        // Cek apakah semua item sudah diisi?
                        const allFilled = items.every(i => (i.data && Array.isArray(i.data) && i.data.length > 0));
                        const finalStatus = allFilled ? 'success' : 'processing';

                        t.update(docRef, { items: items, status: finalStatus });
                        return { allFilled, itemName: items[itemIdx].name };
                    }).then(async (res) => {
                        await sendMessage(chatId, `✅ <b>[TERSIMPAN]</b> Data untuk ${res.itemName} masuk.`);
                        if (res.allFilled) {
                            await sendMessage(chatId, "🎉 Semua item terisi! Mengirim notif ke User...");
                            await sendWALink(chatId, orderId);
                        } else {
                            // Tampilkan menu lagi jika masih ada yg kosong
                            await sendMessage(chatId, "⚠️ Masih ada item kosong:");
                            const freshSnap = await db.collection('orders').doc(orderId).get();
                            await showManualInputMenu(chatId, orderId, freshSnap.data().items);
                        }
                    }).catch(e => sendMessage(chatId, `❌ Error DB: ${e.message}`));
                }

                // --- SKENARIO 2: BALAS KOMPLAIN ---
                else if (replyOrigin.includes('Type: COMPLAINT')) {
                    await db.collection('orders').doc(orderId).update({
                        complaintReply: textAdmin,
                        hasNewReply: true
                    });
                    await sendMessage(chatId, `✅ <b>[TERKIRIM]</b> Balasan komplain masuk ke Web User.`);
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    return res.status(200).send('ok');
};

// --- FUNGSI LOGIKA CORE (DIGUNAKAN OLEH BOT & MIDTRANS) ---

async function processOrderStock(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw new Error("Order hilang");
        
        const orderData = orderDoc.data();
        let items = orderData.items;
        let logs = [];
        let needManual = false;

        for (let i = 0; i < items.length; i++) {
            // Skip jika data sudah ada
            if (items[i].data && items[i].data.length > 0) continue;

            const item = items[i];
            const pid = item.isVariant ? item.originalId : item.id;
            
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);

            // Cek Ketersediaan & Tipe Produk
            if (!pDoc.exists || pDoc.data().isManual || pDoc.data().processType === 'MANUAL') {
                logs.push(`⚠️ ${item.name}: Produk Manual / Tidak Ditemukan.`);
                needManual = true; continue;
            }

            const pData = pDoc.data();
            let stokDiambil = [];
            let updateTarget = {};

            // Logika Potong Stok (Varian vs Utama)
            if (item.isVariant) {
                const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                if (vIdx !== -1) {
                    const stokVarian = pData.variations[vIdx].items || [];
                    if (stokVarian.length >= item.qty) {
                        stokDiambil = stokVarian.slice(0, item.qty);
                        pData.variations[vIdx].items = stokVarian.slice(item.qty);
                        updateTarget = { variations: pData.variations };
                        logs.push(`✅ ${item.name}: Ambil Varian OK.`);
                    } else { logs.push(`❌ ${item.name}: Stok Varian Kurang.`); needManual = true; }
                } else { logs.push(`❌ ${item.name}: Varian Salah.`); needManual = true; }
            } else {
                const stokUtama = pData.items || [];
                if (stokUtama.length >= item.qty) {
                    stokDiambil = stokUtama.slice(0, item.qty);
                    updateTarget = { items: stokUtama.slice(item.qty) };
                    logs.push(`✅ ${item.name}: Ambil Utama OK.`);
                } else { logs.push(`❌ ${item.name}: Stok Utama Habis.`); needManual = true; }
            }

            // Update Jika Stok Ada
            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil;
                items[i].sn = stokDiambil;
                updateTarget.realSold = (pData.realSold || 0) + item.qty;
                t.update(pRef, updateTarget);
            }
        }

        const finalStatus = needManual ? 'processing' : 'success';
        t.update(orderRef, { items: items, status: finalStatus });

        return { success: !needManual, logs, items };
    });
}

async function showManualInputMenu(chatId, orderId, items) {
    let msg = `📋 <b>INPUT MANUAL DIPERLUKAN</b>\nOrder ID: ${orderId}\n`;
    const kb = [];
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `\n${i+1}. ${item.name} [${ready ? '✅' : '❌'}]`;
        if (!ready) kb.push([{ text: `✏️ ISI: ${item.name}`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "🚀 DONE & KIRIM", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

async function sendWALink(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    let hp = data.phoneNumber || (data.items[0]?.note || "").replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);

    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 ${i.name}\n${(i.data||[]).join('\n')}\n\n`;
    });
    const url = `https://wa.me/${hp}?text=${encodeURIComponent(msg)}`;
    
    await sendMessage(chatId, `✅ <b>SELESAI!</b>\nStatus Web: Success.\n\nKlik untuk kirim ke WA:`, { 
        reply_markup: { inline_keyboard: [[{ text: "📲 Chat WA", url: url }]] } 
    });
}
