const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

module.exports = async function(req, res) {
    const update = req.body;

    try {
        // ============================================================
        // 1. HANDLE TOMBOL (CALLBACK QUERY)
        // ============================================================
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data;
            const chatId = query.message.chat.id;

            // --- TOMBOL ACC (PROSES OTOMATIS) ---
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ Memproses Order: <b>${orderId}</b>...`);

                const orderRef = db.collection('orders').doc(orderId);
                
                await db.runTransaction(async (t) => {
                    const orderDoc = await t.get(orderRef);
                    if (!orderDoc.exists) throw new Error("Order tidak ditemukan");
                    
                    const orderData = orderDoc.data();
                    let items = orderData.items;
                    let logs = [];
                    let needManual = false;

                    for (let i = 0; i < items.length; i++) {
                        if (items[i].data && Array.isArray(items[i].data) && items[i].data.length > 0) continue;

                        const item = items[i];
                        const pid = item.isVariant ? item.originalId : item.id;
                        const pRef = db.collection('products').doc(pid);
                        const pDoc = await t.get(pRef);

                        if (!pDoc.exists) {
                            logs.push(`⚠️ ${item.name}: Produk induk hilang.`);
                            needManual = true; continue;
                        }

                        const pData = pDoc.data();
                        let stokDiambil = [];
                        let updateTarget = {};

                        // LOGIKA CARI STOK (Variant vs Utama)
                        if (item.isVariant) {
                            const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                            if (vIdx !== -1) {
                                const stokVarian = pData.variations[vIdx].items || [];
                                if (stokVarian.length >= item.qty) {
                                    stokDiambil = stokVarian.slice(0, item.qty);
                                    pData.variations[vIdx].items = stokVarian.slice(item.qty);
                                    updateTarget = { variations: pData.variations };
                                    logs.push(`✅ ${item.name}: Stok Varian OK.`);
                                } else {
                                    logs.push(`❌ ${item.name}: Stok Varian HABIS.`);
                                    needManual = true;
                                }
                            } else {
                                logs.push(`⚠️ ${item.name}: Varian tidak ditemukan.`);
                                needManual = true;
                            }
                        } else {
                            const stokUtama = pData.items || [];
                            if (stokUtama.length >= item.qty) {
                                stokDiambil = stokUtama.slice(0, item.qty);
                                updateTarget = { items: stokUtama.slice(item.qty) };
                                logs.push(`✅ ${item.name}: Stok Utama OK.`);
                            } else {
                                logs.push(`❌ ${item.name}: Stok Utama HABIS.`);
                                needManual = true;
                            }
                        }

                        if (stokDiambil.length > 0) {
                            items[i].data = stokDiambil; 
                            items[i].sn = stokDiambil;
                            items[i].desc = stokDiambil;
                            updateTarget.realSold = (pData.realSold || 0) + item.qty;
                            t.update(pRef, updateTarget);
                        }
                    }

                    const statusFinal = needManual ? 'processing' : 'success';
                    t.update(orderRef, { items: items, status: statusFinal });

                    return { logs, needManual };
                }).then(async (res) => {
                    await sendMessage(chatId, `📄 <b>Laporan:</b>\n${res.logs.join('\n')}`);
                    if (res.needManual) await showMenu(chatId, orderId);
                    else await sendWALink(chatId, orderId);
                }).catch(async (e) => {
                    await sendMessage(chatId, `❌ Error: ${e.message}`);
                });
            }

            // --- TOMBOL FILL (INPUT MANUAL) ---
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                const secret = `DATA|${orderId}|${itemIdx}`;
                
                await sendMessage(chatId, `✍️ <b>INPUT DATA MANUAL</b>\nSilakan balas (reply) pesan ini dengan data produk.\n\nJika lebih dari 1, pisahkan dengan baris baru (Enter).`, { reply_markup: { force_reply: true } });
                await sendMessage(chatId, `<span class="tg-spoiler">${secret}</span>`, { parse_mode: 'HTML' });
            }

            // --- TOMBOL DONE (SELESAI & LINK WA) ---
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendWALink(chatId, orderId);
            }

            // --- TOMBOL BALAS KOMPLAIN ---
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[2] || data.split('_')[1];
                const secret = `COMPLAINT|${orderId}`;
                await sendMessage(chatId, `🗣 <b>BALAS KOMPLAIN</b>\nKetik balasan Anda untuk pembeli di bawah ini:`, { reply_markup: { force_reply: true } });
                await sendMessage(chatId, `<span class="tg-spoiler">${secret}</span>`, { parse_mode: 'HTML' });
            }

            return res.status(200).send('ok');
        }

        // ============================================================
        // 2. HANDLE REPLY PESAN (INPUT DATA & BALAS KOMPLAIN)
        // ============================================================
        if (update.message && update.message.reply_to_message) {
            const text = update.message.text;
            const replyText = update.message.reply_to_message.text || "";
            const chatId = update.message.chat.id;

            let matchData = replyText.match(/DATA\|([A-Za-z0-9-]+)\|(\d+)/);
            let matchComp = replyText.match(/COMPLAINT\|([A-Za-z0-9-]+)/);

            // A. Proses Simpan Data Manual
            if (matchData) {
                const orderId = matchData[1];
                const idx = parseInt(matchData[2]);
                const dataArray = text.split('\n').filter(x => x.trim());

                const ref = db.collection('orders').doc(orderId);
                const snap = await ref.get();
                if (snap.exists) {
                    let items = snap.data().items;
                    if (items[idx]) {
                        items[idx].data = dataArray; 
                        items[idx].sn = dataArray;
                        items[idx].desc = dataArray;
                        items[idx].note = dataArray[0] || 'Manual Input';
                        
                        await ref.update({ items: items });
                        await sendMessage(chatId, `✅ Berhasil menyimpan data untuk: <b>${items[idx].name}</b>`);
                        // [PENTING] Munculkan kembali menu utama agar admin bisa klik tombol "DONE"
                        await showMenu(chatId, orderId); 
                    }
                }
            }
            // B. Proses Balas Komplain
            else if (matchComp) {
                const orderId = matchComp[1];
                await db.collection('orders').doc(orderId).update({ 
                    complaintReply: text, 
                    hasNewReply: true 
                });
                await sendMessage(chatId, `✅ <b>BERHASIL!</b>\nBalasan komplain untuk Order <code>${orderId}</code> sudah tampil di Web pembeli.`);
            }
        }
    } catch (e) {
        console.error("Bot Error:", e);
    }
    return res.status(200).send('ok');
};

// ============================================================
// FUNGSI HELPER
// ============================================================

async function showMenu(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    if(!snap.exists) return;
    const items = snap.data().items;
    
    let msg = `📋 <b>MENU PENGISIAN DATA: ${orderId}</b>\n`;
    const kb = [];
    
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `\n${i+1}. ${item.name} [${ready ? '✅' : '❌'}]`;
        kb.push([{ text: `${ready ? '✅' : '✏️'} Isi/Edit: ${item.name}`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    
    kb.push([{ text: "🚀 SELESAI & KIRIM WA", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

async function sendWALink(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    
    let hp = data.phoneNumber || "";
    if ((!hp || hp.length < 5) && data.items[0]?.note) {
        const possible = data.items[0].note.replace(/\D/g, '');
        if (possible.length > 9) hp = possible;
    }

    hp = hp.replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);
    
    let waMsg = `Halo, Pesanan *${orderId}* sukses diproses!\n\n`;
    data.items.forEach(i => {
        waMsg += `📦 *${i.name}*\n`;
        if(i.data && Array.isArray(i.data)) waMsg += `\`${i.data.join('\n')}\`\n\n`;
        else waMsg += `(Data akan segera dikirim)\n\n`;
    });
    waMsg += `Terima kasih telah berbelanja!`;

    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(waMsg)}` : `https://wa.me/?text=${encodeURIComponent(waMsg)}`;
    
    const textFinal = `✅ <b>ORDER SELESAI!</b>\nData sudah sinkron ke Web.\n\n📱 Nomor: ${hp || 'Tidak Ditemukan'}\n\nKlik tombol di bawah untuk chat pembeli:`;
    
    await sendMessage(chatId, textFinal, { 
        reply_markup: { inline_keyboard: [[{ text: "📲 Chat WhatsApp", url: url }]] } 
    });
}
