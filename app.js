const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-GB');
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
let currentSearch;
let searchTimer;

const selected = new Set();
const reportColumns = [
    'Select', 'Arrival Date', 'Delivery Boxes', 'Product Model', 'Product Name', 'Colour',
    'Total QTY', 'Barcode', 'Box Number + Qty in that Box', 'Boxes Containing Product',
];

function rowKey(row) {
    return row.id + ':' + row.product_id;
}

function reportValues(row, display = false) {
    const quantity = (value) => display ? number.format(value) : value;
    const boxes = row.box_quantities.map(([box, qty]) => box + ' (' + quantity(qty) + ')');
    return [
        display ? date.format(new Date(row.arrival)) : row.arrival,
        quantity(row.boxes), row.model, row.name, row.colour,
        quantity(row.qty), row.barcode, boxes.join(', '), productBoxText(row.product_box_count),
    ];
}

function makeCsv(rows, selection) {
    return [reportColumns, ...rows.map((row) => [
        selection.has(rowKey(row)) ? 'Yes' : 'No', ...reportValues(row),
    ])]
        .map((fields) => fields.map(csvCell).join(','))
        .join('\r\n') + '\r\n';
}

function updateSelection() {
    byId('selection-status').textContent = selected.size
        ? number.format(selected.size) + ' selected · CSV includes selected rows'
        : 'No selection · CSV includes all deliveries';
    byId('clear-selection').hidden = selected.size === 0;
}

byId('clear-selection').addEventListener('click', () => {
    selected.clear();
    byId('rows').querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = false; });
    updateSelection();
});

byId('export').addEventListener('click', async () => {
    const button = byId('export');
    const status = byId('report-status');
    const selection = new Set(selected);
    button.disabled = true;
    status.textContent = '';
    try {
        const response = await fetch('/api/history');
        if (!response.ok) throw new Error();
        const { rows } = await response.json();
        const report = selection.size ? rows.filter((row) => selection.has(rowKey(row))) : rows;
        const url = URL.createObjectURL(new Blob(['\uFEFF', makeCsv(report, selection)], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = selection.size ? 'selected-delivery-products.csv' : 'delivery-history.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.className = 'success';
        status.textContent = number.format(report.length) + ' rows exported.';
    } catch {
        status.className = 'error';
        status.textContent = 'Could not download the report. Try again.';
    } finally {
        button.disabled = false;
    }
});

let historyRows = [];
let shownRows = 0;
function showMoreRows() {
        const fragment = document.createDocumentFragment();
        for (const row of historyRows.slice(shownRows, shownRows + 100)) {
            const tr = document.createElement('tr');
            const selection = tr.insertCell();
            const checkbox = document.createElement('input');
            const identity = rowKey(row);
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(identity);
            checkbox.setAttribute('aria-label', 'Select ' + [row.name, row.model, row.colour, row.arrival, 'delivery ' + row.id].join(', '));
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selected.add(identity);
                else selected.delete(identity);
                updateSelection();
            });
            selection.append(checkbox);
            reportValues(row, true).forEach((value, index) => {
                const cell = tr.insertCell();
                if (index === 7 && row.box_quantities.length) {
                    const list = document.createElement('ul');
                    list.className = 'box-list';
                    for (const [box, qty] of row.box_quantities) {
                        const item = document.createElement('li');
                        item.textContent = box + ' (' + number.format(qty) + ')';
                        list.append(item);
                    }
                    cell.append(list);
                } else {
                    cell.textContent = value === '' ? '—' : value;
                }
                if (index === 0) cell.append(' ', deliveryTag(row.status));
                if (index === 1 || index === 5 || index === 8) cell.className = 'num';
                if (index === 8) cell.title = row.product_box_count.issues.join('; ');
            });
            fragment.append(tr);
        }
        byId('rows').append(fragment);
    shownRows = Math.min(shownRows + 100, historyRows.length);
    byId('load-more').hidden = shownRows >= historyRows.length;
    byId('history-status').textContent = historyRows.length
        ? 'Showing ' + number.format(shownRows) + ' of ' + number.format(historyRows.length) + ' matching rows'
        : 'No deliveries match this search.';
}

byId('load-more').addEventListener('click', showMoreRows);
const rowObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !byId('load-more').hidden) showMoreRows();
});
rowObserver.observe(byId('load-more'));

