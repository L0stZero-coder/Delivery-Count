const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-GB');
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
let currentSearch;
let searchTimer;

const selected = new Set();
const reportColumns = [
    'Arrival Date', 'Delivery Boxes', 'Product Model', 'Product Name', 'Colour',
    'Box Number + Qty in that Box', 'Barcode', 'Total QTY',
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
        boxes.join(', '), row.barcode, quantity(row.qty),
    ];
}

function csvCell(value) {
    let text = String(value);
    // Prevent imported text from being interpreted as an Excel formula.
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
}

function makeCsv(rows) {
    return [reportColumns, ...rows.map((row) => reportValues(row))]
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
        const url = URL.createObjectURL(new Blob(['\uFEFF', makeCsv(report)], { type: 'text/csv;charset=utf-8' }));
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

async function showHistory() {
    currentSearch?.abort();
    const search = new AbortController();
    currentSearch = search;
    const query = new URLSearchParams({
        q: byId('name-filter').value,
        colour: byId('colour-filter').value,
        boxes: byId('boxes-filter').value,
    });
    const status = byId('history-status');
    try {
        const response = await fetch('/api/history?' + query, { signal: search.signal });
        if (!response.ok) throw new Error();
        const { rows, total } = await response.json();
        if (search.signal.aborted) return;
        const fragment = document.createDocumentFragment();
        for (const row of rows) {
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
                if (index === 5 && row.box_quantities.length) {
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
                if (index === 1 || index === 7) cell.className = 'num';
            });
            fragment.append(tr);
        }
        byId('rows').replaceChildren(fragment);
        byId('total').textContent = number.format(total);
        status.textContent = rows.length
            ? number.format(rows.length) + (rows.length === 1 ? ' matching line' : ' matching lines')
            : 'No deliveries match this search.';
        status.className = '';
    } catch {
        if (search.signal.aborted) return;
        byId('rows').replaceChildren();
        byId('total').textContent = '—';
        status.textContent = 'Could not load delivery history. Refresh to try again.';
        status.className = 'error';
    }
}

byId('arrival').value = new Date().toLocaleDateString('sv-SE');

for (const id of ['name-filter', 'colour-filter', 'boxes-filter']) {
    byId(id).addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(showHistory, 150);
    });
}

byId('clear').addEventListener('click', () => {
    byId('name-filter').value = '';
    byId('colour-filter').value = '';
    byId('boxes-filter').value = '';
    clearTimeout(searchTimer);
    showHistory();
});

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
        await showHistory();
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
