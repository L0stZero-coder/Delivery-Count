const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-GB');
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
let currentSearch;
let searchTimer;

async function showHistory() {
    currentSearch?.abort();
    const search = new AbortController();
    currentSearch = search;
    const query = new URLSearchParams({
        name: byId('name-filter').value,
        colour: byId('colour-filter').value,
    });
    const status = byId('history-status');
    try {
        const response = await fetch('/api/history?' + query, { signal: search.signal });
        if (!response.ok) throw new Error();
        const { rows, total } = await response.json();
        if (search.signal.aborted) return;
        const headings = [...new Set(rows.flatMap((row) => Object.keys(row.details)))];
        const header = byId('history-head');
        header.querySelectorAll('.extra-heading').forEach((cell) => cell.remove());
        for (const heading of headings) {
            const cell = document.createElement('th');
            cell.className = 'extra-heading';
            cell.textContent = heading;
            header.insertBefore(cell, header.lastElementChild);
        }
        byId('total-label').colSpan = header.cells.length - 1;
        const fragment = document.createDocumentFragment();
        for (const row of rows) {
            const tr = document.createElement('tr');
            const values = [
                date.format(new Date(row.arrival)), '#' + row.id, row.name, row.model,
                row.colour, number.format(row.boxes), row.box_number || '—', row.barcode || '—',
                ...headings.map((heading) => Object.hasOwn(row.details, heading) ? row.details[heading] : ''),
                number.format(row.qty),
            ];
            values.forEach((value, index) => {
                const cell = tr.insertCell();
                cell.textContent = value;
                if (index === 5 || index === values.length - 1) cell.className = 'num';
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

for (const id of ['name-filter', 'colour-filter']) {
    byId(id).addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(showHistory, 150);
    });
}

byId('clear').addEventListener('click', () => {
    byId('name-filter').value = '';
    byId('colour-filter').value = '';
    clearTimeout(searchTimer);
    showHistory();
});

byId('upload').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = byId('workbook').files[0];
    const button = byId('save');
    if (!file || button.disabled) return;
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
