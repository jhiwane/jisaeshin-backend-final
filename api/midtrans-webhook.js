const { db, admin } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID;

async function processOrderInventory(orderId) {
    const orderRef = db.collection('orders').doc(orderId);

    // Cek status manual dulu
    let needsManualProcessing = false;
    let updatedItems = [];

    await db.runTransaction(async (t) => {
        const doc = await t.get(orderRef);
        if (!doc.exists) throw "Order not found";
        const order = doc.data();
        if (order.status === 'paid' && order.fulfillmentDone) return; 

        updatedItems = [...order.items];

        // Loop items untuk potong stok (Simplified Logic)
        for (let i = 0; i < updatedItems.length; i++) {
            let item = updatedItems[i];
            // Jika manual atau belum ada sistem stok otomatis, flag manual
            if (item.isManual || item.processType === 'MANUAL') {
                needsManualProcessing = true;
            }
            // (Di sini bisa ditambahkan logika potong stok otomatis jika database produk sudah siap)
        }

        t.update(orderRef, { status: 'paid', items: updatedItems });
    });

    // Notif ke Admin
    if (needsManualProcessing) {
        let msg = `🔔 <b>ORDER LUNAS (BUTUH PROSES)</b>\nID: <code>${orderId}</code>\n\nItem berikut butuh data manual:\n`;
        updatedItems.forEach((item, index) => {
             msg += `\n📦 <b>${item.name}</b> (Qty: ${item.qty})\n👉 <i>Reply:</i> <code>#${index} [data1]</code>\n(Enter untuk data baris berikutnya)\n`;
        });
        await sendMessage(ADMIN_CHAT_ID, msg);
    } else {
        await sendMessage(ADMIN_CHAT_ID, `✅ <b>ORDER SELESAI</b>\nID: ${orderId}\nSemua stok terkirim.`);
    }
}

module.exports = async function(req, res) {
    const { order_id, transaction_status } = req.body;
    if (transaction_status === 'capture' || transaction_status === 'settlement') {
        await processOrderInventory(order_id);
    }
    res.status(200).json({ status: 'ok' });
};
