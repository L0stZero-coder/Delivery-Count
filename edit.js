const container = document.getElementById('deliveries');
const status = document.getElementById('status');

const boxesFilter = document.getElementById('boxes-filter');
const deliveryCards = [];
let deliveriesLoaded = false;

function filterDeliveries() {
    if (!deliveriesLoaded) return;
    const boxes = boxesFilter.value;
    const from = document.getElementById('date-from').value;
    const to = document.getElementById('date-to').value;
    let count = 0;
    for (const { delivery, card } of deliveryCards) {
        const matches = (!boxes || String(delivery.boxes) === boxes)
            && delivery.arrival >= from && delivery.arrival <= to;
        card.hidden = !matches;
        if (matches) count++;
    }
    status.textContent = count
        ? count + (count === 1 ? ' matching delivery' : ' matching deliveries')
        : 'No deliveries match these filters.';
}

resetDateRange();
boxesFilter.addEventListener('input', filterDeliveries);
document.addEventListener('arrival-range-change', filterDeliveries);
document.getElementById('clear').addEventListener('click', () => {
    boxesFilter.value = '';
    resetDateRange();
    filterDeliveries();
});

async function loadDeliveries() {
    try {
        const response = await fetch('/api/deliveries');
        if (!response.ok) throw new Error();
        const { deliveries } = await response.json();
        for (const delivery of deliveries) {
            const card = document.createElement('section');
            card.className = 'card';
            const title = document.createElement('h2');
            title.textContent = 'Delivery #' + delivery.id;
            const boxList = document.createElement('p');
            boxList.textContent = delivery.box_numbers.length
                ? 'Box numbers · ' + delivery.box_numbers.join(', ')
                : 'Box numbers were not recorded for this delivery.';
            const form = document.createElement('form');
            form.className = 'edit-form';
            const dateLabel = document.createElement('label');
            dateLabel.textContent = 'Arrival date';
            const arrival = document.createElement('input');
            arrival.type = 'date';
            arrival.required = true;
            arrival.value = delivery.arrival;
            dateLabel.append(arrival);
            const boxesLabel = document.createElement('label');
            boxesLabel.textContent = 'Delivery boxes';
            const boxes = document.createElement('input');
            boxes.type = 'number';
            boxes.min = '1';
            boxes.max = '2147483647';
            boxes.step = '1';
            boxes.required = true;
            boxes.value = delivery.boxes;
            boxesLabel.append(boxes);
            const save = document.createElement('button');
            save.textContent = 'Save changes';
            const message = document.createElement('p');
            message.setAttribute('role', 'status');
            form.append(dateLabel, boxesLabel, save);
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (save.disabled) return;
                const details = {
                    arrival: arrival.value, boxes: boxes.value,
                    previous_arrival: delivery.arrival, previous_boxes: delivery.boxes,
                };
                [save, arrival, boxes].forEach((input) => { input.disabled = true; });
                message.textContent = 'Saving…';
                message.className = '';
                try {
                    const response = await fetch('/api/deliveries/' + delivery.id + '/edit', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(details),
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error);
                    Object.assign(delivery, result);
                    filterDeliveries();
                    message.className = 'success';
                    message.textContent = 'Changes saved.';
                } catch (error) {
                    message.className = 'error';
                    message.textContent = error.message || 'Could not save. Reload the page to check the delivery.';
                } finally {
                    [save, arrival, boxes].forEach((input) => { input.disabled = false; });
                }
            });
            const replacementForm = document.createElement('form');
            replacementForm.className = 'edit-form';
            const fileLabel = document.createElement('label');
            fileLabel.textContent = 'Updated spreadsheet (up to 50 MB)';
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.xlsx,.xls,.xl,.ods';
            fileInput.required = true;
            fileLabel.append(fileInput);
            const replace = document.createElement('button');
            replace.textContent = 'Re-upload Excel';
            const replacementMessage = document.createElement('p');
            replacementMessage.setAttribute('role', 'status');
            const explanation = document.createElement('p');
            explanation.textContent = 'Re-upload replaces the product and box-number data for this delivery. The saved arrival date and total delivery-box count are retained.';
            replacementForm.append(fileLabel, replace);
            replacementForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const file = fileInput.files[0];
                if (!file || replace.disabled) return;
                replacementMessage.className = '';
                if (!file.size || file.size > 50 * 1024 * 1024) {
                    replacementMessage.className = 'error';
                    replacementMessage.textContent = 'Choose a non-empty workbook up to 50 MB.';
                    return;
                }
                const query = new URLSearchParams({
                    extension: file.name.slice(file.name.lastIndexOf('.')),
                    revision: delivery.revision,
                });
                replace.disabled = fileInput.disabled = true;
                replacementMessage.textContent = 'Replacing delivery data…';
                try {
                    const response = await fetch('/api/deliveries/' + delivery.id + '/replace?' + query, {
                        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error);
                    delivery.revision = result.revision;
                    delivery.box_numbers = result.box_numbers;
                    boxList.textContent = result.box_numbers.length
                        ? 'Box numbers · ' + result.box_numbers.join(', ')
                        : 'Box numbers were not recorded for this delivery.';
                    fileInput.value = '';
                    replacementMessage.className = 'success';
                    replacementMessage.textContent = 'Delivery replaced. ' + result.qty.toLocaleString('en-GB') + ' units saved.';
                } catch (error) {
                    replacementMessage.className = 'error';
                    replacementMessage.textContent = error instanceof TypeError
                        ? 'Connection lost. Reload to check the delivery before re-uploading.'
                        : error.message;
                } finally {
                    replace.disabled = fileInput.disabled = false;
                }
            });
            card.append(title, boxList, form, message, explanation, replacementForm, replacementMessage);
            deliveryCards.push({ delivery, card });
            container.append(card);
        }
        deliveriesLoaded = true;
        filterDeliveries();
    } catch {
        status.className = 'error';
        status.textContent = 'Could not load deliveries. Refresh to try again.';
    }
}
loadDeliveries();
