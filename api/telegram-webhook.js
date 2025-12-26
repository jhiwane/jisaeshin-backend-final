const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

module.exports = async function(req, res) {
    const update = req.body;

    try {
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data;
            const chatId = query.message.chat.id;

            // ============================================================
            // 1. TOMBOL ACC (PROSES OTOMATIS)
            // ============================================================
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ Memproses ${orderId}...`);

                const orderRef = db.collection('orders').doc(orderId);
                
                await db.runTransaction(async (t) => {
                    const orderDoc = await t.get(orderRef);
                    if (!orderDoc.exists) throw "Order tidak ditemukan";
                    
                    const orderData = orderDoc.data();
                    let items = orderData.items; // Ambil array items
                    let logs = [];
                    let needManual = false;

                    for (let i = 0; i < items.length; i++) {
                        // Skip jika data sudah terisi
                        if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

                        const item = items[i];
                        const pid = item.isVariant ? item.originalId : item.id;
                        const pRef = db.collection('products').doc(pid);
                        const pDoc = await t.get(pRef);

                        if (!pDoc.exists) {
                            logs.push(`⚠️ ${item.name}: Produk induk hilang di DB.`);
                            needManual = true; continue;
                        }

                        const pData = pDoc.data();
                        let stokDiambil = [];
                        let updateTarget = {};

                        // --- LOGIKA CARI STOK ---
                        if (item.isVariant) {
                            // Cari Varian
                            const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                            if (vIdx !== -1) {
                                const stokVarian = pData.variations[vIdx].items || [];
                                if (stokVarian.length >= item.qty) {
                                    stokDiambil = stokVarian.slice(0, item.qty);
                                    pData.variations[vIdx].items = stokVarian.slice(item.qty);
                                    updateTarget = { variations: pData.variations };
                                    logs.push(`✅ ${item.name}: Stok Varian OK.`);
                                } else {
                                    logs.push(`❌ ${item.name}: Stok Varian KURANG.`);
                                    needManual = true;
                                }
                            } else {
                                logs.push(`⚠️ ${item.name}: Varian tidak ketemu.`);
                                needManual = true;
                            }
                        } else {
                            // Cari Utama
                            const stokUtama = pData.items || [];
                            if (stokUtama.length >= item.qty) {
                                stokDiambil = stokUtama.slice(0, item.qty);
                                updateTarget = { items: stokUtama.slice(item.qty) };
                                logs.push(`✅ ${item.name}: Stok Utama OK.`);
                            } else {
                                logs.push(`❌ ${item.name}: Stok Utama KOSONG.`);
                                needManual = true;
                            }
                        }

                        // --- UPDATE JIKA STOK ADA ---
                        if (stokDiambil.length > 0) {
                            // [FIX KRUSIAL] Paksa jadi Array agar Web tidak Zonk
                            // App.jsx butuh Array untuk .map()
                            items[i].data = stokDiambil; 
                            
                            // Isi field lain jaga-jaga
                            items[i].sn = stokDiambil;
                            items[i].desc = stokDiambil;

                            // Update DB Produk
                            updateTarget.realSold = (pData.realSold || 0) + item.qty;
                            t.update(pRef, updateTarget);
                        }
                    }

                    // Simpan ke Order
                    const statusFinal = needManual ? 'processing' : 'success'; // Success = muncul di web
                    t.update(orderRef, { items: items, status: statusFinal });

                    return { logs, needManual };
                }).then(async (res) => {
                    await sendMessage(chatId, `📄 <b>Laporan:</b>\n${res.logs.join('\n')}`);
                    if (res.needManual) await showMenu(chatId, orderId);
                    else await sendWALink(chatId, orderId); // Kirim Link WA
                }).catch(async (e) => {
                    await sendMessage(chatId, `❌ Error: ${e.message}`);
                });
            }

            // ============================================================
            // 2. TOMBOL FILL (ISI MANUAL)
            // ============================================================
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const secret = `DATA|${parts[1]}|${parts[2]}`;
                
                await sendMessage(chatId, `✍️ Reply pesan ini dengan data (Akun/Kode):`, { reply_markup: { force_reply: true } });
                await sendMessage(chatId, `<span class="tg-spoiler">${secret}</span>`, { parse_mode: 'HTML' });
            }

            // ============================================================
            // 3. DONE & KOMPLAIN
            // ============================================================
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendWALink(chatId, orderId);
            }
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                const secret = `COMPLAINT|${orderId}`;
                await sendMessage(chatId, `✍️ Balas komplain:`, { reply_markup: { force_reply: true } });
                await sendMessage(chatId, `<span class="tg-spoiler">${secret}</span>`, { parse_mode: 'HTML' });
            }

            return res.status(200).send('ok');
        }

        // ============================================================
        // 4. HANDLE REPLY PESAN (TEXT)
        // ============================================================
        if (update.message && update.message.reply_to_message) {
            const text = update.message.text;
            const reply = update.message.reply_to_message.text || "";
            const chatId = update.message.chat.id;

            let matchData = reply.match(/DATA\|([A-Za-z0-9-]+)\|(\d+)/);
            let matchComp = reply.match(/COMPLAINT\|([A-Za-z0-9-]+)/);

            if (matchData) {
                const orderId = matchData[1];
                const idx = parseInt(matchData[2]);
                
                // [FIX KRUSIAL] Ubah Text jadi Array (Split Enter)
                // App.jsx WAJIB ARRAY
                const dataArray = text.split('\n').filter(x => x.trim());

                const ref = db.collection('orders').doc(orderId);
                const snap = await ref.get();
                if (snap.exists) {
                    let items = snap.data().items;
                    if (items[idx]) {
                        items[idx].data = dataArray; // Array
                        items[idx].sn = dataArray;   // Backup
                        items[idx].note = dataArray[0] || ''; // Preview note
                        
                        await ref.update({ items: items });
                        await sendMessage(chatId, "✅ Data tersimpan (Array Mode).");
                        await showMenu(chatId, orderId);
                    }
                }
            }
            else if (matchComp) {
                await db.collection('orders').doc(matchComp[1]).update({ complaintReply: text, hasNewReply: true });
                await sendMessage(chatId, "✅ Balasan terkirim.");
            }
        }
    } catch (e) {
        if(req.body.message) sendMessage(req.body.message.chat.id, `Error: ${e.message}`);
    }
    return res.status(200).send('ok');
};

// --- FUNGSI BANTUAN ---

async function showMenu(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    if(!snap.exists) return;
    const items = snap.data().items;
    
    let msg = `📋 <b>ORDER ${orderId}</b>\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        // Cek Array length
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `\n${i+1}. ${item.name} [${ready ? '✅' : '❌'}]`;
        kb.push([{ text: `${ready?'✅':'✏️'} Edit: ${item.name}`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "🚀 SELESAI & KIRIM WA", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

// [FIX WA LINK SALAH SASARAN]
async function sendWALink(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    // LOGIKA PENCARIAN NOMOR HP (AGRESIF)
    let hp = data.phoneNumber || "";
    
    // 1. Jika kosong, cari di note item pertama (biasanya user tulis nomor disitu)
    if ((!hp || hp.length < 5) && data.items[0]?.note) {
        // Ambil hanya angka dari note
        const possibleNumber = data.items[0].note.replace(/\D/g, '');
        if (possibleNumber.length > 9) hp = possibleNumber;
    }

    // 2. Format ke 62
    hp = hp.replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);
    
    // 3. Susun Pesan
    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 ${i.name}\n`;
        // Gabungkan array jadi string utk WA
        if(i.data && Array.isArray(i.data)) msg += `${i.data.join('\n')}\n\n`;
        else msg += `Data: -\n\n`;
    });
    msg += `Trims!`;

    // 4. Link
    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    
    await sendMessage(chatId, `✅ <b>SELESAI!</b>\nData PASTI muncul di web (Array Fix).\n\nNomor User: ${hp || 'TIDAK KETEMU'}\nKlik WA:`, { 
        reply_markup: { inline_keyboard: [[{ text: "📲 Chat WA", url: url }]] } 
    });
}
