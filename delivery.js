const deliveryId = new URLSearchParams(location.search).get('id');
const detailStatus = document.getElementById('status');
const formatNumber = new Intl.NumberFormat('en-GB');
const headings = ['Arrival Date', 'Delivery Boxes', 'Product Model', 'Product Name', 'Colour', 'Total QTY', 'Barcode', 'Box Number + Qty in that Box'];

async function loadDelivery() {
    try {
        if (!/^[1-9][0-9]*$/.test(deliveryId || '')) throw new Error('Choose a valid delivery.');
        const [listResponse, historyResponse] = await Promise.all([
            fetch('/api/deliveries'), fetch('/api/history?delivery=' + deliveryId),
        ]);
        if (!listResponse.ok || !historyResponse.ok) throw new Error('Could not load this delivery. Refresh to try again.');
        const { deliveries } = await listResponse.json();
        const { rows, total } = await historyResponse.json();
        const delivery = deliveries.find((item) => String(item.id) === deliveryId);
        if (!delivery) throw new Error('This delivery could not be found.');
        document.title = 'Delivery #' + delivery.id + ' · Packing list';
        document.getElementById('title').textContent = 'Delivery #' + delivery.id;
        const arrival = new Intl.DateTimeFormat('en-GB', {dateStyle:'long', timeZone:'UTC'}).format(new Date(delivery.arrival));
        document.getElementById('summary').textContent = arrival + ' · ' + formatNumber.format(delivery.boxes) + ' delivery boxes · ' + formatNumber.format(total) + ' units';
        const report = rows.map((row) => [
            row.arrival, row.boxes, row.model, row.name, row.colour, row.qty, row.barcode,
            row.box_quantities.map(([box, qty]) => box + ' (' + qty + ')').join(', '),
        ]);
        for (const values of report) {
            const tr = document.createElement('tr');
            values.slice(2).forEach((value, index) => {
                const cell = tr.insertCell();
                cell.textContent = index === 3 ? formatNumber.format(value) : value || '—';
                if (index === 3) cell.className = 'num';
            });
            document.getElementById('detail-rows').append(tr);
        }
        document.getElementById('detail-total').textContent = formatNumber.format(total);
        document.getElementById('print').addEventListener('click', () => window.print());
        document.getElementById('download').addEventListener('click', () => {
            const csv = [headings, ...report].map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
            const url = URL.createObjectURL(new Blob(['﻿', csv], {type:'text/csv;charset=utf-8'}));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'delivery-' + deliveryId + '-packing-list.csv';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        document.getElementById('content').hidden = false;
        detailStatus.textContent = '';
    } catch (error) {
        detailStatus.className = 'error';
        detailStatus.textContent = error.message;
    }
}
loadDelivery();
