const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

// 1. DASHBOARD
async function showAdminDashboard(chatId) {
    const text = `🎛 <b>DASHBOARD ADMIN</b>\n\nSilakan pilih menu:`;
    const kb = [
        [{ text: "📊 Laporan Hari Ini", callback_data: "ADMIN_REPORT" }],
        [{ text: "⚠️ Cek Stok Menipis", callback_data: "ADMIN_STOCK" }],
        [{ text: "🔄 Refresh", callback_data: "ADMIN_MENU" }]
    ];
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: kb } });
}

// 2. LAPORAN OMZET (SAMA SEPERTI SEBELUMNYA)
async function handleDailyReport(chatId) {
    await sendMessage(chatId, "⏳ <i>Menghitung data...</i>");
    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(today.setHours(23, 59, 59, 999)).toISOString();

        const snapshot = await db.collection('orders')
            .where('date', '>=', startOfDay)
            .where('date', '<=', endOfDay)
            .get();

        let totalOmzet = 0;
        let totalTrx = 0;
        let pendingTrx = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.status === 'success' || data.status === 'paid') {
                totalOmzet += parseInt(data.total) || 0;
                totalTrx++;
            } else if (data.status === 'processing' || data.status === 'pending') {
                pendingTrx++;
            }
        });

        const msg = `📊 <b>LAPORAN HARIAN</b>\n-----------------\n✅ Sukses: ${totalTrx}\n💰 Omzet: Rp ${totalOmzet.toLocaleString()}\n⏳ Pending: ${pendingTrx}`;
        await sendMessage(chatId, msg);
        await showAdminDashboard(chatId);

    } catch (e) {
        console.error(e);
        await sendMessage(chatId, "❌ Gagal lapor.");
    }
}

// 3. CEK STOK (PERBAIKAN SAFETY CHECK AGAR TIDAK DIAM)
async function handleLowStockCheck(chatId) {
    await sendMessage(chatId, "🔍 <i>Memindai gudang...</i>");

    try {
        const snapshot = await db.collection('products').get();
        let lowStockItems = "";
        let count = 0;
        const THRESHOLD = 3; 

        snapshot.forEach(doc => {
            const p = doc.data();
            // SKIP JIKA MANUAL
            if (p.isManual || p.processType === 'MANUAL') return;

            // SAFETY CHECK: Gunakan '|| []' agar tidak error jika array kosong/undefined
            const mainItems = p.items || [];
            const variations = p.variations || [];

            // 1. Cek Produk Utama (Hanya jika tidak punya variasi)
            if (variations.length === 0) {
                if (mainItems.length <= THRESHOLD) {
                    lowStockItems += `📦 ${p.name} (Sisa: ${mainItems.length})\n`;
                    count++;
                }
            }

            // 2. Cek Variasi
            if (variations.length > 0) {
                variations.forEach(v => {
                    const vItems = v.items || []; // Safety check lagi
                    if (vItems.length <= THRESHOLD) {
                        lowStockItems += `🔸 ${p.name} - ${v.name} (Sisa: ${vItems.length})\n`;
                        count++;
                    }
                });
            }
        });

        if (count > 0) {
            await sendMessage(chatId, `⚠️ <b>PERINGATAN STOK MENIPIS</b>\n\n${lowStockItems}`);
        } else {
            await sendMessage(chatId, `✅ <b>AMAN!</b> Stok masih banyak.`);
        }
        await showAdminDashboard(chatId);

    } catch (e) {
        console.error("Stock Check Error:", e);
        await sendMessage(chatId, `❌ Error Cek Stok: ${e.message}`);
    }
}

module.exports = { showAdminDashboard, handleDailyReport, handleLowStockCheck };
