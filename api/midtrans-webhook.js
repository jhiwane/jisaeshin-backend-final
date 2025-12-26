const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

const ADMIN_CHAT_ID = '1383656187'; // Sesuaikan ID Admin

module.exports = async function(req, res) {
    const { order_id, transaction_status, fraud_status } = req.body;

    // Logika Midtrans: Settlement / Capture = Uang Masuk
    if (transaction_status == 'capture' || transaction_status == 'settlement') {
        
        try {
            const orderRef = db.collection('orders').doc(order_id);
            
            // 1. UPDATE STATUS JADI 'PAID' (Agar user tau uang masuk)
            await orderRef.update({ status: 'paid' });

            // 2. JALANKAN LOGIKA STOK OTOMATIS (Logic Sama dgn Telegram ACC)
            const result = await db.runTransaction(async (t) => {
                const orderDoc = await t.get(orderRef);
                if (!orderDoc.exists) return null;
                
                const orderData = orderDoc.data();
                // Jika sudah success/processing, skip biar ga double
                if (orderData.status === 'success' || orderData.status === 'processing') return null;

                let items = orderData.items;
                let needManual = false;
                let logs = [];

                for (let i = 0; i < items.length; i++) {
                    if (items[i].data && items[i].data.length > 0) continue;

                    const item = items[i];
                    const pid = item.isVariant ? item.originalId : item.id;
                    const pRef = db.collection('products').doc(pid);
                    const pDoc = await t.get(pRef);

                    if (!pDoc.exists || pDoc.data().isManual || pDoc.data().processType === 'MANUAL') {
                        needManual = true; continue;
                    }

                    const pData = pDoc.data();
                    let stokDiambil = [];
                    let updateTarget = {};

                    if (item.isVariant) {
                        const vIdx = pData.variations ? pData.variations.findIndex(v => v.name === item.variantName) : -1;
                        if (vIdx !== -1 && (pData.variations[vIdx].items || []).length >= item.qty) {
                            stokDiambil = pData.variations[vIdx].items.slice(0, item.qty);
                            pData.variations[vIdx].items = pData.variations[vIdx].items.slice(item.qty);
                            updateTarget = { variations: pData.variations };
                        } else needManual = true;
                    } else {
                        if ((pData.items || []).length >= item.qty) {
                            stokDiambil = pData.items.slice(0, item.qty);
                            updateTarget = { items: pData.items.slice(item.qty) };
                        } else needManual = true;
                    }

                    if (stokDiambil.length > 0) {
                        items[i].data = stokDiambil;
                        items[i].sn = stokDiambil;
                        updateTarget.realSold = (pData.realSold || 0) + item.qty;
                        t.update(pRef, updateTarget);
                    }
                }

                const finalStatus = needManual ? 'processing' : 'success';
                t.update(orderRef, { items: items, status: finalStatus });
                return { needManual, items };
            });

            // 3. KIRIM NOTIFIKASI KE ADMIN
            if (result) {
                if (result.needManual) {
                    // Jika butuh manual, kirim tombol FILL
                    const kb = result.items.map((item, i) => {
                         if (!item.data || item.data.length === 0) {
                             return [{ text: `✏️ ISI: ${item.name}`, callback_data: `FILL_${order_id}_${i}` }];
                         }
                         return null;
                    }).filter(Boolean);
                    
                    await sendMessage(ADMIN_CHAT_ID, `🔔 <b>MIDTRANS SUKSES (BUTUH DATA)</b>\nOrder: ${order_id}\nStok otomatis kurang/manual. Harap isi:`, {
                        reply_markup: { inline_keyboard: kb }
                    });
                } else {
                    await sendMessage(ADMIN_CHAT_ID, `✅ <b>MIDTRANS SUKSES (AUTO DONE)</b>\nOrder: ${order_id}\nStok terkirim otomatis.`);
                }
            }

        } catch (e) {
            console.error("Midtrans Logic Error:", e);
        }
    }
    
    res.status(200).send('ok');
};
