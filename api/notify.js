const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Helper (Wajib ada untuk menu manual)
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items: rawItems } = req.body;

    try {
        // ==========================================
        // 0. CEK DATA REALTIME DARI DATABASE
        // ==========================================
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        // Prioritaskan data dari DB (karena Frontend App.jsx mungkin sudah inject stok Capcut)
        let orderData = orderSnap.exists ? orderSnap.data() : null;
        let finalItems = orderData ? orderData.items : rawItems;

        // Cek apakah produk ini tipe digital/otomatis (Bukan barang fisik/manual murni)
        const isDigitalProduct = finalItems && finalItems.some(i => !i.isManual && i.processType !== 'MANUAL');

        // ==========================================
        // LOGIKA BARU: PENANGANAN PARSIAL (CAMPUR)
        // ==========================================
        const handleMixedDelivery = async (sourceType) => {
            let readyItems = [];
            let missingItems = [];

            // Pisahkan mana yang sudah punya konten (CapCut) dan mana yang belum (YouTube/Netflix)
            finalItems.forEach((item, index) => {
                const hasData = item.data && Array.isArray(item.data) && item.data.length > 0;
                // Item dianggap 'Missing' jika: Tidak ada data DAN Bukan Produk Manual Murni
                if (!hasData && !item.isManual && item.processType !== 'MANUAL') {
                    missingItems.push({ ...item, index });
                } else {
                    readyItems.push({ ...item, index });
                }
            });

            // SKENARIO 1: SEMUA KOSONG (Total Gagal / Belum diproses Frontend)
            if (readyItems.length === 0 && missingItems.length > 0) {
                // Coba ambil stok pakai cara backend (fallback)
                const result = await processOrderStock(orderId);
                if (result.success) {
                    await sendSuccessNotification(ADMIN_CHAT_ID, orderId, sourceType, result.orderData);
                } else {
                    // Jika tetap gagal, munculkan menu input manual
                    await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK KOSONG SEMUA (${sourceType})</b>\n\nSemua item stoknya habis/belum diisi.\nSilakan input manual di bawah:`);
                    await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
                }
                return;
            }

            // SKENARIO 2: ADA YANG READY, ADA YANG KOSONG (Kasus Kamu)
            if (missingItems.length > 0 && readyItems.length > 0) {
                // 1. Kirim dulu yang READY (CapCut)
                let contentLog = "";
                readyItems.forEach(i => {
                    if (i.data && i.data.length > 0) {
                        contentLog += `📦 <b>${i.name}</b>\n<code>${i.data.join('\n')}</code>\n\n`;
                    }
                });

                const partialMsg = `⚠️ <b>ORDER PARSIAL (SEBAGIAN) - ${sourceType}</b>\n` +
                                   `🆔 ID: <code>${orderId}</code>\n\n` +
                                   `✅ <b>BERHASIL DIAMBIL:</b>\n${contentLog}` +
                                   `❌ <b>STOK KOSONG/GAGAL:</b>\n` +
                                   missingItems.map(m => `- ${m.name}`).join('\n') + 
                                   `\n\n👇 <b>WAJIB ISI MANUAL YANG KOSONG:</b>`;
                
                await sendMessage(ADMIN_CHAT_ID, partialMsg);
                
                // 2. MUNCULKAN TOMBOL INPUT MANUAL (PENTING!!)
                // Bot akan mengirim menu tombol agar Admin bisa isi YouTube & Netflix
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, finalItems);
                return;
            }

            // SKENARIO 3: SEMUA READY (Perfect)
            if (missingItems.length === 0) {
                // Update status jadi PAID/SUCCESS
                await orderRef.update({ status: 'paid' }); 
                
                let contentLog = "";
                finalItems.forEach(i => {
                    // Cek manual atau auto
                    if (i.data && i.data.length > 0) {
                        contentLog += `📦 <b>${i.name}</b>\n<code>${i.data.join('\n')}</code>\n\n`;
                    } else {
                        contentLog += `📦 <b>${i.name}</b>\n(Manual Process/Fisik)\n\n`;
                    }
                });

                const successMsg = `✅ <b>TRANSAKSI SUKSES FULL (${sourceType})</b>\n` +
                                   `🆔 ID: <code>${orderId}</code>\n` +
                                   `💰 Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                                   `<b>DATA TERKIRIM:</b>\n${contentLog}`;
                
                await sendMessage(ADMIN_CHAT_ID, successMsg);
            }
        };

        // ==========================================
        // 1. AUTO ORDER (MIDTRANS / WEB)
        // ==========================================
        if (type === 'auto') {
            const itemsDetail = finalItems.map(i => `📦 ${i.name}`).join('\n');
            await sendMessage(ADMIN_CHAT_ID, `⚡️ <b>PESANAN OTOMATIS</b>\n🆔 ID: <code>${orderId}</code>\n${itemsDetail}\n⚙️ <i>Cek kelengkapan stok...</i>`);
            
            await handleMixedDelivery("OTOMATIS");
        } 
        
        // ==========================================
        // 2. PEMBAYARAN SALDO (MEMBER)
        // ==========================================
        else if (type === 'saldo') {
            const itemsDetail = finalItems.map(i => `💎 ${i.name}`).join('\n');
            await sendMessage(ADMIN_CHAT_ID, `💎 <b>PESANAN SALDO</b>\n🆔 ID: <code>${orderId}</code>\n👤 ${buyerContact}\n${itemsDetail}\n⚙️ <i>Cek kelengkapan stok...</i>`);

            await handleMixedDelivery("SALDO");
        }

        // ==========================================
        // 3. KONFIRMASI PEMBAYARAN MANUAL
        // ==========================================
        else if (type === 'manual') {
            if (isDigitalProduct) {
                // Jika user beli Capcut+Netflix pake TF Manual & klik "Sudah Bayar"
                const itemsDetail = finalItems.map(i => `🚀 ${i.name}`).join('\n');
                await sendMessage(ADMIN_CHAT_ID, `🚀 <b>MANUAL TF (AUTO-CHECK)</b>\n🆔 ID: <code>${orderId}</code>\n${itemsDetail}\nℹ️ <i>Mencoba kirim stok yang ready...</i>`);

                await handleMixedDelivery("MANUAL-BYPASS");
                
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>INFO ADMIN:</b> Cek mutasi bank untuk order <code>${orderId}</code>.`);

            } else {
                // Produk Manual Murni (Joki/Topup Login) - Tetap butuh ACC
                let itemsDetail = "";
                if (finalItems && Array.isArray(finalItems)) {
                    finalItems.forEach(i => {
                        const note = i.note ? ` (Input: ${i.note})` : '';
                        itemsDetail += `- ${i.name} x${i.qty}${note}\n`;
                    });
                }

                const text = `💸 <b>MANUAL TRANSFER MASUK</b>\n` +
                             `🆔 ID: <code>${orderId}</code>\n` +
                             `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                             `👤 User: ${buyerContact}\n\n` +
                             `🛒 <b>List Item:</b>\n${itemsDetail}\n` +
                             `👇 <b>TINDAKAN:</b>`;

                await sendMessage(ADMIN_CHAT_ID, text, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                            [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                        ]
                    }
                });
            }
        }
        
        // ==========================================
        // 4. KOMPLAIN
        // ==========================================
        else if (type === 'complaint') {
            const text = `⚠️ <b>KOMPLAIN USER</b>\n🆔 ID: <code>${orderId}</code>\n💬 "${message}"`;
            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: { inline_keyboard: [[{ text: "🗣 BALAS KE USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]] }
            });
        }

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error("Notify Error:", e);
        return res.status(500).json({ error: e.message });
    }
};
