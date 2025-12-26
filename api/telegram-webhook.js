const { db } = require('./firebaseConfig'); //
const { sendMessage } = require('./botConfig'); //

const ADMIN_ID = '1383656187'; //

// Fungsi Helper untuk memproses stok otomatis
async function prosesOtomatisOrder(orderId, chatId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    try {
        await db.runTransaction(async (t) => {
            const orderDoc = await t.get(orderRef);
            if (!orderDoc.exists) throw "Order tidak ditemukan di database";
            
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

                if (!pDoc.exists) { logs.push(`⚠️ ${item.name}: Produk induk hilang.`); needManual = true; continue; }

                const pData = pDoc.data();
                let stokDiambil = [];
                let updateTarget = {};

                if (item.isVariant) {
                    const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                    if (vIdx !== -1) {
                        const stokVarian = pData.variations[vIdx].items || [];
                        if (stokVarian.length >= item.qty) {
                            stokDiambil = stokVarian.slice(0, item.qty);
                            pData.variations[vIdx].items = stokVarian.slice(item.qty);
                            updateTarget = { variations: pData.variations };
                            logs.push(`✅ ${item.name}: Stok Varian OK.`);
                        } else { logs.push(`❌ ${item.name}: Stok Varian KURANG.`); needManual = true; }
                    } else { logs.push(`⚠️ ${item.name}: Varian hilang.`); needManual = true; }
                } else {
                    const stokUtama = pData.items || [];
                    if (stokUtama.length >= item.qty) {
                        stokDiambil = stokUtama.slice(0, item.qty);
                        updateTarget = { items: stokUtama.slice(item.qty) };
                        logs.push(`✅ ${item.name}: Stok Utama OK.`);
                    } else { logs.push(`❌ ${item.name}: Stok Utama KOSONG.`); needManual = true; }
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
            await sendMessage(chatId, `📄 <b>Laporan Proses:</b>\n${res.logs.join('\n')}`);
            if (res.needManual) {
                 await sendMessage(chatId, "⚠️ Ada stok kosong. Silakan isi manual.");
            }
        });
    } catch (e) {
        await sendMessage(chatId, `❌ Gagal: ${e.message}`);
    }
}

// Handler utama yang dieksport ke index.js
module.exports = async (req, res) => {
    const update = req.body;

    try {
        // A. HANDLE TOMBOL (CALLBACK QUERY)
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data;
            const chatId = query.message.chat.id;

            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ Memproses Order: ${orderId}...`);
                await prosesOtomatisOrder(orderId, chatId);
            }
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];
                const secret = `DATA|${orderId}|${itemIdx}`;
                
                await sendMessage(chatId, 
                    `✍️ <b>INPUT DATA MANUAL</b>\nReply pesan ini dengan data produk.\n<span class="tg-spoiler">${secret}</span>`, 
                    { parse_mode: 'HTML', reply_markup: { force_reply: true } }
                );
            }
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendMessage(chatId, `✅ Order ${orderId} ditandai Selesai.`);
            }
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                const secret = `COMPLAINT|${orderId}`;
                await sendMessage(chatId, 
                    `🗣 <b>BALAS KOMPLAIN</b>\nKetik balasan Anda untuk pembeli:\n<span class="tg-spoiler">${secret}</span>`, 
                    { parse_mode: 'HTML', reply_markup: { force_reply: true } }
                );
            }
            return res.status(200).send('ok');
        }

        // B. HANDLE REPLY TEXT
        if (update.message && update.message.reply_to_message) {
            const text = update.message.text;
            const reply = update.message.reply_to_message.text || "";
            const chatId = update.message.chat.id;

            let matchData = reply.match(/DATA\|([A-Za-z0-9-]+)\|(\d+)/);
            let matchComp = reply.match(/COMPLAINT\|([A-Za-z0-9-]+)/);

            if (matchData) {
                const orderId = matchData[1];
                const idx = parseInt(matchData[2]);
                const dataArray = text.split('\n').filter(x => x.trim());
                const ref = db.collection('orders').doc(orderId);
                const snap = await ref.get();
                
                if (snap.exists) {
                    let items = snap.data().items;
                    items[idx].data = dataArray; 
                    items[idx].sn = dataArray;
                    items[idx].desc = dataArray;
                    await ref.update({ items: items });
                    await sendMessage(chatId, `✅ Data berhasil disimpan untuk item ke-${idx+1}`);
                }
            } else if (matchComp) {
                const orderId = matchComp[1];
                await db.collection('orders').doc(orderId).update({ 
                    complaintReply: text, 
                    hasNewReply: true 
                });
                await sendMessage(chatId, `✅ Balasan terkirim ke pembeli.`);
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    res.status(200).send('ok');
};
