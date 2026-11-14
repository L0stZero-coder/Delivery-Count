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

const activityStatus = document.getElementById('activity-status');
const activityMessage = document.getElementById('activity-message');
const activityList = document.getElementById('activity-list');
const activityDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
let activityRequest;

function updateBoxList(list, boxNumbers) {
    list.textContent = boxNumbers.length
        ? 'Box numbers · ' + boxNumbers.join(', ')
        : 'Box numbers were not recorded for this delivery.';
}

function describeActivity(entry) {
    if (entry.kind === 'replace') {
        return 'Spreadsheet replaced · ' + entry.old_qty.toLocaleString('en-GB')
            + ' → ' + entry.new_qty.toLocaleString('en-GB') + ' units';
    }
    const changes = [];
    if (entry.old_arrival !== entry.new_arrival) {
        changes.push('Arrival date ' + rangeDisplay(entry.old_arrival) + ' → ' + rangeDisplay(entry.new_arrival));
    }
    if (entry.old_boxes !== entry.new_boxes) {
        changes.push('Delivery boxes ' + entry.old_boxes + ' → ' + entry.new_boxes);
    }
    return changes.join(' · ');
}

async function loadActivity() {
    activityRequest?.abort();
    const request = new AbortController();
    activityRequest = request;
    try {
        const response = await fetch('/api/activity', { signal: request.signal });
        if (!response.ok) throw new Error();
        const { activity } = await response.json();
        if (request.signal.aborted) return;
        const fragment = document.createDocumentFragment();
        for (const entry of activity) {
            const item = document.createElement('li');
            const title = document.createElement('strong');
            const link = document.createElement('a');
            link.href = '/delivery?id=' + entry.delivery;
            link.textContent = 'Delivery #' + entry.delivery;
            title.append(link);
            const summary = document.createElement('p');
            summary.textContent = describeActivity(entry);
            const time = document.createElement('time');
            time.dateTime = entry.created_at;
            time.textContent = activityDate.format(new Date(entry.created_at));
            item.append(title, summary, time);
            if (entry.undone_at) {
                const undone = document.createElement('p');
                undone.textContent = 'Undone ' + activityDate.format(new Date(entry.undone_at));
                item.append(undone);
            } else if (entry.can_undo) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'secondary';
                button.textContent = 'Undo';
                button.setAttribute('aria-label', 'Undo change to delivery ' + entry.delivery);
                button.addEventListener('click', () => undoActivity(entry, button));
                item.append(button);
            }
            fragment.append(item);
        }
        activityList.replaceChildren(fragment);
        activityStatus.textContent = activity.length ? '' : 'No changes recorded yet.';
    } catch {
        if (!request.signal.aborted) activityStatus.textContent = 'Could not load the activity log. Refresh to try again.';
    }
}

async function undoActivity(entry, button) {
    if (button.disabled || !confirm('Undo this change to delivery #' + entry.delivery + '?')) return;
    button.disabled = true;
    activityMessage.className = '';
    activityMessage.textContent = 'Undoing change…';
    try {
        const response = await fetch('/api/activity/' + entry.id + '/undo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        const current = deliveryCards.find(({ delivery }) => delivery.id === result.delivery.id);
        if (current) {
            Object.assign(current.delivery, result.delivery);
            if (result.kind === 'edit') {
                current.arrival.value = result.delivery.arrival;
                current.boxes.value = result.delivery.boxes;
            }
            updateBoxList(current.boxList, result.delivery.box_numbers);
            current.boxSummary.textContent = deliveryBoxText(current.delivery.box_count, current.delivery.boxes);
            filterDeliveries();
        }
        activityMessage.className = 'success';
        activityMessage.textContent = 'Change to delivery #' + entry.delivery + ' undone.';
    } catch (error) {
        activityMessage.className = 'error';
        activityMessage.textContent = error.message || 'Could not undo the change.';
    } finally {
        await loadActivity();
        button.disabled = false;
    }
}

async function loadDeliveries() {
    try {
        const response = await fetch('/api/deliveries');
        if (!response.ok) throw new Error();
        const { deliveries, backup_path } = await response.json();
        if (backup_path) {
            document.getElementById("backup-path").textContent = backup_path;
            document.getElementById("backup-location").hidden = false;
        }
        for (const delivery of deliveries) {
            const card = document.createElement('section');
            card.className = 'card';
            const title = document.createElement('h2');
            const link = document.createElement('a');
            link.href = '/delivery?id=' + delivery.id;
            link.textContent = 'Delivery #' + delivery.id;
            title.append(link);
            const boxList = document.createElement('p');
            updateBoxList(boxList, delivery.box_numbers);
            const boxSummary = document.createElement('p');
            boxSummary.className = 'note';
            boxSummary.textContent = deliveryBoxText(delivery.box_count, delivery.boxes);
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
                    boxSummary.textContent = deliveryBoxText(delivery.box_count, delivery.boxes);
                    filterDeliveries();
                    message.className = 'success';
                    message.textContent = 'Changes saved.';
                    loadActivity();
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
                    delivery.box_count = result.box_count;
                    boxSummary.textContent = deliveryBoxText(delivery.box_count, delivery.boxes);
                    delivery.box_numbers = result.box_numbers;
                    updateBoxList(boxList, result.box_numbers);
                    loadActivity();
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
            card.append(title, boxList, boxSummary, form, message, explanation, replacementForm, replacementMessage);
            deliveryCards.push({ delivery, card, arrival, boxes, boxList, boxSummary });
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
loadActivity();
