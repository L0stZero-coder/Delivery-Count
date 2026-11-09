const container = document.getElementById('deliveries');
const status = document.getElementById('status');

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
                    message.className = 'success';
                    message.textContent = 'Changes saved.';
                } catch (error) {
                    message.className = 'error';
                    message.textContent = error.message || 'Could not save. Reload the page to check the delivery.';
                } finally {
                    [save, arrival, boxes].forEach((input) => { input.disabled = false; });
                }
            });
            card.append(title, boxList, form, message);
            container.append(card);
        }
        status.textContent = deliveries.length ? deliveries.length + ' deliveries' : 'No deliveries have been recorded.';
    } catch {
        status.className = 'error';
        status.textContent = 'Could not load deliveries. Refresh to try again.';
    }
}
loadDeliveries();