async function showHistory() {
    currentSearch?.abort();
    byId('load-more').hidden = true;
    const search = new AbortController();
    currentSearch = search;
    const query = new URLSearchParams({
        q: byId('name-filter').value,
        colour: byId('colour-filter').value,
        boxes: byId('boxes-filter').value,
        status: byId('status-filter').value,
        date_from: byId('date-from').value,
        date_to: byId('date-to').value,
    });
    const status = byId('history-status');
    try {
        const response = await fetch('/api/history?' + query, { signal: search.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load delivery history.');
        const { rows, total } = result;
        if (search.signal.aborted) return;
        historyRows = rows;
        shownRows = 0;
        byId('rows').replaceChildren();
        showMoreRows();
        byId('total').textContent = number.format(total);
        status.className = '';
    } catch (error) {
        if (search.signal.aborted) return;
        byId('rows').replaceChildren();
        byId('total').textContent = '—';
        status.textContent = error.message || 'Could not load delivery history. Refresh to try again.';
        status.className = 'error';
    }
}

byId('arrival').value = new Date().toLocaleDateString('sv-SE');
resetDateRange();

for (const id of ['name-filter', 'colour-filter', 'boxes-filter']) {
    byId(id).addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(showHistory, 150);
    });
}

byId('status-filter').addEventListener('change', showHistory);
document.addEventListener('arrival-range-change', showHistory);

byId('clear').addEventListener('click', () => {
    byId('name-filter').value = '';
    byId('colour-filter').value = '';
    byId('boxes-filter').value = '';
    byId('status-filter').value = '';
    resetDateRange();
    clearTimeout(searchTimer);
    showHistory();
});

function deliveryTag(status) {
    const tag = document.createElement('span');
    tag.className = 'delivery-tag tag-' + status;
    tag.textContent = { arrived: 'Arrived', expected: 'Expected', delayed: 'Delayed' }[status];
    return tag;
}

function renderScheduleList(id, deliveries, emptyMessage) {
    const list = byId(id);
    list.replaceChildren();
    if (!deliveries.length) {
        const item = document.createElement('li');
        item.textContent = emptyMessage;
        list.append(item);
        return;
    }
    for (const delivery of deliveries) {
        const item = document.createElement('li');
        const arrival = document.createElement('time');
        arrival.dateTime = delivery.arrival;
        arrival.textContent = date.format(new Date(delivery.arrival));
        const boxes = document.createElement('strong');
        boxes.textContent = number.format(delivery.boxes) + (delivery.boxes === 1 ? ' box' : ' boxes');
        item.append(arrival, boxes, deliveryTag(delivery.status));
        if (delivery.status !== 'arrived' && delivery.arrival <= rangeIso(new Date())) {
            const check = document.createElement('button');
            check.type = 'button';
            check.className = 'arrival-check';
            check.textContent = 'Arrived?';
            check.addEventListener('click', () => openStatusDialog(delivery));
            item.append(check);
        }
        list.append(item);
    }
}

let statusDelivery;
let savingStatus = false;
const statusDialog = byId('delivery-status-dialog');
function openStatusDialog(delivery) {
    if (savingStatus) return;
    statusDelivery = delivery;
    byId('confirm-arrived').hidden = false;
    byId('delivery-status-description').textContent = number.format(delivery.boxes)
        + ' boxes · Expected ' + date.format(new Date(delivery.arrival));
    byId('confirmed-arrival').value = rangeIso(new Date());
    byId('confirmed-arrival').max = rangeIso(new Date());
    byId('delay-date-label').hidden = true;
    byId('confirm-delayed').hidden = true;
    byId('delayed-date').value = '';
    byId('status-save-message').textContent = '';
    statusDialog.showModal();
}
byId('choose-delay').addEventListener('click', () => {
    byId('confirm-arrived').hidden = true;
    byId('delay-date-label').hidden = false;
    byId('confirm-delayed').hidden = false;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    byId('delayed-date').min = rangeIso(tomorrow);
    byId('delayed-date').focus();
});
byId('cancel-status').addEventListener('click', () => statusDialog.close());
statusDialog.addEventListener('cancel', (event) => { if (savingStatus) event.preventDefault(); });
async function saveDeliveryStatus(status, arrival) {
    if (savingStatus) return;
    savingStatus = true;
    const controls = [...byId('delivery-status-form').elements];
    controls.forEach((control) => { control.disabled = true; });
    byId('status-save-message').textContent = 'Saving…';
    try {
        const response = await fetch('/api/deliveries/' + statusDelivery.id + '/status', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({status, arrival,
                previous_status: statusDelivery.status, previous_arrival: statusDelivery.arrival}),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        statusDialog.close();
        await Promise.all([showDeliverySchedule(), showHistory()]);
    } catch (error) {
        byId('status-save-message').textContent = error.message || 'Could not save. Try again.';
    } finally {
        savingStatus = false;
        controls.forEach((control) => { control.disabled = false; });
    }
}
byId('delivery-status-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!byId('delay-date-label').hidden) {
        byId('confirm-delayed').click();
    } else {
        saveDeliveryStatus('arrived', byId('confirmed-arrival').value);
    }
});
byId('confirm-delayed').addEventListener('click', () => {
    const input = byId('delayed-date');
    if (!input.value) { input.focus(); return; }
    if (input.reportValidity()) saveDeliveryStatus('delayed', input.value);
});

