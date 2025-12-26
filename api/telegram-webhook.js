const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const { db } = require('./firebaseConfig'); // Pastikan file ini ada
const { sendMessage } = require('./botConfig'); // Pastikan file ini ada

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. KONFIGURASI ADMIN & MIDTRANS
// ==========================================
const ADMIN_ID = '1383656187'; // GANTI DENGAN ID TELEGRAM ANDA (ANGKA)
const PORT = process.env.PORT || 3000;

// GANTI DENGAN SERVER KEY MIDTRANS ANDA
const snap = new midtransClient.Snap({
    isProduction: true, // Ubah ke true jika sudah live production
    serverKey: 'Mid-client-TayUBwSvTzcr6nwS' // GANTI INI
});

// ==========================================
// 2. ROUTE API WEBSITE (MEMPERBAIKI ERROR 404)
// ==========================================

// A. Endpoint Token Midtrans (Agar Web bisa bayar)
app.post('/api/token', async (req, res) => {
    try {
        const { order_id, total, items } = req.body;
        
        // Parameter Midtrans Standar
        let parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: total
            },
            item_details: items.map(item => ({
                id: Math.random().toString(36).substring(7),
                price: parseInt(item.price),
                quantity: parseInt(item.qty),
                name: item.name.substring(0, 50) // Midtrans limit nama 50 char
            }))
        };

        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token });
    } catch (e) {
        console.error("Midtrans Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// B. Endpoint Notifikasi dari Web ke Bot (Agar Web bisa lapor sukses/komplain)
app.post('/api/notify', async (req, res) => {
    try {
        const { orderId, type, message, buyerContact, total, items } = req.body;
        
        if (type === 'auto') {
            // Notifikasi Pembayaran Sukses (Otomatis/Manual Transfer)
            await sendMessage(ADMIN_ID, `🔔 <b>PESANAN MASUK DARI WEB!</b>\nOrder ID: ${orderId}\nTotal: Rp ${total?.toLocaleString()}\nKontak: ${buyerContact}\n\n⚙️ <i>Sistem sedang memproses stok...</i>`);
            
            // Trigger Fungsi Otomatis Bot
            await prosesOtomatisOrder(orderId, ADMIN_ID);
        } 
        else if (type === 'complaint') {
            // Notifikasi Komplain dari User
            const keyboard = [[{ text: "🗣 BALAS PESAN", callback_data: `REPLY_COMPLAINT_${orderId}` }]];
            await sendMessage(ADMIN_ID, `⚠️ <b>LAPORAN MASALAH BARU!</b>\n\n🆔 Order: ${orderId}\n👤 User: ${buyerContact || 'Guest'}\n💬 Pesan: "${message}"`, { reply_markup: { inline_keyboard: keyboard } });
        }
        
        res.json({ status: 'ok' });
    } catch (e) {
        console.error("Notify Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 3. ROUTE BOT TELEGRAM (LOGIKA SAKTI)
// ==========================================
app.post('/telegram-webhook', async (req, res) => { // Pastikan URL Webhook di BotFather mengarah ke sini
    const update = req.body;

    try {
        // A. HANDLE TOMBOL (CALLBACK QUERY)
        if (update.callback_query) {
            const query = update.callback_query;
            const data = query.data;
            const chatId = query.message.chat.id;

            // 1. TOMBOL ACC (Manual Trigger)
            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                await sendMessage(chatId, `⚙️ Cek Stok Database untuk ${orderId}...`);
                await prosesOtomatisOrder(orderId, chatId);
            }

            // 2. TOMBOL FILL (Isi Manual)
            else if (data.startsWith('FILL_')) {
                const parts = data.split('_');
                const orderId = parts[1];
                const itemIdx = parts[2];

                const snap = await db.collection('orders').doc(orderId).get();
                const itemName = snap.exists ? snap.data().items[itemIdx].name : 'Item';
                const secret = `DATA|${orderId}|${itemIdx}`;
                
                // FORCE REPLY WAJIB AGAR MUNCUL KEYBOARD
                await sendMessage(chatId, 
                    `✍️ <b>INPUT MANUAL: ${itemName}</b>\n\n` +
                    `Reply pesan ini dengan data (Akun/Kode).\n` +
                    `<span class="tg-spoiler">${secret}</span>`, 
                    { parse_mode: 'HTML', reply_markup: { force_reply: true } }
                );
            }

            // 3. DONE (Selesai)
            else if (data.startsWith('DONE_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'success' });
                await sendWALink(chatId, orderId);
            }

            // 4. BALAS KOMPLAIN (PERBAIKAN FITUR INI)
            else if (data.startsWith('REPLY_COMPLAINT_')) {
                const orderId = data.split('_')[1];
                const secret = `COMPLAINT|${orderId}`;
                
                await sendMessage(chatId, 
                    `🗣 <b>BALAS KOMPLAIN ORDER ${orderId}</b>\n\n` +
                    `Silakan ketik balasan Anda:\n` +
                    `<span class="tg-spoiler">${secret}</span>`, 
                    { parse_mode: 'HTML', reply_markup: { force_reply: true } }
                );
            }

            // Jawab Callback agar loading hilang
            // (Opsional, perlu token bot untuk hit API answerCallbackQuery, tapi biasanya sendMessage cukup)
            return res.status(200).send('ok');
        }

        // B. HANDLE TEXT REPLY (MANUAL INPUT & KOMPLAIN)
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
                    if (items[idx]) {
                        // SIMPAN KE SEMUA FIELD (ANTI-ZONK)
                        items[idx].data = dataArray; 
                        items[idx].sn = dataArray;
                        items[idx].desc = dataArray;
                        items[idx].note = dataArray[0] || 'Manual Input'; 

                        await ref.update({ items: items });
                        await sendMessage(chatId, `✅ <b>Tersimpan!</b> Item: ${items[idx].name}`);
                        await showMenu(chatId, orderId);
                    }
                }
            }
            else if (matchComp) {
                const orderId = matchComp[1];
                // Update Firebase agar Web User melihat balasan
                await db.collection('orders').doc(orderId).update({ 
                    complaintReply: text, 
                    hasNewReply: true 
                });
                await sendMessage(chatId, `✅ Balasan terkirim ke User (Order ${orderId}).`);
            }
        }

    } catch (e) {
        console.error(e);
    }
    res.status(200).send('ok');
});

// ==========================================
// 4. FUNGSI LOGIKA (AUTO STOK & UI)
// ==========================================

async function prosesOtomatisOrder(orderId, chatId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    await db.runTransaction(async (t) => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) throw "Order hilang";
        
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

            // LOGIKA CARI STOK
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

            // UPDATE DATA
            if (stokDiambil.length > 0) {
                items[i].data = stokDiambil; 
                items[i].sn = stokDiambil;
                items[i].desc = stokDiambil; // Backup Anti Zonk
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
             await sendMessage(chatId, "⚠️ Ada stok kosong. Silakan isi manual:");
             await showMenu(chatId, orderId);
        } else {
             await sendWALink(chatId, orderId);
        }
    }).catch(async (e) => {
        await sendMessage(chatId, `❌ Gagal Proses: ${e.message}`);
    });
}

async function showMenu(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    if(!snap.exists) return;
    const items = snap.data().items;
    let msg = `📋 <b>ORDER ${orderId}</b>\n`;
    const kb = [];
    items.forEach((item, i) => {
        const ready = (item.data && Array.isArray(item.data) && item.data.length > 0);
        msg += `\n${i+1}. ${item.name} [${ready ? '✅' : '❌'}]`;
        kb.push([{ text: `${ready?'✅':'✏️'} Edit/Isi: ${item.name}`, callback_data: `FILL_${orderId}_${i}` }]);
    });
    kb.push([{ text: "🚀 SELESAI & KIRIM WA", callback_data: `DONE_${orderId}` }]);
    await sendMessage(chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

async function sendWALink(chatId, orderId) {
    const snap = await db.collection('orders').doc(orderId).get();
    const data = snap.data();
    let hp = data.phoneNumber || "";
    if ((!hp || hp.length < 5) && data.items[0]?.note) {
        const possibleNumber = data.items[0].note.replace(/\D/g, '');
        if (possibleNumber.length > 9) hp = possibleNumber;
    }
    hp = hp.replace(/\D/g, '');
    if (hp.startsWith('0')) hp = '62' + hp.slice(1);
    
    let msg = `Halo, Pesanan *${orderId}* Sukses!\n\n`;
    data.items.forEach(i => {
        msg += `📦 ${i.name}\n`;
        if(i.data && Array.isArray(i.data)) msg += `${i.data.join('\n')}\n\n`;
        else msg += `Data: -\n\n`;
    });
    msg += `Trims!`;
    const url = hp ? `https://wa.me/${hp}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    await sendMessage(chatId, `✅ <b>SELESAI!</b>\nData muncul di Web.\n\nKlik WA:`, { reply_markup: { inline_keyboard: [[{ text: "📲 Chat WA", url: url }]] } });
}

// JALANKAN SERVER
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