function showDeliverySummary(deliveries, monthlyUnits) {
    const today = new Date();
    const start = rangeIso(today);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 6);
    const end = rangeIso(endDate);
    const month = start.slice(0, 7);
    const pending = deliveries.filter((delivery) => delivery.status !== 'arrived');
    const monthlyArrivals = deliveries.filter((delivery) => delivery.status === 'arrived' && delivery.arrival.startsWith(month));
    const values = {
        upcoming: pending.filter((delivery) => delivery.arrival >= start && delivery.arrival <= end).length,
        overdue: pending.filter((delivery) => delivery.arrival < start).length,
        delayed: deliveries.filter((delivery) => delivery.status === 'delayed').length,
        arrived: monthlyArrivals.length,
        boxes: monthlyArrivals.reduce((total, delivery) => total + delivery.boxes, 0),
        units: monthlyUnits,
    };
    for (const [name, value] of Object.entries(values)) {
        byId('summary-' + name).textContent = number.format(value);
    }
    document.querySelector('.delivery-summary').setAttribute('aria-busy', 'false');
}

let scheduleRequest;
async function showDeliverySchedule() {
    scheduleRequest?.abort();
    const request = new AbortController();
    scheduleRequest = request;
    const status = byId('schedule-status');
    try {
        const response = await fetch('/api/deliveries', { signal: request.signal });
        if (!response.ok) throw new Error();
        const { deliveries, monthly_arrived_units } = await response.json();
        if (request.signal.aborted) return;
        showDeliverySummary(deliveries, monthly_arrived_units);
        const arrived = deliveries.filter((delivery) => delivery.status === 'arrived').slice(0, 8);
        const expected = deliveries.filter((delivery) => delivery.status !== 'arrived')
            .sort((a, b) => a.arrival.localeCompare(b.arrival) || a.id - b.id).slice(0, 8);
        renderScheduleList('arrived-deliveries', arrived, 'No arrivals recorded.');
        renderScheduleList('expected-deliveries', expected, 'No upcoming deliveries recorded.');
        status.textContent = '';
    } catch {
        if (!request.signal.aborted) {
            status.textContent = 'Could not refresh the summary and schedule. Retrying automatically.';
            for (const name of ['upcoming', 'overdue', 'delayed', 'arrived', 'boxes', 'units']) {
                byId('summary-' + name).textContent = '—';
            }
            document.querySelector('.delivery-summary').setAttribute('aria-busy', 'false');
        }
    }
}

byId('upload').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = byId('workbook').files[0];
    const button = byId('save');
    if (!file || button.disabled) return;
    if (file.size === 0 || file.size > 50 * 1024 * 1024) {
        byId('upload-status').className = 'error';
        byId('upload-status').textContent = 'Choose a non-empty workbook up to 50 MB.';
        return;
    }
    const query = new URLSearchParams({
        arrival: byId('arrival').value,
        boxes: byId('boxes').value,
        extension: file.name.slice(file.name.lastIndexOf('.')),
    });
    const fields = [button, byId('workbook'), byId('arrival'), byId('boxes')];
    fields.forEach((field) => { field.disabled = true; });
    const status = byId('upload-status');
    status.className = '';
    status.textContent = 'Saving delivery…';
    try {
        const response = await fetch('/api/deliveries?' + query, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        byId('workbook').value = '';
        byId('boxes').value = '';
        status.className = 'success';
        status.textContent = 'Delivery saved. ' + number.format(result.qty) + ' units across '
            + number.format(result.items) + (result.items === 1 ? ' product line.' : ' product lines.');
        await Promise.all([showHistory(), showDeliverySchedule()]);
    } catch (error) {
        status.className = 'error';
        status.textContent = error instanceof TypeError
            ? 'Connection lost. Check delivery history before uploading again.'
            : error.message;
    } finally {
        fields.forEach((field) => { field.disabled = false; });
    }
});

showHistory();
showDeliverySchedule();
setInterval(() => {
    if (!document.hidden) showDeliverySchedule();
}, 30_000);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) showDeliverySchedule();
});
